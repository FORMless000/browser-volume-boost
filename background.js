import { ErrorCode, isCapturableUrl, MessageType } from "./shared/protocol.js";
import { loadSettings, saveSettings } from "./shared/settings.js";

const OFFSCREEN_PATH = "offscreen.html";
const meterPorts = new Map();
const lastErrors = new Map();
let creatingOffscreen = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
        justification: "Capture, process, and replay user-selected tab audio locally.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function sendToOffscreen(message) {
  if (!(await hasOffscreenDocument())) {
    return null;
  }
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

function normalizeError(error) {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
  if (/permission|capture|invoked|active tab/i.test(message)) {
    return ErrorCode.CAPTURE_DENIED;
  }
  return ErrorCode.PROCESSOR_ERROR;
}

async function setBadge(activeCount) {
  await chrome.action.setBadgeBackgroundColor({ color: "#36c98f" });
  await chrome.action.setBadgeText({ text: activeCount > 0 ? String(activeCount) : "" });
}

function postToMeterPorts(message) {
  for (const port of meterPorts.keys()) {
    try {
      port.postMessage(message);
    } catch {
      meterPorts.delete(port);
    }
  }
}

async function updateMeterSubscription() {
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({
      type: MessageType.SET_METER_SUBSCRIBERS,
      count: meterPorts.size,
    }).catch(() => null);
  }
}

async function startTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!isCapturableUrl(tab.url)) {
    lastErrors.set(tabId, ErrorCode.UNSUPPORTED_URL);
    return getState(tabId);
  }

  lastErrors.delete(tabId);
  const settings = await loadSettings();
  postToMeterPorts({
    type: MessageType.OFFSCREEN_STATUS,
    tabStatus: { tabId, state: "starting", errorCode: null },
  });

  let streamId;
  try {
    // Keep this call as close as possible to the popup's user gesture.
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    await ensureOffscreenDocument();
    const response = await sendToOffscreen({
      type: MessageType.START_TAB,
      tabId,
      streamId,
      wasAudible: Boolean(tab.audible),
      settings,
    });
    if (!response?.ok) {
      lastErrors.set(tabId, response?.errorCode ?? ErrorCode.PROCESSOR_ERROR);
    }
  } catch (error) {
    lastErrors.set(tabId, normalizeError(error));
  }
  await updateMeterSubscription();
  return getState(tabId);
}

async function stopTab(tabId) {
  lastErrors.delete(tabId);
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ type: MessageType.STOP_TAB, tabId }).catch(() => null);
  }
  return getState(tabId);
}

async function getState(tabId) {
  const settings = await loadSettings();
  let offscreenState = null;
  if (await hasOffscreenDocument()) {
    offscreenState = await sendToOffscreen({ type: MessageType.GET_STATE, tabId }).catch(() => null);
  }
  const tabStatus = offscreenState?.tabStatus ?? {
    tabId,
    state: lastErrors.has(tabId) ? "error" : "idle",
    errorCode: lastErrors.get(tabId) ?? null,
  };
  if (tabStatus.state === "idle" && lastErrors.has(tabId)) {
    tabStatus.state = "error";
    tabStatus.errorCode = lastErrors.get(tabId);
  }
  const activeCount = offscreenState?.activeCount ?? 0;
  await setBadge(activeCount);
  return {
    ok: true,
    settings,
    tabStatus,
    activeCount,
  };
}

async function setSettings(settingsValue) {
  const settings = await saveSettings(settingsValue);
  if (await hasOffscreenDocument()) {
    await sendToOffscreen({ type: MessageType.SET_SETTINGS, settings }).catch(() => null);
  }
  return { ok: true, settings };
}

async function handleMessage(message) {
  switch (message.type) {
    case MessageType.START_TAB:
      return startTab(message.tabId);
    case MessageType.STOP_TAB:
      return stopTab(message.tabId);
    case MessageType.GET_STATE:
      return getState(message.tabId);
    case MessageType.SET_SETTINGS:
      return setSettings(message.settings);
    case MessageType.METER_UPDATE:
      postToMeterPorts(message);
      return { ok: true };
    case MessageType.OFFSCREEN_STATUS: {
      const { tabStatus, activeCount = 0 } = message;
      if (tabStatus?.state === "error") {
        lastErrors.set(tabStatus.tabId, tabStatus.errorCode);
      } else if (tabStatus?.tabId !== undefined) {
        lastErrors.delete(tabStatus.tabId);
      }
      await setBadge(activeCount);
      postToMeterPorts(message);
      return { ok: true };
    }
    default:
      return { ok: false, errorCode: ErrorCode.PROCESSOR_ERROR };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "background") {
    return undefined;
  }
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, errorCode: normalizeError(error) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "dynamic-volume-meters") {
    return;
  }
  meterPorts.set(port, null);
  port.onMessage.addListener((message) => {
    if (message.type === MessageType.SUBSCRIBE_METERS) {
      meterPorts.set(port, message.tabId);
      updateMeterSubscription().catch(() => null);
    }
  });
  port.onDisconnect.addListener(() => {
    meterPorts.delete(port);
    updateMeterSubscription().catch(() => null);
  });
  updateMeterSubscription().catch(() => null);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastErrors.delete(tabId);
  if (creatingOffscreen || meterPorts.size > 0) {
    sendToOffscreen({ type: MessageType.STOP_TAB, tabId }).catch(() => null);
  } else {
    hasOffscreenDocument().then((exists) => {
      if (exists) {
        sendToOffscreen({ type: MessageType.STOP_TAB, tabId }).catch(() => null);
      }
    });
  }
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  if (info.status === "stopped" || info.status === "error") {
    sendToOffscreen({ type: MessageType.EXTERNAL_STOP, tabId: info.tabId }).catch(() => null);
  }
});
