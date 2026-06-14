// Node verification for stages.wasm (see tools/build_stages.sh).
// Usage: node tools/test_stages.js [path/to/stages.wasm]
//
// SIMMER is a RAMP->HOLD->RAMP function generator. We check that:
//  (a) a gate produces a rising-then-falling contour (an envelope),
//  (b) LOOP mode free-runs (oscillates with no gate),
//  (c) output stays finite and within ~0..1.
const fs = require('fs');
const path = require('path');

const wasmPath = process.argv[2] || path.join(__dirname, '..', 'stages.wasm');
const bytes = fs.readFileSync(wasmPath);
const SR = 48000, BLOCK = 128;

function hasNaN(a){ for (const v of a) if (!Number.isFinite(v)) return true; return false; }
function peak(a){ let m=0; for (const v of a) m=Math.max(m,v); return m; }
function min(a){ let m=1e9; for (const v of a) m=Math.min(m,v); return m; }

WebAssembly.instantiate(bytes, {}).then(({ instance }) => {
  const e = instance.exports;
  if (e._initialize) e._initialize();
  const out = new Float32Array(e.memory.buffer, e.s_value(), BLOCK);

  // s_render(attack, hold, release, shape, loop, gate, size)
  function run({ attack=0.3, hold=0.3, release=0.4, shape=0.5, loop=0, gateSeq, seconds=0.6 }) {
    e.s_init();
    const total = Math.ceil(seconds * SR / BLOCK);
    const all = new Float32Array(total * BLOCK);
    for (let b = 0; b < total; ++b) {
      const t = b * BLOCK / SR;
      const gate = gateSeq ? gateSeq(t) : 0;
      e.s_render(attack, hold, release, shape, loop, gate, BLOCK);
      all.set(out, b * BLOCK);
    }
    return all;
  }

  let failed = 0;
  const check = (name, ok, detail) => { console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?' — '+detail:''}`); if(!ok) failed++; };

  // 1. Envelope: gate high for the first 0.25s, then low.
  const env = run({ attack:0.4, hold:0.2, release:0.5, gateSeq:t=>t<0.25?1:0, seconds:0.9 });
  check('envelope finite', !hasNaN(env));
  const pk = peak(env), riseIdx = env.findIndex(v => v > 0.5);
  check('envelope rises on gate', pk > 0.6, `peak=${pk.toFixed(3)}`);
  // after release it should come back down well below the peak
  const tail = env.subarray(Math.floor(env.length*0.85));
  check('envelope falls after gate', peak(tail) < pk * 0.5, `tailPeak=${peak(tail).toFixed(3)} vs peak=${pk.toFixed(3)}`);
  check('envelope starts low', env[0] < 0.2, `start=${env[0].toFixed(3)}`);

  // 2. Loop mode: no gate, should oscillate (multiple rises above 0.5 and dips below 0.2).
  const lfo = run({ attack:0.15, hold:0.05, release:0.15, loop:1, gateSeq:()=>0, seconds:1.2 });
  check('loop finite', !hasNaN(lfo));
  let rises=0, armed=true;
  for (const v of lfo){ if(v>0.6 && armed){ rises++; armed=false; } if(v<0.2) armed=true; }
  check('loop oscillates (LFO)', rises >= 2, `cycles=${rises}`);

  // 3. Bounds across both modes.
  check('bounded 0..~1', peak(env) < 1.3 && peak(lfo) < 1.3 && min(env) > -0.3, `envPk=${peak(env).toFixed(2)} lfoPk=${peak(lfo).toFixed(2)}`);

  console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}).catch(err => { console.error(err); process.exit(1); });
