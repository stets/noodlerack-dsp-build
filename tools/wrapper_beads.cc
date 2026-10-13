// PEARL: Beads DSP by Emilie Gillet (MIT; see LICENSE and NOTICE).
// External rate is supplied by the AudioContext. Native blocks remain 12
// frames, as in upstream's desktop test; media run at 24/32/48 kHz.
// Streaming linear resampling preserves native grain/delay/reverb timing.
#include <algorithm>
#include <cmath>
#include <cstring>
#include "beads/dsp/processor.h"
#include "beads/dsp/synth.h"
#include "stmlib/utils/random.h"

static beads::Processor processor;
static beads::Synth synth;
static uint8_t delay1[512 * 1024], delay2[256 * 1024];
static uint16_t reverb[32768], synth_reverb[32768];
static float inl[128], inr[128], outl[128], outr[128], controls[21];
static beads::FloatFrame input[12], output[12], fifo[256];
static stmlib::GateFlags gates[12];
static bool freezes[12];
static int fill, head, tail, count, media = -1, source = -1;
static float external_rate = 48000, native_rate = 48000;
static double ds_phase, us_phase;
static beads::FloatFrame previous_in, previous_out, current_out;
static bool pending_trigger, previous_gate;

static float clamp(float v, float lo=0, float hi=1) {
  return std::isfinite(v) ? std::max(lo, std::min(hi, v)) : lo;
}
static void push(beads::FloatFrame f) {
  if (count == 256) return;
  fifo[head] = f; head = (head + 1) % 256; ++count;
}
static beads::FloatFrame pop() {
  beads::FloatFrame f; f = 0.0f;
  if (count) { f = fifo[tail]; tail = (tail + 1) % 256; --count; }
  return f;
}
static void reset_stream() {
  fill = head = tail = count = 0;
  ds_phase = us_phase = 0;
  previous_in = previous_out = current_out = 0.0f;
  pending_trigger = previous_gate = false;
  beads::FloatFrame zero; zero = 0.0f;
  for (int i=0; i<24; ++i) push(zero);
}
static beads::RandomizedParameter parameter(int base, int amount, int cv, bool connected, bool pitch=false) {
  beads::RandomizedParameter p;
  p.base = clamp(controls[base], pitch ? -48 : 0, pitch ? 48 : 1);
  p.attenuverter = clamp(controls[amount], -1, 1);
  p.cv = clamp(controls[cv], pitch ? -48 : -1, pitch ? 48 : 1);
  p.has_cv = connected;
  return p;
}
extern "C" {
void b_init(float sample_rate) {
  external_rate = clamp(sample_rate, 8000, 192000);
  memset(delay1,0,sizeof(delay1)); memset(delay2,0,sizeof(delay2));
  memset(reverb,0,sizeof(reverb)); memset(synth_reverb,0,sizeof(synth_reverb));
  memset(controls,0,sizeof(controls));
  uint8_t* buffers[] = {delay1, delay1 + 256 * 1024, delay2};
  stmlib::Random::Seed(0x50454152);
  processor.Init(buffers, reverb); synth.Init(synth_reverb);
  media = source = -1; reset_stream();
}
float* b_inl() { return inl; } float* b_inr() { return inr; }
float* b_outl() { return outl; } float* b_outr() { return outr; }
float* b_params() { return controls; }
// controls: time,size,pitch,density,shape,mix,feedback,reverb,
// timeAmount,sizeAmount,pitchAmount,shapeAmount,timeCV,sizeCV,pitchCV,
// densityCV,shapeCV. Remaining entries reserved.
void b_render(int quality, int wavetable, int seed_connected, int cv_mask,
              int freeze, int trigger, int size) {
  size = std::max(0, std::min(128,size));
  quality = std::max(0,std::min(3,quality));
  wavetable = !!wavetable;
  if (media != quality || source != wavetable) {
    media = quality; source = wavetable;
    processor.Configure(static_cast<beads::Processor::Media>(media), false);
    // Synth::Reset is declared but not defined upstream. Init is the reset.
    memset(synth_reverb,0,sizeof(synth_reverb)); synth.Init(synth_reverb);
    native_rate = source ? 48000 : processor.sample_rate();
    reset_stream();
  }
  beads::Parameters p;
  p.time = parameter(0,8,12,cv_mask & 1);
  p.size = parameter(1,9,13,cv_mask & 2);
  p.pitch = parameter(2,10,14,cv_mask & 4,true);
  p.shape = parameter(4,11,16,cv_mask & 8);
  p.monophonic_mode = false;
  beads::ModulatedParameter density = {clamp(controls[3]), clamp(controls[15],-1,1)};
  beads::Processor::MixParameters mix = {clamp(controls[6]),clamp(controls[5]),clamp(controls[7]),false};
  pending_trigger |= !!trigger;
  for (int n=0;n<size;++n) {
    beads::FloatFrame cur; cur.l = clamp(inl[n],-4,4); cur.r = clamp(inr[n],-4,4);
    while (ds_phase < 1.0) {
      input[fill] = previous_in + static_cast<float>(ds_phase) * (cur - previous_in);
      bool gate = pending_trigger; pending_trigger = false;
      gates[fill] = stmlib::ExtractGateFlags(previous_gate ? stmlib::GATE_FLAG_HIGH : stmlib::GATE_FLAG_LOW,gate);
      previous_gate = gate;
      freezes[fill] = !!freeze;
      if (++fill == 12) {
        fill = 0;
        const auto seed = seed_connected ? beads::SEED_BUTTON_STATE_LOCKED : beads::SEED_BUTTON_STATE_ON;
        if (source) synth.Render(seed, seed_connected ? gates : nullptr, freezes,
            static_cast<beads::Synth::Resolution>(media), density,p,mix,output,12);
        else processor.Process(seed, seed_connected ? gates : nullptr, freezes,density,p,mix,input,output,12);
        for (int i=0;i<12;++i) push(output[i]);
      }
      ds_phase += external_rate / native_rate;
    }
    ds_phase -= 1.0; previous_in = cur;
    const auto f = previous_out + static_cast<float>(us_phase) * (current_out - previous_out);
    outl[n] = f.l; outr[n] = f.r;
    us_phase += native_rate / external_rate;
    while (us_phase >= 1.0) { us_phase -= 1.0; previous_out=current_out; current_out=pop(); }
  }
}
}
