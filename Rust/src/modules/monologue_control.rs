//! Host-rate integration of the recovered 40 kHz voice-controller laws.
//! Addresses refer to OS2.00 unpacked main/voice flash, see the evidence report.
pub const CONTROL_RATE: f64 = 40_000.0;
const Q32: f64 = 4_294_967_296.0;
const AMP_FLOOR: f64 = 0x3c098dea_u32 as f64 / Q32;

/// Main 0x90bc via 0x94a8; voice 0x845c applies this signed Q8 pitch depth.
/// The fourth branch really drops by six semitones at raw 960 (OS2.00).
pub fn lfo_pitch_semitones(raw: u16) -> f32 {
    let delta = raw.min(1023) as i32 - 512;
    let z = 2 * delta.abs();
    let magnitude = if z < 384 {
        z * 512 / 384
    } else if z < 768 {
        512 + (z - 384) * 2560 / 384
    } else if z < 896 {
        3072 + ((z - 768) * 4608 >> 7)
    } else {
        6144 + ((z - 896) * 13824 >> 7)
    };
    (magnitude * delta.signum()) as f32 / 256.0
}

/// Main 0x9068 and voice 0x81a4: signed quadratic depth, in full cutoff-CV ranges.
pub fn cutoff_eg_depth(raw: u16) -> f32 {
    let delta = raw.min(1023) as i32 - 512;
    let d = (delta.abs() - 20).clamp(0, 481);
    let magnitude = (d * d * 0x1221) >> 18;
    (magnitude * delta.signum()) as f32 / 4096.0
}

/// Main 0xcc9e..0xccec: note offset added to the 13-bit cutoff knob, then
/// clamped before the voice adds EG/LFO. Velocity is centered on MIDI 80.
pub fn cutoff_note_offset(note: u8, velocity: u8, tracking: u8, sensitivity: u8) -> i32 {
    let velocity = (velocity.min(127) as i32 - 80) * sensitivity.min(2) as i32 * 16;
    let tracking = (note.min(127) as i32 - 60) * tracking.min(2) as i32 * 6 * 0x334 / 0x90;
    (velocity + tracking).clamp(-4096, 4096)
}

/// Main 0x92a0/0x92ce and 0x92ae/0x92dc -> voice phase increment.
pub fn envelope_step(raw: u16, attack: bool) -> f64 {
    let r = raw.min(1023) as u64;
    let encoded = if attack {
        r * 1536
    } else {
        r * 2_097_151 / 1024
    };
    let d = encoded * encoded / 8_388_608;
    (2 * (u32::MAX as u64 / (d + if attack { 160 } else { 240 }))) as f64 / Q32
}

