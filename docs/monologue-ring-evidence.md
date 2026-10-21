# Monologue ring: native product and experimental circuit models

The final native v3 engine retains the existing selected-waveform product
approximation for Ring. Alias correction targets the oscillator's upstream
triangle slope changes before the existing RC stage, alongside the separate
hard-sync event correction. The circuit-derived diode bridge/coupling and
interval-averaged product remain **analysis-only experiments**.

The physical model regressed the String Hold development recording. The
interval-averaged product changed the tested 48 kHz off-family power by only
-0.13 to +0.25 dB, with mixed signs. Neither experiment established sufficient
benefit for native adoption. Both decisions preceded fresh validation scoring.
No circuit constants or physical connections were changed to chase a recording;
the source, tables, tests and rejected comparisons remain reproducible.

## Native path and latency

Native Ring multiplies the current selected VCO1 and VCO2 waveform samples,
including VCO1 when its mixer level is zero. Both mixer inputs use their current
sample, without the experimental half-internal-sample offset. The physical
bridge table, coupling states and product interval averaging are excluded from
native processing. Analysis mode 0, `product`, produces the same output.

The free triangle's piecewise-linear corners receive a BLAMP slope correction
before the existing RC stage. This corrects upstream digital aliasing without
adding a block queue or a fixed delay. It does not identify the analog diode
characteristic or establish hardware fidelity for the ring transfer.

At 4x oversampling the 127-tap decimator has linear-phase group delay
63/(4*sampleRate), or **0.328125 ms at 48 kHz**. There is no additional 2.604 µs
ring-averaging delay in the native path. These are DSP delays, not physical
MIDI-to-sound or device round-trip latency: host buffering, route conversion,
OS scheduling and envelope onset remain separate.

## Experimental interval-averaged product

For previous inputs a0,b0 and current inputs a1,b1, analysis mode 5,
`product-aa`, computes the exact average product along a linearly interpolated
sample interval:

```text
meanA = (a0+a1)/2; meanB = (b0+b1)/2
product = meanA*meanB + (a1-a0)*(b1-b0)/12
```

It preserves the existing product law and gain for constant inputs. Dry VCO1
uses meanA while Ring is selected, aligning the two inputs. The method adds a
nominal half internal sample (0.002604 ms at 48 kHz) only when this experiment is
selected; it is not part of the final native path.

An audit of the frozen pre-triangle-correction renderer compared `product-aa`
with `product` using the same source binary. For the four high-note cases at
48 kHz, changes in 40 Hz–16 kHz off-family power were -0.1301, -0.0832, -0.0381 and
+0.2538 dB (negative is improvement). The 55 Hz cases changed by less than 0.0003 dB.
These small mixed-sign changes did not justify adoption. The exact scores,
renderer/script/audio hashes and measurement limits are preserved in
[product-aa-experiment.json](../Tools/monologue/v3/ring/product-aa-experiment.json).
This was an engineering alias probe, not a hardware recording comparison.

The intermediate product-AA integration passed standalone native/analysis
parity with output SHA256
`37b7d8eade6a517db07a37bdd0a289efcea57be1fbfef84935cc405b2dd464f8`.
Its source hashes remain in
[native-analysis-parity-product-aa.json](../Tools/monologue/v3/ring/native-analysis-parity-product-aa.json).
That is historical experiment evidence, not the final native default.

## Primary evidence and identification limits

- [Korg monologue service manual, manufacturer-authored mirror](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf),
  KLM3621 sheet4, printed page7 (PDF index6): IC24A–D, D29–D32, C274/C275/C271,
  IC25/IC26 and the VCA input resistors.
  SHA256 `1f8ed4017e4dba227b2f0cf66fd6ea59e68d458db8d0ec253837bc2ad2c17fe9`.
