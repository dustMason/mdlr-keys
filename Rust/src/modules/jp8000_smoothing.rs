//! Independent JP controller write scheduler reconstructed from H8 control flow.
//! This contains no DSP program, ROM table, waveform, or captured machine state.
//! Use one scheduler per amp/filter envelope. Envelope/controller values advance
//! every 100 Hz tick even when this scheduler holds the downstream DSP writes.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Destination {
    Amp,
    Filter,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SmoothingScheduler {
    selector: u8,
}

impl Default for SmoothingScheduler {
    fn default() -> Self {
        Self { selector: 11 }
    }
}
impl SmoothingScheduler {
    pub fn selector(&self) -> u8 {
        self.selector
    }
    /// Full allocation clears the filter selector only; amp keeps its prior
    /// selector. The initial envelope advance then uses the ordinary tick gate.
    pub fn full_allocation(&mut self, destination: Destination) {
        if destination == Destination::Filter {
            self.selector = 0;
        }
    }
    /// ECBE legato retarget. Does not itself write a DSP target/rate.
    pub fn retarget(&mut self) {
        self.selector = 4;
    }
    /// Applied before the envelope step, matching the native LFO priority rules.
    /// `edge` means an active routed discontinuous LFO1 crossed its boundary.
    pub fn modulation(&mut self, active_depth: bool, edge: bool) {
        if active_depth && self.selector == 11 {
            self.selector = 10;
        }
        if edge && self.selector > 2 && self.selector <= 11 {
            self.selector = 2;
        }
    }
    /// `attack` is the stage AFTER this tick's envelope advance. The requested
    /// selector is the envelope rate class (0..11), not a DSP smoothing word.
    /// None holds target AND rate; Some writes both and returns the rate word.
    /// Filter None also holds its cutoff-dependent damping TARGET. It does not
    /// gate the separate allocation-time damping smoother-coefficient update.
    pub fn tick(&mut self, destination: Destination, attack: bool, requested: u8) -> Option<u16> {
        assert!(requested <= 11);
        if requested < self.selector && self.selector < 12 {
            self.selector = requested;
        }
        if self.selector == 10 {
            self.selector = 11;
            return Some(32);
        }
        let selected = self.selector;
        if attack && selected >= 12 {
            self.selector = match selected {
                13 => 12,
                12 => 11,
                _ => selected,
            };
            return None;
        }
        let rate = match selected {
            0 => 2048,
            1 => 512,
            2 => 256,
            3 => 208,
            4 => 144,
            5 => 128,
            6 => 96,
            7 => 80,
            8 => 74,
            9 => 55,
            11 => 8,
            // Native compatibility corner: leaving Attack while holding12/13
            // takes the unguarded non-Attack rate lookup. The adjacent words
            // encode DSP address0x2400 +48*n (amp), or100*n (filter). Native
            // release probes verify these unusual one-tick rate writes.
            12 | 13 => match destination {
                Destination::Amp => 0x2400 + 48 * u16::from(selected - 12),
                Destination::Filter => 100 * u16::from(selected - 12),
            },
            _ => unreachable!("only native scheduler selectors0..13 are constructed"),
        };
        self.selector = if attack && selected != 0 && selected != 11 {
            13
        } else {
            11
        };
        Some(rate)
    }
    // NoteOff and ordinary cached control edits deliberately do not mutate this
    // scheduler. Their stage/value changes are consumed by the next tick.
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retarget_attack_holds_two_ticks() {
        for dst in [Destination::Amp, Destination::Filter] {
            let mut s = SmoothingScheduler::default();
            s.retarget();
            assert_eq!(s.tick(dst, true, 11), Some(144));
            assert_eq!(s.selector(), 13);
            assert_eq!(s.tick(dst, true, 0), None);
            assert_eq!(s.selector(), 12);
            assert_eq!(s.tick(dst, true, 2), None);
            assert_eq!(s.selector(), 11);
            assert_eq!(s.tick(dst, true, 11), Some(8));
        }
    }
    #[test]
    fn release_during_native_hold() {
        for (dst, r13, r12) in [
            (Destination::Amp, 9264, 9216),
            (Destination::Filter, 100, 0),
        ] {
            for (skip, rate) in [(false, r13), (true, r12)] {
                let mut s = SmoothingScheduler::default();
                s.retarget();
                s.tick(dst, true, 11);
                if skip {
                    assert_eq!(s.tick(dst, true, 11), None);
                }
                assert_eq!(s.tick(dst, false, 11), Some(rate));
                assert_eq!(s.selector(), 11);
                assert_eq!(s.tick(dst, false, 11), Some(8));
            }
        }
    }
    #[test]
    fn modulation_cannot_cancel_a_hold() {
        let mut s = SmoothingScheduler::default();
        s.modulation(true, false);
        assert_eq!(s.tick(Destination::Amp, true, 11), Some(32));
        assert_eq!(s.selector(), 11);
        s.retarget();
        s.modulation(true, true);
        assert_eq!(s.tick(Destination::Amp, true, 11), Some(256));
        assert_eq!(s.selector(), 13);
        s.modulation(true, true);
        assert_eq!(s.tick(Destination::Amp, true, 0), None);
    }
    #[test]
    fn allocation_initialization_is_asymmetric() {
        let mut amp = SmoothingScheduler::default();
        amp.retarget();
        amp.tick(Destination::Amp, true, 11);
        amp.full_allocation(Destination::Amp);
        assert_eq!(amp.selector(), 13);
        assert_eq!(amp.tick(Destination::Amp, true, 11), None);
        let mut filter = amp;
        filter.full_allocation(Destination::Filter);
        assert_eq!(filter.tick(Destination::Filter, true, 11), Some(2048));
        assert_eq!(filter.selector(), 11);
    }
    #[test]
    fn ordinary_rates_remain_bounded() {
        for selector in 0..=11 {
            for attack in [false, true] {
                let mut s = SmoothingScheduler { selector };
                assert!(s.tick(Destination::Filter, attack, 11).is_some());
                assert!(s.selector() <= 13);
            }
        }
    }
}
