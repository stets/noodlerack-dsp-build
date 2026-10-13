// Real Beads DSP: media/sample-rate coverage, capture/freeze, delay,
// pitch, random modulation, external clocks, and independent instances.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const bytes=fs.readFileSync(process.argv[2]||path.join(__dirname,'../engines/beads.wasm'));
const rms=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
async function engine(rate=48000){
  const {instance}=await WebAssembly.instantiate(bytes,{}),e=instance.exports;
  if(e._initialize)e._initialize(); e.b_init(rate);
  const f=p=>new Float32Array(e.memory.buffer,p,128);
  return {e,rate,l:f(e.b_inl()),r:f(e.b_inr()),out:f(e.b_outl()),right:f(e.b_outr()),p:new Float32Array(e.memory.buffer,e.b_params(),21)};
}
function run(w,{seconds=2,media=3,source=0,freeze=0,clock=0,mask=0,input=true,controls={}}={}){
  w.p.set([.1,.65,0,.65,.5,1,0,0,0,0,0,0,0,0,0,0,0]);
  for(const [k,v] of Object.entries(controls))w.p[+k]=v;
  const blocks=Math.ceil(seconds*w.rate/128),all=new Float32Array(blocks*128),right=new Float32Array(all.length);
  for(let b=0;b<blocks;b++){
    for(let i=0;i<128;i++){
      const t=(b*128+i)/w.rate;
      w.l[i]=input?.3*Math.sin(t*2*Math.PI*220):0;
      w.r[i]=input?.2*Math.sin(t*2*Math.PI*330):0;
    }
    w.e.b_render(media,source,clock?1:0,mask,freeze,clock&&b%Math.round(w.rate/128/8)===0?1:0,128);
    all.set(w.out,b*128);right.set(w.right,b*128);
  }
  assert(all.every(Number.isFinite)&&right.every(Number.isFinite),'finite stereo audio');
  assert(Math.max(...Array.from(all.subarray(all.length-128)).map(Math.abs))<=1.1,'bounded output');
  return all;
}
(async()=>{
  for(const rate of [44100,48000,96000])for(let media=0;media<4;media++){
    const w=await engine(rate);
    const wet=run(w,{media});assert(rms(wet.subarray(rate))>.005,`wet output ${rate}/${media}`);
    const held=run(w,{media,freeze:1,input:false});assert(rms(held.subarray(rate))>.005,`frozen capture ${rate}/${media}`);
    const silence=run(await engine(rate),{media,input:false});assert(rms(silence)<1e-6,'silent input remains silent');
    const synth=run(await engine(rate),{media,source:1,input:false});assert(rms(synth.subarray(rate))>.005,'wavetable voice');
    console.log(`PASS media ${media} at ${rate} Hz: granular, freeze, silence, wavetable`);
  }
  const a=await engine(),b=await engine();
  const baseline=run(a,{}),shifted=run(b,{controls:{2:12}});
  assert(rms(baseline.map((v,i)=>v-shifted[i]))>.02,'pitch changes sound');
  const random=run(await engine(),{controls:{8:.8,9:.8,10:.8,11:.8}});
  assert(rms(baseline.map((v,i)=>v-random[i]))>.02,'randomness changes grains');
  const cv=run(await engine(),{mask:4,controls:{10:1,14:12}});
  assert(rms(baseline.map((v,i)=>v-cv[i]))>.02,'external pitch CV');
  const wave=run(await engine(),{source:1,input:false,controls:{0:0,5:0}});
  const octave=run(await engine(),{source:1,input:false,mask:4,controls:{0:0,5:0,14:12}});
  const crossings=a=>a.subarray(48000).reduce((n,v,i,t)=>n+(i>0&&v>=0&&t[i-1]<0?1:0),0);
  const ratio=crossings(octave)/crossings(wave);assert(ratio>1.9&&ratio<2.1,'wavetable 1V CV doubles pitch with PITCH AMT at zero');
  const clock=run(await engine(),{clock:1,controls:{3:0}});assert(rms(clock)>.005,'external clock launches grains');
  const delay=run(await engine(),{seconds:5,controls:{1:1}});assert(rms(delay.subarray(48000*3))>.005,'delay mode');
  for(let media=0;media<4;media++) run(a,{media,seconds:.2,controls:{6:.95,7:.8,1:.2}});
  const dry=run(await engine(),{controls:{5:0}});assert(rms(dry.subarray(48000))>.1,'dry audio');
  const empty=run(await engine(),{input:false});assert.equal(rms(empty),0,'instances are isolated');
  console.log('PASS pitch, randomness, CV, wavetable 1V/oct, external clock, delay, media switching, dry mix, isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
