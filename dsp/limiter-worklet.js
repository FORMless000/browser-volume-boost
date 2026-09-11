import { SamplePeakLimiter } from "./limiter-core.js";

class SamplePeakLimiterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.limiter = new SamplePeakLimiter({
      sampleRate,
      ...(options.processorOptions ?? {}),
    });
    this.framesSinceReport = 0;
    this.reportIntervalFrames = Math.round(sampleRate / 10);
  }

  process(inputs, outputs) {
    this.limiter.processBlock(inputs[0] ?? [], outputs[0] ?? []);
    const frameCount = outputs[0]?.[0]?.length ?? 0;
    this.framesSinceReport += frameCount;
    if (this.framesSinceReport >= this.reportIntervalFrames) {
      this.framesSinceReport %= this.reportIntervalFrames;
      this.port.postMessage(this.limiter.metrics({ resetPeak: true }));
    }
    return true;
  }
}

registerProcessor("sample-peak-limiter", SamplePeakLimiterProcessor);
