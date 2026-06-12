// NOODLERACK wrapper around the open-source Clouds DSP (MIT, © Émilie Gillet)
// Exposes the GranularProcessor (presented in-app as "STEAM").
//
// Conventions:
// - External I/O sample rate: 48000 Hz, 1..128 stereo samples per c_render
//   call. Clouds runs natively at 32 kHz (kSampleRate is baked into the
//   reverb/diffuser delay tunings, grain durations, WSOLA correlator and
//   phase-vocoder hop times), so rather than recompiling at 48 kHz (which
//   would shift all time constants), we keep the engine at 32 kHz and do
//   exact-rational (3:2) linear-interpolation resampling 48k<->32k here.
// - Memory: firmware statically allocates 118784-byte main + (65536-128)-byte
//   CCM blocks (clouds.cc); we mirror those exact sizes.
// - Quality 0 = 16-bit stereo, low_fidelity false (firmware defaults).
// - density is passed straight through 0..1: its center deadzone / meta
//   mapping (deterministic seeds below 0.5, overlap fanning out from the
//   0.47..0.53 dead band) lives inside GranularProcessor::ProcessGranular.
// - pitch is kept continuous (firmware quantizes the pitch *pot* via
//   lut_quantized_pitch, but the V/Oct CV path is continuous; we follow the
//   CV path), clamped to ±48 like cv_scaler.cc.
// - trig is latched and applied to exactly one native 32-sample block, like
//   the one-Read pulse cv_scaler.cc produces.
// - processor.Prepare() is called before every native block, mirroring the
//   firmware main loop (it performs buffer (re)allocation on mode changes,
//   WSOLA correlator evaluation and phase-vocoder FFT buffering).
// - Output makeup gain 2*sqrt(2): the firmware's xfade LUTs peak at 1/sqrt(2)
//   and SoftConvert halves the signal (headroom restored by Clouds' analog
//   output stage); we compensate digitally so dry_wet=0 is ~unity through.
// - build_clouds.sh applies VCV Rack's one-line fix to Window::Start
//   (done_ = false), without which STRETCH mode latches silent.
#include <cmath>
#include <cstring>

#include "clouds/dsp/granular_processor.h"

using namespace clouds;

static const int kMaxFrames = 128;   // per c_render call, at 48 kHz
static const int kBlock = 32;        // Clouds' native block, at 32 kHz

static GranularProcessor processor;

// Same sizes as the firmware's statically allocated blocks (clouds.cc).
static uint8_t block_mem[118784];
static uint8_t block_ccm[65536 - 128];

// I/O buffers exposed to JS (48 kHz).
static float inl_buf[kMaxFrames];
static float inr_buf[kMaxFrames];
static float outl_buf[kMaxFrames];
static float outr_buf[kMaxFrames];

// 48k -> 32k downsampler state (positions step 3/2 input samples; exact
// rational phase, numerator over 2).
static float ds_prev_l = 0.0f, ds_prev_r = 0.0f;
static int ds_frac = 0;

// Staging block fed to GranularProcessor (32 kHz, int16 stereo).
static ShortFrame in_block[kBlock];
static ShortFrame out_block[kBlock];
static int in_fill = 0;

// Processed-output FIFO at 32 kHz (float frames).
static const int kFifoSize = 1024;
static float fifo_l[kFifoSize];
static float fifo_r[kFifoSize];
static int fifo_head = 0;  // write index
static int fifo_tail = 0;  // read index
static int fifo_count = 0;

// 32k -> 48k upsampler state (positions step 2/3; numerator over 3).
static float us_prev_l = 0.0f, us_prev_r = 0.0f;
static float us_cur_l = 0.0f, us_cur_r = 0.0f;
static int us_frac = 0;

static bool pending_trig = false;

static inline int16_t Float2Short(float x) {
  float s = x * 32767.0f;
  if (s < -32768.0f) s = -32768.0f;
  if (s > 32767.0f) s = 32767.0f;
  return static_cast<int16_t>(s);
}

static inline void FifoPush(float l, float r) {
  if (fifo_count >= kFifoSize) return;  // shouldn't happen
  fifo_l[fifo_head] = l;
  fifo_r[fifo_head] = r;
  fifo_head = (fifo_head + 1) % kFifoSize;
  ++fifo_count;
}

static inline void FifoPop(float* l, float* r) {
  if (fifo_count == 0) {  // underflow guard; priming makes this unreachable
    *l = *r = 0.0f;
    return;
  }
  *l = fifo_l[fifo_tail];
  *r = fifo_r[fifo_tail];
  fifo_tail = (fifo_tail + 1) % kFifoSize;
  --fifo_count;
}

static inline float Clamp01(float x) {
  return x < 0.0f ? 0.0f : (x > 1.0f ? 1.0f : x);
}

