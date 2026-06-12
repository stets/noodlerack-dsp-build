#!/bin/bash
set -e
mkdir -p /tmp/tides-build
cp "$(dirname "$0")/wrapper_tides.cc" /tmp/tides-build/
cd /tmp/tides-build
SRC="wrapper_tides.cc /tmp/eurorack/tides2/resources.cc /tmp/eurorack/tides2/poly_slope_generator.cc"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/eurorack -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_t_init,_t_render,_t_out1,_t_out2,_t_out3,_t_out4 \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o tides.wasm \
  $SRC $STMLIB_SRC
ls -la tides.wasm
echo "tides.wasm ready in $(pwd)"
