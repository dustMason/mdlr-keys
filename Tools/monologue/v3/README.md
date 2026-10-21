# Monologue sync/ring evaluation

The active protocol is **v3.1**, an eleven-case comparison of native renderers against paired public hardware recordings. The evaluator profiles a small set of unknown performance values; it never fits global analog constants. Firmware-derived control laws and the completed v2 calibration remain fixed.

## Reproduce a comparison

From the repository root, using the shared requirements in a virtual environment:

```sh
python3 -m venv Tools/monologue/.venv
Tools/monologue/.venv/bin/pip install -r Tools/monologue/requirements.txt
Tools/monologue/.venv/bin/python Tools/monologue/v3/prepare_corpus_v3.py \
  --output-root Tools/monologue/data/v3 --fetch
cargo build --manifest-path Rust/Cargo.toml --release --features analysis --bin monologue-render
Tools/monologue/.venv/bin/python Tools/monologue/v3/evaluate_v3.py \
  --renderer Rust/target/release/monologue-render \
  --manifest Tools/monologue/data/v3/corpus-v3.1.json \
  --output Tools/monologue/data/v3-runs/development
```

Use the actual renderer path if Cargo has a different target directory. The default split is development. Inputs and renders stay in ignored scratch space. `--cache /path/to/pinned/assets` replaces the download when matching assets already exist. The bounded download contains 23 assets totaling 57,039,045 bytes. Every source, extracted 448-byte program, event file and cropped WAV is hash-checked. Python 3.11 or newer is required.

After freezing the final renderer and its calibration, evaluate the reserved cases once:

```sh
Tools/monologue/.venv/bin/python Tools/monologue/v3/evaluate_v3.py \
  --renderer Rust/target/release/monologue-render \
  --manifest Tools/monologue/data/v3/corpus-v3.1.json \
  --split validation --allow-validation \
  --output Tools/monologue/data/v3-runs/validation
```

The final report's five known controls preserve the selected v2 performances rather than choosing a new nuisance minimum:

```sh
Tools/monologue/.venv/bin/python Tools/monologue/v3/evaluate_fixed_controls.py \
  --renderer Rust/target/release/monologue-render \
  --manifest Tools/monologue/data/v3/corpus-v3.1.json \
  --output Tools/monologue/data/v3-runs/known-controls
```

`fixed-regression-performances.json` pins those events, velocities and phase seeds. The main evaluator also offers `--split regression` for an explicitly new full-grid analysis of the known cases; that is a different experiment from the fixed-performance guard.

## Corpus and boundaries

