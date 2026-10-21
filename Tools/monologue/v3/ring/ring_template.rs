//! Monologue diode ring and its AC coupling, derived from KLM3621 sheet 4.
//!
//! `transfer` is a bilinear table of the four-node DC circuit, including the
//! output amplifier's 100k/150k loading and 1.5 differential gain. The diode
//! part is unspecified in the service schematic. An explicitly assumed
//! silicon law (Is=1nA, nVt=0.1/ln(10) V) approximates a ROHM 1SS355 25 C curve;
//! this does not identify D29..D32. No recorded audio was used to generate it.
//!
//! Oscillator engine unit 1 means 0.55 V (the schematic's 1.1 Vpp raw ramp).
//! There is no RMS normalization or compensation for the nonlinear gain.
//! LUT source/generation and numerical checks: Tools/monologue/v3/ring/.
//! See docs/monologue-ring-evidence.md for circuit assumptions and limits.

const A_COUNT: usize = 129;
const B_COUNT: usize = 65;
const MAX_VOLTS: f32 = 1.5;
const VOLTS_PER_UNIT: f32 = 0.55;
const CELLS_PER_VOLT: f32 = 64.0 / MAX_VOLTS;

/// Matched-diode static bridge. Inputs/return use the oscillator engine scale.
///
/// The table spans +/-1.5 V (engine +/-2.72727), with room beyond the nominal
/// +/-1.21 V unshaped triangle. Guard clipping outside that modeled domain is
/// explicit; it is not a model of op-amp rail clipping. NaNs are rejected.
#[inline]
pub(super) fn transfer(a: f32, b: f32) -> f32 {
    if a.is_nan() || b.is_nan() {
        return 0.0;
    }
    let av = (a * VOLTS_PER_UNIT).clamp(-MAX_VOLTS, MAX_VOLTS);
    let bv = (b * VOLTS_PER_UNIT).abs().min(MAX_VOLTS);
    let ax = av * CELLS_PER_VOLT + 64.0;
    let bx = bv * CELLS_PER_VOLT;
    let ai = (ax as usize).min(A_COUNT - 2);
    let bi = (bx as usize).min(B_COUNT - 2);
    let af = ax - ai as f32;
    let bf = bx - bi as f32;
    let i = ai * B_COUNT + bi;
    let p00 = TABLE[i];
    let p10 = TABLE[i + B_COUNT];
    let p01 = TABLE[i + 1];
    let p11 = TABLE[i + B_COUNT + 1];
    let p0 = p00 + af * (p10 - p00);
    let p1 = p01 + af * (p11 - p01);
    let out = (p0 + bf * (p1 - p0)) / VOLTS_PER_UNIT;
    if b < 0.0 { -out } else { out }
}

/// Continuously running source and return coupling capacitors.
///
/// Source coupling must be updated in every oscillator mode. The diode bridge
/// also runs while deselected: C271 then charges through its 100k shunt, instead
/// of the shunt in parallel with the selected VCA2 input. All states start at
/// zero; there is no assumed DC warm-up. f64 capacitor states avoid the small
/// permanent DC residue of an f32 low-pass integrator at a high sample rate.
#[derive(Clone)]
pub(super) struct RingModulator {
    sample_rate: f64,
    source_dc: [f64; 2],
    return_dc: f64,
    source1_g: f64,
    source2_g: [f64; 2],
    return_g: [f64; 2],
}

impl RingModulator {
    pub(super) fn new(sample_rate: f32) -> Self {
        let mut this = Self {
            sample_rate: 0.0,
            source_dc: [0.0; 2],
            return_dc: 0.0,
            source1_g: 0.0,
            source2_g: [0.0; 2],
            return_g: [0.0; 2],
        };
        this.set_sample_rate(sample_rate);
        this
    }

    /// Pass the rate at which `process_sources`/`process_return` are called,
    /// i.e. the oversampled rate, not the host output rate.
    pub(super) fn set_sample_rate(&mut self, sample_rate: f32) {
        let rate = if sample_rate.is_finite() && sample_rate > 0.0 {
            sample_rate as f64
        } else { 48_000.0 };
        if self.sample_rate == rate {
            return;
        }
        self.sample_rate = rate;
        let g = |r: f64| -(-1.0 / (rate * r * 10e-6)).exp_m1();
        // Approximate BJT input by its explicit 1k shunt after the 47k series.
        let vca = 48_000.0;
        let a_load = 1.0 / (1.0 / vca + 1.0 / 1_000_000.0);
        let b_load = 40_000.0; // 200k || 100k || R391 100k.
        self.source1_g = g(a_load);
        self.source2_g = [g(1.0 / (1.0 / b_load + 1.0 / vca)), g(b_load)];
        self.return_g = [g(100_000.0), g(1.0 / (1.0 / 100_000.0 + 1.0 / vca))];
    }

    pub(super) fn reset(&mut self) {
        self.source_dc = [0.0; 2];
        self.return_dc = 0.0;
    }

