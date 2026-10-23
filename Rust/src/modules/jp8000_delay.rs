//! Recovered JP-8000 per-part delay, operating at 88.2 kHz.
//!
//! Input is the signed24 mono EQ tap; output is the signed24 stereo tap
//! immediately before Chorus. The 112/128 dry gain belongs to this stage.
//! This contains independent arithmetic/control laws, no firmware program
//! words, extracted state, or factory-patch data.

const Q: i64 = 1 << 23;
const HISTORY: usize = 1 << 17;

fn sat(value: i64) -> i64 {
    value.clamp(-Q, Q - 1)
}

fn mul(value: i64, coefficient: i64, shift: u32) -> i64 {
    ((value * (coefficient >> 16)) >> shift)
        + (((value >> 7) * ((coefficient >> 9) & 127)) >> shift)
}

/// ERAM's signed14 mantissa and two-bit exponent round trip. Negative values
/// round down, matching the arithmetic shifts in the native memory codec.
pub(crate) fn quantize_eram(value: i64) -> i64 {
    let value = sat(value);
    for shift in [4, 6, 8, 10] {
        let mantissa = value >> shift;
        if (-8192..=8191).contains(&mantissa) {
            return mantissa << shift;
        }
    }
    unreachable!("signed24 always fits ERAM's largest exponent")
}

fn curve(raw: u16) -> i64 {
    let raw = raw.min(127) as i64;
    32767 * raw * raw / 16129
}

/// Free-time law. The controller's raw2 entry has one additional sample;
/// all other entries follow the compact integer-millisecond ranges below.
pub(crate) fn free_time_frames(raw: u16, kind: u16) -> usize {
    let raw = raw.min(127) as usize;
    let milliseconds = match raw {
        0 => 1,
        1..=40 => 2 * raw,
        41..=84 => 80 + 5 * (raw - 40),
        85..=110 => 300 + 10 * (raw - 84),
        111..=113 => 560 + 20 * (raw - 110),
        114..=115 => 620 + 30 * (raw - 113),
        116..=118 => 680 + 40 * (raw - 115),
        _ => 800 + 50 * (raw - 118),
    };
    let frames = milliseconds * 441 / 5 + usize::from(raw == 2);
    frames
        >> if kind == 2 {
            2
        } else if kind == 3 {
            3
        } else {
            0
        }
}

/// Musical division measured in quarter notes. Native timing first truncates
/// 60000/BPM to integer milliseconds. Panning modes have a half-time tap, so
/// their feedback period is doubled. Excessively long times are octave-folded.
pub(crate) fn synced_time_frames(kind: u16, division: u16, bpm: u16) -> usize {
    const RATIOS: [(usize, usize); 11] = [
        (1, 1),
        (1, 4),
        (1, 3),
        (3, 8),
        (1, 2),
        (2, 3),
        (3, 4),
        (1, 1),
        (4, 3),
        (3, 2),
        (2, 1),
    ];
    let (numerator, denominator) = RATIOS[division.min(10) as usize];
    let period = 60000 / bpm.clamp(20, 250) as usize;
    let mut frames = period * numerator * 88200 / (denominator * 1000);
    if kind < 2 {
        frames *= 2;
    }
    while frames > 110250 {
        frames >>= 1;
    }
    frames
}

pub(crate) struct Delay {
    history: Box<[i32]>,
    cursor: usize,
    kind: u16,
    time: usize,
    feedback_target: i64,
    level_target: i64,
    feedback: i64,
    level: i64,
    lowpass: i64,
    dc: i64,
    wet_long: i64,
    wet_short: i64,
}

impl Delay {
    /// Allocate once on the non-audio construction path, once per part.
    pub(crate) fn new() -> Self {
        Self {
            history: vec![0; HISTORY].into_boxed_slice(),
            cursor: 0,
            kind: 0,
            time: free_time_frames(64, 0),
            feedback_target: 0,
            level_target: 0,
            feedback: 0,
            level: 0,
            lowpass: 0,
            dc: 0,
            wet_long: 0,
            wet_short: 0,
        }
    }

