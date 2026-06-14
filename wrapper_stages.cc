// NOODLERACK wrapper around the open-source Stages DSP (MIT, © Émilie Gillet)
// Exposes a single SegmentGenerator as a triggerable/loopable function
// generator (presented in-app as "SIMMER").
//
// Scope (v1): one channel configured as a 3-segment RAMP -> HOLD -> RAMP
// envelope. Gate-triggered it's an attack/hold/release contour; with LOOP on
// the whole chain cycles, turning it into a shapeable LFO. This is the common
// single-channel use of Stages; the full 6-segment chaining / step-sequencer
// modes are intentionally not exposed yet.
//
// Conventions:
// - Stages' DSP bakes time constants to kSampleRate (31250 Hz). We run the
//   generator at the host rate without resampling: envelope/LFO output is slow
//   CV with no aliasing concern, so the only effect is that a given knob maps
//   to a slightly shorter time than on hardware — still fully knob-controlled.
// - Output is the segment value (~0..1), suitable straight into a VCA/CV input.
// - Gate edges are converted to stmlib GateFlags per sample; the wrapper tracks
//   the previous gate level across calls.
#include <cmath>
#include <cstring>

#include "stages/segment_generator.h"
#include "stmlib/utils/gate_flags.h"

using namespace stages;

static const int kMaxFrames = 128;

static SegmentGenerator gen;
static segment::Configuration cfg[3];
static SegmentGenerator::Output out_block[kMaxFrames];
static stmlib::GateFlags flags[kMaxFrames];

static int prev_gate = 0;
static int cur_loop = -1;  // force first Configure

static inline float Clamp01(float x){ return x<0.f?0.f:(x>1.f?1.f:x); }

static void configure(int loop){
  // RAMP (attack) -> HOLD (sustain peak) -> RAMP (release)
  cfg[0].type=segment::TYPE_RAMP; cfg[0].loop=loop?true:false;
  cfg[1].type=segment::TYPE_HOLD; cfg[1].loop=false;
  cfg[2].type=segment::TYPE_RAMP; cfg[2].loop=loop?true:false;
  gen.Configure(true, cfg, 3);
  cur_loop=loop;
}

extern "C" {

void s_init(){
  gen.Init();
  prev_gate=0; cur_loop=-1;
  configure(0);
}

// flat output buffer JS reads (the segment value per sample)
static float value_buf[kMaxFrames];
float* s_value(){ return value_buf; }

// attack/hold/release/shape: 0..1. loop: 0/1. gate: current gate level 0/1.
void s_render(float attack, float hold, float release, float shape,
              int loop, int gate, int size){
  if(size<1) return;
  if(size>kMaxFrames) size=kMaxFrames;
  if((loop?1:0)!=cur_loop) configure(loop?1:0);

  // seg0 RAMP: primary = attack time, secondary = curve shape
  gen.set_segment_parameters(0, Clamp01(attack), Clamp01(shape));
  // seg1 HOLD: primary = peak level (target of the attack ramp), secondary = hold time
  gen.set_segment_parameters(1, 1.0f, Clamp01(hold));
  // seg2 RAMP: primary = release time, secondary = curve shape
  gen.set_segment_parameters(2, Clamp01(release), Clamp01(shape));

  for(int i=0;i<size;++i){
    int g = gate?1:0;
    stmlib::GateFlags f = g ? stmlib::GATE_FLAG_HIGH : stmlib::GATE_FLAG_LOW;
    if(i==0){
      if(g && !prev_gate) f = stmlib::GATE_FLAG_HIGH | stmlib::GATE_FLAG_RISING;
      else if(!g && prev_gate) f = stmlib::GATE_FLAG_FALLING;
    }
    flags[i]=f;
  }
  prev_gate = gate?1:0;

  gen.Process(flags, out_block, size);
  for(int i=0;i<size;++i) value_buf[i]=out_block[i].value;
}

}  // extern "C"
