//! Original fixed-point reconstructions of JP-8000 oscillator arithmetic.
//! No firmware, program words, captured phases, or sampled waves are included.
//! Inputs and outputs are signed Q23 at the native 88.2 kHz oscillator rate.

const Q: i64 = 1 << 23;
#[inline(always)]
fn sat(x: i64) -> i64 {
    x.clamp(-Q, Q - 1)
}
#[inline(always)]
fn wrap(x: i64) -> i64 {
    ((x + Q) & (2 * Q - 1)) - Q
}
/// The two-product ESP multiply, including its two separate truncations.
#[inline(always)]
fn mul(x: i64, c: i64, shift: u32) -> i64 {
    ((x * (c >> 16)) >> shift) + (((x >> 7) * ((c >> 9) & 127)) >> shift)
}
#[inline(always)]
fn folded_abs(x: i64) -> i64 {
    if x < 0 {
        !x
    } else {
        x
    }
}

/// Stateless sample functions also permit independent arithmetic verification.
#[inline(always)]
pub fn triangle(phase: i64, shape: i64) -> i64 {
    let t = (phase >> 1) + (Q >> 1);
    let t3 = sat(mul(sat(mul(t, t, 7)), t, 7));
    let warped = mul(t, (!shape) & (Q - 1), 7) + mul(t3, shape, 7);
    let z = sat(-Q + 2 * sat(warped));
    let tri = sat(-Q + 2 * folded_abs(z));
    let tri3 = sat(mul(sat(mul(tri, tri, 7)), tri, 7));
    let shaped = tri + mul(tri, !shape, 5) + mul(tri3, shape, 5);
    let compensated = mul(sat(shaped), (!(shape >> 1)) & (Q - 1), 7);
    sat((sat(compensated) * 39) >> 7)
}

#[inline(always)]
pub fn triangle_mod(phase: i64, shape: i64, frequency: i64) -> i64 {
    let tri = sat(Q - 2 * folded_abs(phase));
    let warped = wrap(((tri * 72) >> 6) + mul(tri, shape, 7));
    let edge = Q - folded_abs(warped);
    let (g, h) = ramp_edge_weights(2 * frequency);
    let edge = sat(h + mul(edge, g, 3) + edge);
    sat((sat(mul(warped, edge, 7)) * 20) >> 7)
}

#[inline(always)]
pub fn pulse(phase: i64, shape: i64, frequency: i64) -> i64 {
    let tri = sat(Q - 2 * folded_abs(phase));
    let twice_f = sat(2 * frequency);
    let compensation = sat(Q + mul(twice_f, !twice_f, 7));
    let offset = mul(shape, compensation, 7);
    let v = sat(offset + tri);
    let g0 = sat(Q + sat(-4 * frequency));
    let g1 = sat(Q + sat(sat(-4 * frequency) * 4));
    let g2 = sat(Q + sat(sat(sat(-4 * frequency) * 4) * 4));
    let sign = if v >= 0 { Q - 1 } else { -Q };
    let shaped = v + mul(g0, v, 5) + mul(g1, sat(4 * v), 5) + mul(g2, sign, 7);
    // The offset subtraction is deliberately an eight-bit-only product.
    sat(((sat(shaped) * 19) >> 7) + ((sat(offset) * -20) >> 7))
}

#[derive(Clone, Default)]
struct NoiseState {
    x1: i64,
    x2: i64,
    lp1: i64,
    bp1: i64,
    lp2: i64,
    bp2: i64,
    hp1: i64,
    hp2: i64,
}
impl NoiseState {
    #[inline(always)]
    fn next(&mut self, c: i64, r: i64) -> i64 {
        let x1 = self.x1;
        let x2 = self.x2;
        self.x1 = wrap(
            ((Q / 2 * 124) >> 7)
                + (((Q / 2 >> 7) * 121) >> 7)
                + ((x1 * -116) >> 6)
                + (((x1 >> 7) * 83) >> 6)
                + ((x2 * 127) >> 7)
                + (((x2 >> 7) * 62) >> 7),
        );
        self.x2 = wrap(
            ((self.x1 * -127) >> 6)
                + (((self.x1 >> 7) * 58) >> 6)
                + ((x2 * 126) >> 6)
                + (((x2 >> 7) * 39) >> 6),
        ) >> 1;
        let lp1 = sat(self.lp1 + mul(self.bp1, c, 7));
        let hp1 = sat(-sat(lp1 + mul(self.bp1, r, 6)) + mul(x2, r, 7) + (((x2 >> 7) * 32) >> 7));
        let lp2 = sat(self.lp2 + mul(self.bp2, c, 7));
        let hp2 = sat(-sat(lp2 + mul(self.bp2, r, 6))
            + ((self.lp1 * 53) >> 6)
            + (((self.lp1 >> 7) * 97) >> 6));
        let gain = sat(sat((r * 38) >> 3) + ((Q / 2 * 23) >> 6) + (((Q / 2 >> 7) * 5) >> 6));
        let out = sat((sat(mul(self.lp2, gain, 6)) * 30) >> 6);
        self.lp1 = lp1;
        self.lp2 = lp2;
        self.bp1 = sat(self.bp1 + mul(hp1, c, 7));
        self.bp2 = sat(self.bp2 + mul(hp2, c, 7));
        self.hp1=hp1; self.hp2=hp2;
        out
    }
}

