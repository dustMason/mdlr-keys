//! Independently reconstructed mono bookkeeping and portamento arithmetic.
//! No firmware, lookup table, audio, or captured machine state is included.
#[derive(Clone)]
pub(super) struct HeldKeys {
    counts: [u8; 128],
    total: u16,
}
impl HeldKeys {
    pub(super) fn new() -> Self {
        Self {
            counts: [0; 128],
            total: 0,
        }
    }
    /// Native counters saturate at127; a saturated press is not accepted.
    /// Return whether physical keys were held before this accepted press.
    pub(super) fn press(&mut self, note: u8) -> Option<bool> {
        let count = self.counts.get_mut(note as usize)?;
        if *count == 127 {
            return None;
        }
        let overlap = self.total != 0;
        *count += 1;
        self.total += 1;
        Some(overlap)
    }
    pub(super) fn release(&mut self, note: u8) -> bool {
        if let Some(c) = self.counts.get_mut(note as usize) {
            if *c > 0 {
                *c -= 1;
                self.total -= 1;
                return true;
            }
        }
        false
    }
    pub(super) fn highest(&self) -> Option<u8> {
        (0..128)
            .rev()
            .find(|&i| self.counts[i] != 0)
            .map(|i| i as u8)
    }
    pub(super) fn is_empty(&self) -> bool {
        self.total == 0
    }
    pub(super) fn clear(&mut self) {
        self.counts.fill(0);
        self.total = 0;
    }
}
#[derive(Clone, Copy, Default)]
pub(super) struct Glide {
    pub(super) initial_cents: i32,
    pub(super) offset_cents: i32,
    pub(super) remaining: u16,
}
impl Glide {
    /// Caller determines the correct source note. In poly mode this includes the
    /// last allocated note after release. Only Mono with Legato enabled suppresses
    /// this history across a physical key gap.
    pub(super) fn start(&mut self, initial_cents: i32) {
        self.initial_cents = initial_cents;
        self.offset_cents = initial_cents;
        self.remaining = 8192;
    }
    /// One100Hz control update. Rate is the existing exact envelope_rate(raw70).
    /// The timer continues while portamento is off; its audible offset is zero.
    pub(super) fn tick(&mut self, rate: u16, enabled: bool) -> i32 {
        self.remaining = self.remaining.saturating_sub(rate);
        self.offset_cents = if enabled {
            ((i64::from(self.initial_cents) * i64::from(self.remaining)) >> 13) as i32
        } else {
            0
        };
        self.offset_cents
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn highest_fallback_and_duplicate_counts() {
        let mut k = HeldKeys::new();
        assert_eq!(k.press(60), Some(false));
        for n in [67, 64, 55] {
            assert_eq!(k.press(n), Some(true));
        }
        k.release(55);
        assert_eq!(k.highest(), Some(67));
        k.press(60);
        k.release(60);
        k.release(67);
        k.release(64);
        assert_eq!(k.highest(), Some(60));
        k.release(60);
        assert!(k.is_empty());
        k.release(60);
        assert!(k.is_empty());
    }
    #[test]
    fn counters_are_bounded_and_invalid_notes_do_not_alias() {
        let mut k = HeldKeys::new();
        for _ in 0..127 {
            assert!(k.press(127).is_some());
        }
        assert_eq!(k.press(127), None);
        assert_eq!(k.press(255), None);
        k.release(255);
        for _ in 0..127 {
            k.release(127);
        }
        assert!(k.is_empty());
        k.press(64);
        k.clear();
        assert!(k.is_empty());
    }
    #[test]
    fn fixed_duration_signed_glide_and_off_timer() {
        let mut g = Glide::default();
        g.start(-1200);
        assert_eq!(g.tick(256, true), -1163);
        for _ in 1..32 {
            g.tick(256, true);
        }
        assert_eq!(g.offset_cents, 0);
        g.start(1200);
        assert_eq!(g.tick(256, true), 1162);
        assert_eq!(g.tick(256, false), 0);
        assert_eq!(g.remaining, 7680);
        assert_eq!(g.tick(256, true), 1087);
        g.tick(8192, true);
        assert_eq!(g.remaining, 0);
    }
}
