#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM="${BEADS_SOURCE:-/tmp/noodlerack-beads-upstream}"
BUILD="${BEADS_BUILD:-/tmp/noodlerack-beads-build}"
# Official release and its exact stmlib submodule; fail rather than silently
# building a different source. See tools/README.md for checkout instructions.
[[ "$(git -C "$UPSTREAM" rev-parse HEAD)" == f4cfa7697095a28d292bff758beb51deb49b5a86 ]]
[[ "$(git -C "$UPSTREAM/stmlib" rev-parse HEAD)" == e3bd7c9cc00e4364166f9905c0509b6ffd0535ec ]]
mkdir -p "$BUILD"
# Stage committed sources; never compile dirty checkout edits.
git -C "$UPSTREAM" archive HEAD beads | tar -x -C "$BUILD"
mkdir -p "$BUILD/stmlib"
git -C "$UPSTREAM/stmlib" archive HEAD | tar -x -C "$BUILD/stmlib"
cp "$ROOT/tools/wrapper_beads.cc" "$BUILD/"
# emcc may need to create cache entries; keep them in the build directory.
if [[ ! -d "$BUILD/cache" ]]; then
  cp -R "$(em-config CACHE)" "$BUILD/cache"
fi
export EM_CACHE="$BUILD/cache"
# Desktop debug print runs on grain stealing; remove it from real-time DSP.
python3 - "$BUILD/beads/dsp/wavetable_granular_player.h" <<'PATCH'
import sys
from pathlib import Path
p=Path(sys.argv[1]); s=p.read_text()
line='        printf("stealing, duration = %d\\n", new_grain()->remaining_samples());'
assert line in s
p.write_text(s.replace(line, '        // Desktop diagnostic omitted in the audio worklet.'))
PATCH
emcc -O3 -std=c++17 -DTEST -DNDEBUG -Wno-vla-cxx-extension -I"$BUILD" --no-entry \
  -sEXPORTED_FUNCTIONS=_b_init,_b_render,_b_inl,_b_inr,_b_outl,_b_outr,_b_params \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  "$BUILD/wrapper_beads.cc" "$BUILD/beads/resources.cc" \
  "$BUILD/beads/dsp/processor.cc" "$BUILD/beads/dsp/synth.cc" \
  "$BUILD/beads/dsp/mu_law.cc" "$BUILD/beads/dsp/delay_clock.cc" \
  "$BUILD/beads/dsp/delay_controller.cc" "$BUILD/beads/dsp/trigger_generator.cc" \
  "$BUILD/stmlib/utils/random.cc" "$BUILD/stmlib/dsp/units.cc" \
  -o "$BUILD/beads.wasm"
cp "$BUILD/beads.wasm" "$ROOT/engines/beads.wasm"
