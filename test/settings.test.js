import test from "node:test";
import assert from "node:assert/strict";

import {
  dbToGain,
  DEFAULT_SETTINGS,
  effectiveCompressor,
  gainToDb,
  PRESETS,
  sanitizeSettings,
} from "../shared/settings.js";

test("decibel and gain conversions round-trip", () => {
  for (const db of [-60, -18, -1, 0, 6]) {
    assert.ok(Math.abs(gainToDb(dbToGain(db)) - db) < 1e-10);
  }
});

test("settings validation clamps untrusted values", () => {
  const settings = sanitizeSettings({
    presetId: "not-a-preset",
    strength: 4,
    compressor: {
      thresholdDb: -100,
      kneeDb: 100,
      ratio: -3,
      attackSeconds: 8,
      releaseSeconds: 0,
    },
    outputTrimDb: 99,
    autoLevel: { enabled: 1, targetLufs: -40, maxBoostDb: 99, maxCutDb: -99 },
  });

  assert.equal(settings.version, 1);
  assert.equal(settings.presetId, DEFAULT_SETTINGS.presetId);
  assert.equal(settings.strength, 1);
  assert.deepEqual(settings.compressor, {
    thresholdDb: -60,
    kneeDb: 40,
    ratio: 1,
    attackSeconds: 1,
    releaseSeconds: 0.01,
  });
  assert.equal(settings.outputTrimDb, 6);
  assert.deepEqual(settings.autoLevel, {
    enabled: true,
    targetLufs: -24,
    maxBoostDb: 12,
    maxCutDb: -12,
  });
});

test("zero strength is neutral and full strength matches the preset", () => {
  const neutral = effectiveCompressor({
    ...DEFAULT_SETTINGS,
    strength: 0,
  });
  assert.equal(neutral.thresholdDb, 0);
  assert.equal(neutral.kneeDb, 0);
  assert.equal(neutral.ratio, 1);

  const full = effectiveCompressor({
    ...DEFAULT_SETTINGS,
    strength: 1,
    compressor: PRESETS.night,
  });
  assert.deepEqual(full, PRESETS.night);
});
