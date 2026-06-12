#!/bin/bash
set -e
cd /tmp/plaits-build
SRC="wrapper.cc /tmp/eurorack/plaits/resources.cc $(find /tmp/eurorack/plaits/dsp -name '*.cc')"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/eurorack -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_p_init,_p_render,_p_out,_p_aux \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o plaits.wasm \
  $SRC $STMLIB_SRC
ls -la plaits.wasm
