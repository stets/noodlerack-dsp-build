// Node verification for tides.wasm (see tools/build_tides.sh).
// Usage: node tools/test_tides.js [path/to/tides.wasm]
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] || path.join(__dirname, '..', 'tides.wasm');
const bytes = fs.readFileSync(wasmPath);

const SR = 48000;
const BLOCK = 128;

// Enums (tides2/ramp_generator.h order):
const RAMP_AD = 0, RAMP_LOOPING = 1, RAMP_AR = 2;
const OUT_GATES = 0, OUT_AMPLITUDE = 1, OUT_SLOPE_PHASE = 2, OUT_FREQUENCY = 3;

function rms(arr, from, to) {
  from = from || 0;
  to = to === undefined ? arr.length : to;
  let sum = 0;
  for (let i = from; i < to; ++i) sum += arr[i] * arr[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function risingZeroCrossings(arr) {
  let n = 0;
  for (let i = 1; i < arr.length; ++i) {
    if (arr[i - 1] < 0 && arr[i] >= 0) n++;
  }
  return n;
}

function hasNaN(arr) {
  for (let i = 0; i < arr.length; ++i) {
    if (!Number.isFinite(arr[i])) return true;
  }
  return false;
}

function argmax(arr) {
  let m = -Infinity, mi = 0;
  for (let i = 0; i < arr.length; ++i) {
    if (arr[i] > m) { m = arr[i]; mi = i; }
  }
  return mi;
}

WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const e = instance.exports;
  const mem = e.memory.buffer;
  const out1 = new Float32Array(mem, e.t_out1(), BLOCK);
  const out2 = new Float32Array(mem, e.t_out2(), BLOCK);
  const out3 = new Float32Array(mem, e.t_out3(), BLOCK);
  const out4 = new Float32Array(mem, e.t_out4(), BLOCK);

  let sawNaN = false;

  // t_render(ramp_mode, output_mode, range, frequency_hz, shape, slope,
  //          smoothness, shift, trig, gate_held, size)
  function run(opts) {
    const o = Object.assign({
      rampMode: RAMP_LOOPING, outputMode: OUT_SLOPE_PHASE, range: 1,
      freq: 2, shape: 0.5, slope: 0.5, smoothness: 0.5, shift: 0.5,
      trigAtStart: false, gateHeld: 0, seconds: 2,
    }, opts);
    e.t_init();
    const total = Math.ceil(o.seconds * SR / BLOCK);
    const o1 = new Float32Array(total * BLOCK);
    const o2 = new Float32Array(total * BLOCK);
    const o3 = new Float32Array(total * BLOCK);
    const o4 = new Float32Array(total * BLOCK);
    for (let b = 0; b < total; ++b) {
      const trig = (o.trigAtStart && b === 0) ? 1 : 0;
      e.t_render(o.rampMode, o.outputMode, o.range, o.freq, o.shape,
                 o.slope, o.smoothness, o.shift, trig, o.gateHeld, BLOCK);
      o1.set(out1, b * BLOCK);
      o2.set(out2, b * BLOCK);
      o3.set(out3, b * BLOCK);
      o4.set(out4, b * BLOCK);
    }
    if (hasNaN(o1) || hasNaN(o2) || hasNaN(o3) || hasNaN(o4)) sawNaN = true;
    return { o1, o2, o3, o4 };
  }

  let failures = 0;
  function assert(cond, msg) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg);
    if (!cond) failures++;
  }

  // --- Test (a): LOOPING at 2 Hz, SLOPE_PHASE -> out1 oscillates at ~2 Hz
  const SECONDS_A = 5;
  const a = run({ rampMode: RAMP_LOOPING, outputMode: OUT_SLOPE_PHASE,
                  freq: 2, seconds: SECONDS_A });
  const cycles2 = risingZeroCrossings(a.o1);
  const hz2 = cycles2 / SECONDS_A;
  console.log(`  LOOPING 2 Hz: ${cycles2} cycles in ${SECONDS_A}s -> ${hz2.toFixed(2)} Hz, RMS ${rms(a.o1).toFixed(4)}`);
  assert(rms(a.o1) > 0.05, 'LOOPING out1 produces signal');
  assert(hz2 > 2 * 0.8 && hz2 < 2 * 1.2, `LOOPING rate ~2 Hz (got ${hz2.toFixed(2)})`);
  assert(rms(a.o2) > 0.01 && rms(a.o3) > 0.01 && rms(a.o4) > 0.01,
      'out2..out4 (phase-shifted copies) also nonzero');

  // --- Test (b): AD mode + one trig -> envelope rises then decays near zero
  const b = run({ rampMode: RAMP_AD, outputMode: OUT_SLOPE_PHASE,
                  freq: 2, trigAtStart: true, seconds: 2 });
  const peakIdx = argmax(b.o1);
  const peak = b.o1[peakIdx];
  const startVal = Math.abs(b.o1[0]);
  const tail = rms(b.o1, b.o1.length - 4800);  // last 100 ms
  console.log(`  AD envelope: peak ${peak.toFixed(3)} at ${(peakIdx / SR).toFixed(3)}s, start ${startVal.toFixed(4)}, tail RMS ${tail.toFixed(5)}`);
  assert(peak > 0.2, 'AD envelope reaches a substantial peak');
  assert(peakIdx > 100, 'AD envelope rises (peak not at the start)');
  assert(tail < 0.02, 'AD envelope decays back near zero');
  assert(peak > 10 * tail, 'AD peak well above the tail');

  // --- Test (c): 4 Hz gives ~2x the cycles of 2 Hz
  const c = run({ rampMode: RAMP_LOOPING, outputMode: OUT_SLOPE_PHASE,
                  freq: 4, seconds: SECONDS_A });
  const cycles4 = risingZeroCrossings(c.o1);
  const ratio = cycles4 / Math.max(1, cycles2);
  console.log(`  4 Hz vs 2 Hz: ${cycles4} vs ${cycles2} cycles (ratio ${ratio.toFixed(2)})`);
  assert(ratio > 2 * 0.8 && ratio < 2 * 1.2, `4 Hz is ~2x of 2 Hz (ratio ${ratio.toFixed(2)})`);

  // --- Test (d): shape sweep changes the waveform
  const d1 = run({ shape: 0.1, freq: 2, seconds: 2 });
  const d2 = run({ shape: 0.9, freq: 2, seconds: 2 });
  const r1 = rms(d1.o1), r2 = rms(d2.o1);
  // Compare peak position within one cycle (24000 samples at 2 Hz).
  const cyc = SR / 2;
  const p1 = argmax(d1.o1.slice(cyc, 2 * cyc)) / cyc;
  const p2 = argmax(d2.o1.slice(cyc, 2 * cyc)) / cyc;
  const rmsDiff = Math.abs(r1 - r2) / Math.max(r1, r2);
  const peakDiff = Math.abs(p1 - p2);
  console.log(`  shape 0.1: RMS ${r1.toFixed(4)} peak@${p1.toFixed(3)} | shape 0.9: RMS ${r2.toFixed(4)} peak@${p2.toFixed(3)}`);
  assert(rmsDiff > 0.02 || peakDiff > 0.02,
      `shape changes the waveform (RMS diff ${(rmsDiff * 100).toFixed(1)}%, peak pos diff ${peakDiff.toFixed(3)})`);

  // --- Test (e): no NaNs anywhere (checked in every run, plus extreme corners)
  run({ rampMode: RAMP_AR, outputMode: OUT_GATES, range: 0, freq: 0.1,
        shape: 0, slope: 0, smoothness: 0, shift: 0, gateHeld: 1, seconds: 1 });
  run({ rampMode: RAMP_LOOPING, outputMode: OUT_FREQUENCY, range: 2, freq: 220,
        shape: 1, slope: 1, smoothness: 1, shift: 1, seconds: 1 });
  run({ rampMode: RAMP_AD, outputMode: OUT_AMPLITUDE, range: 2, freq: 8,
        shape: 0.7, slope: 0.3, smoothness: 0.9, shift: 0.8,
        trigAtStart: true, seconds: 1 });
  assert(!sawNaN, 'no NaNs/Infs in any output across all runs');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
});
