import { clamp } from "../shared/settings.js";

export const DEFAULT_CONTROLLER_OPTIONS = Object.freeze({
  targetLufs: -18,
  deadbandLu: 1.5,
  maxBoostDb: 9,
  maxCutDb: -9,
  silenceGateLufs: -55,
  boostRateDbPerSecond: 1,
  attenuationRateDbPerSecond: 6,
});

export class LevelController {
  constructor(options = {}) {
    this.gainDb = 0;
    this.configure(options);
  }

  configure(options = {}) {
    this.options = {
      ...DEFAULT_CONTROLLER_OPTIONS,
      ...options,
    };
    this.options.targetLufs = clamp(this.options.targetLufs, -24, -14, -18);
    this.options.deadbandLu = clamp(this.options.deadbandLu, 0, 6, 1.5);
    this.options.maxBoostDb = clamp(this.options.maxBoostDb, 0, 12, 9);
    this.options.maxCutDb = clamp(this.options.maxCutDb, -12, 0, -9);
    this.options.silenceGateLufs = clamp(this.options.silenceGateLufs, -90, -30, -55);
    this.options.boostRateDbPerSecond = clamp(
      this.options.boostRateDbPerSecond,
      0.1,
      12,
      1,
    );
    this.options.attenuationRateDbPerSecond = clamp(
      this.options.attenuationRateDbPerSecond,
      0.1,
      24,
      6,
    );
  }

  reset() {
    this.gainDb = 0;
    return this.gainDb;
  }

  update({ shortTermLufs = null, momentaryLufs = null, deltaSeconds = 0.1 } = {}) {
    const shortTerm = Number.isFinite(shortTermLufs) ? shortTermLufs : null;
    const momentary = Number.isFinite(momentaryLufs) ? momentaryLufs : null;
    const reference = shortTerm ?? momentary;
    if (reference === null || reference < this.options.silenceGateLufs) {
      return this.gainDb;
    }

    let desiredDb = this.options.targetLufs - reference;
    if (Math.abs(desiredDb) <= this.options.deadbandLu) {
      desiredDb = 0;
    }

    // A loud momentary window may request faster attenuation, but a quiet transient
    // never requests more boost than the stable short-term measurement.
    if (momentary !== null && momentary >= this.options.silenceGateLufs) {
      let momentaryDesired = this.options.targetLufs - momentary;
      if (Math.abs(momentaryDesired) <= this.options.deadbandLu) {
        momentaryDesired = 0;
      }
      if (momentaryDesired < desiredDb) {
        desiredDb = momentaryDesired;
      }
    }

    desiredDb = clamp(
      desiredDb,
      this.options.maxCutDb,
      this.options.maxBoostDb,
      this.gainDb,
    );
    const delta = desiredDb - this.gainDb;
    const seconds = clamp(deltaSeconds, 0.001, 1, 0.1);
    const maxStep =
      (delta < 0
        ? this.options.attenuationRateDbPerSecond
        : this.options.boostRateDbPerSecond) * seconds;
    this.gainDb += Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
    this.gainDb = clamp(
      this.gainDb,
      this.options.maxCutDb,
      this.options.maxBoostDb,
      0,
    );
    return this.gainDb;
  }
}