#[derive(Clone)]
struct FeedbackState {
    memory: Box<[i32]>,
    cursor: usize,
    dc: i64,
    period: i64,
    period_target: i64,
    depth: i64,
    depth_target: i64,
}
impl FeedbackState {
    fn new() -> Self {
        Self {
            memory: vec![0; 65536].into_boxed_slice(),
            cursor: 0,
            dc: 0,
            period: 0,
            period_target: 0,
            depth: 0,
            depth_target: 4096,
        }
    }
    fn reset(&mut self) {
        self.memory.fill(0);
        self.cursor = 0;
        self.dc = 0;
        self.period = 0;
        self.period_target = 0;
        self.depth = 0;
        self.depth_target = 4096;
    }
    #[inline(always)]
    fn read(&self, address: i64) -> i64 {
        let offset = (address >> 12) as usize;
        let fraction = ((address << 11) & (Q - 1)) >> 16;
        let a = i64::from(self.memory[(self.cursor + offset) & 65535]);
        let b = i64::from(self.memory[(self.cursor + offset + 1) & 65535]);
        // Separate products are each truncated, then doubled. There is no low-bit multiply extension.
        2 * ((a * (127 - fraction)) >> 7) + 2 * ((b * fraction) >> 7)
    }
    #[inline(always)]
    fn quantize(x: i64) -> i32 {
        for shift in [4, 6, 8, 10] {
            let mantissa = x >> shift;
            if (-8192..8192).contains(&mantissa) {
                return (mantissa << shift) as i32;
            }
        }
        0
    }
    #[inline(always)]
    fn next(&mut self, phase: i64, shape: i64) -> i64 {
        let address0 = 8 * self.period;
        let address1 = mul(self.period, sat((shape >> 1) + Q / 4), 3);
        let a = sat(self.read(address0));
        let b = sat(self.read(address1));
        let depth = sat((self.depth * 51) >> 6);
        let excitation = sat(((phase * 70) >> 7) + ((a * 40) >> 7) + mul(b, depth, 7));
        let y = sat(((excitation * 127) >> 7) + (((excitation >> 7) * 96) >> 7) + self.dc);
        self.dc = sat((-y >> 7) + (((y >> 7) * 64) >> 7) + self.dc);
        let write = sat((y * 42) >> 6);
        self.memory[self.cursor] = Self::quantize(write);
        self.cursor = (self.cursor.wrapping_sub(1)) & 65535;
        sat((write * 23) >> 6)
    }
}

fn pitch_ratio(cents: i32) -> (i64, i32) {
    let oct = cents.div_euclid(1200);
    let rem = cents.rem_euclid(1200);
    let coarse = (2048.0 * 2.0_f64.powf(f64::from((rem >> 8) * 256) / 1200.0)).floor() as i64;
    let fine = (32768.0 * 2.0_f64.powf(f64::from(rem & 255) / 1200.0)).floor() as i64;
    ((coarse * fine) >> 12, oct)
}
fn noise_targets(pitch: i32, raw31: u8, raw32: u8) -> (i64, i64) {
    let cents = (pitch + i32::from(raw31.min(127)) * 100 - 1292).clamp(0, 12700);
    let (ratio, oct) = pitch_ratio(cents);
    let shift = oct - 9;
    let control = ((if shift >= 0 {
        ratio << shift
    } else {
        ratio >> (-shift)
    }) + 1)
        .clamp(33, 32767);
    let mut r = (32 + (128 - i64::from(raw32.min(127))).pow(2)).min(16384);
    if control <= 15165 {
        r = (r * ((38038 - (control >> 2)) >> 1)) >> 14;
    }
    ((control * 256) & !511, (r * 256) & !511)
}

