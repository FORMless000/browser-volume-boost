import { LevelController } from "./dsp/level-controller.js";
import { ErrorCode, MessageType } from "./shared/protocol.js";
import {
  DEFAULT_SETTINGS,
  dbToGain,
  effectiveCompressor,
  sanitizeSettings,
} from "./shared/settings.js";

const graphs = new Map();
const errors = new Map();
let audioContext = null;
let contextPromise = null;
let globalSettings = sanitizeSettings(DEFAULT_SETTINGS);
let meterSubscriberCount = 0;
let meterTimer = null;

function smoothParam(param, value, seconds = 0.05) {
  const now = audioContext.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, seconds);
}

async function ensureAudioContext() {
  if (audioContext && audioContext.state !== "closed") {
    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }
    return audioContext;
  }
  if (!contextPromise) {
    contextPromise = (async () => {
      const context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
      if (context.sampleRate !== 48000) {
        await context.close();
        throw new Error("A 48 kHz AudioContext is required for BS.1770 metering.");
      }
      await Promise.all([
        context.audioWorklet.addModule(chrome.runtime.getURL("dsp/meter-worklet.js")),
        context.audioWorklet.addModule(chrome.runtime.getURL("dsp/limiter-worklet.js")),
      ]);
      await context.resume();
      audioContext = context;
      return context;
    })().finally(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

function controllerOptions(settings) {
  return {
    targetLufs: settings.autoLevel.targetLufs,
    maxBoostDb: settings.autoLevel.maxBoostDb,
    maxCutDb: settings.autoLevel.maxCutDb,
  };
}

function applySettingsToGraph(graph, settingsValue, immediate = false) {
  const settings = sanitizeSettings(settingsValue);
  const compressor = effectiveCompressor(settings);
  const smoothing = immediate ? 0.001 : 0.05;
  smoothParam(graph.compressor.threshold, compressor.thresholdDb, smoothing);
  smoothParam(graph.compressor.knee, compressor.kneeDb, smoothing);
  smoothParam(graph.compressor.ratio, compressor.ratio, smoothing);
  smoothParam(graph.compressor.attack, compressor.attackSeconds, smoothing);
  smoothParam(graph.compressor.release, compressor.releaseSeconds, smoothing);
  smoothParam(graph.trimGain.gain, dbToGain(settings.outputTrimDb), smoothing);
  graph.controller.configure(controllerOptions(settings));
  if (!settings.autoLevel.enabled) {
    graph.controller.reset();
    graph.autoGainDb = 0;
    smoothParam(graph.autoGain.gain, 1, smoothing);
  }
  graph.settings = settings;
}

function meterSnapshot(graph) {
  return {
    tabId: graph.tabId,
    shortTermLufs: graph.meters.shortTermLufs,
    momentaryLufs: graph.meters.momentaryLufs,
    compressorReductionDb: Number.isFinite(graph.compressor.reduction)
      ? graph.compressor.reduction
      : 0,
    autoGainDb: graph.autoGainDb,
    limiterReductionDb: graph.meters.limiterReductionDb,
    outputPeakDbfs: graph.meters.outputPeakDbfs,
  };
}

function startMeterBroadcasts() {
  if (meterTimer || meterSubscriberCount < 1) {
    return;
  }
  meterTimer = setInterval(() => {
    for (const graph of graphs.values()) {
      chrome.runtime
        .sendMessage({
          target: "background",
          type: MessageType.METER_UPDATE,
          snapshot: meterSnapshot(graph),
        })
        .catch(() => null);
    }
  }, 100);
}

function stopMeterBroadcastsIfIdle() {
  if (meterSubscriberCount > 0 || !meterTimer) {
    return;
  }
  clearInterval(meterTimer);
  meterTimer = null;
}

function tabStatus(tabId) {
  if (graphs.has(tabId)) {
    return { tabId, state: "active", errorCode: null };
  }
  if (errors.has(tabId)) {
    return { tabId, state: "error", errorCode: errors.get(tabId) };
  }
  return { tabId, state: "idle", errorCode: null };
}

function notifyStatus(tabId) {
  chrome.runtime
    .sendMessage({
      target: "background",
      type: MessageType.OFFSCREEN_STATUS,
      tabStatus: tabStatus(tabId),
      activeCount: graphs.size,
    })
    .catch(() => null);
}

function disconnectNode(node) {
  try {
    node.disconnect();
  } catch {
    // A partially constructed graph may not have any connections yet.
  }
}

function stopGraph(tabId, { errorCode = null, notify = true } = {}) {
  const graph = graphs.get(tabId);
  if (graph) {
    graph.intentionalStop = true;
    clearTimeout(graph.silenceTimer);
    for (const track of graph.stream.getTracks()) {
      track.stop();
    }
    for (const node of [
      graph.source,
      graph.compressor,
      graph.autoGain,
      graph.trimGain,
      graph.limiter,
      graph.meter,
      graph.silentGain,
    ]) {
      disconnectNode(node);
    }
    graphs.delete(tabId);
  }
  if (errorCode) {
    errors.set(tabId, errorCode);
  } else {
    errors.delete(tabId);
  }
  if (notify) {
    notifyStatus(tabId);
  }
}

function mapStartError(error) {
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return ErrorCode.CAPTURE_DENIED;
  }
  if (error?.name === "NotFoundError" || error?.name === "NotReadableError") {
    return ErrorCode.NO_AUDIO;
  }
  return ErrorCode.PROCESSOR_ERROR;
}

async function startTab({ tabId, streamId, wasAudible, settings: settingsValue }) {
  if (graphs.has(tabId)) {
    return { ok: true, tabStatus: tabStatus(tabId), activeCount: graphs.size };
  }
  errors.delete(tabId);
  let stream = null;
  try {
    // Consume the short-lived stream ID before doing any other asynchronous setup.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const context = await ensureAudioContext();
    const settings = sanitizeSettings(settingsValue ?? globalSettings);
    globalSettings = settings;
    const source = context.createMediaStreamSource(stream);
    const compressor = new DynamicsCompressorNode(context);
    const autoGain = new GainNode(context, { gain: 1 });
    const trimGain = new GainNode(context, { gain: 1 });
    const limiter = new AudioWorkletNode(context, "sample-peak-limiter", {
      processorOptions: { ceilingDb: -1, lookAheadSeconds: 0.005, releaseSeconds: 0.1 },
    });
    const meter = new AudioWorkletNode(context, "loudness-meter");
    const silentGain = new GainNode(context, { gain: 0 });
    const controller = new LevelController(controllerOptions(settings));

    source.connect(compressor);
    compressor.connect(autoGain).connect(trimGain).connect(limiter).connect(context.destination);
    compressor.connect(meter).connect(silentGain).connect(context.destination);

    const graph = {
      tabId,
      stream,
      source,
      compressor,
      autoGain,
      trimGain,
      limiter,
      meter,
      silentGain,
      controller,
      settings,
      autoGainDb: 0,
      intentionalStop: false,
      sawSignal: false,
      silenceTimer: null,
      meters: {
        momentaryLufs: null,
        shortTermLufs: null,
        limiterReductionDb: 0,
        outputPeakDbfs: -Infinity,
      },
    };
    graphs.set(tabId, graph);
    applySettingsToGraph(graph, settings, true);

    meter.port.onmessage = (event) => {
      if (!graphs.has(tabId)) {
        return;
      }
      const measurement = event.data;
      graph.meters.momentaryLufs = measurement.momentaryLufs;
      graph.meters.shortTermLufs = measurement.shortTermLufs;
      if (measurement.rawPeakDbfs > -80) {
        graph.sawSignal = true;
      }
      if (graph.settings.autoLevel.enabled) {
        graph.autoGainDb = graph.controller.update({
          shortTermLufs: measurement.shortTermLufs,
          momentaryLufs: measurement.momentaryLufs,
          deltaSeconds: 0.1,
        });
        smoothParam(graph.autoGain.gain, dbToGain(graph.autoGainDb), 0.08);
      }
    };
    limiter.port.onmessage = (event) => {
      graph.meters.limiterReductionDb = event.data.reductionDb;
      graph.meters.outputPeakDbfs = event.data.outputPeakDbfs;
    };

    for (const track of stream.getTracks()) {
      track.addEventListener("ended", () => {
        if (!graph.intentionalStop && graphs.has(tabId)) {
          stopGraph(tabId, { errorCode: ErrorCode.STREAM_ENDED });
        }
      });
    }

    if (wasAudible) {
      graph.silenceTimer = setTimeout(() => {
        if (graphs.has(tabId) && !graph.sawSignal) {
          stopGraph(tabId, { errorCode: ErrorCode.NO_AUDIO });
        }
      }, 3500);
    }

    notifyStatus(tabId);
    startMeterBroadcasts();
    return { ok: true, tabStatus: tabStatus(tabId), activeCount: graphs.size };
  } catch (error) {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }
    const errorCode = mapStartError(error);
    errors.set(tabId, errorCode);
    notifyStatus(tabId);
    return { ok: false, errorCode, tabStatus: tabStatus(tabId), activeCount: graphs.size };
  }
}

