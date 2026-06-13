#!/bin/bash
set -e
mkdir -p /tmp/warps-build
cp "$(dirname "$0")/wrapper_warps.cc" /tmp/warps-build/
cd /tmp/warps-build
SRC="wrapper_warps.cc /tmp/eurorack/warps/resources.cc $(find /tmp/eurorack/warps/dsp -name '*.cc')"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/eurorack -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_w_init,_w_render,_w_inl,_w_inr,_w_out \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o warps.wasm \
  $SRC $STMLIB_SRC
ls -la warps.wasm
echo "warps.wasm ready in $(pwd)"
