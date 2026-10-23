# Firmware-free JP-8000 audition build

The JP-8000 Rust engine runs eight physical voices with Upper/Lower parts, seven
OSC1 and three OSC2 waveforms, sync/ring/cross modulation, envelopes, LFOs,
filters, EQ, delay, chorus and pan. Supported arpeggiator patterns and controller
routes are exposed through capability checks. Individual Trigger, RPS, external
clock and some active control combinations remain unsupported. Unsupported
settings are rejected rather than silently substituted.

Runtime audio uses mathematical control laws and fixed-point DSP. It loads no
firmware image, DSP executable, sampled notes, captured state or vendor bank.
The core was developed through firmware analysis and emulator comparisons;
complete sound parity is not claimed. Free-running oscillator/LFO histories and
some modulation cases still produce audible differences.

## Build and install

On the Mac connected to your iPad, install the Rust iOS target and sign in to
your Apple development account in Xcode. Unlock and trust the iPad and enable
Developer Mode. From the repository root:

```sh
rustup target add aarch64-apple-ios
MDLR_JP8000_RUST_ONLY=1 MDLR_DEVICE='Your iPad' MDLR_APPLE_TEAM='YOUR_TEAM_ID' \
  bash Scripts/install-ipad.sh
```

The script forwards the Rust-only option as an explicit Xcode build setting.
It builds the bundled frontend, compiles a Release app, verifies the device
provisioning profile, installs and launches. Skip the native firmware
`prepare.py` step. The generated app contains neither the firmware emulator
library nor ROM/SRAM resources. Other instrument engines remain available.

For an unsigned device build:

```sh
bash Scripts/prepare-assets.sh
xcodebuild -project MDLR.xcodeproj -scheme MDLR -configuration Release \
  -sdk iphoneos -destination 'generic/platform=iOS' \
  MDLR_JP8000_RUST_ONLY=1 CODE_SIGNING_ALLOWED=NO build
```

An unsigned build verifies compilation but cannot be installed on an iPad.

## Auditioning

Select JP-8000. The LCD identifies the Rust backend. Sound and Performance pages
allow Upper, Lower and Both editing. The on-screen keys use the current Remote
and arpeggiator routing; external MIDI uses the configured receive channels.
Factory patch/performance menus, firmware Save/Load and hardware panel actions
are disabled. This build starts from the Rust initialization sound; the factory
comparison recordings are development evidence and are not an app preset bank.

The audio callback owns the engine and consumes bounded event queues. Synthesis
runs at 88.2 kHz and a causal resampler feeds the 48 kHz app stream with a nominal
0.720 ms group delay. There is no future-audio worker queue. This is not a
measurement of iPad MIDI-to-speaker latency.

## Validation

The current integrated core passed 436 release tests and a 524,288-frame
zero-allocation workload. The OSC2 timing correction matched 169 checked native
controller fields and five ordered coefficient updates. All 15 selected factory
recordings remained byte-identical to the previous Rust core; nine separate
corrected-input comparisons also stayed unchanged. This correction covers live
oscillator-control updates and preserves the existing audio buffer size.

A fresh host callback comparison exercised 33 configurations and 198,000
callbacks per version. Both versions had zero deadline misses and zero observed C++ callback
allocations. At 64-frame/48 kHz blocks, the candidate's largest per-configuration
99th percentile was 0.080 ms against a 1.333 ms block budget. These are software
callback measurements on the development Mac, not iPad MIDI-to-speaker latency.

The Rust-only iOS Release build was validated on October 22, 2026. Successful
rendering, test results and low aggregate errors do not establish complete sound
parity; the remaining unsupported features and audible differences still apply.

```sh
cargo test --locked --release --manifest-path Rust/Cargo.toml --features analysis
bash Tests/run-jp8000-rust-host-tests.sh fixture
```

The analysis-only `jp8000-render` CLI is built with `--features analysis`.
Research captures, firmware, recordings, generated binaries and historical
comparison artifacts are kept outside this source commit.
