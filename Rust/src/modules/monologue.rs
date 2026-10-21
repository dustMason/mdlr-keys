//! Circuit-informed monologue voice. Firmware/control evidence and remaining
//! analog-model assumptions are tracked in docs/monologue-analysis.md.
//! All audio state is fixed-size; oversampling adds 63 / (4 * fs) seconds.
use super::{BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor};
use core::f32::consts::PI;
#[path = "monologue_control.rs"]
mod control;
#[path = "monologue_fir.rs"]
mod decimator;
#[cfg(any(feature = "analysis", test))]
#[path = "monologue_ring.rs"]
mod ring;
#[path = "monologue_ring_aa.rs"]
#[cfg(any(feature = "analysis", test))]
mod ring_aa;
#[path = "monologue_sync.rs"]
mod sync;
use control::{AmpEnvelope, ModEnvelope};

pub const PARAM_COUNT: usize = 64;
const OS: usize = 4;
const FIR_LEN: usize = 127;

pub const DEFAULTS: [f32; PARAM_COUNT] = {
    let mut p = [0.0; PARAM_COUNT];
    p[2] = 1.0;
    p[9] = 1.0;
    p[12] = 1.0;
    p[14] = 0.25;
    p[16] = 2.0;
    p[17] = 1.0;
    p[19] = 0.3;
    p[23] = 0.8;
    p[29] = 1.0;
    p[33] = 120.0;
    p[35] = 1.0;
    p
};

/// Global analog calibration, never a per-patch correction or audio sample bank.
#[derive(Clone, Copy, Debug)]
pub struct Calibration {
    pub cutoff_min: f32,
    pub cutoff_max: f32,
    pub cutoff_curve: f32,
    pub resonance_curve: f32,
    pub resonance_max: f32,
    pub filter_saturation: f32,
    pub vca_curve: f32,
    pub saw_shape_scale: f32,
    pub triangle_fold_slope: f32,
    pub triangle_shape_depth: f32,
    /// The PWM endpoint search uses a roughly 6006 Hz divider triangle. Its
    /// RC-filtered peak is smaller than the low-note triangle used as our unit.
    pub shape_calibration_peak: f32,
    pub drive_gain: f32,
    pub drive_mix_curve: f32,
    pub drive_bass: f32,
    pub output_gain: f32,
}
impl Default for Calibration {
    fn default() -> Self {
        Self {
            cutoff_min: 19.445436,
            cutoff_max: 19_380.219,
            cutoff_curve: 1.0,
            resonance_curve: 0.85,
            resonance_max: 2.3,
            filter_saturation: 0.875,
            vca_curve: 1.0,
            saw_shape_scale: 1.2929688,
            triangle_fold_slope: 2.7,
            triangle_shape_depth: 0.7272949,
            shape_calibration_peak: 0.78,
            drive_gain: 28.0,
            drive_mix_curve: 0.425,
            drive_bass: 0.0,
            output_gain: 0.5,
        }
    }
}
impl Calibration {
    pub fn set(&mut self, name: &str, value: f32) -> Result<(), &'static str> {
        if !value.is_finite() {
            return Err("calibration must be finite");
        }
        let (field, lo, hi) = match name {
            "cutoff_min" => (&mut self.cutoff_min, 2.0, 100.0),
            "cutoff_max" => (&mut self.cutoff_max, 4000.0, 40000.0),
            "cutoff_curve" => (&mut self.cutoff_curve, 0.3, 3.0),
            "resonance_curve" => (&mut self.resonance_curve, 0.3, 4.0),
            "resonance_max" => (&mut self.resonance_max, 1.0, 2.5),
            "filter_saturation" => (&mut self.filter_saturation, 0.05, 4.0),
            "vca_curve" => (&mut self.vca_curve, 0.3, 3.0),
            "saw_shape_scale" => (&mut self.saw_shape_scale, 0.5, 1.5),
            "triangle_fold_slope" => (&mut self.triangle_fold_slope, 1.0, 4.0),
            "triangle_shape_depth" => (&mut self.triangle_shape_depth, 0.0, 1.0),
            "shape_calibration_peak" => (&mut self.shape_calibration_peak, 0.5, 1.1),
            "drive_gain" => (&mut self.drive_gain, 1.0, 60.0),
            "drive_mix_curve" => (&mut self.drive_mix_curve, 0.2, 4.0),
            "drive_bass" => (&mut self.drive_bass, 0.0, 3.0),
            "output_gain" => (&mut self.output_gain, 0.05, 3.0),
            _ => return Err("unknown calibration field"),
        };
        if !(lo..=hi).contains(&value) {
            return Err("calibration outside safe range");
        }
        *field = value;
        Ok(())
    }
}

/// Trapezoidal two-integrator lowpass with nonlinear damping. The negative
/// small-signal damping at high resonance generates self oscillation within
/// the filter; there is no separately injected sine oscillator.
#[derive(Clone, Copy, Default)]
struct Filter {
    band: f32,
    low: f32,
}
impl Filter {
    fn tick(&mut self, input: f32, g: f32, damping: f32, saturation: f32) -> f32 {
        let a = 1.0 + g * (g + damping);
        let rhs = self.band + g * (input - self.low);
        let mut bp = rhs / a;
        for _ in 0..3 {
            let square = bp * bp;
            bp -=
                (a * bp + g * saturation * square * bp - rhs) / (a + 3.0 * g * saturation * square);
        }
        let lp = self.low + g * bp;
        self.band = flush(2.0 * bp - self.band);
        self.low = flush(2.0 * lp - self.low);
        if !lp.is_finite() || self.band.abs() > 20.0 || self.low.abs() > 20.0 {
            *self = Self::default();
            return 0.0;
        }
        lp
    }
}

