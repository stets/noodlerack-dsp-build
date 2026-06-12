#!/bin/bash
set -e
mkdir -p /tmp/clouds-build
cp "$(dirname "$0")/wrapper_clouds.cc" /tmp/clouds-build/
cd /tmp/clouds-build

# Stage a copy of the clouds sources so we can patch without touching
# /tmp/eurorack.
rm -rf staging
mkdir -p staging
cp -r /tmp/eurorack/clouds staging/clouds
rm -rf staging/clouds/drivers staging/clouds/bootloader staging/clouds/test \
       staging/clouds/hardware_design
mkdir -p staging/clouds/drivers
# granular_processor.cc includes debug_pin.h; provide the TEST-guarded header.
cp /tmp/eurorack/clouds/drivers/debug_pin.h staging/clouds/drivers/

# VCV Rack's fix (VCVRack/eurorack fork): upstream Window::Start never clears
# done_, which latches the WSOLA windows silent after init -> STRETCH mode
# produces no output without this.
perl -0pi -e 's/(phase_ = 0;)/$1\n    done_ = false;/' staging/clouds/dsp/window.h
grep -q 'done_ = false;' staging/clouds/dsp/window.h || { echo "window.h patch failed"; exit 1; }

# All Clouds DSP (incl. pvoc) + resources; no drivers/ui/settings.
SRC="wrapper_clouds.cc staging/clouds/resources.cc $(find staging/clouds/dsp -name '*.cc')"
STMLIB_SRC=""
for f in /tmp/stmlib/utils/random.cc /tmp/stmlib/dsp/units.cc /tmp/stmlib/dsp/atan.cc; do
  [ -f "$f" ] && STMLIB_SRC="$STMLIB_SRC $f"
done
# Clouds' big sample buffers (~180 KB) live in static data; 16 MB is plenty.
emcc -O3 -std=c++17 -DTEST \
  -I/tmp/clouds-build/staging -I/tmp \
  --no-entry \
  -sEXPORTED_FUNCTIONS=_c_init,_c_render,_c_inl,_c_inr,_c_outl,_c_outr \
  -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=16777216 \
  -o clouds.wasm \
  $SRC $STMLIB_SRC
ls -la clouds.wasm
echo "clouds.wasm ready in $(pwd)"
