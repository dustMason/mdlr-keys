# Monologue analog and control corrections, second analysis

Analysis date: 2026-10-21. The input firmware is the same verified official
2.00 main/voice image documented in `docs/monologue-firmware-evidence.md`.
This follow-up reuses the saved Ghidra 12.1.4 project and REA workflow. A new
isolated REA6.4.0 `decompile .../voice-analysis.elf 0x66bc --provider ghidra
--format json` query completed successfully with Evidence ID
`ev_8971f86f7622e3cc7a87d13bceec47dce53bf6df909aa6a81a83397235e3ee46`.
Its ELF SHA-256 was
`4564e40eaab92f0686f6ec03a1d3dc2e171450d2b270bf8c82bcae59651195f0`.
The result establishes the pitch-converter instructions and agrees with the
saved project. REA closed its temporary native session on exit; no GUI or
persistent native session was opened. Other direct Ghidra/Capstone queries do
not have separate REA Evidence IDs.
No vendor binaries, schematic scans or generated decompilation are committed.

## Sources and evidence types

- [Korg service schematic, third-party-hosted original scan](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf), PDF pages6–8, KLM-3621 sheets3–5.
- [Official owner manual](https://cdn.korg.com/us/support/download/files/0ed33bb02a3ce4cc3ec976f0378a996e.pdf), printed page16: wave-shape drawings.
- Main flash addresses `0x9018`, `0x9068`, `0x9172`, `0x9244`, `0xcc38`;
  voice addresses `0x483a`, `0x4ae0`, `0x520c`, `0x66bc`, `0x7210`,
  `0x7290`, `0x7740`, `0x7778`, `0x7e58`, `0x81a4`, ISR `0x423c`.
- Public paired patch recordings provide a separate observational cross-check:
  stored sequence notes in S0S/Harpie are one octave above the previously
  estimated lowest audio fundamental. This is consistent with the circuit,
  rather than an undocumented transpose to bake into the patch importer.

The integer control equations below are checked against instructions. Analog
equations are ideal circuit reductions, with explicitly stated approximations.
No live hardware execution or scope capture was performed.

## Oscillator phase and saw shaping

The saw is not a crossfade between an ordinary saw and a periodic wavefolder.
The core ramp is buffered by IC17B and inverted by IC17C. Those two signals
feed both X and Y sections of the CD74HC4053 IC16 (IC8B/IC8C/IC7 for VCO2).
The discrete divider controls X, alternating ramp polarity on successive ramp
cycles to generate `TRI_RAW`. Therefore the raw ramp has twice the triangle's
frequency. The Y section selects either ramp polarity according to IC17D's
comparison of `TRI_RAW` and `CV_PW`; Y is the saw audio output.

This explains the owner manual's five unshaped saw cycles versus two and a half
triangle cycles in the same drawing width, and the lower periodicity introduced
by saw shaping. It also provides a structural explanation for Harpie's dominant
second harmonic: a nearly unshaped raw saw remains strong at twice the divider
frequency, while shaping creates the lower fundamental.

For a triangle/divider phase `p` in0..1, an ideal circuit representation is:

```text
ramp = 2*fract(2*p)-1
triangle = p<0.5 ? ramp : -ramp
saw = triangle>threshold ? -ramp : ramp
```

The branch signs follow X0/Y0 taking the buffered ramp and X1/Y1 its inversion;
absolute phase relative to an externally recorded note has not been measured.
Oscillators free-run. The full circuit's reset transient and component offsets
are still approximations. Anti-aliasing must include both ramp resets and the
comparator's switching discontinuities, including cases where the two coincide.

Main `0x9172` sets oscillator pitch offset to
`(rawOctave-2)*0xc00 + pitchUnits`. Public raw octaves0/1/2/3 are16'/8'/4'/2'.
There are3072 units per octave. Hence with8', the divider/triangle phase is
one octave below the incoming MIDI note; an unshaped saw is at the incoming
MIDI note. The wave selection path at voice `0x7e58` does not compensate pitch;
the legacy helper it calls at `0x7940` is a no-op.

## Calibration sets PWM span, but the physical excursion is frequency dependent

This section supersedes the earlier inference that calibration endpoints equal
the full low-frequency triangle peak. The integer PWM coefficients are exact;
the conversion from those coefficients to a low-note comparator threshold needs
an analog calibration-excursion factor.

Voice `0x7210`/`0x7290` search the comparator's two pulse-producing endpoints.
One search starts at PWM compare 249 and decreases; the other starts at 1 and
increases. Each accepts an endpoint after observing at least five `INT_VCO`
edges during its measurement. Crucially, `0x7210` calls `0x71bc` with pitch
`0x7240`, or Q8 MIDI 114.25: approximately **6006.018 Hz**.

This is the triangle/divider frequency. The circuit routes IC17D/IC8D's
`TRI_RAW` comparator to `INT_VCO1/2`. IRQ setup `0x6da6` writes
`ELVR=0x0a002080`, `ELVR1=0x800`; the channel table at `0x9258` selects
channels 3, 21 and 6. All three are configured for rising edges only. The
[FM3 peripheral manual](https://www.infineon.com/assets/row/public/documents/30/44/infineon-32-bit-microcontroller-fm3-family-peripheral-manual-main-part-usermanual-en.pdf),
chapter 8 section 4.4, defines mode `10` as rising edge. ISR `0x6c78` measures
successive timestamps. Pitch converter `0x66bc` uses Q8 note 21 with reference
period `32*45454` at 40 MHz (approximately 27.5 Hz), confirming one captured
period per divider cycle, not a hidden extra octave or both-edge capture.

Let `low`, `high` be the accepted PWM compare endpoints and `span=high-low`.
At `0x7740`, calibration stores:

```text
offsetQ16 = low*65536 - span*0x2960
slope = span*0x14b
pwmQ16 = offsetQ16 + (slope*U >> 5)  // normal path at 0x483a
```

With the descending CV-to-threshold polarity, ignoring comparator offset and
endpoint quantization, define `alpha` as the accepted calibration excursion
divided by the low-frequency raw triangle peak. The resulting approximation is:

```text
threshold / lowFrequencyTrianglePeak = alpha * (1.3232421875 - 2.5859375*(U/8192))
```

The saw LUT has `U=4096*x`, with `x` in 0..2, so its threshold is
`alpha*(1.3232421875-1.29296875*x)`. Setting `alpha=1` falsely turns a
calibration assumption into a fixed quarter-knob saw dead zone. It is not
established hardware behavior.

`TRI_RAW` reaches the calibration comparator after the 180 ohm / 47 nF RC and
CD74HC4053 switch. For a continuous triangle followed by one pole, the maximum
is delayed after the input corner. Its peak ratio is:

```text
tau = (180 + switchRon) * 47e-9
d = 6006.017848239854 * tau
alphaRC = 1 - 4*d*ln(2 / (1 + exp(-0.5/d)))
```

This gives 0.85913 for zero switch resistance, 0.82790 for 40 ohms,
0.78142 for 100 ohms and 0.75853 for 130 ohms. The
[TI CD74HC4053 datasheet](https://www.ti.com/lit/ds/symlink/cd74hc4053.pdf)
specifies full-signal-range resistance of 45 ohms typical and 130 ohms maximum
at 25 C with +/-4.5 V supplies; rail tests are 40/120 ohms. The synth uses
+/-5 V. A common training-only `shape_calibration_peak` range **0.78..0.88**
therefore has a circuit basis, but is a bounded fitting interval, not a complete
component-tolerance guarantee. The default 0.84 is a model estimate, not a
recovered literal. Capacitor tolerance, op-amp loading, comparator recovery,
PWM endpoint quantization and unit calibration remain unmeasured. The MCU's
minimum detectable pulse is three peripheral clocks; this alone does not
establish a large additional excursion loss.

The firmware treats endpoint values separately: `U<16` and `U>=8176` load
extended PWM limits. At `0x7744..0x7778`, these extend beyond the accepted
span and are clipped to compare values 1..249. Within the chosen alpha range,
they put the ideal comparator beyond both waveform peaks. Thus the endpoint
model should explicitly select the pure raw/inverted saw, unfolded triangle,
or constant pulse polarity. Scaling the usual threshold by alpha alone can
incorrectly leave a thin pulse at the full pulse-shape endpoint.

## Full LFO-to-shape chain re-audit

Main `0x94a8` supplies `rawIntensity<<3` to the shape field when target is shape,
with neutral 4096 for the unused cutoff field. Voice `0x845c` subtracts 4096,
then multiplies the shape field by four. The ISR's signed high-word multiply
against its bipolar LFO yields, before LUT folding:

```text
signedShape = (rawShape << 3) + ((rawIntensity - 512) * 16 * lfo)
x = rawShape/1024 + ((rawIntensity - 512)/512) * lfo
```

Here `lfo` is normalized to +/-1; actual firmware arithmetic is integer.
The alternate saw table maps `U=4096*min(abs(x),2)`. Harpie's shape 52 and
intensity 227 give `signedShape=416-4560=-4144` at the positive one-shot saw
start, or x=-0.505859375. The main rate table yields F=50720 for raw rate 321;
voice `0x4a7a` reconstructs phase increment 101440. At 40 kHz this is
0.944733620 Hz, with one-shot stopping after half a cycle at 0.529249716 s.
These arithmetic, polarity and timing checks found no missing factor of two.
The large early loss of the lower harmonic must not be repaired by silently
changing these recovered laws.

### Final bounded check of LFO timing

A temporal residual in the Harpie recording motivated a fresh instruction-level
check for an extra update divider or a distinct one-shot saw equation. Neither
was found. At `0x43b6..0x43be`, one byte toggles on each 80 kHz ISR; alternate
visits enter the LFO path at `0x44da`. The phase loads and additions at
`0x44e4..0x452e` have no further alternate-tick gate. Handler `0x4a7a` stores
`2*packed+1072` directly as the increment.

The saw branch at `0x450a` computes `0x7fffffff XOR phase`, interpreted as a
signed value. Normalization by 2^31 gives `1-2*phase`, including in One Shot.
Mode handler `0x84c4` extracts the one-shot bit; `0x4532` tests carry after
adding that bit shifted by 31. The output becomes zero and the LFO deactivates
at phase 0x80000000. The binary therefore does not support halving the update
rate or replacing the one-shot waveform with `1-phase`.

The recording's slower apparent shape evolution remains an unresolved audio
residual, not evidence overriding these instructions. No fitted timing change
was made. The firmware version of that older public recording is unverified;
this report's verified executable is OS 2.00.

## LFO pitch intensity uses a separate nonlinear encoder

The final control-law audit found that pitch-target LFO intensity does not use
the linear bipolar depth of the shape and cutoff targets. Main `0x94a8` calls
`0x90bc` for the pitch target, then sends that result as the pitch field through
`0x8b64`. For raw intensity `r` in 0..1023, define:

```text
z = 2*abs(r-512)
if z < 384:       magnitude = floor(z*512/384)
else if z < 768:  magnitude = 512 + floor((z-384)*2560/384)
else if z < 896:  magnitude = 3072 + ((z-768)*4608 >> 7)
else:             magnitude = 6144 + ((z-896)*13824 >> 7)
encodedPitch = r < 512 ? -magnitude : magnitude
```

Voice `0x845c` doubles the encoded pitch and passes it to `0x4a88`. The ISR's
signed high-word multiplication against the bipolar LFO, followed by direct
addition to the oscillator's Q8 pitch, gives approximately:

```text
pitchOffsetSemitones = unitLfoWaveform * encodedPitch / 256
```

Use the unit waveform here, before the linear intensity scaling used by shape
and cutoff. Replacing this with `linearIntensity*24` is not equivalent. The
integer encoder has no center dead zone beyond the exact zero at raw 512.

| Raw intensity | Encoded Q8 pitch | Peak semitones |
|---:|---:|---:|
| 0 | -19968 | -78 |
| 511 | -2 | -0.0078125 |
| 512 | 0 | 0 |
| 513 | 2 | 0.0078125 |
| 550 | 101 | 0.39453125 |
| 704 | 512 | 2 |
| 896 | 3072 | 12 |
| 959 | 7608 | 29.71875 |
| 960 | 6144 | 24 |
| 1023 | 19752 | 77.15625 |

The **959 to 960 decrease is present in the firmware**, not a rounding error:
the third branch approaches 7680, while the fourth starts at 6144. Capstone
Thumb instructions and a fresh Ghidra decompilation independently confirmed
the constants and branch conditions. Preserve this discontinuity rather than
regularizing the curve. The negative side mirrors the encoded magnitude;
asymmetric endpoints follow from the raw range containing 512 negative steps
and 511 positive steps.

Evidence is saved locally as `hardware/decompiled-main/90bc.c` and
`hardware/ghidra-lfo-depth.log` in the analysis workspace. This was a direct
headless Ghidra query against the verified main image, not an additional REA
Evidence ID. No proprietary disassembly or executable bytes are included here.

## Triangle is a single threshold fold

IC20A/IC20C implement opposite precision-rectifier branches, each with1k input
and2.7k feedback resistors. IC20B inverts the threshold for the second branch.
IC20D sums the raw triangle and both branches through100k resistors with220k
feedback. To first order, after removing the common output polarity/gain:

```text
y = t - 2.7*sign(t)*max(abs(t)-threshold,0)
```

This is a single threshold fold with an outer slope of−1.7. It is not an
arbitrary periodic fold with an increasing drive gain. The triangle LUT uses
`U=2304*x`, so its calibrated threshold is approximately
`alpha*(1.3232421875-0.727294921875*x)`, using the same calibration excursion
as the saw and pulse. For x approximately 0.666 and alpha=0.84, the threshold
is approximately 0.705. The rectifier topology is supported by the schematic;
its exact effective threshold remains subject to the calibration approximation.
Finite100k load on the2.7k branch modifies the ideal threshold/gain by a few
percent; op-amp/diode nonidealities have not been solved as a transistor model.

Both raw triangle and saw outputs have180Ω/.047µF RC sections (about18.8kHz).
The2kHz annotation on the FX schematic belongs to the metronome PWM filter,
not the dry synth audio path; it does not justify adding a2kHz audio low-pass.

## Fine pitch units and EG depth

Main `0x9018` is the actual fine-pitch conversion. For
`d=abs(raw-512)`, calculate the unsigned magnitude:

```text
d<20: 0
d<36: d-20
d<156: 2*d-56
d<508: 8*d-992
otherwise: 3072
```

Apply the sign of `raw-512`. These are256 units per semitone, not cents.
Thus raw550 is20 units =7.8125 cents. The public MIDI noteP2 labels intermediate
numbers as cents, which disagrees with this executed path and the explicit
3072-units-per-octave addition. The prior report's claim that the MIDI pitch
chart directly established the cents law is superseded here.

Pitch EG uses four times this signed conversion (`0x9244`), and voice `0x4ae0`
multiplies it by the modulation envelope. Its maximum is48 semitones, with the
same deadband/piecewise mapping rather than a linear intensity knob.

For cutoff EG, main `0x9068` instead uses:

```text
d = min(max(abs(raw-512)-20,0),481)
m = (d*d*0x1221) >> 18
encoded = 4096 + sign(raw-512)*m
```

Voice `0x81a4` sets depth `(encoded-4096)*32`; ISR signed multiplication by
`envQ32>>1` yields normalized cutoff-control delta approximately
`sign(raw-512)*m/4096 * envelope`. Harpie raw675 gives362/4096≈0.08838,
not a linear0.318 intensity multiplied by an assumed six octaves.

## Cutoff table, note tracking and velocity

The self-oscillation calibration at voice `0x7290` builds257 cutoff PWM knots
against target pitch `q8=0xf00+floor(index*0x7800/257)`. Pitch converter
`0x66bc` starts at MIDI21 (`0x1500`) and advances by `0xc00` per octave.
The reference period value45454 at voice `0x9264` agrees with
40MHz/(27.5Hz*32), independently checking this pitch scale.

Nominal cutoff knots therefore span:

| Index | MIDI pitch | Frequency |
|---:|---:|---:|
|0|15|19.445436Hz|
|128|74.765625|613.886640Hz|
|256|134.53125|19380.218468Hz|

ISR `0x423c` interpolates this device-calibrated PWM table using a16-bit cutoff
control. A software model can use the corresponding exponential pitch law as
its nominal mapping. The real nonlinear filter response under audio drive and
resonance is distinct from its self-oscillation calibration frequency.

Main note handler `0xcc38` computes cutoff key/velocity offsets in13-bit
control units before sending the note:

```text
velocityOffset = (MIDIvelocity-80)*velocityEnum*16
trackOffset = 0 if trackEnum=0
            = trunc((note-60)*6*0x334/0x90) if trackEnum=1
            = trunc((note-60)*12*0x334/0x90) if trackEnum=2
noteOffset = clamp(velocityOffset+trackOffset,-4096,4096)
base = clamp(floor(rawCutoff*8192/1023)+noteOffset,0,8191)*8
finalCutoff = clamp(base + EGdelta + LFOdelta,0,65535)
```

Here note is incoming key plus keyboard transpose, before per-VCO octave,
fine tuning and waveform conversion. The reference note is60, and velocity
reference is80, so higher velocity can raise cutoff. EG/LFO are added after
the base-plus-note-offset saturation, which matters near the endpoints.

## Waveform output levels and RC placement

A second pass through sheet4 traced the complete path to each oscillator VCA.
The18.8kHz value is the nominal `1/(2*pi*180ohm*47nF)` corner, and is **not a
common filter after waveform selection**:

| Path | VCO1 components | VCO2 components | Placement |
| --- | --- | --- | --- |
| Raw triangle | R301/C216 | R225/C167 | After the X polarity switch; before triangle folding and the pulse comparator |
| Saw | R302/C217 | R226/C168 | After the Y polarity switch; before final waveform selection |
| Pulse | R306/R310 | R228/R229 | Comparator output through2.2k/150ohm divider; no47nF output capacitor |

Thus filtering the raw triangle also affects comparator edge timing, but its
regenerated pulse edges do not themselves pass through this RC. New harmonics
created by the subsequent triangle fold also bypass it. Modeling one shared
18.8kHz pole after all three final waveforms would place the pole incorrectly.
Switch on-resistance lowers the effective corner: TI specifies40ohm typical
at9V span for [CD74HC4053](https://www.ti.com/product/CD74HC4053), so adding40ohm
to180ohm gives an illustrative15.4kHz. This is not a measured monologue corner.

The schematic labels both TRI_RAW and SAW as1.1Vpp. The triangle summer has
R348=220k and R361=100k (VCO2 R251=220k/R250=100k), a nominal **inverting gain
of2.2** before the nonlinear branches contribute. The earlier dimensionless
triangle formula deliberately omitted this common gain; using saw peak1 as
reference, the actual ideal triangle output is
`-2.2*(t-2.7*sign(t)*max(abs(t)-threshold,0))`. At unshaped endpoints its
nominal peak-to-peak voltage is2.42V, versus saw1.1V. This is an amplitude
relationship from the components, not an RMS loudness equalization.

IC25 and IC26 select the final waveforms through0ohm input jumpers (VCO1
R144/R149/R167; VCO2 R145/R150/R169). There is no waveform-specific resistor
attenuation after the triangle summer. The waveform handler0x7e58 does not
apply a per-wave gain correction; its VCO2 special case switches to/from the
noise path. The voice mixer setter0x520c is independent of waveform.

Pulse amplitude is bounded but is not exactly determined by the passive
values. The divider factor is150/2350=0.063829787, making pulse relative
peak-to-peak level `(comparatorVoh-comparatorVol)*0.063829787/1.1` compared
with saw. Assuming comparator outputs at+/-3.5V gives0.40619 times saw, while
ideal+/-5V rails give an upper bound0.58027. The
[ST TL084 datasheet](https://www.st.com/resource/en/datasheet/tl084c.pdf)
specifies output swing with explicit load and supply conditions; the actual
monologue uses+/-5V and about2.35kohm load, so+/-3.5V must remain a modeling
assumption until measured, not a firmware-derived constant. The divisor is
checked directly in both VCO circuits.

A later differential amplifier inside each oscillator VCA has matched100k /
47pF feedback/filter components (VCO1 R414/C296 andR413/C295; VCO2 R411/C293
andR412/C294). Its ideal balanced differential transfer has a33.86kHz pole
and is common to the selected waveform. This small-signal reduction neglects
transistor output impedance, loading and component tolerances.

## Ring input sources and diode bridge

The RING input is not OSC_TR1, a fixed digital square wave, or an abstract
unit-amplitude carrier. SND1 taps the selected analog waveform at IC25 YCOM
pin15 after C275; SND2 taps IC26 YCOM pin15 after C274. Both are ahead of
the oscillator-level VCAs. Thus setting VCO1 mixer level to0 does not remove
the carrier, but changing its selected waveform, shape or physical amplitude
does affect it. RING_ON drives IC26 Z selector to replace the VCO2 VCA input
with RTN; it does not switch the ring diodes themselves.

IC24A/B/C and D29–D32 form an analog diode bridge. With `a=SND1`, `b=SND2`,
the three drive opamps give IC24A=`b-a`, IC24B=`b+a`, IC24C=`-b`.
R408/R405 are both1M; the other sum/difference resistors are100k. The four
ring corners, clockwise from upper-left, receive `(b-a,-b,b+a,-b)` through
10k resistors R406/R375/R403/R393. Diodes run clockwise around these corners.
IC24D is a differential amplifier with100k inputs and150k feedback/divider:
`RTN=1.5*(lowerLeft-upperRight)`, before C271 AC coupling.

A bounded ideal-opamp nodal model is therefore available without pretending
that diode physics is known. Let corners be `u,v,w,z`, let `D(x)` be forward
diode current at voltage `x`, and express voltages in volts/resistors in ohms:

```text
(u-(b-a))/10000 + D(u-v)-D(z-u) = 0
(v+b)/10000 + D(v-w)-D(u-v) + (v-0.6*z)/100000 = 0
(w-(b+a))/10000 + D(w-z)-D(v-w) = 0
(z+b)/10000 + D(z-u)-D(w-z) + z/250000 = 0
RTN = 1.5*(z-v)
```

The last terms include the output amplifier's loading. The schematic uses
only a generic diode designation, so diode saturation current, ideality,
capacitance and matching remain unmeasured. At the v2 export,
`work/monologue/accuracy-v2/hardware/ring_model.py` was an offline Newton-solver
prototype with those unknowns exposed; the native path still multiplied the
selected analog waveforms. That historical model preserved the input sources
but approximated the bridge transfer and loading.

The v3 analysis-only experiment solves these equations offline with an
explicitly assumed silicon characteristic and a 33,540-byte transfer table,
including asymmetric output loading and source/return coupling capacitors.
It was rejected for native adoption after a String Hold development regression,
including under identical 12-second resting-state conditions. Its actual diode
identity, comparator amplitude and recording prehistory remain unmeasured.
The final native path retains the selected-waveform product approximation.
Upstream triangle slope changes receive BLAMP correction before the existing
RC stage; the bridge, coupling and interval-averaged product remain analysis-only
experiments. Product averaging also failed to establish a useful alias benefit.
See [the ring model evidence](monologue-ring-evidence.md) for
the preserved comparisons, source recheck, voltage units, circuit assumptions,
numerical checks and reproducibility. Replacing VCO1 with an amplitude-independent
digital carrier would still contradict the circuit.

## Incoming MIDI CC expansion

The main MIDI byte parser at 0x18db0 dispatches incoming control changes to
0x19af8. Continuous parameters (type1 in the table at 0x241be) expand7-bit
values by bit replication, not by center snapping:

```text
raw10 = (value7 << 3) | ((value7 & 127) >> 4)
```

The table's index32 entry at 0x241fe is0x011a: continuous type1, CC26 (LFO
intensity). Therefore values63,64,127 produce raw507,516,1023 respectively.
Raw512 is not representable by this7-bit expansion. A small positive LFO
intensity at CC64 is hardware behavior; making64 exactlyzero would introduce
a mismatch. For bipolar intensity, the resultingnormalized value is
`(raw10-512)/512`, so CC64 gives0.0078125. For unsigned controls normalized
for the app's0..1023 raw range, use`raw10/1023`.

The same handler maps a switch withN positions as`min(N-1,(N*value7)>>7)`.
For N=3 its thresholds are43 and86; for N=4 they are32,64,96. This was
verified by the executed main handler and direct Capstone instructions;
saved decompilation is in`hardware/decompiled-main/19af8.c` in the analysis
workspace. These later direct Ghidra queries have no separate REA Evidence ID.

## Sync topology and finite pulse bounds

The sync source is the VCO1 divider, independently of its audible waveform,
shape, and mixer level. Q17's collector feeds IC16 A (pin 11), OSC_TR1 and
IC16 Z1 (pin 3). ZCOM (pin 4) is `SYNC_PH`; Z0 is unused and `SYNC_OFF` gates
Z through C (pin 9). This source is not the shape comparator on B (pin 10).
Changing VCO1 shape therefore does not alter the ideal sync trigger phase.

VCO2 has two reset paths. `SYNC_PH` passes C176 (100 pF), DT4 DTC114EUB and
DT15 DTA114EUB to drive IC7's Z control. Both digital transistors have internal
10k/10k bias resistors, confirmed by the
[ROHM DTC114EUB](https://www.rohm.com/products/transistors/digital-transistors/standard/dtc114eub-product)
and [DTA114EUB](https://www.rohm.com/products/transistors/digital-transistors/standard/dta114eub-product)
product data. The input high-pass time constant is approximately 1 us while
the base is clamped, or 2 us through both resistors while off. Transistor
storage and switch recovery add uncertainty; this is a timescale estimate,
not a measured hold time.

**C175 (2.2 nF) connects SYNC_OFF/DT15's emitter supply to ground. It is not
on the reset output.** R230 (47k) is the collector/output pull-down. Their
product, 103 us, must not be used as the raw-ramp reset duration.

The separate divider injection uses C204 (220 pF), D19 and two 470k bias
resistors R274/R255. Its unloaded bias decay is 51.7 us, but it drives the
bistable divider through a diode. That RC value does not establish a 51.7 us
audio hold. Resetting both ideal ramp and divider is justified; exact forced
polarity, transient duration and analog recovery still need scope measurements
or a validated transistor simulation. There is no evidence here for adding a
long reset hold solely to improve Harpie's harmonic metric.

## Remaining boundaries

Comparator output slew and recovery, RC phase delay before the saw comparator,
finite reset behavior and switch charge injection are still idealized. Native
RING retains the existing product approximation; interval averaging remains an
analysis-only experiment. The circuit-derived diode transfer and coupling stages remain analysis-only experiments described in
[the v3 ring evidence](monologue-ring-evidence.md); they regressed a development
recording and were not adopted. Diode identity/matching, comparator amplitude,
op-amp dynamics, component tolerances and actual recording prehistory remain
unmeasured.

Mixer control is linear in firmware: main maps raw level to 8192 and voice
`0x520c` maps it to a 500-count PWM compare. This does not establish a perfectly
linear analog VCA gain. The two channel circuits have matching nominal values;
there is no evidence here for baking a per-patch mixer correction into DSP.

VCF transistor/OTA nonlinear response, resonance gain, exact analog VCA gain,
drive transfer, per-unit calibration, and physical latency remain unresolved.
