const LUFS_OFFSET = -0.691;

// ITU-R BS.1770 K-weighting coefficients for 48 kHz PCM.
export const K_WEIGHTING_COEFFICIENTS_48K = Object.freeze([
  Object.freeze({
    b: Object.freeze([1.53512485958697, -2.69169618940638, 1.19839281085285]),
    a: Object.freeze([1, -1.69065929318241, 0.73248077421585]),
  }),
  Object.freeze({
    b: Object.freeze([1, -2, 1]),
    a: Object.freeze([1, -1.99004745483398, 0.99007225036621]),
  }),
]);

export function meanSquareToLufs(meanSquare) {
  const numeric = Number(meanSquare);
  return numeric > 0 ? LUFS_OFFSET + 10 * Math.log10(numeric) : -Infinity;
}

export class BiquadFilterState {
  constructor(coefficients) {
    this.b = coefficients.b;
    this.a = coefficients.a;
    this.z1 = 0;
    this.z2 = 0;
  }

  process(sample) {
    const value = Number.isFinite(sample) ? sample : 0;
    const output = this.b[0] * value + this.z1;
    this.z1 = this.b[1] * value - this.a[1] * output + this.z2;
    this.z2 = this.b[2] * value - this.a[2] * output;
    return output;
  }
}

export class KWeightingFilter {
  constructor() {
    this.stages = K_WEIGHTING_COEFFICIENTS_48K.map(
      (coefficients) => new BiquadFilterState(coefficients),
    );
  }

  process(sample) {
    let output = sample;
    for (const stage of this.stages) {
      output = stage.process(output);
    }
    return output;
  }
}

export class RollingLoudnessMeter {
  constructor({ sampleRate = 48000, momentarySeconds = 0.4, shortTermSeconds = 3 } = {}) {
    if (sampleRate !== 48000) {
      throw new RangeError("The v1 loudness meter requires a 48 kHz AudioContext.");
    }
    this.sampleRate = sampleRate;
    this.momentaryFrames = Math.round(sampleRate * momentarySeconds);
    this.shortTermFrames = Math.round(sampleRate * shortTermSeconds);
    this.energyRing = new Float64Array(this.shortTermFrames);
    this.filters = [];
    this.position = 0;
    this.totalFrames = 0;
    this.momentaryEnergy = 0;
    this.shortTermEnergy = 0;
    this.rawPeak = 0;
  }

  ensureChannels(channelCount) {
    while (this.filters.length < channelCount) {
      this.filters.push(new KWeightingFilter());
    }
  }

  pushFrame(samples) {
    const channelCount = Math.max(1, samples.length);
    this.ensureChannels(channelCount);
    let energy = 0;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const raw = Number.isFinite(samples[channel]) ? samples[channel] : 0;
      this.rawPeak = Math.max(this.rawPeak, Math.abs(raw));
      const weighted = this.filters[channel].process(raw);
      energy += weighted * weighted;
    }

    if (this.totalFrames >= this.shortTermFrames) {
      this.shortTermEnergy -= this.energyRing[this.position];
    }
    if (this.totalFrames >= this.momentaryFrames) {
      const leavingMomentary =
        (this.position - this.momentaryFrames + this.shortTermFrames) % this.shortTermFrames;
      this.momentaryEnergy -= this.energyRing[leavingMomentary];
    }

    this.energyRing[this.position] = energy;
    this.position = (this.position + 1) % this.shortTermFrames;
    this.totalFrames += 1;
    this.momentaryEnergy += energy;
    this.shortTermEnergy += energy;
  }

  snapshot({ requireFullWindows = true, resetPeak = false } = {}) {
    const momentaryCount = Math.min(this.totalFrames, this.momentaryFrames);
    const shortTermCount = Math.min(this.totalFrames, this.shortTermFrames);
    const momentaryReady = !requireFullWindows || this.totalFrames >= this.momentaryFrames;
    const shortTermReady = !requireFullWindows || this.totalFrames >= this.shortTermFrames;
    const rawPeakDbfs = this.rawPeak > 0 ? 20 * Math.log10(this.rawPeak) : -Infinity;

    const result = {
      momentaryLufs: momentaryReady
        ? meanSquareToLufs(this.momentaryEnergy / Math.max(1, momentaryCount))
        : null,
      shortTermLufs: shortTermReady
        ? meanSquareToLufs(this.shortTermEnergy / Math.max(1, shortTermCount))
        : null,
      rawPeakDbfs,
    };

    if (resetPeak) {
      this.rawPeak = 0;
    }
    return result;
  }
}
