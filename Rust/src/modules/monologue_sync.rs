//! Two-sample polynomial edge correction for free and hard-synced triangles.
//!
//! Only edges actually traversed are emitted. A reset can cancel a future
//! natural edge, but must retain the tail of an edge traversed before reset.
//! The current sample uses the known next oscillator interval; this adds no
//! input buffering. Triangle corrections precede its analog RC and wavefolder.

/// Triangle-only BLAMP for a free-running divider oscillator.
///
/// The caller supplies a phase in [0,1) and a positive increment no larger
/// than .2. At most one half-cycle corner can occur in that interval. Like
/// SyncOscillator, it uses the known next interval without buffering audio.
#[derive(Clone, Copy, Default)]
pub(super) struct FreeTriangle {
    carry: f32,
}

impl FreeTriangle {
    pub(super) fn clear(&mut self) {
        self.carry = 0.0;
    }

    #[inline]
    pub(super) fn sample(&mut self, phase: f32, inc: f32) -> f32 {
        let mut output = 1.0 - 4.0 * (phase - 0.5).abs() + self.carry;
        self.carry = 0.0;
        let corner = if phase < 0.5 { 0.5 } else { 1.0 };
        if inc > 0.0 && phase + inc >= corner {
            let t = (corner - phase) / inc;
            let u = 1.0 - t;
            let slope_jump = if corner == 0.5 { -8.0 * inc } else { 8.0 * inc };
            output += slope_jump * u * u * u / 6.0;
            self.carry = slope_jump * t * t * t / 6.0;
        }
        output
    }
}

#[derive(Default)]
pub(super) struct SyncOscillator {
    carry: [f32; 2],
}

impl SyncOscillator {
    pub fn clear(&mut self) {
        self.carry = [0.0; 2];
    }

    /// Return [triangle, switched saw]. `reset` is a fraction of this internal
    /// sample, and `inc` is the slave's phase increment before that reset.
    pub fn sample(&mut self, phase: f32, inc: f32, reset: Option<f32>, threshold: f32) -> [f32; 2] {
        let (value, _) = value_slope(phase, threshold, false);
        let mut output = [value[0] + self.carry[0], value[1] + self.carry[1]];
        self.carry = [0.0; 2];
        if let Some(t) = reset {
            // Exclude an edge coinciding with reset. Taking its left limit
            // combines the natural edge and reset into one net discontinuity.
            self.segment(phase, inc, 0.0, t, false, threshold, &mut output);
            let (before, before_slope) = value_slope(phase + inc * t, threshold, true);
            let (after, after_slope) = value_slope(0.0, threshold, false);
            for i in 0..2 {
                self.edge(
                    i,
                    t,
                    after[i] - before[i],
                    inc * (after_slope[i] - before_slope[i]),
                    &mut output,
                );
            }
            self.segment(0.0, inc, t, 1.0, true, threshold, &mut output);
        } else {
            self.segment(phase, inc, 0.0, 1.0, true, threshold, &mut output);
        }
        output
    }

    fn edge(&mut self, i: usize, t: f32, step: f32, slope: f32, output: &mut [f32; 2]) {
        let u = 1.0 - t;
        output[i] += 0.5 * step * u * u + slope * u * u * u / 6.0;
        self.carry[i] += -0.5 * step * t * t + slope * t * t * t / 6.0;
    }

    fn segment(
        &mut self,
        phase: f32,
        inc: f32,
        begin: f32,
        end: f32,
        include_end: bool,
        threshold: f32,
        output: &mut [f32; 2],
    ) {
        let finish = phase + inc * (end - begin);
        let comparator = (threshold + 1.0) * 0.25;
        // Increments are bounded by .2. Two cycles cover every possible edge,
        // including a comparator crossing just after a natural wrap.
        for cycle in [0.0, 1.0] {
            for (index, boundary) in [0.5, 1.0, comparator, 1.0 - comparator]
                .into_iter()
                .enumerate()
            {
                // At endpoint thresholds, comparator edges coincide with ramp
                // edges. Emit the latter exactly once with their net jump.
                if index >= 2 && (threshold <= -1.0 || threshold >= 1.0) {
                    continue;
                }
                // Near a rail, float rounding can merge a comparator crossing
                // with .5 or 1 even while threshold is strictly inside (-1,1).
                // value_slope already gives that boundary's net jump; emitting
                // it again would also duplicate the triangle's BLAMP corner.
                if index >= 2 && (boundary == 0.0 || boundary == 0.5 || boundary == 1.0) {
                    continue;
                }
                let position = cycle + boundary;
                if position <= phase || position > finish || (!include_end && position == finish) {
                    continue;
                }
                let t = begin + (position - phase) / inc;
                let (left, left_slope) = value_slope(boundary, threshold, true);
                let (right, right_slope) = value_slope(boundary, threshold, false);
                for i in 0..2 {
                    self.edge(
                        i,
                        t,
                        right[i] - left[i],
                        inc * (right_slope[i] - left_slope[i]),
                        output,
                    );
                }
            }
        }
    }
}

