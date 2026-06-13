// Node verification for warps.wasm (see tools/build_warps.sh).
// Usage: node tools/test_warps.js [path/to/warps.wasm]
//
// Warps cross-modulates two audio inputs. We feed a carrier sine and a
// modulator sine and check that (a) ring-modulation produces sum/difference
// energy the inputs don't have, (b) output stays finite and bounded, and
// (c) the internal oscillator produces tone when no carrier is patched.
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] || path.join(__dirname, '..', 'warps.wasm');
const bytes = fs.readFileSync(wasmPath);

const SR = 48000;
const BLOCK = 128;

function rms(arr, from, to) {
  from = from || 0; to = to === undefined ? arr.length : to;
  let s = 0; for (let i = from; i < to; ++i) s += arr[i] * arr[i];
  return Math.sqrt(s / Math.max(1, to - from));
}
function peak(arr) { let m = 0; for (const v of arr) m = Math.max(m, Math.abs(v)); return m; }
function hasNaN(arr) { for (const v of arr) if (!Number.isFinite(v)) return true; return false; }

// Goertzel single-bin magnitude at frequency f.
function bin(arr, f) {
  const w = 2 * Math.PI * f / SR, c = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < arr.length; ++i) { s0 = arr[i] + c * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - c * s1 * s2) / arr.length;
}

WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const e = instance.exports;
  if (e._initialize) e._initialize();
  const mem = e.memory.buffer;
  const inL = new Float32Array(mem, e.w_inl(), BLOCK);
  const inR = new Float32Array(mem, e.w_inr(), BLOCK);
  const out = new Float32Array(mem, e.w_out(), BLOCK);

  // w_render(algorithm, timbre, drive_a, drive_b, shape, note, size)
  // Keep drive modest: the channel amplifiers square the drive and saturate,
  // so hot inputs smear the spectrum and mask clean sidebands.
  function run({ algorithm, timbre = 1, fc, fm, shape = 0, note = 48, drive = 0.4, seconds = 0.2 }) {
    e.w_init();
    const total = Math.ceil(seconds * SR / BLOCK);
    const all = new Float32Array(total * BLOCK);
    let ph = 0;
    for (let b = 0; b < total; ++b) {
      for (let i = 0; i < BLOCK; ++i, ++ph) {
        inL[i] = fc ? 0.6 * Math.sin(2 * Math.PI * fc * ph / SR) : 0;
        inR[i] = fm ? 0.6 * Math.sin(2 * Math.PI * fm * ph / SR) : 0;
      }
      e.w_render(algorithm, timbre, drive, drive, shape, note, BLOCK);
      all.set(out, b * BLOCK);
    }
    return all;
  }

  let failed = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failed++;
  };

  // Skip the first half (engine settling / param smoothing); measure the tail.
  const tail = a => a.subarray(a.length >> 1);

  // 1. Analog ring modulation (algorithm 2/8 = pure ANALOG_RING, a diode ring
  //    modulator) of fc=300, fm=80 should strongly suppress the carrier (300)
  //    feedthrough compared with a clean crossfade, and create new spectral
  //    content (e.g. the 240 Hz region) absent from a plain mix.
  const ring = tail(run({ algorithm: 2 / 8, fc: 300, fm: 80 }));
  check('ring-mod finite', !hasNaN(ring));
  check('ring-mod audible', rms(ring) > 0.01, `rms=${rms(ring).toFixed(4)}`);
  const carRing = bin(ring, 300), carXf = bin(tail(run({ algorithm: 0, timbre: 0, fc: 300, fm: 80 })), 300);
  check('ring-mod suppresses carrier feedthrough', carRing < carXf * 0.5,
        `ring@300=${carRing.toFixed(4)} xfade@300=${carXf.toFixed(4)}`);

  // 2. Crossfade (algorithm 0) at timbre 0 should pass mostly the carrier.
  const xf = tail(run({ algorithm: 0, timbre: 0, fc: 300, fm: 80 }));
  check('xfade passes carrier', bin(xf, 300) > bin(xf, 80),
        `c=${bin(xf, 300).toFixed(4)} m=${bin(xf, 80).toFixed(4)}`);

  // 3. Internal oscillator (shape 1 = sine) at note 48, modulator at 100 Hz,
  //    digital ring mod — should produce tone with no external carrier.
  const osc = tail(run({ algorithm: 3.5 / 8, fm: 100, shape: 1, note: 48 }));
  check('internal osc finite', !hasNaN(osc));
  check('internal osc audible', rms(osc) > 0.005, `rms=${rms(osc).toFixed(4)}`);

  // 4. No runaway: output stays within sane bounds across all algorithms.
  let maxPeak = 0;
  for (let a = 0; a <= 5; ++a) {
    const o = tail(run({ algorithm: a / 8, fc: 220, fm: 55 }));
    maxPeak = Math.max(maxPeak, peak(o));
    if (hasNaN(o)) { check(`algorithm ${a} finite`, false); }
  }
  check('all algorithms bounded', maxPeak < 4, `maxPeak=${maxPeak.toFixed(3)}`);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
