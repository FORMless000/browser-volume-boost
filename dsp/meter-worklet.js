import { RollingLoudnessMeter } from "./loudness.js";

class LoudnessMeterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.meter = new RollingLoudnessMeter({ sampleRate });
    this.framesSinceReport = 0;
    this.reportIntervalFrames = Math.round(sampleRate / 10);
  }

  process(inputs, outputs) {
    const input = inputs[0] ?? [];
    const output = outputs[0] ?? [];
    const frameCount = input[0]?.length ?? output[0]?.length ?? 0;
    const frame = new Array(Math.max(1, input.length));

    for (let index = 0; index < frameCount; index += 1) {
      for (let channel = 0; channel < frame.length; channel += 1) {
        frame[channel] = input[channel]?.[index] ?? 0;
      }
      this.meter.pushFrame(frame);
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][index] = input[channel]?.[index] ?? 0;
      }
    }

    this.framesSinceReport += frameCount;
    if (this.framesSinceReport >= this.reportIntervalFrames) {
      this.framesSinceReport %= this.reportIntervalFrames;
      this.port.postMessage(this.meter.snapshot({ resetPeak: true }));
    }
    return true;
  }
}

registerProcessor("loudness-meter", LoudnessMeterProcessor);
