# mdlr-keys

A standalone iPad instrument built from the Rust synth engines and panels in
[mdlr](https://github.com/dustMason/mdlr), with an Apple Silicon Mac preview.
The JP-8000 engine runs original firmware in a native C++ emulator alongside the
five Rust engines. Audio and MIDI run natively; the React controls run offline
in a bundled WebKit view. No web server or account is needed to play.

## Engines and controls

| Engine | Polyphony |
| --- | --- |
| Five | 5 voices |
| FM4 | 4 voices |
| One | Always monophonic |
| Six | 6 voices, with stereo chorus |
| JP-8000 | 8 voices across upper/lower parts |
| monologue | Monophonic, with per-note tuning |

One engine plays at a time. The four Rust engines retain their 122 parameters and
16 factory presets. JP-8000 adds 167 mapped controls, 128 factory patches and 64
performances from the supplied v1.05 ROM. Both parts and the complete current
performance are saved locally, including edits made through the firmware panel.
Monologue adds 48 controls and original presets. Its native Rust voice combines
recovered controller behavior with an approximate analog oscillator/filter/drive
model; it does not execute firmware or play sampled notes. Its Sound and Tuning
pages use a silver, touch-sized panel. See the [analysis and calibration notes](docs/monologue-analysis.md).
Mono output and velocity sensitivity are global options. Mono output averages
left and right into both outputs, with a short
crossfade when switching. It preserves each engine’s polyphony, held notes and
effect tails. One remains monophonic with last-note priority. Audio starts when
the app opens or becomes active.

The piano keyboard is hidden by default to maximize panel space. Knobs and faders
use relative vertical dragging with pointer capture; double-tap to reset a
control. The panels fit the logical content area of an 8th-generation iPad in portrait and landscape at
100% zoom with the piano hidden. Smaller windows or enlarged panels may scroll.
Toolbar buttons accept touches throughout their full rectangles, and round knobs
have invisible square hit areas. A small inset keeps controls away from the iPad's
physical edges without shrinking them. The app also requests hidden system
overlays and priority for gestures beginning at the screen edges. JP-8000 keeps
Sound, Performance and Panel views within the screen at normal zoom; the larger
controller-assignment view scrolls. Its slate paint, orange legends, indicator
knobs and faders are based on the original instrument, with a layout for touch.
See [panel notes and references](docs/jp8000-panel.md).

For a full-screen playing session, choose **Settings → Multitasking & Gestures →
Full Screen Apps**. To keep the iPad in MDLR, enable **Settings → Accessibility →
Guided Access**, open MDLR, and triple-click the Home button (or top button on an
iPad without a Home button). Keep **Touch** enabled, then start the session.
Triple-click the same button, authenticate, and choose **End** to leave it.
See Apple's [full-screen settings](https://support.apple.com/en-us/123635) and
[Guided Access instructions](https://support.apple.com/en-us/111795).

Connect a class-compliant USB MIDI keyboard through a compatible iPad USB adapter.
Core MIDI handles connected sources and hotplug. JP-8000 respects the performance’s
upper/lower MIDI receive channels; the on-screen keyboard follows the selected
part (or both parts). Audio plays through the current
iPad audio route. Keyboard power requirements depend on the adapter and keyboard.

## Build

Requirements: macOS with full Xcode and the relevant platform SDK, Node.js 22.12+
(or a compatible newer version), npm, Python 3, CMake, and Rust installed with rustup.
The JP-8000 engine requires a private copy of the verified v1.05 ROM.
The iPad deployment target is iPadOS 16; the native Mac preview requires macOS 13
and Apple Silicon.

```sh
git clone https://github.com/dustMason/mdlr-keys.git
cd mdlr-keys
rustup target add aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin
python3 Native/JP8000/tools/prepare.py /path/to/jp8000_v1.05.bin
bash Scripts/build.sh mac
open Build/Products/Release/MDLR.app
```

`Scripts/build.sh` installs the locked frontend dependencies, checks TypeScript,
builds the offline panel assets, and runs Xcode. Xcode compiles and links the Rust
DSP and the JP-8000 static library automatically. Run preparation once per
checkout; subsequent builds reuse the verified private inputs. Preparation generates factory SRAM by executing the firmware reset routine and
checks both input hashes. The build compiles DSP kernels ahead of time on the Mac;
the app does not generate executable code at runtime. Firmware, SRAM, and generated
kernels remain ignored local inputs/build outputs. See the
[native engine build and provenance](Native/JP8000/README.md).

Other unsigned build targets:

```sh
bash Scripts/build.sh ipad
bash Scripts/build.sh simulator
```

For Xcode's graphical build workflow, first run
`bash Scripts/prepare-assets.sh`, then open `MDLR.xcodeproj`, select the MDLR
scheme and your destination, and configure your own signing team for a device.

### Install on your iPad

Connect and unlock the iPad, trust the Mac, and enable Developer Mode. Use your
own development team and device name or identifier:

```sh
MDLR_DEVICE='Your iPad' MDLR_APPLE_TEAM='YOUR_TEAM_ID' bash Scripts/install-ipad.sh
```

The script builds, verifies that the development profile includes the connected
iPad, installs, and launches the app. Xcode must have access to your developer
account. Complete any developer-trust prompts on the iPad. A personal-team
development build expires and must be signed again periodically.

## Development

- `App/`: SwiftUI shell, audio bridge, Core MIDI input and icon resources.
- `Rust/`: Five synth processors and the standalone MIDI/voice adapter.
- `Tools/monologue/`: Reproducible firmware analysis and audio-calibration tools.
- `Native/JP8000/`: Pinned emulator sources, static ARM64 DSP generator and C API.
- `App/JP8000Host.hpp`: Audio producer, bounded PCM/event queues and resampling.
- `Frontend/src/`: Panel host, touch controls and layout/styling adaptations.
- `Frontend/upstream/`: Preserved upstream frontend source and assets.
- `Artwork/`: Source icon artwork; `Scripts/build-icons.py` regenerates its sizes.
- `Tests/`: Native state, routing and audio-host regression checks.

```sh
cargo test --release --manifest-path Rust/Cargo.toml
xcrun swiftc -parse-as-library App/InstrumentModel.swift Tests/InstrumentModelTests.swift -o /tmp/mdlr-model-tests
/tmp/mdlr-model-tests App/Engines.json
clang++ -std=c++17 -O2 Tests/SynthRoutingTests.cpp -o /tmp/mdlr-routing-tests
/tmp/mdlr-routing-tests
```

To preview just the controls in a browser, run `bash Scripts/prepare-assets.sh`
and `python3 -m http.server 8796 --directory App/WebPanel`, then open
`http://127.0.0.1:8796`. Audio and MIDI require the native app.

## Source provenance

The DSP and original frontend derive from `dustMason/mdlr` at commit
`32bf69ac6121826f8acfa07218f82b0ff5a0be65`. See `source-provenance.json`,
`Frontend/upstream-manifest.json`, and `upstream-adapter.patch` for the source
snapshot and adaptation details. Dependency licenses remain with their packages;
this repository does not introduce a new license grant.

The JP-8000 integration derives from Gearmulator JE8086 at
`b8e1a28d4efaa3764d875eb3118d881dba672a70` under GPL-3.0-or-later; its licenses,
source hashes and local adaptations are retained under `Native/JP8000/`. That
license does not grant rights to the Roland firmware. Firmware is not committed.

Only source and required artwork belong in Git. App packages, compiled web
bundles, dependency caches, backups, personal build records, signing material,
and local environment files are ignored. Generate them locally using the scripts
above; do not force-add them.
