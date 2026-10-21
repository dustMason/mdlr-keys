# Monologue audio calibration toolkit

These original Python tools decode public patches, render the native Rust voice,
and compare it with paired hardware recordings. They run offline during
development. The app's live sound engine does not load reference audio or Python.

The active workflow uses the corrected seven-case [v2 protocol](v2/README.md).
The original four-case tools and evidence are preserved under `legacy/v1/`; their
pitch convention, excerpts and objective differ and their scores are historical.
Do not pass their removed oscillator/filter calibration keys to the current engine.

## Reproduce the current comparison

Python 3.11 or newer is required. From the repository root:

```sh
python3 -m venv Tools/monologue/.venv
Tools/monologue/.venv/bin/pip install -r Tools/monologue/requirements.txt
Tools/monologue/.venv/bin/python Tools/monologue/fetch_references.py
cargo build --manifest-path Rust/Cargo.toml --release --features analysis --bin monologue-render
Tools/monologue/.venv/bin/python Tools/monologue/calibrate.py Rust/target/release/monologue-render \
  --calibration Tools/monologue/initial-calibration.json \
  --include-validation --output Tools/monologue/data/runs/baseline
Tools/monologue/.venv/bin/python Tools/monologue/calibrate.py Rust/target/release/monologue-render \
  --calibration Tools/monologue/evidence/current-calibration.json \
  --include-validation --output Tools/monologue/data/runs/fitted
Tools/monologue/.venv/bin/python Tools/monologue/harmonic_report.py Tools/monologue/data/runs/fitted
```

Use the actual renderer path if Cargo has another target directory. Downloads and
renders default to ignored `Tools/monologue/data/`. `fetch_references.py` prepares
and verifies the entire bounded corpus; `build_corpus.py` repeats that operation
offline. For another location, supply `--data-root /path/to/scratch` to the fetch
command and `--manifest /path/to/scratch/accuracy-v2/corpus-v2.json` to the scorer.
The downloader verifies every source, raw 448-byte patch, crop and event file.

`calibrate.py` is the active v2 entry point. Omit `--calibration` to score native
defaults. `audio_compare.py reference.wav candidate.wav` retains the original
full-spectrum diagnostics; `decode_patch.py patch.molgprog --output patch.json`
exports documented control values. `harmonic_report.py` summarizes the v2 metrics
already retained in a run; it does not choose a different alignment or rescore it.

## Corpus, fitting and evidence

The source is [callimero's Monologue patches and recordings](https://github.com/callimero/Monologue),
pinned at commit `e829a7fbcc15a2a3555f86625b8592d77e4e5b76`. The artist publishes
paired patch files, WAVs and parameter screenshots under MIT. Attribution and the
original license are retained in `sources/`. The published material does not give
complete MIDI performances or the recording signal chain. No firmware, audio,
patch containers or compiled engine binaries are committed here.

Five excerpts train global analog constants. String Hold is an existing holdout;
Gloeckchen was selected using only its recording and patch and was held untouched
until the model and calibration were frozen. Known firmware control laws stay
fixed. Unknown manual velocity, gate timing and relative oscillator phase are
profiled separately from global analog constants. Recording gain is fitted only
for comparison and is never installed as a per-patch engine adjustment.

The objective combines local power in up to 64 harmonic bands, capped at 12 kHz
or Nyquist, with RMS-envelope error. The 4 ms alignment bound follows the onset
audit. Small tuning offsets, envelope, gain, harmonic coverage and the historical
full-spectrum score remain separate diagnostics. The objective is not a hardware
fidelity percentage; local harmonic bands do not reliably quantify alias/noise
energy, and median-frame aggregation can underweight brief timbral transients.

`evidence/current-*.json` records the final explicit baseline/fitted comparison,
selected nuisance values, source and binary hashes, native-default equivalence
and the fixed train/validation split. The v2 README explains bounded fitting and
its local-neighborhood approximation. Historical runs, including unsuccessful
structural steps, remain under `legacy/`. A new tuning iteration should reserve
new validation data rather than repeatedly optimize against these reported cases.

Seven short excerpts from one recording chain cannot uniquely identify the
analog circuit. Unknown drift, absolute phase, velocity and recording transfer
remain confounds; parameters at search boundaries are not measured component
values. Controlled isolated oscillator, filter, level, resonance and envelope
captures would support stronger conclusions.

## Primary control schema

The [official Korg MIDI implementation](https://www.korg.com/us/support/download/manual/0/733/4231/)
defines the 448-byte program. `decode_patch.py` follows Table 2, including its
EG INT 26 / LFO RATE 27 / LFO INT 28 high-byte ordering and 22-byte sequencer steps.
The document's note P1 and an early event-range example contain conflicting
values; paired parameter images and total program size resolve them. Bipolar
controls are centered at raw 512. Normalized control positions are not analog
transfer functions.

The [service manual](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf)
shows analog oscillator/filter/VCA audio and a post-VCA dry/drive/wet branch.
Firmware supplies control laws rather than audio DSP to execute. The native model
therefore combines recovered controller behavior with an approximate analog
signal path. See `../../docs/monologue-firmware-evidence.md` and
`../../docs/monologue-analog-evidence.md` for the owning research notes.
