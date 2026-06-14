#!/bin/bash
set -e
mkdir -p /tmp/stages-build
cp "$(dirname "$0")/wrapper_stages.cc" /tmp/stages-build/
cd /tmp/stages-build
# Stages reuses Tides' RampExtractor (clock-following for the ramp segments).
SRC="wrapper_stages.cc /tmp/eurorack/stages/resources.cc /tmp/eurorack/stages/segment_generator.cc /tmp/eurorack/tides2/ramp/ramp_extractor.cc"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/eurorack -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_s_init,_s_render,_s_value \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o stages.wasm \
  $SRC $STMLIB_SRC
ls -la stages.wasm
echo "stages.wasm ready in $(pwd)"