- [ROHM 1SS355 datasheet, manufacturer-authored distributor copy](https://media.digikey.com/pdf/Data%20Sheets/Rohm%20PDFs/1ss355.pdf),
  page2 figure1: representative 25°C forward characteristic. SHA256
  `85a33606c48f855e87997bf742ae75eb35493454ed361e18573f6df51ef99a31`.
  This is a reference curve, **not identification of the installed ring diodes**.
  The service manual's named 1SS355 devices belong to a different panel board.
  Mainboard D29–D32 are only marked `D`, and the repair parts list does not name them.
- [ST TL084C datasheet](https://www.st.com/resource/en/datasheet/tl084c.pdf),
  July2022 revision8, pages5–6: the schematic names TL084CPT. Its listed typical
  slew rate16V/µs and gain bandwidth4MHz apply at the datasheet test conditions,
  including ±15V supply, not a direct measurement of this ±5V circuit.

## Signal routing and voltage convention

`SND1` is the selected VCO1 analog waveform after C275, before VCA1. `SND2` is
the selected VCO2 waveform after C274, before VCA2. Muting VCO1 in the mixer
therefore leaves its ring input active. The carrier is the selected analog
waveform with its physical shape and amplitude, not an abstract digital square.

`RING_ON` makes IC26's Z switch replace VCA2's input with `RTN`. The diodes
remain connected and operating when ring mode is off. This is why coupling
states run continuously rather than being initialized on a note or mode change.

The core's oscillator unit corresponds to0.55V, from the schematic's1.1Vpp
raw saw annotation. Existing waveform-path gains are retained: a nominal
unshaped triangle reaches±1.21V after its2.2 gain, while the nominal pulse peak
is about±.2234V under the separately documented7Vpp comparator assumption.
The bridge converts input units to volts and output volts back to the same
units. It performs **no RMS, peak, or perceived-loudness normalization**.

## Static nodal model

Let `a=SND1` and `b=SND2`, in volts. IC24A produces `b−a` (R408/R405=1M,
R166/R172=100k). IC24B produces `b+a` (R373/R404=100k). IC24C produces `−b`
(R399/R376=100k).

Label the diode ring corners clockwise: upper-left `u`, upper-right `v`,
lower-right `w`, lower-left `z`. All four sources connect through10k:
`u←b−a` via R406, `v←−b` via R375, `w←b+a` via R403, `z←−b` via R393.
Diodes run clockwise: D32 u→v, D30 v→w, D29 w→z, D31 z→u.

IC24D has R378/R394=100k and R377/R395=150k. Its plus input is`.6z`, so the
ideal output is`1.5(z−v)`. The bridge is loaded asymmetrically: the v node sees
`(v−.6z)/100k`, while z sees`z/250k`. Those terms are retained in the solve.

With diode current `D(q)`, the KCL equations are:

```text
(u−(b−a))/10000 + D(u−v) − D(z−u) = 0
(v+b)/10000     + D(v−w) − D(u−v) + (v−.6z)/100000 = 0
(w−(b+a))/10000 + D(w−z) − D(v−w) = 0
(z+b)/10000     + D(z−u) − D(w−z) + z/250000 = 0
output = 1.5(z−v)
```

The nominal diode assumption is `D(q)=1e−9*expm1(q/0.04342944819032518)` A.
It approximately follows the reference25°C curve around .4V at10µA,
.5V at100µA and .6V at1mA. The earlier scratch model's `Is=1e−12,nVt=.05V`
was an uncalibrated placeholder and is superseded by this explicit assumption.

The matched nominal circuit is exactly odd in b. Changing `b→−b` maps nodes
`(u,v,w,z)→(−w,−v,−u,−z)`, negating the output while preserving all equations.
It is not exactly odd in a because of the output loading. The table therefore
keeps both signs of a and only uses odd symmetry for b. Both zero axes vanish
for the matched circuit; no arbitrary carrier leakage has been added.

Example converged voltages, before output coupling:

| a (V) | b (V) | Output (V) |
|---:|---:|---:|
| .2234 | .55 | .297062206 |
| −.2234 | .55 | −.297432412 |
| .55 | .55 | .715932815 |
| 1.21 | .55 | .982865547 |
| 1.21 | 1.21 | 1.353229190 |

## Coupling capacitors and continuous state

All three capacitors are10µF, specified20% tolerance. Approximating each VCA
input by its47k series resistor plus explicit1k base shunt gives48k. Actual
transistor base loading can reduce that1k contribution, making this a small
input-impedance approximation, not a recovered transistor model.

| Capacitor | Mode | Effective resistance | Time constant |
|---|---|---:|---:|
| C275, source1 | either | 48k ∥ 1M =45.802k | .458015s |
| C274, source2 | ring on | 100k ∥ 100k ∥ 200k =40k | .400000s |
| C274, source2 | ring off | 40k ∥ 48k =21.818k | .218182s |
| C271, return | ring on | R407 (100kΩ) ∥ 48k =32.432k | .324324s |
| C271, return | ring off | R407 (100kΩ) | 1.000000s |

R391 is the 100kΩ source2 shunt. The other source2 loads are IC24A's100k+100k
divider and IC24C's100k input. The source1 load through R408 is weakly driven
by the IC24A minus input at`b/2`; it is not simply grounded. The capacitor
update includes that cross term with gain`(48k∥1M)/(2*1M)=.02290076336`.
Holding b constant over each oversampled update is the stated discretization
approximation. The per-step pole uses`g=−expm1(−1/(fs*R*C))`.

Capacitor states use f64, avoiding the artificial permanent DC floor that an
f32 low-pass state can acquire when its tiny update rounds away near a steady
input. They begin at zero, persist across notes and mode changes, and reset
only when the engine explicitly resets. This is not a warm-start assumption.
The sources and return can be processed separately for controlled ablations.

## Table, numerical verification and real-time cost

The offline solver uses damped Newton with a residual-decreasing line search
and refuses to emit nonconverged points. Its129×65 f32 table occupies33,540bytes.
The domain is a∈[−1.5,+1.5]V, |b|∈[0,1.5]V, covering the nominal±1.21V
triangle with guard space. Outside inputs are explicitly clamped to that
domain; this guard is **not** a physical op-amp rail saturation model.

Verification covers all8,192 table cells at nine interior locations each,
plus20,000 seeded random points across all signs:93,728 points total.
Maximum observed interpolation error is1.083mV; RMS error is.184mV. The
generator enforces a1.2mV ceiling over this coverage. This is an engineering
check of finite coverage, not an all-real-input mathematical certificate.
The largest KCL residual was2.23e−16A. b-odd residual was6.67e−16V; a-inversion
asymmetry reached35.94mV in the checked region and is retained.

The table's f32 little-endian SHA256 is
`e03c02cd81333c7cec7a9be554267b693fd774a48b8507af2a6a7c0d6610aa13`.
`Tools/monologue/v3/ring` contains the generator, wrapper template, voltage
fixture, standalone tests and benchmark harness. Six Rust tests cover circuit
probes, zero axes and symmetry, domain guards, source-cap time constants at
four rates, long-term DC rejection, and split/convenience API equivalence.

The static transfer lookup uses four table reads and bilinear interpolation.
Coupling adds a few capacitor-state operations. There is no live Newton solver,
heap allocation, lock or queue. Coefficients are cached and recomputed only when
the internal sample rate changes. The experimental `bridge-coupled-aa` path
adds four Gauss-Legendre evaluations of this transfer per internal step and
aligns its dry VCO1 input with the same interval average.

Five local optimized Rust 1.98 arm64 microbenchmark runs measured median 3.35ns
for one static transfer and6.47ns for transfer plus coupling, against 1.05ns for
the old scalar product. These are historical cache-hot microbenchmarks of the
**experimental helper without quadrature**, not final native callback timing
or an iPad measurement. Neither the LUT cost nor the coupling cost applies to
the final native product path. Full bridge-AA and final native CPU results
must be reported separately.

The earlier bridge integration passed standalone native/analysis parity with
output hash `6a3ae0a1c3e8078b26e1183ea7f8a2a9e6cee28d0b3f4c00c0b0edee01076b12`.
That is a historical pre-AA integration check, not the final native model.

## Development comparison and fixed resting-state audit

Cold comparisons began with zero capacitor states. A source audit then found
that String Hold's pulse waveform should be constant after its OneShot finishes,
so a rested physical C275 would be charged. Protocol 3.1 therefore declared the
same 12-second gate-low prehistory for baseline and candidate: parameters
settled first, resting pitch/velocity set to the first note, OneShot completed
at phase 0.5, oscillator and repeating-LFO phase seeds applied at t=-12 seconds,
and no state reset at t=0. Capacitors settle by rendering; their voltages are
never assigned or fitted. The prior physical pitch, idle duration and capacitor
charges were not recorded, so this is a reproducible condition rather than a
reconstruction of that particular recording session. Default `--idle-seconds 0`
skips the initialization and rendering completely.

The paired development results below use the same bounded nuisance-profiling
rules within each protocol. Lower errors/scores are better. The warm baseline
retains the old product; these values predate the final upstream triangle correction.

| String Hold condition/model | Harmonic mean error (dB) | Envelope error (dB) | Objective |
|---|---:|---:|---:|
| Cold product | 3.073617 | 0.653209 | 3.269580 |
| Cold bridge only | 3.041378 | 1.345004 | 3.444879 |
| Cold coupled product | 3.311592 | 0.445002 | 3.445093 |
| Cold coupled bridge | 3.138734 | 0.875774 | 3.401466 |
| 12s idle baseline product | 3.073027 | 0.588954 | 3.249713 |
| 12s idle coupled bridge | 4.126189 | 1.573633 | 4.598279 |

For the warm comparison, H2/H1 trajectory mean absolute error also rose from
1.944486 to 8.635629 dB. Deep Meow's H2/H1 trajectory improved under the bridge,
but its warm total objective was 2.198981 versus baseline 2.137734. Thus an
individual harmonic improvement did not establish a reliable overall gain.
The bridge was rejected on development data; no fresh validation result or
per-patch component adjustment influenced that decision.

The complete cold and warm development summaries are preserved in
[development-comparisons.json](../Tools/monologue/v3/ring/development-comparisons.json),
including original source hashes and metric/nuisance details. Their source
SHA256 values are `fdff48eeecb6e5cb3e174cd0b04f7b70e432dfff343659df8c6c9c5dcb178c32`
and `425afb9783906f437272401ca658bf958fc93dec9cc023c811569e86adcdc829`.

## String Hold primary-source recheck

The paired [patch, screenshot and recording](https://github.com/callimero/Monologue/tree/e829a7fbcc15a2a3555f86625b8592d77e4e5b76/patches)
from callimero/Monologue agree on the controls: VCO1 square with shape 1023 and
level 0; VCO2 saw with shape 603 and level 886; Ring; a negative OneShot saw LFO
targeting Shape, raw rate 249 and intensity 138. The screenshot shows the
corresponding 7-bit values (shape 127/75, rate 31, intensity -47, level 0/110).
The repository history places both String Hold's WAV/program pair and Deep
Meow's pair in the same April 4, 2019 upload commit
`a132af80576ea205e27eb592cf9f8a9e975fa9bb`, with no later independent file updates.
That does not support file-revision drift, but it does not establish the hardware
firmware version or performance state used for either recording.

The raw 448-byte program SHA256 is
`e77c49abcb33170346b491e80c10c39f96a43cec6118d92366fe78e82a84caf2`;
the WAV SHA256 is
`4af72f2407bafe1b37c6c13c3b6d7a6e4173bd295d7408a5cb5b8059b60b7513`.
The screenshot SHA256 is
`a6a365418d39b3f84392552974c16d4d49f90d6388a8e7b045a469f25e0963c2`.

A bounded recheck found no source-coupling placement or value error. C275 (10µF)
is between IC25 YCOM and SND1, before R409 (47kΩ) / R410 (1kΩ). C274 (10µF) similarly
precedes SND2, whose Ring-mode load is R391 (100kΩ) in parallel with the 100kΩ
inverting and 200kΩ divider paths. C271 (10µF) precedes RTN and R407 (100kΩ). The weak
b/2 feedback through R408 (1MΩ) has the implemented sign. VCO1's mixer level does
not disconnect this pre-VCA ring source.

The OS 2.00 main shape sender at 0x94a8, voice depth handler0x845c, shape lookup
at 0x9700, shape setter0x483a and ISR0x423c give:

```text
at note start: signedShape = 1023*8 + (138-512)*16 = 2200
pulse U = 4096 + (4096*(2200&8191)>>13) = 5196
at completed OneShot: signedShape = 8184; pulse U = 8188
```

U 8188 exceeds the endpoint threshold 8176. IC17D's TRI_RAW input is on+ and
CV_PW on-; the endpoint therefore produces the modeled positive constant
pulse polarity. The slow/OneShot rate LUT at main0x2081c yields F 17553;
voice0x4a7a reconstructs phase increment 35106. The 40kHz LFO update and endpoint
phase 0x80000000 give a 1.529285-second OneShot. The saw starts positive and
falls to zero; negative intensity narrows the initial pulse relative to rest.

Consequently, a long-rest C275 charge followed by an asymmetric pulse transient
is consistent with the circuit and recovered controls. It was not removed to
improve String Hold. The comparator swing (nominal+/-3.5V before attenuation),
actual diode curve, downstream VCA/drive response, unit calibration, recording
firmware version and actual prehistory remain unresolved. The paired sources
support the intended settings but do not measure those analog quantities.

## Final native/analysis output parity

A same-source standalone build with and without the analysis feature produced
bit-identical 368,640 f32 values across all four output ports, using final
`product` defaults and the free-triangle correction. Cases covered 48/96 kHz
sync and ring, live mode/wave changes, midstream 24/48 kHz changes and nonfinite
pitch/bend inputs. All outputs remained finite. Output SHA256:
`4b7ba2cb8af5481129896bed5da63860404126cd0339a10fc91db9b802156e39`.

Source hashes and exact scope are retained in
[native-analysis-parity.json](../Tools/monologue/v3/ring/native-analysis-parity.json).
The source stayed unchanged throughout both compilations. This establishes
standalone default-path parity; it does not measure the native app binary,
callback scheduling, hardware fidelity or physical latency.

## Physical uncertainty and frequency limits

The table is accurate to the declared circuit model. Hardware accuracy is
limited by unknown diode identity/temperature/matching,1% resistor variation,
op-amp offsets/bandwidth/rail behavior and the coupling-cap tolerances. Shifting
the assumed diode forward curve by±50mV changed output by up to.121V over the
nominal±1.21V input region, much larger than interpolation error. No diode or
resistor mismatch was invented to reproduce leakage in a recording.

This is a quasi-static diode model at the existing4× audio oversampling rate.
The representative diode datasheet specifies up to3pF capacitance at its
stated test condition and up to4ns reverse recovery;10k×3pF is30ns, suggesting
a several-MHz dynamic scale. The specified TL084CPT likewise has MHz-bandwidth
and fast-slew behavior under its documented conditions. These support a
quasi-static audible-band approximation, not exact modeling of switching
edges. Junction charge, op-amp finite dynamics, source-switch impedance and
parasitics are omitted. Oversampling controls digital aliasing; it does not
establish the accuracy of those omitted analog dynamics.
