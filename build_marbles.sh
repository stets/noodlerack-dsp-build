#!/bin/bash
set -e
mkdir -p /tmp/marbles-build
cp "$(dirname "$0")/wrapper_marbles.cc" /tmp/marbles-build/
cd /tmp/marbles-build
SRC="wrapper_marbles.cc /tmp/eurorack/marbles/resources.cc $(find /tmp/eurorack/marbles/random /tmp/eurorack/marbles/ramp -name '*.cc')"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/eurorack -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_m_init,_m_render,_m_clock,_m_t1,_m_t2,_m_t3,_m_x1,_m_x2,_m_x3,_m_y \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o marbles.wasm \
  $SRC $STMLIB_SRC
ls -la marbles.wasm
echo "marbles.wasm ready in $(pwd)"
