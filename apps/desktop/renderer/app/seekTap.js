'use strict';

// An AudioWorklet (seekCheck.js): keeps the last seconds of what an element
// sounds, mixed to one channel, and hands them over when asked, with the
// context time the last of them was rendered at. It sends nothing on, so the
// sound itself is not touched.

class SeekTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(Math.ceil(sampleRate * 3));
    this.written = 0;
    this.end = 0;
    this.port.onmessage = (m) => {
      const n = Math.min(this.ring.length, Math.round(m.data.seconds * sampleRate), this.written);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i += 1) out[i] = this.ring[(this.written - n + i) % this.ring.length];
      this.port.postMessage({ id: m.data.id, data: out, end: this.end }, [out.buffer]);
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const a = input[0];
    const b = input[1] || a;
    for (let i = 0; i < a.length; i += 1) {
      this.ring[this.written % this.ring.length] = (a[i] + b[i]) / 2;
      this.written += 1;
    }
    this.end = currentTime + a.length / sampleRate;
    return true;
  }
}

registerProcessor('seek-tap', SeekTap);