All assets come from [Carsten Wartmann's callimero/Monologue repository](https://github.com/callimero/Monologue/tree/e829a7fbcc15a2a3555f86625b8592d77e4e5b76), pinned at `e829a7fbcc15a2a3555f86625b8592d77e4e5b76`. The artist publishes paired WAVs, programs and parameter screenshots under MIT; source license and attribution are preserved. No audio, program containers, raw patch binaries, vendor firmware or native executables are committed here. The instrument's firmware version, complete MIDI performance and recording chain are unknown.

| Role | Cases |
| --- | --- |
| Development | Harpie, String Hold, Deep Meow |
| Reserved validation | Enough, Spce Meow, Wiff Wiff |
| Known controls | S0S, Pinoesque, Gloeckchen, DuiDui, Wuai |

Harpie and String Hold were already known from v2. Gloeckchen is now a known control, not unseen validation. The three reserved cases were selected using reference audio and stored controls before any candidate-engine evaluation. This remains one artist/instrument, not independent hardware-unit validation. The final validation is complete: all eleven are now known results, and future fitting needs new validation material.

Deep Meow's manual first A1 and Spce Meow's A2 differ from the first stored sequencer notes; their direct saw components and octave settings identify the physical notes. Enough and Wiff Wiff begin with notes and timing consistent with their stored sequences. Onsets have about 2 ms uncertainty, bounded by the unchanged 4 ms alignment allowance. Manual releases, relative oscillator phase and free-running slow-LFO phase use the same finite grids for every renderer. Fast and one-shot LFOs retrigger; their initial phase is not fitted. Boundary winners and every nuisance trial are retained.

## Fixed offline settling amendment

`protocol-v3.json` preserves the original cold-start experiment. After its development diagnostics exposed a coupling-capacitor initialization issue, **v3.1 was frozen before any validation-engine evaluation**. It adds a physically specified 12-second gate-low warmup, not a fitted capacitor state:

- Settled controls; resting pitch and velocity equal the first note-on event.
- Directly initialized internal pitch, avoiding an unrelated glide transient.
- One-shot LFO initially finished at phase 0.5 and inactive.
- Oscillator and slow-LFO phase flags are seeds at time −12 seconds. State evolves continuously; there is no time-zero phase reset. A synced slave locks naturally.

The renderer's `--idle-seconds 12` performs this offline preparation. It introduces no live startup or playing delay. The previous hardware note and idle duration were not recorded; these are explicit test assumptions. Cold and warm scores are separate experiments: phase seeds also advance during warmup, so a cold-to-warm score change is not a pure capacitor ablation.

The downloader creates both manifests. Use `corpus-v3.1.json` for the active protocol; `corpus-v3.json` retains the original cold protocol. The corpus excerpts and nuisance grids are identical.

## Metrics and their limits

The primary score is mean time-local harmonic error plus 0.3 times the aligned RMS-envelope error. It retains v2's across-frame median result, its independent minimum over the same nuisance grid, pitch, gain, alignment, harmonic coverage, legacy full-spectrum error, temporal p90/worst error and early/middle/late harmonic trajectories. Harmonic analysis uses 96 ms windows, 24 ms hops and up to 64 bands capped at 12 kHz. The normalized-power floor is −50 dB; harmonic ratios near that floor are limited by the floor.

Full-spectrum power transport includes off-comb ring sidebands. Its unit is cents of transported spectral mass, not pitch error or a fidelity percentage. Unlike the harmonic mean, transport normalizes every frame without an activity mask; late recording noise can inflate its average. Inspect time traces and coverage. The 96 ms windows cannot resolve sub-cycle reset errors; independent [sync/alias tests](sync/README.md) complement recordings.

The synthetic audit establishes phase/gain robustness of the **harmonic and transport components**, not the whole objective. The 5 ms RMS term can reflect cycle shape and absolute phase for low notes such as Deep Meow's 55 Hz fundamental. Separate 20/50 ms envelope diagnostics were inspected without changing the frozen objective or selecting a model. Recording gain is fitted for comparison only, never installed as a per-patch engine gain.

## Retained experiments

The coupled diode-bridge model was rejected for native adoption. Under full v3.1 development grids, aggregate error worsened from 3.753676 to 4.223574. String Hold regressed from 3.249713 to 4.598279: the early second harmonic collapses and the gain-matched attack/tail balance diverges from the recording. Deep Meow's H2/H1 gets closer in one respect but overshoots. Circuit plausibility alone did not justify shipping this model.

The coupled-AA grid was deliberately stopped after Harpie and String Hold; its evidence is explicitly incomplete. The separate exact-product-AA development grid completed, but independent alias tests found negligible benefit, so that numerical branch was also not selected. These results remain in `evidence/` without being presented as current native behavior. The evaluator accepts the analysis-only `--ring-model` options `product`, `bridge`, `coupled-product`, `bridge-coupled`, `bridge-coupled-aa` and `product-aa`. These expose retained diagnostic branches; current native behavior is original product ring with the independent free-triangle correction. The renderer itself also exposes `--triangle-aa off|on` for numerical ablations. Omit both overrides when measuring current native defaults.

The selected native implementation retains original product ring, adds free-triangle corner correction and corrects sync events. No analog constants are retuned and no audio delay is added. Final recording metrics and selected performances are retained in [evidence/final-summary.json](evidence/final-summary.json). The final development score is 3.753645 versus 3.753676 before; reserved validation is 4.627975 versus 4.641191 before. Wiff Wiff slightly regresses (3.005027 → 3.005700). These low-register clips are largely unchanged, while independent stress tests establish the numerical improvement. No result is a hardware-fidelity percentage.

## Historical identities and reproducibility

- Final v3 renderer: `83b2b0879de9714a041129fe56c5393224041dd88852a5c9e7cb400f429bc7ad`.
- Original v2 native renderer: `02730e59367815dfdd0d9e27853c9f05cd1c9cf2d7fcdcd875d81c7ddbec8dcd`.
- V3 cold baseline with analysis-only LFO phase: `384bc34dc8994117cffc65c44c68faac26b27d1d3cc1cc72a8d2960acf7bbb9f`.
- V3.1 baseline with offline settling: `acbc91bf2f01ebf80a015e0e78714e40623d7348b3a1ead14c31ed5083bf66b8`.

The phase-enabled baseline was byte-identical for all seven v2 renders at phase zero. Idle-zero parity passed all seven baseline cases and three candidate development cases. Historical numerical results require their frozen renderer; running a newer native engine against an old manifest is a new comparison, not historical reproduction.

The portable metric differs from its frozen workspace copy only in import paths. All scoring function bodies are AST-identical (`packaging-proof.json`). Full temporal JSON from the installed portable scorer exactly matches all three final development cases (`evidence/portable-v3.1-proof.json`), and all 23 source assets plus eleven extracted programs/crops/event files reproduce byte for byte. The portable CLI requires an explicit manifest to prevent accidentally selecting the historical cold protocol. Corpus paths are rewritten for portability, but source bytes, crops, events, notes and nuisance grids are preserved. Protocols and manifests retain original workspace hashes. The older v2 directory and evidence remain unchanged.
