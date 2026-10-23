//! Handwritten stereo chorus/flanger/phaser, processing at 88.2 kHz.
//!
//! Named effect settings describe delay ranges, feedback and one-pole filters.
//! No firmware program, lookup table, captured phase, or recorded audio is used.
//! The dry path is current-sample; all history belongs to the wet effect.
use super::delay::quantize_eram;
const HISTORY: usize = 4096;
const Q23: i64 = 1 << 23;
fn sat(x: i64) -> i64 {
    x.clamp(-Q23, Q23 - 1)
}
fn wrap(x: i64) -> i64 {
    ((x + Q23) & (2 * Q23 - 1)) - Q23
}
// Preserve the two partial-product roundings in the original fixed-point signal path.
fn mul(x: i64, c: i64) -> i64 {
    (x * (c >> 16) >> 7) + ((x >> 7) * ((c >> 9) & 127) >> 7)
}
fn complement(c: i64) -> i64 {
    (!c) & (Q23 - 1)
}
fn feedback_mul(x: i64, q13: i64) -> i64 {
    (x * (q13 >> 7) >> 6) + ((x >> 7) * (q13 & 127) >> 6)
}

#[derive(Clone, Copy)]
struct Settings {
    input_pole: i64,
    feedback_pole: i64,
    feedback_gain: i64,
    minimum: i64,
    sweep: i64,
    step: i64,
    return_pole: i64,
    stereo_offset: i64,
}
impl Settings {
    // Delay values are native samples; frequency is microhertz. Filter poles use Q14.
    const fn new(
        loss: i64,
        feedback_pole: i64,
        feedback_gain: i64,
        minimum: i64,
        sweep: i64,
        microhertz: i64,
        return_pole: i64,
        stereo_offset: i64,
    ) -> Self {
        Self {
            input_pole: (16384 - loss) * 512,
            feedback_pole: feedback_pole * 512,
            feedback_gain,
            minimum: minimum * 4096,
            sweep: sweep * 4096,
            step: (microhertz * 16777216 + 44_100_000_000) / 88_200_000_000,
            return_pole: return_pole * 512,
            stereo_offset: stereo_offset * 4096,
        }
    }
    fn for_kind(kind: u16) -> Self {
        match kind {
            0 => Self::new(113, 0, 0, 1152, 1536, 63_086, 8576, 2), // Super Chorus Slow
            1 => Self::new(113, 0, 0, 512, 232, 420_570, 8320, 2),  // Super Chorus Mid
            2 => Self::new(433, 0, 0, 1280, 44, 4_037_476, 10175, 2), // Super Chorus Fast
            3 => Self::new(1024, 8704, -2688, 1536, 1280, 84_114, 4096, 2), // Clear
            4 => Self::new(513, 8448, 6400, 128, 100, 315_428, 4096, 0), // Flanger Slow
            5 => Self::new(1, 8448, 6528, 64, 224, 357_485, 4096, 0), // Flanger Deep
            6 => Self::new(769, 8704, 5888, 128, 60, 1_682_281, 6144, 0), // Flanger Fast
            7 => Self::new(1, 8832, -7826, 0, 20, 84_114, 4096, 1), // Deep Phasing Slow
            8 => Self::new(417, 8832, -5632, 224, 1280, 84_114, 4096, 1), // Jet Phasing
            9 => Self::new(1, 8832, -4864, 1536, 40, 168_228, 4096, 1), // Twisting
            10 => Self::new(2032, 8896, -3072, 1024, 10, 0, 8192, 80), // Freeze Phase 1
            _ => Self::new(2032, 8896, -1536, 3072, 10, 0, 8192, 80), // Freeze Phase 2
        }
    }
}

