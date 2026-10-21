# Monologue accuracy experiment, protocol v2

This directory contains the active seven-case protocol. The historical four-case
workflow and evidence are preserved in `../legacy/v1/`. The earlier corpus confused the oscillator's lower
divider frequency with the played MIDI note, omitted several note releases, and
included a second attack in the Pinoesque excerpt. Its scores are historical
diagnostics and cannot be compared numerically with this protocol's scores.

The public source is [callimero's Monologue patches and recordings](https://github.com/callimero/Monologue),
pinned at commit `e829a7fbcc15a2a3555f86625b8592d77e4e5b76`. The artist publishes
paired `.molgprog`, WAV and parameter images under MIT. The README identifies
Reaper/monoctrl, but does not publish MIDI performances, recording levels or a
complete recording signal chain. These are useful paired references, not laboratory
measurements of a uniquely identifiable analog circuit. Credit and the original
license accompany downloads. No firmware, recordings or patches are stored here.

## Frozen cases

| Case | Split | Physical MIDI | Analysis base | Source crop, seconds | Performance assumptions |
|---|---|---:|---:|---|---|
| S0S | Train | 88 | 76 | 1.222–1.625 | Later sequence note avoids source fade-in; known gate |
| Harpie | Train | 60 | 48 | .146–.745 | Hard sync; release at .346 source time inferred from sequence and envelope |
| Pinoesque | Train | 60 | 48 | .410–.840 | Stops before second attack at about .895; velocity and release unknown |
| DuiDui | Train | 52 | 40 | .538–1.038 | Two saws, shape LFO, velocity insensitive; manual release unknown |
| Wuai | Train | 48 | 48 | .540–1.040 | Similar two-saw settings, cutoff LFO; manual release unknown |
| String Hold | Existing holdout | 69 | 57 | .418–1.300 | Ring modulation includes muted VCO1; release unknown |
| Gloeckchen | New holdout | 72 | 60 | .305–.805 | Two triangles; first four pitches and 0.5 s steps match the saved sequence |

Firmware establishes that 8-foot triangle/divider phase is an octave below the
played MIDI note, whereas the unshaped saw carrier is twice that frequency.
`physical_midi_note` controls playback. `observed_base_note` specifies the spectral
analysis grid. The legacy `sounding_note` field retains observed-base semantics.
Wuai's unshaped saw has no appreciable lower divider component, so its analysis
base is the raw saw carrier. Notes are inferred from the recording and patch;
the artist did not supply the original MIDI stream.

Each excerpt places inferred note-on at 0.05 s, with approximately 2 ms uncertainty.
Known sequence gates are retained; other gates use frozen candidate sets in the
manifest. Pinoesque alone has nonzero velocity sensitivity, so nine velocities
from 1/127 through 127/127 are profiled. Unsynced two-oscillator cases also profile
eight initial relative phases. These are nuisance variables, not global DSP
parameters or claimed measurements of the artist's performance.

Gloeckchen was selected from the recording/patch alone and remained unscored
until the model and global calibration were frozen. String Hold has been inspected
in earlier iterations, so it is weaker validation than the new case. A Base and
Brite Power begin during notes or have overlapping releases; Twang adds unknown
velocity, glide and ring modulation; Akkordeon begins during attack. They remain
research reserves rather than silently adding uncertain performance assumptions.

## Reproduce

Use the pinned requirements in the parent directory. From the repository root:

```sh
python3 Tools/monologue/v2/prepare_corpus_v2.py --data-root /tmp/monologue-v2
cargo build --manifest-path Rust/Cargo.toml --release --features analysis --bin monologue-render
python3 Tools/monologue/v2/calibrate_v2.py Rust/target/release/monologue-render \
  --manifest /tmp/monologue-v2/accuracy-v2/corpus-v2.json \
  --calibration Tools/monologue/v2/warm-start-calibration-v2.json \
  --space Tools/monologue/v2/analog-search-space-v2.json \
  --fit --passes 2 --cycles-per-pass 2 --max-lag-ms 4 \
  --output /tmp/monologue-v2/fit
```

The downloader retrieves approximately 29.8 MB from 17 bounded, checksum-pinned
assets. It verifies the raw 448-byte patches, rendered excerpt bytes and event
JSON against the frozen manifest. `--offline` verifies already available assets.
The expected manifest SHA-256 is
`d8c52e3c2b8b01da0c048c04d601881f1c8dabbebfb053d7faff8fbfbf63e036`.

The seven search axes cover resonance, filter saturation, the post-VCA drive
branch and the common shape-calibration excursion. Firmware calibrates shape
endpoints at approximately 6 kHz, where the triangle RC filter reduces amplitude.
The excursion bound of 0.78–0.88 was fixed from the circuit and analog-switch
resistance before this search. Recovered pitch, controller, envelope and cutoff
laws, waveform-switch topology and calibration PWM coefficients stay fixed. The script never substitutes per-patch
oscillator or filter parameters. Baseline, pass boundaries and final evaluation
use the complete frozen nuisance grids. During global trials, nuisance candidates
are restricted to the current winner and adjacent values; this approximation is
recorded. Two passes with two coordinate cycles allow at most 56 global trials. The recorded
search starts from the preceding six-axis training result; explicit warm-start
constants preserve that provenance. `initial-calibration-v2.json` instead contains
the nominal analog baseline for a comparison within the final architecture.

After freezing the result, score validation in a separate invocation:

```sh
python3 Tools/monologue/v2/calibrate_v2.py Rust/target/release/monologue-render \
  --manifest /tmp/monologue-v2/accuracy-v2/corpus-v2.json \
  --calibration /tmp/monologue-v2/fit/best-calibration.json \
  --include-validation --max-lag-ms 4 --output /tmp/monologue-v2/frozen-evaluation
```

The fitter rejects `--fit --include-validation`. Freeze and retain the renderer
binary before fitting; changing a binary at the same path invalidates a run.
Reports retain binary/manifest/scorer hashes, every nuisance score, chosen events,
training means and the selected audio renders. Retain source revision/hashes with
results as well.

## Frozen result

The final architecture was evaluated with explicit nominal and fitted analog
constants. The five training renders are also bit-identical before and after the
last source audit, and all seven native-default renders are bit-identical to
explicit fitted constants at the same selected events and phases.

| Objective, lower is better | Nominal analog constants | Fitted constants |
|---|---:|---:|
| Training mean, five cases | 3.673462 | 2.278317 |
| Held-out mean, two cases | 3.382387 | 2.324286 |
| Gloeckchen, newly untouched validation | 3.438704 | 1.528456 |
| String Hold, existing validation | 3.326069 | 3.120117 |

That is a 37.98% training-objective reduction and a 31.28% held-out mean reduction
within the same architecture, not a percentage of hardware fidelity. The final
seven-axis search ran 50 bounded candidates, after a separate 68-candidate
six-axis structural run. Neither held-out case selected global constants.

The selected calibration excursion is 0.78 and the drive-bass coefficient is 0,
both at their declared lower bounds. Only Pinoesque supplies driven training
audio, so the drive branch remains weakly identified. Pinoesque chooses MIDI
velocity 127 and its earliest candidate release; String Hold chooses its earliest
release, and Wuai chooses its latest. DuiDui and Wuai reach the 4 ms alignment
bound. These choices remain uncertainties, not measured performance facts.
Reference harmonic coverage is approximately 94.9% for Wuai and above 99% for
the other cases. Fitted recording gain ranges from −5.06 to −10.05 dB; it is used
only for evaluation.

Harpie's lower component still decays too quickly. At approximately 25, 217 and
481 ms after onset, reference H2/H1 is −1.0, 9.2 and 17.4 dB; the model gives
1.6, 15.6 and 72.5 dB. The recovered firmware timing was independently rechecked
and was not altered to fit this remaining discrepancy. The source hardware's
firmware version is also not published: Harpie was uploaded before Korg's
[June 2019 OS 2.00 release](https://www.korg.com/us/support/download/software/0/733/3529/),
the version analyzed for this engine. A version difference is a confound, not an
established explanation.

The earlier engine scores 16.7340 on training and 20.8950 on validation when
played with the same physical MIDI. Those comparisons include its triangle
register error. An additional generous retrospective profile lets each training
case use the physical MIDI or one octave lower, reducing its mean to 4.83924;
that comparison changes the input and is labeled separately. Historical scores
remain available, but the within-architecture table above is the cleaner measure
of analog calibration.

## Objective and limits

The objective is local harmonic-band power error plus 0.3 times aligned
RMS-envelope error. It uses 64 harmonic bands, limited by a 12 kHz or Nyquist
center-frequency cap. This protocol was frozen before the first v2 model search;
the higher bands include DuiDui’s musically important resonance near 2.8 kHz. It uses the known analysis base, bounded local tuning
estimation and per-recording gain fitting. Maximum alignment is 4 ms; no pitch or
time warping is performed. Pitch error, harmonic coverage, envelope mismatch,
gain adjustment and the historical spectral metric are reported separately.
The main harmonic term takes a median over analysis frames to resist accidental
phase cancellation. Short timbral transients can therefore be underweighted;
pooled, union and temporal diagnostics must also be inspected. Harmonic bands do
not adequately measure noise or inharmonic alias energy. The objective is not a
perceptual fidelity percentage.

`cached_metric.py` caches immutable reference audio/features while always reading
the current candidate. It executes the unchanged comparator with private helper
bindings. Cached/uncached equality, mutable-file invalidation and concurrent calls
were checked; `cache-validation.json` records that verification. Packaging removes
only the original workspace-specific audit driver. Retained function ASTs and
five complete training reports were verified identical; see
`metric-packaging-proof.json` and `packaging-validation.json`. Cache performance
does not establish native real-time audio performance.

Seven excerpts from one recording chain cannot identify every circuit parameter.
Relative phase, manual gate timing, velocity, analog drift and recording transfer
remain confounds even after profiling. A good training score is insufficient:
the untouched case and broader hardware recordings are still required to assess
how well an improvement generalizes.
