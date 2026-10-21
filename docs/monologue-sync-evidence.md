# Monologue oscillator edge correction

The synced VCO2 now corrects the discontinuities it actually traverses. The
previous free-running phase-BLEP formula anticipated natural edges that a master
reset could cancel, carried the wrong ordinary-wrap tail after reset, and omitted
the reset's arbitrary jump. The fractional reset phase advance itself was already
correct; this change preserves it and the modeled reset-to-zero convention.

## Event timing and state

For master phase `p1` and increment `d1`, a wrap in the next internal sample occurs
at `t = (1 - p1) / d1`. The slave then finishes that interval at `(1 - t) * d2`.
`monologue_sync.rs` emits actual natural edges before reset, the reset edge, then
natural edges after reset. A slave wrap before reset retains its correction tail;
a wrap after reset is canceled. At exact coincidence the natural edge is excluded
and the reset uses the waveform's left limit, producing one net jump.

An event at fraction `t`, with value jump `J` and derivative jump `D` measured per
internal sample, contributes:

```text
current sample:  J/2 * (1-t)^2 + D/6 * (1-t)^3
next carry:    -J/2 * t^2     + D/6 * t^3
```

The value correction is a two-sample polynomial BLEP. The derivative correction is
its integrated BLAMP counterpart. Triangle corners and reset slope changes need
the latter. Both corrections precede the analog RC; triangle folding remains
after that RC and can create further corners. Free-running triangles now use the
same BLAMP term for their actual half-cycle corners. This is a separate one-tail
helper, with no saw or comparator calculation. The existing saw and pulse
formulas and the analog shaping curves are unchanged. The slave noise selection
does not use these waveform corrections; its free-triangle tail is cleared in
Sync/noise mode so a previous phase trajectory cannot leak into a later mode.