/// Voice 0x6050: attack-dependent decrement for the final below-floor mute.
pub fn amp_mute_step(raw_attack: u16) -> f64 {
    let encoded = raw_attack.min(1023) as u64 * 1536;
    let step = if encoded <= 0x7800 {
        0x04000000
    } else if encoded < 0x4b000 {
        0x04000000 - (((encoded - 0x7800) >> 8) << 17) / 0x438 * 256
    } else {
        0x02000000
    };
    step as f64 / Q32
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Stage {
    Idle,
    Attack,
    Decay,
    Release,
}
pub struct ModEnvelope {
    pub stage: Stage,
    pub value: f32,
    phase: f64,
    start: f64,
}
impl ModEnvelope {
    pub fn new() -> Self {
        Self {
            stage: Stage::Idle,
            value: 0.0,
            phase: 0.0,
            start: 1.0,
        }
    }
    pub fn trigger(&mut self) {
        self.phase = 0.0;
        self.stage = Stage::Attack;
    }
    pub fn release(&mut self) {
        self.start = self.value as f64;
        self.phase = 1.0;
        self.stage = Stage::Release;
    }
    pub fn tick(&mut self, attack: f64, decay: f64, sustain: bool) -> f32 {
        match self.stage {
            Stage::Idle => self.value = 0.0,
            Stage::Attack => {
                self.phase = (self.phase + attack).min(1.0);
                self.value = (self.phase * (2.0 - self.phase)) as f32;
                if self.phase >= 1.0 {
                    self.phase = 1.0;
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                // Firmware advances decay even in AGD and retains this state at
                // phase zero, so changing the mode uses the elapsed phase.
                self.phase = (self.phase - decay).max(0.0);
                let sustain = if sustain { 1023.0 / 1024.0 } else { 0.0 };
                self.value = (sustain + (1.0 - sustain) * self.phase * self.phase) as f32;
            }
            Stage::Release => {
                self.phase = (self.phase - decay).max(0.0);
                self.value = (self.start * self.phase * self.phase) as f32;
                if self.phase <= 0.0 {
                    self.stage = Stage::Idle;
                    self.value = 0.0;
                }
            }
        }
        self.value
    }
}

#[derive(Clone, Copy)]
enum AmpStage {
    Idle,
    Precharge,
    Attack,
    Decay,
    Release,
    Mute,
}
pub struct AmpEnvelope {
    stage: AmpStage,
    p: f64,
    phase: f64,
    start: f64,
}
impl AmpEnvelope {
    pub fn new() -> Self {
        Self {
            stage: AmpStage::Idle,
            p: 0.0,
            phase: 0.0,
            start: 0.0,
        }
    }
    pub fn trigger(&mut self) {
        self.p = 0.0;
        self.phase = 0.0;
        self.stage = AmpStage::Precharge;
    }
    pub fn release(&mut self) {
        self.start = self.p;
        self.phase = 1.0;
        self.stage = AmpStage::Release;
    }
    pub fn tick(
        &mut self,
        attack: f64,
        decay: f64,
        sustain: bool,
        tick_scale: f64,
        mute_step: f64,
        curve: f32,
    ) -> f32 {
        let sustain = if sustain { 1023.0 / 1024.0 } else { 0.0 };
        match self.stage {
            AmpStage::Idle => self.p = 0.0,
            AmpStage::Precharge => {
                self.p += tick_scale / 64.0;
                if self.p >= AMP_FLOOR {
                    self.p = AMP_FLOOR;
                    self.stage = AmpStage::Attack;
                }
            }
            AmpStage::Attack => {
                self.p = (self.p + attack).min(1.0);
                if self.p >= 1.0 {
                    self.phase = 0.0;
                    self.stage = AmpStage::Decay;
                }
            }
            AmpStage::Decay => {
                self.phase = (self.phase + decay).min(1.0);
                let q = 1.0 - self.phase;
                self.p = 1.0 - (1.0 - AMP_FLOOR) * (1.0 - sustain) * (1.0 - q * q);
                // Do not mute a completed AD while the key remains held:
                // the firmware can still change its sustain through mode edits.
            }
            AmpStage::Release => {
                if self.start < AMP_FLOOR {
                    self.p = self.start;
                    self.stage = AmpStage::Mute;
                } else {
                    self.phase = (self.phase - decay).max(0.0);
                    self.p = AMP_FLOOR + (self.start - AMP_FLOOR) * self.phase * self.phase;
                    if self.phase <= 0.0 {
                        self.stage = AmpStage::Mute;
                    }
                }
            }
            AmpStage::Mute => {
                self.p = (self.p - mute_step).max(0.0);
                if self.p <= 0.0 {
                    self.stage = AmpStage::Idle;
                }
            }
        }
        // Firmware emits p² as a control voltage. This normalization and the
        // following current-to-gain exponent model the analog VCA, not code.
        (((self.p * self.p - AMP_FLOOR * AMP_FLOOR) / (1.0 - AMP_FLOOR * AMP_FLOOR)).clamp(0.0, 1.0)
            as f32)
            .powf(curve)
    }
}

// Main image0x2081c: 129 knots, one per8 raw LFO-rate units.
const LFO_SLOW: [u32; 129] = [
    42949, 78600, 114252, 149904, 185555, 221207, 256859, 292510, 328161, 363813, 399465, 435116,
    470768, 506420, 542071, 577722, 613374, 649026, 684677, 720329, 755981, 791632, 827283, 862935,
    898587, 934238, 969890, 1005542, 1041193, 1086156, 1228762, 1371369, 1634771, 1938774, 2223987,
    2511465, 2832329, 3122575, 3407787, 3709022, 4021162, 4312792, 4758437, 5204082, 5649727,
    6095371, 6541016, 6986661, 7432305, 7877950, 8323595, 8769240, 9214885, 9660530, 10106175,
    10551820, 10997464, 11443109, 11888754, 12334398, 12780043, 13225688, 13671333, 14116978,
    14562622, 15008267, 15453912, 15899557, 16345202, 16790847, 17236492, 17682136, 18127781,
    18573426, 19019070, 19464715, 19910360, 20356005, 20801650, 21247294, 21911043, 22802333,
    23693623, 24584912, 25476201, 26367491, 27258781, 28150070, 29041360, 29932650, 30823939,
    31715228, 32606518, 33497808, 34389098, 35280387, 36171677, 37062966, 37954256, 38845545,
    39736835, 40628125, 41519415, 42410704, 43654315, 45436894, 47219474, 49002052, 50784632,
    52567211, 54349790, 56132369, 57914949, 59697528, 61480107, 63262686, 65666022, 69231181,
    72796340, 76361498, 79926656, 83491814, 87635786, 92983524, 98331262, 103678999, 109026737,
    114374475, 119722212,
];
pub fn lfo_slow_hz(raw: u16) -> f32 {
    let r = raw.min(1023) as usize;
    let index = r / 8;
    let fraction = r % 8;
    let value = (LFO_SLOW[index] as u64 * (8 - fraction) as u64
        + LFO_SLOW[index + 1] as u64 * fraction as u64)
        / 8;
    let f = value / 80;
    let step = 2 * f.saturating_sub(536).max(1) + 1072;
    (step as f64 * CONTROL_RATE / Q32) as f32
}
pub fn lfo_fast_hz(raw: u16) -> f32 {
    let r = raw.min(1023) as u64;
    let z = if r < 256 {
        (r * 0x1b62) >> 8
    } else if r < 512 {
        (((r - 256) * 0x419e) >> 8) + 0x1b62
    } else if r < 768 {
        (((r - 512) * 0x2a300) >> 8) + 0x5d00
    } else {
        (((r - 768) * 0x2a0000) >> 8) + 0x30000
    };
    let f = ((z + 500) * 0xd1b7) >> 10;
    let step = 2 * f.saturating_sub(536).max(1) + 1072;
    (step as f64 * CONTROL_RATE / Q32) as f32
}
/// Exact normalized shape-CV transfer, voice LUT0x9700. Saw may exceed its
/// unmodulated knob range; triangle's alternate map reflects around x=1 too.
pub fn shape_control(x: f32, wave: u8, square_lfo: bool) -> f32 {
    match wave {
        0 => {
            if square_lfo {
                x.clamp(0.0, 2.0)
            } else {
                x.abs().min(2.0)
            }
        }
        1 => {
            if square_lfo {
                x.clamp(0.0, 1.0)
            } else {
                (1.0 - (x.abs() - 1.0).abs()).max(0.0)
            }
        }
        _ => x.clamp(-1.0, 1.0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lfo_pitch_depth_preserves_recovered_encoder_boundaries() {
        for (raw, semitones) in [
            (0, -78.0),
            (64, -24.0),
            (65, -29.71875),
            (512, 0.0),
            (513, 0.0078125),
            (550, 0.39453125),
            (704, 2.0),
            (896, 12.0),
            (959, 29.71875),
            (960, 24.0),
            (1023, 77.15625),
        ] {
            assert_eq!(lfo_pitch_semitones(raw), semitones);
        }
    }
    #[test]
    fn recovered_cutoff_depth_and_note_offsets() {
        assert_eq!(cutoff_eg_depth(512), 0.0);
        assert_eq!(cutoff_eg_depth(531), 0.0);
        assert_eq!(cutoff_eg_depth(675), 362.0 / 4096.0);
        assert_eq!(cutoff_eg_depth(349), -362.0 / 4096.0);
        assert_eq!(cutoff_eg_depth(0), -1.0);
        assert_eq!(cutoff_eg_depth(1023), 1.0);
        assert_eq!(cutoff_note_offset(60, 80, 2, 2), 0);
        assert_eq!(cutoff_note_offset(60, 127, 0, 1), 752);
        assert_eq!(cutoff_note_offset(60, 1, 0, 2), -2528);
        assert_eq!(cutoff_note_offset(72, 80, 2, 0), 820);
        assert_eq!(cutoff_note_offset(48, 80, 1, 0), -410);
        assert_eq!(cutoff_note_offset(127, 127, 2, 2), 4096);
    }
    #[test]
    fn modulation_uses_distinct_attack_and_level_preserving_release() {
        let mut eg = ModEnvelope::new();
        eg.trigger();
        assert_eq!(eg.tick(0.25, 0.1, false), 0.4375);
        eg.release();
        let out = eg.tick(0.25, 0.25, false);
        assert!((out - 0.4375 * 0.75 * 0.75).abs() < 1e-7);
    }
    #[test]
    fn modulation_mode_changes_keep_elapsed_decay_and_release_level() {
        let mut eg = ModEnvelope::new();
        eg.trigger();
        eg.tick(1.0, 0.25, true);
        eg.tick(1.0, 0.25, true);
        eg.tick(1.0, 0.25, true);
        // AGD has consumed half the decay phase; switching to AD must not
        // restart at one or preserve the previous hold value.
        assert_eq!(eg.tick(1.0, 0.25, false), 0.0625);
        assert_eq!(eg.tick(1.0, 0.25, false), 0.0);
        assert_eq!(eg.stage, Stage::Decay);
        let sustained = eg.tick(1.0, 0.25, true);
        assert_eq!(sustained, 1023.0 / 1024.0);
        eg.release();
        assert!((eg.tick(1.0, 0.25, true) - sustained * 0.75 * 0.75).abs() < 1e-7);
        for _ in 0..3 {
            eg.tick(1.0, 0.25, true);
        }
        assert_eq!(eg.stage, Stage::Idle);
    }
    #[test]
    fn held_amp_can_change_from_completed_ad_to_agd() {
        let mut eg = AmpEnvelope::new();
        eg.trigger();
        // Advance through precharge and attack, then finish AD decay.
        eg.tick(1.0, 0.25, false, 64.0, amp_mute_step(0), 1.0);
        eg.tick(1.0, 0.25, false, 1.0, amp_mute_step(0), 1.0);
        for _ in 0..4 {
            eg.tick(1.0, 0.25, false, 1.0, amp_mute_step(0), 1.0);
        }
        assert!(matches!(eg.stage, AmpStage::Decay));
        assert_eq!(eg.p, AMP_FLOOR);
        assert!(eg.tick(1.0, 0.25, true, 1.0, amp_mute_step(0), 1.0) > 0.99);
        eg.release();
        let start = eg.p;
        eg.tick(1.0, 0.25, false, 1.0, amp_mute_step(0), 1.0);
        assert!((eg.p - (AMP_FLOOR + (start - AMP_FLOOR) * 0.75 * 0.75)).abs() < 1e-12);
    }
    #[test]
    fn final_mute_uses_attack_dependent_firmware_decrement() {
        assert_eq!(amp_mute_step(0), 1.0 / 64.0);
        assert_eq!(amp_mute_step(20), 1.0 / 64.0);
        assert_eq!(amp_mute_step(110), 3.0 / 256.0);
        assert_eq!(amp_mute_step(200), 1.0 / 128.0);
        assert_eq!(amp_mute_step(1023), 1.0 / 128.0);
        let mut eg = AmpEnvelope::new();
        eg.stage = AmpStage::Mute;
        eg.p = 0.125;
        eg.tick(0.0, 0.0, false, 1.0, amp_mute_step(0), 1.0);
        assert_eq!(eg.p, 0.125 - 1.0 / 64.0);
    }
    #[test]
    fn times_follow_recovered_integer_law() {
        assert!((envelope_step(0, true) * CONTROL_RATE - 500.0).abs() < 0.001);
        assert!((envelope_step(0, false) * CONTROL_RATE - 333.3333).abs() < 0.001);
        assert!(envelope_step(512, true) < envelope_step(256, true));
        assert!(envelope_step(1023, false) < envelope_step(1023, true));
        assert!((lfo_slow_hz(321) - 0.95).abs() < 0.02);
        assert!((lfo_fast_hz(512) - 23.73823896).abs() < 0.00001);
        assert!((0.5 / lfo_slow_hz(321) - 0.529249716).abs() < 0.000001);
    }
    #[test]
    fn shape_mapping_retains_extended_and_reflected_modulation() {
        assert_eq!(shape_control(-0.5, 0, false), 0.5);
        assert_eq!(shape_control(-0.5, 0, true), 0.0);
        assert_eq!(shape_control(1.5, 0, false), 1.5);
        assert_eq!(shape_control(1.5, 1, false), 0.5);
        assert_eq!(shape_control(1.5, 1, true), 1.0);
        assert_eq!(shape_control(-0.5, 2, false), -0.5);
    }
}