    /// Update targets without allocating or discarding the current tail.
    pub(crate) fn configure(
        &mut self,
        kind: u16,
        time: u16,
        feedback: u16,
        level: u16,
        sync: u16,
        bpm: u16,
    ) {
        self.kind = kind.min(4);
        self.time = if sync == 0 {
            free_time_frames(time, self.kind)
        } else {
            synced_time_frames(self.kind, sync, bpm)
        };
        self.feedback_target = (curve(feedback) >> 1) << 9;
        self.level_target = (curve(level) >> 1) << 8;
    }

    /// Clear the existing storage in place; retain the configured controls.
    pub(crate) fn reset(&mut self) {
        self.history.fill(0);
        self.cursor = 0;
        self.feedback = 0;
        self.level = 0;
        self.lowpass = 0;
        self.dc = 0;
        self.wet_long = 0;
        self.wet_short = 0;
    }

    /// Advance every native sample, including when wet level is zero.
    /// No allocation, I/O, worker queue or dry-path buffering occurs here.
    pub(crate) fn process(&mut self, input: i64) -> (i64, i64) {
        let input = sat(input);
        self.feedback = sat(self.feedback + (sat(self.feedback_target - self.feedback) >> 7));
        self.level = sat(self.level + (sat(self.level_target - self.level) >> 8));
        let first = self.history[(self.cursor + HISTORY - self.time) & (HISTORY - 1)] as i64;
        let second = self.history[(self.cursor + HISTORY - self.time / 2) & (HISTORY - 1)] as i64;
        let damping = if self.kind < 2 {
            103
        } else if self.kind == 4 {
            96
        } else {
            107
        } << 16;
        let excitation = sat(mul(first, self.feedback, 7) + ((input * 96) >> 7));
        self.lowpass =
            sat(mul(excitation, (!damping) & (Q - 1), 7) + mul(self.lowpass, damping, 7));
        let write = sat(self.dc + ((self.lowpass * 127) >> 7) + (((self.lowpass >> 7) * 96) >> 7));
        self.dc = sat(self.dc + ((-write) >> 7) + (((write >> 7) * 64) >> 7));
        self.history[self.cursor] = quantize_eram(write) as i32;
        self.cursor = (self.cursor + 1) & (HISTORY - 1);

        // The DSP reads the previous frame's wet gains through its rotating
        // IRAM. The dry signal is current-frame EQ, with no added delay.
        let dry = (input * 112) >> 7;
        let left = sat(dry
            + if self.kind == 0 {
                self.wet_short
            } else {
                self.wet_long
            });
        let right = sat(dry
            + if self.kind == 1 || self.kind == 2 {
                self.wet_short
            } else {
                self.wet_long
            });
        self.wet_long = sat(mul(first, self.level, 6));
        self.wet_short = sat(mul(second, self.level, 6));
        (left, right)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dry_path_has_no_added_sample_delay() {
        let mut delay = Delay::new();
        assert_eq!(delay.process(1_000_000), (875_000, 875_000));
        assert_eq!(delay.process(0), (0, 0));
    }

    #[test]
    fn compression_and_time_endpoints() {
        assert_eq!(quantize_eram(-259816), -259840);
        assert_eq!(quantize_eram(0), 0);
        assert_eq!(quantize_eram(-Q), -Q);
        assert_eq!(free_time_frames(2, 0), 353);
        assert_eq!(free_time_frames(127, 0), 110250);
        assert_eq!(free_time_frames(0, 3), 11);
        assert_eq!(synced_time_frames(0, 7, 120), 88200);
        assert_eq!(synced_time_frames(4, 7, 120), 44100);
    }

    #[test]
    fn level_zero_preserves_history_and_reset_clears_in_place() {
        let mut delay = Delay::new();
        delay.configure(4, 64, 0, 0, 0, 120);
        delay.process(1_000_000);
        for _ in 0..1000 {
            delay.process(0);
        }
        delay.configure(4, 64, 0, 127, 0, 120);
        assert!((0..20000).any(|_| delay.process(0).0 != 0));
        let pointer = delay.history.as_ptr();
        delay.reset();
        assert_eq!(pointer, delay.history.as_ptr());
        for _ in 0..20000 {
            assert_eq!(delay.process(0), (0, 0));
        }
    }
}
