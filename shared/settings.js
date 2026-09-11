export const SETTINGS_KEY = "globalSettingsV1";

export const PRESETS = Object.freeze({
  gentle: Object.freeze({
    thresholdDb: -14,
    kneeDb: 18,
    ratio: 2,
    attackSeconds: 0.015,
    releaseSeconds: 0.22,
  }),
  balanced: Object.freeze({
    thresholdDb: -22,
    kneeDb: 24,
    ratio: 3,
    attackSeconds: 0.01,
    releaseSeconds: 0.28,
  }),
  dialogue: Object.freeze({
    thresholdDb: -30,
    kneeDb: 30,
    ratio: 4.5,
    attackSeconds: 0.008,
    releaseSeconds: 0.35,
  }),
  night: Object.freeze({
    thresholdDb: -38,
    kneeDb: 36,
    ratio: 8,
    attackSeconds: 0.003,
    releaseSeconds: 0.5,
  }),
});

const PRESET_IDS = new Set([...Object.keys(PRESETS), "custom"]);

export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  presetId: "balanced",
  strength: 0.65,
  compressor: PRESETS.balanced,
  outputTrimDb: 0,
  autoLevel: Object.freeze({
    enabled: false,
    targetLufs: -18,
    maxBoostDb: 9,
    maxCutDb: -9,
  }),
});

export function clamp(value, min, max, fallback = min) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
}

export function dbToGain(db) {
  return 10 ** (Number(db) / 20);
}

export function gainToDb(gain, floorDb = -120) {
  const numeric = Number(gain);
  return numeric > 0 ? Math.max(floorDb, 20 * Math.log10(numeric)) : floorDb;
}

export function clonePreset(presetId) {
  const preset = PRESETS[presetId] ?? PRESETS.balanced;
  return { ...preset };
}

function sanitizeCompressor(value, fallback) {
  const source = value && typeof value === "object" ? value : {};
  return {
    thresholdDb: clamp(source.thresholdDb, -60, 0, fallback.thresholdDb),
    kneeDb: clamp(source.kneeDb, 0, 40, fallback.kneeDb),
    ratio: clamp(source.ratio, 1, 20, fallback.ratio),
    attackSeconds: clamp(source.attackSeconds, 0, 1, fallback.attackSeconds),
    releaseSeconds: clamp(source.releaseSeconds, 0.01, 1, fallback.releaseSeconds),
  };
}

export function sanitizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  const presetId = PRESET_IDS.has(source.presetId) ? source.presetId : DEFAULT_SETTINGS.presetId;
  const presetFallback = presetId === "custom" ? PRESETS.balanced : PRESETS[presetId];
  const autoLevel = source.autoLevel && typeof source.autoLevel === "object" ? source.autoLevel : {};

  return {
    version: 1,
    presetId,
    strength: clamp(source.strength, 0, 1, DEFAULT_SETTINGS.strength),
    compressor: sanitizeCompressor(source.compressor, presetFallback),
    outputTrimDb: clamp(source.outputTrimDb, -12, 6, DEFAULT_SETTINGS.outputTrimDb),
    autoLevel: {
      enabled: Boolean(autoLevel.enabled),
      targetLufs: clamp(autoLevel.targetLufs, -24, -14, DEFAULT_SETTINGS.autoLevel.targetLufs),
      maxBoostDb: clamp(autoLevel.maxBoostDb, 0, 12, DEFAULT_SETTINGS.autoLevel.maxBoostDb),
      maxCutDb: clamp(autoLevel.maxCutDb, -12, 0, DEFAULT_SETTINGS.autoLevel.maxCutDb),
    },
  };
}

export function effectiveCompressor(settingsValue) {
  const settings = sanitizeSettings(settingsValue);
  const strength = settings.strength;
  const base = settings.compressor;
  return {
    thresholdDb: strength === 0 ? 0 : base.thresholdDb * strength,
    kneeDb: base.kneeDb * strength,
    ratio: 1 + (base.ratio - 1) * strength,
    attackSeconds: base.attackSeconds,
    releaseSeconds: base.releaseSeconds,
  };
}

export async function loadSettings(storageArea = chrome.storage.local) {
  const stored = await storageArea.get(SETTINGS_KEY);
  return sanitizeSettings(stored[SETTINGS_KEY] ?? DEFAULT_SETTINGS);
}

export async function saveSettings(settings, storageArea = chrome.storage.local) {
  const validated = sanitizeSettings(settings);
  await storageArea.set({ [SETTINGS_KEY]: validated });
  return validated;
}
