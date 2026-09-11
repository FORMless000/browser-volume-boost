export const MessageType = Object.freeze({
  START_TAB: "START_TAB",
  STOP_TAB: "STOP_TAB",
  GET_STATE: "GET_STATE",
  SET_SETTINGS: "SET_SETTINGS",
  SUBSCRIBE_METERS: "SUBSCRIBE_METERS",
  SET_METER_SUBSCRIBERS: "SET_METER_SUBSCRIBERS",
  METER_UPDATE: "METER_UPDATE",
  OFFSCREEN_STATUS: "OFFSCREEN_STATUS",
  EXTERNAL_STOP: "EXTERNAL_STOP",
});

export const ErrorCode = Object.freeze({
  UNSUPPORTED_URL: "UNSUPPORTED_URL",
  CAPTURE_DENIED: "CAPTURE_DENIED",
  NO_AUDIO: "NO_AUDIO",
  STREAM_ENDED: "STREAM_ENDED",
  PROCESSOR_ERROR: "PROCESSOR_ERROR",
});

export function isCapturableUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
      return false;
    }
    return !(
      parsed.hostname === "chromewebstore.google.com" ||
      (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore"))
    );
  } catch {
    return false;
  }
}
