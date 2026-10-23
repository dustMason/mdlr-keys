//! Recovered signed fixed-point per-part pan and shared stereo DAC sum.
//! Pan consumes the previous frame's Chorus output; that routing history is
//! owned by the shared effects chain, not by this allocation-free gain stage.

const Q: i64 = 1 << 23;
fn sat(x: i64) -> i64 {
    x.clamp(-Q, Q - 1)
}
fn mul(x: i64, c: i64) -> i64 {
    ((x * (c >> 16)) >> 7) + (((x >> 7) * ((c >> 9) & 127)) >> 7)
}

/// Compact integer reconstruction of the observed right-channel curve.
/// It matches all129 control entries; this is not an equal-power sine pan.
fn curve(index: usize) -> i64 {
    match index {
        63 | 64 => 89 * 256,
        0..=90 => (index as i64 * 1411 / 1000) * 256,
        91..=95 => 32256 + (index as i64 - 90) * 32,
        96..=107 => 32416 + (index as i64 - 95) * 16,
        108..=126 => 32608 + (index as i64 - 107) * 8,
        _ => 32767,
    }
}

fn at(index: usize, left: bool) -> i64 {
    curve(if left {
        127usize.saturating_sub(index)
    } else {
        index
    })
}

fn interpolated(position: i32, left: bool) -> i64 {
    let position = position.clamp(0, 32768) as usize;
    let index = position >> 8;
    let a = at(index, left);
    if index == 128 {
        return a;
    }
    a + (((at(index + 1, left) - a) * (position & 255) as i64) >> 8)
}

/// mode0 uses MIDI pan; mode1 adds LFO modulation; mode2 adds manual offset.
/// Manual raw52 requires ordinary assignment clamping, while auto_depth is
/// the existing amp_lfo_depth of bipolar-clamped effective raw52 (±4096).
pub(crate) fn control_targets(
    mode: u16,
    manual_raw: u16,
    auto_depth: i32,
    midi_pan: u8,
    lfo: i32,
) -> [i64; 2] {
    let cc = i32::from(midi_pan.min(127));
    let gains = if mode == 1 {
        let position = if cc == 127 { 32768 } else { cc * 256 };
        let position =
            position + ((lfo.clamp(-16384, 16384) * auto_depth.clamp(-4096, 4096)) >> 12);
        [interpolated(position, true), interpolated(position, false)]
    } else {
        let index = if mode == 2 {
            (cc + i32::from(manual_raw.min(127)) - 64).clamp(0, 127)
        } else {
            cc
        } as usize;
        [at(index, true), at(index, false)]
    };
    // The controller's split immediate encoding discards the low control bit.
    [(gains[0] >> 1) << 9, (gains[1] >> 1) << 9]
}

#[derive(Clone, Copy)]
pub(crate) struct Pan {
    targets: [i64; 2],
    gains: [i64; 2],
}

impl Pan {
    pub(crate) fn new() -> Self {
        Self {
            targets: control_targets(0, 64, 0, 64, 0),
            gains: [0; 2],
        }
    }
    /// Call after advancing the shared part LFO on each100Hz controller tick,
    /// and after the corresponding MIDI/parameter updates.
    pub(crate) fn update_control(
        &mut self,
        mode: u16,
        manual_raw: u16,
        auto_depth: i32,
        midi_pan: u8,
        lfo: i32,
    ) {
        self.targets = control_targets(mode, manual_raw, auto_depth, midi_pan, lfo);
    }
    pub(crate) fn reset(&mut self) {
        self.gains = [0; 2];
    }
    /// Input is the stereo post-Chorus tap. No new sample/queue delay is added.
    pub(crate) fn process(&mut self, left: i64, right: i64) -> (i64, i64) {
        for channel in 0..2 {
            let delta = sat(self.targets[channel] - self.gains[channel]);
            self.gains[channel] = sat(self.gains[channel] + (((delta >> 7) * 32) >> 7));
        }
        (
            sat(mul(sat(left), self.gains[0])),
            sat(mul(sat(right), self.gains[1])),
        )
    }
}

/// Apply once, after summing the panned upper/lower parts. Native saturation
/// precedes the divide-by-four; dividing each part separately is not equivalent.
pub(crate) fn dac_mix(upper: (i64, i64), lower: (i64, i64)) -> (i64, i64) {
    (
        sat(2 * (sat(upper.0) + sat(lower.0))) >> 2,
        sat(2 * (sat(upper.1) + sat(lower.1))) >> 2,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn center_matches_existing_gain_recurrence_without_added_delay() {
        let mut pan = Pan::new();
        let mut old_gain = 0;
        for _ in 0..20000 {
            old_gain += (((89 * 65536 - old_gain) >> 7) * 32) >> 7;
            assert_eq!(
                pan.process(1_000_000, -1_000_000),
                (mul(1_000_000, old_gain), mul(-1_000_000, old_gain))
            );
        }
        pan.reset();
        assert!(pan.process(1_000_000, 0).0 > 0);
    }
    #[test]
    fn manual_and_auto_reach_the_same_pan_rails() {
        assert_eq!(control_targets(2, 0, 0, 64, 0), [8388096, 0]);
        assert_eq!(control_targets(2, 127, 0, 64, 0), [0, 8388096]);
        assert_eq!(control_targets(1, 64, 4096, 64, -16384), [8388096, 0]);
        assert_eq!(control_targets(1, 64, 4096, 64, 16384), [0, 8388096]);
    }
    #[test]
    fn final_mix_clips_before_scaling_and_retains_cross_part_cancellation() {
        assert_eq!(dac_mix((Q - 1, -Q), (0, 0)), ((Q - 1) >> 2, -Q >> 2));
        assert_eq!(dac_mix((Q - 1, -Q), (-(Q - 1), Q - 1)), (0, -1));
    }
}

#[cfg(test)]
impl Pan {
    pub(crate) fn shared_cache_test_targets(&self) -> [i64; 2] {
        self.targets
    }
    pub(crate) fn shared_cache_test_gains(&self) -> [i64; 2] {
        self.gains
    }
}