fn value_slope(mut phase: f32, threshold: f32, left: bool) -> ([f32; 2], [f32; 2]) {
    if phase >= 1.0 {
        phase -= 1.0;
    }
    if left && phase == 0.0 {
        phase = 1.0;
    }
    let second = if left { phase > 0.5 } else { phase >= 0.5 };
    let triangle = 1.0 - 4.0 * (phase - 0.5).abs();
    let raw_saw = 4.0 * phase - if second { 3.0 } else { 1.0 };
    let edge = (threshold + 1.0) * 0.25;
    let inverted = if threshold <= -1.0 {
        true
    } else if threshold >= 1.0 {
        false
    } else if left {
        phase > edge && phase <= 1.0 - edge
    } else {
        phase >= edge && phase < 1.0 - edge
    };
    let sign = if inverted { -1.0 } else { 1.0 };
    (
        [triangle, sign * raw_saw],
        [if second { -4.0 } else { 4.0 }, sign * 4.0],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_triangle_matches_the_proven_no_reset_path() {
        for start in [0.0_f32, 0.137, 0.49, 0.5, 0.731, 0.99] {
            for inc in [0.00001_f32, 0.013, 0.049, 0.125, 0.2] {
                let mut free = FreeTriangle::default();
                let mut sync = SyncOscillator::default();
                let mut phase = start;
                for _ in 0..512 {
                    assert!(
                        (free.sample(phase, inc) - sync.sample(phase, inc, None, 1.0)[0]).abs()
                            < 1e-6
                    );
                    phase += inc;
                    if phase >= 1.0 {
                        phase -= 1.0;
                    }
                }
            }
        }
    }

    #[test]
    fn free_triangle_reset_clears_previous_corner_tail() {
        let mut osc = FreeTriangle::default();
        osc.sample(0.49, 0.02);
        assert!(osc.carry.abs() > 1e-4);
        osc.clear();
        assert_eq!(osc.sample(0.2, 0.02), 1.0 - 4.0 * (0.2_f32 - 0.5).abs());
    }

    #[test]
    fn reset_cancels_future_wrap_but_keeps_a_previous_wrap_tail() {
        let mut after = SyncOscillator::default();
        let mut before = SyncOscillator::default();
        // A wrap at .6 is canceled by reset at .5. A wrap at .3 survives.
        let a = after.sample(0.94, 0.1, Some(0.5), 1.0);
        let b = before.sample(0.97, 0.1, Some(0.5), 1.0);
        assert!((a[1] - (0.76 - 1.96 * 0.125)).abs() < 2e-6);
        assert!((b[1] - (0.88 - 0.49 - 0.08 * 0.125)).abs() < 2e-6);
        assert!((after.carry[1] - 1.96 * 0.125).abs() < 2e-6);
        assert!((before.carry[1] - (0.09 + 0.08 * 0.125)).abs() < 2e-6);
    }

    #[test]
    fn exact_wrap_reset_matches_a_natural_wrap() {
        for threshold in [-1.0, -0.6, 0.0, 0.7, 1.0] {
            let mut natural = SyncOscillator::default();
            let mut reset = SyncOscillator::default();
            let a = natural.sample(0.875, 0.125, None, threshold);
            let b = reset.sample(0.875, 0.125, Some(1.0), threshold);
            assert_eq!(a, b);
            assert_eq!(natural.carry, reset.carry);
        }
    }

    #[test]
    fn endpoint_saws_keep_both_natural_ramp_edges() {
        for phase in [0.48, 0.98] {
            let mut positive = SyncOscillator::default();
            let mut negative = SyncOscillator::default();
            let a = positive.sample(phase, 0.04, None, 1.0);
            let b = negative.sample(phase, 0.04, None, -1.0);
            assert!((a[1] + b[1]).abs() < 1e-6);
            assert!((positive.carry[1] + negative.carry[1]).abs() < 1e-6);
            assert!((positive.carry[1] - 0.25).abs() < 2e-6);
        }
    }

    #[test]
    fn adjacent_float_thresholds_do_not_duplicate_coincident_edges() {
        let below_one = f32::from_bits(1.0_f32.to_bits() - 1);
        let above_minus_one = -below_one;
        for (near, endpoint) in [(below_one, 1.0), (above_minus_one, -1.0)] {
            for phase in [0.48, 0.98] {
                for reset in [None, Some(0.5)] {
                    let mut a = SyncOscillator::default();
                    let mut b = SyncOscillator::default();
                    let x = a.sample(phase, 0.04, reset, near);
                    let y = b.sample(phase, 0.04, reset, endpoint);
                    for i in 0..2 {
                        assert!(
                            (x[i] - y[i]).abs() < 2e-6,
                            "{near} {phase} {reset:?}: {x:?} {y:?}"
                        );
                        assert!((a.carry[i] - b.carry[i]).abs() < 2e-6);
                    }
                }
            }
        }
    }
}
