# Circuit-derived monologue ring model

These files reproduce the ring lookup table and validate the standalone Rust
module. The circuit model remains analysis-only after development recordings
regressed; native playback retains the original product and corrects upstream
triangle aliasing. The separate interval-averaged product experiment was also
not adopted. See `development-comparisons.json` and
`product-aa-experiment.json` for the preserved results.

No audio examples, firmware bytes, or patch-specific fitting enter the
generator. See `docs/monologue-ring-evidence.md` for the circuit and assumptions.

From this directory:

```sh
python3 generate_ring.py
rustfmt --edition 2021 monologue_ring.rs
rustc --edition 2021 -O --test ring_tests.rs -o /tmp/monologue-ring-tests
/tmp/monologue-ring-tests
rustc --edition 2021 -C opt-level=3 bench.rs -o /tmp/monologue-ring-bench
/tmp/monologue-ring-bench
```

Python needs numpy; the Rust runtime has no new dependencies. The generator
writes `monologue_ring.rs`, `ring_table.npy` and `verification.json` beside
itself. Review the generated module before copying it to
`Rust/src/modules/monologue_ring.rs`. The template is the authoritative source
for the wrapper and tests; update it when changing the generated wrapper.

`verification.json` is a small reference fixture with converged physical
voltage probes, grid/hash metadata, interpolation coverage, symmetry checks
and component sensitivity. The table hash covers f32 little-endian bytes in
a-major/b-minor order. `benchmark.jsonl` preserves five local cache-hot
microbenchmark runs; it is not an iPad audio callback or end-to-end latency
measurement. The old scalar product was measured in the same harness.

The 1.2mV checked ceiling describes error versus the declared nominal circuit
model over the tested grid interior and seeded points. It is not a physical
hardware accuracy claim or a mathematical certificate over every real input.
The actual D29–D32 part number is unknown; diode parameters are assumptions.

## Native/analysis parity

`parity.rs` is the preserved standalone harness for `native-analysis-parity.json`.
Its relative source path works from any checkout. From the repository root:

```sh
monologue_parity_dir="$(mktemp -d)"
rustc --edition=2021 -C opt-level=3 Tools/monologue/v3/ring/parity.rs -o "$monologue_parity_dir/native"
rustc --edition=2021 -C opt-level=3 --cfg 'feature="analysis"' Tools/monologue/v3/ring/parity.rs -o "$monologue_parity_dir/analysis"
"$monologue_parity_dir/native" "$monologue_parity_dir/native.f32"
"$monologue_parity_dir/analysis" "$monologue_parity_dir/analysis.f32"
cmp "$monologue_parity_dir/native.f32" "$monologue_parity_dir/analysis.f32"
shasum -a 256 "$monologue_parity_dir/native.f32" "$monologue_parity_dir/analysis.f32"
```

Each output contains 368,640 finite f32 values (1,474,560 bytes), covering all
four ports, sync/ring/mode switching, live sample-rate changes and nonfinite
pitch/bend inputs. There is no idle conditioning. The recorded final arm64
output hash is `4b7ba2cb8af5481129896bed5da63860404126cd0339a10fc91db9b802156e39`.
The JSON pins the corresponding engine sources; later DSP/compiler/target
changes may change that historical hash. `cmp` verifies the two feature variants
against each other. This checks standalone voice output, not the app binary or
physical audio latency. Executables and output data stay in the temporary folder.
