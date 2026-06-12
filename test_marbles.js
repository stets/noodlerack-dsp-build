// Node verification for marbles.wasm (see tools/build_marbles.sh).
// Usage: node tools/test_marbles.js [path/to/marbles.wasm]
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] ||
    path.join(__dirname, '..', 'marbles.wasm');
const bytes = fs.readFileSync(wasmPath);

const SR = 48000;
const BLOCK = 128;
const SECONDS = 5;

function stats(arr) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of arr) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  const mean = sum / arr.length;
  let varsum = 0;
  for (const v of arr) varsum += (v - mean) * (v - mean);
  return { min, max, mean, std: Math.sqrt(varsum / arr.length) };
}

function uniq(arr) { return new Set(arr).size; }

WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const e = instance.exports;
  const mem = e.memory.buffer;
  const f32 = (ptr) => new Float32Array(mem, ptr, BLOCK);

  const bufs = {
    clock: f32(e.m_clock()),
    t1: f32(e.m_t1()), t2: f32(e.m_t2()), t3: f32(e.m_t3()),
    x1: f32(e.m_x1()), x2: f32(e.m_x2()), x3: f32(e.m_x3()),
    y: f32(e.m_y()),
  };

  function run(opts) {
    // m_render(t_rate_bpm, t_bias, t_jitter, t_model, deja_vu, dv_length,
    //          x_spread, x_bias, x_steps, x_scale, x_range,
    //          use_ext_clock, size)
    const o = Object.assign({
      bpm: 120, tBias: 0.5, tJitter: 0, tModel: 0,
      dejaVu: 0.3, dvLength: 8,
      xSpread: 0.5, xBias: 0.5, xSteps: 0.5, xScale: 0, xRange: 0,
      extClock: 0, seconds: SECONDS, clockHz: 0,
    }, opts);
    e.m_init();
    const out = { t1: [], t2: [], t3: [], x1: [], x2: [], x3: [], y: [] };
    const totalBlocks = Math.ceil(o.seconds * SR / BLOCK);
    // the lag processor takes ~2.5s to settle from 0V — let callers skip it
    const skipBlocks = Math.ceil((o.skipSeconds || 0) * SR / BLOCK);
    let n = 0;
    for (let b = 0; b < totalBlocks; ++b) {
      for (let i = 0; i < BLOCK; ++i, ++n) {
        bufs.clock[i] = o.clockHz > 0 &&
            (n % Math.round(SR / o.clockHz)) < Math.round(SR / o.clockHz / 2)
            ? 1 : 0;
      }
      e.m_render(o.bpm, o.tBias, o.tJitter, o.tModel, o.dejaVu, o.dvLength,
                 o.xSpread, o.xBias, o.xSteps, o.xScale, o.xRange,
                 o.extClock, BLOCK);
      if (b < skipBlocks) continue;
      for (const k of Object.keys(out)) {
        for (let i = 0; i < BLOCK; ++i) out[k].push(bufs[k][i]);
      }
    }
    return out;
  }

  let failures = 0;
  function assert(cond, msg) {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + msg);
    if (!cond) failures++;
  }

  // --- Test 1: internal clock 120 BPM, deja vu 0.3 ---
  const r1 = run({});
  for (const t of ['t1', 't2', 't3']) {
    const ones = r1[t].filter(v => v === 1).length;
    const zeros = r1[t].filter(v => v === 0).length;
    assert(ones > 0 && zeros > 0,
        `${t} fires: ${ones} high / ${zeros} low samples`);
  }
  for (const x of ['x1', 'x2', 'x3']) {
    const s = stats(r1[x]);
    const distinct = uniq(r1[x]);
    assert(distinct > 3, // deja vu .3 loops a short sequence — few values is correct
        `${x} varies over time (${distinct} distinct values)`);
    assert(s.min >= -3 && s.max <= 3,
        `${x} within -3..+3 (min ${s.min.toFixed(3)} max ${s.max.toFixed(3)})`);
  }
  {
    const s = stats(r1.y);
    assert(uniq(r1.y) > 4 && s.min >= -5 && s.max <= 5,
        `y varies (${uniq(r1.y)} distinct, min ${s.min.toFixed(3)} max ${s.max.toFixed(3)})`);
  }

  // --- Test 2: x_spread changes the distribution ---
  const low = run({ xSpread: 0.05, dejaVu: 0, seconds: 10, skipSeconds: 3 });
  const high = run({ xSpread: 0.95, dejaVu: 0, seconds: 10, skipSeconds: 3 });
  const sLow = stats(low.x1), sHigh = stats(high.x1);
  console.log(`  x1 std @ spread .05: ${sLow.std.toFixed(4)}  @ spread .95: ${sHigh.std.toFixed(4)}`);
  assert(sHigh.std > sLow.std * 2,
      'x_spread widens x1 distribution');

  // --- Test 3: external clock drives t gates ---
  const r3 = run({ extClock: 1, clockHz: 4, seconds: 8 });
  for (const t of ['t1', 't2', 't3']) {
    const ones = r3[t].filter(v => v === 1).length;
    const zeros = r3[t].filter(v => v === 0).length;
    assert(ones > 0 && zeros > 0,
        `ext clock: ${t} fires (${ones} high / ${zeros} low)`);
  }
  const x1ext = uniq(r3.x1);
  assert(x1ext > 4, `ext clock: x1 varies (${x1ext} distinct values)`);

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
});
