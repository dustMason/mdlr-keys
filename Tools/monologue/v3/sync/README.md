# Sync and free-triangle numerical audits

This is an independent numerical audit of the synced oscillator. It contains no
firmware bytes, recordings, executable renderers, or copies of the engine source.
The model uses the same waveform, reset-to-zero convention, analog RC and triangle
fold as the engine. It does not establish that those assumptions reproduce the
physical instrument. See `docs/monologue-sync-evidence.md`.

Python needs numpy, scipy, numba and soundfile. Rust checks use the installed
`rustc`; they do not build or launch the native application. Run from the repo:

```sh
python3 Tools/monologue/v3/sync/audit.py --output /tmp/monologue-sync-reference
python3 Tools/monologue/v3/sync/convolution_probe.py --output /tmp/monologue-sync-convolution
```

`audit.py` implements the old phase-BLEP oscillator and the event-corrected
proposals independently in f64. It computes exact Fourier coefficients of the
piecewise-linear periodic raw waveform, applies the continuous analog RC, and
resolves triangle folding on a dense periodic grid. A 16× numerical render checks
reference convergence. The only engine file read is the 127-tap FIR coefficient
file. `--save-signals` optionally writes a scratch NumPy array for plotting.

`convolution_probe.py` compiles `convolution_probe.rs` against the current Rust
module by relative path. It checks 3,000 seeded cases against exact piecewise
integration of a triangular kernel, without using BLEP/BLAMP correction formulas.
The cases include reset fractions, ordinary wraps, and the adjacent f32 values
inside both comparator rails. It fails on errors above 2e-5 or source changes
while running. The helper executable and JSON report go only to `--output`.

A whole-engine comparison also needs a preserved baseline executable and a
candidate built with the `analysis` feature:

```sh
cargo build --manifest-path Rust/Cargo.toml --release --features analysis --bin monologue-render
python3 Tools/monologue/v3/sync/binary_audit.py \
  --baseline /path/to/preserved-v2-renderer \
  --candidate Rust/target/release/monologue-render \
  --output /tmp/monologue-sync-binaries
```

The binary audit records hashes and renders synthetic notes at 44.1, 48, 96 and
192 kHz. It measures 40 Hz–16 kHz off-harmonic power with fixed clocks and controls.
The optional `--candidate-ring-model product` isolates sync from later ring-source
coupling experiments. The included final report explicitly selects the native
product model.
An original executable is not bundled; the independent reference audit does not
require one. Generated WAV files are scratch outputs, not repository fixtures.

Included small reference reports:

- `analytic-reference-report.json`: independent f64 model and reference convergence.
- `convolution-report.json`: current Rust module versus exact triangular convolution.
- `whole-engine-report.json`: frozen v2 versus final v3 candidate binary.
- `packaging-proof.json`: retained numerical function ASTs match the original audit.

Off-harmonic energy misses errors that coincide with a legitimate harmonic. The
analytic audit therefore also reports coherent error without phase, pitch, time
or gain fitting. That error includes the polynomial smoothing and digital RC
approximation, not just aliasing. Folded triangles still create new corners after
the corrected oscillator and retain a sample-rate-dependent residual.

The free-triangle corner correction has its own exact-convolution probe and a
same-binary ring matrix. Both product-ring variants have identical physical
parameters; only the numerical triangle correction differs:

```sh
python3 Tools/monologue/v3/sync/free_convolution_probe.py --output /tmp/free-triangle-convolution
python3 Tools/monologue/v3/sync/triangle_audit.py \
  --renderer Rust/target/release/monologue-render --output /tmp/triangle-rates
python3 Tools/monologue/v3/sync/triangle_audit.py \
  --renderer Rust/target/release/monologue-render --low --output /tmp/triangle-lowband
```

`triangle-rate-report.json` includes every valid integer product family, 44.1/48/
96/192 kHz renders and the common 40 Hz–16 kHz off-family metric.
`triangle-lowband-report.json` measures the same-rate 55 Hz-master waveform change
without delay or gain fitting. The report's cross-rate family-amplitude diagnostics
also include float phase accumulation and coherent-product cancellation; they
must not be used as a pure alias or hardware-fidelity metric.

For performance, use the native harness, not the analysis renderer. Analysis
intentionally advances experimental circuit states for ablation and costs more.
The standalone harness uses production float block types and release compiler
settings, omits the analysis feature, warms the engine, and alternates the model
order across paired repeats. It does not launch an application:

```sh
python3 Tools/monologue/v3/sync/native-benchmark.py \
  --baseline-source /path/to/preserved-v2/src/modules \
  --candidate-source Rust/src/modules \
  --output /tmp/monologue-native-cpu --run
```

Run timing only after competing build/scoring jobs stop. The result is host
normal-priority voice-core timing, excluding the Synth bridge, app scheduling,
MIDI transport and physical audio hardware. All generated binaries and WAVs stay
in the chosen scratch output folder.
