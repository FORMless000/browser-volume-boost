import test from "node:test";
import assert from "node:assert/strict";

import { LevelController } from "../dsp/level-controller.js";
import { SamplePeakLimiter } from "../dsp/limiter-core.js";
import { meanSquareToLufs, RollingLoudnessMeter } from "../dsp/loudness.js";
import { dbToGain } from "../shared/settings.js";

test("mean-square loudness conversion has the BS.1770 offset", () => {
  assert.ok(Math.abs(meanSquareToLufs(1) - -0.691) < 1e-12);
  assert.equal(meanSquareToLufs(0), -Infinity);
});

test("rolling loudness windows become ready at 400 ms and 3 s", () => {
  const meter = new RollingLoudnessMeter();
  const sample = (index) => 0.1 * Math.sin((2 * Math.PI * 1000 * index) / 48000);
  for (let index = 0; index < 19200 - 1; index += 1) {
    meter.pushFrame([sample(index), sample(index)]);
  }
  assert.equal(meter.snapshot().momentaryLufs, null);
  meter.pushFrame([sample(19199), sample(19199)]);
  assert.ok(Number.isFinite(meter.snapshot().momentaryLufs));
  assert.equal(meter.snapshot().shortTermLufs, null);

  for (let index = 19200; index < 144000; index += 1) {
    meter.pushFrame([sample(index), sample(index)]);
  }
  const snapshot = meter.snapshot();
  assert.ok(Number.isFinite(snapshot.shortTermLufs));
  assert.ok(Math.abs(snapshot.shortTermLufs - snapshot.momentaryLufs) < 0.05);
});

test("auto level respects boost, cut, rate, deadband, and silence hold", () => {
  const controller = new LevelController();
  assert.equal(controller.update({ shortTermLufs: -80 }), 0);

  for (let index = 0; index < 200; index += 1) {
    controller.update({ shortTermLufs: -40, momentaryLufs: -40, deltaSeconds: 0.1 });
  }
  assert.equal(controller.gainDb, 9);
  assert.equal(controller.update({ shortTermLufs: -80 }), 9);

  controller.update({ shortTermLufs: -18, momentaryLufs: -5, deltaSeconds: 0.1 });
  assert.ok(controller.gainDb <= 8.4 + 1e-12);
  for (let index = 0; index < 100; index += 1) {
    controller.update({ shortTermLufs: -5, momentaryLufs: -5, deltaSeconds: 0.1 });
  }
  assert.equal(controller.gainDb, -9);
});

test("sample-peak limiter delays and caps a linked stereo impulse", () => {
  const limiter = new SamplePeakLimiter();
  const frames = limiter.lookAheadFrames + 64;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  left[0] = 2;
  right[0] = -2;
  const outputLeft = new Float32Array(frames);
  const outputRight = new Float32Array(frames);
  limiter.processBlock([left, right], [outputLeft, outputRight]);

  const ceiling = dbToGain(-1);
  assert.ok(Math.abs(outputLeft[limiter.lookAheadFrames]) <= ceiling + 1e-6);
  assert.ok(Math.abs(outputRight[limiter.lookAheadFrames]) <= ceiling + 1e-6);
  assert.equal(outputLeft[0], 0);
  assert.ok(limiter.metrics().outputPeakDbfs <= -1 + 1e-5);
});

test("limiter keeps silence finite and preserves stereo linking", () => {
  const limiter = new SamplePeakLimiter();
  const left = new Float32Array(1000);
  const right = new Float32Array(1000);
  left[10] = Number.NaN;
  right[300] = 1.5;
  const outputLeft = new Float32Array(1000);
  const outputRight = new Float32Array(1000);
  limiter.processBlock([left, right], [outputLeft, outputRight]);
  assert.ok(outputLeft.every(Number.isFinite));
  assert.ok(outputRight.every(Number.isFinite));
  assert.ok(limiter.gain <= 1 && limiter.gain > 0);
});
