import { ErrorCode, isCapturableUrl, MessageType } from "../shared/protocol.js";
import {
  clonePreset,
  DEFAULT_SETTINGS,
  PRESETS,
  sanitizeSettings,
} from "../shared/settings.js";

const elements = Object.fromEntries(
  [
    "active-count", "status-dot", "status-title", "status-detail", "tab-toggle",
    "peak-value", "meter-fill", "preset-grid", "preset-label", "strength",
    "strength-value", "auto-level", "threshold", "threshold-value", "knee",
    "knee-value", "ratio", "ratio-value", "attack", "attack-value", "release",
    "release-value", "trim", "trim-value", "target", "target-value", "boost",
    "boost-value", "loudness-value", "compression-value", "gain-value",
    "limiter-value", "reset-settings",
  ].map((id) => [id, document.getElementById(id)]),
);

const errorCopy = {
  [ErrorCode.UNSUPPORTED_URL]: ["Unsupported page", "Chrome internal and Web Store pages cannot be captured."],
  [ErrorCode.CAPTURE_DENIED]: ["Capture unavailable", "Activate the tab and try again from this popup."],
  [ErrorCode.NO_AUDIO]: ["No capturable audio", "The stream was silent, so native audio was restored."],
  [ErrorCode.STREAM_ENDED]: ["Audio stream ended", "Enable processing again when the tab is playing."],
  [ErrorCode.PROCESSOR_ERROR]: ["Processing failed", "Native audio was restored. Try enabling again."],
};

let currentTab = null;
let settings = sanitizeSettings(DEFAULT_SETTINGS);
let tabStatus = { state: "idle", errorCode: null };
let activeCount = 0;
let meterPort = null;
let saveTimer = null;

function send(message) {
  return chrome.runtime.sendMessage({ ...message, target: "background" });
}

function titleCase(value) {
  return value ? value[0].toUpperCase() + value.slice(1) : "Custom";
}

function formatDb(value, suffix = "dB") {
  return Number.isFinite(value) ? `${value > 0 ? "+" : ""}${value.toFixed(1)} ${suffix}` : "—";
}

function setRange(id, value, label) {
  elements[id].value = String(value);
  elements[`${id}-value`].textContent = label;
}

function renderSettings() {
  for (const button of elements["preset-grid"].querySelectorAll("button")) {
    button.classList.toggle("selected", button.dataset.preset === settings.presetId);
  }
  elements["preset-label"].textContent = titleCase(settings.presetId);
  elements.strength.value = String(Math.round(settings.strength * 100));
  elements["strength-value"].textContent = `${Math.round(settings.strength * 100)}%`;
  elements["auto-level"].checked = settings.autoLevel.enabled;
  setRange("threshold", settings.compressor.thresholdDb, `${settings.compressor.thresholdDb.toFixed(0)} dB`);
  setRange("knee", settings.compressor.kneeDb, `${settings.compressor.kneeDb.toFixed(0)} dB`);
  setRange("ratio", settings.compressor.ratio, `${settings.compressor.ratio.toFixed(1)}:1`);
  setRange("attack", settings.compressor.attackSeconds * 1000, `${Math.round(settings.compressor.attackSeconds * 1000)} ms`);
  setRange("release", settings.compressor.releaseSeconds * 1000, `${Math.round(settings.compressor.releaseSeconds * 1000)} ms`);
  setRange("trim", settings.outputTrimDb, formatDb(settings.outputTrimDb));
  setRange("target", settings.autoLevel.targetLufs, `${settings.autoLevel.targetLufs.toFixed(0)} LUFS`);
  setRange("boost", settings.autoLevel.maxBoostDb, `+${settings.autoLevel.maxBoostDb.toFixed(0)} dB`);
}

function renderStatus() {
  const capturable = currentTab && isCapturableUrl(currentTab.url);
  const state = capturable ? tabStatus.state : "error";
  const errorCode = capturable ? tabStatus.errorCode : ErrorCode.UNSUPPORTED_URL;
  elements["active-count"].textContent = String(activeCount);
  elements["status-dot"].className = `status-dot ${state === "active" ? "active" : state === "error" ? "error" : ""}`;
  elements["tab-toggle"].classList.toggle("stop", state === "active");

  if (state === "active") {
    elements["status-title"].textContent = "Processing this tab";
    elements["status-detail"].textContent = "Closing this popup will not stop the audio graph.";
    elements["tab-toggle"].textContent = "Disable";
    elements["tab-toggle"].disabled = false;
  } else if (state === "starting") {
    elements["status-title"].textContent = "Starting audio graph…";
    elements["status-detail"].textContent = "Capturing and reconnecting tab audio.";
    elements["tab-toggle"].textContent = "Starting";
    elements["tab-toggle"].disabled = true;
  } else if (state === "error") {
    const [title, detail] = errorCopy[errorCode] ?? errorCopy[ErrorCode.PROCESSOR_ERROR];
    elements["status-title"].textContent = title;
    elements["status-detail"].textContent = detail;
    elements["tab-toggle"].textContent = "Try again";
    elements["tab-toggle"].disabled = !capturable;
  } else {
    elements["status-title"].textContent = "Ready for this tab";
    elements["status-detail"].textContent = "Audio stays entirely on this device.";
    elements["tab-toggle"].textContent = "Enable";
    elements["tab-toggle"].disabled = !capturable;
  }
}

