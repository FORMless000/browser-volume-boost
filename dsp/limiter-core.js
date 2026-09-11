import { dbToGain, gainToDb } from "../shared/settings.js";

export class SamplePeakLimiter {
  constructor({ sampleRate = 48000, ceilingDb = -1, lookAheadSeconds = 0.005, releaseSeconds = 0.1 } = {}) {
    this.sampleRate = sampleRate;
    this.ceiling = dbToGain(ceilingDb);
    this.ceilingDb = ceilingDb;
    this.lookAheadFrames = Math.max(1, Math.round(sampleRate * lookAheadSeconds));
    this.releaseCoefficient = Math.exp(-1 / (Math.max(0.001, releaseSeconds) * sampleRate));
    this.delayBuffers = [];
    this.delayPosition = 0;
    this.sampleIndex = -1;
    this.dequeCapacity = this.lookAheadFrames + 2;
    this.dequeIndices = new Float64Array(this.dequeCapacity);
    this.dequePeaks = new Float32Array(this.dequeCapacity);
    this.dequeHead = 0;
    this.dequeTail = 0;
    this.dequeSize = 0;
    this.gain = 1;
    this.outputPeak = 0;
  }

  ensureChannels(channelCount) {
    while (this.delayBuffers.length < channelCount) {
      this.delayBuffers.push(new Float32Array(this.lookAheadFrames));
    }
  }

  processBlock(inputChannels, outputChannels) {
    const channelCount = Math.max(inputChannels.length, outputChannels.length, 1);
    const frameCount = outputChannels[0]?.length ?? inputChannels[0]?.length ?? 0;
    this.ensureChannels(channelCount);

    for (let frame = 0; frame < frameCount; frame += 1) {
      this.sampleIndex += 1;
      let linkedPeak = 0;
      for (let channel = 0; channel < channelCount; channel += 1) {
        const sample = inputChannels[channel]?.[frame] ?? 0;
        linkedPeak = Math.max(linkedPeak, Math.abs(Number.isFinite(sample) ? sample : 0));
      }

      while (this.dequeSize > 0) {
        const last = (this.dequeTail - 1 + this.dequeCapacity) % this.dequeCapacity;
        if (this.dequePeaks[last] > linkedPeak) {
          break;
        }
        this.dequeTail = last;
        this.dequeSize -= 1;
      }
      this.dequeIndices[this.dequeTail] = this.sampleIndex;
      this.dequePeaks[this.dequeTail] = linkedPeak;
      this.dequeTail = (this.dequeTail + 1) % this.dequeCapacity;
      this.dequeSize += 1;
      const oldestAllowed = this.sampleIndex - this.lookAheadFrames;
      while (
        this.dequeSize > 0 &&
        this.dequeIndices[this.dequeHead] < oldestAllowed
      ) {
        this.dequeHead = (this.dequeHead + 1) % this.dequeCapacity;
        this.dequeSize -= 1;
      }

      const windowPeak = this.dequeSize > 0 ? this.dequePeaks[this.dequeHead] : 0;
      const targetGain = windowPeak > this.ceiling ? this.ceiling / windowPeak : 1;
      if (targetGain < this.gain) {
        this.gain = targetGain;
      } else {
        this.gain = targetGain + this.releaseCoefficient * (this.gain - targetGain);
      }

      for (let channel = 0; channel < channelCount; channel += 1) {
        const input = inputChannels[channel]?.[frame] ?? 0;
        const delayed = this.delayBuffers[channel][this.delayPosition];
        this.delayBuffers[channel][this.delayPosition] = Number.isFinite(input) ? input : 0;
        const output = delayed * this.gain;
        if (outputChannels[channel]) {
          outputChannels[channel][frame] = output;
        }
        this.outputPeak = Math.max(this.outputPeak, Math.abs(output));
      }
      this.delayPosition = (this.delayPosition + 1) % this.lookAheadFrames;
    }
  }

  metrics({ resetPeak = false } = {}) {
    const result = {
      reductionDb: Math.min(0, gainToDb(this.gain)),
      outputPeakDbfs: gainToDb(this.outputPeak),
    };
    if (resetPeak) {
      this.outputPeak = 0;
    }
    return result;
  }
}