// Run one native block through the processor and queue its output.
static void ProcessBlock() {
  Parameters* p = processor.mutable_parameters();
  p->trigger = pending_trig;
  p->gate = pending_trig;
  pending_trig = false;

  // The firmware runs Prepare() continuously in main(); once per 32-sample
  // block is more than the per-hop work the STFT/correlator ever need.
  processor.Prepare();
  processor.Process(in_block, out_block, kBlock);

  // See makeup-gain note at the top of this file.
  const float kMakeupGain = 2.8284271f / 32768.0f;  // 2*sqrt(2) / int16 range
  for (int i = 0; i < kBlock; ++i) {
    FifoPush(static_cast<float>(out_block[i].l) * kMakeupGain,
             static_cast<float>(out_block[i].r) * kMakeupGain);
  }
}

extern "C" {

void c_init() {
  memset(block_mem, 0, sizeof(block_mem));
  memset(block_ccm, 0, sizeof(block_ccm));
  processor.Init(block_mem, sizeof(block_mem), block_ccm, sizeof(block_ccm));
  processor.set_quality(0);  // 16-bit stereo
  processor.set_low_fidelity(false);
  processor.set_playback_mode(PLAYBACK_MODE_GRANULAR);
  processor.set_silence(false);
  processor.set_bypass(false);

  Parameters* p = processor.mutable_parameters();
  p->position = 0.0f;
  p->size = 0.5f;
  p->pitch = 0.0f;
  p->density = 0.5f;
  p->texture = 0.5f;
  p->dry_wet = 1.0f;
  p->stereo_spread = 0.0f;
  p->feedback = 0.0f;
  p->reverb = 0.0f;
  p->freeze = false;
  p->trigger = false;
  p->gate = false;

  processor.Prepare();  // performs the initial buffer allocation

  ds_prev_l = ds_prev_r = 0.0f;
  ds_frac = 0;
  in_fill = 0;
  fifo_head = fifo_tail = fifo_count = 0;
  us_prev_l = us_prev_r = us_cur_l = us_cur_r = 0.0f;
  us_frac = 0;
  pending_trig = false;

  // Prime the output FIFO: covers the partially-filled staging block (<=31
  // frames) plus resampler phase jitter, so FifoPop never underflows.
  for (int i = 0; i < 2 * kBlock; ++i) {
    FifoPush(0.0f, 0.0f);
  }
}

float* c_inl() { return inl_buf; }
float* c_inr() { return inr_buf; }
float* c_outl() { return outl_buf; }
float* c_outr() { return outr_buf; }

// mode: 0 GRANULAR, 1 STRETCH, 2 LOOPING_DELAY, 3 SPECTRAL
// (PlaybackMode enum order). All float params 0..1 except
// pitch_semitones (-24..+24 nominal, clamped at the firmware's ±48).
void c_render(int mode, float position, float grain_size,
              float pitch_semitones, float density, float texture,
              float drywet, float spread, float feedback, float reverb,
              int freeze, int trig, int size) {
  if (size < 1) return;
  if (size > kMaxFrames) size = kMaxFrames;

  if (mode < 0) mode = 0;
  if (mode > PLAYBACK_MODE_LAST - 1) mode = PLAYBACK_MODE_LAST - 1;
  processor.set_playback_mode(static_cast<PlaybackMode>(mode));

  Parameters* p = processor.mutable_parameters();
  p->position = Clamp01(position);
  p->size = Clamp01(grain_size);
  p->density = Clamp01(density);
  p->texture = Clamp01(texture);
  p->dry_wet = Clamp01(drywet);
  p->stereo_spread = Clamp01(spread);
  p->feedback = Clamp01(feedback);
  p->reverb = Clamp01(reverb);
  if (pitch_semitones < -48.0f) pitch_semitones = -48.0f;
  if (pitch_semitones > 48.0f) pitch_semitones = 48.0f;
  p->pitch = pitch_semitones;
  p->freeze = freeze != 0;
  if (trig) {
    pending_trig = true;
  }

  for (int n = 0; n < size; ++n) {
    // --- Downsample 48k -> 32k (3:2, linear interpolation) into the
    // staging block; run the engine whenever a native block is full.
    float cur_l = inl_buf[n];
    float cur_r = inr_buf[n];
    while (ds_frac < 2) {
      float t = ds_frac * 0.5f;
      in_block[in_fill].l = Float2Short(ds_prev_l + t * (cur_l - ds_prev_l));
      in_block[in_fill].r = Float2Short(ds_prev_r + t * (cur_r - ds_prev_r));
      if (++in_fill == kBlock) {
        in_fill = 0;
        ProcessBlock();
      }
      ds_frac += 3;
    }
    ds_frac -= 2;
    ds_prev_l = cur_l;
    ds_prev_r = cur_r;

    // --- Upsample 32k -> 48k (2:3, linear interpolation) from the FIFO.
    float t = us_frac * (1.0f / 3.0f);
    outl_buf[n] = us_prev_l + t * (us_cur_l - us_prev_l);
    outr_buf[n] = us_prev_r + t * (us_cur_r - us_prev_r);
    us_frac += 2;
    while (us_frac >= 3) {
      us_frac -= 3;
      us_prev_l = us_cur_l;
      us_prev_r = us_cur_r;
      FifoPop(&us_cur_l, &us_cur_r);
    }
  }
}

}  // extern "C"
