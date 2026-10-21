# Native JP-8000

This is the actual JP-8000 v1.05 firmware running on Gearmulator's H8/3002 CPU and four Roland ESP DSPs. It is not a substitute synthesizer and does not use a DSP56300 CPU. The selected upstream repository happens to use that organization name. The public source archive used during verification was [DBWBP JP-8000 v1.05](https://dbwbp.com/synthbin/jp8000_v1.05.zip); firmware is kept separate from source.

The runtime is a static C++20 library for arm64 iOS 16, iOS Simulator 16 and macOS 13. The C API in `include/jp8000.h` is C/C++17 compatible. A single producer thread owns the complete machine; the app's realtime audio callback consumes a separate bounded ring. No core function may be called concurrently or from the audio callback. The firmware runs at its native 88,200 stereo frames/second. The app’s producer resamples to 48,000 Hz with persistent phase and filtering; AVAudioEngine handles any further hardware-route conversion. Output is the unchanged signed 24-bit DAC word divided by 8,388,608, with unity host gain.

## Prepare private firmware

Requires Apple Silicon macOS, Xcode command-line tools, Python 3 and CMake. Obtain your own 512 KiB JP-8000 v1.05 firmware image; firmware is not included in this repository. Its expected SHA256 is `d2c7f2ccf457553c5c05b2095a187f700e481c67a4bbde1ef793f5241f7d3061`.

```sh
python3 Native/JP8000/tools/prepare.py /path/to/jp8000_v1.05.bin
Scripts/build-jp8000.sh
```

Preparation imports the verified ROM into ignored `Private/` and runs the firmware's factory-reset procedure with the native Mac build tool to produce battery-backed SRAM. The generated 256 KiB SRAM must match `093c2f7ea581f7cf99fefb91ff80e73aef8c37fccb413634bf4870f9f56e9e9e`. Existing differing files are preserved and cause a clear error. No files from a Codex conversation are required.

`JP8000_ROM` and `JP8000_BASELINE_RAM` can point to verified external inputs. `JP8000_BUILD_DIR` overrides the ignored build directory. Xcode supplies `PLATFORM_NAME`, `BUILT_PRODUCTS_DIR`, `TARGET_BUILD_DIR` and `UNLOCALIZED_RESOURCES_FOLDER_PATH`. The script produces `libmdlr_jp8000.a` and copies the verified private inputs into the app bundle's `JP8000/` resources before signing. Without Xcode variables it builds a Mac archive in `Build/macosx/`. Set `PLATFORM_NAME=iphoneos` or `iphonesimulator` for the other targets. Only arm64 is supported.

## Static DSP execution

Ordinary iPad apps cannot rely on runtime JIT permission. The build-time Mac tool exercises real firmware and exports position-independent, validated ARM64 ESP kernels into an ordinary static text section. Xcode signs that section with the app. The target is compiled with `CHIPS_FORCE_NO_JIT=1`; AsmJit is a build-tool dependency only. Runtime imports have no `mmap`, `mprotect`, JIT allocator or dynamic compiler dependency.

A kernel is selected by an exact normalized identity covering both 1024-word programs, all scheduling command markers, external-RAM size, clocks and configuration. Coefficients and other live fields stay live in the current emulated machine. Unknown structures run the original canonical interpreter; they are not replaced with approximate synthesis. `jp8000_stats` exposes native/fallback frame counts. Startup and transitions may fall back. The app measures rolling rendering speed and suppresses active output when the core cannot keep up.

The exporter preserves Apple's x29 frame-pointer requirement. Logical retained-input register 29 uses physical x30, which is saved/restored; packed ERAM pointers are loaded into scratch x11 on demand. The original vendor files remain unmodified and hash-listed; the three localized overlays are in `patches/`. The exact kernel-frame layout was cross-checked between macOS and iOS for all relevant ERAM sizes. An independent disassembly audit of all 1,269 kernels checked 6,129,322 instructions: x18 and SIMD/FP registers are untouched, x29 is used only for save/restore, x19–x30 are preserved, SP stays 16-byte aligned, and no external or indirect calls are emitted.

Generated assembly, kernel keys, ROMs, SRAM and native binaries are private build products and must not be committed. Build-time kernels contain material derived from the supplied firmware.

## Firmware state and tests

