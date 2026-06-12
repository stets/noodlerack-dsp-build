// Node verification for clouds.wasm (see tools/build_clouds.sh).
// Usage: node tools/test_clouds.js [path/to/clouds.wasm]
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] || path.join(__dirname, '..', 'clouds.wasm');
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

function zeroCrossings(arr, from, to) {
  from = from || 0;
  to = to === undefined ? arr.length : to;
  let n = 0;
  for (let i = from + 1; i < to; ++i) {
    if ((arr[i - 1] < 0 && arr[i] >= 0) || (arr[i - 1] >= 0 && arr[i] < 0)) n++;
  }
  return n;
}

function hasNaN(arr) {
  for (let i = 0; i < arr.length; ++i) {
    if (!Number.isFinite(arr[i])) return true;
  }
  return false;
}

WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const e = instance.exports;
  const mem = e.memory.buffer;
  const inL = new Float32Array(mem, e.c_inl(), BLOCK);
  const inR = new Float32Array(mem, e.c_inr(), BLOCK);
  const outL = new Float32Array(mem, e.c_outl(), BLOCK);
  const outR = new Float32Array(mem, e.c_outr(), BLOCK);

  // c_render(mode, position, grain_size, pitch, density, texture,
  //          drywet, spread, feedback, reverb, freeze, trig, size)
  // phases: array of {seconds, freeze, input: fn(n) -> sample | null}
  function run(opts) {
    const o = Object.assign({
      mode: 0, position: 0.2, size: 0.5, pitch: 0, density: 0.6,
      texture: 0.5, drywet: 1, spread: 0, feedback: 0, reverb: 0,
    }, opts);
    e.c_init();
    const allOut = [];
    const allIn = [];
    for (const phase of o.phases) {
      const total = Math.ceil(phase.seconds * SR / BLOCK);
      const out = new Float32Array(total * BLOCK);
      const inp = new Float32Array(total * BLOCK);
      let n = phase.n0 || 0;
      for (let b = 0; b < total; ++b) {
        for (let i = 0; i < BLOCK; ++i, ++n) {
          const s = phase.input ? phase.input(n) : 0;
          inL[i] = s;
          inR[i] = s;
          inp[b * BLOCK + i] = s;
        }
        e.c_render(o.mode, o.position, o.size, o.pitch, o.density, o.texture,
                   o.drywet, o.spread, o.feedback, o.reverb,
                   phase.freeze ? 1 : 0, 0, BLOCK);
        out.set(outL, b * BLOCK);
      }
      allOut.push(out);
      allIn.push(inp);
    }
    return { out: allOut, inp: allIn };
  }

  const sine220 = (n) => 0.3 * Math.sin(2 * Math.PI * 220 * n / SR);

  let failures = 0;
  function assert(cond, msg) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg);
    if (!cond) failures++;
  }

  // --- Test (a): GRANULAR, 220 Hz sine, density .6, drywet 1
  const a = run({
    mode: 0, density: 0.6, drywet: 1,
    phases: [{ seconds: 2, input: sine220 }],
  });
  const aOut = a.out[0], aIn = a.inp[0];
  const half = aOut.length >> 1;
  const aRms = rms(aOut, half);
  let maxDiff = 0;
  for (let i = half; i < aOut.length; ++i) {
    maxDiff = Math.max(maxDiff, Math.abs(aOut[i] - aIn[i]));
  }
  console.log(`  granular: out RMS ${aRms.toFixed(5)}, max |out-in| ${maxDiff.toFixed(4)}`);
  assert(!hasNaN(aOut), 'granular output is finite');
  assert(aRms > 1e-4, 'granular output is nonzero');
  assert(maxDiff > 0.05, 'granular output is not identical to input');

  // --- Test (b): FREEZE — 1s signal, then freeze + 1s silence
  const b = run({
    mode: 0, density: 0.6, drywet: 1,
    phases: [
      { seconds: 1, input: sine220 },
      { seconds: 1, input: null, freeze: true, n0: SR },
    ],
  });
  const frozen = b.out[1];
  const bRms = rms(frozen, frozen.length >> 1);  // last 0.5 s of silence-fed
  console.log(`  freeze: frozen-tail RMS ${bRms.toFixed(5)}`);
  assert(!hasNaN(frozen), 'frozen output is finite');
  assert(bRms > 1e-4, 'frozen grains keep playing on silent input');

  // --- Test (c): pitch +12 vs 0 -> higher zero-crossing rate
  const c0 = run({
    mode: 0, density: 0.8, drywet: 1, pitch: 0,
    phases: [{ seconds: 2, input: sine220 }],
  });
  const c12 = run({
    mode: 0, density: 0.8, drywet: 1, pitch: 12,
    phases: [{ seconds: 2, input: sine220 }],
  });
  const zFrom = c0.out[0].length >> 1;  // settle for 1 s first
  const z0 = zeroCrossings(c0.out[0], zFrom);
  const z12 = zeroCrossings(c12.out[0], zFrom);
  console.log(`  zero crossings (1 s): pitch 0 -> ${z0}, pitch +12 -> ${z12}`);
  assert(z12 > z0 * 1.3, 'pitch +12 raises zero-crossing rate');

  // --- Test (d): drywet 0 -> output ~= input (within resampling tolerance)
  const d = run({
    mode: 0, drywet: 0,
    phases: [{ seconds: 1, input: sine220 }],
  });
  const dOut = d.out[0], dIn = d.inp[0];
  // The 48k->32k->48k round trip and block buffering add a fixed latency;
  // find the best lag by cross-correlation, then compare.
  let bestLag = 0, bestCorr = -1;
  const win = 8192, start = SR >> 1;
  for (let lag = 0; lag <= 400; ++lag) {
    let dot = 0, ein = 0, eout = 0;
    for (let i = start; i < start + win; ++i) {
      dot += dIn[i - lag] * dOut[i];
      ein += dIn[i - lag] * dIn[i - lag];
      eout += dOut[i] * dOut[i];
    }
    const corr = dot / Math.sqrt(ein * eout + 1e-12);
    if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
  }
  let resid = 0, sig = 0;
  for (let i = start; i < start + win; ++i) {
    const diff = dOut[i] - dIn[i - bestLag];
    resid += diff * diff;
    sig += dIn[i - bestLag] * dIn[i - bestLag];
  }
  const residRatio = Math.sqrt(resid / sig);
  console.log(`  drywet 0: lag ${bestLag} samples, corr ${bestCorr.toFixed(4)}, residual ${(residRatio * 100).toFixed(2)}%`);
  assert(bestCorr > 0.97, 'drywet 0 output tracks input (corr > 0.97)');
  assert(residRatio < 0.2, 'drywet 0 residual under 20% (resampling tolerance)');

  // --- Test (e): all 4 modes produce finite (non-NaN) output
  const modeNames = ['GRANULAR', 'STRETCH', 'LOOPING_DELAY', 'SPECTRAL'];
  for (let m = 0; m < 4; ++m) {
    const r = run({
      mode: m, density: 0.6, drywet: 1,
      phases: [{ seconds: 2, input: sine220 }],
    });
    const o = r.out[0];
    const mRms = rms(o, o.length >> 1);
    console.log(`  mode ${m} (${modeNames[m]}): RMS ${mRms.toFixed(5)}`);
    assert(!hasNaN(o), `${modeNames[m]} output is non-NaN`);
    assert(mRms > 1e-5, `${modeNames[m]} output is nonzero`);
  }

  // Right channel sanity (stereo path wired).
  assert(Number.isFinite(outR[0]), 'right channel readable and finite');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
});