fn flush(x: f32) -> f32 {
    if x.abs() < 1e-20 {
        0.0
    } else {
        x
    }
}
fn blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        let x = t / dt;
        2.0 * x - x * x - 1.0
    } else if t > 1.0 - dt {
        let x = (t - 1.0) / dt;
        x * x + 2.0 * x + 1.0
    } else {
        0.0
    }
}
fn one_pole(input: f32, coefficient: f32, state: &mut f32) -> f32 {
    let delta = (input - *state) * coefficient;
    let output = *state + delta;
    *state = flush(output + delta);
    output
}
fn triangle_output(
    triangle: f32,
    shape: f32,
    slope: f32,
    depth: f32,
    calibration_peak: f32,
) -> f32 {
    // Voice 0x7778 drives PWM to its rail outside U=16..8175; endpoint
    // saturation bypasses the calibrated interpolation and cannot be scaled.
    let threshold = if shape <= 15.0 / 2304.0 {
        1.5
    } else {
        calibration_peak * (1.3232422 - shape * depth)
    };
    // IC20D/IC12D: inverting 220k/100k summing stage, before waveform selection.
    -2.2 * (triangle - slope * triangle.signum() * (triangle.abs() - threshold).max(0.0))
}
/// The circuit's divider phase is one octave below the raw ramp. A comparator
/// selects the ramp or its inversion, without a parallel dry-wave crossfade.
fn saw_threshold(shape: f32, scale: f32, peak: f32) -> f32 {
    (if shape <= 15.0 / 4096.0 {
        1.0
    } else if shape >= 8176.0 / 4096.0 {
        -1.0
    } else {
        peak * (1.3232422 - shape * scale)
    })
    .clamp(-1.0, 1.0)
}

fn wave(
    phase: f32,
    inc: f32,
    kind: u8,
    shape: f32,
    saw_scale: f32,
    triangle_slope: f32,
    triangle_depth: f32,
    calibration_peak: f32,
) -> f32 {
    let tri = 1.0 - 4.0 * (phase - 0.5).abs();
    match kind {
        1 => {
            // Two precision rectifiers form one symmetric fold. Resistor
            // ratios set its slope; CV moves the threshold, not its gain.
            triangle_output(tri, shape, triangle_slope, triangle_depth, calibration_peak)
        }
        2 => {
            let u = 0.5 + shape * 0.5;
            let threshold = if u <= 15.0 / 8192.0 {
                1.0
            } else if u >= 8176.0 / 8192.0 {
                -1.0
            } else {
                calibration_peak * (1.3232422 - 2.5859375 * u)
            };
            let width = ((1.0 - threshold) * 0.5).clamp(0.0, 1.0);
            if width == 0.0 {
                return -1.0;
            }
            if width == 1.0 {
                return 1.0;
            }
            let rising = (1.0 - width) * 0.5;
            let falling = 1.0 - rising;
            (if phase >= rising && phase < falling {
                1.0
            } else {
                -1.0
            }) + blep((phase - rising).rem_euclid(1.0), inc)
                - blep((phase - falling).rem_euclid(1.0), inc)
        }
        _ => {
            let threshold = saw_threshold(shape, saw_scale, calibration_peak);
            let edge = (threshold + 1.0) * 0.25;
            let raw = 2.0 * (2.0 * phase).fract() - 1.0;
            let switched = if phase >= edge && phase < 1.0 - edge {
                -raw
            } else {
                raw
            };
            // Correct both raw-ramp wraps and the two comparator jumps.
            switched - blep(phase, inc) + blep((phase - 0.5).rem_euclid(1.0), inc)
                - threshold
                    * (blep((phase - edge).rem_euclid(1.0), inc)
                        + blep((phase - (1.0 - edge)).rem_euclid(1.0), inc))
        }
    }
}

pub struct Monologue {
    target: [f32; PARAM_COUNT],
    current: [f32; PARAM_COUNT],
    pub calibration: Calibration,
    phase: [f32; 2],
    sync: sync::SyncOscillator,
    free_triangle: [sync::FreeTriangle; 2],
    #[cfg(feature = "analysis")]
    analysis_triangle_aa: bool,
    #[cfg(feature = "analysis")]
    ring: ring::RingModulator,
    #[cfg(feature = "analysis")]
    ring_antialias: ring_aa::RingAntialias,
    #[cfg(feature = "analysis")]
    product_antialias: ring_aa::ProductAntialias,
    #[cfg(feature = "analysis")]
    analysis_ring_model: u8,
    filter: Filter,
    triangle_rc: [f32; 2],
    saw_rc: [f32; 2],
    vca_rc: [f32; 2],
    modulation: ModEnvelope,
    amplitude: AmpEnvelope,
    previous_gate: bool,
    pending_note: bool,
    pending_phrase: bool,
    pitch: f32,
    velocity: f32,
    key_note: u8,
    lfo_phase: f32,
    lfo_finished: bool,
    noise: u32,
    noise_low: f32,
    drive_low: f32,
    dc_input: f32,
    dc_output: f32,
    history: [f32; FIR_LEN],
    history_pos: usize,
}

