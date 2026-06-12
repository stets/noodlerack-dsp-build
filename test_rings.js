// Node verification for rings.wasm (see tools/build_rings.sh).
// Usage: node tools/test_rings.js [path/to/rings.wasm]
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] || path.join(__dirname, '..', 'rings.wasm');
const bytes = fs.readFileSync(wasmPath);

const SR = 48000;
const BLOCK = 128;

function rms(arr, from, to) {
  from = from || 0;
  to = to === undefined ? arr.length : to;
  let sum = 0;
  for (let i = from; i < to; ++i) sum += arr[i] * arr[i];
  return Math.sqrt(sum / Math.max(1, to - from));
}

function zeroCrossings(arr) {
  let n = 0;
  for (let i = 1; i < arr.length; ++i) {
    if ((arr[i - 1] < 0 && arr[i] >= 0) || (arr[i - 1] >= 0 && arr[i] < 0)) {
      n++;
    }
  }
  return n;
}

WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const e = instance.exports;
  const mem = e.memory.buffer;
  const inBuf = new Float32Array(mem, e.r_in(), BLOCK);
  const outBuf = new Float32Array(mem, e.r_out(), BLOCK);
  const auxBuf = new Float32Array(mem, e.r_aux(), BLOCK);

  // r_render(model, polyphony, note_semitones, structure, brightness,
  //          damping, position, strum, internal_exciter, size)
  function run(opts) {
    const o = Object.assign({
      model: 0, poly: 1, note: 48,
      structure: 0.4, brightness: 0.5, damping: 0.7, position: 0.3,
      internalExciter: 1, seconds: 2, noiseBurstSamples: 0,
    }, opts);
    e.r_init();
    const total = Math.ceil(o.seconds * SR / BLOCK);
    const out = new Float32Array(total * BLOCK);
    const aux = new Float32Array(total * BLOCK);
    let n = 0;
    for (let b = 0; b < total; ++b) {
      for (let i = 0; i < BLOCK; ++i, ++n) {
        inBuf[i] = n < o.noiseBurstSamples ? (Math.random() * 2 - 1) * 0.5 : 0;
      }
      const strum = b === 0 ? 1 : 0;  // one strum at the start
      e.r_render(o.model, o.poly, o.note, o.structure, o.brightness,
                 o.damping, o.position, strum, o.internalExciter, BLOCK);
      out.set(outBuf, b * BLOCK);
      aux.set(auxBuf, b * BLOCK);
    }
    return { out, aux };
  }

  let failures = 0;
  function assert(cond, msg) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg);
    if (!cond) failures++;
  }

  // --- Test (a): modal model, internal exciter, strum once, decays over 2s
  const a = run({ model: 0, note: 48, seconds: 2 });
  const half = a.out.length >> 1;
  const r1 = rms(a.out, 0, half);
  const r2 = rms(a.out, half);
  console.log(`  modal strum: RMS 1st half ${r1.toFixed(5)}, 2nd half ${r2.toFixed(5)}`);
  assert(r1 > 1e-5, 'modal strum produces output');
  assert(r2 > 0 && r2 < r1, 'modal output decays over 2s');
  assert(rms(a.aux) > 1e-6, 'aux (EVEN) output also nonzero');

  // --- Test (b): higher note -> higher zero-crossing rate
  const b48 = run({ note: 48, seconds: 1 });
  const b60 = run({ note: 60, seconds: 1 });
  const z48 = zeroCrossings(b48.out);
  const z60 = zeroCrossings(b60.out);
  console.log(`  zero crossings: note 48 -> ${z48}, note 60 -> ${z60}`);
  assert(z60 > z48, 'note 60 has higher zero-crossing rate than note 48');

  // --- Test (c): FM voice (model 3) differs from modal (model 0)
  const c0 = run({ model: 0, seconds: 1 });
  const c3 = run({ model: 3, seconds: 1 });
  const rms0 = rms(c0.out);
  const rms3 = rms(c3.out);
  const zc0 = zeroCrossings(c0.out);
  const zc3 = zeroCrossings(c3.out);
  console.log(`  model 0: RMS ${rms0.toFixed(5)} ZC ${zc0} | model 3: RMS ${rms3.toFixed(5)} ZC ${zc3}`);
  const rmsDiff = Math.abs(rms0 - rms3) / Math.max(rms0, rms3);
  const zcDiff = Math.abs(zc0 - zc3) / Math.max(zc0, zc3);
  assert(rms3 > 1e-5, 'FM voice produces output');
  assert(rmsDiff > 0.05 || zcDiff > 0.05,
      `FM voice differs from modal (RMS diff ${(rmsDiff * 100).toFixed(1)}%, ZC diff ${(zcDiff * 100).toFixed(1)}%)`);

  // --- Test (d): external excitation (noise burst into r_in) rings
  const d = run({
    internalExciter: 0, seconds: 2,
    noiseBurstSamples: Math.round(0.01 * SR),  // 10 ms burst
  });
  const afterBurst = Math.round(0.05 * SR);  // well after the burst ends
  const ring = rms(d.out, afterBurst, SR);   // 50 ms .. 1 s
  console.log(`  external excitation: post-burst RMS ${ring.toFixed(6)}`);
  assert(ring > 1e-5, 'external noise burst makes the resonator ring');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
});
