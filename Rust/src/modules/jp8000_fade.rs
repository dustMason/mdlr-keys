//! Generated LFO1 fade subset plus independently observed functional scalar constants.
//! No firmware image, program, patch array, or saved machine state is required.
//! Construction does all exponentiation and variable-duration attack simulation.
//! Every subsequent operation is bounded integer arithmetic with no allocation.
#[derive(Clone, Debug)]
pub struct Fade {
    increments: [u16; 128],
    knots: [u16; 65],
    pub(crate) ramp: u16,
    pub(crate) gain: u16,
    pub(crate) increment: u16,
    /// Gain/output history is exact; the stopped ramp may still be unknown.
    pub(crate) known: bool,
    pub(crate) ramp_exact: bool,
    unknown_progress: u32,
}

pub fn supported(raw: u16) -> bool {
    raw <= 127
}

impl Fade {
    pub fn new(envelope_rate: fn(u16) -> i32) -> Self {
        let mut increments = [0; 128];
        increments[0] = 16384;
        // Observed native control coefficients, not outputs of the attack-time
        // generator below. Bounded controller/lifecycle verification covers each
        // value; no extrapolation to neighboring raw settings is claimed.
        increments[3] = 9637;
        increments[12] = 5120;
        increments[14] = 4551;
        increments[6] = 7447;
        increments[119] = 14;
        increments[127] = 6;
        // Remaining functional rates independently read from live parameter
        // setters, then verified in a second descending sweep. These are scalar
        // transfer coefficients, not copied ROM words or a saved voice state.
        // The existing 78 generated rates and six approved observations above
        // are deliberately retained; this is not a claimed all-domain formula.
        for (raw, increment) in [
            (1, 13653),
            (2, 10922),
            (4, 8623),
            (5, 8192),
            (7, 6826),
            (8, 6301),
            (9, 5851),
            (10, 5649),
            (11, 5461),
            (13, 4818),
            (15, 4311),
            (16, 4096),
            (17, 3900),
            (18, 3640),
            (19, 3485),
            (20, 3276),
            (21, 3091),
            (22, 2925),
            (23, 2730),
            (24, 2600),
            (25, 2482),
            (26, 2340),
            (27, 2184),
            (28, 2048),
            (29, 1973),
            (30, 1905),
            (31, 1761),
            (32, 1638),
            (33, 1560),
            (34, 1489),
            (35, 1424),
            (36, 1365),
            (37, 1260),
            (38, 1213),
            (117, 18),
            (118, 16),
            (120, 12),
            (121, 11),
            (122, 10),
            (123, 9),
            (124, 8),
            (125, 8),
            (126, 7),
        ] {
            increments[raw] = increment;
        }
        for raw in 39..=116 {
            let rate = envelope_rate(raw);
            let (mut level, mut ticks) = (0i32, 0u32);
            while level < 16384 {
                level += (((20480 - level) * rate) >> 13).max(1);
                ticks += 1;
            }
            increments[raw as usize] = (16384 / ticks) as u16;
        }
        let knots = std::array::from_fn(|i| {
            if i >= 63 {
                16384
            } else {
                (512.0 * (33.0_f64.powf(i as f64 / 64.0) - 1.0)).floor() as u16
            }
        });
        Self {
            increments,
            knots,
            ramp: 16384,
            gain: 16384,
            increment: 16384,
            known: true,
            ramp_exact: true,
            unknown_progress: 0,
        }
    }
    /// Clear lifecycle state without rebuilding the mathematical caches.
    pub fn reset(&mut self) {
        self.ramp = 16384;
        self.gain = 16384;
        self.increment = 16384;
        self.known = true;
        self.ramp_exact = true;
        self.unknown_progress = 0;
    }
    /// All valid raw controls are covered. Invalid private input retains the
    /// defensive unknown-history path; public setters reject it transactionally.
    pub fn configure(&mut self, raw: u16) {
        self.increment = self.increments.get(raw as usize).copied().unwrap_or(0);
        if self.increment == 0 && self.gain < 16384 && self.known {
            self.unknown_progress = u32::from(self.ramp);
            self.known = false;
            self.ramp_exact = false;
        }
    }
    pub fn allocate(&mut self) {
        self.ramp = 0;
        self.gain = 0;
        self.known = self.increment != 0;
        self.ramp_exact = self.known;
        self.unknown_progress = 0;
        self.tick();
    }
    pub fn tick(&mut self) {
        if self.known && self.gain == 16384 {
            return;
        }
        if !self.known {
            // The ramp is monotone. A sum of known positive increments reaching
            // 16384 proves gain unity even when earlier increments were unknown.
            // Its stopped ramp location remains unknown and is not fabricated.
            self.unknown_progress += u32::from(self.increment);
            if self.unknown_progress >= 16384 {
                self.gain = 16384;
                self.known = true;
            }
        } else {
            self.ramp = (u32::from(self.ramp) + u32::from(self.increment)).min(16384) as u16;
            self.gain = self.curve(self.ramp);
        }
    }
    pub fn scale(&self, raw_lfo: i32) -> i32 {
        (raw_lfo * i32::from(self.gain)) >> 14
    }
    pub fn curve(&self, ramp: u16) -> u16 {
        if ramp >= 16384 {
            return 16384;
        }
        let i = usize::from(ramp >> 8);
        let a = u32::from(self.knots[i]);
        (a + (((u32::from(self.knots[i + 1]) - a) * u32::from(ramp & 255)) >> 8)) as u16
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rate(raw: u16) -> i32 {
        match raw {
            0..=57 => (8192.0 * 0.945_f64.powi(i32::from(raw))).ceil() as i32,
            58..=78 => 768 - 8 * i32::from(raw),
            79..=100 => 456 - 4 * i32::from(raw),
            101..=112 => 256 - 2 * i32::from(raw),
            113..=116 => 144 - i32::from(raw),
            _ => i32::from((140 - raw) / 2),
        }
    }
    #[test]
    fn generated_cache_has_only_proven_domain() {
        let f = Fade::new(rate);
        for r in 0..128 {
            assert_eq!(f.increments[r] != 0, supported(r as u16));
        }
        assert_eq!(
            (f.increments[64], f.increments[96], f.increments[116]),
            (321, 89, 34)
        );
    }
    #[test]
    fn retarget_and_edits_preserve_current_ramp_gain() {
        let mut f = Fade::new(rate);
        f.configure(64);
        f.allocate();
        let before = (f.ramp, f.gain, f.scale(-12345));
        f.configure(116);
        assert_eq!(before, (f.ramp, f.gain, f.scale(-12345)));
        f.tick();
        assert_eq!(f.ramp, 355);
    }
    #[test]
    fn saturation_stops_at_gain_unity_not_forced_ramp_endpoint() {
        let mut f = Fade::new(rate);
        f.configure(64);
        f.allocate();
        for _ in 0..100 {
            f.tick();
        }
        assert_eq!(f.gain, 16384);
        assert_eq!(f.ramp, 16371);
        for _ in 0..100 {
            f.tick();
        }
        assert_eq!(f.ramp, 16371);
    }
    #[test]
    fn invalid_private_input_marks_unknown_and_new_allocation_recovers() {
        let mut f = Fade::new(rate);
        f.configure(128);
        f.allocate();
        assert!(!f.known);
        f.configure(64);
        f.tick();
        assert!(!f.known);
        f.allocate();
        assert!(f.known);
        assert_eq!(f.ramp, 321);
        f.configure(128);
        assert!(!f.known);
        f.configure(0);
        f.tick();
        assert!(f.known);
        assert_eq!(f.gain, 16384);
    }

    #[test]
    fn sparse_tail_rates_complete_and_stop_at_gain_unity() {
        for (raw, increment, total_ticks, stopped_ramp) in [(6,7447,3,16384),(119,14,1152,16128),(127,6,2688,16128)] {
            let mut f=Fade::new(rate);f.configure(raw);f.allocate();
            assert_eq!(f.increment,increment);
            for _ in 1..total_ticks {assert!(f.gain<16384);f.tick();}
            assert_eq!((f.ramp,f.gain),(stopped_ramp,16384));
            for _ in 0..64 {f.tick();assert_eq!((f.ramp,f.gain),(stopped_ramp,16384));}
            f.configure(0);f.tick();assert_eq!((f.ramp,f.gain),(stopped_ramp,16384));
            f.configure(raw);f.allocate();assert_eq!(f.ramp,increment);
        }
    }
}