    /// C275 and C274, before either VCA or the ring bridge. Exposed separately
    /// to allow controlled transfer-only versus coupling-only comparisons.
    #[inline]
    pub(super) fn process_sources(&mut self, a: f32, b: f32, ring: bool) -> (f32, f32) {
        let ac_a = a as f64 - self.source_dc[0];
        let ac_b = b as f64 - self.source_dc[1];
        // IC24A's virtual minus input is b/2, through R408 1M. The exact
        // cross-gain with the 48k VCA approximation is (48k || 1M)/(2*1M).
        const CROSS_GAIN: f64 = (48_000.0 * 1_000_000.0 / 1_048_000.0) / 2_000_000.0;
        self.source_dc[0] += self.source1_g * (ac_a - CROSS_GAIN * ac_b);
        self.source_dc[1] += self.source2_g[ring as usize] * ac_b;
        (ac_a as f32, ac_b as f32)
    }

    /// C271; run continuously with the actual static bridge output even when
    /// ring is deselected, so enabling it does not invent a capacitor state.
    #[inline]
    pub(super) fn process_return(&mut self, bridge: f32, ring: bool) -> f32 {
        let ac = bridge as f64 - self.return_dc;
        self.return_dc += self.return_g[ring as usize] * ac;
        ac as f32
    }

    #[inline]
    pub(super) fn process(&mut self, a: f32, b: f32, ring: bool) -> (f32, f32) {
        let (a,b) = self.process_sources(a,b,ring);
        let returned = self.process_return(transfer(a,b),ring);
        (a,if ring { returned } else { b })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circuit_voltage_probes_match_offline_kcl_solver() {
        // Filled with independent converged solver voltages, not LUT knots.
        let probes = [
            // @PROBES@
        ];
        for (a,b,expected) in probes {
            let got = transfer(a/VOLTS_PER_UNIT,b/VOLTS_PER_UNIT)*VOLTS_PER_UNIT;
            assert!((got-expected).abs()<0.0007,"{a} {b}: {got} vs {expected}");
        }
    }

    #[test]
    fn zero_axes_and_verified_b_odd_symmetry() {
        for i in -100..=100 {
            let a = i as f32 * 0.027;
            assert_eq!(transfer(a,0.0),0.0);
            assert_eq!(transfer(0.0,a),0.0);
            for j in 1..=32 {
                let b=j as f32*0.08;
                assert_eq!(transfer(a,-b),-transfer(a,b));
            }
        }
        // The asymmetric output loading makes a-odd symmetry inexact. Keep it.
        assert!((transfer(0.4,1.0)+transfer(-0.4,1.0)).abs()>1e-5);
    }

    #[test]
    fn modeled_domain_is_finite_and_guards_are_continuous() {
        for i in -100..=100 {
            for j in -100..=100 {
                assert!(transfer(i as f32*0.03,j as f32*0.03).is_finite());
            }
        }
        let edge=MAX_VOLTS/VOLTS_PER_UNIT;
        assert!((transfer(edge,1.0)-transfer(edge-1e-5,1.0)).abs()<1e-4);
        assert_eq!(transfer(edge,1.0),transfer(edge+10.0,1.0));
        assert_eq!(transfer(f32::NAN,1.0),0.0);
    }

    #[test]
    fn coupling_time_constants_are_sample_rate_independent() {
        for rate in [44_100.0,48_000.0,176_400.0,192_000.0] {
            let mut ring=RingModulator::new(rate);
            let mut a=0.0;
            let mut b=0.0;
            for _ in 0..rate as usize { (a,b)=ring.process_sources(1.0,0.0,true); }
            let tau_a=10e-6*(48_000.0*1_000_000.0/1_048_000.0);
            assert!((a as f64-(-1.0_f64/tau_a).exp()).abs()<1e-5);
            assert_eq!(b,0.0);
            ring.reset();
            for _ in 0..rate as usize { (_,b)=ring.process_sources(0.0,1.0,true); }
            assert!((b as f64-(-1.0_f64/0.4).exp()).abs()<1e-5);
        }
    }

    #[test]
    fn constant_carrier_does_not_leave_f32_dc_floor() {
        let mut ring=RingModulator::new(192_000.0);
        let mut a=0.0;
        for _ in 0..(192_000*8) { (a,_)=ring.process_sources(1.0,0.0,true); }
        assert!(a.abs()<1e-7,"DC residue {a}");
    }

    #[test]
    fn split_stages_match_convenience_process_and_rate_change_keeps_state() {
        let mut whole=RingModulator::new(192_000.0);
        let mut split=whole.clone();
        for i in 0..10000 {
            let a=(i as f32*0.03).sin()*2.2;
            let b=(i as f32*0.049).sin();
            let enabled=i%2000>=1000;
            let expected=whole.process(a,b,enabled);
            let (aa,bb)=split.process_sources(a,b,enabled);
            let returned=split.process_return(transfer(aa,bb),enabled);
            assert_eq!(expected,(aa,if enabled {returned} else {bb}));
        }
        let old_state=whole.source_dc;
        whole.set_sample_rate(176_400.0);
        assert_eq!(whole.source_dc,old_state);
    }
}

// Generated a-major, b-minor table. Entries are physical output volts.
// Do not force a-odd symmetry: R378/394/395 load the two output nodes differently.
#[rustfmt::skip]
static TABLE: [f32; A_COUNT * B_COUNT] = [
// @GENERATED_TABLE@
];
