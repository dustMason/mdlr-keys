"""Extract measured control data from the unmodified monologue 2.00 images.

Run extract_sqez.py first. All addresses here are file/flash offsets, not claims
about an analog audio transfer function. No vendor executable is redistributed.
"""
import argparse
import hashlib
import json
import struct
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path, help="directory produced by extract_firmware.py")
ROOT = parser.parse_args().directory
main = (ROOT / "monologue_0200.bin").read_bytes()
voice = (ROOT / "voice.bin").read_bytes()
slow = list(struct.unpack_from("<129I", main, 0x2081C))
shape = list(struct.unpack_from("<48h", voice, 0x9700))


def lfo_step(raw, fast=False):
    if fast:
        if raw < 256:
            z = (raw * 0x1B62) >> 8
        elif raw < 512:
            z = (((raw - 256) * 0x419E) >> 8) + 0x1B62
        elif raw < 768:
            z = (((raw - 512) * 0x2A300) >> 8) + 0x5D00
        else:
            z = (((raw - 768) * 0x2A0000) >> 8) + 0x30000
        f = ((z + 500) * 0xD1B7) >> 10
    else:
        i, frac = divmod(raw, 8)
        f = (slow[i] + ((frac * (slow[i + 1] - slow[i])) >> 3)) // 80
    return 2 * max(f - 536, 1) + 1072


def eg_increment(raw, attack=False):
    t = raw * 1536 if attack else (raw * 2097151) >> 10
    d = (t * t) >> 23
    return 2 * (0xFFFFFFFF // (d + (160 if attack else 240)))


evidence = {
    "model": "Korg monologue",
    "os_version": "2.00",
    "images": {
        "main": {"path": "monologue_0200.bin", "sha256": hashlib.sha256(main).hexdigest()},
        "voice": {"path": "voice.bin", "sha256": hashlib.sha256(voice).hexdigest()},
    },
    "clock": {
        "external_crystal_hz": 4000000,
        "cpu_hz": 40000000,
        "control_interrupt_hz": 80000,
        "amp_tick_hz": 40000,
        "mod_eg_lfo_tick_hz": 40000,
        "evidence": ["service manual schematic p6 X2/RSD-04000F202000", "voice 0x4c88 PLL_CTL1=1 PLL_CTL2=9", "voice 0x4fb0 BT1 PCSR=499 TMCR=0x110", "voice ISR0x423c alternates amp vs mod/LFO"],
        "confidence": "high, static derivation; no physical scope measurement",
    },
    "envelope": {
        "raw_mode": {"0": "gate", "1": "AGD", "2": "AD"},
        "time_input_raw_range": [0, 1023],
        "attack_encoded_t": "raw*1536",
        "decay_release_encoded_t": "floor(raw*2097151/1024)",
        "increment": "2*floor(0xffffffff/(floor(t*t/8388608)+offset))",
        "attack_offset": 160,
        "decay_release_offset": 240,
        "gate_max_decay": "raw1023 becomes sentinel1024 for modulation EG only, increment0/infinite hold",
        "amp_floor_u32": 0x3C098DEA,
        "amp_precharge_step_u32": 0x04000000,
        "amp_final_mute_step_u32": {
            "encoded_attack_t": "raw_attack*1536",
            "t_le_0x7800": 0x04000000,
            "t_ge_0x4b000": 0x02000000,
            "middle": "0x04000000-floor(((((t-0x7800)>>8)<<17)/0x438))*256",
            "voice_offset": "0x6050",
        },
        "mod_attack_curve": "1-(1-phase)^2",
        "mod_decay_curve": "sustain+(1-sustain)*remaining_phase^2",
        "mod_release_curve": "captured_current_level*remaining_phase^2",
        "amp_attack": "precharge0 tofloor at1/64 per tick, then linear internal phase floor to1; CV squares internalphase",
        "amp_decay": "p=1-depth*(1-(1-progress)^2), depth=(1-floor)*(1-sustain); CV squares p",
        "amp_release": "p=floor+(capturedP-floor)*remaining_phase^2; CV squares p",
        "warning": "Firmware outputs analog VCA control, not PCM amplitude. Analog conversion from CV remains a modeling/calibration question.",
        "main_offsets": ["0x16e60", "0x1702a", "0x16ef4", "0x92a0", "0x92ae", "0x92ce", "0x92dc"],
        "voice_offsets": ["0x4708", "0x49bc", "0x423c", "0x6050", "0x6064", "0x60aa", "0x60be"],
    },
    "lfo": {
        "raw_mode": {"0": "one_shot", "1": "slow", "2": "fast"},
        "raw_wave": {"0": "square", "1": "triangle", "2": "saw"},
        "slow_and_one_shot_lut_offset": "main0x2081c",
        "slow_and_one_shot_u32_knots": slow,
        "slow_interpolation": "i=raw>>3; f=raw&7; F=(lut[i]+((f*(lut[i+1]-lut[i]))>>3))/80 integer",
        "fast_formula": "see lfo_step() in extract_controls.py; main0x9314",
        "voice_phase_increment": "2*max(F-536,1)+1072",
        "frequency_hz": "phase_increment*40000/4294967296",
        "one_shot_end_phase": "0x80000000, half of a cycle, then output0/inactive",
        "one_shot_shapes": {"saw": "+1 to0", "triangle": "0 to+1 to0", "square": "+1 hold then0"},
        "default_note_sync": {"slow": False, "fast": True, "one_shot": True},
        "note_sync_evidence": ["main0x9418 sets mode!=slow via0xd018", "main noteon0xcd20 uses flag", "voice0x7e14/0x86e6 call phase reset0x4a52"],
        "examples": [{"raw": r, "slow_hz": lfo_step(r)*40000/2**32, "fast_hz": lfo_step(r, True)*40000/2**32, "oneshot_seconds": 2**31/lfo_step(r)/40000} for r in [0,128,256,321,512,768,1023]],
    },
    "shape_cv": {
        "offset": "voice0x9700",
        "int16_pairs": shape,
        "layout": "3 waves * 2 choices * 4 (base,slope) pairs, each signed16",
        "choice": "regular if LFOwave==square, alternate otherwise",
        "pair_select": "((signedShape>>13)+1), range -8192..24575",
        "interpolation": "base + ((slope*(signedShape&8191))>>13)",
        "input_scaling": "signedShape=(rawshape<<3)+high32(((rawint<<3)-4096)*4 * bipolarLfoI32)",
        "normalized_sum": "x=rawshape/1024+2*(rawint-512)/1024*lfo_bipolar",
        "notable_behavior": "alternate saw and triangle reflect negative shape excursions; triangle folds down from x1..2, while saw continues through x2; do not clamp signed summed shape to0..1",
        "warning": "Shape CV is not the analog waveform; physical VCO output transfer remains to be modeled/fitted.",
        "voice_offsets": ["0x7e58", "0x84a8", "0x483a", "ISR0x423c"],
    },
    "lfo_cutoff_scaling": {"voice_offset": "0x845c", "formula": "cutoffDepth=(rawint*8-4096)*2; cutoffMod=high32(cutoffDepth*bipolarLfoI32)*8", "range": "approximately +/-32768 in a0..65535 cutoff control domain; cutoff-Hz transfer not established"},
    "confidence": "High for integer control laws and state transitions; no claim of complete analog audio equivalence.",
}

(ROOT / "control-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
print(json.dumps({"output": str(ROOT / "control-evidence.json"), "lfo_examples": evidence["lfo"]["examples"]}, indent=2))