/// Inline oscillator state; changing the shape or waveform does not reset phase.
#[derive(Clone)]
pub struct Oscillator {
    wave: u8,
    phase: i64,
    frequency: i64,
    shape: i64,
    target: i64,
    loading: bool,
    raw31: u8,
    raw32: u8,
    pitch: i32,
    noise: NoiseState,
    feedback: FeedbackState,
    noise_c: i64,
    noise_r: i64,
    noise_ct: i64,
    noise_rt: i64,
}
impl Default for Oscillator {
    fn default() -> Self {
        Self::new()
    }
}
impl Oscillator {
    pub fn new() -> Self {
        Self {
            wave: 6,
            phase: 0,
            frequency: 65536,
            shape: 0,
            target: 4096,
            loading: true,
            raw31: 0,
            raw32: 0,
            pitch: 0,
            noise: NoiseState::default(),
            feedback: FeedbackState::new(),
            noise_c: 0,
            noise_r: 0,
            noise_ct: 8192,
            noise_rt: 4867584,
        }
    }
    pub fn reset(&mut self) {
        self.wave = 6;
        self.phase = 0;
        self.frequency = 65536;
        self.shape = 0;
        self.target = 4096;
        self.loading = true;
        self.raw31 = 0;
        self.raw32 = 0;
        self.pitch = 0;
        self.noise = NoiseState::default();
        self.noise_c = 0;
        self.noise_r = 0;
        self.noise_ct = 8192;
        self.noise_rt = 4867584;
        self.feedback.reset();
    }
    /// Install semantic defaults from the ROM program template; do not copy
    /// phase, delay memory or other runtime state. Control values are stored
    /// elsewhere and become targets only when a controller is assigned.
    pub fn load_generic_program(&mut self, raw: u8) {
        self.wave = raw.min(6);
        self.target = 4096;
        if self.wave == 3 {
            self.feedback.period_target = 0;
            self.feedback.depth_target = 4096;
        } else if self.wave == 2 {
            self.noise_ct = 65536;
            self.noise_rt = 4194304;
        }
    }
    /// Noise and Pulse interpret physical IRAM08/0a as different quantities.
    /// This carries only this engine's generated state across the proven 2→4
    /// program transition. Other program aliases remain a separate audit.
    pub fn inherit_noise_pulse_state(&mut self) -> i64 {
        self.phase = self.noise.x1;
        self.shape = self.noise.x2;
        self.phase
    }
    /// Super Saw's generated side phases occupy the cells Pulse reads as its
    /// phase and width. Preserve those values for the proven 0→4 transition;
    /// this does not emulate the MCU's non-atomic program-upload timing.
    pub fn inherit_supersaw_pulse_state(&mut self, side_phase: i32, next_side_phase: i32) -> i64 {
        self.phase = i64::from(side_phase);
        self.shape = i64::from(next_side_phase);
        self.phase
    }
    /// Copy only this engine's generated phase/width across the proved
    /// Saw/Pulse program boundary. Signed widths are physical history and must
    /// not be clamped to the semantic unipolar shape-control range.
    pub(super) fn inherit_phase_width(&mut self, phase: i64, width: i64) -> i64 {
        self.phase = wrap(phase);
        self.shape = width;
        self.phase
    }
    pub(super) fn width_state(&self) -> i64 { self.shape }
    /// Immediate outgoing read-cell interpretations, before a Noise upload.
    /// Every listed active kernel writes predecessors07/09 each DSP frame.
    /// Feedback's 0a is smoothed delay period, not its shape.
    pub(super) fn noise_entry_cells(&self) -> [i64; 2] {
        [self.phase, if self.wave == 3 { self.feedback.period } else { self.shape }]
    }
    /// Preserve generated signed24 values, including a first x2 outside the
    /// half range established only by the following Noise recurrence.
    pub(super) fn inherit_noise_excitation(&mut self, cells: [i64; 2]) {
        self.noise.x1 = cells[0];
        self.noise.x2 = cells[1];
    }
    /// Direct Super Saw→Noise shares these four just-written SVF cells.
    /// This does not model their rotation during an intervening program.
    pub(super) fn inherit_noise_filter_history(&mut self, history: [i64; 4]) {
        [self.noise.lp1, self.noise.bp1, self.noise.lp2, self.noise.bp2] = history;
    }
    #[cfg(test)]
    pub(super) fn noise_history_for_test(&self) -> ([i64; 2], [i64; 4], [i64; 2]) {
        ([self.noise.x1, self.noise.x2],
         [self.noise.lp1, self.noise.bp1, self.noise.lp2, self.noise.bp2],
         [self.noise_c, self.noise_r])
    }
    pub fn set_wave(&mut self, raw: u8) {
        self.wave = raw;
        self.set_shape_targets(self.raw31, self.raw32);
    }
    pub fn set_pitch_cents(&mut self, cents: i32) {
        self.pitch = cents;
        (self.noise_ct, self.noise_rt) = noise_targets(cents, self.raw31, self.raw32);
    }
    pub fn set_frequency_word(&mut self, frequency: i64) {
        self.frequency = frequency.clamp(0, 0x309c00);
    }
    pub fn set_feedback_note(&mut self, note: i32) {
        let hz = ((440.0 * 2.0_f64.powf(f64::from(note.clamp(0, 127) - 69) / 12.0) * 100.0).round()
            / 100.0) as f32;
        self.set_feedback_period_word(((88200.0 * 4096.0 / f64::from(hz)).round() as i64) >> 3);
    }
    /// Period in Q9 samples. The DSP stores this in a signed24-bit state.
    pub fn set_feedback_period_word(&mut self, period: i64) {
        self.feedback.period_target = period.clamp(0, Q - 1);
    }
    pub fn set_loading(&mut self, loading: bool) {
        self.loading = loading;
    }
    pub fn set_phase(&mut self, phase: i64) {
        self.phase = wrap(phase);
    }
    pub fn phase(&self) -> i64 {
        self.phase
    }
    /// Control2 for these three waveforms is LFO depth, not a static timbre control.
    /// The controller can supply its time-varying result through set_shape_target.
    pub fn set_shape_targets(&mut self, raw31: u8, raw32: u8) {
        self.raw31 = raw31.min(127);
        self.raw32 = raw32.min(127);
        (self.noise_ct, self.noise_rt) = noise_targets(self.pitch, self.raw31, self.raw32);
        let remaining = 127 - i64::from(self.raw32);
        let curve = if self.raw32 == 0 {
            32768
        } else {
            32767 * remaining * remaining / 16129
        };
        self.feedback.depth_target = ((32767 - curve) >> 1) * 512;
        self.target = if self.wave == 3 {
            i64::from(self.raw31) * 8192 / 127 * 512
        } else if self.wave == 1 {
            (127_i64 - i64::from(raw31.min(127))).clamp(32, 114) << 16
        } else {
            i64::from(raw31.min(124)) << 16
        };
    }
    pub fn set_shape_target(&mut self, target: i64) {
        self.target = sat(target);
    }
    #[inline(always)]
    pub fn next_sample(&mut self) -> i64 {
        self.next_sample_with_frequency(self.frequency)
    }
    /// Per-sample signed FM increment for waveforms1/3/4/6. Feedback uses it
    /// only for the excitation phase; its delay period remains nominal.
    #[inline(always)]
    pub fn next_sample_with_frequency(&mut self, increment: i64) -> i64 {
        let frequency = if matches!(self.wave, 1 | 3 | 4 | 6) {
            wrap(increment)
        } else {
            self.frequency
        };
        let feedback_sample = if self.wave == 3 {
            self.feedback.next(self.phase, self.shape)
        } else {
            self.feedback.cursor = (self.feedback.cursor.wrapping_sub(1)) & 65535;
            0
        };
        self.feedback.period =
            sat(self.feedback.period
                + (sat(self.feedback.period_target - self.feedback.period) >> 7));
        let depth_delta = sat(self.feedback.depth_target - self.feedback.depth);
        self.feedback.depth = sat(self.feedback.depth
            + if self.loading {
                (depth_delta * 112) >> 7
            } else {
                depth_delta >> 11
            });

        // Pulse reads IRAM0a before this frame writes its width successor.
        let previous_shape = self.shape;
        let delta = sat(self.target - self.shape);
        self.shape = sat(self.shape
            + if self.loading {
                (delta * 112) >> 7
            } else {
                delta >> 11
            });
        self.phase = wrap(self.phase + frequency);
        for (state, target) in [
            (&mut self.noise_c, self.noise_ct),
            (&mut self.noise_r, self.noise_rt),
        ] {
            let d = sat(target - *state);
            *state = sat(*state
                + if self.loading {
                    (d * 112) >> 7
                } else {
                    d >> 11
                });
        }
        match self.wave {
            1 => triangle_mod(self.phase, self.shape, frequency),
            2 => self.noise.next(self.noise_c, self.noise_r),
            3 => feedback_sample,
            4 => pulse(self.phase, previous_shape, frequency),
            6 => triangle(self.phase, self.shape),
            _ => 0,
        }
    }
}