async function handleMessage(message) {
  switch (message.type) {
    case MessageType.START_TAB:
      return startTab(message);
    case MessageType.STOP_TAB:
      stopGraph(message.tabId);
      return { ok: true, tabStatus: tabStatus(message.tabId), activeCount: graphs.size };
    case MessageType.EXTERNAL_STOP:
      if (graphs.has(message.tabId)) {
        stopGraph(message.tabId, { errorCode: ErrorCode.STREAM_ENDED });
      }
      return { ok: true };
    case MessageType.GET_STATE:
      return {
        ok: true,
        tabStatus: tabStatus(message.tabId),
        activeCount: graphs.size,
      };
    case MessageType.SET_SETTINGS:
      globalSettings = sanitizeSettings(message.settings);
      for (const graph of graphs.values()) {
        applySettingsToGraph(graph, globalSettings);
      }
      return { ok: true, settings: globalSettings };
    case MessageType.SET_METER_SUBSCRIBERS:
      meterSubscriberCount = Math.max(0, Number(message.count) || 0);
      if (meterSubscriberCount > 0) {
        startMeterBroadcasts();
      } else {
        stopMeterBroadcastsIfIdle();
      }
      return { ok: true };
    default:
      return { ok: false, errorCode: ErrorCode.PROCESSOR_ERROR };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return undefined;
  }
  handleMessage(message)
    .then(sendResponse)
    .catch(() => sendResponse({ ok: false, errorCode: ErrorCode.PROCESSOR_ERROR }));
  return true;
});
