//! Reconstructed scalar controller laws. These are generated arithmetic and
//! musical control detents, not copied firmware lookup tables.

// Public patch IDs and assignment routing, not a vendor lookup table. The H8
// getters combine two signed products before their common arithmetic shift.
pub(super) const RAW_PARAMETER_COUNT: usize = 363;
pub(super) const SYNTH_PARAMETER_COUNT: usize = 74;
pub(super) const ASSIGNMENT_DESTINATIONS: [u16; 40] = [
    17, 18, 19, 22, 23, 25, 26, 27, 28, 29, 31, 32, 35, 36, 37, 38, 41, 42, 43, 44, 45, 46, 47, 48,
    49, 50, 51, 52, 53, 54, 55, 56, 57, 59, 60, 62, 64, 65, 66, 70,
];
pub(super) const CONTROL_ASSIGNMENTS: [u16; 40] = [
    74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102, 104, 106, 108, 110, 112, 114,
    116, 118, 120, 122, 124, 126, 256, 258, 260, 262, 264, 266, 268, 270, 272, 274, 276, 278, 281,
];
pub(super) fn assignment_destination(id: u16) -> Option<u16> {
    if (284..=362).contains(&id) && id % 2 == 0 {
        Some(ASSIGNMENT_DESTINATIONS[((id - 284) / 2) as usize])
    } else {
        CONTROL_ASSIGNMENTS
            .iter()
            .position(|&x| x == id)
            .map(|i| ASSIGNMENT_DESTINATIONS[i])
    }
}
pub(super) fn assignment_supported(destination: u16) -> bool {
    matches!(destination,17|18|19|22|23|25..=29|31|32|35..=38|41..=57|59|60|62|64|65|66|70)
}
pub(super) fn velocity_code(raw: u8) -> i32 {
    let value = i32::from(raw.min(127));
    if value <= 80 {
        (128 * (value - 80)).div_euclid(79).max(-128)
    } else {
        128 * (value - 80) / 47
    }
}
pub(super) fn effective_value(
    base: u16,
    velocity: i32,
    morph: i32,
    velocity_assignment: u16,
    control_assignment: u16,
    bipolar: bool,
) -> u16 {
    let delta = (velocity * (i32::from(velocity_assignment) - 127)
        + morph * (i32::from(control_assignment) - 127))
        >> 7;
    let value = i32::from(base) + delta;
    if bipolar {
        if base < 64 {
            value.clamp(0, 64) as u16
        } else {
            value.clamp(64, 127) as u16
        }
    } else {
        value.clamp(0, 127) as u16
    }
}
pub(super) fn effective_controls(
    params: &[u16; RAW_PARAMETER_COUNT],
    velocity: i32,
    morph: i32,
) -> [u16; SYNTH_PARAMETER_COUNT] {
    let mut result = [0; SYNTH_PARAMETER_COUNT];
    result.copy_from_slice(&params[..SYNTH_PARAMETER_COUNT]);
    for (index, &destination) in ASSIGNMENT_DESTINATIONS.iter().enumerate() {
        result[destination as usize] = effective_value(
            params[destination as usize],
            velocity,
            morph,
            params[284 + 2 * index],
            params[CONTROL_ASSIGNMENTS[index] as usize],
            matches!(destination, 25 | 26 | 27 | 44 | 45 | 46 | 53)
                || (destination == 52 && params[58] != 2),
        );
    }
    // The two OSC2 tuning getters clamp their assignment results before using
    // the normal or wide-range laws (H8 a898/a8ba).
    result[35] = result[35].min(50);
    result[36] = result[36].min(100);
    result
}
pub(super) fn can_vary(params: &[u16; RAW_PARAMETER_COUNT], destination: u16) -> bool {
    ASSIGNMENT_DESTINATIONS
        .iter()
        .position(|&d| d == destination)
        .is_some_and(|i| {
            params[CONTROL_ASSIGNMENTS[i] as usize] != 127 || params[284 + 2 * i] != 127
        })
}
pub(super) fn oscillator2_tuning(range: u16, fine: u16) -> i32 {
    let fine = i32::from(fine.min(100));
    match range.min(50) {
        0 => -((98 - fine) * 50).clamp(0, 4800),
        50 => ((fine - 2) * 50).clamp(0, 4800),
        value => 100 * (i32::from(value) - 25) + fine - 50,
    }
}
/// H8 bend path b3b4..b3fe: the positive MIDI endpoint is widened to8192.
pub(super) fn pitch_bend_cents(raw: u16, up: u16, down: u16) -> i32 {
    let bend = if raw >= 16383 {
        8192
    } else {
        i32::from(raw) - 8192
    };
    (bend * i32::from(if bend < 0 { down } else { up }).min(24) * 100) >> 13
}
pub(super) fn wheel_level(raw: u8) -> i32 {
    i32::from(raw.min(127)) + i32::from(raw > 64)
}
/// H8 b856..b9ae scales the note's rounded-frequency period by inverse pitch.
pub(super) fn feedback_period(note: i32, modulation_cents: i32) -> i64 {
    let hz = ((440.0 * 2.0_f64.powf(f64::from(note.clamp(0, 127) - 69) / 12.0) * 100.0).round()
        / 100.0) as f32;
    let base = (88200.0 * 4096.0 / f64::from(hz)).round() as i64;
    let cents = -modulation_cents.clamp(-38400, 38400);
    let oct = cents.div_euclid(1200);
    let rem = cents.rem_euclid(1200);
    let coarse = (2048.0 * 2.0_f64.powf(f64::from(rem >> 8) * 256.0 / 1200.0)).floor() as i64;
    let fine = (32768.0 * 2.0_f64.powf(f64::from(rem & 255) / 1200.0)).floor() as i64;
    let ratio = (coarse * fine) >> 12;
    let period = (base * ratio) >> 14;
    ((if oct >= 0 {
        period << oct
    } else {
        period >> -oct
    }) >> 3)
        .clamp(0, (1 << 23) - 1)
}
/// The second oscillator is always triangle; its rate has independent musical detents.
pub(super) fn lfo2_step(raw: u16) -> u32 {
    let r = raw.min(127);
    if r >= 123 {
        return lfo_step(r);
    }
    let period: Option<f64> = match r {
        87 => Some(12.0),
        91 => Some(11.0),
        94 => Some(10.0),
        98 => Some(9.0),
        100 => Some(8.5),
        102 => Some(8.0),
        105 => Some(7.5),
        107 => Some(7.0),
        110 => Some(6.5),
        111 => Some(6.4),
        113 => Some(6.0),
        116 => Some(5.5),
        117 => Some(16.0 / 3.0),
        120 => Some(5.0),
        _ => None,
    };
    period.map_or_else(
        || (512.0 * 2.0_f64.powf(5.0 * f64::from(r) / 128.0)).floor() as u32,
        |p| (65536.0 / p).round() as u32,
    )
}
pub(super) fn level_curve(raw: u16) -> i64 {
    let raw = i64::from(raw.min(127));
    if raw == 127 {
        32768
    } else {
        32767 * raw * raw / 16129
    }
}
/// Native 12 dB filter gain compensation uses uncorrected damping, not cutoff.
pub(super) fn filter12_amplitude(resonance: u16) -> i64 {
    let distance = 128 - i64::from(resonance.min(127));
    let index = ((32 + distance * distance).min(16384) >> 7).min(36);
    8192 - 4096 * (36 - index).pow(2) / 1296
}
pub(super) fn amp_lfo_depth(raw: u16) -> i32 {
    let raw = raw.min(127);
    let k = (i32::from(raw) - 64).abs().min(63);
    let magnitude = if raw == 0 || raw == 127 {
        4096
    } else {
        (4096.0 * (1.0 - (std::f64::consts::PI * f64::from(k) / 126.0).cos()) - 1e-9)
            .floor()
            .max(0.0) as i32
    };
    if raw < 64 {
        -magnitude
    } else {
        magnitude
    }
}
pub(super) fn bipolar_depth(raw: u16, peak: i32) -> i32 {
    let raw = raw.min(127) as i32;
    let k = (raw - 64).abs().min(63);
    let magnitude = if raw == 0 || raw == 127 {
        peak
    } else if raw == 1 {
        peak * 79 / 80
    } else {
        ((peak as f64 * (1.0 - (std::f64::consts::PI * k as f64 / 126.0).cos()) - 1e-9).floor()
            as i32)
            .max(0)
    };
    if raw < 64 {
        -magnitude
    } else {
        magnitude
    }
}
pub(super) fn pitch_lfo_depth(raw: u16) -> i32 {
    let raw = raw.min(127);
    if raw == 63 || raw == 65 {
        return 1;
    }
    let k = (raw as i32 - 64).abs();
    let detent = match k {
        12 => 100,
        17 => 200,
        20 => 300,
        24 => 400,
        26 => 500,
        31 => 700,
        34 => 800,
        36 => 900,
        38 => 1000,
        40 => 1100,
        42 => 1200,
        44 => 1300,
        46 => 1400,
        48 => 1500,
        51 => 1700,
        53 => 1800,
        58 => 2100,
        60 => 2200,
        _ => return bipolar_depth(raw, 2400),
    };
    if raw < 64 {
        -detent
    } else {
        detent
    }
}
pub(super) fn shape_target(wave: u16, shape: u16, depth: u16, lfo: i32) -> i64 {
    let delta = (lfo * depth.min(127) as i32) >> 7;
    let value = if wave == 1 {
        ((127 - shape.min(127) as i32) * 256 - delta).clamp(8192, 29184)
    } else {
        (shape.min(127) as i32 * 256 + delta).clamp(0, 31744)
    };
    (value as i64 * 256) & !511
}
pub(super) fn balance_amplitude(raw: u16) -> i64 {
    if raw == 63 || raw == 64 {
        return 16384;
    }
    (16384.0 * ((raw.min(127) as f64 / 127.0 - 0.5) * std::f64::consts::FRAC_PI_2).cos()).floor()
        as i64
        & !1
}
pub(super) fn balance_target(raw: u16) -> i64 {
    let x = raw.min(127) as f64 / 127.0;
    let value =
        (32767.0 * (1.0 + ((x - 0.5) * std::f64::consts::FRAC_PI_2).tan()) / 2.0).floor() as i64;
    (value * 256) & !511
}
pub(super) fn keyfollow(raw: u16) -> i32 {
    let r = raw.min(127) as i32;
    match r {
        0..=64 => r - 64,
        65..=97 => 2 * (r - 64),
        98..=126 => 2 * (r - 64) + 1,
        _ => 128,
    }
}
pub(super) fn lfo_step(raw: u16) -> u32 {
    let r = raw.min(127);
    let period = match r {
        93 => 12.0,
        96 => 11.0,
        99 => 10.0,
        102 => 9.0,
        104 => 8.5,
        106 => 8.0,
        108 => 7.5,
        110 => 7.0,
        112 => 6.5,
        114 => 6.0,
        117 => 5.5,
        118 => return 12288,
        120 => 5.0,
        123 => 4.5,
        125 => 4.0,
        126 => 3.0,
        127 => 2.0,
        _ => 0.0,
    };
    if period > 0.0 {
        return (65536.0_f64 / period).round() as u32;
    }
    match r {
        0 => 32,
        1..=62 => (32.0 * 2.0_f64.powf(r as f64 * 3.0 / 32.0) - 1e-8).floor() as u32,
        _ => (2048.0 * 2.0_f64.powf((r - 63) as f64 * 3.0 / 64.0)).floor() as u32,
    }
}
/// Eight shifts of a15-bit feedback register per random-LFO half-cycle.
/// Seed once at initialization; preserve it across waveform and patch edits.
fn random_lfo_next(mut seed:u16) -> u16 {
    for _ in 0..8 { seed=seed.wrapping_shl(1) | (((seed>>14)^seed)&1); }
    seed & 0x7fff
}