/// Saturation between the two edge-width stages matters under strong FM.
#[inline(always)]
fn ramp_edge_weights(frequency: i64) -> (i64, i64) {
    let a1 = sat(-4 * frequency);
    let a2 = sat(3 * a1);
    (
        sat(Q + ((a1 * 40) >> 7) + ((a2 * 88) >> 7)),
        sat(((a2 * 80) >> 5) + Q * 3 / 32) + Q,
    )
}

#[inline(always)]
pub fn sync_pulse(phase: i64, shape: i64, frequency: i64) -> i64 {
    let tri = sat(Q - 2 * folded_abs(phase));
    let offset = mul(shape, Q - 1, 7);
    let v = sat(offset + tri);
    let g0 = sat(Q + sat(-4 * frequency));
    let g1 = sat(Q + sat(sat(-4 * frequency) * 4));
    let g2 = sat(Q + sat(sat(sat(-4 * frequency) * 4) * 4));
    let sign = if v >= 0 { Q - 1 } else { -Q };
    // Sync's first product replaces the accumulator; free Pulse adds v.
    let shaped = mul(g0, v, 5) + mul(g1, sat(4 * v), 5) + mul(g2, sign, 7);
    sat(((sat(shaped) * 19) >> 7) + ((sat(offset) * -20) >> 7))
}
/// Return (slave phase, slave edge state, audio); input states are from the prior frame.
#[inline(always)]
pub fn sync_saw(
    old_phase: i64,
    old_master: i64,
    old_edge: i64,
    ratio: i64,
    frequency: i64,
) -> (i64, i64, i64) {
    let edge_frequency = sat(2 * mul(frequency, ratio, 3)) >> 1;
    sync_saw_with_frequency_history(
        old_phase,
        old_master,
        old_edge,
        ratio,
        frequency,
        edge_frequency,
    )
}

// The live kernel's edge coefficient comes from the prior frame's I0x08.
#[inline(always)]
fn sync_saw_with_frequency_history(
    old_phase: i64,
    old_master: i64,
    old_edge: i64,
    ratio: i64,
    frequency: i64,
    edge_frequency: i64,
) -> (i64, i64, i64) {
    let f2 = edge_frequency;
    let raw = mul(old_master, ratio, 3) + 2 * mul(Q / 2, ratio, 3) - Q;
    let phase = wrap(raw);
    let guard = sat(Q - sat(raw + Q));
    let slave_width = sat(Q + guard - folded_abs(phase));
    let master_width = sat(Q - folded_abs(old_master));
    let (g, h) = ramp_edge_weights(f2);
    let slave_edge = sat(h + slave_width + mul(slave_width, g, 3));
    let master_edge = sat(h + master_width + mul(master_width, g, 3));
    let unipolar = (sat(mul(old_edge, old_phase, 7)) >> 1) + Q / 2;
    let gated = sat(mul(unipolar, master_edge, 6) - Q);
    let gain = sat(Q / 8 + mul(frequency, frequency, 6));
    (phase, slave_edge, sat(mul(gated, gain, 6)))
}
/// Return (slave phase, audio). The ratio-dependent offset corrects the sync seam.
#[inline(always)]
pub fn sync_triangle(master: i64, ratio: i64, frequency: i64) -> (i64, i64) {
    let offset_phase = mul(-Q, !ratio, 3);
    let phase = wrap(mul(master, ratio, 3) + offset_phase - Q);
    let tri = sat(Q - 2 * folded_abs(phase));
    let offset = sat(Q - folded_abs(wrap(2 * offset_phase)));
    let width = sat(Q - folded_abs(master));
    let (g, h) = ramp_edge_weights(frequency);
    let gate = sat(h + mul(width, g, 3) + width);
    let average = (offset >> 1) + (tri >> 1);
    let out = sat((sat(mul(sat(average), gate, 6) - offset) * 40) >> 7);
    (phase, out)
}

