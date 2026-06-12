#!/bin/bash
set -e
mkdir -p /tmp/rings-build
cp "$(dirname "$0")/wrapper_rings.cc" /tmp/rings-build/
cd /tmp/rings-build
SRC="wrapper_rings.cc /tmp/eurorack/rings/resources.cc $(find /tmp/eurorack/rings/dsp -name '*.cc')"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/eurorack -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_r_init,_r_render,_r_in,_r_out,_r_aux \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o rings.wasm \
  $SRC $STMLIB_SRC
ls -la rings.wasm
echo "rings.wasm ready in $(pwd)"
