// NOODLERACK wrapper around the open-source Tides 2018 DSP (MIT, © Émilie Gillet)
// Exposes the PolySlopeGenerator (presented in-app as "SLURP").
//
// Conventions:
// - Sample rate: 48000 Hz, 1..128 samples per t_render call. The firmware
//   runs at 62.5 kHz and converts the FREQUENCY knob to a normalized phase
//   increment via kRoot[range] * SemitonesToRatio(transposition); here the
//   caller passes frequency in Hz directly and we normalize: f = hz / 48000
//   (Render() clamps it to 0.25, i.e. 12 kHz, like the firmware).
// - The firmware renders SLOPE_PHASE / FREQUENCY modes at half sample rate
//   purely to save STM32 CPU (tides.cc `half_speed`); we render everything
//   at the full 48 kHz instead — same waveforms, no sample doubling.
// - Rendering is chunked at the firmware's native kBlockSize (8 samples) so
//   ParameterInterpolator slews match the hardware cadence.
// - ramp_mode follows tides2's RampMode enum: 0 = AD, 1 = LOOPING, 2 = AR.
// - output_mode follows OutputMode: 0 = GATES, 1 = AMPLITUDE (quadrature
//   level distribution), 2 = SLOPE_PHASE (phase-shifted copies),
//   3 = FREQUENCY (harmonic ratios).
// - range mirrors the firmware's 3-position switch (state.range 0..2):
//   0 = LOW, 1 = MID (both processed as RANGE_CONTROL), 2 = HIGH
//   (RANGE_AUDIO). Since frequency is passed in Hz, 0 and 1 only differ on
//   hardware (different kRoot); here they behave identically.
// - trig: a single rising edge is latched onto the first sample of this call
//   (forced GATE_FLAG_RISING even if the gate was already high, so repeated
//   trigs retrigger AD mode). gate_held: sustained gate level, used by AR.
// - PolySlopeGenerator outputs are in DAC volts (settings.cc calibration is
//   ~4033 codes/V): LOOPING is bipolar ±5 V, AD/AR slopes are unipolar
//   0..8 V, GATES mode's EOA/EOR fire at 8 V. We scale by 0.2 (1/5 V), so
//   LOOPING audio is ±1.0 and unipolar envelopes/gates reach 1.6.
// - The external clock/ramp inputs are not exposed (ramp = NULL, like an
//   unpatched CLOCK jack), so no RampExtractor state is needed.
#include <cmath>

#include "stmlib/utils/gate_flags.h"

#include "tides2/poly_slope_generator.h"
#include "tides2/ramp_generator.h"

using namespace tides;
using namespace stmlib;

static const int kMaxFrames = 128;
static const size_t kNativeBlockSize = 8;  // io_buffer.h kBlockSize
static const float kWrapperSampleRate = 48000.0f;
static const float kVoltScale = 0.2f;  // 5 V -> 1.0

static PolySlopeGenerator poly_slope_generator;
static OutputMode previous_output_mode;
static GateFlags previous_gate;

static PolySlopeGenerator::OutputSample out_samples[kMaxFrames];
static GateFlags gate_flags[kMaxFrames];

// The four output channels exposed to JS.
static float out1_buf[kMaxFrames];
static float out2_buf[kMaxFrames];
static float out3_buf[kMaxFrames];
static float out4_buf[kMaxFrames];

static inline float Clamp01(float x) {
  if (x < 0.0f) return 0.0f;
  if (x > 1.0f) return 1.0f;
  return x;
}

extern "C" {

void t_init() {
  poly_slope_generator.Init();
  previous_output_mode = OUTPUT_MODE_GATES;
  previous_gate = GATE_FLAG_LOW;
  for (int i = 0; i < kMaxFrames; ++i) {
    out1_buf[i] = out2_buf[i] = out3_buf[i] = out4_buf[i] = 0.0f;
  }
}

float* t_out1() { return out1_buf; }
float* t_out2() { return out2_buf; }
float* t_out3() { return out3_buf; }
float* t_out4() { return out4_buf; }

void t_render(int ramp_mode, int output_mode, int range,
              float frequency_hz, float shape, float slope,
              float smoothness, float shift,
              int trig, int gate_held, int size) {
  if (size < 1) return;
  if (size > kMaxFrames) size = kMaxFrames;

  if (ramp_mode < 0) ramp_mode = 0;
  if (ramp_mode > RAMP_MODE_LAST - 1) ramp_mode = RAMP_MODE_LAST - 1;
  if (output_mode < 0) output_mode = 0;
  if (output_mode > OUTPUT_MODE_LAST - 1) output_mode = OUTPUT_MODE_LAST - 1;
  // Mirrors tides.cc: const Range range = state.range < 2 ? CONTROL : AUDIO.
  const Range range_enum = range < 2 ? RANGE_CONTROL : RANGE_AUDIO;

  shape = Clamp01(shape);
  slope = Clamp01(slope);
  smoothness = Clamp01(smoothness);
  shift = Clamp01(shift);

  // tides.cc: frequency = kRoot[range] * SemitonesToRatio(transposition).
  // We take Hz directly. Render() clamps to <= 0.25.
  float frequency = frequency_hz / kWrapperSampleRate;
  if (frequency < 0.0f || std::isnan(frequency)) frequency = 0.0f;

  // tides.cc resets the generator when the output mode changes.
  if (OutputMode(output_mode) != previous_output_mode) {
    poly_slope_generator.Reset();
    previous_output_mode = OutputMode(output_mode);
  }

  // Build per-sample gate flags the way gate_inputs.cc would see them.
  for (int i = 0; i < size; ++i) {
    bool level = gate_held != 0 || (trig != 0 && i == 0);
    previous_gate = ExtractGateFlags(previous_gate, level);
    gate_flags[i] = previous_gate;
  }
  if (trig != 0) {
    // Force a retrigger even if the gate was already high.
    gate_flags[0] |= GATE_FLAG_RISING | GATE_FLAG_HIGH;
  }

  // Render in the firmware's native 8-sample blocks.
  int rendered = 0;
  while (rendered < size) {
    int chunk = size - rendered;
    if (chunk > static_cast<int>(kNativeBlockSize)) {
      chunk = static_cast<int>(kNativeBlockSize);
    }
    poly_slope_generator.Render(
        RampMode(ramp_mode),
        OutputMode(output_mode),
        range_enum,
        frequency,
        slope,        // firmware passes block->parameters.slope as `pw`
        shape,
        smoothness,
        shift,
        &gate_flags[rendered],
        NULL,         // no external clock ramp
        &out_samples[rendered],
        chunk);
    rendered += chunk;
  }

  for (int i = 0; i < size; ++i) {
    out1_buf[i] = out_samples[i].channel[0] * kVoltScale;
    out2_buf[i] = out_samples[i].channel[1] * kVoltScale;
    out3_buf[i] = out_samples[i].channel[2] * kVoltScale;
    out4_buf[i] = out_samples[i].channel[3] * kVoltScale;
  }
}

}  // extern "C"