impl Default for Monologue {
    fn default() -> Self {
        Self::new()
    }
}
impl Monologue {
    pub fn new() -> Self {
        Self {
            target: DEFAULTS,
            current: DEFAULTS,
            calibration: Calibration::default(),
            phase: [0.137, 0.731],
            sync: sync::SyncOscillator::default(),
            free_triangle: [sync::FreeTriangle::default(), sync::FreeTriangle::default()],
            #[cfg(feature = "analysis")]
            analysis_triangle_aa: true,
            #[cfg(feature = "analysis")]
            ring: ring::RingModulator::new(48_000.0 * OS as f32),
            #[cfg(feature = "analysis")]
            ring_antialias: ring_aa::RingAntialias::new(),
            #[cfg(feature = "analysis")]
            product_antialias: ring_aa::ProductAntialias::new(),
            #[cfg(feature = "analysis")]
            analysis_ring_model: 0,
            filter: Filter::default(),
            triangle_rc: [0.0; 2],
            saw_rc: [0.0; 2],
            vca_rc: [0.0; 2],
            modulation: ModEnvelope::new(),
            amplitude: AmpEnvelope::new(),
            previous_gate: false,
            pending_note: false,
            pending_phrase: false,
            pitch: 0.0,
            velocity: 1.0,
            key_note: 48,
            lfo_phase: 0.0,
            lfo_finished: false,
            noise: 0x6d6f6e6f,
            noise_low: 0.0,
            drive_low: 0.0,
            dc_input: 0.0,
            dc_output: 0.0,
            history: [0.0; FIR_LEN],
            history_pos: 0,
        }
    }
    pub fn parameter(&self, id: usize) -> f32 {
        self.target.get(id).copied().unwrap_or(0.0)
    }
    /// Offline/preset setup before playback; never used to bypass live smoothing.
    pub fn settle_parameters(&mut self) {
        self.current = self.target;
    }
    /// Offline-only initialization for measuring unknown analog oscillator phase.
    /// This is not a patch control and does not reset phase on live note events.
    #[cfg(feature = "analysis")]
    pub fn set_analysis_phases(&mut self, phases: [f32; 2]) -> Result<(), &'static str> {
        if phases.iter().any(|x| !x.is_finite()) {
            return Err("oscillator phases must be finite");
        }
        self.phase = phases.map(|x| x.rem_euclid(1.0));
        Ok(())
    }
    /// Offline initial state for recordings with an unobserved free-running LFO.
    /// Key sync, Fast and One Shot retrigger normally after initialization.
    #[cfg(feature = "analysis")]
    pub fn set_analysis_lfo_phase(&mut self, phase: f32) -> Result<(), &'static str> {
        if !phase.is_finite() {
            return Err("LFO phase must be finite");
        }
        self.lfo_phase = phase.rem_euclid(1.0);
        self.lfo_finished = false;
        Ok(())
    }
    /// Declare a resting prehistory for offline recording comparisons. This
    /// never writes capacitor or filter states: those settle through rendering.
    /// Oscillator/LFO phase seeds precede the idle interval and are not reset
    /// afterward. A completed One Shot resumes normally on the next note.
    #[cfg(feature = "analysis")]
    pub fn prepare_analysis_idle(&mut self, note: u8, velocity: f32) {
        self.set_key_note(note);
        self.set_velocity(velocity);
        self.pitch = (note as f32 - 48.0) / 12.0 + self.tuning_cents(note) / 1200.0;
        if self.current[18] >= 1.5 {
            self.lfo_phase = 0.5;
            self.lfo_finished = true;
        }
    }
    /// Offline circuit experiments. Native playback retains the scalar product.
    #[cfg(feature = "analysis")]
    pub fn set_analysis_triangle_antialias(&mut self, enabled: bool) {
        self.analysis_triangle_aa = enabled;
    }
    #[cfg(feature = "analysis")]
    pub fn set_analysis_ring_model(&mut self, model: &str) -> Result<(), &'static str> {
        self.analysis_ring_model = match model {
            "product" => 0,
            "bridge" => 1,
            "coupled-product" => 2,
            "bridge-coupled" => 3,
            "bridge-coupled-aa" => 4,
            "product-aa" => 5,
            _ => {
                return Err(
                    "ring model must be product, bridge, coupled-product, bridge-coupled, bridge-coupled-aa, or product-aa",
                )
            }
        };
        Ok(())
    }
    pub fn set_velocity(&mut self, velocity: f32) {
        if velocity.is_finite() {
            self.velocity = velocity.clamp(0.0, 1.0);
        }
    }
    /// Original key number, before oscillator octave, glide, bend, or tuning.
    pub fn set_key_note(&mut self, note: u8) {
        self.key_note = note.min(127);
    }
    /// Explicit note event: pitch bend and tuning edits must not retrigger EG.
    pub fn note_on(&mut self, from_silence: bool) {
        self.pending_note = true;
        self.pending_phrase |= from_silence;
    }
    pub fn tuning_cents(&self, note: u8) -> f32 {
        self.target[48 + note as usize % 12]
    }

    pub fn midi_cc(&mut self, cc: u8, value: u8) {
        // Main0x19af8 expands continuous CCs by bit replication. In particular
        // MIDI64 becomes516, so zero bipolar depth is not represented by a CC.
        let seven = value.min(127) as u16;
        let raw = (seven << 3) | (seven >> 4);
        let normalized = raw as f32 / 1023.0;
        let delta = raw as f32 - 512.0;
        let bipolar = delta / if delta < 0.0 { 512.0 } else { 511.0 };
        let three = if value < 43 {
            0
        } else if value < 86 {
            1
        } else {
            2
        };
        let (id, v) = match cc {
            5 => (22, seven as f32 / 127.0),
            16 => (13, normalized),
            17 => (14, normalized),
            24 => (19, normalized),
            25 => (15, bipolar),
            26 => (20, bipolar),
            28 => (11, normalized),
            34 => (30, pitch_cents(raw)),
            35 => (7, pitch_cents(raw)),
            36 => (1, normalized),
            37 => (4, normalized),
            39 => (2, normalized),
            40 => (5, normalized),
            43 => (9, normalized),
            44 => (10, normalized),
            48 => (31, (value / 32) as f32 - 1.0),
            49 => (6, (value / 32) as f32 - 1.0),
            50 => (0, (2 - three) as f32),
            51 => (3, (2 - three) as f32),
            56 => (21, (2 - three) as f32),
            58 => (17, (2 - three) as f32),
            59 => (18, [2.0, 0.0, 1.0][three]),
            60 => (8, [2.0, 0.0, 1.0][three]),
            61 => (12, (2 - three) as f32),
            62 => (16, (2 - three) as f32),
            _ => return,
        };
        self.set_float_param(id, v);
    }

    fn oscillator(&mut self, index: usize, kind: u8, shape: f32, inc: f32, rc: f32) -> f32 {
        let triangle = self.free_triangle[index].sample(self.phase[index], inc);
        #[cfg(feature = "analysis")]
        let triangle = if self.analysis_triangle_aa {
            triangle
        } else {
            1.0 - 4.0 * (self.phase[index] - 0.5).abs()
        };
        let triangle = one_pole(triangle, rc, &mut self.triangle_rc[index]);
        let c = self.calibration;
        if kind == 1 {
            return triangle_output(
                triangle,
                shape,
                c.triangle_fold_slope,
                c.triangle_shape_depth,
                c.shape_calibration_peak,
            );
        }
        // Comparator edges use ideal triangle phase for analytic BLEP. The RC's
        // small edge displacement and finite comparator slew remain approximations.
        let signal = wave(
            self.phase[index],
            inc,
            kind,
            shape,
            c.saw_shape_scale,
            c.triangle_fold_slope,
            c.triangle_shape_depth,
            c.shape_calibration_peak,
        );
        if kind == 0 {
            one_pole(signal, rc, &mut self.saw_rc[index])
        } else {
            signal * (7.0 * 150.0 / (2350.0 * 1.1))
        } // Nominal 7Vpp comparator into150/(2200+150).
    }
    fn synced_oscillator(
        &mut self,
        kind: u8,
        shape: f32,
        inc: f32,
        reset: Option<f32>,
        rc: f32,
    ) -> f32 {
        let c = self.calibration;
        let [triangle, saw] = self.sync.sample(
            self.phase[1],
            inc,
            reset,
            saw_threshold(shape, c.saw_shape_scale, c.shape_calibration_peak),
        );
        let triangle = one_pole(triangle, rc, &mut self.triangle_rc[1]);
        if kind == 1 {
            triangle_output(
                triangle,
                shape,
                c.triangle_fold_slope,
                c.triangle_shape_depth,
                c.shape_calibration_peak,
            )
        } else {
            one_pole(saw, rc, &mut self.saw_rc[1])
        }
    }
    fn sample(
        &mut self,
        raw_pitch: f32,
        bend: f32,
        gate: bool,
        sr: f32,
        smooth: f32,
        rc: [f32; 2],
    ) -> f32 {
        for i in 0..37 {
            if matches!(
                i,
                0 | 3 | 6 | 8 | 12 | 16 | 17 | 18 | 21 | 25 | 26 | 29 | 31 | 32
            ) {
                self.current[i] = self.target[i];
            } else {
                self.current[i] += (self.target[i] - self.current[i]) * smooth;
            }
        }
        let p = self.current;
        let c = self.calibration;
        let rising = gate && !self.previous_gate;
        let note_event = self.pending_note;
        let new_phrase = self.pending_phrase;
        self.pending_note = false;
        self.pending_phrase = false;
        let trigger = gate && (rising || new_phrase || (note_event && p[26] < 0.5));
        if trigger {
            self.modulation.trigger();
            self.amplitude.trigger();
        }
        if (rising || note_event) && (p[25] >= 0.5 || p[18] >= 0.5) {
            self.lfo_phase = 0.0;
            self.lfo_finished = false;
        }
        if !gate && self.previous_gate {
            self.modulation.release();
            self.amplitude.release();
        }
        let glide_seconds = 0.001 + 2.0 * p[22] * p[22];
        if p[22] <= 0.0001 || ((rising || new_phrase) && p[29] >= 0.5) {
            self.pitch = raw_pitch;
        } else {
            self.pitch += (raw_pitch - self.pitch) * (1.0 - (-1.0 / (glide_seconds * sr)).exp());
        }
        let tick_scale = control::CONTROL_RATE / sr as f64;
        let attack_raw = (p[13] * 1023.0).round() as u16;
        let decay_raw = (p[14] * 1023.0).round() as u16;
        let attack = control::envelope_step(attack_raw, true) * tick_scale;
        let decay = control::envelope_step(decay_raw, false) * tick_scale;
        let eg_type = p[12] as u8;
        let mod_decay = if eg_type == 2 && decay_raw == 1023 {
            0.0
        } else {
            decay
        };
        let env = self
            .modulation
            .tick(attack, mod_decay, eg_type == 1 && gate);
        let amp_attack = if eg_type == 2 {
            control::envelope_step(0, true) * tick_scale
        } else {
            attack
        };
        let amp_decay = if eg_type == 2 {
            control::envelope_step(0, false) * tick_scale
        } else {
            decay
        };
        let amp = self.amplitude.tick(
            amp_attack,
            amp_decay,
            eg_type != 0 && gate,
            tick_scale,
            control::amp_mute_step(if eg_type == 2 { 0 } else { attack_raw }) * tick_scale,
            c.vca_curve,
        );
        let mode = p[18] as usize;
        let lfo_hz = if p[32] >= 0.5 {
            let divisions = [
                4.0,
                2.0,
                1.0,
                0.75,
                0.5,
                0.375,
                1.0 / 3.0,
                0.25,
                0.1875,
                1.0 / 6.0,
                0.125,
                1.0 / 12.0,
                0.0625,
                1.0 / 24.0,
                0.03125,
                1.0 / 36.0,
            ];
            // Main0x9314 also multiplies the clock-synced fast branch by32.
            p[33] / 240.0 / divisions[(p[19] * 16.0).min(15.0) as usize]
                * if mode == 1 { 32.0 } else { 1.0 }
        } else if mode == 1 {
            control::lfo_fast_hz((p[19] * 1023.0).round() as u16)
        } else {
            control::lfo_slow_hz((p[19] * 1023.0).round() as u16)
        };
        if mode != 2 {
            self.lfo_finished = false;
        }
        let lfo_phase = self.lfo_phase;
        if !self.lfo_finished {
            self.lfo_phase += lfo_hz / sr;
            if mode == 2 && self.lfo_phase >= 0.5 {
                self.lfo_phase = 0.5;
                self.lfo_finished = true;
            } else if self.lfo_phase >= 1.0 {
                self.lfo_phase -= self.lfo_phase.floor();
            }
        }
        let lfo_wave = if self.lfo_finished && mode == 2 {
            0.0
        } else {
            match p[17] as u8 {
                0 => 1.0 - 2.0 * lfo_phase,
                2 => {
                    if lfo_phase < 0.5 {
                        1.0
                    } else {
                        -1.0
                    }
                }
                _ => {
                    if lfo_phase < 0.25 {
                        4.0 * lfo_phase
                    } else if lfo_phase < 0.75 {
                        2.0 - 4.0 * lfo_phase
                    } else {
                        4.0 * lfo_phase - 4.0
                    }
                }
            }
        };
        let lfo = lfo_wave * p[20] * if p[20] >= 0.0 { 511.0 / 512.0 } else { 1.0 };
        let eg_raw = bipolar_raw(p[15]);
        let base = 36.0 + (self.pitch + bend) * 12.0 + p[28] / 100.0;
        let common = if p[21] < 0.5 {
            lfo_wave * control::lfo_pitch_semitones(bipolar_raw(p[20]))
        } else {
            0.0
        };
        let eg_pitch = env * pitch_cents(eg_raw) * 0.04;
        let note1 =
            base + p[31] * 12.0 + p[30] / 100.0 + common + if p[16] < 0.5 { eg_pitch } else { 0.0 };
        let note2 =
            base + p[6] * 12.0 + p[7] / 100.0 + common + if p[16] < 1.5 { eg_pitch } else { 0.0 };
        let internal = sr * OS as f32;
        let inc1 = (440.0 * 2.0_f32.powf((note1 - 69.0) / 12.0) / internal).clamp(1e-7, 0.2);
        let inc2 = (440.0 * 2.0_f32.powf((note2 - 69.0) / 12.0) / internal).clamp(1e-7, 0.2);
        let shape_mod = if (0.5..1.5).contains(&p[21]) {
            lfo
        } else {
            0.0
        };
        // Voice 0x9700 LUT: saw/triangle CV folds negative modulation for
        // non-square LFOs; a square LFO selects the clamp-to-zero table.
        let shape1 =
            control::shape_control(p[1] * 1023.0 / 1024.0 + shape_mod, p[0] as u8, p[17] >= 1.5);
        let shape2 =
            control::shape_control(p[4] * 1023.0 / 1024.0 + shape_mod, p[3] as u8, p[17] >= 1.5);
        // Voice 0x845c + ISR: bipolar LFO spans half the full cutoff-CV
        // control range. Convert that CV through the modeled frequency curve.
        let note_offset = control::cutoff_note_offset(
            self.key_note,
            (self.velocity * 127.0).round() as u8,
            (p[24] * 2.0).round() as u8,
            (p[27] * 2.0).round() as u8,
        );
        let note_cutoff =
            ((p[9] * 8192.0).floor() + note_offset as f32).clamp(0.0, 8191.0) / 8192.0;
        let cutoff_control = (note_cutoff
            + if p[16] >= 1.5 {
                env * control::cutoff_eg_depth(eg_raw)
            } else {
                0.0
            }
            + if p[21] >= 1.5 { 0.5 * lfo } else { 0.0 })
        .clamp(0.0, 1.0);
        let cutoff = (c.cutoff_min
            * (c.cutoff_max / c.cutoff_min).powf(cutoff_control.powf(c.cutoff_curve)))
        .clamp(5.0, sr * 0.46);
        let g = (PI * cutoff / internal).tan();
        let damping = 2.0 - c.resonance_max * p[10].powf(c.resonance_curve);
        let drive_mix = p[11].powf(c.drive_mix_curve);
        let bass_alpha = 1.0 - (-2.0 * PI * 160.0 / internal).exp();
        let dc_r = (-2.0 * PI * 8.0 / internal).exp();
        let velocity_gain = (1.0 - p[35] + p[35] * self.velocity) * 10.0_f32.powf(p[36] / 20.0);
        let synced = (0.5..1.5).contains(&p[8]);
        if !synced || p[3] >= 1.5 {
            self.sync.clear();
        }
        // A disabled free-running slave must not retain a correction from an
        // unrelated old phase when returning from reset or noise operation.
        if synced || p[3] >= 1.5 {
            self.free_triangle[1].clear();
        }
        for _ in 0..OS {
            let w1 = self.oscillator(0, p[0] as u8, shape1, inc1, rc[0]);
            self.noise ^= self.noise << 13;
            self.noise ^= self.noise >> 17;
            self.noise ^= self.noise << 5;
            let white = self.noise as i32 as f32 / i32::MAX as f32;
            self.noise_low +=
                (white - self.noise_low) * (0.02 + 0.97 * (1.0 - shape2.clamp(0.0, 1.0)).powi(3));
            let w2 = if p[3] >= 1.5 {
                self.noise_low
            } else if synced {
                let reset = (self.phase[0] + inc1 >= 1.0)
                    .then(|| ((1.0 - self.phase[0]) / inc1).clamp(0.0, 1.0));
                self.synced_oscillator(p[3] as u8, shape2, inc2, reset, rc[0])
            } else {
                self.oscillator(1, p[3] as u8, shape2, inc2, rc[0])
            };
            let ring_enabled = p[8] >= 1.5;
            // Alternative ring integrators remain offline experiments.
            #[cfg(feature = "analysis")]
            let (averaged_w1, averaged_product) = self.product_antialias.process(w1, w2);
            #[cfg(not(feature = "analysis"))]
            let (source1, source2) = (w1, if ring_enabled { w1 * w2 } else { w2 });
            #[cfg(feature = "analysis")]
            let (source1, source2) = {
                // The physical circuit remains an offline experiment: it
                // regressed held development recordings under fixed testing.
                let (a, b) = self.ring.process_sources(w1, w2, ring_enabled);
                let (averaged_a, averaged_bridge) = self.ring_antialias.process(a, b);
                let (ring_dry, bridge) = match self.analysis_ring_model {
                    2 => (a, a * b),
                    4 => (averaged_a, averaged_bridge),
                    _ => (a, ring::transfer(a, b)),
                };
                let returned = self.ring.process_return(bridge, ring_enabled);
                match self.analysis_ring_model {
                    0 => (w1, if ring_enabled { w1 * w2 } else { w2 }),
                    1 => (
                        w1,
                        if ring_enabled {
                            ring::transfer(w1, w2)
                        } else {
                            w2
                        },
                    ),
                    5 => {
                        if ring_enabled {
                            (averaged_w1, averaged_product)
                        } else {
                            (w1, w2)
                        }
                    }
                    _ => (
                        if ring_enabled { ring_dry } else { a },
                        if ring_enabled { returned } else { b },
                    ),
                }
            };
            let mixed = (one_pole(source1, rc[1], &mut self.vca_rc[0]) * p[2]
                + one_pole(source2, rc[1], &mut self.vca_rc[1]) * p[5])
                * 0.5;
            let filtered = self.filter.tick(mixed, g, damping, c.filter_saturation);
            // Service schematic KLM-3621 sheet 5: voice VCA, then parallel dry
            // and diode-drive/low-boost branches, then output summing amplifier.
            let dry = filtered * amp * velocity_gain;
            let distorted = (dry * c.drive_gain).tanh();
            self.drive_low += (distorted - self.drive_low) * bass_alpha;
            let wet = (distorted + c.drive_bass * self.drive_low) * 0.65;
            let sample = (dry * (1.0 - drive_mix) + wet * drive_mix) * p[23] * c.output_gain;
            let dc = sample - self.dc_input + dc_r * self.dc_output;
            self.dc_input = sample;
            self.dc_output = flush(dc);
            self.history[self.history_pos] = dc;
            self.history_pos = (self.history_pos + 1) % FIR_LEN;
            self.phase[0] += inc1;
            self.phase[1] += inc2;
            if self.phase[0] >= 1.0 {
                self.phase[0] -= 1.0;
                if (0.5..1.5).contains(&p[8]) {
                    self.phase[1] = self.phase[0] / inc1 * inc2;
                }
            }
            self.phase[1] -= self.phase[1].floor();
        }
        let mut output = 0.0;
        for i in 0..FIR_LEN / 2 {
            output += decimator::COEFFICIENTS[i]
                * (self.history[(self.history_pos + FIR_LEN - 1 - i) % FIR_LEN]
                    + self.history[(self.history_pos + i) % FIR_LEN]);
        }
        output += decimator::COEFFICIENTS[FIR_LEN / 2]
            * self.history[(self.history_pos + FIR_LEN / 2) % FIR_LEN];
        self.previous_gate = gate;
        if output.is_finite() {
            output.clamp(-1.0, 1.0)
        } else {
            0.0
        }
    }
}

