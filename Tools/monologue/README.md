# Monologue audio analysis toolkit

These original Python tools decode public patches, render the native Rust voice,
and compare it with paired hardware recordings. Analysis runs offline. The live
app does not load reference audio or Python.

The active workflow is [v3 sync/ring evaluation](v3/README.md). It compares fixed
circuit models, preserves recovered firmware laws and the v2 analog constants,
and examines changes across each note. The [v2 toolkit](v2/README.md), its evidence
and the older `legacy/` directories remain unchanged. Root-level `calibrate.py`,
`fetch_references.py`, `build_corpus.py` and `harmonic_report.py` remain v2
compatibility entry points; they are not the active sync/ring workflow.

## Download, build and compare

Python 3.11 or newer is required. From the repository root:

```sh
python3 -m venv Tools/monologue/.venv
Tools/monologue/.venv/bin/pip install -r Tools/monologue/requirements.txt
Tools/monologue/.venv/bin/python Tools/monologue/v3/prepare_corpus_v3.py \
  --output-root Tools/monologue/data/v3 --fetch
cargo build --manifest-path Rust/Cargo.toml --release --features analysis --bin monologue-render
Tools/monologue/.venv/bin/python Tools/monologue/v3/evaluate_v3.py \
  --renderer Rust/target/release/monologue-render \
  --manifest Tools/monologue/data/v3/corpus-v3.1.json \
  --output Tools/monologue/data/v3-runs/current
```

Use the actual renderer path if Cargo has another target directory. Inputs and
renders above stay under ignored `Tools/monologue/data/`. The downloader is pinned
to 23 public assets totaling 57,039,045 bytes and verifies every source, extracted
448-byte program, event file and cropped WAV. Use `--cache /path/to/assets` instead
of `--fetch` for an offline reproduction. The data root can be elsewhere.

V3.1 applies a fixed 12-second gate-low warmup in the offline renderer. Phase
flags are seeds before that warmup, and one-shot LFOs begin finished. This does
not add live startup or playing delay. Cold and warm results remain separate.

The default split is development. Use `v3/evaluate_fixed_controls.py` with the same
renderer, manifest and output arguments for the five known controls; it preserves
their earlier performances. `--split regression` on the main evaluator instead
starts a new full-grid diagnostic, which differs from the published control guard.
Only after freezing a final model, add
`--split validation --allow-validation` for the reserved comparison. Validation
results must not become another round of parameter selection. The analysis-only
`--ring-model` override exposes retained experimental signal paths; omit it to
measure native defaults. No global analog constants are fitted by this runner.

## What the comparison establishes

The source is [Carsten Wartmann's paired Monologue patches and recordings](https://github.com/callimero/Monologue),
pinned at `e829a7fbcc15a2a3555f86625b8592d77e4e5b76`. The artist publishes WAVs,
patches and parameter screenshots under MIT. The source license and attribution
are preserved. No firmware, audio, patch containers or engine binaries are
committed in this toolkit. The complete MIDI performances, recording chain and
hardware firmware version are unknown.

V3 development uses the previously known Harpie and String Hold, plus Deep Meow.
Enough, Spce Meow and Wiff Wiff were selected from their source recordings and
patch controls before candidate-engine evaluation and reserved for validation.
The remaining five v2 cases are known regression controls; Gloeckchen is no
longer unseen. All eleven come from one recording artist/instrument. The final validation run is
complete; these are now known results. A future fitting round needs new validation
material.

The primary score uses mean time-local harmonic shape error plus 0.3-weighted
RMS-envelope error. It retains the original v2 median score, and reports temporal
p90/worst error, early/middle/late harmonic trajectories, bounded pitch estimates,
recording gain, alignment and harmonic coverage. Full-spectrum transport also
tracks off-harmonic ring sidebands. Its unit is cents of transported spectral
mass, not pitch error or a fidelity percentage. Near-silent recording noise can
inflate that secondary diagnostic; inspect its time trace rather than its mean
alone. The 5 ms RMS term can reflect cycle phase on low notes; separate
longer-window diagnostics do not replace the frozen objective. The 96 ms spectral windows do not resolve sub-cycle reset edges, so
independent event, alias and sample-rate tests remain necessary.

The coupled diode bridge was rejected after a material String Hold regression.
Its failed comparison remains explicit in the v3 evidence.

Unknown manual releases, relative oscillator phase and free-running slow-LFO
phase are profiled over frozen finite grids, identically for each circuit model.
Fast and one-shot modes retrigger their LFOs; their initial phase is not a fitted
parameter. The maximum onset alignment is 4 ms. Recording gain is fitted only for
comparison and never installed as a per-patch engine gain. Finite grids may miss
the actual performance; boundary winners and all nuisance trials are retained.

## Historical reproducibility

Published v2 scores require its frozen renderer, SHA-256
`02730e59367815dfdd0d9e27853c9f05cd1c9cf2d7fcdcd875d81c7ddbec8dcd`.
Running the current native engine against an old corpus creates a new comparison;
it does not reproduce those historical numbers. The phase-enabled v3 baseline
was separately verified byte-identical for all seven old WAVs at zero initial LFO
phase. `v3/protocol-v3.json` retains the cold experiment; `v3/protocol-v3.1.json`
adds fixed offline settling before any validation evaluation. The portable scorer's function bodies are identical to the frozen workspace
version; only import paths differ (`v3/packaging-proof.json`).

The original four-case v1 tools used a different octave convention, crops and
objective. They remain under `legacy/v1/` for audit only; do not pass their removed
calibration keys to the current engine. Existing `evidence/current-*.json` files
retain the completed v2 results rather than being overwritten by v3.

## Primary control and circuit evidence

The [official Korg MIDI implementation](https://www.korg.com/us/support/download/manual/0/733/4231/)
defines the 448-byte program. `decode_patch.py` follows Table 2, including EG INT
26 / LFO RATE 27 / LFO INT 28 high bytes and 22-byte sequencer steps. Bipolar
controls are centered at raw 512; control positions are not analog transfer laws.

The [service manual](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf)
shows analog oscillator/filter/VCA audio and a post-VCA drive branch. Firmware
provides controller behavior rather than executable audio DSP. The native voice
combines recovered controller laws with an approximate analog circuit model.
See [firmware evidence](../../docs/monologue-firmware-evidence.md) and
[analog evidence](../../docs/monologue-analog-evidence.md) for the owning research.
