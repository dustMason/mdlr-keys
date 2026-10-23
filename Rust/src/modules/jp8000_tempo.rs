//! Generated internal tempo and musical synchronization laws. No boot-state replay.
/// Internal-tempo synchronized phase increment at the 100 Hz control cadence.
/// Sync zero means the separate free-running rate law. These are musical ratios
/// (cycles per quarter note), not oscillator samples or firmware coefficients.
pub(super) fn synced_lfo_increment(sync: u16, tempo: u16) -> Option<u32> {
    let (numerator, denominator) = match sync {
        1 => (4, 1), 2 => (3, 1), 3 => (8, 3), 4 => (2, 1),
        5 => (3, 2), 6 => (4, 3), 7 => (1, 1), 8 => (3, 4),
        9 => (2, 3), 10 => (1, 2), 11 => (3, 8), 12 => (1, 3),
        13 => (1, 4), 14 => (3, 16), 15 => (1, 6), 16 => (1, 8),
        17 => (1, 12), 18 => (1, 16), 19 => (1, 20), 20 => (1, 24),
        21 => (1, 28), 22 => (1, 32), _ => return None,
    };
    let quarter = (((tempo.clamp(20, 250) as u64) << 16) / 6000) << 16;
    Some((quarter * numerator / denominator) as u32)
}

/// Internal clock only. The hardware scheduler starts at a separate boot epoch;
/// this independently constructed clock deliberately starts at zero.
#[derive(Clone, Copy, Debug)]
pub(super) struct TempoClock {
    sample_fraction: u32,
    period: u32,
    remainder: u32,
    pulses: u32,
}
impl TempoClock {
    pub(super) fn new(tempo: u16) -> Self {
        Self { sample_fraction: 0, period: 480_000 / u32::from(tempo.clamp(20,250)), remainder: 0, pulses: 0 }
    }
    pub(super) fn set_tempo(&mut self, tempo: u16) {
        self.period = 480_000 / u32::from(tempo.clamp(20,250));
        // Both sub-timer sample position and native timer remainder survive edits.
    }
    pub(super) fn pulses(&self) -> u32 { self.pulses }
    /// One 88.2 kHz sample. Some calls emit one 24-PPQN clock pulse.
    pub(super) fn native_sample(&mut self) -> Option<u32> {
        self.sample_fraction += 500;
        if self.sample_fraction < 88_200 { return None; }
        self.sample_fraction -= 88_200;
        self.timer_tick()
    }
    fn timer_tick(&mut self) -> Option<u32> {
        self.remainder += 384;
        if self.remainder < self.period { return None; }
        self.remainder %= self.period;
        // Native 22a1a–22aa4 emits ONE pulse for a nonzero quotient, even if a
        // large tempo jump leaves more than one new period in the old remainder.
        self.pulses = self.pulses.wrapping_add(1);
        Some(self.pulses)
    }
    /// Native internal tempo performs this reset only on quarter-note boundaries.
    /// The caller owns part anchor/phase; reset phase to u32::MAX, anchor to pulse+1.
    /// This does not update the held LFO value or random seed.
    pub(super) fn reset_due(sync: u16, quarter: u32) -> bool {
        let beats = match sync {
            1 | 2 | 4 | 5 | 7 | 8 | 10 => 4,
            3 | 6 | 9 => 6,
            11 | 13 | 16 => 8,
            12 | 15 | 17 => 12,
            14 | 18 => 16,
            19 => 20, 20 => 24, 21 => 28, 22 => 32,
            _ => return false,
        };
        quarter % beats == 0
    }
    /// Use for sync-selector changes (actual part anchor) and tempo changes
    /// (anchor zero), not for every emitted PPQN clock pulse.
    pub(super) fn phase(sync: u16, pulse: u32, anchor: u32) -> Option<u32> {
        let period = match sync {
            1 => 6, 2 => 8, 3 => 9, 4 => 12, 5 => 16, 6 => 18,
            7 => 24, 8 => 32, 9 => 36, 10 => 48, 11 => 64, 12 => 72,
            13 => 96, 14 => 128, 15 => 144, 16 => 192, 17 => 288,
            18 => 384, 19 => 480, 20 => 576, 21 => 672, 22 => 768,
            _ => return None,
        };
        Some((((pulse.wrapping_sub(anchor) % period) << 16) / period) << 16)
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn zero_origin_timer_is_exactly_rational() {
        for tempo in [20,37,60,74,120,173,250] {
            let mut clock = TempoClock::new(tempo);
            let mut native_ticks = 0;
            for sample in 1..=882_000 {
                clock.native_sample();
                let now = sample * 500 / 88_200;
                if now != native_ticks {
                    native_ticks = now;
                    assert_eq!(clock.pulses, (native_ticks * 384 / clock.period) as u32);
                }
            }
            assert_eq!(native_ticks, 5000);
        }
    }
    #[test] fn tempo_edit_preserves_timer_state_and_emits_at_most_one_pulse() {
        let mut clock = TempoClock::new(20);
        for _ in 0..62 { assert!(clock.timer_tick().is_none()); }
        assert_eq!(clock.remainder,23808);
        clock.sample_fraction = 123;
        clock.set_tempo(250);
        assert_eq!(clock.sample_fraction,123);
        assert_eq!(clock.timer_tick(),Some(1));
        assert_eq!(clock.remainder,(23808+384)%1920);
    }
    #[test] fn alignment_uses_integer_24_ppqn_grid_and_wraps_anchor() {
        assert_eq!(TempoClock::phase(7,0,0),Some(0));
        assert_eq!(TempoClock::phase(7,6,0),Some(0x4000_0000));
        assert_eq!(TempoClock::phase(7,12,0),Some(0x8000_0000));
        assert_eq!(TempoClock::phase(7,24,0),Some(0));
        assert_eq!(TempoClock::phase(7,0,u32::MAX),TempoClock::phase(7,1,0));
    }
}