impl ModuleProcessor for Monologue {
    fn set_float_param(&mut self, id: u32, value: f32) {
        if !value.is_finite() {
            return;
        }
        let i = id as usize;
        let v = match i {
            0 | 3 | 8 | 12 | 16 | 17 | 18 | 21 => value.round().clamp(0.0, 2.0),
            6 | 31 => value.round().clamp(-1.0, 2.0),
            7 | 30 => value.clamp(-1200.0, 1200.0),
            15 | 20 => value.clamp(-1.0, 1.0),
            28 | 48..=59 => value.clamp(-100.0, 100.0),
            33 => value.clamp(10.0, 300.0),
            36 => value.clamp(-25.0, 25.0),
            25 | 26 | 29 | 32 => value.round().clamp(0.0, 1.0),
            0..=35 => value.clamp(0.0, 1.0),
            _ => return,
        };
        self.target[i] = v;
    }
    fn process_block(
        &mut self,
        context: &BlockContext,
        inputs: &ModuleInputs,
        outputs: &mut ModuleOutputs,
    ) {
        let sr = if context.sample_rate.is_finite() {
            context.sample_rate.clamp(8000.0, 192000.0)
        } else {
            48000.0
        };
        let smooth = 1.0 - (-1.0 / (0.002 * sr)).exp();
        #[cfg(feature = "analysis")]
        self.ring.set_sample_rate(sr * OS as f32);
        let rc = [
            1.0 / (2.0 * PI * 180.0 * 47e-9),
            1.0 / (2.0 * PI * 100_000.0 * 47e-12),
        ]
        .map(|frequency: f32| {
            let g = (PI * frequency.min(sr * OS as f32 * 0.45) / (sr * OS as f32)).tan();
            g / (1.0 + g)
        });
        for i in 0..context.frames.min(super::MAX_BLOCK_FRAMES) {
            let pitch = if inputs[0][i].is_finite() {
                inputs[0][i].clamp(-8.0, 8.0)
            } else {
                0.0
            };
            let bend = if inputs[2][i].is_finite() {
                inputs[2][i].clamp(-2.0, 2.0)
            } else {
                0.0
            };
            let x = self.sample(pitch, bend, inputs[1][i] > 0.5, sr, smooth, rc);
            outputs[0][i] = x;
            outputs[1][i] = x;
            outputs[2][i] = self.modulation.value;
            outputs[3][i] = self.lfo_phase;
        }
    }
}
impl crate::Instrument for Monologue {
    fn key_note(&mut self, _: usize, note: u8) {
        self.set_key_note(note);
    }
    fn velocity(&mut self, _: usize, value: f32) {
        self.set_velocity(value);
    }
    fn tuning_cents(&self, note: u8) -> f32 {
        self.tuning_cents(note)
    }
    fn midi_cc(&mut self, cc: u8, value: u8) {
        self.midi_cc(cc, value);
    }
    fn note_on(&mut self, from_silence: bool) {
        self.note_on(from_silence);
    }
    fn silence(&mut self) {
        self.filter = Filter::default();
        self.sync.clear();
        for triangle in &mut self.free_triangle {
            triangle.clear();
        }
        #[cfg(feature = "analysis")]
        {
            self.ring.reset();
            self.ring_antialias.reset();
            self.product_antialias.reset();
        }
        self.triangle_rc.fill(0.0);
        self.saw_rc.fill(0.0);
        self.vca_rc.fill(0.0);
        self.modulation = ModEnvelope::new();
        self.amplitude = AmpEnvelope::new();
        self.previous_gate = false;
        self.pending_note = false;
        self.pending_phrase = false;
        self.drive_low = 0.0;
        self.dc_input = 0.0;
        self.dc_output = 0.0;
        self.history.fill(0.0);
    }
}

