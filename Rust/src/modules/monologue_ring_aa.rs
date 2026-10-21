//! Bounded quadrature antialiasing for the static two-input diode transfer.
//!
//! Integrate the declared lookup transfer along the straight source-voltage
//! segment from the previous internal sample to the current one. The four
//! Gauss–Legendre nodes are fixed: no solver, allocation, or data-dependent loop.
//! This approximates the average of a linearly interpolated input interval; it
//! does not change the diode constants or normalize the output gain. Its nominal
//! phase delay is half an internal sample. Advance it even when ring is not
//! selected, so a later selection never reuses stale source voltages.

#[cfg(any(feature = "analysis", test))]
use super::ring;

#[cfg(any(feature = "analysis", test))]
#[derive(Clone, Default)]
pub(super) struct RingAntialias {
    previous: [f32; 2],
}

#[cfg(any(feature = "analysis", test))]
impl RingAntialias {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn reset(&mut self) {
        self.previous = [0.0; 2];
    }

    #[inline]
    /// Return (interval-averaged dry source A, averaged bridge output).
    /// Use the dry average only while ring is selected, to align its phase.
    pub(super) fn process(&mut self, a: f32, b: f32) -> (f32, f32) {
        if !a.is_finite() || !b.is_finite() {
            self.reset();
            return (0.0, 0.0);
        }
        // Convex interpolation avoids overflow in (current - previous) for
        // arbitrary finite inputs; normal oscillator inputs are much smaller.
        let mut output = 0.0;
        for (t, weight) in [
            (0.069_431_84_f32, 0.173_927_43_f32),
            (0.330_009_5_f32, 0.326_072_57_f32),
            (0.669_990_54_f32, 0.326_072_57_f32),
            (0.930_568_16_f32, 0.173_927_43_f32),
        ] {
            let av = (1.0 - t) * self.previous[0] + t * a;
            let bv = (1.0 - t) * self.previous[1] + t * b;
            output += weight * ring::transfer(av, bv);
        }
        let dry = 0.5 * self.previous[0] + 0.5 * a;
        self.previous = [a, b];
        (dry, output)
    }
}

/// Exact interval average of the original scalar-product ring approximation.
///
/// Source inputs are linearly interpolated over one internal sample. Their
/// product is quadratic, so mean(a)*mean(b) + delta(a)*delta(b)/12 is its exact
/// integral in real arithmetic. This preserves the earlier operating model;
/// it is not a claim that the physical diode bridge is an ideal multiplier.
#[derive(Clone, Default)]
pub(super) struct ProductAntialias {
    previous: [f32; 2],
}

impl ProductAntialias {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn reset(&mut self) {
        self.previous = [0.0; 2];
    }

    /// Advance on every oscillator mode using the raw oscillator outputs.
    /// Apply the dry average only when the returned product is selected.
    #[inline]
    pub(super) fn process(&mut self, a: f32, b: f32) -> (f32, f32) {
        if !a.is_finite() || !b.is_finite() {
            self.reset();
            return (0.0, 0.0);
        }
        let mean_a = 0.5 * self.previous[0] + 0.5 * a;
        let mean_b = 0.5 * self.previous[1] + 0.5 * b;
        let delta_a = a - self.previous[0];
        let delta_b = b - self.previous[1];
        let product = mean_a * mean_b + delta_a * delta_b * (1.0 / 12.0);
        self.previous = [a, b];
        (mean_a, product)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_average_matches_independent_exact_gauss_integral() {
        // Two-point Gauss integrates the quadratic product exactly. Evaluate
        // interpolated voltages directly in f64, independent of the covariance
        // formula used by the real-time implementation.
        let nodes = [0.211_324_865_405_187_13_f64, 0.788_675_134_594_812_9_f64];
        for a0 in [-2.2_f32, -0.13, 1.7] {
            for b0 in [-2.0_f32, 0.03, 1.2] {
                for a1 in [-1.8_f32, 0.1, 2.2] {
                    for b1 in [-1.7_f32, 0.2, 2.1] {
                        let mut aa = ProductAntialias::new();
                        aa.process(a0, b0);
                        let (dry, product) = aa.process(a1, b1);
                        let mut reference = 0.0;
                        for t in nodes {
                            let a = (1.0 - t) * a0 as f64 + t * a1 as f64;
                            let b = (1.0 - t) * b0 as f64 + t * b1 as f64;
                            reference += 0.5 * a * b;
                        }
                        assert!((product as f64 - reference).abs() < 8e-7);
                        assert_eq!(dry, 0.5 * a0 + 0.5 * a1);
                    }
                }
            }
        }
    }

    #[test]
    fn product_zero_axes_and_constant_input_keep_original_gain() {
        let mut aa = ProductAntialias::new();
        for (a, b) in [(0.0, -1.2), (0.0, 1.3), (0.0, -2.0)] {
            assert_eq!(aa.process(a, b).1, 0.0);
        }
        aa.process(-1.7, 2.1);
        assert_eq!(aa.process(-1.7, 2.1), (-1.7, -1.7 * 2.1));
        aa.reset();
        assert_eq!(
            aa.process(1.2, -0.7),
            ProductAntialias::new().process(1.2, -0.7)
        );
    }

    #[test]
    fn constant_input_keeps_the_circuit_transfer_and_reset_restarts_history() {
        let mut aa = RingAntialias::new();
        for (a, b) in [(0.0, 0.0), (0.4, -1.2), (-1.3, 0.8), (2.2, 2.2)] {
            aa.process(a, b);
            assert!((aa.process(a, b).1 - ring::transfer(a, b)).abs() < 1e-6);
        }
        aa.reset();
        assert_eq!(
            aa.process(0.7, -1.1),
            RingAntialias::new().process(0.7, -1.1)
        );
    }

    #[test]
    fn segment_average_is_invariant_under_time_reversal() {
        for (a, b, c, d) in [
            (-1.8, 0.2, 1.5, -0.8),
            (0.3, 0.6, 0.31, 0.61),
            (-0.9, -1.2, 0.4, 1.7),
        ] {
            let mut forward = RingAntialias::new();
            let mut backward = RingAntialias::new();
            forward.process(a, b);
            backward.process(c, d);
            assert!((forward.process(c, d).1 - backward.process(a, b).1).abs() < 2e-6);
        }
    }

    #[test]
    fn dry_path_averages_the_same_interval_as_the_bridge() {
        let mut aa = RingAntialias::new();
        assert_eq!(aa.process(1.0, 0.2).0, 0.5);
        assert_eq!(aa.process(-0.5, 1.2).0, 0.25);
        assert_eq!(aa.process(0.5, -0.8).0, 0.0);
    }

    #[test]
    fn nonfinite_input_cannot_poison_following_audio() {
        let mut aa = RingAntialias::new();
        aa.process(1.0, -0.5);
        assert_eq!(aa.process(f32::NAN, 0.5), (0.0, 0.0));
        assert_eq!(aa.process(0.5, 0.7), RingAntialias::new().process(0.5, 0.7));
        assert_eq!(aa.process(f32::INFINITY, 1.0), (0.0, 0.0));
    }
}
