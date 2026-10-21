# Korg monologue 2.00 firmware evidence

Analysis date: 2026-10-21. This is a firmware-informed reconstruction of the
instrument's controls plus a separately modeled analog audio path. The firmware
does **not** contain a complete PCM oscillator/filter implementation to translate.
The service schematic shows analog VCOs, VCF and VCA controlled by a voice MCU.

## Sources and identity

- [Official OS 2.00 updater page](https://www.korg.com/us/support/download/software/0/733/3529/), release 2019-06-28.
- [Official Windows updater ZIP](https://cdn.korg.com/us/support/download/files/7e0f07eb913f9ad4157396858e1f9813.zip).
- [Official MIDI implementation](https://cdn.korg.com/us/support/download/files/16ee9047b932f624ed640d98940ff798.txt), linked from [Korg's manual page](https://www.korg.com/us/support/download/manual/0/733/4231/).
- [Korg service manual, third-party scan](https://www.synthxl.com/wp-content/uploads/2021/10/KORG-MONOLOGUE-Service-Manual.pdf). Original schematic labels, rather than the mirror's prose, establish the hardware observations below.
- [Manufacturer FM3 timer reference](https://www.infineon.com/assets/row/public/documents/30/44/infineon-bit-microcontroller-fm3-family-peripheral-manual-timer-part-trm-v04-00-en-usermanual-en.pdf), document 002-04794 rev D, especially pages 256, 262 and 267.

`Tools/monologue/firmware/source-hashes.json` and `embedded-images.json` record
full SHA-256 digests and lengths. Important identities:

| Artifact | SHA-256 |
|---|---|
| Official ZIP, 1,065,543 bytes | `1756d1a72fa73992f49fa35c0c22c0aab41e007edc6ea002f85ec0c081ee2ea4` |
| VSB container, 262,400 bytes | `4658d88ec0b898d84e1078ce721151d89ff626e74758fb67226d685733b90f3d` |
| Main flash after 256-byte VSB header | `27ddc78d5076bd60145be952e91a0c3c048d016600343ee743a67fd8a32c60e6` |
| Decompressed voice flash, 38,912 bytes | `114755a9617d85efaf445dd14dabbbcc2c40ae9c91624ef1518681f55b77d577` |
| Decompressed panel flash, 50,656 bytes | `ad4b07fc51066102ee7743ffc0a99907c25a18932aac08c5ffd16c8f81e9c698` |

The main MCU is MB9BF324M, the voice MCU MB9BF121M (both ARM Cortex-M3), and
the panel MCU STM32F030 (Cortex-M0). Executable images, updater archives, manuals,
analysis databases and generated disassembly remain outside this repository.

## Extraction and REA provenance

The user requested the [REA skill](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md).
Skill version 44 and `rea-agents` 6.4.0 were used via CLI. No global MCP/client
configuration was changed. REA's archive inspection succeeded with Evidence ID
`ev_6d70d1e274dbc762481513aa754318bae884493bd25126e9bf3defa7f4e7cd51`.
The exact metadata is retained in `Tools/monologue/firmware/rea-provenance.json`.

The custom `SQEZ` container was resolved by examining main flash decoder
`0x1a7ec`. It contains an LH5 stream: 8 KiB dictionary, 510 literal/length
symbols, 14 position symbols, static Huffman trees. Its 14-byte header is magic,
little-endian compressed length, original length, and CRC16. Wrapping the
unchanged payload in an LHA level-0 header lets 7-Zip decode and verify it.

| Component | SQEZ header offset in main flash | Packed bytes | Unpacked bytes | CRC16 |
|---|---|---:|---:|---|
| Voice | `0x2b5fc` | 17,588 | 38,912 | `0x9da1` |
| Panel | `0x24f68` | 26,234 | 50,656 | `0x251b` |

The portable extractor verifies the input ZIP and output image hashes. Analysis
addresses below are raw flash offsets. The analysis-only ELF wrapper maps the
voice bytes unchanged at virtual address zero, sets Thumb entry `0x8f55`, and
declares RAM `0x1fffe000..0x20002000`; it is not a vendor executable format.

REA then successfully decompiled voice main `0x8f54` using Ghidra 12.1.4:
Evidence ID `ev_d4f9c4a184450f1b81ea3653441128b72bf87e5f44b24ee934e0c7be522f72aa`.
The ELF digest was
`4564e40eaab92f0686f6ec03a1d3dc2e171450d2b270bf8c82bcae59651195f0`.
Focused direct Ghidra headless queries and Capstone Thumb disassembly then traced
control handlers and their ISR consumers. These additional observations are not
separate REA Evidence records; the address ledger below makes them reproducible.

Ghidra's macOS ARM decompiler was built from the source bundled with its official
12.1.4 release. Java 24 and Node 22.22.2 were already present. A first native REA
attempt failed during sandbox-restricted process cleanup; the resolved attempt
completed with exit 0. CLI `DirectAnalysis.js` uses isolated sessions and
`withSessionCleanup`; successful completion closes the provider and removes its
temporary project. No persistent MCP native session or GUI was opened. The
separate saved headless project was closed after each command and retained only
in the local investigation workspace.

## Clock chain: derived from code and schematic

The voice schematic has its **own 4 MHz crystal**, X2, part
`RSD-04000F202000`, connected to MB9BF121M X0/X1. The block diagram's 72 MHz
label is not the runtime clock established by the firmware.

Voice initializer `0x4c88` programs PLL_CTL1=1 and PLL_CTL2=9, yielding a
40 MHz machine clock. At `0x4fb0`, Base Timer 1 has PCSR=499 and TMCR=`0x110`.
Its count-clock selection is zero, hence the machine clock; PWM underflow occurs
once per 500 clocks. The ISR clears bit 0 of `0x40025050` through bit-band
`0x424a0a00`; bit-band `0x424a0a10` controls interrupt enable bit 4.
Thus the ISR is **80 kHz**. ISR `0x423c` alternates amp processing with LFO and
modulation-EG processing, so each runs at **40 kHz**.

Confidence is high for this static derivation. It has not been checked using a
physical instrument or oscilloscope. The early tentative 20 kHz EG estimate was
superseded once the timer registers were traced.

## Envelope control laws

Main `0x16e60`, `0x1702a`, and `0x16ef4` configure two envelopes, not one shared
ADSR. Raw modes are Gate=0, AGD=1, AD=2.

| Mode | Amp envelope | Modulation envelope |
|---|---|---|
| Gate | Attack=0, decay=0, sustain maximum | Actual attack/decay, sustain zero |
| AGD | Actual attack/decay, sustain maximum | Actual attack/decay, sustain maximum |
| AD | Actual attack/decay, sustain zero | Actual attack/decay, sustain zero |

Gate plus decay raw1023 is special: only the modulation decay/release gets the
1024 sentinel, producing increment zero and holding after attack indefinitely.

For raw knob `r` in 0..1023:

```text
attack t = r * 1536
decay/release t = floor(r * 2097151 / 1024)
d = floor(t*t / 8388608)
attack_increment = 2 * floor(0xffffffff / (d + 160))
decay_release_increment = 2 * floor(0xffffffff / (d + 240))
```

These are unsigned 32-bit phase increments at 40 kHz. Main encoders are at
`0x92a0`, `0x92ae`, `0x92ce`, `0x92dc`; voice handlers at `0x6050`, `0x6064`,
`0x60aa`, `0x60be`, with multiply helper `0x4104`. Decay changes also set the
corresponding release increment.

The modulation attack is `1-(1-p)^2`. Decay is `S+(1-S)*q^2`, where `q` falls
from one to zero. Release is `captured_level*q^2`; note-off preserves the current
level and does not restart an attack. The maximum sustain encoded by the public
knob protocol is slightly below one due to integer scaling. Decay phase keeps
advancing during AGD, and both envelopes remain in the decay state at its
endpoint until note-off. Changing AD/AGD while holding a key therefore changes
the sustain contribution using the elapsed phase; it does not restart decay.

The amp has a calibration floor `f=0x3c098dea/2^32≈0.23452`. Note-on (`0x4708`)
starts internal `p=0`; a precharge state advances by `1/64` per tick to `f`.
Attack then advances linearly from `f` to one. Decay uses
`p=1-depth*(1-(1-progress)^2)`, with `depth=(1-f)*(1-S)`.
Note-off (`0x49bc`) changes to release without resetting the current internal
level: `p=f+(capturedP-f)*q^2`. After release, a final mute state decreases the
internal level to zero. Its decrement is set by voice `0x6050` from the attack
control: `1/64` per tick for attack raw0..20, decreasing to `1/128` at raw200,
then staying `1/128`. For encoded attack `t` between `0x7800` and `0x4b000`,
the unsigned decrement is
`0x04000000-floor(((((t-0x7800)>>8)<<17)/0x438))*256`.
The precharge increment remains fixed at `1/64`. The VCA control conversion squares
`p`, includes further velocity/calibration processing, and converts it to PWM.
This is **not** proof that audio amplitude is exactly `p^2` or `p^4`; the analog
VCA's CV-to-gain transfer is a separate model assumption.

## LFO control laws and note synchronization

Main `0x9314` uses the 129-word table at `0x2081c` for both Slow and One Shot.
`extract_controls.py` extracts the exact knots and implements interpolation.
For `i=r>>3`, `f=r&7`, first calculate
`F=floor((table[i]+floor(f*(table[i+1]-table[i])/8))/80)`.

Fast mode uses four linear segments in integer control space:

```text
r < 256: z = (r * 0x1b62) >> 8
r < 512: z = ((r-256) * 0x419e >> 8) + 0x1b62
r < 768: z = ((r-512) * 0x2a300 >> 8) + 0x5d00
otherwise: z = ((r-768) * 0x2a0000 >> 8) + 0x30000
F = ((z+500) * 0xd1b7) >> 10
```

Both paths send `max(F-536,1)`; voice `0x4a7a` converts it to phase increment
`2*packed+1072`. Frequency is `increment*40000/2^32`.
Slow raw321 is 0.944733620 Hz; fast raw1023 is 2869.983390 Hz.

One Shot stops at phase `0x80000000`, **half** a full cycle, and then outputs zero.
The positive saw lobe goes +1 to zero; triangle goes zero to +1 to zero; square
holds +1 then stops. At raw321 the one-shot lasts 0.529249716 seconds.

Mode handler `0x9418` sets a note-control flag via `0xd018` to `mode!=Slow`.
Note-on reads it at `0xcd20`, queues a sync event via `0x8f60`; voice reset
`0x4a52` clears phase and marks active. The voice also honors note-command sync
bit4 at `0x7e14`. Default behavior is therefore Slow free-running, Fast/One Shot
retriggered. The public patch format has no independent key-sync bit; any extra
key-sync UI is an application extension.

## Shape CV table and a consequential folding rule

Voice `0x9700` contains signed 16-bit base/slope pairs: three oscillator waves,
two choices, and four piecewise segments. Selector `0x7e58` and LFO handler
`0x84a8` use the alternate choice when the **LFO waveform is not square**.
Shape input is base rawshape shifted left three plus signed modulation.
LFO shape depth is `(rawint*8-4096)*4` before signed high-word multiplication
by the bipolar LFO; approximately:

```text
x = rawshape/1024 + 2*(rawint-512)/1024 * lfo_bipolar
```

Do not clamp this sum to 0..1 before the table. For the relevant domain:

| VCO wave | LFO square | LFO triangle/saw |
|---|---|---|
| Pulse | CV=clamp((1+x)/2,0,1) | Same |
| Triangle | CV=0.28125*clamp(x,0,1) | Reflect negative x; rise to x=1, fall to zero at x=2 |
| Saw | CV=0.5*clamp(x,0,2) | CV=0.5*min(abs(x),2) |

The triangle alternate choice also outputs zero for x≥2. The saw can use twice
the positive unmodulated control range. This explains why negative saw LFO
modulation on a low-shape saw patch can create substantial shaping immediately,
instead of remaining pinned at zero. Firmware then applies device calibration
and clamps small CV endpoint regions (`0x483a`). The table determines CV, not the
analog oscillator's exact output waveform; the latter needs schematic analysis
and recording-based fitting.

For cutoff modulation, voice `0x845c` sets LFO depth to `(rawint*8-4096)*2`;
the signed high-word multiply followed by the ISR's scale of eight spans roughly
±32768 in the 0..65535 cutoff-control domain. This establishes the control span,
not a specific number of octaves without the analog cutoff mapping.

## Patch data and remaining boundaries

The official 448-byte program map is usable, with one documented inconsistency:
main Table2 has high bytes EG INT=26, LFO RATE=27, LFO INT=28. The later Note P1
summary rotates those labels incorrectly. Public patches plus screenshots
corroborate Table2; use it when parsing. Wave enums are square/triangle/saw=0/1/2
(VCO2 enum0 is noise); sync/ring is ring/off/sync=0/1/2.

The second analysis found that MIDI noteP2 labels intermediate pitch values as
cents, while the executed main0x9018/0x9172 path uses256 units per semitone.
For example raw550 is7.8125 cents, not20 cents. See
[the analog and control follow-up](monologue-analog-evidence.md) for this
correction, the oscillator octave convention, calibrated shape thresholds,
cutoff law, and modulation depths. This report establishes extraction, MCU
identity, EG modes and curves, timing, LFO rates and shape-control folding.

**Partial or unresolved:** physical VCO waveform transfer, VCF cutoff/resonance
and nonlinear response, drive transfer, per-unit calibration, exact glide law,
full sequencer/retrigger corner cases, and physical end-to-end latency. The
sample corpus is useful calibration evidence but is not a substitute for a
complete instrument test. Static decompilation did not observe hardware
execution. No claim of full firmware emulation or hardware-perfect audio is made.