pub(crate) struct Chorus {
    settings: Settings,
    kind: u16,
    level_target: i64,
    level: i64,
    history: Box<[i32]>,
    position: usize,
    input_lp: i64,
    feedback_lp: i64,
    feedback: i64,
    dc: i64,
    phase: i64,
    triangle: i64,
    wet: [i64; 2],
    return_lp: [i64; 2],
}
impl Chorus {
    /// Allocate once per part, outside the audio callback (16 KiB).
    pub(crate) fn new() -> Self {
        Self {
            settings: Settings::for_kind(0),
            kind: 0,
            level_target: 0,
            level: 0,
            history: vec![0; HISTORY].into_boxed_slice(),
            position: 0,
            input_lp: 0,
            feedback_lp: 0,
            feedback: 0,
            dc: 0,
            phase: 0,
            triangle: 0,
            wet: [0; 2],
            return_lp: [0; 2],
        }
    }
    /// Keep the free-running phase and delay history when the controls change.
    pub(crate) fn configure(&mut self, kind: u16, level: u16) {
        let kind=kind.min(11);
        if kind!=self.kind {self.load_kind(kind);}
        self.level_target=Self::level_target(level);
    }
    pub(crate) fn level_target(level: u16) -> i64 {
        let r = i64::from(level.min(127));
        (32767 * r * r / 16129 / 2) * 512
    }
    pub(crate) fn free_step(kind: u16) -> i64 {
        Settings::for_kind(kind.min(11)).step
    }
    // Native16272 is an explicit type-program event, including same-value writes.
    // Only coefficients/rate change; histories and level target survive.
    pub(crate) fn load_kind(&mut self, kind: u16) {
        self.kind = kind.min(11);
        self.settings = Settings::for_kind(self.kind);
    }
    pub(crate) fn publish(&mut self, level: i64, step: i64) {
        self.level_target = level;
        self.settings.step = step;
    }
    /// Convert the 100Hz controller's Q32 cycle increment to the DSP's Q24
    /// per-sample rate. Turning sync off retains the last rate until type changes.
    pub(crate) fn configure_sync(&mut self, increment:Option<u32>) -> i64 {
        if let Some(increment)=increment { self.settings.step=i64::from(increment)/(882*256); }
        self.settings.step
    }
    /// Hard reset, in-place. MIDI note-off/all-notes-off should not call this.
    pub(crate) fn reset(&mut self) {
        self.history.fill(0);
        self.position = 0;
        self.level = 0;
        self.input_lp = 0;
        self.feedback_lp = 0;
        self.feedback = 0;
        self.dc = 0;
        self.phase = 0;
        self.triangle = 0;
        self.wet = [0; 2];
        self.return_lp = [0; 2];
    }
    fn tap(&self, offset: i64) -> i64 {
        let index = (self.position + (offset as usize >> 12)) & (HISTORY - 1);
        let fraction = (offset & 4095) << 11;
        mul(i64::from(self.history[index]), complement(fraction))
            + mul(
                i64::from(self.history[(index + 1) & (HISTORY - 1)]),
                fraction,
            )
    }
    /// Advance even at level zero, preserving native history for a later enable.
    pub(crate) fn process(&mut self, left: i64, right: i64) -> (i64, i64) {
        let c = self.settings;
        self.level = sat(self.level + ((self.level_target - self.level) >> 7));
        let average = sat((left >> 1) + (right >> 1));
        self.input_lp =
            sat(mul(average, complement(c.input_pole)) + mul(self.input_lp, c.input_pole));
        let highpassed = sat(average - self.input_lp);
        self.feedback_lp = sat(mul(
            sat(feedback_mul(self.feedback, c.feedback_gain)),
            complement(c.feedback_pole),
        ) + mul(self.feedback_lp, c.feedback_pole));
        let input = sat(highpassed + self.feedback_lp);
        let write = sat((input * 127 >> 7) + ((input >> 7) * 96 >> 7) + self.dc);
        self.dc = sat(self.dc + (-write >> 7) + ((write >> 7) * 64 >> 7));
        self.history[self.position] = quantize_eram(write) as i32;
        let center = c.minimum + (c.sweep >> 1);
        let offsets = [
            center + mul(self.triangle, c.sweep),
            center + mul(-self.triangle, c.sweep) + c.stereo_offset,
        ];
        self.phase = wrap(self.phase + c.step);
        self.triangle = ((if self.phase < 0 {
            !self.phase
        } else {
            self.phase
        }) & (Q23 - 1))
            - (Q23 >> 1);
        let interpolated = [self.tap(offsets[0]), self.tap(offsets[1])];
        self.feedback = sat(interpolated[1]);
        let mixed = [
            sat(self.wet[0] + (self.wet[1] * -90 >> 7)),
            sat(self.wet[1] + (self.wet[0] * -90 >> 7)),
        ];
        self.return_lp = [
            sat(mul(mixed[0], complement(c.return_pole)) + mul(self.return_lp[0], c.return_pole)),
            sat(mul(mixed[1], complement(c.return_pole)) + mul(self.return_lp[1], c.return_pole)),
        ];
        self.wet = [
            sat(mul(sat(interpolated[0]), self.level)),
            sat(mul(sat(interpolated[1]), self.level)),
        ];
        self.position = self.position.wrapping_sub(1) & (HISTORY - 1);
        (
            sat((left * 116 >> 7) + (self.return_lp[0] * 116 >> 7)),
            sat((right * 116 >> 7) + (self.return_lp[1] * 116 >> 7)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dry_output_is_current_sample_and_reset_preserves_controls() {
        let mut c = Chorus::new();
        c.configure(9, 0);
        assert_eq!(c.process(1000000, -1000000), (906250, -906250));
        c.reset();
        assert_eq!(c.process(1000000, -1000000), (906250, -906250));
    }
    #[test]
    fn all_effect_ranges_fit_preallocated_history() {
        for kind in 0..12 {
            let c = Settings::for_kind(kind);
            assert!(c.minimum >= 0);
            assert!((c.minimum + c.sweep + c.stereo_offset) / 4096 + 1 < HISTORY as i64);
        }
    }
}

#[cfg(test)]
impl Chorus {
    pub(crate) fn shared_cache_test_targets(&self) -> [i64; 3] {
        [i64::from(self.kind), self.settings.step, self.level_target]
    }
    pub(crate) fn shared_cache_test_free_step(kind: u16) -> i64 {
        Settings::for_kind(kind).step
    }
    pub(crate) fn shared_cache_test_history(&self) -> [i64; 13] {
        [
            self.level,
            self.position as i64,
            self.input_lp,
            self.feedback_lp,
            self.feedback,
            self.dc,
            self.phase,
            self.triangle,
            self.wet[0],
            self.wet[1],
            self.return_lp[0],
            self.return_lp[1],
            self.history
                .iter()
                .fold(0i64, |a, &v| a.wrapping_mul(31).wrapping_add(i64::from(v))),
        ]
    }
}