#[derive(Clone, Copy)]
pub(super) struct Lfo {
    phase: u32,
    step: u32,
    random_state: u16,
    sync: u16,
    tempo: u16,
    anchor: u32,
    wave: u16,
    value: i32,
    edge: bool,
}
impl Lfo {
    pub(super) fn new() -> Self {
        Self {
            phase: 0,
            step: lfo_step(64) << 16,
            random_state: 1,
            sync: 0,
            tempo: 120,
            anchor: 0,
            wave: 0,
            value: 0,
            edge: false,
        }
    }
    pub(super) fn configure(&mut self, wave: u16, rate: u16) {
        let step = lfo_step(rate) << 16;
        if step == 0x80000000 && (self.step != step || self.wave != wave) {
            self.phase = if wave == 0 { 0x40000000 } else { 0 };
        }
        self.wave = wave;
        self.step = step;
    }
    /// Native sync edits change phase/increment but leave the held waveform
    /// value untouched until the next100Hz controller update.
    pub(super) fn configure_primary(&mut self, wave:u16, rate:u16, sync:u16, tempo:u16, pulse:u32) {
        let changed_sync=self.sync!=sync;
        let changed_tempo=self.tempo!=tempo;
        self.sync=sync;
        self.tempo=tempo;
        if sync==0 { self.configure(wave,rate); return; }
        self.wave=wave;
        self.step=super::tempo::synced_lfo_increment(sync,tempo).expect("validated musical division");
        if changed_sync || changed_tempo {
            let anchor=if changed_tempo { 0 } else { self.anchor };
            self.phase=super::tempo::TempoClock::phase(sync,pulse,anchor).unwrap();
        }
    }
    pub(super) fn clock_pulse(&mut self,pulse:u32) {
        if pulse%24==0 && super::tempo::TempoClock::reset_due(self.sync,pulse/24) {
            self.phase=u32::MAX;
            self.anchor=pulse.wrapping_add(1);
        }
    }
    /// Note allocation/retarget restarts only the fastest free rate. The held
    /// waveform and edge flag survive until the next100Hz controller update.
    pub(super) fn retarget_note(&mut self) {
        if self.sync==0 && self.step==0x80000000 {
            self.phase=if self.wave==0 {0x40000000} else {0};
        }
    }
    pub(super) fn increment(&self) -> u32 { self.step }
    pub(super) fn set_phase(&mut self, cycles: f64) -> Result<(), &'static str> {
        if !cycles.is_finite() {
            return Err("LFO phase must be finite");
        }
        self.phase = (cycles.rem_euclid(1.0) * 4294967296.0) as u32;
        self.evaluate();
        self.edge = false;
        Ok(())
    }
    fn evaluate(&mut self) {
        let p = (self.phase >> 16) as u16;
        self.value = match self.wave {
            0 => {
                if p <= 0x4000 || p >= 0xc000 {
                    p as i16 as i32
                } else {
                    0x8000 - p as i32
                }
            }
            1 => -(p.wrapping_sub(0x8000) as i16 as i32 / 2),
            2 => {
                if p < 0x8000 {
                    16384
                } else {
                    -16384
                }
            }
            _ => self.value, // Random holds the preceding value until a half-cycle edge.
        };
    }
    pub(super) fn configure_second(&mut self, rate: u16) {
        let step = lfo2_step(rate) << 16;
        if step == 0x80000000 && self.step != step {
            self.phase = 0x40000000;
        }
        self.wave = 0;
        self.step = step;
    }
    pub(super) fn tick(&mut self) -> i32 {
        let old = self.phase;
        self.phase = self.phase.wrapping_add(self.step);
        self.edge = match self.wave {
            1 => old >= 0x80000000 && self.phase < 0x80000000,
            2 | 3 => (old ^ self.phase) & 0x80000000 != 0,
            _ => false,
        };
        if self.wave == 3 && self.edge {
            self.random_state = random_lfo_next(self.random_state);
            self.value = i32::from(self.random_state) - 16384;
        }
        self.evaluate();
        self.value
    }
    pub(super) fn edge(&self) -> bool {
        self.edge
    }
    pub(super) fn value(&self) -> i32 {
        self.value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn free_rate_edits_and_note_retarget_preserve_held_output_and_edge() {
        let mut l=Lfo::new();
        l.configure(1,127);
        l.tick(); l.tick();
        assert_eq!(l.value(),16384);assert!(l.edge());
        l.retarget_note();
        assert_eq!(l.phase,0);assert_eq!(l.value(),16384);assert!(l.edge());
        l.configure(1,127);
        assert_eq!(l.value(),16384);assert!(l.edge());
        l.tick();assert_eq!(l.value(),0);assert!(!l.edge());
        let mut second=Lfo::new();
        second.configure_second(127);
        assert_eq!(second.value(),0);
        second.tick();second.tick();
        assert_eq!(second.value(),16384);
        second.retarget_note();second.configure_second(127);
        assert_eq!(second.phase,0x40000000);assert_eq!(second.value(),16384);
        second.tick();assert_eq!(second.value(),-16384);
    }
    #[test]
    fn synchronized_phase_edits_and_bar_resets_preserve_the_held_value() {
        let mut l=Lfo::new();
        l.configure_primary(0,64,7,120,6);
        assert_eq!(l.phase,0x40000000);
        assert_eq!(l.value(),0);
        l.tick();
        let held=l.value();
        let phase=l.phase;
        l.clock_pulse(24);
        assert_eq!(l.phase,phase);
        l.clock_pulse(96);
        assert_eq!(l.phase,u32::MAX);
        assert_eq!(l.anchor,97);
        assert_eq!(l.value(),held);
        l.configure_primary(0,96,7,120,100);
        assert_eq!(l.phase,u32::MAX); // A free rate edit cannot restart sync.
        l.configure_primary(0,96,4,120,100);
        assert_eq!(l.phase,0x40000000); // Three pulses since anchor /12.
        assert_eq!(l.value(),held);
        l.configure_primary(0,96,4,74,100);
        assert_eq!(l.phase,super::super::tempo::TempoClock::phase(4,100,0).unwrap());
        assert_eq!(l.value(),held);
    }
    #[test]
    fn random_lfo_advances_on_edges_and_retains_state_across_wave_changes() {
        let mut l=Lfo::new();
        l.configure(3,127);
        assert_eq!(l.value(),0);
        let seed=random_lfo_next(1);
        assert_eq!(l.tick(),i32::from(seed)-16384);
        assert!(l.edge());
        l.configure(2,64);
        for _ in 0..100 { l.tick(); }
        assert_eq!(l.random_state,seed);
        let held=l.value();
        l.configure(3,0);
        assert_eq!(l.value(),held);
        l.set_phase(0.0).unwrap();
        for _ in 0..1023 { assert_eq!(l.tick(),held); assert!(!l.edge()); }
        assert_eq!(l.tick(),i32::from(random_lfo_next(seed))-16384);
        assert!(l.edge());
    }
    #[test]
    fn fastest_triangle_preserves_two_nonzero_half_cycles() {
        for second in [false, true] {
            let mut lfo = Lfo::new();
            if second {
                lfo.configure_second(127);
            } else {
                lfo.configure(0, 127);
            }
            assert_eq!(lfo.value(), 0); // Setter preserves the held output.
            assert_eq!(lfo.tick(), -16384);
            // An unrelated control refresh preserves phase. Explicit note
            // retarget has its own phase-only reset, tested separately.
            if second {
                lfo.configure_second(127);
            } else {
                lfo.configure(0, 127);
            }
            assert_eq!(lfo.tick(), 16384);
        }
    }
    #[test]
    fn assignments_sum_before_shift_and_preserve_bipolar_sign() {
        assert_eq!(velocity_code(1), -128);
        assert_eq!(velocity_code(32), -78);
        assert_eq!(velocity_code(80), 0);
        assert_eq!(velocity_code(100), 54);
        assert_eq!(velocity_code(127), 128);
        assert_eq!(effective_value(64, 1, 1, 191, 191, false), 65);
        assert_eq!(effective_value(64, -128, 0, 254, 127, true), 64);
        assert_eq!(effective_value(63, 128, 0, 254, 127, true), 64);
        assert_eq!(effective_value(63, -128, 0, 254, 127, true), 0);
        assert_eq!(oscillator2_tuning(0, 0), -4800);
        assert_eq!(oscillator2_tuning(0, 50), -2400);
        assert_eq!(oscillator2_tuning(0, 100), 0);
        assert_eq!(oscillator2_tuning(50, 0), 0);
        assert_eq!(oscillator2_tuning(50, 50), 2400);
        assert_eq!(oscillator2_tuning(50, 100), 4800);
    }
    #[test]
    fn controller_integer_endpoints_and_period_ratios_are_exact() {
        assert_eq!(pitch_bend_cents(0, 2, 12), -1200);
        assert_eq!(pitch_bend_cents(8191, 2, 12), -1);
        assert_eq!(pitch_bend_cents(8192, 2, 12), 0);
        assert_eq!(pitch_bend_cents(16382, 2, 12), 199);
        assert_eq!(pitch_bend_cents(16383, 2, 12), 200);
        assert_eq!(wheel_level(64), 64);
        assert_eq!(wheel_level(65), 66);
        assert_eq!(wheel_level(127), 128);
        assert_eq!(lfo2_step(0), 512);
        assert_eq!(lfo2_step(64), 2896);
        assert_eq!(lfo2_step(111), 10240);
        assert_eq!(lfo2_step(127), 32768);
        assert_eq!(feedback_period(60, 0), 172604);
        assert_eq!(feedback_period(60, 1200), 86302);
        assert_eq!(feedback_period(60, -1200), 345208);
        for range in 0..=24 {
            let mut previous = -2401;
            for raw in 0..=16383 {
                let cents = pitch_bend_cents(raw, range, range);
                assert!(cents >= previous && cents.abs() <= i32::from(range) * 100);
                previous = cents;
            }
        }
    }
    #[test]
    fn nonlinear_depth_endpoints_and_musical_detents_are_preserved() {
        for peak in [2400, 4800, 6000, 12000] {
            assert_eq!(bipolar_depth(0, peak), -peak);
            assert_eq!(bipolar_depth(64, peak), 0);
            assert_eq!(bipolar_depth(127, peak), peak);
            assert_eq!(bipolar_depth(1, peak), -peak * 79 / 80);
            assert_eq!(bipolar_depth(106, peak), peak / 2 - 1);
        }
        assert_eq!(pitch_lfo_depth(63), 1);
        assert_eq!(pitch_lfo_depth(65), 1);
        assert_eq!(pitch_lfo_depth(52), -100);
        assert_eq!(pitch_lfo_depth(76), 100);
        assert_eq!(keyfollow(64), 0);
        assert_eq!(keyfollow(97), 66);
        assert_eq!(keyfollow(98), 69);
    }
    #[test]
    fn shape_modulation_preserves_polarity_clamps_and_quantization() {
        for wave in [1, 4, 5, 6] {
            for raw in 0..=127 {
                let a = shape_target(wave, raw, 0, 0);
                let b = shape_target(wave, raw, 127, 16384);
                let c = shape_target(wave, raw, 127, -16384);
                assert_eq!(a & 511, 0);
                assert_eq!(b & 511, 0);
                assert_eq!(c & 511, 0);
                if wave == 1 {
                    assert!(b <= a && a <= c);
                } else {
                    assert!(c <= a && a <= b);
                }
            }
        }
        assert_eq!(balance_amplitude(0), 11584);
        assert_eq!(balance_amplitude(127), 11584);
        assert_eq!(balance_amplitude(63), 16384);
        assert_eq!(balance_amplitude(64), 16384);
        assert_eq!(balance_target(0), 0);
        assert_eq!(balance_target(127), 8388096);
        assert!(balance_target(64) > balance_target(63));
    }
    #[test]
    fn lfo_phase_wrap_and_wave_values_are_bounded() {
        for wave in 0..3 {
            for rate in 0..128 {
                let mut l = Lfo::new();
                l.configure(wave, rate);
                for _ in 0..100 {
                    assert!((-16384..=16384).contains(&l.tick()));
                }
            }
        }
        assert_eq!(lfo_step(127), 32768);
        assert_eq!(lfo_step(125), 16384);
        assert_eq!(lfo_step(118), 12288);
        assert_eq!(lfo_step(0), 32);
    }
}
