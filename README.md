# NOODLERACK DSP build chain

This repo is the complete, reproducible build chain for the WebAssembly DSP
engines used by [NOODLERACK](https://noodlerack.com), a browser-based modular
synthesizer. It exists so anyone can verify exactly where the audio engines
come from and how they're built.

## Provenance & licensing — read this first

The engines are compiled **directly from Émilie Gillet's original firmware
sources**:

- [pichenettes/eurorack](https://github.com/pichenettes/eurorack) — the DSP cores
- [pichenettes/stmlib](https://github.com/pichenettes/stmlib) — support code

All of the engines used here are **STM32 projects, which upstream licenses
under the MIT License** (the eurorack repo's GPL-3 grant covers only its AVR
projects, none of which are used). **No code from VCV Rack or the Audible
Instruments plugins is used** — those ports are GPL-3 because VCV relicensed
*their port*, not because the upstream DSP is.

The wrappers and build scripts in this repo are MIT-licensed too (see
[LICENSE](LICENSE) and [NOTICE](NOTICE)). Per upstream's guidelines for
derivative works, NOODLERACK does not use the upstream brand or the original
module names in the app:

| NOODLERACK module | Upstream source | Wrapper |
|---|---|---|
| RAMEN | Plaits | `wrapper.cc` → `plaits.wasm` |
| BOBA | Marbles | `wrapper_marbles.cc` → `marbles.wasm` |
| UDON | Rings | `wrapper_rings.cc` → `rings.wasm` |
| SLURP | Tides (2018) | `wrapper_tides.cc` → `tides.wasm` |
| STEAM | Clouds | `wrapper_clouds.cc` → `clouds.wasm` |
| PEARL | Beads | `tools/wrapper_beads.cc` → `engines/beads.wasm` |
| TWIRL | Warps | `wrapper_warps.cc` → `warps.wasm` |
| SIMMER | Stages | `wrapper_stages.cc` → `stages.wasm` |

Each wrapper is a thin C shim that instantiates the upstream voice/engine,
exposes its parameter and modulation matrix as flat exported functions, and
renders blocks into buffers an AudioWorklet can read. The DSP itself is
untouched upstream code (one exception: `build_clouds.sh` applies the
well-known one-line `done_ = false;` init fix from VCV's eurorack fork so
Clouds' WSOLA stretch mode produces output under emscripten).

## Building

Requires [Emscripten](https://emscripten.org) (`brew install emscripten`).

```bash
git clone --depth 1 https://github.com/pichenettes/eurorack.git /tmp/eurorack
git clone --depth 1 https://github.com/pichenettes/stmlib.git /tmp/stmlib

# Plaits: stage wrapper.cc + build.sh in /tmp/plaits-build, then
bash build.sh

# The rest stage themselves:
bash build_clouds.sh
bash build_marbles.sh
bash build_rings.sh
bash build_tides.sh
bash build_warps.sh
bash build_stages.sh
```

Each script leaves its `.wasm` in its `/tmp/<engine>-build` directory.

## Smoke tests

With Node installed, each engine has a renders-audible-output sanity check:

```bash
node test_marbles.js
node test_rings.js
node test_tides.js
node test_clouds.js
node test_warps.js
node test_stages.js
```

## Credits

All DSP by [Émilie Gillet](https://github.com/pichenettes) (MIT, © Émilie
Gillet). Mutable Instruments is a registered trademark and is not affiliated
with NOODLERACK.

## PEARL / Beads

The October 2026 official MIT source is pinned to eurorack
`f4cfa7697095a28d292bff758beb51deb49b5a86` and stmlib
`e3bd7c9cc00e4364166f9905c0509b6ffd0535ec`.

```sh
git clone https://github.com/pichenettes/eurorack.git /tmp/noodlerack-beads-upstream
git -C /tmp/noodlerack-beads-upstream checkout f4cfa7697095a28d292bff758beb51deb49b5a86
git -C /tmp/noodlerack-beads-upstream submodule update --init stmlib
bash tools/build_beads.sh
node tools/test_beads.js
```

This recipe archives committed sources, removes the desktop grain-stealing
printf in staged sources and disables debug assertions. It keeps native
12-frame blocks and 24/32/48 kHz media rates, resampled to the host rate.
Both upstream Processor and Synth are included, with explicit source selection.
Firmware automatic gain, hardware detection/calibration and buffer backup are
not part of this browser wrapper. The shipped binary uses Emscripten 5.0.7-git
and SHA-256 `19eace85ec65e4cabc34b7e613fdcd58bf723c1487057b3beea2cb445d2e1d62`.
