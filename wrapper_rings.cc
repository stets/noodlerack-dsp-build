// NOODLERACK wrapper around the open-source Rings DSP (MIT, © Émilie Gillet)
// Exposes the resonator Part + Strummer (presented in-app as "UDON").
//
// Conventions:
// - Sample rate: 48000 Hz (Rings' native kSampleRate), 1..128 samples per
//   r_render call. Rings processes in fixed 24-sample blocks (kMaxBlockSize),
//   so we run a one-block FIFO: each output sample was rendered from input
//   24 samples earlier (0.5 ms latency).
// - note_semitones is a MIDI note number (69 = A440). Internally tonic is
//   pinned to 12.0 and performance_state.note = note_semitones - 12, which
//   mirrors the firmware's external-V/Oct path (pitch = note + tonic + fm).
// - chord is derived from structure exactly like cv_scaler.cc:
//   chord = round(structure * (kNumChords - 1)), used by the quantized
//   sympathetic-string model.
// - internal_strum is always false: strums come only from the explicit
//   `strum` argument (latched until the next 24-sample block boundary).
//   The Strummer still runs for its 10 ms inhibit/debounce, like firmware.
#include <cmath>

#include "rings/dsp/part.h"
#include "rings/dsp/patch.h"
#include "rings/dsp/performance_state.h"
#include "rings/dsp/strummer.h"

using namespace rings;

static const int kMaxFrames = 128;

static Part part;
static Strummer strummer;
static uint16_t reverb_buffer[32768];  // same size as the firmware's CCM block

// I/O buffers exposed to JS.
static float in_buf[kMaxFrames];   // input: external excitation audio
static float out_buf[kMaxFrames];  // ODD output
static float aux_buf[kMaxFrames];  // EVEN output

// One-block FIFO bridging arbitrary render sizes to kMaxBlockSize chunks.
static float in_fifo[kMaxBlockSize];
static float out_fifo[kMaxBlockSize];
static float aux_fifo[kMaxBlockSize];
static size_t fifo_pos = 0;
static bool pending_strum = false;

extern "C" {

void r_init() {
  strummer.Init(0.01f, kSampleRate / kMaxBlockSize);
  part.Init(reverb_buffer);

  for (size_t i = 0; i < kMaxBlockSize; ++i) {
    in_fifo[i] = out_fifo[i] = aux_fifo[i] = 0.0f;
  }
  fifo_pos = 0;
  pending_strum = false;
}

float* r_in() { return in_buf; }
float* r_out() { return out_buf; }
float* r_aux() { return aux_buf; }

void r_render(int model, int polyphony, float note_semitones,
              float structure, float brightness, float damping,
              float position, int strum, int internal_exciter, int size) {
  if (size < 1) return;
  if (size > kMaxFrames) size = kMaxFrames;

  if (model < 0) model = 0;
  if (model > RESONATOR_MODEL_LAST - 1) model = RESONATOR_MODEL_LAST - 1;
  part.set_model(static_cast<ResonatorModel>(model));

  int poly = polyphony >= 4 ? 4 : (polyphony >= 2 ? 2 : 1);
  if (part.polyphony() != poly) {
    part.set_polyphony(poly);  // only when changed: set_polyphony marks dirty
  }

  if (structure < 0.0f) structure = 0.0f;
  if (structure > 0.9995f) structure = 0.9995f;
  if (brightness < 0.0f) brightness = 0.0f;
  if (brightness > 1.0f) brightness = 1.0f;
  if (damping < 0.0f) damping = 0.0f;
  if (damping > 0.9995f) damping = 0.9995f;
  if (position < 0.0f) position = 0.0f;
  if (position > 0.9995f) position = 0.9995f;

  Patch patch;
  patch.structure = structure;
  patch.brightness = brightness;
  patch.damping = damping;
  patch.position = position;

  // Hysteresis-free version of cv_scaler.cc's chord derivation.
  int32_t chord =
      static_cast<int32_t>(structure * static_cast<float>(kNumChords - 1) +
                           0.5f);
  if (chord < 0) chord = 0;
  if (chord > kNumChords - 1) chord = kNumChords - 1;

  if (strum) {
    pending_strum = true;
  }

  for (int i = 0; i < size; ++i) {
    // Pop the previously rendered block...
    out_buf[i] = out_fifo[fifo_pos];
    aux_buf[i] = aux_fifo[fifo_pos];
    // ...and push fresh input.
    in_fifo[fifo_pos] = in_buf[i];
    ++fifo_pos;

    if (fifo_pos == kMaxBlockSize) {
      fifo_pos = 0;

      PerformanceState performance_state;
      performance_state.strum = pending_strum;
      performance_state.internal_exciter = internal_exciter != 0;
      performance_state.internal_strum = false;
      performance_state.internal_note = false;
      performance_state.tonic = 12.0f;
      performance_state.note = note_semitones - 12.0f;
      performance_state.fm = 0.0f;
      performance_state.chord = chord;
      pending_strum = false;

      // internal_strum == false, so the strummer never generates strums of
      // its own (no double trigger); it only applies the 10 ms inhibit.
      strummer.Process(in_fifo, kMaxBlockSize, &performance_state);
      part.Process(performance_state, patch,
                   in_fifo, out_fifo, aux_fifo, kMaxBlockSize);
    }
  }
}

}  // extern "C"
