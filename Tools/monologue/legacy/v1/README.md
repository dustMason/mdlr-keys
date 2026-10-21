# Monologue audio calibration toolkit

These original Python tools decode public patch settings, render the native Rust voice, and compare it with paired recordings. They are development tools; the live sound engine does not load reference audio or run Python.

The [callimero/Monologue](https://github.com/callimero/Monologue) author publishes matching `.molgprog`, WAV and MonoCtrl screenshots under MIT. `sources/callimero-provenance.json` pins revision `e829a7fbcc15a2a3555f86625b8592d77e4e5b76` and every downloaded original’s URL, size and SHA-256. Attribution/license is preserved in `sources/callimero-LICENSE`. No source WAVs, patch containers, firmware, or native binaries are checked into this directory.

## Reproduce from the repository root

Python 3.11+ is required. The requirements pin the versions used for the recorded experiment.

```sh
python3 -m venv Tools/monologue/.venv
Tools/monologue/.venv/bin/pip install -r Tools/monologue/requirements.txt
Tools/monologue/.venv/bin/python Tools/monologue/fetch_references.py
Tools/monologue/.venv/bin/python Tools/monologue/build_corpus.py
cargo build --manifest-path Rust/Cargo.toml --release --features analysis --bin monologue-render
Tools/monologue/.venv/bin/python Tools/monologue/calibrate.py Rust/target/release/monologue-render --calibration Tools/monologue/initial-calibration.json --output Tools/monologue/data/runs/baseline
Tools/monologue/.venv/bin/python Tools/monologue/calibrate.py Rust/target/release/monologue-render --fit --passes 2 --space Tools/monologue/search-space.json --output Tools/monologue/data/runs/fit
Tools/monologue/.venv/bin/python Tools/monologue/harmonic_report.py Tools/monologue/data/runs/fit
```

If Cargo uses a different target directory, pass the actual renderer path. `--data-root /path/to/scratch` is supported by the fetch, corpus, fit and harmonic tools. Generated assets default to ignored `Tools/monologue/data/`. `fetch_references.py --all` downloads the larger, bounded research subset (seven recordings and 28 patches); the default downloads only the four cases needed for reproduction. Existing assets are hash-checked before reuse. The extractor reads exactly one 448-byte program member from each ZIP and never executes external code.

`audio_compare.py reference.wav candidate.wav --max-lag-ms 20` also works independently. `decode_patch.py patch.molgprog --output patch.json` exports control values and sequencer events.

## Fixed cases and evaluation rules

| Case | Split | Audio excerpt | Inferred sounding note |
| --- | --- | --- | --- |
| S0S, open-filter triangles | Train | 1.222–1.625 s | 76 / E5 |
| Harpie, single VCO2 saw | Train | 0.146–0.745 s | 48 / C3 |
| Pinoesque, triangle + saw with drive | Train | 0.410–1.000 s | 48 / C3 |
| String Hold, single VCO2 saw with drive | Held out | 0.418–1.300 s | 57 / A3 |

Each excerpt contains one note. Gate onset is inferred at 50 ms into the excerpt. S0S gate off is estimated at 347 ms; other excerpts end before the next note, without inventing a gate-off. S0S, Harpie and String Hold have both amplitude and cutoff velocity sensitivity zero; their placeholder performance velocity is 0.8. Pinoesque has amplitude sensitivity 50/127 and cutoff sensitivity 50%. Its unknown performance velocity is profiled over MIDI values 1, 16, 32, 48, 64, 80, 96, 112 and 127 for every candidate. Each score retains the full velocity profile and selected value. This is a nuisance fit, not evidence that the original velocity was recovered. Timing, oscillator phase, recording gain/transfer and global settings are not supplied by the artist. Three checked recordings sound an octave below their stored sequence note numbers; the renderer events use measured sounding pitch instead of asserting a universal hardware transposition rule. S0S’s early events appear faded, so a later stable event is used.

The objective combines mean log-magnitude error at FFT sizes 256/1024/4096 with 0.3 times 5 ms RMS-envelope error. It ignores bins where both signals are below −60 dB of reference peak and floors magnitudes at −80 dB. Recording gain is fitted per excerpt and reported explicitly. The optional bounded envelope alignment defaults to ±20 ms. No pitch shifting or time stretching occurs; residual fundamental pitch and spectral convergence are separate diagnostics. Gain correction is not installed into the sound engine.

`--fit` performs coordinate search over **global** cutoff curve, filter-EG depth, separate saw/triangle waveshape amounts, triangle amplitude fall and drive constants. It never modifies patch controls, event notes, timings, or stored samples. Search uses only the three training cases. The held-out case is evaluated at baseline and completion. `--space search.json` sets plausible ranges; `--calibration initial.json` provides initial constants. Without the latter, fit baselines use the search space’s explicit initial constants. Baseline/final WAVs and every trial’s constants/scores are retained; temporary trial WAVs are removed. Output gain is excluded from global calibration because it is a recording nuisance. The Pinoesque velocity profile is likewise separate from the seven global constants.

## Evidence and limits

The initial and firmware-law experiments below assumed velocity 0.8 for every case. That was an unjustified assumption for Pinoesque, discovered and corrected before the final profiled experiment. Their numbers are historical diagnostics and are not directly comparable with the later nuisance-profiled objective.

`evidence/initial-*.json` records the first provisional model, before firmware-derived envelope/LFO laws were incorporated. The 20-trial fit reduced its training objective from 11.97447 to 10.87987 (9.14%) and its untouched held-out objective from 9.12596 to 8.88937 (2.59%). These are metric reductions, not claims of perceptual similarity or hardware equivalence. The exact renderer binary hash is retained in the evidence; its binary is outside the repository. Later model revisions need new renders and must not reuse those scores as current validation.

`evidence/firmware-*.json` records the subsequent firmware-derived envelope/LFO/shape-control model. Its separate 20-trial fit reduced training error from 12.03461 to 11.36287 (5.58%) and untouched held-out error from 8.96565 to 8.92031 (0.51%). The selected global constants are in `evidence/firmware-calibration.json`. They were selected using training cases only. The shape-fold-only ablation is also retained: it worsened the provisional model’s training score, showing that a correct isolated control rule does not compensate for other approximate laws. These experiments preserve unsuccessful as well as successful steps.

`evidence/profiled-*.json` records the firmware-law model with separate triangle shaping and amplitude fall, plus corrected velocity handling. Its 28-trial fit reduced training objective from 11.92218 to 10.60078 (11.08%). The held-out String Hold score changed from 8.98004 to 8.96055 (0.22%), essentially unchanged. Best-case training scores are S0S 7.520, Harpie 11.170 and Pinoesque 13.113. Both initial and final velocity profiles choose Pinoesque's upper boundary, MIDI 127. The final velocity-grid scores range from 13.835 to 13.113; this weak identification can trade off against analog-model errors. Do not interpret the selected velocity as measured performance data.

`evidence/current-*.json` is the final frozen revision after the firmware audit, including cutoff-control LFO modulation, signed depth, fast BPM sync and live envelope phase transitions. It re-evaluates the same initial and selected constants without another search. Training objective is 11.93439 → 10.60614 (11.13% lower); held-out is 8.98126 → 8.95966 (0.24%), essentially unchanged. Native-default renders are bit-identical to explicitly fitted renders for all four cases; their WAV SHA-256 values are recorded in `current-summary.json`. `current-renderer.json` records binary, split Rust source, corpus, analysis-script hashes and runtime versions. `evidence/current-calibration.json` contains the installed global constants. Native defaults can change, so the reproduction commands pass explicit initial constants; to score fitted constants, pass this evidence calibration file instead.

The remaining harmonic error is substantial. Ideal symmetric triangles lack some small even harmonics in S0S and have stronger upper odd harmonics than the recording. The latest model includes waveform-dependent triangle amplitude changes, but a tiny expressive-patch corpus cannot uniquely identify those circuit parameters or establish generalization. Mixed-oscillator pitch estimates can jump an octave when the upper oscillator dominates; they are diagnostics, not an independent tuning measurement. Uncontrolled recording transfer, velocity, phase and manual timing remain confounds. Controlled isolated oscillator, filter sweep, level, resonance and envelope captures would be needed for stronger claims.

## Primary control schema

The [official Korg MIDI implementation](https://www.korg.com/us/support/download/manual/0/733/4231/) defines the 448-byte program. `decode_patch.py` follows Table 2, with two explicit document errata: note P1 rotates EG INT/LFO RATE/LFO INT high-byte offsets, and early event ranges incorrectly imply 12-byte steps. Table 2’s EG INT 26/LFO RATE 27/LFO INT 28 ordering matches paired screenshots; S2 and the total size establish 22-byte steps. EG INT and LFO INT are bipolar around 512. Normalized positions are not analog transfer functions.

The manufacturer’s [service manual](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf) shows the analog oscillator/filter/VCA signal path and a **post-VCA** dry/drive+low-boost/wet branch. Firmware supplies control laws, not an audio DSP synthesizer to execute. The native audio model remains an approximation of that analog path.