function renderMeters(snapshot) {
  const peak = snapshot.outputPeakDbfs;
  const normalized = Number.isFinite(peak) ? Math.max(0, Math.min(1, (peak + 60) / 60)) : 0;
  elements["meter-fill"].style.width = `${normalized * 100}%`;
  elements["peak-value"].textContent = Number.isFinite(peak) ? `${peak.toFixed(1)} dBFS` : "— dBFS";
  elements["loudness-value"].textContent = Number.isFinite(snapshot.shortTermLufs)
    ? `${snapshot.shortTermLufs.toFixed(1)} LUFS`
    : "—";
  elements["compression-value"].textContent = formatDb(snapshot.compressorReductionDb);
  elements["gain-value"].textContent = formatDb(snapshot.autoGainDb);
  elements["limiter-value"].textContent = formatDb(snapshot.limiterReductionDb);
}

async function refreshState() {
  if (!currentTab) return;
  const response = await send({ type: MessageType.GET_STATE, tabId: currentTab.id });
  if (response?.ok) {
    settings = sanitizeSettings(response.settings);
    tabStatus = response.tabStatus;
    activeCount = response.activeCount;
    renderSettings();
    renderStatus();
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const response = await send({ type: MessageType.SET_SETTINGS, settings });
    if (response?.ok) {
      settings = sanitizeSettings(response.settings);
      renderSettings();
    }
  }, 60);
}

function setCustomCompressor(field, value) {
  settings = sanitizeSettings({
    ...settings,
    presetId: "custom",
    strength: 1,
    compressor: { ...settings.compressor, [field]: value },
  });
  renderSettings();
  scheduleSave();
}

elements["tab-toggle"].addEventListener("click", async () => {
  if (!currentTab) return;
  if (tabStatus.state === "active") {
    tabStatus = { tabId: currentTab.id, state: "idle", errorCode: null };
    renderStatus();
    const response = await send({ type: MessageType.STOP_TAB, tabId: currentTab.id });
    if (response?.ok) {
      tabStatus = response.tabStatus;
      activeCount = response.activeCount;
    }
  } else {
    tabStatus = { tabId: currentTab.id, state: "starting", errorCode: null };
    renderStatus();
    const response = await send({ type: MessageType.START_TAB, tabId: currentTab.id });
    if (response?.ok) {
      tabStatus = response.tabStatus;
      activeCount = response.activeCount;
      settings = sanitizeSettings(response.settings);
    } else {
      tabStatus = { tabId: currentTab.id, state: "error", errorCode: response?.errorCode };
    }
  }
  renderSettings();
  renderStatus();
});

elements["preset-grid"].addEventListener("click", (event) => {
  const presetId = event.target.closest("button")?.dataset.preset;
  if (!PRESETS[presetId]) return;
  settings = sanitizeSettings({
    ...settings,
    presetId,
    compressor: clonePreset(presetId),
  });
  renderSettings();
  scheduleSave();
});

elements.strength.addEventListener("input", () => {
  settings = sanitizeSettings({ ...settings, strength: Number(elements.strength.value) / 100 });
  elements["strength-value"].textContent = `${elements.strength.value}%`;
  scheduleSave();
});

elements["auto-level"].addEventListener("change", () => {
  settings = sanitizeSettings({
    ...settings,
    autoLevel: { ...settings.autoLevel, enabled: elements["auto-level"].checked },
  });
  scheduleSave();
});

for (const [id, field, transform] of [
  ["threshold", "thresholdDb", Number],
  ["knee", "kneeDb", Number],
  ["ratio", "ratio", Number],
  ["attack", "attackSeconds", (value) => Number(value) / 1000],
  ["release", "releaseSeconds", (value) => Number(value) / 1000],
]) {
  elements[id].addEventListener("input", () => setCustomCompressor(field, transform(elements[id].value)));
}

elements.trim.addEventListener("input", () => {
  settings = sanitizeSettings({ ...settings, outputTrimDb: Number(elements.trim.value) });
  renderSettings();
  scheduleSave();
});
elements.target.addEventListener("input", () => {
  settings = sanitizeSettings({
    ...settings,
    autoLevel: { ...settings.autoLevel, targetLufs: Number(elements.target.value) },
  });
  renderSettings();
  scheduleSave();
});
elements.boost.addEventListener("input", () => {
  settings = sanitizeSettings({
    ...settings,
    autoLevel: { ...settings.autoLevel, maxBoostDb: Number(elements.boost.value) },
  });
  renderSettings();
  scheduleSave();
});

elements["reset-settings"].addEventListener("click", () => {
  settings = sanitizeSettings(DEFAULT_SETTINGS);
  renderSettings();
  scheduleSave();
});

async function initialize() {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!currentTab) {
    tabStatus = { state: "error", errorCode: ErrorCode.UNSUPPORTED_URL };
    renderStatus();
    return;
  }
  meterPort = chrome.runtime.connect({ name: "dynamic-volume-meters" });
  meterPort.postMessage({ type: MessageType.SUBSCRIBE_METERS, tabId: currentTab.id });
  meterPort.onMessage.addListener((message) => {
    if (message.type === MessageType.METER_UPDATE && message.snapshot?.tabId === currentTab.id) {
      renderMeters(message.snapshot);
    }
    if (message.type === MessageType.OFFSCREEN_STATUS) {
      activeCount = message.activeCount ?? activeCount;
      if (message.tabStatus?.tabId === currentTab.id) {
        tabStatus = message.tabStatus;
      }
      renderStatus();
    }
  });
  await refreshState();
}

initialize().catch(() => {
  tabStatus = { state: "error", errorCode: ErrorCode.PROCESSOR_ERROR };
  renderStatus();
});