This follows the general event-based hard-sync treatment described by [Eli
Brandt](https://www.cs.cmu.edu/~eli/papers/icmc01-hardsync.pdf). The need to correct
derivative discontinuities is discussed by [Esqueda, Välimäki and
Bilbao](https://www.pure.ed.ac.uk/ws/portalfiles/portal/28180097/18_DAFx_16_paper_33_PN.pdf).
The short polynomial formulas here were independently derived; they are not a
claim to reproduce a particular paper's implementation.

The audit also found a floating-point endpoint defect: the f32 threshold
immediately below 1 can round its comparator phase to 0.5. Treating the resulting
three equal boundaries as separate net jumps tripled their correction. The final
module skips comparator boundaries that round onto 0, 0.5 or 1; natural boundary
handling already provides the net value and slope change. The tiny positive
comparator near −1 remains a real event and is retained. Adjacent-float regression
coverage now includes both rails, both ramp boundaries and reset/no-reset cases.

The synced oscillator keeps two f32 correction tails; each free triangle keeps
one more f32 tail. It predicts its own next oscillator
interval and adds no input or output buffer. The existing 127-tap decimator's
group delay remains 63 / (4 × sample rate), or **0.328125 ms at 48 kHz**. This does
not measure native callback scheduling, MIDI delivery or physical iPad latency.

## Independent checks

The reproducible checks and small JSON reports are in
[`Tools/monologue/v3/sync`](../Tools/monologue/v3/sync/README.md).

1. **Exact triangular convolution of the compiled module.** Three thousand seeded
   two-interval cases cover arbitrary reset fractions and increments, with 300
   cases at each immediately adjacent interior f32 rail value. Two-point Gauss
   integration on each piecewise-linear segment exactly integrates the waveform
   times the triangular kernel. This calculation does not reuse the BLEP/BLAMP
   formulas. Maximum absolute error was **1.55e-7 for triangle** and **1.39e-6 for
   saw**, below the 2e-5 tolerance. Small differences include f32 phase rounding.
2. **Analytic periodic reference.** Value jumps and slope jumps give exact Fourier
   coefficients of the piecewise-linear synced raw waveform. The reference then
   applies the continuous analog RC. Triangle folding is resolved on a 262144-point
   periodic grid before the existing FIR response. A separate event-corrected
   render at 3.072 MHz converges to that reference with **−87.7 to −95.1 dB**
   coherent in-band error across the twelve cases.
3. **Frozen whole-engine executables.** Synthetic steady notes at 44.1, 48, 96 and
   192 kHz exercise saw/triangle shapes, noninteger slave/master ratios, nearly
   coincident wraps and high notes. The final candidate uses the native product
   ring and corrected free-triangle defaults. No recording, reset parameter, phase, pitch or gain is fitted.

A naïvely sampled high-rate discontinuous waveform was rejected as the reference:
it retained detectable aliasing even at 3.072 MHz. The analytic reference and
independent high-rate convergence check avoid treating that artifact as truth.

## Whole-engine results

The table is off-harmonic power relative to total power from 40 Hz to 16 kHz, at a
48 kHz output rate. Harmonic masks are ±30 Hz. More negative is cleaner. These are
selected synthetic stress cases, not percentages of hardware sound accuracy.

| Synthetic case | Previous v2 | Final v3 |
| --- | ---: | ---: |
| Shaped saw, master 997.3 Hz, ratio 2.375 | −41.43 dB | −77.44 dB |
| Plain triangle, same clocks | −34.73 dB | −84.67 dB |
| Folded triangle, same clocks | −35.71 dB | −53.03 dB |
| Shaped saw, master 3989.2 Hz, ratio 2.375 | −30.01 dB | −64.58 dB |
| Plain triangle, same high clocks | −25.71 dB | −80.10 dB |

The folded triangle improves further to **−77.68 dB at 192 kHz**. Its remaining
corners occur after the corrected oscillator, so input-edge correction cannot
remove every nonlinear artifact. No filtering or timing parameter was tuned to
these measurements.

The preserved baseline renderer SHA-256 is
`02730e59367815dfdd0d9e27853c9f05cd1c9cf2d7fcdcd875d81c7ddbec8dcd`.
The final candidate is
`83b2b0879de9714a041129fe56c5393224041dd88852a5c9e7cb400f429bc7ad`.
The JSON includes all parameters, sample rates and generated audio hashes.

The off-harmonic metric alone is insufficient. At an exactly 1000 Hz master,
timing artifacts can land on legitimate harmonics and remain invisible to it.
Across reset fractions 0.125, 0.5 and 0.875, the independent model's coherent error
improves from roughly −30 to −38 dB to about −42 dB. The remaining coherent error
also includes polynomial smoothing and the discrete RC approximation. The
analysis window's finite leakage floor limits the meaning of very low residuals.

These checks establish numerical consistency under the declared waveform and
reset model. The physical sync edge polarity, reset transient, analog tolerances
and full hardware sound match remain separate questions.

## Free triangles and ring modulation

The native engine retains its scalar-product ring approximation. Experimental
coupled diode models, bridge quadrature and product averaging remain behind the
analysis feature; none adds work or buffering to production audio. Their recorded
sound comparisons are discussed in `monologue-ring-evidence.md`.

A separate 6000-case exact-convolution audit checks `FreeTriangle`, with a maximum
absolute error of **1.78e-7**. A streaming regression also checks that the cheaper
helper matches the proven no-reset triangle path. The whole-engine rate audit
uses one frozen executable and switches only `--triangle-aa off/on`, with
`--ring-model product` in both renders. It introduces no phase, gain, delay or
pitch adjustment.

At a 48 kHz output rate and a 1123.45 Hz master:

| Ring inputs | Triangle correction off | Correction on |
| --- | ---: | ---: |
| Pulse × plain triangle, ratio 19/8 | −67.87 dB | −85.11 dB |
| Plain triangle × plain triangle, ratio 19/8 | −67.78 dB | −92.54 dB |
| Folded triangles, ratio 7/4 | −57.41 dB | −59.68 dB |
| Shaped saws, ratio 19/8 | −64.11 dB | −64.11 dB |
| Pulse × shaped saw, ratio 11/8 | −72.52 dB | −72.52 dB |

This metric measures energy outside the full integer `n*f1 + m*f2` frequency
lattice from 40 Hz to 16 kHz, using ±12 Hz masks. It therefore includes the higher
product families and does not misclassify legitimate ring sidebands as aliases.
It still misses aliases coincident with those families. The plain-pair result
reaches this test's finite-window floor, so it establishes a bound rather than an
exact residual noise level. The corrections also improve the triangle cases at
44.1 and 96 kHz. Source folding still creates additional corners after correction.

At a 55 Hz master, the 40 Hz–2 kHz waveform changes by no more than **0.000923%**
RMS across these cases, without alignment or gain fitting. Saw-only paths are
byte-identical. Cross-rate family-amplitude diagnostics are also recorded but
should not be interpreted as pure alias error: float phase accumulation and
cancellation between coincident harmonic products can affect them. Same-rate
on/off comparisons avoid that confound.

Both the free-triangle and sync corrections use known oscillator trajectories,
so their additional buffering delay is **zero**. Physical playability still
requires an actual device and MIDI/audio-loopback measurement.