/// Reconstruct the ten-bit knob from the bipolar UI/preset representation.
fn bipolar_raw(value: f32) -> u16 {
    (512.0 + value * if value < 0.0 { 512.0 } else { 511.0 })
        .round()
        .clamp(0.0, 1023.0) as u16
}

/// Main0x9018's piecewise pitch law, converted from256 units per semitone.
pub fn pitch_cents(raw: u16) -> f32 {
    // Main0x9018 returns fixed-point pitch units; main0x9172 uses3072
    // units per octave. The MIDI document's curve values are not cents.
    let delta = raw.min(1023) as i32 - 512;
    let d = delta.abs();
    let units = match d {
        0..=19 => 0,
        20..=35 => d - 20,
        36..=155 => 2 * d - 56,
        156..=507 => 8 * d - 992,
        _ => 3072,
    };
    (units * delta.signum()) as f32 * (100.0 / 256.0)
}

/// Parse an extracted .molgprog Prog_000.prog_bin, not its ZIP envelope.
/// Based on Korg Table 2; the document's later P1 summary incorrectly rotates
/// the upper-byte offsets for EG INT, LFO RATE and LFO INT. Table 2 is used.
pub fn program_parameters(bytes: &[u8]) -> Result<[f32; PARAM_COUNT], &'static str> {
    if bytes.len() != 448 || &bytes[..4] != b"PROG" || &bytes[48..52] != b"SEQD" {
        return Err("expected a 448-byte monologue PROG/SEQD program");
    }
    let word = |hi: usize, lo: usize, shift: u8| -> f32 {
        (((bytes[hi] as u16) << 2) | ((bytes[lo] as u16 >> shift) & 3)) as f32
    };
    let mut p = DEFAULTS;
    let wave1 = bytes[30] >> 6;
    let wave2 = bytes[31] >> 6;
    let eg = bytes[34] & 3;
    let eg_target = bytes[34] >> 6;
    let lfo = bytes[36] & 3;
    let lfo_mode = (bytes[36] >> 2) & 3;
    let lfo_target = (bytes[36] >> 4) & 3;
    let sync = bytes[32] & 3;
    if [wave1, wave2, eg, eg_target, lfo, lfo_mode, lfo_target, sync]
        .iter()
        .any(|v| *v > 2)
    {
        return Err("invalid program switch value");
    }
    p[0] = (2 - wave1) as f32;
    p[1] = word(17, 30, 2) / 1023.0;
    p[2] = word(20, 33, 0) / 1023.0;
    p[3] = (2 - wave2) as f32;
    p[4] = word(19, 31, 2) / 1023.0;
    p[5] = word(21, 33, 2) / 1023.0;
    p[6] = ((bytes[31] >> 4) & 3) as f32 - 1.0;
    p[7] = pitch_cents(word(18, 31, 0) as u16);
    p[8] = [2.0, 0.0, 1.0][sync as usize];
    p[9] = word(22, 33, 4) / 1023.0;
    p[10] = word(23, 33, 6) / 1023.0;
    p[11] = word(29, 35, 6) / 1023.0;
    p[12] = (2 - eg) as f32;
    p[13] = word(24, 34, 2) / 1023.0;
    p[14] = word(25, 34, 4) / 1023.0;
    let eg_int = word(26, 35, 0) - 512.0;
    p[15] = eg_int / if eg_int < 0.0 { 512.0 } else { 511.0 };
    p[16] = (2 - eg_target) as f32;
    p[17] = (2 - lfo) as f32;
    p[18] = [2.0, 0.0, 1.0][lfo_mode as usize];
    p[19] = word(27, 35, 2) / 1023.0;
    let lfo_int = word(28, 35, 4) - 512.0;
    p[20] = lfo_int / if lfo_int < 0.0 { 512.0 } else { 511.0 };
    p[21] = (2 - lfo_target) as f32;
    p[22] = bytes[41] as f32 / 129.0;
    p[24] = ((bytes[44] >> 6) & 3).min(2) as f32 / 2.0;
    p[27] = ((bytes[44] >> 4) & 3).min(2) as f32 / 2.0;
    p[28] = bytes[37] as f32 - 50.0;
    p[29] = 1.0 - (bytes[44] & 1) as f32;
    p[30] = pitch_cents(word(16, 30, 0) as u16);
    p[31] = ((bytes[30] >> 4) & 3) as f32 - 1.0;
    p[32] = ((bytes[44] >> 3) & 1) as f32;
    p[33] = ((bytes[52] as u16) | ((bytes[53] as u16 & 15) << 8)) as f32 / 10.0;
    p[35] = bytes[46] as f32 / 127.0;
    p[36] = (bytes[45] as f32 - 102.0).clamp(-25.0, 25.0);
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::MAX_BLOCK_FRAMES;
    use crate::Instrument;
    fn block(s: &mut Monologue, pitch: f32, gate: bool, rate: f32) -> ModuleOutputs {
        let mut inputs = [[0.0; 128]; 15];
        let mut outputs = [[0.0; 128]; 4];
        inputs[0].fill(pitch);
        inputs[1].fill(if gate { 1.0 } else { 0.0 });
        s.process_block(
            &BlockContext {
                sample_rate: rate,
                frames: 128,
                tempo_bpm: 120.0,
                transport_sixteenth_position: 0.0,
            },
            &inputs,
            &mut outputs,
        );
        outputs
    }
    #[test]
    fn sync_ring_and_mode_transitions_do_not_depend_on_callback_size() {
        let render = |chunk: usize| {
            let mut voice = Monologue::new();
            voice.set_float_param(2, 0.3);
            voice.set_float_param(5, 0.8);
            voice.set_float_param(4, 0.42);
            voice.set_float_param(7, 317.0);
            voice.settle_parameters();
            let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; 15];
            inputs[0].fill(2.0);
            inputs[1].fill(1.0);
            let mut audio = Vec::new();
            for mode in [0.0, 1.0, 2.0, 1.0, 0.0] {
                voice.set_float_param(8, mode);
                let mut remaining = 512;
                while remaining > 0 {
                    let frames = chunk.min(remaining);
                    let mut output = [[0.0; MAX_BLOCK_FRAMES]; 4];
                    voice.process_block(
                        &BlockContext {
                            sample_rate: 48_000.0,
                            frames,
                            tempo_bpm: 120.0,
                            transport_sixteenth_position: 0.0,
                        },
                        &inputs,
                        &mut output,
                    );
                    audio.extend_from_slice(&output[0][..frames]);
                    remaining -= frames;
                }
            }
            audio
        };
        let expected = render(128);
        for chunk in [1, 7, 17, 64] {
            assert_eq!(expected, render(chunk));
        }
    }
    #[test]
    fn pitch_dead_zone_and_endpoints_match_documented_control() {
        for raw in 492..=532 {
            assert_eq!(pitch_cents(raw), 0.0);
        }
        for (raw, cents) in [
            (0, -1200.0),
            (356, -100.0),
            (476, -6.25),
            (548, 6.25),
            (550, 7.8125),
            (668, 100.0),
            (1023, 1200.0),
        ] {
            assert_eq!(pitch_cents(raw), cents);
        }
        assert!((0..1023).all(|x| pitch_cents(x) <= pitch_cents(x + 1)));
    }
    #[test]
    fn program_uses_table_two_bitfields_and_rejects_truncation() {
        let mut p = [0u8; 448];
        p[..4].copy_from_slice(b"PROG");
        p[48..52].copy_from_slice(b"SEQD");
        p[26] = 128;
        p[27] = 64;
        p[28] = 255;
        p[35] = 0b00_11_10_01;
        let parsed = program_parameters(&p).unwrap();
        assert_eq!(parsed[15], 1.0 / 511.0);
        assert_eq!(parsed[19], 258.0 / 1023.0);
        assert_eq!(parsed[20], 1.0);
        // Negative range has512 steps; raw0 andraw1 remain distinct.
        p[28] = 0;
        p[35] &= !0b00110000;
        assert_eq!(program_parameters(&p).unwrap()[20], -1.0);
        p[35] |= 0b00010000;
        assert_eq!(program_parameters(&p).unwrap()[20], -511.0 / 512.0);
        assert_eq!(parsed[0], 2.0);
        assert_eq!(parsed[3], 2.0);
        assert_eq!(parsed[8], 2.0);
        for length in 0..448 {
            assert!(program_parameters(&p[..length]).is_err());
        }
        p[30] = 0xc0;
        assert!(program_parameters(&p).is_err());
    }
    #[test]
    fn saw_switch_has_double_frequency_ramp_and_shape_subharmonic() {
        let amplitude = |kind: u8, shape: f32, harmonic: f32| {
            let mut sin = 0.0;
            let mut cos = 0.0;
            for i in 0..4096 {
                let phase = (i as f32 + 0.5) / 4096.0;
                let c = Calibration::default();
                let w = wave(
                    phase,
                    1.0 / 4096.0,
                    kind,
                    shape,
                    c.saw_shape_scale,
                    c.triangle_fold_slope,
                    c.triangle_shape_depth,
                    c.shape_calibration_peak,
                );
                let angle = 2.0 * PI * phase * harmonic;
                sin += w * angle.sin();
                cos += w * angle.cos();
            }
            (sin * sin + cos * cos).sqrt() / 2048.0
        };
        // The hardware's divider creates a triangle at f and raw saw at2f.
        assert!(amplitude(1, 0.0, 1.0) > 0.8);
        assert!(amplitude(0, 0.0, 1.0) < 1e-5);
        assert!(amplitude(0, 0.0, 2.0) > 0.63);
        // Comparator shaping introduces the lower divider-frequency component.
        assert!(amplitude(0, 0.5, 1.0) > 0.1);
    }
    #[test]
    fn shape_pwm_rails_stay_saturated_with_reduced_calibration_excursion() {
        let c = Calibration::default();
        for i in 0..1024 {
            let phase = (i as f32 + 0.5) / 1024.0;
            let render = |kind, shape, peak| {
                wave(
                    phase,
                    1.0 / 1024.0,
                    kind,
                    shape,
                    c.saw_shape_scale,
                    c.triangle_fold_slope,
                    c.triangle_shape_depth,
                    peak,
                )
            };
            // Maximum pulse shape is a constant carrier for the ring bridge,
            // even when the calibrated peak is below the low-note peak.
            assert_eq!(render(2, 1023.0 / 1024.0, 0.78), 1.0);
            assert_eq!(render(2, -1.0, 0.78), -1.0);
            assert_eq!(render(0, 0.0, 0.78), render(0, 0.0, 1.0));
            assert_eq!(render(1, 0.0, 0.78), render(1, 0.0, 1.0));
        }
    }
    #[test]
    fn midi_bipolar_controls_keep_firmware_bit_replication() {
        let mut s = Monologue::new();
        s.midi_cc(26, 63);
        assert_eq!(s.parameter(20), -5.0 / 512.0);
        s.midi_cc(26, 64);
        assert_eq!(s.parameter(20), 4.0 / 511.0);
        s.midi_cc(26, 127);
        assert_eq!(s.parameter(20), 1.0);
        s.midi_cc(25, 64);
        assert_eq!(bipolar_raw(s.parameter(15)), 516);
        s.midi_cc(35, 83);
        assert_eq!(s.parameter(7), pitch_cents((83 << 3) | (83 >> 4)));
    }
    #[test]
    fn decimator_preserves_audible_band_and_rejects_folded_ultrasound() {
        let gain = |frequency: f64| {
            let (mut re, mut im) = (0.0, 0.0);
            for (i, coefficient) in decimator::COEFFICIENTS.iter().enumerate() {
                let angle = 2.0 * std::f64::consts::PI * frequency * i as f64 / 192000.0;
                re += *coefficient as f64 * angle.cos();
                im += *coefficient as f64 * angle.sin();
            }
            re.hypot(im)
        };
        for i in 0..=180 {
            assert!((gain(i as f64 * 100.0) - 1.0).abs() < 0.002);
        }
        for i in 240..=960 {
            assert!(gain(i as f64 * 100.0) < 0.00015);
        }
        for i in 0..FIR_LEN {
            assert_eq!(
                decimator::COEFFICIENTS[i],
                decimator::COEFFICIENTS[FIR_LEN - 1 - i]
            );
        }
    }
    #[test]
    fn bpm_synced_fast_lfo_follows_firmware_multiplier() {
        let mut s = Monologue::new();
        for (id, value) in [(18, 1.0), (19, 0.125), (25, 0.0), (32, 1.0), (33, 120.0)] {
            s.set_float_param(id, value);
        }
        s.settle_parameters();
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; 4];
        s.process_block(
            &BlockContext {
                sample_rate: 48000.0,
                frames: 120,
                tempo_bpm: 120.0,
                transport_sixteenth_position: 0.0,
            },
            &[[0.0; MAX_BLOCK_FRAMES]; 15],
            &mut outputs,
        );
        // Whole-note clock division: .5Hz slow, 16Hz fast at120BPM.
        assert!((s.lfo_phase - 0.04).abs() < 1e-6);
    }
    #[test]
    fn extreme_settings_stay_finite_at_supported_rates() {
        for rate in [8000.0, 44100.0, 48000.0, 96000.0, 192000.0] {
            for mode in 0..3 {
                let mut s = Monologue::new();
                for (id, value) in [
                    (0, mode as f32),
                    (3, mode as f32),
                    (1, 1.0),
                    (4, 1.0),
                    (5, 1.0),
                    (8, mode as f32),
                    (10, 1.0),
                    (11, 1.0),
                    (18, 1.0),
                    (19, 1.0),
                    (20, -1.0),
                ] {
                    s.set_float_param(id, value);
                }
                s.settle_parameters();
                for n in 0..64 {
                    s.set_float_param(9, if n < 32 { 0.01 } else { 1.0 });
                    let out = block(&mut s, if n < 32 { -2.0 } else { 5.0 }, true, rate);
                    assert!(out[0].iter().all(|x| x.is_finite() && x.abs() <= 1.0));
                    assert_eq!(out[0], out[1]);
                }
                s.silence();
                let out = block(&mut s, 0.0, false, rate);
                assert!(out[0].iter().all(|x| *x == 0.0));
            }
        }
    }
    #[test]
    fn filter_self_oscillates_after_excitation_without_oscillator_input() {
        let mut s = Monologue::new();
        s.set_float_param(9, 0.45);
        s.set_float_param(10, 1.0);
        s.settle_parameters();
        for _ in 0..100 {
            block(&mut s, 1.0, true, 48000.0);
        }
        s.set_float_param(2, 0.0);
        s.settle_parameters();
        for _ in 0..300 {
            block(&mut s, 1.0, true, 48000.0);
        }
        let out = block(&mut s, 1.0, true, 48000.0);
        assert!(out[0].iter().map(|x| x * x).sum::<f32>() > 0.0001);
    }
    #[test]
    fn bend_does_not_restart_envelope_but_note_event_does() {
        let mut s = Monologue::new();
        s.set_float_param(12, 0.0);
        s.set_float_param(14, 0.0);
        s.settle_parameters();
        for _ in 0..20 {
            block(&mut s, 1.0, true, 48000.0);
        }
        assert_eq!(s.modulation.stage, control::Stage::Decay);
        assert_eq!(s.modulation.value, 0.0);
        block(&mut s, 1.0 + 1.0 / 12.0, true, 48000.0);
        assert_eq!(s.modulation.stage, control::Stage::Decay);
        assert_eq!(s.modulation.value, 0.0);
        s.note_on(false);
        block(&mut s, 1.25, true, 48000.0);
        assert!(s.modulation.value > 0.0);
        s.set_float_param(26, 1.0);
        s.settle_parameters();
        for _ in 0..20 {
            block(&mut s, 1.25, true, 48000.0);
        }
        s.note_on(false);
        block(&mut s, 1.5, true, 48000.0);
        assert_eq!(s.modulation.stage, control::Stage::Decay);
        assert_eq!(s.modulation.value, 0.0);
    }
}