/// OSC2 saw differs from OSC1: it omits the cubic shape blend and has its own gain.
#[inline(always)]
pub fn oscillator_2_saw(phase: i64, frequency: i64) -> i64 {
    let edge = Q - folded_abs(phase);
    let (g, h) = ramp_edge_weights(frequency);
    let edge = sat(h + mul(edge, g, 3) + edge);
    let gain = sat(Q / 8 + mul(frequency, frequency, 6));
    // Operand order matters because each ESP product discards different bits.
    sat(mul(sat(mul(edge, phase, 7)), gain, 6))
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Oscillator2Sample {
    pub audio: i64,
    pub cross: i64,
}
/// OSC2 has no delay allocation. Raw wave IDs: 0 Pulse, 1 Saw, 2 Triangle.
#[derive(Clone)]
pub struct Oscillator2 {
    wave: u8,
    phase: i64,
    shape: i64,
    target: i64,
    ratio: i64,
    ratio_target: i64,
    ratio_wide: bool,
    previous_output: i64,
    previous_master: i64,
    sync_edge: i64,
    // Physical I0x08: slave frequency in free Pulse/Saw, nominal frequency in
    // either Triangle, smoothed slave frequency in Sync Pulse, and delayed
    // slave frequency for Sync Saw's edge weights.
    frequency_state: i64,
    // Physical I0x0c: written only by Sync Saw. Other waveforms preserve it.
    sync_base_frequency: i64,
    loading: bool,
    shape_loading: bool,
}
impl Default for Oscillator2 {
    fn default() -> Self {
        Self::new()
    }
}
impl Oscillator2 {
    pub fn new() -> Self {
        Self {
            wave: 2,
            phase: 0,
            shape: 0,
            target: 4096,
            ratio: 0,
            // Generic inactive program target, not captured machine state.
            ratio_target: (64 << 16) + 256,
            ratio_wide: false,
            previous_output: 0,
            previous_master: 0,
            sync_edge: 0,
            frequency_state: 0,
            sync_base_frequency: 0,
            loading: false,
            shape_loading: true,
        }
    }
    pub fn reset(&mut self) {
        *self = Self::new();
    }
    pub fn set_wave(&mut self, wave: u8) {
        self.wave = wave.min(2);
    }
    pub fn set_loading(&mut self, loading: bool) {
        self.set_loading_modes(loading, loading);
    }
    pub fn set_loading_modes(&mut self, ratio_fast: bool, width_fast: bool) {
        self.loading = ratio_fast;
        self.shape_loading = width_fast;
    }
    pub fn set_phase(&mut self, phase: i64) {
        self.phase = wrap(phase);
    }
    pub fn phase(&self) -> i64 {
        self.phase
    }
    pub fn set_shape(&mut self, raw37: u8) {
        self.target = i64::from(raw37.min(124)) << 16;
    }
    pub fn set_shape_target(&mut self, target: i64) {
        self.target = sat(target);
    }
    /// Latch at voice allocation: range endpoints use a slower pitch ratio
    /// smoother. A later held-note range edit changes its target, not this rate.
    pub fn set_ratio_wide(&mut self, wide: bool) {
        self.ratio_wide = wide;
    }
    pub fn set_tuning(&mut self, range: u8, fine: u8) {
        self.set_tuning_cents(
            (i32::from(range.clamp(1, 49)) - 25) * 100 + i32::from(fine.min(100)) - 50,
        );
    }
    pub fn set_tuning_cents(&mut self, cents: i32) {
        let (r, oct) = pitch_ratio(cents);
        // The H8 switches to the wider target writer at its upper limit.
        // Negative modulation is not restricted to the front-panel range.
        let value = if oct >= 4 {
            Q
        } else if oct >= 0 {
            (r * 32) << oct
        } else if oct <= -63 {
            0
        } else {
            (r * 32) >> (-oct)
        };
        self.ratio_target = (((value + 256) & !511) + 256).min(Q + 256);
    }
    /// Audio is the current output; the outer mixer consumes it on the next
    /// frame. The separate cross-modulation tap has waveform-specific gain/delay.
    #[inline(always)]
    pub fn next_sample(&mut self, base_frequency: i64) -> Oscillator2Sample {
        self.next_sample_with_sync(base_frequency, 0, false)
    }
    /// master_phase is the nominal OSC1 phase after the common GRAM frame delay.
    /// Sync has distinct, directly recovered algorithms for all three waveforms.
    #[inline(always)]
    pub fn next_sample_with_sync(
        &mut self,
        base_frequency: i64,
        master_phase: i64,
        sync: bool,
    ) -> Oscillator2Sample {
        // Frequency and sync geometry use the old ratio; width uses the new
        // shape below. The native instruction pipeline treats them differently.
        let previous_ratio = self.ratio;
        let ratio_delta = sat(self.ratio_target - self.ratio);
        self.ratio = sat(self.ratio
            + if self.loading {
                (ratio_delta * 112) >> 7
            } else {
                ratio_delta >> if self.ratio_wide { 9 } else { 8 }
            });
        let frequency = mul(base_frequency, previous_ratio, 3);
        let frequency = if self.wave == 2 {
            frequency
        } else {
            sat(2 * frequency) >> 1
        };
        let old_phase = self.phase;
        let old_master = self.previous_master;
        self.previous_master = wrap(master_phase);
        let delta = sat(self.target - self.shape);
        self.shape = sat(self.shape
            + if self.shape_loading {
                (delta * 112) >> 7
            } else {
                delta >> 11
            });
        let result = if sync {
            match self.wave {
                0 => {
                    self.phase = wrap(mul(master_phase, previous_ratio, 3));
                    self.frequency_state =
                        sat(self.frequency_state + (sat(frequency - self.frequency_state) >> 4));
                    Oscillator2Sample {
                        audio: sync_pulse(self.phase, self.shape, self.frequency_state),
                        cross: self.previous_output,
                    }
                }
                1 => {
                    let previous_base_frequency = self.sync_base_frequency;
                    let (phase, edge, audio) = sync_saw_with_frequency_history(
                        old_phase,
                        old_master,
                        self.sync_edge,
                        previous_ratio,
                        previous_base_frequency,
                        self.frequency_state,
                    );
                    self.frequency_state =
                        sat(2 * mul(previous_base_frequency, previous_ratio, 3)) >> 1;
                    self.sync_base_frequency = base_frequency;
                    self.phase = phase;
                    self.sync_edge = edge;
                    Oscillator2Sample {
                        audio,
                        cross: self.previous_output >> 1,
                    }
                }
                _ => {
                    let (phase, audio) =
                        sync_triangle(master_phase, previous_ratio, base_frequency);
                    self.frequency_state = base_frequency;
                    self.phase = phase;
                    Oscillator2Sample {
                        audio,
                        cross: self.previous_output,
                    }
                }
            }
        } else {
            self.frequency_state = if self.wave == 2 {
                base_frequency
            } else {
                frequency
            };
            self.phase = wrap(self.phase + frequency);
            match self.wave {
                0 => Oscillator2Sample {
                    audio: pulse(self.phase, self.shape, frequency),
                    cross: self.previous_output,
                },
                1 => {
                    let x = oscillator_2_saw(self.phase, frequency);
                    Oscillator2Sample { audio: x, cross: x }
                }
                _ => {
                    let x = folded_abs(old_phase) - Q / 2;
                    Oscillator2Sample {
                        audio: (x * 40) >> 6,
                        cross: x,
                    }
                }
            }
        };
        self.previous_output = result.audio;
        result
    }
}

/// Apply the DSP's ring operation to the second oscillator contribution.
#[inline(always)]
pub fn ring_sample(oscillator_1: i64, oscillator_2: i64) -> i64 {
    sat(mul(oscillator_2, oscillator_1, 5))
}
#[inline(always)]
pub fn mix_oscillators(oscillator_1: i64, oscillator_2: i64, balance: i64) -> i64 {
    sat(mul(oscillator_1, (!balance) & (Q - 1), 7) + mul(oscillator_2, balance, 7))
}
/// Only oscillator-1 waves 1/4/5/6 have this linear-FM route.
#[inline(always)]
pub fn cross_modulated_frequency(base_frequency: i64, oscillator_2_tap: i64, depth: i64) -> i64 {
    wrap(base_frequency + mul(oscillator_2_tap, sat((depth * 51) >> 7), 7))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_pulse_loads_edge_frequency_through_its_native_smoother() {
        let mut osc = Oscillator2::new();
        osc.set_wave(0);
        osc.set_shape(64);
        osc.set_tuning(32, 53);
        let mut master = 0;
        // Zero-state native trace, before the coefficient has settled.
        for (frame, expected) in [0, 18, 50, 98, 161].into_iter().enumerate() {
            let frequency = if frame == 0 { 0 } else { 49767 };
            osc.next_sample_with_sync(frequency, master, true);
            assert_eq!(osc.frequency_state, expected, "frame {frame}");
            master = wrap(master + 49767);
        }
    }

    #[test]
    fn sync_saw_edge_uses_the_previous_frequency_slot() {
        let mut osc = Oscillator2::new();
        osc.set_wave(1);
        osc.set_tuning(32, 53);
        let mut master = 0;
        let mut output = Oscillator2Sample::default();
        for frame in 0..444 {
            output = osc.next_sample_with_sync(if frame == 0 { 0 } else { 49767 }, master, true);
            master = wrap(master + 49767);
        }
        // Native cold-state frame443: current frequency61419; its edge uses
        // previous frequency61370. Recomputing that edge early gives7660561.
        assert_eq!(osc.frequency_state, 61419);
        assert_eq!(osc.sync_base_frequency, 49767);
        assert_eq!(osc.phase, -8367958);
        assert_eq!(osc.sync_edge, 7662051);
        assert_eq!(output.audio, 2035932);
    }

    #[test]
    fn waveform_changes_preserve_physical_frequency_history() {
        let mut osc = Oscillator2::new();
        osc.frequency_state = 123456;
        osc.sync_base_frequency = 78910;
        osc.set_tuning(32, 53);
        for wave in [0, 1, 2] {
            osc.set_wave(wave);
            assert_eq!(osc.sync_base_frequency, 78910);
            let previous_ratio = osc.ratio;
            osc.next_sample_with_sync(49767, 0, false);
            let expected = if wave == 2 {
                49767
            } else {
                sat(2 * mul(49767, previous_ratio, 3)) >> 1
            };
            assert_eq!(osc.frequency_state, expected);
            assert_eq!(osc.sync_base_frequency, 78910);
        }
        osc.next_sample_with_sync(64000, 0, true);
        assert_eq!(osc.frequency_state, 64000);
        assert_eq!(osc.sync_base_frequency, 78910);
        osc.set_wave(1);
        let previous_ratio = osc.ratio;
        osc.next_sample_with_sync(65000, 0, true);
        assert_eq!(
            osc.frequency_state,
            sat(2 * mul(78910, previous_ratio, 3)) >> 1
        );
        assert_eq!(osc.sync_base_frequency, 65000);
    }
    #[test]
    fn reset_preserves_delay_allocation_and_clears_history() {
        let mut osc = Oscillator::new();
        let address = osc.feedback.memory.as_ptr();
        osc.set_wave(3);
        osc.set_shape_targets(127, 127);
        osc.set_feedback_note(0);
        for _ in 0..1000 {
            osc.next_sample();
        }
        osc.reset();
        assert_eq!(address, osc.feedback.memory.as_ptr());
        assert!(osc.feedback.memory.iter().all(|&x| x == 0));
        assert_eq!(osc.phase(), 0);
    }
    #[test]
    fn delay_quantization_is_idempotent_and_bounded() {
        for x in (-Q..Q).step_by(257) {
            let y = i64::from(FeedbackState::quantize(x));
            assert!(y <= x && x - y < 1024);
            assert_eq!(FeedbackState::quantize(y), y as i32);
        }
    }
    #[test]
    fn waveform_changes_preserve_running_phase() {
        let mut osc = Oscillator::new();
        osc.set_frequency_word(49767);
        for wave in [1, 4, 6, 4, 1] {
            let phase = osc.phase();
            osc.set_wave(wave);
            osc.set_shape_targets(127, 0);
            osc.next_sample();
            assert_eq!(osc.phase(), wrap(phase + 49767));
        }
    }
    #[test]
    fn oscillator_2_extreme_tuning_and_sync_changes_stay_bounded() {
        let mut osc = Oscillator2::new();
        let mut master = 0;
        for cents in [i32::MIN, -9600, -4800, 0, 4800, 9600, i32::MAX] {
            osc.set_tuning_cents(cents);
            for wave in [0, 1, 2] {
                osc.set_wave(wave);
                osc.set_shape(127);
                for sync in [false, true, false] {
                    for _ in 0..128 {
                        master = wrap(master + 0x309c00);
                        let result = osc.next_sample_with_sync(0x309c00, master, sync);
                        assert!((-Q..Q).contains(&result.audio));
                        assert!((-Q..Q).contains(&result.cross));
                        assert!((-Q..Q).contains(&osc.phase()));
                    }
                }
            }
        }
    }
    #[test]
    fn oscillator_2_reads_old_pitch_ratio_but_new_width_in_each_frame() {
        for sync in [false, true] {
            let mut osc = Oscillator2::new();
            osc.set_wave(0);
            osc.set_loading(true);
            osc.set_shape(64);
            osc.next_sample_with_sync(65_536, 100_000, sync);
            assert_eq!(osc.phase, 0);
            assert!(osc.ratio > 0);
            assert!(osc.shape > 0);
            osc.next_sample_with_sync(65_536, 200_000, sync);
            assert_ne!(osc.phase, 0);
        }
    }
    #[test]
    fn oscillator_2_wide_ratio_rate_is_latched_and_loading_is_unchanged() {
        let mut ordinary = Oscillator2::new();
        ordinary.ratio_target = 262144;
        let mut wide = ordinary.clone();
        wide.set_ratio_wide(true);
        ordinary.next_sample(0);
        wide.next_sample(0);
        assert_eq!(ordinary.ratio, 1024);
        assert_eq!(wide.ratio, 512);
        wide.set_tuning_cents(0);
        assert!(wide.ratio_wide);
        wide.ratio = 0;
        wide.ratio_target = 262144;
        wide.set_loading(true);
        wide.next_sample(0);
        assert_eq!(wide.ratio, 229376);
        wide.reset();
        assert!(!wide.ratio_wide);
    }
    #[test]
    fn signed_cross_modulation_extremes_stay_bounded() {
        for frequency in [-Q, -Q + 1, -0x309c00, -1, 0, 1, 0x309c00, Q - 1] {
            for phase in [-Q, -Q + 1, -1, 0, 1, Q - 1] {
                for shape in [0, Q / 2, 124 << 16] {
                    assert!((-Q..Q).contains(&pulse(phase, shape, frequency)));
                    assert!((-Q..Q).contains(&triangle_mod(phase, shape, frequency)));
                }
            }
        }
    }
    #[test]
    fn full_parameter_domain_is_bounded() {
        for wave in [1, 2, 3, 4, 6] {
            for raw in 0..=127 {
                let mut osc = Oscillator::new();
                osc.set_wave(wave);
                osc.set_shape_targets(raw, 0);
                for frequency in [1, 49767, 0x146e40, 0x309c00] {
                    osc.set_frequency_word(frequency);
                    for _ in 0..64 {
                        assert!((-Q..Q).contains(&osc.next_sample()));
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod generic_program_lifecycle_tests {
    use super::*;

    #[test]
    fn program_template_defaults_are_independent_of_stored_shape_controls() {
        let mut o = Oscillator::new();
        o.set_shape_targets(112, 127);
        o.load_generic_program(3);
        assert_eq!((o.feedback.period_target, o.feedback.depth_target, o.target), (0, 4096, 4096));
        o.load_generic_program(2);
        assert_eq!((o.noise_ct, o.noise_rt), (65536, 4194304));
        for wave in [1, 4, 6] {
            o.load_generic_program(wave);
            assert_eq!(o.target, 4096);
        }
    }

    #[test]
    fn feedback_reload_preserves_physical_history() {
        let mut o = Oscillator::new();
        o.set_wave(3);
        o.set_shape_targets(64, 64);
        o.set_frequency_word(49767);
        o.set_feedback_period_word(172604);
        for _ in 0..2048 { o.next_sample(); }
        let history = (o.phase, o.shape, o.feedback.period, o.feedback.depth, o.feedback.dc, o.feedback.cursor);
        let memory = o.feedback.memory.clone();
        o.load_generic_program(3);
        assert_eq!(history, (o.phase, o.shape, o.feedback.period, o.feedback.depth, o.feedback.dc, o.feedback.cursor));
        assert_eq!(&*memory, &*o.feedback.memory);
    }

    #[test]
    fn generic_pulse_width_is_fast_while_ratio_remains_slow() {
        let mut o = Oscillator2::new();
        o.set_wave(0);
        o.set_loading_modes(false, true);
        o.next_sample(65536);
        assert_eq!(o.ratio, 16385); // floor(4194560/256)
        assert_eq!(o.shape, 3584); // floor(4096*7/8)
        for _ in 0..4096 { o.next_sample(65536); }
        assert_eq!(o.ratio, 4194305);
        assert_eq!(o.shape, 4095);
    }
}

#[cfg(test)]
mod pulse_width_history_tests {
    use super::*;
    #[test]
    fn pulse_uses_prior_width_with_normal_and_fast_loading() {
        for fast in [false, true] {
            let mut o = Oscillator::new();
            o.set_wave(4);
            o.set_frequency_word(24883);
            o.set_shape_targets(102, 0);
            o.set_loading(fast);
            let old = o.shape;
            let y = o.next_sample();
            assert_eq!(y, 1_245_183);
            assert_eq!(y, pulse(o.phase, old, 24883));
            assert_ne!(y, pulse(o.phase, o.shape, 24883));
        }
    }
}

#[cfg(test)]
mod noise_pulse_history_tests {
    use super::*;
    #[test]
    fn generated_noise_state_becomes_pulse_phase_and_width() {
        let mut o = Oscillator::new();
        o.set_wave(2);
        o.set_pitch_cents(-1200);
        o.set_frequency_word(24883);
        o.set_shape_targets(64, 0);
        o.set_loading(false);
        for _ in 0..2048 {
            o.next_sample();
        }
        let expected = (o.noise.x1, o.noise.x2);
        assert_ne!(expected, (o.phase, o.shape));
        assert_eq!(o.inherit_noise_pulse_state(), expected.0);
        o.set_wave(4);
        o.set_shape_targets(102, 0);
        assert_eq!(
            o.next_sample(),
            pulse(wrap(expected.0 + 24883), expected.1, 24883)
        );
    }
}

#[cfg(test)]
mod supersaw_pulse_history_tests {
    use super::*;

    #[test]
    fn inherited_generated_phases_continue_with_previous_width_in_both_load_modes() {
        // Original mathematical histories, including negative wrapped phases.
        for frames in [1, 257, 2048, 8191] {
            let p = wrap(frames * 25011) as i32;
            let w = wrap(frames * 24755) as i32;
            for loading in [false, true] {
                let mut o = Oscillator::new();
                assert_eq!(o.inherit_supersaw_pulse_state(p, w), i64::from(p));
                o.load_generic_program(4);
                assert_eq!((o.phase, o.shape), (i64::from(p), i64::from(w)));
                o.set_frequency_word(24883);
                o.set_shape_targets(102, 0);
                o.set_loading(loading);
                let mut phase = i64::from(p);
                let mut width = i64::from(w);
                for _ in 0..4096 {
                    phase = wrap(phase + 24883);
                    let expected = pulse(phase, width, 24883);
                    width += if loading { (sat(o.target - width) * 112) >> 7 } else { sat(o.target - width) >> 11 };
                    assert_eq!(o.next_sample(), expected);
                    assert_eq!((o.phase, o.shape), (phase, width));
                }
            }
        }
    }
}

impl Oscillator {
    pub(super) fn inherit_noise_coefficients(&mut self, cr:[i64;2]) { self.noise_c=cr[0]; self.noise_r=cr[1]; }
    pub(super) fn noise_tail_writes(&self)->([i64;4],[i64;2],[i64;2]) {
        ([self.noise.lp1,self.noise.bp1,self.noise.lp2,self.noise.bp2], [self.noise.hp1,self.noise.hp2], [self.noise_c,self.noise_r])
    }
}
