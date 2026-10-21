# Monologue native engine

The app's monologue instrument is a native Rust voice informed by the Korg monologue OS 2.00 controller firmware, official MIDI schema, and analog service schematic. It is playable synthesis at arbitrary MIDI pitches; no recording is substituted for a synthesized voice. The analog signal path is an approximation, and this is not a claim of hardware-equivalent sound.

## What was recovered

The [official updater](https://www.korg.com/us/support/download/software/0/733/3529/) contains a 256-byte KORG wrapper and a 256 KiB main ARM Thumb image. REA/Ghidra analysis identified two embedded SQEZ streams. Reconstructing their LHA/LH5 envelopes recovered a 38,912-byte voice image and a 50,656-byte panel image, with verified CRCs. The voice image contains control-voltage algorithms for the analog synthesizer, not a PCM sound engine.

The [firmware evidence report](monologue-firmware-evidence.md) records hashes, addresses, extraction steps and confidence. `Tools/monologue/firmware/` preserves the reproducible analysis tools without distributing proprietary firmware. The code reimplements these findings:

- Separate amplitude and modulation envelope state machines. The 40 kHz tick follows the board's 4 MHz crystal, PLL configuration, timer period and alternating interrupt branches. Time controls follow the recovered integer quadratic laws.
- Amplitude precharge, a nonzero control-voltage floor, squared CV output, level-preserving release and final mute. The modulation attack is `1−(1−phase)²`, with squared decay/release phases. Gate mode still has an AD modulation envelope; maximum decay holds that modulation indefinitely.
- The 129-knot slow/one-shot LFO table, piecewise fast rate law, waveform phase conventions and half-cycle one-shot termination. Slow runs freely; Fast and One-shot retrigger. “Sync slow LFO” is an explicit software extension.
- The shape-CV lookup's negative reflection, triangle reflection above the ordinary knob range, extended saw modulation and signed pulse width.
- Official waveform/target/mode enumeration, packed 10-bit program controls, bipolar depths and the wide central pitch-knob deadband. The raw-program decoder follows Table 2 rather than the document's conflicting P1 summary.

Rust integrates the recovered control trajectories at the host sample rate. It does not emulate the complete MCU instruction stream, PWM carrier or exact interrupt-by-interrupt quantization.

## Audio model and controls

The voice has two oscillators, oscillator sync/ring modulation, a nonlinear two-pole lowpass with self-oscillation, separate amplitude/modulation envelopes, audio-rate LFO modulation, glide and pitch-class tuning. Saw/pulse use polynomial discontinuity correction; nonlinear processing runs at four times the output rate. A 127-tap FIR decimates the signal.

The [service schematic](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf) places drive **after** the voice amplifier, as parallel dry and distorted/low-boost paths. The model follows that arrangement. The waveform transfer functions, VCA CV-to-gain mapping, filter CV/resonance/saturation, drive transfer, noise coloration and glide law remain model choices. In particular, saw and triangle use separate shaping parameters; triangle folding lowers its amplitude, consistent with the circuit and the [owner's manual](https://cdn.korg.com/us/support/download/files/d05d6cb06052aed2b067eea2dfa4f7cd.pdf) waveform illustration.

Native app ID 5 maps to Rust ID 4; app ID 4 remains the separate JP-8000 host. The silver Sound/Tuning panel exposes 48 parameters with touch targets at least 44 logical pixels. Its presets are original examples. Raw 448-byte `.prog_bin` loading is available in the analysis renderer; importing ZIP patch files into the app is not implemented. The 16-step sequencer, motion lanes, factory scale tables, hardware calibration menu and complete original preset bank are not implemented. Manual C–B tuning offsets are available.

## Real-time behavior

The audio callback uses fixed-size state, no allocation, no locks and no background audio producer. MIDI arrives through the existing native command queue. The Rust adapter renders only the frames requested by that callback, so a 64-frame callback no longer leaves another 64 synthesized frames delaying subsequent MIDI. The 127-tap decimator's linear-phase group delay is 63/(4×sample rate): 0.328125 ms at 48 kHz. Native Ring retains the existing oscillator product. Free-triangle corners receive BLAMP slope correction before the existing RC, with no added block queue or fixed delay. The diode bridge/LUT, coupling model and interval-averaged product remain analysis-only experiments and add no native processing or ring-averaging delay; see [ring evidence](monologue-ring-evidence.md). These are DSP group delays, not physical device round-trip or MIDI-to-sound latency. Firmware-like envelope onset is separate.

Pitch bend is applied after note portamento. Explicit note events preserve repeated-note legato and distinguish queued note-off→note-on from overlapping notes. One-shot LFO state is cleared when returning to a repeating mode. Panic clears sounding and residual filter state.

The native iPad host requests 128 frames at 48 kHz (2.67 ms). That is a request, not a measured end-to-end latency. Device input, output, route conversion and OS scheduling add latency; an unsigned build and Mac CPU benchmark do not establish iPad timing.

Earlier baseline measurements, before the v3 sync/ring changes: on an Apple M4 Max, 10,000 standalone 64-frame renders at 48 kHz measured 13.21 µs median / 16.29 µs p99 for the default voice, and 15.25 µs median / 19.17 µs p99 with ring modulation, maximum drive/resonance and fast pitch LFO. The buffer deadline is 1,333.33 µs. These CPU measurements exclude the native mixer, MIDI device, driver and OS audio route. Maximum observed blocks were 97.96 µs and 56.50 µs respectively; this finite run is not a scheduling guarantee.

## Calibration and validation

The [calibration toolkit](../Tools/monologue/README.md) pins public patch/recording pairs from [callimero/Monologue](https://github.com/callimero/Monologue), preserves its MIT attribution, decodes the actual controls and compares synthesized clips with multi-resolution log spectra and RMS envelopes. Global analog constants are fitted across training clips. A held-out patch is evaluated separately. Recording gain and bounded onset uncertainty are nuisance variables; the manually played Pinoesque patch also has unknown, tone-affecting velocity, which must be reported explicitly.

Evidence files retain each renderer hash, trial history, controls and metrics. Early provisional scores are historical experiments, not scores for the current source. Residual spectral differences remain substantial, and four expressive patches cannot uniquely identify the analog circuit. Controlled oscillator, filter, resonance, envelope and drive recordings would provide stronger calibration.

The final source revision re-evaluates the selected global constants against the original constants: training objective 11.93439 → 10.60614 (11.13% lower), held-out 8.98126 → 8.95966 (0.24% lower, effectively unchanged). The held-out patch was never used for parameter selection. These objective reductions are not perceptual similarity percentages. Rendering with native defaults and with the explicit fitted constants produced byte-identical WAVs for all four cases.

The release test run passes 49 unit tests, four public MIDI regressions and one allocation regression. Frontend type checks/build, Swift model tests and native routing tests also pass. Both arm64 macOS and iPhoneOS Release products build unsigned; no physical device run is implied. Landscape and portrait checks cover every exposed parameter, touch target size, grid overlap, scrolling and JavaScript errors.

Run `cargo test --release --manifest-path Rust/Cargo.toml` for waveform stability, controller formulas, raw-program validation, MIDI/legato/bend behavior, callback timing boundaries and allocation checks. `cargo build --release --features analysis --manifest-path Rust/Cargo.toml` also builds `monologue-render`, with WAV output and a 64-frame CPU benchmark. The JSON parser is an optional offline-only dependency; it is not linked into the iPad engine.