Parameter changes use actual Roland SysEx, including base128 wire offsets and two-byte values. Snapshots contain complete actual firmware readback (`params_upper`, `params_lower`, patch/performance names and receive channels). They contain no generated parameter defaults. Panel presses remain down for at least 50 ms of emulated time. Readback is requested after controls settle; `state_syncing` remains true until all six regions return. Save rejects pending or incomplete readback. Saved state includes system, performance, both parts and both patches (625 bytes of validated SysEx), rather than DSP execution memory or held notes.

MIDI input accepts channel voice messages and F1/F2/F3/F6/F8/FA/FB/FC/FE with their actual lengths; undefined statuses and partial SysEx are rejected. Realtime clock preserves running status. The firmware arpeggiator responds to external clock and transport; no host arpeggiator substitutes for it.

`tests/native_test.cpp` checks changes in all six regions, addresses above 0x7f, two-byte values, exact save/restore bytes, presets, panel release/readback and 128-frame note rendering. `tests/pcm_corpus.cpp` produces deterministic raw DSP output covering 128 patches, 64 performances, an eight-note chord and waveform/ring/sync/filter/effect/key/allocation sweeps. It is intended for differential comparison against the pinned unmodified JIT core. No test opens audio, MIDI, USB, a browser, or a physical device.

The final corpus contains 1,269 exact kernels, generated from both idle and held-chord passes. It includes the 504 waveform/ring/sync/filter/slope combinations and 60 chorus/delay combinations. All 802 settled audit phases used native kernels with zero fallback. The full differential compared 20,366,850 stereo frames / 162,934,800 bytes and matched the unmodified JIT SHA256 `87b9fee0dbbc4c583d0b90b1e67fe43635668be2545e29147e7a4a1265e2c84c`. Transient startup/control changes still use the genuine interpreter where required. Steady small-block tests on the development Mac reached roughly 7–8× realtime without fallback in the measured chord. These are software/Mac measurements, not iPad hardware, route-latency, thermal, or physical-instrument parity measurements.

A source-free receipt is saved in `verification/native-verification.json`; the MIDI-sync and OSC2 waveform receipts are adjacent. The generated kernels contain 24,517,288 bytes of machine code. The tested archives are about 36.4 MB, and the all-object iOS link is about 35.9 MB, before application code/resources and signing.

To rerun the state and small-block test after building on Mac:

```sh
clang++ -std=c++20 -O3 -target arm64-apple-macos13.0 \
  -INative/JP8000/include -INative/JP8000/src \
  Native/JP8000/tests/native_test.cpp \
  Native/JP8000/Build/macosx/libmdlr_jp8000.a \
  -o Native/JP8000/Build/native-test
Native/JP8000/Build/native-test \
  Native/JP8000/Private/jp8000_v1.05.bin \
  Native/JP8000/Private/ram_dump.bin \
  Native/JP8000/Build/native-test.json
```

`midi_bytes_test.cpp` uses the same archive and the additional include path `Native/JP8000/vendor/gearmulator/source/framework`. `midi_sync_test.cpp` accepts ROM, SRAM and a private output prefix; `midi_sync_analysis.py` analyzes its captured float PCM using NumPy. The test verifies quarter-note steps of 0.500 seconds at 120 BPM and 0.250 seconds at 240 BPM from incoming 24-PPQN clock, and Stop silencing. Continue is tested with newly pressed keys. F1/F2/F3/F6 and Active Sensing are byte-delivery checks; no broader device-function claim is made for them.

## Sources and licenses

Gearmulator: https://github.com/dsp56300/gearmulator, pinned `b8e1a28d4efaa3764d875eb3118d881dba672a70`; GPL-3.0-or-later. The CPU/board/DSP/state source subset and supporting headers are vendored. Unused upstream generated hardware/firmware test fixtures are excluded. See `vendor-manifest.json`, `sources.json` and `vendor/gearmulator/LICENSE.md`.

AsmJit: pinned `3577608cab0bc509f856ebf6e41b2f9d9f71acc4`, retained under `vendor/asmjit/` with its zlib license in `LICENSE.md`; used only by the Mac exporter. nlohmann/json is embedded in `src/json.hpp` under its retained MIT notice. Integration source and overlays are GPL-3.0-or-later. Firmware rights are separate from emulator-source licenses. Distribution must satisfy the applicable GPL source/license requirements and firmware rights; this local build does not grant firmware redistribution rights.
