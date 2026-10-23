//! Firmware-free JP-8000 comparison voice and bounded eight-voice instrument.
//!
//! This module contains algorithms and user parameter values only: no ROM,
//! program image, machine state, sampled notes, or recorded register streams.
//! Recovered scalar controller and fixed-point DSP laws implement seven
//! oscillators, pitch/filter/amplifier envelopes, global LFO1, filters and the
//! stereo EQ, delay, chorus and pan. Unsupported active routing remains explicit
//! errors. Pitch uses the recovered quantized exponential law.

#[path = "jp8000_chorus.rs"]
mod chorus;
#[path = "jp8000_control.rs"]
mod control;
#[path = "jp8000_delay.rs"]
mod delay;
#[path = "jp8000_effects.rs"]
mod effects;
#[path = "jp8000_fade.rs"]
mod fade;
#[path = "jp8000_arp.rs"]
mod arp;
#[path = "jp8000_instrument.rs"]
mod instrument;
#[path = "jp8000_notes.rs"]
mod notes;
#[path = "jp8000_oscillators.rs"]
mod oscillators;
#[path = "jp8000_output.rs"]
mod output;
#[path = "jp8000_pan.rs"]
mod pan;
#[path = "jp8000_smoothing.rs"]
mod retarget_smoothing;
#[path = "jp8000_tempo.rs"]
mod tempo;
use control::{
    amp_lfo_depth, balance_amplitude, balance_target, bipolar_depth, feedback_period,
    filter12_amplitude, keyfollow, level_curve, pitch_bend_cents, pitch_lfo_depth, shape_target,
    wheel_level, Lfo,
};
pub use instrument::{Jp8000Instrument, MidiError, VOICE_COUNT};
use retarget_smoothing::{Destination, SmoothingScheduler};

pub const NATIVE_SAMPLE_RATE: u32 = 88_200;
pub const MAX_RENDER_FRAMES: usize = 128;
const PARAM_COUNT: usize = control::RAW_PARAMETER_COUNT;
const Q23: i64 = 1 << 23;
const DEFAULT_SUPERSAW_SIDE: i32 = (((Q23 / 5 + 256) / 512) * 512) as i32;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ParameterError {
    UnsupportedParameter(u16),
    UnsupportedValue { id: u16, value: u16 },
    OutOfRange { id: u16, value: u16, maximum: u16 },
}
impl std::fmt::Display for ParameterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ParameterError {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RenderTap {
    Output,
    Oscillator,
}

/// Supported raw controls. Remaining patch controls may be accepted at their
/// neutral setting. Two-part performances and remaining modulation modes still
/// fail explicitly; see validation for routing limits. Mono key priority belongs
/// to Jp8000Instrument; Jp8000Voice is a single voice owned by its caller.
pub const IMPLEMENTED_PARAMETERS: &[u16] = &[
    16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
    41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64,
    65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96, 98, 100, 102,
    104, 106, 108, 110, 112, 114, 116, 118, 120, 122, 124, 126, 256, 258, 260, 262, 264, 266, 268,
    270, 272, 274, 276, 278, 281, 283, 284, 286, 288, 290, 292, 294, 296, 298, 300, 302, 304, 306, 308,
    310, 312, 314, 316, 318, 320, 322, 324, 326, 328, 330, 332, 334, 336, 338, 340, 342, 344, 346,
    348, 350, 352, 354, 356, 358, 360, 362, 1004, 1005, 1006, 2034,
];

fn defaults() -> [u16; PARAM_COUNT] {
    let mut p = [0; PARAM_COUNT];
    for (i, id) in control::CONTROL_ASSIGNMENTS.iter().enumerate() {
        p[*id as usize] = 127;
        p[284 + 2 * i] = 127;
    }
    for id in [
        17, 19, 25, 26, 27, 29, 43, 44, 45, 46, 48, 50, 52, 53, 59, 60, 64,
    ] {
        p[id] = 64;
    }
    p[30] = 5;
    p[35] = 25;
    p[36] = 50;
    p[39] = 2;
    p[40] = 1;
    p[41] = 127;
    p[49] = 127;
    p[51] = 127;
    p[56] = 127;
    p[57] = 0;
    p[67] = 2;
    p[68] = 2;
    p[73] = 2;
    p
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Stage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy)]
struct Envelope {
    stage: Stage,
    level: i32,
    value: i64,
    // Only the amplifier uses these DSP-side committed values. Controller E
    // may advance while native selectors13/12 hold these writes.
    target: i64,
    committed_rate: i64,
    rates: [i32; 3],
    sustain: i32,
    amplitude: i32,
    smoothing: i32,
    modulation_smoothing: i32,
    until_tick: u16,
}
impl Envelope {
    fn new() -> Self {
        Self {
            stage: Stage::Idle,
            level: 0,
            value: 0,
            target: 0,
            committed_rate: 8,
            rates: [8192; 3],
            sustain: 16384,
            amplitude: 11584,
            smoothing: 8,
            modulation_smoothing: 8,
            until_tick: 0,
        }
    }
    fn configure(&mut self, attack: u16, decay: u16, sustain: u16, release: u16) {
        self.rates = [
            envelope_rate(attack),
            envelope_rate(decay),
            envelope_rate(release),
        ];
        self.sustain = if sustain == 127 {
            16384
        } else {
            (32767 * sustain as i32 * sustain as i32 / 16129) >> 1
        };
    }
    fn on(&mut self) {
        // Allocation resets the controller level, preserving ESP gain history.
        self.level = 0;
        self.stage = Stage::Attack;
        self.advance();
    }
    fn off(&mut self) {
        self.stage = Stage::Release;
    }
    fn advance(&mut self) {
        let rate = match self.stage {
            Stage::Attack => self.rates[0],
            // Native does not request a decay rate when already at sustain.
            Stage::Decay if self.level > self.sustain => self.rates[1],
            Stage::Release => self.rates[2],
            _ => 0,
        };
        self.smoothing = envelope_smoothing(rate);
        match self.stage {
            Stage::Idle => self.level = 0,
            Stage::Attack => {
                self.level = if rate > 4864 {
                    16384
                } else {
                    (self.level + (((20480 - self.level) * rate) >> 13).max(1)).min(16384)
                };
                if self.level == 16384 {
                    self.stage = Stage::Decay;
                }
            }
            Stage::Decay => {
                self.level = if rate > 4864 {
                    self.sustain
                } else {
                    (self.level - (((self.level - self.sustain) * rate) >> 13).max(1))
                        .max(self.sustain)
                };
                if self.level == self.sustain {
                    self.stage = Stage::Sustain;
                }
            }
            Stage::Sustain => self.level = self.sustain,
            Stage::Release => {
                self.level = if rate > 4864 {
                    0
                } else {
                    (self.level - ((self.level * rate) >> 13).max(1)).max(0)
                };
                if self.level == 0 {
                    self.stage = Stage::Idle;
                }
            }
        }
    }
    fn commit(&mut self, rate: u16) {
        // H8's two-immediate writer discards the target word's lowest bit.
        let word = (i64::from(self.level) * i64::from(self.amplitude)) >> 14;
        self.target = (word & !1) << 8;
        self.committed_rate = i64::from(rate);
    }
    fn next(&mut self) -> i64 {
        self.until_tick = self.until_tick.saturating_sub(1);
        self.value = amp_smooth(self.value, self.target, self.committed_rate);
        self.value
    }
}
fn smoothing_selector(rate: i32) -> u8 {
    match rate {
        2048 => 0,
        512 => 1,
        256 => 2,
        208 => 3,
        144 => 4,
        128 => 5,
        96 => 6,
        80 => 7,
        74 => 8,
        55 => 9,
        32 => 10,
        8 => 11,
        _ => unreachable!("recovered controller rate class"),
    }
}
fn amp_smooth(current: i64, target: i64, rate: i64) -> i64 {
    let delta = sat24(target - current);
    sat24(current + ((delta * (rate >> 8)) >> 6) + (((delta >> 7) * ((rate >> 1) & 127)) >> 6))
}
fn envelope_rate(raw: u16) -> i32 {
    let r = raw.min(127) as i32;
    match r {
        0..=57 => (8192.0 * 0.945_f64.powi(r)).ceil() as i32,
        58..=78 => 768 - 8 * r,
        79..=100 => 456 - 4 * r,
        101..=112 => 256 - 2 * r,
        113..=116 => 144 - r,
        _ => (140 - r) / 2,
    }
}
fn envelope_smoothing(rate: i32) -> i32 {
    if rate <= 1536 {
        8
    } else if rate <= 4864 {
        32
    } else if rate == 8192 {
        2048
    } else if rate > 7680 {
        512
    } else if rate > 7168 {
        256
    } else if rate > 6656 {
        208
    } else if rate > 6400 {
        144
    } else if rate > 6144 {
        128
    } else if rate > 5632 {
        96
    } else if rate > 5376 {
        80
    } else if rate > 5120 {
        74
    } else {
        55
    }
}

#[derive(Clone, Copy)]
struct DspFilter {
    state: [i64; 4],
    cutoff: i64,
    cutoff_target: i64,
    damping: i64,
    damping_target: i64,
    cutoff_rate: i64,
    cutoff_fast: u16,
    damping_fast: u16,
}
impl DspFilter {
    fn new() -> Self {
        // Scalar template defaults, expressed independently of any machine
        // snapshot. Requested patch coefficients are loaded on allocation.
        Self {
            state: [0; 4],
            cutoff: 4096,
            cutoff_target: 4096,
            damping: 4194304,
            damping_target: 4194304,
            cutoff_rate: 8,
            cutoff_fast: 0,
            damping_fast: 0,
        }
    }
    fn process(&mut self, input: i64, filter_type: u16, slope: u16) -> i64 {
        self.cutoff = amp_smooth(
            self.cutoff,
            self.cutoff_target,
            if self.cutoff_fast > 0 {
                2048
            } else {
                self.cutoff_rate
            },
        );
        if self.cutoff_fast > 0 {
            self.cutoff_fast -= 1;
        }
        let damping_delta = sat24(self.damping_target - self.damping);
        self.damping += if self.damping_fast > 0 {
            (damping_delta * 112) >> 7
        } else {
            damping_delta >> 9
        };
        if self.damping_fast > 0 {
            self.damping_fast -= 1;
        }
        let [old_l1, old_b1, old_l2, old_b2] = self.state;
        let l1 = sat24(old_l1 + qmul(old_b1, self.cutoff, 7));
        let h1 = sat24(input - sat24(l1 + qmul(old_b1, self.damping, 6)));
        let b1 = sat24(old_b1 + qmul(h1, self.cutoff, 7));
        let l2 = sat24(old_l2 + qmul(old_b2, self.cutoff, 7));
        let first = match filter_type {
            0 => h1,
            1 => old_b1,
            _ => old_l1,
        };
        let h2 = sat24(qmul(first, self.damping, 6) - sat24(l2 + qmul(old_b2, self.damping, 6)));
        let b2 = sat24(old_b2 + qmul(h2, self.cutoff, 7));
        self.state = [l1, b1, l2, b2];
        // LP/BP taps are old integrators; HP is the new subtraction result.
        let second = match filter_type {
            0 => h2,
            1 => old_b2,
            _ => old_l2,
        };
        if slope == 0 {
            first
        } else {
            second
        }
    }
}

/// Part/performance controls outside the compact patch parameter bank.
#[derive(Clone, Copy)]
struct EffectSettings {
    delay_sync: u16,
    lfo_sync: u16,
    chorus_sync: u16,
    tempo: u16,
}
impl EffectSettings {
    fn new() -> Self {
        Self {
            delay_sync: 0,
            lfo_sync: 0,
            chorus_sync: 0,
            tempo: 120,
        }
    }
    fn parameter(self, id: u16) -> Option<u16> {
        match id {
            1004 => Some(self.delay_sync),
            1005 => Some(self.lfo_sync),
            1006 => Some(self.chorus_sync),
            2034 => Some(self.tempo),
            _ => None,
        }
    }
    fn set(&mut self, id: u16, value: u16) {
        match id {
            1004 => self.delay_sync = value,
            1005 => self.lfo_sync = value,
            1006 => self.chorus_sync = value,
            2034 => self.tempo = value,
            _ => (),
        }
    }
}

#[derive(Clone, Copy)]
struct OutputPath {
    dc: i64,
    eq: output::ToneEq,
    pan: i64,
}
impl OutputPath {
    fn new() -> Self {
        Self {
            dc: 0,
            eq: output::ToneEq::new(),
            pan: 0,
        }
    }
    fn dc_block(&mut self, mixed: i64) -> i64 {
        let output = sat24(mixed + self.dc);
        self.dc = sat24(self.dc + ((-output) >> 7) + ((output >> 7) * 120 >> 7));
        output
    }
    fn set_tone(&mut self, bass: u16, treble: u16) {
        self.eq.configure(bass, treble);
    }
    fn equalize(&mut self, voice: i64) -> i64 {
        self.eq.process(sat24(voice * 2))
    }
    fn process(&mut self, voice: i64) -> i64 {
        let equalized = self.equalize(voice);
        let dry = (equalized * 112) >> 7;
        let dry = (dry * 116) >> 7;
        self.pan += ((89 * 65536 - self.pan) >> 7) * 32 >> 7;
        qmul(dry, self.pan, 7) >> 1
    }
}

/// One comparison voice at the JP native rate. Its bounded feedback delay is
/// allocated in new(); controls, notes, reset and rendering never allocate.
/// The separate instrument shares the post-sum output across eight such voices.
pub struct Jp8000Voice {
    params: [u16; PARAM_COUNT],
    controls: [u16; control::SYNTH_PARAMETER_COUNT],
    velocity_code: i32,
    // H8 +27 is the pending raw release; +38 can lag it while sustained.
    // +36 (velocity_code) continues to drive every held-velocity getter.
    release_velocity_raw: u8,
    release_velocity_code: i32,
    morph: i32,
    saw_phase: i32,
    other_oscillator: oscillators::Oscillator,
    oscillator_2: oscillators::Oscillator2,
    // Semantic normal-rate cache (H8 B6), separate from OSC2's installed
    // arithmetic. Cache refresh alone must not change the running smoother.
    osc2_ratio_rate_cache: u16,
    // H8 B5: consumed on physical controller passes, not sample-count expiry.
    osc2_loader_stage: u8,
    previous_oscillator_1: i64,
    previous_oscillator_2: i64,
    previous_cross_tap: i64,
    nominal_master_phase: i32,
    previous_master_export: i64,
    previous_master_frequency: i64,
    balance: i64,
    balance_target: i64,
    cross: i64,
    cross_target: i64,
    filter_envelope: Envelope,
    pitch_envelope: Envelope,
    lfo: Lfo,
    lfo2: Lfo,
    tempo_clock: tempo::TempoClock,
    lfo2_value: i32,
    bend: u16,
    wheel: u8,
    volume: u8,
    expression: u8,
    amplitude_base: i32,
    raw_lfo_value: i32,
    fade: fade::Fade,
    lfo_value: i32,
    lfo_edge: bool,
    pitch_cents: i32,
    glide: notes::Glide,
    glide_rate: u16,
    glide_enabled: bool,
    frequency_word: i32,
    saw_shape: i64,
    saw_shape_target: i64,
    // Sparse post-rotation aliases used only by the reviewed Saw -> Super Saw
    // transfer: I0b/I0c, I0e/I10/I12, and I14/I15/I16. They are generated from
    // the active Saw/SS kernel, never copied from a reference snapshot.
    saw_ss_shape_history: [i32; 2],
    saw_ss_shaper_cells: [i32; 3],
    saw_ss_increment_history: [i32; 3],
    // Three Saw frames replace every delayed operand after an untracked
    // program. Constructor/reset defaults do not establish that provenance.
    saw_ss_history_frames: u8,
    supersaw_phases: [i32; 7],
    supersaw_increments: [i32; 7],
    supersaw_state: [i64; 4],
    osc1_tail: Osc1TailHistory<47>,
    osc1_highpass: [i64; 2],
    last_dc_mixed: i64,
    osc1_tail_boundary: i64,
    supersaw_g: i64,
    supersaw_detune_target: i32,
    supersaw_detune_state: i32,
    supersaw_side_target: i32,
    supersaw_side_state: i32,
    note: u8,
    part_transpose: u8,
    part_detune: i8,
    gate: bool,
    allocated: bool,
    controller_assigned: bool,
    osc1_generic_program: bool,
    // Track the installed program even while a controller-free slot is silent.
    osc1_program_wave: u16,
    osc2_generic_program: bool,
    coefficient_fast: u16,
    amp: Envelope,
    amp_scheduler: SmoothingScheduler,
    filter_scheduler: SmoothingScheduler,
    filter: DspFilter,
    output: OutputPath,
    effect_settings: EffectSettings,
    // Only standalone comparison voices own a chain. The instrument's eight
    // voices send their summed audio through one shared chain instead.
    effects: Option<effects::Effects>,
}
impl Default for Jp8000Voice {
    fn default() -> Self {
        Self::new()
    }
}
impl Jp8000Voice {
    pub fn new() -> Self {
        Self::with_effects(true)
    }
    fn new_pre_output() -> Self {
        Self::with_effects(false)
    }
    fn with_effects(own_effects: bool) -> Self {
        let mut v = Self {
            params: defaults(),
            controls: control::effective_controls(&defaults(), 0, 0),
            velocity_code: 0,
            release_velocity_raw: 255,
            release_velocity_code: 0,
            morph: 0,
            saw_phase: 0,
            other_oscillator: oscillators::Oscillator::new(),
            oscillator_2: oscillators::Oscillator2::new(),
            osc2_ratio_rate_cache: 0x80,
            osc2_loader_stage: 0,
            previous_oscillator_1: 0,
            previous_oscillator_2: 0,
            previous_cross_tap: 0,
            nominal_master_phase: 0,
            previous_master_export: 0,
            previous_master_frequency: 0,
            balance: 0,
            balance_target: 0,
            cross: 0,
            cross_target: 4096,
            filter_envelope: Envelope::new(),
            pitch_envelope: Envelope::new(),
            lfo: Lfo::new(),
            lfo2: Lfo::new(),
            tempo_clock: tempo::TempoClock::new(120),
            lfo2_value: 0,
            bend: 8192,
            wheel: 0,
            volume: 127,
            expression: 127,
            amplitude_base: 11584,
            raw_lfo_value: 0,
            fade: fade::Fade::new(envelope_rate),
            lfo_value: 0,
            lfo_edge: false,
            pitch_cents: 0,
            glide: notes::Glide::default(),
            glide_rate: 8192,
            glide_enabled: false,
            frequency_word: 65536,
            saw_shape: 4096,
            saw_shape_target: 4096,
            saw_ss_shape_history: [0; 2],
            saw_ss_shaper_cells: [0; 3],
            saw_ss_increment_history: [0; 3],
            saw_ss_history_frames: 0,
            supersaw_phases: [0; 7],
            supersaw_increments: [0; 7],
            supersaw_state: [0; 4],
            osc1_tail: Osc1TailHistory::new(0x6f),
            osc1_tail_boundary: 0,
            osc1_highpass: [0; 2],
            last_dc_mixed: 0,
            supersaw_g: 0,
            supersaw_detune_target: 32768,
            supersaw_detune_state: 0,
            supersaw_side_target: DEFAULT_SUPERSAW_SIDE,
            supersaw_side_state: 0,
            note: 60,
            part_transpose: 24,
            part_detune: 0,
            gate: false,
            allocated: false,
            controller_assigned: false,
            osc1_generic_program: true,
            osc1_program_wave: 5,
            osc2_generic_program: true,
            coefficient_fast: 0,
            amp: Envelope::new(),
            amp_scheduler: SmoothingScheduler::default(),
            filter_scheduler: SmoothingScheduler::default(),
            filter: DspFilter::new(),
            output: OutputPath::new(),
            effect_settings: EffectSettings::new(),
            effects: own_effects.then(effects::Effects::new),
        };
        v.refresh_amplitude_base();
        v.load_osc1_program();
        v.load_osc2_program();
        v.recalculate();
        v
    }
    /// Reset synthesis history while preserving user parameter values.
    pub fn reset(&mut self) {
        self.saw_phase = 0;
        self.other_oscillator.reset();
        self.oscillator_2.reset();
        self.osc2_loader_stage = 0;
        self.previous_oscillator_1 = 0;
        self.previous_oscillator_2 = 0;
        self.previous_cross_tap = 0;
        self.nominal_master_phase = 0;
        self.previous_master_export = 0;
        self.previous_master_frequency = 0;
        self.balance = 0;
        self.balance_target = 0;
        self.cross = 0;
        self.cross_target = 4096;
        self.filter_envelope = Envelope::new();
        self.pitch_envelope = Envelope::new();
        self.lfo = Lfo::new();
        self.lfo2 = Lfo::new();
        self.tempo_clock = tempo::TempoClock::new(self.effect_settings.tempo);
        self.lfo2_value = 0;
        self.clear_velocity_state();
        self.morph = 0;
        self.refresh_controls();
        self.bend = 8192;
        self.wheel = 0;
        self.volume = 127;
        self.expression = 127;
        self.raw_lfo_value = 0;
        self.fade.reset();
        self.lfo_value = 0;
        self.lfo_edge = false;
        self.pitch_cents = 0;
        self.glide = notes::Glide::default();
        self.glide_enabled = false;
        self.glide_rate = envelope_rate(self.controls[70]) as u16;
        self.saw_shape = 4096;
        self.saw_shape_target = 4096;
        self.saw_ss_shape_history = [0; 2];
        self.saw_ss_shaper_cells = [0; 3];
        self.saw_ss_increment_history = [0; 3];
        self.saw_ss_history_frames = 0;
        self.supersaw_phases = [0; 7];
        self.supersaw_state = [0; 4];
        self.osc1_tail = Osc1TailHistory::new(0x6f);
        self.osc1_tail_boundary = 0;
        self.osc1_highpass = [0; 2];
        self.last_dc_mixed = 0;
        self.supersaw_detune_state = 0;
        self.supersaw_detune_target = 32768;
        self.supersaw_side_state = 0;
        self.supersaw_side_target = DEFAULT_SUPERSAW_SIDE;
        self.filter = DspFilter::new();
        self.amp = Envelope::new();
        self.amp_scheduler = SmoothingScheduler::default();
        self.filter_scheduler = SmoothingScheduler::default();
        self.output = OutputPath::new();
        self.output.set_tone(self.params[59], self.params[60]);
        if let Some(effects) = &mut self.effects {
            effects.reset();
        }
        self.note = 60;
        self.gate = false;
        self.allocated = false;
        self.controller_assigned = false;
        self.load_osc1_program();
        self.load_osc2_program();
        self.coefficient_fast = 0;
        self.refresh_amplitude_base();
        self.recalculate();
    }
    pub fn parameter(&self, id: u16) -> Option<u16> {
        if id < 74 || matches!(id, 280 | 283) || control::assignment_destination(id).is_some() {
            self.params.get(id as usize).copied()
        } else {
            self.effect_settings.parameter(id)
        }
    }
    fn validate_parameter(&self, id: u16, value: u16) -> Result<(), ParameterError> {
        Self::validate_parameter_for(&self.params, id, value)?;
        let mut next = self.params;
        if (id as usize) < PARAM_COUNT {
            next[id as usize] = value;
        }
        self.validate_fade_history(&next)
    }
    fn validate_fade_history(&self, next: &[u16; PARAM_COUNT]) -> Result<(), ParameterError> {
        if self.allocated && !self.fade.known && Self::primary_lfo_active(next) {
            return Err(ParameterError::UnsupportedValue {
                id: 18,
                value: next[18],
            });
        }
        Ok(())
    }
    fn primary_lfo_active(params: &[u16; PARAM_COUNT]) -> bool {
        let varied = |id: u16| control::can_vary(params, id);
        [25usize, 44]
            .iter()
            .any(|&id| params[id] != 64 || varied(id as u16))
            || (params[58] == 0 && (params[52] != 64 || varied(52)))
            || (!matches!(params[30], 0 | 2 | 3) && (params[32] != 0 || varied(32)))
            || (params[33] == 0 && (params[38] != 0 || varied(38)))
    }
    fn validate_parameter_for(
        params: &[u16; PARAM_COUNT],
        id: u16,
        value: u16,
    ) -> Result<(), ParameterError> {
        let maximum = if control::assignment_destination(id).is_some() {
            Some(254)
        } else {
            match id {
                16 => Some(3),
                21 | 34 | 283 | 69 | 71 | 72 => Some(1),
                61 => Some(11),
                63 => Some(4),
                24 | 33 | 58 => Some(2),
                1004 => Some(10),
                1005 => Some(22),
                1006 => Some(23),
                2034 => Some(250),
                35 => Some(50),
                36 => Some(100),
                30 => Some(6),
                39 => Some(2),
                40 => Some(1),
                67 | 68 => Some(24),
                73 => Some(4),
                17..=19
                | 22
                | 23
                | 25..=29
                | 31
                | 32
                | 37
                | 38
                | 41..=57
                | 59
                | 60
                | 62
                | 64..=66
                | 70 => Some(127),
                _ => None,
            }
        };
        if let Some(maximum) = maximum {
            if value > maximum {
                return Err(ParameterError::OutOfRange { id, value, maximum });
            }
        } else if !accepted_inactive_parameter(id, value) {
            return Err(ParameterError::UnsupportedParameter(id));
        }
        if id == 2034 && value < 20 {
            return Err(ParameterError::UnsupportedValue { id, value });
        }
        let mut next = *params;
        if (id as usize) < PARAM_COUNT {
            next[id as usize] = value;
        }
        let lfo_active = Self::primary_lfo_active(&next);
        if lfo_active && !fade::supported(next[18]) {
            return Err(ParameterError::UnsupportedValue { id, value });
        }
        // Unsupported assignments cannot hide behind a temporarily zero MIDI
        // source. Only destinations whose underlying feature is disabled may
        // keep non-neutral stored settings without claiming active support.
        for (i, &destination) in control::ASSIGNMENT_DESTINATIONS.iter().enumerate() {
            let dormant = match destination {
                18 => !lfo_active,
                64 | 65 => next[66] == 0,
                _ => false,
            };
            if !control::assignment_supported(destination) && !dormant {
                for assigned in [control::CONTROL_ASSIGNMENTS[i] as usize, 284 + 2 * i] {
                    if next[assigned] != 127 {
                        return Err(ParameterError::UnsupportedValue {
                            id: assigned as u16,
                            value: next[assigned],
                        });
                    }
                }
            }
        }
        Ok(())
    }
    pub fn set_parameter(&mut self, id: u16, value: u16) -> Result<(), ParameterError> {
        self.set_parameter_dispatch(id, value, true)
    }
    // Ownership reload reuses program loading but is not an explicit raw
    // 30/33/34 event. Instrument dispatches the accepted input IDs separately.
    fn set_parameter_dispatch(&mut self, id: u16, value: u16,
        explicit_loader_event: bool) -> Result<(), ParameterError> {
        self.validate_parameter(id, value)?;
        if id as usize >= PARAM_COUNT {
            self.effect_settings.set(id, value);
            self.refresh_lfos_and_effects();
            return Ok(());
        }
        let previous_effective = self.part_effective_note();
        self.params[id as usize] = value;
        self.refresh_controls();
        if matches!(id, 69 | 70 | 281 | 362) { self.refresh_glide_control(); }
        if id == 73 { self.retarget_patch_octave(previous_effective); }
        // A repeated waveform write still reloads its DSP program. Knob writes
        // on a controller-free voice only store values for the next allocation.
        if id == 30 { self.load_osc1_program(); }
        if matches!(id, 33 | 34) { self.load_osc2_program(); }
        if matches!(id, 23 | 51 | 82 | 126 | 292 | 336) {
            self.refresh_amplitude_base();
        }
        self.recalculate();
        if explicit_loader_event && matches!(id, 30 | 33 | 34) {
            self.osc2_loader_stage = 2;
        }
        // H8 0x7172 refreshes both LFO phases on explicit raw 16/17/19
        // events at their fastest free rate, including equal-value writes.
        if matches!(id, 16 | 17 | 19) {
            self.lfo.retarget_note();
            self.lfo2.retarget_note();
        }
        Ok(())
    }
    pub fn apply_patch(&mut self, ids: &[u16], values: &[u16]) -> Result<(), ParameterError> {
        if ids.len() != values.len() || ids.len() > 256 {
            return Err(ParameterError::UnsupportedParameter(u16::MAX));
        }
        let mut params = self.params;
        let mut effect_settings = self.effect_settings;
        for (i, (&id, &value)) in ids.iter().zip(values).enumerate() {
            if ids[..i].contains(&id) {
                return Err(ParameterError::UnsupportedValue { id, value });
            }
            if (id as usize) < PARAM_COUNT {
                params[id as usize] = value;
            }
            effect_settings.set(id, value);
        }
        for (&id, &value) in ids.iter().zip(values) {
            Self::validate_parameter_for(&params, id, value)?;
        }
        self.validate_fade_history(&params)?;
        let previous_effective = self.part_effective_note();
        self.params = params;
        self.effect_settings = effect_settings;
        self.refresh_controls();
        if ids.iter().any(|id| matches!(id, 69 | 70 | 281 | 362)) { self.refresh_glide_control(); }
        if ids.contains(&73) { self.retarget_patch_octave(previous_effective); }
        if ids.contains(&30) { self.load_osc1_program(); }
        if ids.iter().any(|id| matches!(id, 33 | 34)) { self.load_osc2_program(); }
        if ids
            .iter()
            .any(|id| matches!(id, 23 | 51 | 82 | 126 | 292 | 336))
        {
            self.refresh_amplitude_base();
        }
        self.recalculate();
        if ids.iter().any(|id| matches!(id, 30 | 33 | 34)) {
            self.osc2_loader_stage = 2;
        }
        if ids.iter().any(|id| matches!(id, 16 | 17 | 19)) {
            self.lfo.retarget_note();
            self.lfo2.retarget_note();
        }
        Ok(())
    }
    fn is_monophonic(&self) -> bool {
        self.params[71] != 0 || self.params[30] == 3
    }
    pub fn note_on(&mut self, note: u8, velocity: u8) {
        if note > 127 || velocity > 127 {
            return;
        }
        if velocity == 0 {
            self.note_off_with_velocity(note, 64);
            return;
        }
        let overlap = self.is_monophonic() && self.gate;
        let legato = overlap && self.params[72] != 0;
        let mono_legato_gap = self.is_monophonic() && self.params[72] != 0 && !self.gate;
        let source =
            (self.allocated && !mono_legato_gap).then_some((self.note, self.glide.offset_cents));
        if !legato {
            self.clear_controller_amp();
        }
        self.start_note(note, velocity, source, legato);
    }
    /// Native allocator mute: preserve actual DSP gain, selector, oscillator,
    /// filter and effect histories while clearing the controller amplitude.
    /// The allocator calls this before full allocation, not for true legato.
    fn clear_controller_amp(&mut self) {
        self.amp.level = 0;
        self.amp.stage = Stage::Idle;
        self.amp.target = 0;
        self.amp.committed_rate = 128;
    }
    // Internal retarget accepts release velocity0. MIDI NoteOn velocity0 is
    // interpreted by the allocator before reaching this voice-level method.
    fn start_note(&mut self, note: u8, velocity: u8, source: Option<(u8, i32)>, legato: bool) {
        self.start_note_with_forced_source(note, velocity, source, legato, None);
    }
    // H8 1c392 consults the part's CC84 latch for full allocation AND note-off
    // fallback. Its glide override is independent of dispatch and slot choice.
    fn start_note_with_forced_source(&mut self, note: u8, velocity: u8,
        source: Option<(u8, i32)>, legato: bool, forced_source: Option<u8>) {
        self.glide.start(forced_source.map_or_else(|| source.map_or(0, |(old_note, offset)| {
            100 * (i32::from(old_note) - i32::from(note)) + offset
        }), |old_note| 100 * (i32::from(old_note) - i32::from(note))));
        self.note = note;
        // Full and legato initializers write held/release codes together.
        self.release_velocity_raw = if self.params[283] != 0 { velocity } else { 80 };
        self.velocity_code = control::velocity_code(self.release_velocity_raw);
        self.release_velocity_code = self.velocity_code;
        self.refresh_controls();
        self.refresh_glide_control();
        // Native source selection clears cached enable on a cold/key-gap start.
        if forced_source.is_some() { self.glide_enabled = true; }
        else if source.is_none() { self.glide_enabled = false; }
        self.gate = true;
        self.allocated = true;
        self.controller_assigned = true;
        self.refresh_amplitude_base();
        self.recalculate();
        self.lfo.retarget_note();
        self.lfo2.retarget_note();
        if !legato {
            self.fade.allocate();
            self.lfo_value = self.fade.scale(self.raw_lfo_value);
            // Full allocation publishes fast immediately (B5=3). Subsequent
            // controller passes decrement before the active-oscillator gate.
            // ESP histories survive allocation.
            self.osc2_loader_stage = 3;
            self.publish_osc2_ratio_rate();
            let next_tick = if self.amp.until_tick == 0 {
                882
            } else {
                self.amp.until_tick
            };
            // These boundaries approximate UART delivery relative to the H8
            // control tick; the native engine adds no UART delay to notes.
            self.filter.cutoff_fast = next_tick;
            self.coefficient_fast = next_tick + 882;
            self.filter.damping_fast = self.coefficient_fast;
            self.amp_scheduler.full_allocation(Destination::Amp);
            self.filter_scheduler.full_allocation(Destination::Filter);
            self.amp.on();
            self.filter_envelope.on();
            self.pitch_envelope.on();
            self.tick_glide();
        } else {
            self.amp_scheduler.retarget();
            self.filter_scheduler.retarget();
        }
        self.update_modulation();
        if !legato {
            self.commit_controller_targets();
        }
        // True legato preserves stages, levels, phases, committed DSP targets,
        // and allocation fast-loader windows until their own scheduled updates.
    }
    fn tick_glide(&mut self) -> bool {
        let old = self.glide.offset_cents;
        self.glide.tick(self.glide_rate, self.glide_enabled);
        old != self.glide.offset_cents
    }
    // H8 ownership init 960e clears both raw bytes to FF and both codes to0.
    // This helper only changes the velocity caches; caller owns reconfiguration.
    fn clear_velocity_state(&mut self) {
        self.velocity_code = 0;
        self.release_velocity_raw = 255;
        self.release_velocity_code = 0;
    }
    // H8 927c stores raw27 without touching code38, rates or DSP targets.
    fn retain_release_velocity(&mut self, raw: u8) {
        debug_assert!(raw <= 127);
        self.release_velocity_raw = raw;
    }
    // Ordinary E14e / pedal-up9316 refresh both release-rate caches. Do not use
    // this for a future destination-selective Trigger release: its cache policy
    // is different and is deliberately not wired here.
    fn release_retained_velocity(&mut self, note: u8) {
        if note > 127 || !self.gate || self.note != note { return; }
        self.release_velocity_code = if self.release_velocity_raw == 255 {
            0
        } else {
            control::velocity_code(self.release_velocity_raw)
        };
        self.refresh_release_controls();
        self.filter_envelope.rates[2] = envelope_rate(self.controls[50]);
        self.amp.rates[2] = envelope_rate(self.controls[57]);
        // Stage changes only. The existing controller clock commits DSP targets.
        self.note_off(note);
    }
    /// An explicit direct-MIDI release. VelocitySwitch is sampled at this event;
    /// direct Off0 remains0, whereas NoteOn0 is normalized to Off64 by note_on().
    pub fn note_off_with_velocity(&mut self, note: u8, velocity: u8) {
        if note > 127 || velocity > 127 || !self.gate || self.note != note { return; }
        let raw = if self.params[283] != 0 { velocity } else { 80 };
        self.retain_release_velocity(raw);
        self.release_retained_velocity(note);
    }
    /// Compatibility release without a supplied MIDI velocity. Retains the
    /// already cached release code/rates instead of inventing a velocity.
    pub fn note_off(&mut self, note: u8) {
        if note > 127 {
            return;
        }
        if self.gate && self.note == note {
            self.gate = false;
            self.amp.off();
            self.filter_envelope.off();
        }
    }
    pub fn silence(&mut self) {
        self.gate = false;
        self.clear_controller_amp();
        self.amp.value = 0;
        self.filter_envelope.stage = Stage::Idle;
        self.filter_envelope.level = 0;
        self.pitch_envelope.stage = Stage::Idle;
        self.pitch_envelope.level = 0;
        self.filter.state = [0; 4];
        self.output = OutputPath::new();
        self.output.set_tone(self.params[59], self.params[60]);
        if let Some(effects) = &mut self.effects {
            effects.reset();
        }
    }
    pub fn set_pitch_bend(&mut self, raw: u16) -> Result<(), &'static str> {
        if raw > 16383 {
            return Err("pitch bend must be14-bit");
        }
        self.bend = raw;
        self.update_modulation();
        Ok(())
    }
    pub fn set_modulation_wheel(&mut self, raw: u8) -> Result<(), &'static str> {
        if raw > 127 {
            return Err("modulation wheel must be7-bit");
        }
        self.wheel = raw;
        self.update_modulation();
        Ok(())
    }
    /// The signed JP control-assignment source: CC2 is negative and channel
    /// pressure positive. The most recent source wins; it is not a sum.
    pub fn set_morph(&mut self, value: i32) -> Result<(), &'static str> {
        if !(-128..=128).contains(&value) {
            return Err("morph must be in -128..=128");
        }
        let changed = self.morph != value;
        self.morph = value;
        self.refresh_controls();
        // Deferred native Morph processing refreshes every owner-matching slot.
        // Same-value messages leave the cached enable/rate untouched.
        if changed { self.refresh_glide_control(); }
        self.refresh_amplitude_base();
        self.recalculate();
        Ok(())
    }
    pub fn set_volume(&mut self, raw: u8) -> Result<(), &'static str> {
        if raw > 127 {
            return Err("volume must be7-bit");
        }
        self.volume = raw;
        self.refresh_amplitude_base();
        self.update_amplitude();
        Ok(())
    }
    pub fn set_expression(&mut self, raw: u8) -> Result<(), &'static str> {
        if raw > 127 {
            return Err("expression must be7-bit");
        }
        self.expression = raw;
        self.refresh_amplitude_base();
        self.update_amplitude();
        Ok(())
    }
    pub fn set_lfo2_phase(&mut self, phase: f64) -> Result<(), &'static str> {
        self.lfo2.set_phase(phase)?;
        self.lfo2_value = self.lfo2.value();
        self.update_modulation();
        Ok(())
    }
    pub fn set_lfo_phase(&mut self, phase: f64) -> Result<(), &'static str> {
        self.lfo.set_phase(phase)?;
        self.raw_lfo_value = self.lfo.value();
        self.lfo_value = self.fade.scale(self.raw_lfo_value);
        self.lfo_edge = false;
        if let Some(effects) = &mut self.effects {
            effects.update_lfo(self.raw_lfo_value);
        }
        self.update_modulation();
        Ok(())
    }
    pub fn set_phases(&mut self, phases: [f64; 7]) -> Result<(), &'static str> {
        if phases.iter().any(|p| !p.is_finite()) {
            return Err("phases must be finite");
        }
        self.supersaw_phases = phases.map(|p| wrap24((p.rem_euclid(1.0) * 16777216.0) as i32));
        self.saw_phase = self.supersaw_phases[0];
        self.other_oscillator.set_phase(self.saw_phase as i64);
        self.nominal_master_phase = self.saw_phase;
        self.previous_master_export = self.saw_phase as i64;
        if self.controls[30] == 0 {
            self.saw_ss_shape_history[1] = self.supersaw_phases[3];
            self.saw_ss_shaper_cells = [
                self.supersaw_phases[4], self.supersaw_phases[5], self.supersaw_phases[6],
            ];
        }
        Ok(())
    }
    /// Offline control-clock phase, expressed as samples until the next 100 Hz
    /// update. It is a deterministic initial condition, not serial MIDI latency.
    pub fn set_control_phase(&mut self, frames_until_tick: u16) -> Result<(), &'static str> {
        if frames_until_tick >= 882 {
            return Err("control phase must be in 0..882");
        }
        self.amp.until_tick = frames_until_tick;
        Ok(())
    }
    pub fn render(&mut self, output: &mut [f32], tap: RenderTap) {
        for sample in output {
            *sample = self.next_sample(tap);
        }
    }
    pub fn next_sample(&mut self, tap: RenderTap) -> f32 {
        let (oscillator, amplified) = self.next_voice_frame();
        let output = self.process_output(amplified).0;
        match tap {
            RenderTap::Oscillator => oscillator as f32 / Q23 as f32,
            RenderTap::Output => output as f32 / Q23 as f32,
        }
    }
    /// Stereo output at the native sample rate. The legacy mono renderer returns
    /// the left channel, matching the comparison harness's original convention.
    pub fn next_stereo_sample(&mut self) -> (f32, f32) {
        let (_, amplified) = self.next_voice_frame();
        let (left, right) = self.process_output(amplified);
        (left as f32 / Q23 as f32, right as f32 / Q23 as f32)
    }
    fn process_output(&mut self, amplified: i64) -> (i64, i64) {
        if let Some(effects) = &mut self.effects {
            let equalized = self.output.equalize(amplified);
            pan::dac_mix(effects.process(equalized), (0, 0))
        } else {
            let sample = self.output.process(amplified);
            (sample, sample)
        }
    }
    /// Return the raw oscillator tap and amplified voice before the shared sum.
    fn next_voice_frame(&mut self) -> (i64, i64) {
        self.next_voice_frame_with_lfo(None)
    }
    fn next_voice_frame_with_lfo(&mut self, external_lfo: Option<(i32, bool, i32)>) -> (i64, i64) {
        self.next_voice_frame_with_history(external_lfo, None, false)
    }
    fn next_voice_frame_with_history(&mut self, external_lfo: Option<(i32, bool, i32)>,
        shared: Option<(&SharedOscillatorHistory, usize)>, previous_balance: bool) -> (i64, i64) {
        self.next_voice_frame_for_owner(external_lfo, shared, previous_balance, true)
    }
    // Current Instrument ownership maps contain only valid parts. Keep the
    // ratio-publication owner gate explicit, independent of Free/assigned.
    fn next_voice_frame_for_owner(&mut self, external_lfo: Option<(i32, bool, i32)>,
        shared: Option<(&SharedOscillatorHistory, usize)>, previous_balance: bool,
        owner_valid: bool) -> (i64, i64) {
        if external_lfo.is_none() {
            if let Some(pulse) = self.tempo_clock.native_sample() {
                self.lfo.clock_pulse(pulse);
            }
        }
        if self.amp.until_tick == 0 {
            // 155E0 precedes owner and post-advance amp checks. Idle/unowned
            // slots consume stage1 too; a later start must not replay it.
            if (1..=3).contains(&self.osc2_loader_stage) { self.osc2_loader_stage -= 1; }
            if let Some((value, edge, second)) = external_lfo {
                self.raw_lfo_value = value;
                self.lfo_edge = edge;
                self.lfo2_value = second;
            } else {
                self.raw_lfo_value = self.lfo.tick();
                self.lfo2_value = self.lfo2.tick();
                self.lfo_edge = self.lfo.edge();
            }
            if let Some(effects) = &mut self.effects {
                effects.update_lfo(self.raw_lfo_value);
            }
            // Fade is voice-local. Shared LFO2, pan and the edge flag are not scaled.
            if self.allocated {
                self.fade.tick();
            }
            self.lfo_value = self.fade.scale(self.raw_lfo_value);
            self.amp.advance();
            // H8 15682 tests the resulting amp stage. Fade and glide continue
            // for cached owners; filter and oscillator/pitch-EG work do not.
            let periodic_voice_active = self.amp.stage != Stage::Idle;
            let glide_changed = self.allocated && self.tick_glide();
            if periodic_voice_active {
                self.filter_envelope.advance();
                self.pitch_envelope.advance();
                if self.pitch_envelope.stage == Stage::Sustain {
                    self.pitch_envelope.stage = Stage::Idle;
                }
            }
            if periodic_voice_active && self.controller_assigned
                && (glide_changed
                    || self.controls[25] != 64
                    || self.controls[26] != 64
                    || self.controls[27] != 64
                    || self.controls[44] != 64
                    || self.controls[45] != 64
                    || self.controls[52] != 64
                    || self.controls[53] != 64
                    || self.controls[46] != 64
                    || (matches!(self.controls[30], 1 | 4 | 5 | 6) && self.controls[32] != 0)
                    || (self.controls[33] == 0 && self.controls[38] != 0))
            {
                self.update_modulation();
            }
            if owner_valid && periodic_voice_active { self.publish_osc2_ratio_rate(); }
            self.commit_amp_target();
            if periodic_voice_active {
                self.commit_filter_target();
            }
            self.amp.until_tick = 882;
        } else if let Some((value, edge, second)) = external_lfo {
            self.raw_lfo_value = value;
            self.lfo_edge = edge;
            self.lfo2_value = second;
        }
        // Width retains its existing loader approximation. Ratio rate changes
        // only at qualified publication events; elapsed samples cannot end it.
        self.oscillator_2.set_shape_loading(self.coefficient_fast > 0 || self.osc2_generic_program);
        let osc2 = self.oscillator_2.next_sample_with_sync(
            self.previous_master_frequency,
            self.previous_master_export,
            self.controls[34] != 0,
        );
        // Native FM reads the preceding frame's depth before its loader writes.
        let previous_cross = self.cross;
        let delta = sat24(self.cross_target - self.cross);
        self.cross = sat24(
            self.cross
                + if self.coefficient_fast > 0 {
                    (delta * 112) >> 7
                } else if self.allocated {
                    delta >> 9
                } else {
                    delta >> 6
                },
        );
        let increment = if matches!(self.controls[30], 1 | 3 | 4 | 5 | 6) {
            oscillators::cross_modulated_frequency(
                self.frequency_word as i64,
                self.previous_cross_tap,
                previous_cross,
            )
        } else {
            self.frequency_word as i64
        };
        // Immediate source-defined shared register operands, before this
        // frame's sparse writes. Excitation aliases remain the reviewed loader.
        if self.controls[30] == 0 {
            self.supersaw_state = if let Some((history, physical)) = shared {
                history.read_filter(physical)
            } else {
                self.osc1_tail.filter(0)
            };
        } else if self.controls[30] == 2 {
            let (filter_history, coefficient_history) = if let Some((history, physical)) = shared {
                history.read(physical)
            } else {
                (self.osc1_tail.filter(0), [self.osc1_tail.read(0x9b), self.osc1_tail.read(0x9d)])
            };
            self.other_oscillator.inherit_noise_filter_history(filter_history);
            self.other_oscillator.inherit_noise_coefficients(coefficient_history);
        }
        let oscillator = if self.controls[30] == 0 {
            let output = self.next_supersaw();
            self.saw_phase = self.supersaw_phases[0];
            output
        } else if self.controls[30] == 5 {
            let previous_shape = self.saw_shape as i32;
            self.saw_phase = wrap24(self.saw_phase.wrapping_add(increment as i32));
            let delta = sat24(self.saw_shape_target - self.saw_shape);
            self.saw_shape += if self.coefficient_fast > 0 || self.osc1_generic_program {
                (delta * 112) >> 7
            } else {
                delta >> 11
            };
            let (output, cells) = saw_sample_with_cells(
                self.saw_phase as i64, increment, self.saw_shape,
            );
            // Saw writes I09 and I13 but not I0b/I15. Ring rotation therefore
            // advances those unwritten histories rather than clearing them.
            self.saw_ss_shape_history = [previous_shape, self.saw_ss_shape_history[0]];
            self.saw_ss_shaper_cells = cells;
            self.saw_ss_increment_history = [
                increment as i32,
                self.saw_ss_increment_history[0],
                self.saw_ss_increment_history[1],
            ];
            self.saw_ss_history_frames = (self.saw_ss_history_frames + 1).min(3);
            output
        } else {
            self.other_oscillator.set_loading(self.coefficient_fast > 0
                || (self.osc1_generic_program && self.controls[30] != 3));
            self.other_oscillator.set_phase(self.saw_phase as i64);
            let output = self.other_oscillator.next_sample_with_frequency(increment);
            self.saw_phase = self.other_oscillator.phase() as i32;
            output
        };
        if shared.is_none() {
            if let Some((svf, hp, cr)) = self.oscillator_tail_writes() {
                self.osc1_tail.publish(0, svf, hp, cr);
            }
            // Standalone Voice has an explicitly isolated tail. The eight-voice
            // Instrument supplies the physical neighboring-voice inlet instead.
            self.osc1_tail.advance(self.osc1_tail_boundary);
        }
        self.previous_master_frequency = self.frequency_word as i64;
        let old_master = self.nominal_master_phase;
        self.nominal_master_phase = wrap24(old_master.wrapping_add(self.frequency_word));
        // GRAM f7 carries the old phase for SuperSaw/Noise and the new phase
        // for the other kernels; OSC2 observes that export one frame later.
        self.previous_master_export = if matches!(self.controls[30], 0 | 2) {
            old_master as i64
        } else {
            self.nominal_master_phase as i64
        };
        if self.coefficient_fast > 0 {
            self.coefficient_fast -= 1;
        }
        let amp = self.amp.next();
        let old_balance = self.balance;
        self.balance = sat24(self.balance + ((self.balance_target - self.balance) >> 6));
        let mixer_balance = if previous_balance { old_balance } else { self.balance };
        let second = if self.controls[21] != 0 {
            oscillators::ring_sample(self.previous_oscillator_1, self.previous_oscillator_2)
        } else {
            self.previous_oscillator_2
        };
        let mixed = oscillators::mix_oscillators(self.previous_oscillator_1, second, mixer_balance);
        self.previous_oscillator_1 = oscillator;
        self.previous_oscillator_2 = osc2.audio;
        self.previous_cross_tap = osc2.cross;
        let mixed = self.output.dc_block(mixed);
        self.last_dc_mixed = mixed;
        let filtered = self
            .filter
            .process(mixed, self.controls[39], self.controls[40]);
        let amplified = sat24(qmul(filtered, amp, 7));
        (oscillator, amplified)
    }

    fn oscillator_tail_writes(&self) -> Option<([i64; 4], [i64; 2], Option<[i64; 2]>)> {
        match self.controls[30] {
            0 => Some((self.supersaw_state, self.osc1_highpass, None)),
            2 => { let (svf, hp, cr) = self.other_oscillator.noise_tail_writes(); Some((svf, hp, Some(cr))) },
            _ => None,
        }
    }
    fn next_supersaw(&mut self) -> i64 {
        let old_phase2 = self.supersaw_phases[2];
        let old_detune = self.supersaw_detune_state;
        let smooth = |current: i32, target: i32| {
            if self.coefficient_fast > 0 || self.osc1_generic_program {
                current + ((sat24((target - current) as i64) * 112) >> 7) as i32
            } else {
                smooth_word(current, target)
            }
        };
        let detune = smooth(self.supersaw_detune_state, self.supersaw_detune_target);
        let side = smooth(self.supersaw_side_state, self.supersaw_side_target);
        if detune != self.supersaw_detune_state || side != self.supersaw_side_state {
            self.supersaw_detune_state = detune;
            self.supersaw_side_state = side;
            self.update_supersaw_coefficients();
        }
        // Each product shifts before the wider mix accumulator is summed.
        let mut mixed = 0i64;
        for i in 0..7 {
            self.supersaw_phases[i] =
                wrap24(self.supersaw_phases[i].wrapping_add(self.supersaw_increments[i]));
            let coefficient = if i == 0 {
                25
            } else {
                self.supersaw_side_state >> 16
            };
            mixed += (self.supersaw_phases[i] as i64 * coefficient as i64) >> 7;
        }
        // At the post-sync boundary I0b retains old phase2, I0c is new
        // phase3, and I15 retains old detune between new I14/I16 values.
        // Keep these even before a short SS -> Saw -> SS return.
        self.saw_ss_shape_history = [old_phase2, self.supersaw_phases[3]];
        self.saw_ss_shaper_cells = [
            self.supersaw_phases[4], self.supersaw_phases[5], self.supersaw_phases[6],
        ];
        self.saw_ss_increment_history = [detune, old_detune, side];
        self.saw_ss_history_frames = 3;
        let g = self.supersaw_g;
        let c = (self.supersaw_side_state as i64 * 70) >> 5;
        let [old_lp1, old_bp1, old_lp2, old_bp2] = self.supersaw_state;
        let lp1 = sat24(old_lp1 + qmul(old_bp1, g, 7));
        let compensated = sat24(qmul(sat24(mixed), (!c) & (Q23 - 1), 6));
        let hp1 = sat24((compensated >> 1) - sat24(lp1 + old_bp1));
        let bp1 = sat24(old_bp1 + qmul(hp1, g, 6));
        let lp2 = sat24(old_lp2 + qmul(old_bp2, g, 6));
        let hp2 = sat24(((hp1 * 20) >> 6) - sat24(lp2 + old_bp2));
        let bp2 = sat24(old_bp2 + qmul(hp2, g, 6));
        self.supersaw_state = [lp1, bp1, lp2, bp2];
        self.osc1_highpass = [hp1, hp2];
        sat24((hp2 * 116) >> 6)
    }
    fn update_supersaw_coefficients(&mut self) {
        let f = self.frequency_word;
        let detune = self.supersaw_detune_state;
        let k = ((f * (detune >> 16)) >> 7) + (((f >> 7) * ((detune >> 9) & 127)) >> 7);
        self.supersaw_increments = [
            f,
            f + k,
            f - k,
            f + ((102 * k) >> 5),
            f + ((-103 * k) >> 5),
            f + ((44 * k) >> 3),
            f + ((-45 * k) >> 3),
        ];
        self.supersaw_g = sat24((f as i64 * 98) >> 6);
    }
    fn update_modulation(&mut self) {
        if !self.controller_assigned {
            return;
        }
        let base = self.part_base_cents();
        let bend = pitch_bend_cents(self.bend, self.controls[67], self.controls[68]);
        let wheel = wheel_level(self.wheel);
        let lfo1_pitch = (self.lfo_value * pitch_lfo_depth(self.controls[25])) >> 14;
        let envelope_pitch =
            (self.pitch_envelope.level * bipolar_depth(self.controls[27], 4800)) >> 14;
        let wheel_pitch =
            (((self.lfo2_value * pitch_lfo_depth(self.controls[26])) >> 14) * wheel) >> 7;
        let selected_pitch = lfo1_pitch + envelope_pitch;
        // Enable edits only take effect at the next100Hz glide update.
        let glide = self.glide.offset_cents;
        self.pitch_cents = base
            + bend
            + glide
            + wheel_pitch
            + if self.controls[24] == 0 {
                selected_pitch
            } else {
                0
            };
        let tuning = control::oscillator2_tuning(self.controls[35], self.controls[36]);
        self.oscillator_2.set_tuning_cents(
            tuning
                + if self.controls[24] == 1 {
                    selected_pitch
                } else {
                    0
                },
        );
        let cross_base = 32767 * i64::from(self.controls[22]) / 127;
        let cross_raw = if self.controls[24] == 2 {
            // Signed integer division truncates toward zero in the EG route.
            cross_base + 16 * i64::from(lfo1_pitch) + i64::from(envelope_pitch) * 32767 / 4800
        } else {
            cross_base
        };
        self.cross_target = (cross_raw.clamp(0, 32767) << 8) & !511;
        if self.controls[33] == 0 {
            self.oscillator_2.set_shape_target(shape_target(
                4,
                self.controls[37],
                self.controls[38],
                self.lfo_value,
            ));
        }
        if matches!(self.controls[30], 1 | 4 | 5 | 6) {
            let target = shape_target(
                self.controls[30],
                self.controls[31],
                self.controls[32],
                self.lfo_value,
            );
            self.saw_shape_target = target;
            self.other_oscillator.set_shape_target(target);
        }
        self.frequency_word = pitch_word_cents(self.pitch_cents);
        if self.controls[30] == 0 {
            self.frequency_word = self.frequency_word.min(0x146e40);
        }
        self.other_oscillator
            .set_frequency_word(self.frequency_word as i64);
        self.other_oscillator.set_pitch_cents(self.pitch_cents);
        if self.controls[30] == 3 {
            self.other_oscillator
                .set_feedback_period_word(feedback_period(
                    i32::from(self.part_effective_note()),
                    self.pitch_cents - base,
                ));
        }
        self.update_supersaw_coefficients();
        self.update_amplitude();
    }
    fn filter_target_values(&self) -> (i64, i64) {
        let base = self.part_base_cents();
        let bend = pitch_bend_cents(self.bend, self.controls[67], self.controls[68]);
        let glide = self.glide.offset_cents;
        let wheel = wheel_level(self.wheel);
        let cutoff = self.controls[41] as i32 * 100
            + (((base + bend + glide) * keyfollow(self.controls[43])) >> 6)
            + ((self.lfo_value * bipolar_depth(self.controls[44], 6000)) >> 14)
            + ((((self.lfo2_value * bipolar_depth(self.controls[45], 6000)) >> 14) * wheel) >> 7)
            + ((self.filter_envelope.level * bipolar_depth(self.controls[46], 12000)) >> 14);
        let c = filter_cutoff_cents(cutoff);
        (
            (c * 256) & !511,
            filter_damping_control(c, self.controls[42]),
        )
    }
    // Full allocation has its own source path and intentionally does not use
    // the periodic amp-Idle gate. Setters remain cache/target-handler paths.
    fn commit_controller_targets(&mut self) {
        self.commit_amp_target();
        self.commit_filter_target();
    }
    fn commit_amp_target(&mut self) {
        self.update_amplitude();
        let amp_lfo1 = self.controls[58] == 0 && self.controls[52] != 64;
        self.amp_scheduler.modulation(
            amp_lfo1 || self.controls[53] != 64,
            amp_lfo1 && self.lfo_edge,
        );
        if let Some(rate) = self.amp_scheduler.tick(
            Destination::Amp,
            self.amp.stage == Stage::Attack,
            smoothing_selector(self.amp.smoothing),
        ) {
            self.amp.commit(rate);
        }
    }
    fn commit_filter_target(&mut self) {
        if !self.allocated {
            return;
        }
        self.filter_scheduler.modulation(
            self.controls[44] != 64 || self.controls[45] != 64,
            self.controls[44] != 64 && self.lfo_edge,
        );
        let requested = if bipolar_depth(self.controls[46], 12000) != 0 {
            smoothing_selector(self.filter_envelope.smoothing)
        } else {
            11
        };
        if let Some(rate) = self.filter_scheduler.tick(
            Destination::Filter,
            self.filter_envelope.stage == Stage::Attack,
            requested,
        ) {
            let (cutoff, damping) = self.filter_target_values();
            self.filter.cutoff_target = cutoff;
            self.filter.damping_target = damping;
            self.filter.cutoff_rate = i64::from(rate);
        }
    }
    fn refresh_amplitude_base(&mut self) {
        // H8 686e combines channel volume/expression in Q15 before the
        // patch level, then applies the oscillator-balance normalization.
        let channel =
            (level_curve(u16::from(self.volume)) * level_curve(u16::from(self.expression))) >> 15;
        let base = (((level_curve(self.controls[51]) * channel) >> 16)
            * balance_amplitude(self.controls[23]))
            >> 14;
        self.amplitude_base = if self.controls[40] == 0 {
            (base * filter12_amplitude(self.controls[42])) >> 13
        } else {
            base
        } as i32;
    }
    fn update_amplitude(&mut self) {
        let base = i64::from(self.amplitude_base);
        // Raw52 is reassigned to pan in modes1/2. Only LFO2 remains an
        // amplifier source in those modes (H8 voice mode field +0xAE).
        let amp_lfo1 = self.controls[58] == 0 && self.controls[52] != 64;
        let lfo1 = if amp_lfo1 {
            (self.lfo_value * amp_lfo_depth(self.controls[52])) >> 14
        } else {
            0
        };
        let lfo2 = (((self.lfo2_value * amp_lfo_depth(self.controls[53])) >> 14)
            * wheel_level(self.wheel))
            >> 7;
        self.amp.amplitude =
            (base + ((base * i64::from(lfo1 + lfo2)) >> 12)).clamp(0, 32767) as i32;
        self.amp.modulation_smoothing = if amp_lfo1 && self.lfo_edge {
            256
        } else if amp_lfo1 || self.controls[53] != 64 {
            32
        } else {
            8
        };
    }
    fn refresh_controls(&mut self) {
        self.controls = control::effective_controls(&self.params, self.velocity_code, self.morph);
        self.refresh_release_controls();
        // Semantic normal-rate refresh, including full init, legato, Morph and
        // owner patch refresh. No loader rearm or installed-rate mutation.
        // The host constructor performs this refresh; it does not expose the
        // earlier native cold-clear interval where B6 is zero.
        self.refresh_osc2_ratio_rate_cache();
        self.fade.configure(self.controls[18]);
    }
    fn refresh_osc2_ratio_rate_cache(&mut self) {
        self.osc2_ratio_rate_cache = if matches!(self.controls[35], 0 | 50) { 0x40 } else { 0x80 };
    }
    fn publish_osc2_ratio_rate(&mut self) {
        match self.osc2_loader_stage {
            3 => self.oscillator_2.install_ratio_rate(0x7000),
            1 => self.oscillator_2.install_ratio_rate(self.osc2_ratio_rate_cache),
            _ => {},
        }
    }
    // Unwired selected-release primitives. The caller has already normalized
    // the event and selected incoming velocity or fixed 80 for this part.
    // E3CC writes common code38, not pending raw27; other envelope caches and
    // all DSP targets remain untouched until their own source-defined update.
    fn trigger_filter_release(&mut self, effective_velocity: u8) {
        debug_assert!(effective_velocity <= 127);
        self.release_velocity_code = control::velocity_code(effective_velocity);
        let held = control::effective_controls(&self.params, self.velocity_code, self.morph);
        self.controls[46..50].copy_from_slice(&held[46..50]);
        self.controls[50] = control::effective_value(self.params[50],
            self.release_velocity_code, self.morph, self.params[334], self.params[124], false);
        self.filter_envelope.configure(self.controls[47], self.controls[48],
            self.controls[49], self.controls[50]);
        self.filter_envelope.sustain = if self.controls[49] == 127 { 16384 }
            else { 129 * i32::from(self.controls[49]) };
        self.filter_envelope.off();
    }
    // E492 changes only amp caches and stage, retaining raw27 and held36.
    // In particular, a prior filter-only release may have a different cached
    // release rate even though both destinations share the latest code38.
    fn trigger_amp_release(&mut self, effective_velocity: u8) {
        debug_assert!(effective_velocity <= 127);
        self.release_velocity_code = control::velocity_code(effective_velocity);
        let held = control::effective_controls(&self.params, self.velocity_code, self.morph);
        self.controls[54..57].copy_from_slice(&held[54..57]);
        self.controls[57] = control::effective_value(self.params[57],
            self.release_velocity_code, self.morph, self.params[348], self.params[266], false);
        self.amp.configure(self.controls[54], self.controls[55], self.controls[56], self.controls[57]);
        self.amp.off();
    }
    // 1CC52 envelope/commit portion only. The future Trigger On caller must
    // first apply E5C4 caches and retarget the amp scheduler to selector4.
    // It must not use this as a substitute for that still-unwired cache path.
    fn trigger_amp_start_after_cache(&mut self) {
        self.amp.on();
        self.commit_amp_target();
    }
    fn refresh_release_controls(&mut self) {
        // Ordinary release getters61e6/63c6 use code38; all other getters keep36.
        // Assignment IDs are the catalog entries for Filter/Amp Release.
        self.controls[50] = control::effective_value(self.params[50],
            self.release_velocity_code, self.morph, self.params[334], self.params[124], false);
        self.controls[57] = control::effective_value(self.params[57],
            self.release_velocity_code, self.morph, self.params[348], self.params[266], false);
    }
    fn refresh_lfos_and_effects(&mut self) {
        self.tempo_clock.set_tempo(self.effect_settings.tempo);
        self.lfo.configure_primary(
            self.controls[16],
            self.controls[17],
            self.effect_settings.lfo_sync,
            self.effect_settings.tempo,
            self.tempo_clock.pulses(),
        );
        self.lfo2.configure_second(self.controls[19]);
        self.refresh_effects();
    }
    fn refresh_effects(&mut self) {
        let increment = match self.effect_settings.chorus_sync {
            0 => None,
            23 => Some(self.lfo.increment()),
            sync => tempo::synced_lfo_increment(sync, self.effect_settings.tempo),
        };
        if let Some(effects) = &mut self.effects {
            effects.configure(
                &self.controls,
                self.effect_settings.delay_sync,
                self.effect_settings.tempo,
                amp_lfo_depth(self.controls[52]),
                64,
                self.raw_lfo_value,
            );
            effects.configure_chorus_sync(increment);
        }
    }
    /// Part settings are committed by the validated Instrument transaction.
    /// This storage-only hook never restarts a controller or writes a DSP target.
    pub(crate) fn set_part_pitch(&mut self, transpose: u8, detune: i8) {
        debug_assert!(transpose <= 48 && (-25..=25).contains(&detune));
        self.part_transpose = transpose;
        self.part_detune = detune;
    }
    pub(crate) fn part_effective_note(&self) -> u8 {
        self.part_effective_note_with_octave(self.controls[73])
    }
    pub(crate) fn part_effective_note_with_octave(&self, octave: u16) -> u8 {
        debug_assert!(octave <= 4);
        let note = i32::from(self.note) + i32::from(self.part_transpose)
            + 12 * i32::from(octave) - 48;
        // At the validated parameter limits, at most four octave folds suffice.
        let folded = if note > 127 {
            note - 12 * ((note - 127 + 11) / 12)
        } else if note < 0 {
            note + 12 * ((-note + 11) / 12)
        } else { note };
        folded as u8
    }
    fn part_base_cents(&self) -> i32 {
        100 * (i32::from(self.part_effective_note()) - 60) + i32::from(self.part_detune)
    }
    /// The caller selects the prior source in INPUT-note space before mutation.
    /// A live part transpose retargets glide without restarting envelopes/fade.
    pub(crate) fn retarget_part_transpose(&mut self, source: Option<(u8, i32)>) {
        if self.allocated {
            self.glide.start(source.map_or(0, |(note, offset)| {
                100 * (i32::from(note) - i32::from(self.note)) + offset
            }));
        }
    }
    /// Native raw73 dispatch also runs on equal-value writes and owned Free
    /// histories. Preserve the old instantaneous offset until the next tick.
    /// Caller captures previous_effective before changing params/part fields.
    pub(crate) fn retarget_patch_octave(&mut self, previous_effective: u8) {
        if self.allocated {
            self.glide.initial_cents = 100 * (i32::from(previous_effective)
                - i32::from(self.part_effective_note()));
            self.glide.remaining = 8192;
        }
    }
    /// Native1c346 caches both enable and rate on explicit glide-control events.
    /// Caller owns slot/part dispatch; no active or ever-allocated guard applies.
    pub(crate) fn refresh_glide_control(&mut self) {
        self.glide_enabled = self.controls[69] != 0;
        self.glide_rate = envelope_rate(self.controls[70]) as u16;
    }

    /// The instrument owns assignment/free transitions. Clearing ownership
    /// itself changes no DSP history, target, loading window or sample clock.
    pub(crate) fn set_controller_assigned(&mut self, assigned: bool) {
        self.controller_assigned = assigned;
    }
    fn load_osc1_program(&mut self) {
        if self.osc1_program_wave == 5 && self.controls[30] == 0
            && self.saw_ss_history_frames == 3
        {
            // A PRAM-only load preserves these physical post-sync cells.
            // I06/I08/I0a are already represented by the live Saw fields.
            self.supersaw_phases = [
                self.nominal_master_phase, self.saw_phase, self.saw_shape as i32,
                self.saw_ss_shape_history[1], self.saw_ss_shaper_cells[0],
                self.saw_ss_shaper_cells[1], self.saw_ss_shaper_cells[2],
            ];
            self.supersaw_detune_state = self.saw_ss_increment_history[0];
            self.supersaw_side_state = self.saw_ss_increment_history[2];
            self.update_supersaw_coefficients();
        }
        // Other incoming programs and the first two Saw frames after one
        // remain outside this bounded alias model. Preserve prior SS behavior
        // there; do not fabricate unknown delayed cells from constructor data.
        if !matches!(self.controls[30], 0 | 5) {
            self.saw_ss_history_frames = 0;
        }
        if self.controls[30] == 2 && self.osc1_program_wave != 2 {
            // Only the immediately outgoing program is authoritative. Every
            // mapped kernel writes physical07/09, read next frame as08/0a.
            let cells = match self.osc1_program_wave {
                0 => [i64::from(self.supersaw_phases[1]), i64::from(self.supersaw_phases[2])],
                5 => [i64::from(self.saw_phase), self.saw_shape],
                _ => self.other_oscillator.noise_entry_cells(),
            };
            self.other_oscillator.inherit_noise_excitation(cells);
            if self.osc1_program_wave == 0 {
                // Direct boundary only: other programs can leave relative
                // cells rotating even without writing these named offsets.
                self.other_oscillator.inherit_noise_filter_history(self.supersaw_state);
            }
        }
        if self.osc1_program_wave == 2 && self.controls[30] == 4 {
            self.saw_phase = self.other_oscillator.inherit_noise_pulse_state() as i32;
        } else if self.osc1_program_wave == 0 && self.controls[30] == 4 {
            self.saw_phase = self.other_oscillator.inherit_supersaw_pulse_state(
                self.supersaw_phases[1],
                self.supersaw_phases[2],
            ) as i32;
        } else if self.osc1_program_wave == 5 && self.controls[30] == 4 {
            // Saw and Pulse both use physical IRAM08/0a as phase/shape.
            self.saw_phase = self.other_oscillator.inherit_phase_width(
                i64::from(self.saw_phase), self.saw_shape,
            ) as i32;
        } else if self.osc1_program_wave == 4 && self.controls[30] == 5 {
            self.saw_phase = self.other_oscillator.phase() as i32;
            self.saw_shape = self.other_oscillator.width_state();
        } else if self.osc1_program_wave == 0 && self.controls[30] == 5 {
            // Super Saw's center and side phases0/1/2 occupy the Saw
            // master/FM/shape cells. The separately advancing nominal mirror
            // can differ after an unmodeled earlier program transition.
            self.nominal_master_phase = self.supersaw_phases[0];
            self.saw_phase = self.supersaw_phases[1];
            self.saw_shape = i64::from(self.supersaw_phases[2]);
        }
        self.osc1_program_wave = self.controls[30];
        self.osc1_generic_program = true;
        match self.controls[30] {
            0 => {
                self.supersaw_side_target = DEFAULT_SUPERSAW_SIDE;
                self.supersaw_detune_target = 32768;
            }
            5 => self.saw_shape_target = 4096,
            wave => self.other_oscillator.load_generic_program(wave as u8),
        }
    }
    fn load_osc2_program(&mut self) {
        // OSC2's waveform block contains width but not the common ratio loader.
        self.osc2_generic_program = true;
        self.oscillator_2.set_wave(self.controls[33] as u8);
        self.oscillator_2.set_shape_target(4096);
    }
    fn recalculate(&mut self) {
        self.refresh_controls();
        self.output.set_tone(self.controls[59], self.controls[60]);
        self.refresh_lfos_and_effects();
        // Balance is refreshed for every matching owner, including Free slots.
        // Its physical slot2/5 smoother also supplies the shared IRAM inlet.
        self.balance_target = balance_target(self.controls[23]);
        // Global effects still update without a note. Per-voice oscillator
        // targets below require a live controller assignment.
        self.filter_envelope.configure(
            self.controls[47],
            self.controls[48],
            self.controls[49],
            self.controls[50],
        );
        self.filter_envelope.sustain = if self.controls[49] == 127 {
            16384
        } else {
            129 * self.controls[49] as i32
        };
        self.pitch_envelope
            .configure(self.controls[28], self.controls[29], 0, 0);
        if self.controller_assigned {
            self.osc1_generic_program = false;
            self.osc2_generic_program = false;
            self.other_oscillator.set_wave(self.controls[30] as u8);
            self.oscillator_2.set_wave(self.controls[33] as u8);
            self.cross_target = (32767 * self.controls[22] as i64 / 127 * 256) & !511;
            self.oscillator_2.set_shape(self.controls[37] as u8);
            self.saw_shape_target = self.controls[31].min(124) as i64 * 65536;
            self.supersaw_detune_target = supersaw_detune_word(self.controls[31]);
            self.supersaw_side_target = 102400 + 16384 * self.controls[32] as i32;
            self.other_oscillator
                .set_shape_targets(self.controls[31] as u8, self.controls[32] as u8);
            self.update_modulation();
        } else if !self.allocated {
            self.frequency_word = 65536;
            self.update_supersaw_coefficients();
        }
        self.update_amplitude();
        self.amp.configure(
            self.controls[54],
            self.controls[55],
            self.controls[56],
            self.controls[57],
        );
    }
}

/// H8 exp helper 0x159de: quantize coarse and fine exponentials before
/// multiplying, then scale the frequency pivot and octave. This regenerates the
/// controller law mathematically; it does not embed a firmware lookup table.
#[cfg(test)]
fn pitch_word(note: u8, octave: u16) -> i32 {
    pitch_word_cents(100 * (note as i32 - 60) + 1200 * (octave as i32 - 2))
}
fn pitch_word_cents(cents: i32) -> i32 {
    let cents = cents.clamp(-24000, 24000);
    let oct = cents.div_euclid(1200);
    let remainder = cents.rem_euclid(1200);
    let coarse = (2048.0 * 2.0_f64.powf(((remainder >> 8) * 256) as f64 / 1200.0)).floor() as i64;
    let fine = (32768.0 * 2.0_f64.powf((remainder & 255) as f64 / 1200.0)).floor() as i64;
    let ratio = (coarse * fine) >> 12;
    let base = (49767 * ratio) >> 14;
    let word = if oct >= 0 {
        base << oct
    } else {
        base >> (-oct)
    };
    word.min(0x309c00) as i32
}
fn sat24(value: i64) -> i64 {
    value.clamp(-Q23, Q23 - 1)
}
fn qmul(x: i64, coefficient: i64, shift: u32) -> i64 {
    ((x * (coefficient >> 16)) >> shift) + (((x >> 7) * ((coefficient >> 9) & 127)) >> shift)
}
/// Main-controller coefficient before the DSP's split-coefficient quantization.
#[cfg(test)]
fn filter_cutoff_control(raw: u16) -> i64 {
    let raw = raw.min(127) as u32;
    let mantissa = (32.0 * 2.0_f64.powf((raw % 12) as f64 / 12.0)).floor() as i64;
    (mantissa << (raw / 12)).clamp(33, 32767)
}
fn filter_cutoff_cents(cents: i32) -> i64 {
    let cents = cents.clamp(0, 12000);
    let oct = cents / 1200;
    let rem = cents % 1200;
    let coarse = (2048.0 * 2.0_f64.powf(((rem >> 8) * 256) as f64 / 1200.0)).floor() as i64;
    let fine = (32768.0 * 2.0_f64.powf((rem & 255) as f64 / 1200.0)).floor() as i64;
    (((coarse * fine) >> 21) << oct).clamp(33, 32767)
}
#[cfg(test)]
fn filter_cutoff_word(raw: u16) -> i64 {
    (filter_cutoff_control(raw) * 256) & !511
}
#[cfg(test)]
fn filter_damping_word(cutoff: u16, resonance: u16) -> i64 {
    filter_damping_control(filter_cutoff_control(cutoff), resonance)
}
fn filter_damping_control(c: i64, resonance: u16) -> i64 {
    let mut r = (32 + (128 - resonance as i64).pow(2)).min(16384);
    if c <= 0x3b3d {
        r = ((r * ((0x9496 - (c >> 2)) >> 1)) >> 14).min(16384);
    }
    (r * 256) & !511
}
fn saw_sample(phase: i64, frequency: i64, shape: i64) -> i64 {
    saw_sample_with_cells(phase, frequency, shape).0
}
fn saw_sample_with_cells(phase: i64, frequency: i64, shape: i64) -> (i64, [i32; 3]) {
    // Independent reconstruction of ESP scalar arithmetic, including the
    // deliberately coarsened split coefficient products and internal clips.
    let width = Q23 - if phase >= 0 { phase } else { -phase - 1 };
    let a1 = sat24(-4 * frequency);
    let a2 = sat24(3 * a1);
    let gate_b = sat24(Q23 + ((a1 * 40) >> 7) + ((a2 * 88) >> 7));
    let gate_a = sat24((a2 * 80 >> 5) + Q23 * 3 / 32) + Q23;
    let gate = sat24(gate_a + qmul(gate_b, width, 3) + width);
    let p2 = qmul(phase, phase, 7);
    let p3 = sat24(qmul(sat24(p2), phase, 7));
    let h = (phase * 96 >> 6) + qmul(phase, !shape, 5) + qmul(p3, shape, 5) - p3;
    let gain = sat24(Q23 / 8 + qmul(frequency, frequency, 6));
    let y = sat24(qmul(sat24(h), gate, 7));
    let y = sat24(qmul(y, gain, 5));
    // Physical StoreSat at PCs 99/104/86. In particular, width can be Q
    // at phase 0/-1, and gate_a has its final +Q before the physical clip.
    (sat24(y * 23 >> 5), [sat24(gate_b) as i32, sat24(gate_a) as i32, sat24(width) as i32])
}
fn wrap24(value: i32) -> i32 {
    (value << 8) >> 8
}
fn smooth_word(state: i32, target: i32) -> i32 {
    // ESP split arithmetic has a real positive deadband: an ascending control
    // settles up to 511 below target. Decreasing controls reach target exactly.
    state + (((target - state) >> 7) * 32 >> 7)
}
fn supersaw_detune_word(raw: u16) -> i32 {
    let raw = raw.min(127) as i32;
    let n = match raw {
        0..=63 => raw / 2 + 1,
        64..=80 => raw - 31,
        103 => 79, // Independently re-read controller anomaly, not an interpolated repair.
        81..=120 => 2 * raw - 111,
        121 => 137,
        122 => 145,
        123 => 153,
        124 => 169,
        125 => 193,
        126 => 225,
        _ => 321,
    };
    512 * n
}

fn accepted_inactive_parameter(id: u16, value: u16) -> bool {
    match id {
        // Controller/velocity depth assignments are raw bipolar 0..254.
        74 | 76 | 78 | 80 | 82 | 84 | 86 | 88 | 90 | 92 | 94 | 96 | 98 | 100 | 102 | 104 | 106
        | 108 | 110 | 112 | 114 | 116 | 118 | 120 | 122 | 124 | 126 | 256 | 258 | 260 | 262
        | 264 | 266 | 268 | 270 | 272 | 274 | 276 | 278 | 281 | 284 | 286 | 288 | 290 | 292
        | 294 | 296 | 298 | 300 | 302 | 304 | 306 | 308 | 310 | 312 | 314 | 316 | 318 | 320
        | 322 | 324 | 326 | 328 | 330 | 332 | 334 | 336 | 338 | 340 | 342 | 344 | 346 | 348
        | 350 | 352 | 354 | 356 | 358 | 360 | 362 => value == 127,
        280 | 283 => value == 0,
        // With their modulation depths zero, these selectors/rates are dormant.
        16 => value <= 3,
        17..=19 | 28..=29 | 64 => value <= 127,
        20 | 24 | 33 => value <= 2,
        61 => value <= 11,
        63 => value <= 4,
        35 => value <= 50,
        36 => value <= 100,
        37..=38 => value <= 127,
        25..=27 | 44..=45 | 52..=53 | 59..=60 => value == 64,
        21..=23 | 34 | 58 | 62 | 65..=66 | 69..=72 => value == 0,
        67..=68 => value <= 24,
        // Neutral part/system settings from an explicitly expanded patch. These
        // are accepted only where they do not require another voice or feature.
        1000 | 1001 | 1002 | 1004..=1006 | 2016..=2018 | 2020..=2027 | 2029..=2032 | 3004 => {
            value == 0
        }
        1003 => value == 24,
        2019 | 3010 => value == 50,
        2034 => (20..=250).contains(&value),
        3009 => value == 17,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn patch_coefficients_load_on_allocation_with_fast_integer_deadbands() {
        let mut voice = Jp8000Voice::new();
        voice.set_parameter(30, 0).unwrap();
        voice.set_parameter(31, 64).unwrap();
        voice.set_parameter(32, 127).unwrap();
        voice.set_parameter(41, 32).unwrap();
        voice.set_parameter(42, 64).unwrap();
        let mut block = [0.0; 128];
        voice.render(&mut block, RenderTap::Output);
        assert_eq!(voice.frequency_word, 65536);
        assert_eq!(voice.filter.cutoff, 4096);
        assert_eq!(voice.supersaw_detune_state, 32767);
        assert_eq!(voice.supersaw_side_state, DEFAULT_SUPERSAW_SIDE - 1);
        voice.set_control_phase(314).unwrap();
        voice.note_on(60, 100);
        for _ in 0..16 {
            voice.render(&mut block, RenderTap::Output);
        }
        assert_eq!(voice.supersaw_detune_state, voice.supersaw_detune_target);
        assert_eq!(voice.supersaw_side_state, voice.supersaw_side_target - 1);
        assert_eq!(voice.filter.cutoff, voice.filter.cutoff_target - 7);
        assert_eq!(voice.filter.damping, voice.filter.damping_target);
        let mut saw = Jp8000Voice::new();
        saw.set_parameter(31, 64).unwrap();
        saw.set_control_phase(314).unwrap();
        saw.note_on(60, 100);
        for _ in 0..16 {
            saw.render(&mut block, RenderTap::Output);
        }
        assert_eq!(saw.saw_shape, saw.saw_shape_target - 1);
    }
    #[test]
    fn amplifier_smoothing_preserves_rate_encoding_and_deadband() {
        let target = 1 << 22;
        let mut fast = 0;
        let mut slow = 0;
        for _ in 0..100_000 {
            fast = amp_smooth(fast, target, 2048);
            slow = amp_smooth(slow, target, 8);
        }
        assert_eq!(fast, target - 7);
        assert_eq!(slow, target - 2047);
        assert_eq!(amp_smooth(0, target, 55), amp_smooth(0, target, 54));
    }
    #[test]
    fn controller_envelope_has_overrange_attack_and_squared_sustain() {
        let mut e = Envelope::new();
        e.configure(96, 96, 64, 96);
        e.on();
        assert_eq!(e.level, 180);
        assert_eq!(e.sustain, 4160);
        assert_eq!(e.smoothing, 8);
        assert_eq!(envelope_rate(127), 6);
        assert_eq!(envelope_smoothing(8192), 2048);
    }
    #[test]
    fn controller_smoothing_preserves_signed_deadband() {
        let mut rising = 0;
        let mut falling = 2048;
        for _ in 0..10000 {
            rising = smooth_word(rising, 512);
            falling = smooth_word(falling, 512);
        }
        assert_eq!(rising, 1);
        assert_eq!(falling, 512);
    }
    #[test]
    fn all_waveforms_and_dual_oscillator_extremes_remain_bounded() {
        let mut voice = Jp8000Voice::new();
        let mut out = [0.0; 512];
        for wave in 0..=6 {
            for note in [0, 60, 127] {
                for octave in [0, 4] {
                    for wave2 in 0..=2 {
                        for ring in [0, 1] {
                            for high in [false, true] {
                                voice.reset();
                                for (id, value) in [
                                    (30, wave),
                                    (31, 127),
                                    (32, 0),
                                    (33, wave2),
                                    (34, ring),
                                    (21, ring),
                                    (22, 127),
                                    (23, 64),
                                    (35, if high { 50 } else { 0 }),
                                    (36, if high { 100 } else { 0 }),
                                    (37, 127),
                                    (38, 127),
                                    (41, if high { 127 } else { 0 }),
                                    (42, 127),
                                    (73, octave),
                                ] {
                                    voice.set_parameter(id, value).unwrap();
                                }
                                voice.note_on(note, 100);
                                voice.render(&mut out, RenderTap::Output);
                                assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
                                voice.note_off(note);
                                voice.render(&mut out, RenderTap::Output);
                                assert!(out.iter().all(|x| x.is_finite() && x.abs() <= 1.0));
                            }
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn invalid_midi_notes_are_ignored_consistently() {
        let mut voice = Jp8000Voice::new();
        voice.note_on(255, 100);
        assert!(!voice.gate);
        voice.note_on(127, 100);
        voice.note_off(127);
        assert!(!voice.gate);
        voice.set_parameter(30, 0).unwrap();
        voice.set_parameter(32, 20).unwrap();
        voice.set_parameter(30, 5).unwrap();
        assert_eq!(voice.parameter(30), Some(5));
    }
    #[test]
    fn generalized_filter_pitch_preserves_all_static_control_values() {
        for raw in 0..128 {
            assert_eq!(
                filter_cutoff_cents(raw as i32 * 100),
                filter_cutoff_control(raw)
            );
        }
    }
    #[test]
    fn filter_sustain_and_amp_level_use_different_recovered_curves() {
        let mut v = Jp8000Voice::new();
        v.set_parameter(49, 64).unwrap();
        v.set_parameter(51, 64).unwrap();
        assert_eq!(v.filter_envelope.sustain, 8256);
        let curve = (32767i64 * 64 * 64 / 16129) >> 1;
        assert_eq!(v.amp.amplitude, ((curve * 11584) >> 14) as i32);
        v.set_parameter(27, 96).unwrap();
        v.set_parameter(28, 64).unwrap();
        v.note_on(60, 100);
        v.note_off(60);
        assert_eq!(v.pitch_envelope.stage, Stage::Attack);
        assert_eq!(v.filter_envelope.stage, Stage::Release);
    }
    #[test]
    fn velocity_is_cached_at_note_allocation_and_raw_patch_is_preserved() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[51, 283, 336], &[80, 1, 254]).unwrap();
        v.note_on(60, 32);
        assert_eq!(v.velocity_code, -78);
        assert_eq!(v.controls[51], 2);
        assert_eq!(v.parameter(51), Some(80));
        assert_eq!(v.amplitude_base, 2);
        v.set_parameter(283, 0).unwrap();
        v.set_parameter(51, 79).unwrap();
        assert_eq!(v.velocity_code, -78);
        assert_eq!(v.controls[51], 1);
        v.note_on(60, 32);
        assert_eq!(v.velocity_code, 0);
        assert_eq!(v.controls[51], 79);
        v.reset();
        assert_eq!(v.velocity_code, 0);
        assert_eq!(v.parameter(336), Some(254));
    }
    #[test]
    fn fm_reads_previous_depth_without_deferring_the_next_loader_state() {
        let mut v = Jp8000Voice::new();
        v.set_parameter(30, 5).unwrap();
        v.note_on(60, 100);
        v.amp.until_tick = 1;
        v.cross = 0;
        v.cross_target = 8_000_000;
        v.previous_cross_tap = 1_000_000;
        v.saw_phase = 0;
        let frequency = v.frequency_word;
        v.next_voice_frame();
        assert_eq!(v.saw_phase, frequency);
        assert!(v.cross > 0);
    }
    #[test]
    fn glide_enable_edits_wait_for_control_tick_and_filter_keyfollow_uses_glide() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[69, 70, 71, 72, 41, 43], &[1, 64, 1, 1, 50, 96])
            .unwrap();
        v.set_control_phase(400).unwrap();
        v.note_on(60, 100);
        v.note_on(72, 100);
        assert_eq!(v.glide.remaining, 8192);
        assert_eq!(v.glide.offset_cents, -1200);
        assert_eq!(v.pitch_cents, 0);
        let old_cutoff = v.filter.cutoff_target;
        v.set_parameter(69, 0).unwrap();
        assert_eq!(v.pitch_cents, 0);
        for _ in 0..400 {
            v.next_sample(RenderTap::Output);
        }
        assert_eq!(v.glide.offset_cents, -1200);
        v.next_sample(RenderTap::Output);
        assert_eq!(v.glide.offset_cents, 0);
        assert_eq!(v.glide.remaining, 7936);
        assert_eq!(v.pitch_cents, 1200);
        assert!(v.filter.cutoff_target > old_cutoff);
        v.set_parameter(69, 1).unwrap();
        assert_eq!(v.glide.offset_cents, 0);
        for _ in 0..882 {
            v.next_sample(RenderTap::Output);
        }
        assert_eq!(v.glide.remaining, 7680);
        assert_eq!(v.glide.offset_cents, -1125);
        assert_eq!(v.pitch_cents, 75);
    }
    #[test]
    fn dormant_settings_validate_final_activation_atomically() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[65, 70, 72], &[96, 96, 1]).unwrap();
        assert_eq!(v.parameter(65), Some(96));
        assert_eq!(v.parameter(70), Some(96));
        v.apply_patch(&[69, 51, 71], &[1, 32, 1]).unwrap();
        assert!(v.apply_patch(&[69, 51], &[0, 128]).is_err());
        assert_eq!(v.parameter(69), Some(1));
        assert_eq!(v.parameter(51), Some(32));
        v.set_parameter(18, 1).unwrap();
        // Full-domain fade permits latent modulation, but invalid raw controls
        // and assignment amounts still reject the whole batch before mutation.
        v.set_parameter(294, 254).unwrap();
        let before=v.params;
        assert!(v.apply_patch(&[18,294], &[128,127]).is_err());
        assert_eq!(before,v.params);
    }
    #[test]
    fn manual_pan_crosses_center_and_pan_modes_disable_amp_lfo1() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[58, 52, 256, 16], &[2, 96, 254, 2]).unwrap();
        v.set_morph(-128).unwrap();
        assert_eq!(v.controls[52], 0);
        v.note_on(60, 100);
        v.lfo_value = 16384;
        v.lfo_edge = true;
        v.update_amplitude();
        assert_eq!(v.amp.amplitude, v.amplitude_base);
        assert_eq!(v.amp.modulation_smoothing, 8);
        v.set_parameter(58, 1).unwrap();
        assert_eq!(v.controls[52], 64);
        v.set_morph(0).unwrap();
        assert_eq!(v.controls[52], 96);
        v.update_amplitude();
        assert_eq!(v.amp.amplitude, v.amplitude_base);
        v.set_parameter(58, 0).unwrap();
        v.update_amplitude();
        assert!(v.amp.amplitude > v.amplitude_base);
    }
    #[test]
    fn raw_parameters_validate_before_mutating() {
        let mut voice = Jp8000Voice::new();
        assert!(voice.set_parameter(41, 128).is_err());
        assert_eq!(voice.parameter(41), Some(127));
        assert!(voice.set_parameter(30, 7).is_err());
        assert!(voice.set_parameter(283, 2).is_err());
        voice.set_parameter(38, 64).unwrap();
        voice.set_parameter(16, 3).unwrap();
        assert!(voice.set_parameter(18, 128).is_err());
    }
    #[test]
    fn render_partition_is_exact_and_reset_is_reproducible() {
        let mut voice = Jp8000Voice::new();
        voice.set_parameter(30, 0).unwrap();
        voice.set_parameter(31, 81).unwrap();
        voice.set_parameter(32, 117).unwrap();
        voice.note_on(57, 100);
        let mut whole = [0.0; 4096];
        voice.render(&mut whole, RenderTap::Output);
        voice.reset();
        voice.note_on(57, 100);
        let mut pieces = [0.0; 4096];
        for p in pieces.chunks_mut(37) {
            voice.render(p, RenderTap::Output);
        }
        assert_eq!(whole, pieces);
    }
    #[test]
    fn zero_velocity_releases_and_mismatched_note_off_does_not() {
        let mut voice = Jp8000Voice::new();
        voice.note_on(60, 100);
        let mut output = [0.0; 256];
        voice.render(&mut output, RenderTap::Output);
        voice.note_off(61);
        assert!(voice.gate);
        voice.note_on(60, 0);
        voice.render(&mut output, RenderTap::Output);
        assert!(!voice.gate);
        voice.render(&mut output, RenderTap::Output);
        for _ in 0..8 {
            voice.render(&mut output, RenderTap::Output);
        }
        assert!(output[255].abs() < 1e-5);
    }
    #[test]
    fn irregular_events_are_independent_of_caller_block_size() {
        fn run(block: usize) -> [f32; 4096] {
            let mut v = Jp8000Voice::new();
            v.set_control_phase(314).unwrap();
            v.set_parameter(30, 0).unwrap();
            v.set_parameter(31, 96).unwrap();
            v.set_parameter(32, 64).unwrap();
            let mut out = [0.0; 4096];
            let mut cursor = 0;
            for endpoint in [113, 1537, 2021, 4096] {
                while cursor < endpoint {
                    let n = (endpoint - cursor).min(block);
                    v.render(&mut out[cursor..cursor + n], RenderTap::Output);
                    cursor += n;
                }
                match endpoint {
                    113 => v.note_on(60, 100),
                    1537 => v.note_off(60),
                    2021 => v.note_on(67, 100),
                    _ => {}
                }
            }
            out
        }
        let reference = run(1);
        for block in [7, 16, 32, 64, 128] {
            assert_eq!(reference, run(block));
        }
    }
    #[test]
    fn joint_filter_control_stays_in_range_and_changes_low_cutoff_damping() {
        assert!(filter_damping_word(32, 64) > filter_damping_word(127, 64));
        for cutoff in 0..128 {
            for resonance in 0..128 {
                let c = filter_cutoff_word(cutoff);
                let r = filter_damping_word(cutoff, resonance);
                assert!((8192..=8388096).contains(&c));
                assert!((8192..=4194304).contains(&r));
                assert_eq!(c & 511, 0);
                assert_eq!(r & 511, 0);
            }
        }
    }
    #[test]
    fn pitch_quantization_obeys_octaves_and_global_ceiling() {
        assert_eq!(pitch_word(60, 2), 49767);
        for note in 48..96 {
            assert!((pitch_word(note + 12, 2) - 2 * pitch_word(note, 2)).abs() <= 1);
        }
        assert_eq!(pitch_word(127, 4), 0x309c00);
        assert!(pitch_word(0, 0) > 0);
        let mut voice = Jp8000Voice::new();
        voice.set_parameter(30, 0).unwrap();
        voice.note_on(127, 100);
        assert_eq!(voice.frequency_word, 0x146e40);
    }
    #[test]
    fn split_multiply_and_saturation_obey_integer_boundaries() {
        assert_eq!(qmul(Q23 / 2, Q23 / 2, 7), Q23 / 4);
        assert_eq!(wrap24(1 << 23), -(1 << 23));
        assert_eq!(wrap24((1 << 24) - 1), -1);
        assert_eq!(sat24(Q23), Q23 - 1);
        assert_eq!(sat24(-Q23 - 1), -Q23);
    }
    #[test]
    fn supported_parameter_extremes_remain_finite() {
        for wave in [0, 5] {
            for note in [0, 60, 127] {
                for cutoff in [0, 64, 127] {
                    let mut v = Jp8000Voice::new();
                    for (id, value) in [
                        (30, wave),
                        (31, 127),
                        (32, if wave == 0 { 127 } else { 0 }),
                        (41, cutoff),
                        (42, 127),
                    ] {
                        v.set_parameter(id, value).unwrap();
                    }
                    v.note_on(note, 127);
                    let mut out = [0.0; 4096];
                    v.render(&mut out, RenderTap::Output);
                    assert!(out.iter().all(|x| x.is_finite() && x.abs() < 64.0));
                }
            }
        }
    }
    #[test]
    fn silence_preserves_allocated_history_but_reset_restores_generic_lifecycle() {
        let mut voice = Jp8000Voice::new();
        voice.note_on(67, 100);
        let mut block = [0.0; 128];
        voice.render(&mut block, RenderTap::Output);
        voice.silence();
        voice.set_parameter(41, 16).unwrap();
        assert!(voice.allocated);
        assert!(!voice.gate);
        voice.render(&mut block, RenderTap::Output);
        assert!(block.iter().all(|v| *v == 0.0));
        voice.note_on(60, 100);
        assert!(voice.gate);
        assert!(voice.coefficient_fast > 0);
        voice.reset();
        assert!(!voice.allocated);
        assert_eq!(voice.parameter(41), Some(16));
        assert_eq!(voice.frequency_word, 65536);
        assert_eq!(voice.filter.cutoff_target, 4096);
        voice.note_on(60, 100);
        assert_eq!(voice.filter.cutoff_target, filter_cutoff_word(16));
    }
    fn scheduler_test_voice() -> Jp8000Voice {
        let mut v = Jp8000Voice::new();
        v.apply_patch(
            &[41, 42, 46, 47, 48, 49, 50, 54, 55, 56, 57, 71, 72],
            &[64, 64, 80, 64, 64, 96, 64, 64, 64, 96, 64, 1, 1],
        )
        .unwrap();
        v.set_control_phase(400).unwrap();
        v.note_on(60, 100);
        v
    }
    fn scheduler_test_tick(v: &mut Jp8000Voice) {
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((0, false, 0)));
    }
    #[test]
    fn scheduled_initial_allocation_matches_native_control_snapshot() {
        let mut v = scheduler_test_voice();
        assert_eq!((v.amp.level, v.filter_envelope.level), (640, 640));
        assert_eq!(v.amp.target, 452 << 8);
        assert_eq!((v.amp.committed_rate, v.filter.cutoff_rate), (8, 2048));
        assert_eq!(
            (v.amp_scheduler.selector(), v.filter_scheduler.selector()),
            (11, 11)
        );
        scheduler_test_tick(&mut v);
        assert_eq!((v.amp.level, v.filter_envelope.level), (1260, 1260));
        assert_eq!(v.amp.target, 890 << 8);
        assert_eq!((v.amp.committed_rate, v.filter.cutoff_rate), (8, 8));
    }
    #[test]
    fn scheduled_attack_holds_targets_through_parameter_and_expression_edits() {
        let mut v = scheduler_test_voice();
        for _ in 0..10 {
            scheduler_test_tick(&mut v);
        }
        assert_eq!(v.amp.level, 6034);
        let old = (
            v.amp.target,
            v.filter.cutoff_target,
            v.filter.damping_target,
        );
        let loaders = (
            v.coefficient_fast,
            v.filter.cutoff_fast,
            v.filter.damping_fast,
        );
        v.note_on(67, 100);
        assert_eq!(
            (
                v.amp.target,
                v.filter.cutoff_target,
                v.filter.damping_target
            ),
            old
        );
        assert_eq!(
            (
                v.coefficient_fast,
                v.filter.cutoff_fast,
                v.filter.damping_fast
            ),
            loaders
        );
        scheduler_test_tick(&mut v);
        assert_eq!(v.amp.level, 6485);
        assert_eq!(v.amp.target, 4584 << 8);
        assert_eq!((v.amp.committed_rate, v.filter.cutoff_rate), (144, 144));
        let held = (
            v.amp.target,
            v.filter.cutoff_target,
            v.filter.damping_target,
        );
        v.set_expression(64).unwrap();
        v.set_parameter(41, 32).unwrap();
        assert_eq!(v.amp.amplitude, 2941);
        assert_eq!(
            (
                v.amp.target,
                v.filter.cutoff_target,
                v.filter.damping_target
            ),
            held
        );
        for (level, selector) in [(6922, 12), (7345, 11)] {
            scheduler_test_tick(&mut v);
            assert_eq!(v.amp.level, level);
            assert_eq!(v.amp_scheduler.selector(), selector);
            assert_eq!(
                (
                    v.amp.target,
                    v.filter.cutoff_target,
                    v.filter.damping_target
                ),
                held
            );
            assert_eq!((v.amp.committed_rate, v.filter.cutoff_rate), (144, 144));
        }
        scheduler_test_tick(&mut v);
        assert_eq!(v.amp.level, 7755);
        assert_eq!(v.amp.target, 1392 << 8);
        assert_eq!((v.amp.committed_rate, v.filter.cutoff_rate), (8, 8));
        assert_ne!(v.filter.cutoff_target, held.1);
        assert_ne!(v.filter.damping_target, held.2);
    }
    #[test]
    fn scheduled_release_preserves_native_adjacent_word_rates() {
        for (hold_ticks, amp_rate, filter_rate, level, target) in
            [(0, 9264, 100, 6283, 4442), (1, 9216, 0, 6706, 4740)]
        {
            let mut v = scheduler_test_voice();
            for _ in 0..10 {
                scheduler_test_tick(&mut v);
            }
            v.note_on(67, 100);
            scheduler_test_tick(&mut v);
            for _ in 0..hold_ticks {
                scheduler_test_tick(&mut v);
            }
            v.note_off(67);
            scheduler_test_tick(&mut v);
            assert_eq!(v.amp.level, level);
            assert_eq!(v.amp.target, target << 8);
            assert_eq!(
                (v.amp.committed_rate, v.filter.cutoff_rate),
                (amp_rate, filter_rate)
            );
            scheduler_test_tick(&mut v);
            assert_eq!((v.amp.committed_rate, v.filter.cutoff_rate), (8, 8));
        }
    }
    #[test]
    fn allocation_mute_preserves_gain_other_dsp_and_scheduler() {
        let mut v = scheduler_test_voice();
        v.amp_scheduler.retarget();
        v.amp_scheduler.tick(Destination::Amp, true, 11);
        v.amp.value = 123456;
        v.filter.state = [1, 2, 3, 4];
        v.saw_phase = 98765;
        v.clear_controller_amp();
        assert_eq!(
            (v.amp.level, v.amp.stage, v.amp.target, v.amp.committed_rate),
            (0, Stage::Idle, 0, 128)
        );
        assert_eq!(v.amp.value, 123456);
        assert_eq!(v.filter.state, [1, 2, 3, 4]);
        assert_eq!(v.saw_phase, 98765);
        assert_eq!(v.amp_scheduler.selector(), 13);
        // A full restart preserves the old amp selector but resets filter0.
        v.start_note(64, 100, None, false);
        assert_eq!(v.amp_scheduler.selector(), 12);
        assert_eq!((v.amp.target, v.amp.committed_rate), (0, 128));
        assert_eq!(v.filter.cutoff_rate, 2048);
    }
    #[test]
    fn public_mono_retrigger_gap_keeps_glide_history_but_legato_gap_does_not() {
        for legato in [0, 1] {
            let mut v = Jp8000Voice::new();
            v.apply_patch(&[69, 70, 71, 72], &[1, 64, 1, legato])
                .unwrap();
            v.set_control_phase(400).unwrap();
            v.note_on(60, 100);
            v.note_off(60);
            v.note_on(72, 100);
            assert_eq!(v.glide.offset_cents, if legato == 0 { -1163 } else { 0 });
            assert_eq!(v.glide.remaining, 7936);
        }
    }
}

#[cfg(test)]
mod fade_integration_tests {
    use super::*;
    fn active(raw: u16) -> Jp8000Voice {
        let mut v = Jp8000Voice::with_effects(false);
        for (id, value) in [(30, 5), (18, raw), (25, 96), (44, 80), (52, 80), (57, 96)] {
            v.set_parameter(id, value).unwrap();
        }
        v.raw_lfo_value = 12000;
        v.set_control_phase(314).unwrap();
        v.note_on(60, 100);
        v
    }
    #[test]
    fn active_fade_domain_and_assignment_guards_cover_all_raws() {
        let mut p = defaults();
        p[25] = 96;
        for raw in 0..128 {
            p[18] = raw;
            assert_eq!(
                Jp8000Voice::validate_parameter_for(&p, 18, raw).is_ok(),
                fade::supported(raw)
            );
        }
        p[18] = 64;
        for id in [76, 286] {
            for value in [0, 126, 128, 254] {
                assert!(Jp8000Voice::validate_parameter_for(&p, id, value).is_ok());
            }
        }
    }
    #[test]
    fn allocation_scales_once_and_legato_and_edit_preserve_held_value() {
        let mut v = active(64);
        let before = (v.fade.ramp, v.fade.gain, v.lfo_value);
        assert_eq!(
            before,
            (
                321,
                v.fade.curve(321),
                (12000 * i32::from(v.fade.curve(321))) >> 14
            )
        );
        v.raw_lfo_value = -12000;
        v.start_note(64, 100, Some((60, 0)), true);
        assert_eq!(before, (v.fade.ramp, v.fade.gain, v.lfo_value));
        v.set_parameter(18, 116).unwrap();
        assert_eq!(before, (v.fade.ramp, v.fade.gain, v.lfo_value));
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((-12000, true, 8192)));
        assert_eq!(v.fade.ramp, 355);
        assert_eq!(v.lfo_value, (-12000 * i32::from(v.fade.gain)) >> 14);
        assert_eq!(v.lfo2_value, 8192);
        assert!(v.lfo_edge);
        let held = v.lfo_value;
        v.next_voice_frame_with_lfo(Some((-12000, true, 8192)));
        assert_eq!(v.lfo_value, held);
    }
    #[test]
    fn release_keeps_fading_and_full_allocation_resets() {
        let mut v = active(116);
        let before = v.fade.ramp;
        v.note_off(60);
        assert_eq!(v.fade.ramp, before);
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((10000, false, 0)));
        assert_eq!(v.fade.ramp, before + 34);
        v.note_on(64, 100);
        assert_eq!(v.fade.ramp, 34);
    }
    #[test]
    fn fade_routes_to_pitch_filter_and_amp_but_not_second_lfo_or_pan() {
        let mut v = active(64);
        v.wheel = 127;
        v.set_parameter(26, 80).unwrap();
        v.set_parameter(45, 80).unwrap();
        v.set_parameter(53, 80).unwrap();
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, true, 8192)));
        let scaled = (12000 * i32::from(v.fade.gain)) >> 14;
        assert_eq!(v.lfo_value, scaled);
        let cents = (scaled * pitch_lfo_depth(96) >> 14)
            + ((((8192 * pitch_lfo_depth(80)) >> 14) * wheel_level(127)) >> 7);
        assert_eq!(v.pitch_cents, cents);
        let cutoff = 12700
            + ((scaled * bipolar_depth(80, 6000)) >> 14)
            + ((((8192 * bipolar_depth(80, 6000)) >> 14) * wheel_level(127)) >> 7);
        assert_eq!(
            v.filter_target_values().0,
            (filter_cutoff_cents(cutoff) * 256) & !511
        );
        v.update_amplitude();
        let base = i64::from(v.amplitude_base);
        let amount = ((scaled * amp_lfo_depth(80)) >> 14)
            + ((((8192 * amp_lfo_depth(80)) >> 14) * wheel_level(127)) >> 7);
        assert_eq!(
            v.amp.amplitude,
            (base + ((base * i64::from(amount)) >> 12)).clamp(0, 32767) as i32
        );
        v.set_parameter(58, 1).unwrap();
        v.update_amplitude();
        let second = (((8192 * amp_lfo_depth(80)) >> 14) * wheel_level(127)) >> 7;
        assert_eq!(
            v.amp.amplitude,
            (base + ((base * i64::from(second)) >> 12)).clamp(0, 32767) as i32
        );
        assert_eq!(v.raw_lfo_value, 12000);
        assert_eq!(v.lfo2_value, 8192);
        assert!(v.lfo_edge);
    }
    #[test]
    fn unknown_dormant_history_blocks_activation_until_proven_complete_or_reallocated() {
        let mut v = Jp8000Voice::with_effects(false);
        v.set_parameter(18, 1).unwrap();
        v.note_on(60, 100);
        v.fade.configure(128); v.fade.allocate();
        assert!(!v.fade.known);
        v.set_parameter(18, 64).unwrap();
        let p = v.params;
        assert!(v.set_parameter(25, 96).is_err());
        assert_eq!(v.params, p);
        for _ in 0..52 {
            v.amp.until_tick = 0;
            v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        }
        assert!(v.fade.known);
        assert!(!v.fade.ramp_exact);
        v.set_parameter(25, 96).unwrap();
    }
    #[test]
    fn invalid_fade_rejection_keeps_atomic_patch_and_midi_state() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[18, 57], &[1, 96]).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert!(p.apply_patch(&[18, 25, 41], &[128, 96, 50]).is_err());
        assert_eq!(p.parameter(18), Some(1));
        assert_eq!(p.parameter(25), Some(64));
        assert_eq!(p.parameter(41), Some(127));
        for id in [76,286] { assert!(p.apply_patch(&[id,41],&[255,50]).is_err()); }
        p.apply_patch(&[18,76,286,25,41], &[64,254,0,96,50]).unwrap();
    }

    #[test]
    fn autopan_audio_is_identical_for_zero_and_nonzero_voice_fade() {
        fn audio(raw: u16) -> Vec<f32> {
            let mut v = Jp8000Voice::new();
            for (id, value) in [(30, 5), (18, raw), (58, 1), (52, 96)] {
                v.set_parameter(id, value).unwrap();
            }
            v.set_lfo_phase(0.21).unwrap();
            v.note_on(60, 100);
            let mut out = vec![0.0; 8192];
            v.render(&mut out, RenderTap::Output);
            out
        }
        assert_eq!(audio(0), audio(64));
    }
    #[test]
    fn fade_callback_partitioning_is_exact_through_retarget_edit_and_release() {
        fn audio(block: usize) -> Vec<f32> {
            let mut v = active(64);
            v.set_parameter(71, 1).unwrap();
            v.set_parameter(72, 1).unwrap();
            let mut output = vec![0.0; 8192];
            let mut begin = 0;
            for end in [1379, 2911, 4093, 8192] {
                for chunk in output[begin..end].chunks_mut(block) {
                    v.render(chunk, RenderTap::Output);
                }
                match end {
                    1379 => v.note_on(67, 100),
                    2911 => v.set_parameter(18, 116).unwrap(),
                    4093 => v.note_off(67),
                    _ => {}
                }
                begin = end;
            }
            output
        }
        let expected = audio(1);
        for block in [7, 37, 64, 128, 4096] {
            assert_eq!(audio(block), expected);
        }
    }

    #[test]
    fn allocated_idle_amp_preserves_fade_lifecycle_and_history_guard() {
        let mut v = active(116);
        v.clear_controller_amp();
        let ramp = v.fade.ramp;
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        assert_eq!(v.fade.ramp, ramp + 34);
        let value = v.lfo_value;
        v.start_note(64, 100, Some((60, 0)), true);
        assert_eq!(v.lfo_value, value);
        assert_eq!(v.fade.ramp, ramp + 34);
        v.set_parameter(18, 39).unwrap();
        assert_eq!(v.fade.ramp, ramp + 34);
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        assert_eq!(v.fade.ramp, ramp + 34 + 1170);
        let mut unknown = Jp8000Voice::with_effects(false);
        unknown.set_parameter(18, 1).unwrap();
        unknown.note_on(60, 100);
        unknown.fade.configure(128); unknown.fade.allocate();
        unknown.silence();
        unknown.set_parameter(18, 64).unwrap();
        assert!(unknown.set_parameter(25, 96).is_err());
        unknown.reset();
        unknown.set_parameter(25, 96).unwrap();
    }
    #[test]
    fn autopan_only_does_not_require_voice_fade_support() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[58, 52, 18, 76], &[1, 96, 1, 254]).unwrap();
        p.set_parameter(58, 0).unwrap();
        p.set_parameter(25, 96).unwrap();
        assert_eq!(p.parameter(58), Some(0));
    }
    #[test]
    fn standalone_voice_batch_preserves_every_control_on_unknown_fade_rejection() {
        let mut v = Jp8000Voice::with_effects(false);
        v.set_parameter(18, 1).unwrap();
        v.note_on(60, 100);
        v.fade.configure(128); v.fade.allocate();
        let before = (
            v.params,
            v.controls,
            v.effect_settings.parameter(2034),
            v.fade.ramp,
            v.fade.gain,
        );
        assert!(v.apply_patch(&[2034, 18, 25], &[119, 64, 96]).is_err());
        assert_eq!(
            before,
            (
                v.params,
                v.controls,
                v.effect_settings.parameter(2034),
                v.fade.ramp,
                v.fade.gain
            )
        );
        v.set_parameter(18, 0).unwrap();
        assert!(v.apply_patch(&[25], &[96]).is_err());
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        v.apply_patch(&[2034, 25], &[119, 96]).unwrap();
        assert_eq!(v.params[25], 96);
    }
}

#[cfg(test)]
mod generic_program_lifecycle_tests {
    use super::*;

    #[test]
    fn free_controls_are_stored_and_same_selector_is_a_program_reload() {
        let mut v = Jp8000Voice::new_pre_output();
        v.set_parameter(30, 5).unwrap();
        v.set_parameter(31, 112).unwrap();
        assert_eq!(v.saw_shape_target, 4096);
        v.note_on(60, 100);
        assert!(v.controller_assigned && v.gate);
        assert_eq!(v.frequency_word, 49767); // no serial-delay alignment
        assert_eq!(v.saw_shape_target, 112 << 16);
        for _ in 0..3000 { v.next_voice_frame(); }
        let history = (v.saw_phase, v.saw_shape, v.frequency_word, v.amp.until_tick);
        v.set_controller_assigned(false);
        assert_eq!(history, (v.saw_phase, v.saw_shape, v.frequency_word, v.amp.until_tick));
        v.set_parameter(31, 17).unwrap();
        for _ in 0..2000 { v.next_voice_frame(); }
        assert_eq!(v.saw_shape_target, 112 << 16);
        v.set_parameter(30, 5).unwrap();
        assert_eq!(v.saw_shape_target, 4096);
        v.note_on(60, 100);
        assert_eq!(v.saw_shape_target, 17 << 16);
    }

    #[test]
    fn reload_changes_only_its_program_block_not_common_pitch_or_cross() {
        let mut v = Jp8000Voice::new_pre_output();
        v.set_parameter(22, 64).unwrap();
        v.note_on(60, 100);
        for _ in 0..3000 { v.next_voice_frame(); }
        let common = (v.frequency_word, v.cross, v.cross_target);
        v.set_controller_assigned(false);
        v.set_parameter(30, 3).unwrap();
        assert_eq!(common, (v.frequency_word, v.cross, v.cross_target));
        assert!(v.osc1_generic_program);
        v.set_parameter(31, 112).unwrap();
        assert!(v.osc1_generic_program);
    }

    #[test]
    fn generic_cross_evolves_from_zero_with_its_original_loader() {
        let mut v = Jp8000Voice::new_pre_output();
        assert_eq!(v.cross, 0);
        for _ in 0..4096 { v.next_voice_frame(); }
        assert_eq!(v.cross, 4033); // target4096 with floor(delta/64)
    }
}

#[cfg(test)]
mod generic_fade_interaction_tests {
    use super::*;

    #[test]
    fn freeing_stops_oscillator_edits_but_preserves_fade_and_glide_ticks() {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[18, 25, 31, 69, 70], &[116, 80, 112, 1, 64]).unwrap();
        v.note_on(60, 100);
        v.note_on(72, 100);
        v.note_off(72);
        v.clear_controller_amp();
        v.set_controller_assigned(false);
        assert!(v.allocated && !v.controller_assigned);
        let before = (v.saw_shape_target, v.frequency_word, v.cross_target);
        let ramp = v.fade.ramp;
        let glide = v.glide.offset_cents;
        assert!(glide < 0);
        // Free slots still receive the fade-rate edit, but retain OSC targets.
        v.apply_patch(&[18, 31, 22], &[39, 17, 96]).unwrap();
        assert_eq!(v.params[31], 17);
        assert_eq!(before, (v.saw_shape_target, v.frequency_word, v.cross_target));
        assert_eq!(v.fade.ramp, ramp);
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        assert_eq!(v.fade.ramp, ramp + 1170);
        assert!(v.glide.offset_cents > glide);
        assert_eq!(before, (v.saw_shape_target, v.frequency_word, v.cross_target));
    }

    #[test]
    fn repeated_free_selector_keeps_fade_history_and_allocation_restarts_it() {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[18, 25, 31], &[116, 80, 112]).unwrap();
        v.note_on(60, 100);
        v.note_off(60);
        v.clear_controller_amp();
        v.set_controller_assigned(false);
        let before = (v.fade.ramp, v.fade.gain, v.lfo_value, v.amp.until_tick);
        v.set_parameter(30, 5).unwrap();
        assert_eq!(v.saw_shape_target, 4096);
        assert_eq!(before, (v.fade.ramp, v.fade.gain, v.lfo_value, v.amp.until_tick));
        v.set_parameter(31, 17).unwrap();
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        assert_eq!(v.fade.ramp, before.0 + 34);
        v.note_on(67, 100);
        assert!(v.controller_assigned);
        assert_eq!(v.saw_shape_target, 17 << 16);
        assert_eq!(v.fade.ramp, 34);
    }

    #[test]
    fn unknown_free_fade_rejection_does_not_reload_a_program_or_change_effects() {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[18, 31], &[1, 112]).unwrap();
        v.note_on(60, 100);
        v.fade.configure(128); v.fade.allocate();
        v.note_off(60);
        v.clear_controller_amp();
        v.set_controller_assigned(false);
        assert!(!v.fade.known);
        let before = (v.params, v.controls, v.effect_settings.parameter(2034),
            v.saw_shape_target, v.saw_phase, v.fade.ramp, v.fade.gain);
        assert!(v.apply_patch(&[30, 31, 18, 25, 2034], &[5, 17, 64, 96, 119]).is_err());
        assert_eq!(before, (v.params, v.controls, v.effect_settings.parameter(2034),
            v.saw_shape_target, v.saw_phase, v.fade.ramp, v.fade.gain));
        // Supported increments recover known unity even while unassigned.
        v.set_parameter(18, 0).unwrap();
        v.amp.until_tick = 0;
        v.next_voice_frame_with_lfo(Some((12000, false, 0)));
        assert!(v.fade.known);
        v.apply_patch(&[30, 31, 25, 2034], &[5, 17, 96, 119]).unwrap();
        assert_eq!(v.saw_shape_target, 4096);
        assert_eq!(v.params[31], 17);
        assert_eq!(v.effect_settings.parameter(2034), Some(119));
    }
}

#[cfg(test)]
mod part_pitch_tests {
    use super::*;
    fn voice() -> Jp8000Voice { Jp8000Voice::new_pre_output() }
    fn history(v: &Jp8000Voice) -> (i32,i32,u16) {
        (v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining)
    }
    #[test]
    fn part_pitch_folds_all_valid_input_octave_transpose_combinations() {
        let mut v=voice();
        for note in 0..=127 {
            v.note=note;
            for octave in 0..=4 {
                v.controls[73]=octave;
                for transpose in 0..=48 {
                    v.set_part_pitch(transpose,0);
                    let mut expected=i32::from(note)+i32::from(transpose)+12*i32::from(octave)-48;
                    while expected>127 { expected-=12; }
                    while expected<0 { expected+=12; }
                    assert_eq!(i32::from(v.part_effective_note()),expected);
                }
            }
        }
    }
    #[test]
    fn part_pitch_storage_is_staged_and_hard_reset_preserves_settings() {
        let mut v=voice();
        v.note_on(60,100);
        let old=(v.frequency_word,v.pitch_cents,v.filter_target_values(),history(&v));
        v.set_part_pitch(36,17);
        assert_eq!(old.0,v.frequency_word);
        assert_eq!(old.1,v.pitch_cents);
        assert_eq!(old.3,history(&v));
        v.recalculate();
        assert_eq!(v.pitch_cents,1217);
        assert_eq!(v.frequency_word,pitch_word_cents(1217));
        v.reset();
        assert_eq!((v.part_transpose,v.part_detune),(36,17));
        assert_eq!(history(&v),(0,0,0));
        v.note_on(60,100);
        assert_eq!(v.pitch_cents,1217);
    }
    #[test]
    fn part_pitch_matches_equivalent_note_for_pitch_and_filter_keyfollow() {
        let mut a=voice();let mut b=voice();
        for v in [&mut a,&mut b] {
            v.apply_patch(&[41,43],&[50,127]).unwrap();
        }
        a.set_part_pitch(36,17); b.set_part_pitch(24,17);
        a.note_on(60,100); b.note_on(72,100);
        assert_eq!(a.note,60); // Keep the input note separate from the folded note.
        assert_eq!(a.part_effective_note(),72);
        assert_eq!((a.pitch_cents,a.frequency_word,a.filter_target_values()),
            (b.pitch_cents,b.frequency_word,b.filter_target_values()));
        b.set_part_pitch(24,0);b.recalculate();
        assert_ne!(a.filter_target_values(),b.filter_target_values());
    }
    #[test]
    fn feedback_period_uses_folded_note_and_cancels_part_detune() {
        let mut v=voice();v.apply_patch(&[30,31,32],&[3,64,64]).unwrap();
        v.set_part_pitch(0,25);v.note_on(84,100);
        assert_eq!(v.part_effective_note(),60);
        assert_eq!(v.pitch_cents,25);
        let mut actual=v.other_oscillator.clone();
        let mut expected=actual.clone();
        expected.set_feedback_period_word(feedback_period(60,0));
        let mut wrongly_detuned=actual.clone();
        wrongly_detuned.set_feedback_period_word(feedback_period(60,25));
        let mut wrong_differs=false;
        for _ in 0..32768 {
            let sample=actual.next_sample();
            assert_eq!(sample,expected.next_sample());
            wrong_differs |= sample != wrongly_detuned.next_sample();
        }
        assert!(wrong_differs, "fixture must expose a mistakenly detuned delay period");
    }
    #[test]
    fn live_octave_preserves_instantaneous_offset_until_tick_and_same_write_restarts() {
        let mut v=voice();v.apply_patch(&[69,70],&[1,64]).unwrap();
        v.note_on(60,100);v.note_on(67,100);
        let offset=v.glide.offset_cents;let amp=(v.amp.level,v.amp.value);let fade=v.fade.ramp;
        assert!((-700..0).contains(&offset));
        v.set_parameter(73,3).unwrap();
        assert_eq!(history(&v),(-1200,offset,8192));
        assert_eq!((v.amp.level,v.amp.value),amp);assert_eq!(v.fade.ramp,fade);
        v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((0,false,0)));
        assert_eq!(v.glide.offset_cents,(-1200*i32::from(8192-v.glide_rate))>>13);
        let offset=v.glide.offset_cents;
        v.set_parameter(73,3).unwrap();
        assert_eq!(history(&v),(0,offset,8192));
    }
    #[test]
    fn cold_octave_and_part_hooks_do_not_invent_owned_history() {
        let mut v=voice();let before=history(&v);
        v.set_parameter(73,4).unwrap();
        v.set_part_pitch(0,-25);
        v.retarget_part_transpose(Some((127,700)));
        assert_eq!(history(&v),before);
        assert!(!v.allocated);
        v.note_on(60,100);
        assert_eq!(v.pitch_cents,-25);
    }
    #[test]
    fn free_owned_octave_changes_history_without_restarting_fade_or_oscillator() {
        let mut v=voice();v.apply_patch(&[18,25,69,70],&[64,80,1,64]).unwrap();
        v.note_on(60,100);v.set_parameter(69,1).unwrap();v.note_off(60);v.set_controller_assigned(false);
        let before=(v.frequency_word,v.cross_target,v.fade.ramp,v.fade.gain);
        v.set_parameter(73,1).unwrap();
        assert_eq!(history(&v),(1200,0,8192));
        assert_eq!(before,(v.frequency_word,v.cross_target,v.fade.ramp,v.fade.gain));
        v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((0,false,0)));
        assert!(v.glide.offset_cents>0);assert!(v.fade.ramp>before.2);
    }
    #[test]
    fn invalid_batch_cannot_retarget_octave_or_change_stored_part_settings() {
        let mut v=voice();v.note_on(67,100);v.set_part_pitch(36,17);
        let before=(v.params,v.controls,history(&v),v.frequency_word,v.part_transpose,v.part_detune);
        assert!(v.apply_patch(&[73,41],&[4,128]).is_err());
        assert_eq!(before,(v.params,v.controls,history(&v),v.frequency_word,v.part_transpose,v.part_detune));
        assert!(v.set_parameter(73,5).is_err());
        assert_eq!(before,(v.params,v.controls,history(&v),v.frequency_word,v.part_transpose,v.part_detune));
    }
    #[test]
    fn octave_batch_matches_single_commit_and_preserves_input_note() {
        let mut a=voice();let mut b=voice();
        for v in [&mut a,&mut b] { v.note_on(120,100);v.set_part_pitch(36,-17);v.recalculate(); }
        a.set_parameter(73,4).unwrap();b.apply_patch(&[73],&[4]).unwrap();
        assert_eq!(a.part_effective_note(),120);
        assert_eq!(a.note,120);
        assert_eq!(history(&a),history(&b));
        assert_eq!((a.pitch_cents,a.frequency_word),(b.pitch_cents,b.frequency_word));
    }
    #[test]
    fn live_part_transpose_uses_input_source_and_preserves_envelope_fade() {
        let mut v=voice();v.note_on(120,100);
        let before=(v.amp.level,v.amp.value,v.fade.ramp,v.fade.gain);
        v.set_part_pitch(48,25);
        v.retarget_part_transpose(Some((127,-375)));
        assert_eq!(history(&v),(325,325,8192));
        assert_eq!(before,(v.amp.level,v.amp.value,v.fade.ramp,v.fade.gain));
        assert_eq!(v.part_effective_note(),120);
        v.recalculate();assert_eq!(v.pitch_cents,6350);
        v.retarget_part_transpose(None);assert_eq!(history(&v),(0,0,8192));
    }
}

#[cfg(test)]
mod part_pitch_live_cache_tests {
    use super::*;
    fn tick(v:&mut Jp8000Voice,n:usize) { for _ in 0..n { v.tick_glide(); } }
    fn state(v:&Jp8000Voice)->(u8,bool,i32,i32,u16,u16) {
        (v.part_effective_note(),v.glide_enabled,v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining,v.glide_rate)
    }
    #[test]
    fn native_enabled_octave_transpose_and_free_history_sequence() {
        // Semantic100Hz event sequence from the41-row native live-enabled
        // capture. UART/sub-instruction delays are deliberately not reproduced.
        let mut v=Jp8000Voice::new_pre_output();
        v.apply_patch(&[69,70],&[1,100]).unwrap();v.note_on(60,100);
        tick(&mut v,50);
        assert_eq!(state(&v),(60,false,0,0,5336,56));
        v.set_parameter(69,1).unwrap();tick(&mut v,5);
        assert_eq!(state(&v),(60,true,0,0,5056,56));
        v.set_parameter(73,3).unwrap();
        assert_eq!(state(&v),(72,true,-1200,0,8192,56));
        tick(&mut v,1);assert_eq!(state(&v),(72,true,-1200,-1192,8136,56));
        tick(&mut v,5);assert_eq!(state(&v),(72,true,-1200,-1151,7856,56));
        let source=(v.note,v.glide.offset_cents);
        v.set_part_pitch(25,0);v.retarget_part_transpose(Some(source));tick(&mut v,5);
        assert_eq!(state(&v),(73,true,-1151,-1112,7912,56));
        tick(&mut v,1);let source=(v.note,v.glide.offset_cents);
        v.set_part_pitch(25,0);v.retarget_part_transpose(Some(source));tick(&mut v,4);
        assert_eq!(state(&v),(73,true,-1104,-1074,7968,56));
        let source=(v.note,v.glide.offset_cents);let old_octave=v.controls[73];
        v.set_part_pitch(26,0);v.params[73]=4;v.refresh_controls();
        v.retarget_part_transpose(Some(source));
        v.retarget_patch_octave(v.part_effective_note_with_octave(old_octave));
        tick(&mut v,4);assert_eq!(state(&v),(86,true,-1200,-1168,7968,56));
        v.note_off(60);v.set_controller_assigned(false);tick(&mut v,100);
        assert_eq!(state(&v),(86,true,-1200,-347,2368,56));
        v.set_parameter(69,1).unwrap();tick(&mut v,5);
        assert_eq!(state(&v),(86,true,-1200,-306,2088,56));
        v.set_parameter(73,2).unwrap();tick(&mut v,4);
        assert_eq!(state(&v),(62,true,2400,2334,7968,56));
        tick(&mut v,1);let source=(v.note,v.glide.offset_cents);
        v.set_part_pitch(27,0);v.retarget_part_transpose(Some(source));tick(&mut v,4);
        assert_eq!(state(&v),(63,true,2317,2253,7968,56));
    }
    #[test]
    fn first_cold_note_octave_does_not_restore_cached_enable() {
        let mut v=Jp8000Voice::new_pre_output();
        v.apply_patch(&[69,70],&[1,100]).unwrap();v.note_on(60,100);
        assert!(!v.glide_enabled);v.set_parameter(73,3).unwrap();tick(&mut v,1);
        assert_eq!(state(&v),(72,false,-1200,0,8136,56));
        v.set_parameter(41,92).unwrap();assert!(!v.glide_enabled);
        v.set_parameter(70,100).unwrap();assert!(v.glide_enabled);
        assert_eq!((v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining),(-1200,0,8136));
        tick(&mut v,1);assert_eq!(v.glide.offset_cents,-1184);
    }
}

#[cfg(test)]
mod glide_control_latch_tests {
    use super::*;
    #[test]
    fn changed_morph_refreshes_cached_glide_but_unchanged_and_unrelated_edits_do_not() {
        let mut v=Jp8000Voice::new_pre_output();
        v.apply_patch(&[69,70,281],&[1,100,254]).unwrap();v.note_on(60,100);
        assert_eq!((v.glide_enabled,v.glide_rate),(false,56));
        let history=(v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining);
        v.set_morph(0).unwrap();v.set_parameter(41,92).unwrap();
        v.set_pitch_bend(9000).unwrap();v.set_modulation_wheel(64).unwrap();
        assert_eq!((v.glide_enabled,v.glide_rate),(false,56));
        // Native CC2=127, then pressure64 with active assignment281=254.
        v.set_morph(-128).unwrap();
        assert_eq!((v.glide_enabled,v.glide_rate),(true,8192));
        v.set_morph(64).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,6));
        v.set_parameter(70,100).unwrap();assert_eq!(v.glide_rate,6);
        v.set_morph(0).unwrap();assert_eq!(v.glide_rate,56);
        v.set_parameter(281,254).unwrap();assert_eq!(v.glide_rate,56);
        v.set_morph(128).unwrap();assert_eq!(v.glide_rate,6);
        v.set_parameter(362,127).unwrap();v.set_parameter(69,1).unwrap();
        assert_eq!((v.glide_enabled,v.glide_rate),(true,6));
        assert_eq!(history,(v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining));
        v.set_controller_assigned(false);
        v.set_morph(0).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,56));
    }
    #[test]
    fn rejected_glide_batch_preserves_cache_and_timers() {
        let mut v=Jp8000Voice::new_pre_output();
        v.apply_patch(&[69,70],&[1,100]).unwrap();v.note_on(60,100);
        let before=(v.glide_enabled,v.glide_rate,v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining);
        assert!(v.apply_patch(&[69,70,41],&[1,64,128]).is_err());
        assert_eq!(before,(v.glide_enabled,v.glide_rate,v.glide.initial_cents,v.glide.offset_cents,v.glide.remaining));
    }
}

#[cfg(test)]
mod free_morph_glide_tests {
    use super::*;
    #[test]
    fn unchanged_zero_morph_preserves_cold_cache_and_changed_morph_refreshes_free_owner() {
        // Eleven-row native Free/unchanged refinement; caller marks the actual
        // controller-free transition because Voice alone has no allocator.
        let mut v=Jp8000Voice::new_pre_output();
        v.apply_patch(&[69,70,281],&[1,100,254]).unwrap();v.note_on(60,100);
        assert_eq!((v.glide_enabled,v.glide_rate),(false,56));
        v.set_morph(0).unwrap();v.set_morph(0).unwrap();
        assert_eq!((v.glide_enabled,v.glide_rate),(false,56));
        v.note_off(60);v.clear_controller_amp();v.set_controller_assigned(false);
        assert_eq!((v.glide_enabled,v.glide_rate),(false,56));
        v.set_morph(64).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,6));
        v.set_morph(64).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,6));
        v.set_morph(-128).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,8192));
        v.set_parameter(70,100).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,8192));
        v.set_parameter(69,0).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(false,8192));
        v.set_morph(0).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(false,56));
        v.set_parameter(69,1).unwrap();assert_eq!((v.glide_enabled,v.glide_rate),(true,56));
    }
}

#[cfg(test)]
mod low_fade_extension_tests {
    use super::*;
    #[test]
    fn observed_low_rates_follow_allocation_retarget_release_and_idle_lifecycle() {
        for (raw, increment) in [(3, 9637), (12, 5120), (14, 4551), (6, 7447), (119, 14), (127, 6)] {
            let mut v = Jp8000Voice::with_effects(false);
            v.apply_patch(&[18,25,44,52,57,71,72], &[raw,96,80,80,96,1,1]).unwrap();
            v.raw_lfo_value = -12000;
            v.set_control_phase(314).unwrap();
            v.note_on(60,100);
            assert_eq!(v.fade.ramp, increment);
            assert!(v.fade.known && v.fade.ramp_exact);
            let held = (v.fade.ramp,v.fade.gain,v.lfo_value);
            v.note_on(64,90); // true legato before the next 100 Hz update
            assert_eq!(held,(v.fade.ramp,v.fade.gain,v.lfo_value));
            v.note_off(64);
            assert_eq!(held,(v.fade.ramp,v.fade.gain,v.lfo_value));
            v.clear_controller_amp(); // an idle amplifier does not stop owned fade
            v.amp.until_tick=0;
            v.next_voice_frame_with_lfo(Some((11000,true,-8192)));
            assert_eq!(v.fade.ramp,(u32::from(increment)*2).min(16384) as u16);
            assert_eq!(v.lfo_value,(11000*i32::from(v.fade.gain))>>14);
            assert_eq!(v.lfo2_value,-8192);assert!(v.lfo_edge);
            v.note_on(67,110); // key gap: full allocation starts the fade again
            assert_eq!(v.fade.ramp,increment);
        }
    }
    #[test]
    fn low_rate_live_edits_preserve_history_and_rejections_remain_atomic() {
        for (raw,increment) in [(3,9637),(12,5120),(14,4551),(6,7447),(119,14),(127,6)] {
            let mut v=Jp8000Voice::with_effects(false);
            v.apply_patch(&[18,25,71,72],&[116,96,1,1]).unwrap();
            v.raw_lfo_value=10000;v.set_control_phase(314).unwrap();v.note_on(60,100);
            let before=(v.fade.ramp,v.fade.gain,v.lfo_value);
            v.set_parameter(18,raw).unwrap();
            assert_eq!(before,(v.fade.ramp,v.fade.gain,v.lfo_value));
            v.start_note(64,100,Some((60,0)),true);
            assert_eq!(before,(v.fade.ramp,v.fade.gain,v.lfo_value));
            assert_eq!(v.fade.increment,increment);
            let controls=(v.params,v.controls,v.fade.ramp,v.fade.gain,v.lfo_value);
            assert!(v.apply_patch(&[18,41],&[128,80]).is_err());
            assert!(v.apply_patch(&[76,41],&[255,80]).is_err());
            assert!(v.apply_patch(&[286,41],&[255,80]).is_err());
            assert_eq!(controls,(v.params,v.controls,v.fade.ramp,v.fade.gain,v.lfo_value));
            v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((12000,false,0)));
            assert_eq!(v.fade.ramp,34+increment);
        }
    }
}

#[cfg(test)]
mod sparse_tail_fade_tests {
    use super::*;
    #[test]
    fn released_free_owner_fades_to_unity_without_restarting_on_rate_edits() {
        for (raw, ticks) in [(119,1152),(127,2688)] {
            let mut v=Jp8000Voice::with_effects(false);
            v.apply_patch(&[18,25,44,52,71,72],&[raw,96,80,80,1,1]).unwrap();
            v.raw_lfo_value=-12000;v.set_control_phase(314).unwrap();v.note_on(60,100);
            v.note_off(60);v.clear_controller_amp();v.set_controller_assigned(false);
            for _ in 1..ticks {v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((-12000,true,9000)));}
            assert_eq!((v.fade.ramp,v.fade.gain),(16128,16384));
            assert_eq!((v.lfo_value,v.lfo2_value),(-12000,9000));assert!(v.lfo_edge);
            v.set_parameter(18,0).unwrap();v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((10000,false,-9000)));
            assert_eq!((v.fade.ramp,v.fade.gain),(16128,16384));
            assert_eq!((v.lfo_value,v.lfo2_value),(10000,-9000));
        }
    }
}

#[cfg(test)]
mod full_fade_assignment_tests {
    use super::*;
    #[test]
    fn full_domain_assignments_are_bounded_and_invalid_edits_are_atomic() {
        assert!(IMPLEMENTED_PARAMETERS.contains(&76));
        assert!(IMPLEMENTED_PARAMETERS.contains(&286));
        let mut v=Jp8000Voice::with_effects(false);
        v.apply_patch(&[18,25,283],&[64,96,1]).unwrap();v.note_on(60,100);
        for id in [76,286] {for assignment in 0..=254 {
            v.set_parameter(id,assignment).unwrap();
            for morph in [-128,-65,-1,0,1,65,128] {
                v.set_morph(morph).unwrap();
                assert!(v.controls[18]<=127 && v.fade.increment>0);
                assert!(v.fade.known);
            }
        }}
        let before=(v.params,v.controls,v.fade.ramp,v.fade.gain,v.lfo_value);
        for (id,value) in [(18,128),(76,255),(286,255)] {
            assert!(v.apply_patch(&[id,41],&[value,80]).is_err());
            assert_eq!(before,(v.params,v.controls,v.fade.ramp,v.fade.gain,v.lfo_value));
        }
    }
}

#[cfg(test)]
mod full_fade_native_assignment_tests {
    use super::*;
    #[test]
    fn fade_assignment_combines_signed_products_before_single_floor() {
        let mut v=Jp8000Voice::with_effects(false);
        v.apply_patch(&[18,76,286,283,25,71,72],&[64,128,128,1,96,1,1]).unwrap();
        v.set_morph(100).unwrap();v.note_on(60,100); // velocity code54
        assert_eq!(v.controls[18],65);
        let held=(v.fade.ramp,v.fade.gain,v.lfo_value);
        v.set_morph(-100).unwrap();v.note_on(64,64); // velocity code−26
        assert_eq!(v.controls[18],63); // floor((-26−100)/128), not two floors
        assert_eq!(held,(v.fade.ramp,v.fade.gain,v.lfo_value));
        v.note_off(64);v.clear_controller_amp();v.set_controller_assigned(false);
        v.set_morph(100).unwrap();assert_eq!(v.controls[18],64);
        let inc=v.fade.increment;let before=v.fade.ramp;
        v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((12000,false,-9000)));
        assert_eq!(v.fade.ramp,before+inc);assert_eq!(v.lfo2_value,-9000);
        assert_eq!(v.lfo_value,(12000*i32::from(v.fade.gain))>>14);
    }
    #[test]
    fn former_gap_controls_can_activate_and_retarget_without_unknown_history() {
        let mut v=Jp8000Voice::with_effects(false);
        v.apply_patch(&[18,76,283,71,72],&[0,0,1,1,1]).unwrap();
        v.set_morph(-128).unwrap();v.note_on(60,100);
        assert_eq!((v.controls[18],v.fade.increment,v.fade.ramp),(127,6,6));
        v.apply_patch(&[25,44,52],&[96,80,80]).unwrap();
        let held=(v.fade.ramp,v.fade.gain,v.lfo_value);
        v.set_morph(-121).unwrap();assert_eq!((v.controls[18],v.fade.increment),(120,12));
        v.note_on(64,32);assert_eq!(held,(v.fade.ramp,v.fade.gain,v.lfo_value));
        v.note_off(64);v.clear_controller_amp();v.set_controller_assigned(false);
        v.set_morph(-128).unwrap();assert_eq!(v.fade.increment,6);
        for _ in 0..2700 {v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((12000,false,-9000)));}
        assert_eq!((v.fade.ramp,v.fade.gain),(16128,16384));
        v.set_morph(0).unwrap();v.amp.until_tick=0;v.next_voice_frame_with_lfo(Some((12000,false,-9000)));
        assert_eq!((v.fade.ramp,v.fade.gain),(16128,16384));
    }
}

#[cfg(test)]
mod program_history_tests {
    use super::*;
    fn noise_history() -> Jp8000Voice {
        let mut v = Jp8000Voice::new();
        v.set_parameter(30, 2).unwrap();
        for _ in 0..2048 {
            v.next_sample(RenderTap::Oscillator);
        }
        v
    }
    #[test]
    fn noise_to_pulse_loader_rebases_the_voice_phase_mirror() {
        let mut v = noise_history();
        let mut expected = v.other_oscillator.clone();
        let phase = expected.inherit_noise_pulse_state() as i32;
        assert_ne!(phase, v.saw_phase);
        v.set_parameter(30, 4).unwrap();
        assert_eq!(v.saw_phase, phase);
        assert_eq!(v.other_oscillator.phase(), phase as i64);
        v.cross = 0;
        v.cross_target = 0;
        v.previous_cross_tap = 0;
        let f = v.frequency_word;
        v.next_sample(RenderTap::Oscillator);
        assert_eq!(v.saw_phase, wrap24(phase.wrapping_add(f)));
    }
    #[test]
    fn intervening_saw_program_does_not_replay_stale_noise() {
        let mut v = noise_history();
        v.set_parameter(30, 5).unwrap();
        for _ in 0..64 {
            v.next_sample(RenderTap::Oscillator);
        }
        let phase = v.saw_phase;
        v.set_parameter(30, 4).unwrap();
        assert_eq!(v.saw_phase, phase);
        assert_eq!(v.osc1_program_wave, 4);
    }
    #[test]
    fn repeated_pulse_and_reset_do_not_replay_noise() {
        let mut v = noise_history();
        v.set_parameter(30, 4).unwrap();
        for _ in 0..32 {
            v.next_sample(RenderTap::Oscillator);
        }
        let phase = v.saw_phase;
        v.set_parameter(30, 4).unwrap();
        assert_eq!(v.saw_phase, phase);
        v.reset();
        assert_eq!(v.saw_phase, 0);
        assert_eq!(v.osc1_program_wave, 4);
    }
}

#[cfg(test)]
mod supersaw_program_history_tests {
    use super::*;

    fn supersaw_history(held: bool) -> Jp8000Voice {
        let mut v = Jp8000Voice::new_pre_output();
        v.set_parameter(30, 0).unwrap();
        v.set_parameter(31, 64).unwrap();
        if held { v.note_on(60, 100); }
        for _ in 0..2048 { v.next_voice_frame(); }
        assert_ne!(v.supersaw_phases[1], v.supersaw_phases[0]);
        assert_ne!(v.supersaw_phases[2], 0);
        v
    }

    #[test]
    fn supersaw_to_pulse_rebases_phase_mirror_and_preserves_generated_width() {
        for held in [false, true] {
            let mut v = supersaw_history(held);
            let side_phase = v.supersaw_phases[1];
            let next_side_phase = v.supersaw_phases[2];
            let mut expected = v.other_oscillator.clone();
            expected.inherit_supersaw_pulse_state(side_phase, next_side_phase);
            expected.load_generic_program(4);
            if held { expected.set_shape_targets(64, 0); }
            v.set_parameter(30, 4).unwrap();
            assert_eq!(v.saw_phase, side_phase);
            assert_eq!(v.other_oscillator.phase(), i64::from(side_phase));
            assert_eq!(v.osc1_generic_program, !held);
            // Compare the entire generated continuation, not only the handoff.
            let mut actual = v.other_oscillator.clone();
            for _ in 0..4096 { assert_eq!(actual.next_sample(), expected.next_sample()); }
            v.cross = 0;
            v.cross_target = 0;
            v.previous_cross_tap = 0;
            let f = v.frequency_word;
            v.next_voice_frame();
            assert_eq!(v.saw_phase, wrap24(side_phase.wrapping_add(f)));
        }
    }

    #[test]
    fn intervening_waveform_does_not_replay_stale_supersaw_cells() {
        for wave in [1, 2, 3, 5, 6] {
            let mut v = supersaw_history(false);
            v.set_parameter(30, wave).unwrap();
            for _ in 0..65 { v.next_voice_frame(); }
            let phase = if wave == 2 {
                let mut o = v.other_oscillator.clone();
                o.inherit_noise_pulse_state() as i32
            } else { v.saw_phase };
            assert_ne!(phase, v.supersaw_phases[1]);
            v.set_parameter(30, 4).unwrap();
            assert_eq!(v.saw_phase, phase);
        }
    }

    #[test]
    fn repeated_pulse_and_reset_do_not_replay_supersaw_history() {
        let mut v = supersaw_history(false);
        v.set_parameter(30, 4).unwrap();
        for _ in 0..65 { v.next_voice_frame(); }
        let phase = v.saw_phase;
        v.set_parameter(30, 4).unwrap();
        assert_eq!(v.saw_phase, phase);
        v.reset();
        assert_eq!(v.saw_phase, 0);
        assert_eq!(v.supersaw_phases, [0; 7]);
        assert_eq!(v.osc1_program_wave, 4);
    }
}

#[cfg(test)]
mod saw_pulse_shared_history_tests {
 use super::*;
 fn history(held:bool,frames:usize)->Jp8000Voice {
  let mut v=Jp8000Voice::new_pre_output();
  v.apply_patch(&[30,31,32],&[0,64,0]).unwrap();
  if held {v.note_on(60,100);}
  for _ in 0..frames {v.next_voice_frame();}
  v
 }
 fn isolate_cross_and_tick(v:&mut Jp8000Voice,fast:bool) {
  v.cross=0;v.cross_target=0;v.previous_cross_tap=0;v.amp.until_tick=100;
  v.coefficient_fast=if fast{16}else{0};
 }
 #[test]
 fn generated_super_saw_cells_continue_in_saw_and_pulse_for_held_and_free() {
  let mut saw_negative=false;
  for held in [false,true] {for frames in [127,129,257,2048] {for fast in [false,true] {
   let mut v=history(held,frames);
   let phase=v.supersaw_phases[1];let width=i64::from(v.supersaw_phases[2]);
   saw_negative|=width<0;
   v.set_parameter(30,5).unwrap();
   assert_eq!((v.saw_phase,v.saw_shape),(phase,width));
   assert_eq!(v.saw_shape_target,if held{64*65536}else{4096});
   assert_eq!(v.osc1_generic_program,!held);
   isolate_cross_and_tick(&mut v,fast);
   let f=v.frequency_word;let next=wrap24(phase.wrapping_add(f));let delta=sat24(v.saw_shape_target-width);
   let next_width=width+if fast||!held{(delta*112)>>7}else{delta>>11};
   v.next_voice_frame();
   assert_eq!((v.saw_phase,v.saw_shape),(next,next_width));
   assert_eq!(v.previous_oscillator_1,saw_sample(i64::from(next),i64::from(f),next_width));
   // A real repeated program load preserves generated state while reinstalling
   // the appropriate target. It must not replay the older Super Saw side cells.
   v.set_parameter(30,5).unwrap();assert_eq!((v.saw_phase,v.saw_shape),(next,next_width));
   v.set_parameter(30,4).unwrap();assert_eq!(v.other_oscillator.phase(),i64::from(next));
   assert_eq!(v.other_oscillator.width_state(),next_width);
   isolate_cross_and_tick(&mut v,fast);
   v.next_voice_frame();
   let p=wrap24(next.wrapping_add(f));
   assert_eq!(v.saw_phase,p);
   assert_eq!(v.previous_oscillator_1,oscillators::pulse(i64::from(p),next_width,i64::from(f)));
  }}}
  assert!(saw_negative,"fixture must exercise negative generated widths");
 }
 #[test]
 fn pulse_to_saw_carries_generated_width_and_reset_drops_old_history() {
  for held in [false,true] {for fast in [false,true] {
   let mut v=history(held,257);v.set_parameter(30,4).unwrap();
   for _ in 0..67 {v.next_voice_frame();}
   let phase=v.other_oscillator.phase()as i32;let width=v.other_oscillator.width_state();
   v.set_parameter(30,4).unwrap();assert_eq!(v.other_oscillator.width_state(),width);
   v.set_parameter(30,5).unwrap();assert_eq!((v.saw_phase,v.saw_shape),(phase,width));
   isolate_cross_and_tick(&mut v,fast);
   let f=v.frequency_word;let p=wrap24(phase.wrapping_add(f));let delta=sat24(v.saw_shape_target-width);
   let w=width+if fast||!held{(delta*112)>>7}else{delta>>11};
   v.next_voice_frame();assert_eq!((v.saw_phase,v.saw_shape),(p,w));
   assert_eq!(v.previous_oscillator_1,saw_sample(i64::from(p),i64::from(f),w));
   v.reset();assert_eq!((v.saw_phase,v.saw_shape),(0,4096));
   assert_eq!(v.supersaw_phases,[0;7]);assert!(!v.controller_assigned);
   v.set_parameter(30,4).unwrap();assert_eq!(v.other_oscillator.width_state(),4096);
   assert_eq!(v.saw_phase,0);
  }}
 }
 #[test]
 fn previously_owned_free_slots_keep_history_but_load_generic_targets() {
  let mut v=history(true,257);
  v.note_off(60);v.clear_controller_amp();v.set_controller_assigned(false);
  assert!(v.allocated);assert!(!v.controller_assigned);
  let p=v.supersaw_phases[1];let w=i64::from(v.supersaw_phases[2]);
  v.set_parameter(30,5).unwrap();assert_eq!((v.saw_phase,v.saw_shape),(p,w));
  assert_eq!(v.saw_shape_target,4096);assert!(v.osc1_generic_program);
  isolate_cross_and_tick(&mut v,false);
  let next_p=wrap24(p.wrapping_add(v.frequency_word));let next_w=w+((sat24(4096-w)*112)>>7);
  v.next_voice_frame();assert_eq!((v.saw_phase,v.saw_shape),(next_p,next_w));
  v.set_parameter(30,4).unwrap();assert_eq!(v.other_oscillator.width_state(),next_w);
  assert_eq!(v.saw_phase,next_p);assert!(v.osc1_generic_program);
  v.set_parameter(30,5).unwrap();assert_eq!((v.saw_phase,v.saw_shape),(next_p,next_w));
 }

}

#[cfg(test)]
mod incoming_noise_history_tests {
    use super::*;

    fn history(wave: u16, held: bool, frames: usize) -> Jp8000Voice {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[30,31,32], &[wave,64,0]).unwrap();
        if held { v.note_on(60,100); }
        for _ in 0..frames { v.next_voice_frame(); }
        v
    }
    fn noise(v: &Jp8000Voice) -> ([i64;2],[i64;4],[i64;2]) {
        v.other_oscillator.noise_history_for_test()
    }

    #[test]
    fn saw_startup_and_nonzero_held_free_histories_become_noise_excitation() {
        let mut cold = Jp8000Voice::new_pre_output();
        let cold_cells = [i64::from(cold.saw_phase),cold.saw_shape];
        cold.set_parameter(30,2).unwrap();
        assert_eq!(noise(&cold).0,cold_cells);
        for held in [false,true] { for wave in [0,1,3,4,5,6] {
            let mut v = history(wave,held,2048);
            let cells = match wave {
                0 => [i64::from(v.supersaw_phases[1]),i64::from(v.supersaw_phases[2])],
                5 => [i64::from(v.saw_phase),v.saw_shape],
                _ => v.other_oscillator.noise_entry_cells(),
            };
            assert_ne!(cells,[0;2]);
            // Feedback's period must not accidentally be replaced by shape.
            if wave==3 { assert_ne!(cells[1],v.other_oscillator.width_state()); }
            v.set_parameter(30,2).unwrap();
            assert_eq!(noise(&v).0,cells);
            assert_eq!(v.osc1_generic_program,!held);
        }}
    }

    #[test]
    fn supersaw_to_noise_keeps_full_signed_excitation_and_svf_history() {
        let mut saw_negative=false; let mut saw_outside_noise_half_range=false;
        for frames in [127,129,257,2048] { for held in [false,true] {
            let mut v=history(0,held,frames);
            let pair=[i64::from(v.supersaw_phases[1]),i64::from(v.supersaw_phases[2])];
            let filter=v.supersaw_state;
            saw_negative |= pair[1]<0;
            saw_outside_noise_half_range |= !(-(1<<22)..(1<<22)).contains(&pair[1]);
            assert_ne!(filter,[0;4]);
            v.set_parameter(30,2).unwrap();
            assert_eq!(noise(&v).0,pair); assert_eq!(noise(&v).1,filter);
        }}
        assert!(saw_negative); assert!(saw_outside_noise_half_range);
    }

    #[test]
    fn indirect_saw_and_pulse_use_current_excitation_without_stale_replay() {
        for held in [false,true] {
            let mut v=history(0,held,2048);
            let stale=[i64::from(v.supersaw_phases[1]),i64::from(v.supersaw_phases[2])];
            v.set_parameter(30,5).unwrap();
            for _ in 0..67 { v.next_voice_frame(); }
            let cells=[i64::from(v.saw_phase),v.saw_shape]; assert_ne!(cells,stale);
            v.set_parameter(30,2).unwrap(); assert_eq!(noise(&v).0,cells);
            for _ in 0..257 { v.next_voice_frame(); }
            let old=noise(&v).0;
            v.set_parameter(30,4).unwrap();
            for _ in 0..67 { v.next_voice_frame(); }
            let cells=[v.other_oscillator.phase(),v.other_oscillator.width_state()];
            assert_ne!(cells,old);
            v.set_parameter(30,2).unwrap(); assert_eq!(noise(&v).0,cells);
            // No assertion that inactive SVF/C/R relative cells are constant.
        }
    }

    #[test]
    fn noise_repeated_selector_note_events_and_reset_have_distinct_lifetimes() {
        let mut v=history(2,true,2048); let old=noise(&v);
        v.set_parameter(30,2).unwrap(); assert_eq!(noise(&v),old);
        v.note_off(60); assert_eq!(noise(&v),old);
        v.clear_controller_amp(); v.set_controller_assigned(false);
        v.set_parameter(30,2).unwrap(); assert_eq!(noise(&v),old); assert!(v.osc1_generic_program);
        v.note_on(67,32); assert_eq!(noise(&v),old);
        v.reset(); assert_eq!(noise(&v),([0;2],[0;4],[0;2]));
    }
}

// Sparse, rotating logical register history. The fixed array owns only the
// source-derived causal interval, not a general DSP memory emulator.
#[derive(Clone)]
struct Osc1TailHistory<const N: usize> {
    cells: [i64; N], pos: usize, first: usize,
}
impl<const N: usize> Osc1TailHistory<N> {
    fn new(first: usize) -> Self { Self { cells: [0; N], pos: 0, first } }
    fn index(&self, offset: usize) -> usize {
        debug_assert!(offset >= self.first && offset < self.first + N);
        let i = self.pos + offset - self.first;
        if i >= N { i - N } else { i }
    }
    fn read(&self, offset: usize) -> i64 { self.cells[self.index(offset)] }
    fn write(&mut self, offset: usize, value: i64) { let i = self.index(offset); self.cells[i] = value; }
    fn advance(&mut self, inlet: i64) {
        self.pos = if self.pos == 0 { N - 1 } else { self.pos - 1 };
        self.cells[self.pos] = inlet;
    }
    fn filter(&self, local: usize) -> [i64; 4] {
        let d = local * 16;
        [self.read(0x93+d), self.read(0x91+d), self.read(0x97+d), self.read(0x95+d)]
    }
    fn publish(&mut self, local: usize, svf: [i64; 4], hp: [i64; 2], cr: Option<[i64; 2]>) {
        let d = local * 16;
        for (offset, value) in [(0x92,svf[0]),(0x90,svf[1]),(0x96,svf[2]),
            (0x94,svf[3]),(0x98,hp[0]),(0x99,hp[1])] { self.write(offset+d, value); }
        if let Some([c,r]) = cr { self.write(0x9a+d,c); self.write(0x9c+d,r); }
    }
}
struct SharedOscillatorHistory {
    three_voice: [Osc1TailHistory<79>; 2],
    two_voice: Osc1TailHistory<59>,
    voice2_dc_route: [i64; 2],
}
impl SharedOscillatorHistory {
    fn new() -> Self { Self {
        three_voice: std::array::from_fn(|_| Osc1TailHistory::new(0x6f)),
        two_voice: Osc1TailHistory::new(0x73), voice2_dc_route: [0; 2],
    } }
    fn read_filter(&self, physical: usize) -> [i64; 4] {
        debug_assert!(physical < 8);
        if physical < 6 {
            self.three_voice[physical / 3].filter(physical % 3)
        } else {
            self.two_voice.filter(physical - 6)
        }
    }
    fn read(&self, physical: usize) -> ([i64; 4], [i64; 2]) {
        debug_assert!(physical < 8);
        let local = if physical < 6 { physical % 3 } else { physical - 6 };
        let d = local * 16;
        if physical < 6 {
            let h = &self.three_voice[physical / 3];
            (h.filter(local), [h.read(0x9b+d), h.read(0x9d+d)])
        } else {
            (self.two_voice.filter(local), [self.two_voice.read(0x9b+d), self.two_voice.read(0x9d+d)])
        }
    }
    fn publish(&mut self, physical: usize, writes: ([i64; 4], [i64; 2], Option<[i64; 2]>)) {
        let (svf,hp,cr) = writes;
        if physical < 6 { self.three_voice[physical/3].publish(physical%3,svf,hp,cr); }
        else { self.two_voice.publish(physical-6,svf,hp,cr); }
    }
    fn advance(&mut self, balance: [i64; 2], voice2_dc_mixed: i64) {
        self.three_voice[0].advance(balance[0]);
        self.three_voice[1].advance(balance[1]);
        self.two_voice.advance(self.voice2_dc_route[1]);
        self.voice2_dc_route = [voice2_dc_mixed, self.voice2_dc_route[0]];
    }
}

// Authored regressions from the native periodic amp-Idle gate.
#[cfg(test)]
mod periodic_amp_idle_boundary_tests {
    use super::*;

    fn voice() -> Jp8000Voice {
        let mut v = Jp8000Voice::new();
        for (id, value) in [(30,5),(18,64),(54,0),(55,0),(56,127),
                            (47,64),(48,64),(49,127),(46,96),(28,64),(29,64)] {
            v.set_parameter(id,value).unwrap();
        }
        v.note_on(60,100);
        v
    }
    fn tick(v: &mut Jp8000Voice) {
        v.amp.until_tick = 0;
        v.next_voice_frame();
    }
    fn releasing(v: &mut Jp8000Voice, amp_level: i32, amp_rate: i32) {
        v.amp.stage=Stage::Release; v.amp.level=amp_level; v.amp.rates[2]=amp_rate;
        v.filter_envelope.stage=Stage::Release; v.filter_envelope.level=12345;
        v.filter_envelope.rates[2]=256;
        v.pitch_envelope.stage=Stage::Decay; v.pitch_envelope.level=7777;
        v.pitch_envelope.rates[1]=256;
    }
    #[test]
    fn completion_tick_freezes_filter_pitch_targets_but_advances_fade_and_glide() {
        let mut v=voice(); releasing(&mut v,1,8192);
        v.filter_scheduler.retarget();
        v.glide.start(1200); v.glide_enabled=true; v.glide_rate=56;
        let old=(v.filter.cutoff_target,v.filter.damping_target,v.filter.cutoff_rate,
                 v.filter_scheduler,v.frequency_word,v.cross_target,v.saw_shape_target);
        let fade=v.fade.ramp; let remaining=v.glide.remaining;
        tick(&mut v);
        assert_eq!((v.amp.stage,v.amp.level),(Stage::Idle,0));
        assert_eq!((v.filter_envelope.stage,v.filter_envelope.level),(Stage::Release,12345));
        assert_eq!((v.pitch_envelope.stage,v.pitch_envelope.level),(Stage::Decay,7777));
        assert_eq!((v.filter.cutoff_target,v.filter.damping_target,v.filter.cutoff_rate,
                    v.filter_scheduler,v.frequency_word,v.cross_target,v.saw_shape_target),old);
        assert!(v.fade.ramp>fade); assert!(v.glide.remaining<remaining);
        assert_eq!(v.amp.target,0);
        tick(&mut v);
        assert_eq!((v.filter_envelope.level,v.pitch_envelope.level),(12345,7777));
        assert_eq!(v.filter_scheduler,old.3);
    }
    #[test]
    fn nonidle_release_tick_still_advances_both_controller_envelopes() {
        let mut v=voice(); releasing(&mut v,1000,256); tick(&mut v);
        assert_eq!((v.amp.stage,v.amp.level),(Stage::Release,969));
        assert_eq!(v.filter_envelope.level,11960);
        assert_eq!(v.pitch_envelope.level,7534);
    }
    #[test]
    fn silent_sustain_is_not_an_idle_stage() {
        let mut v=voice(); releasing(&mut v,1000,256);
        v.amp.stage=Stage::Sustain; v.amp.sustain=0; v.amp.level=0;
        tick(&mut v);
        assert_eq!((v.amp.stage,v.amp.level),(Stage::Sustain,0));
        assert_eq!(v.filter_envelope.level,11960);
        assert_eq!(v.pitch_envelope.level,7534);
    }
    #[test]
    fn idle_parameter_cache_edit_is_not_suppressed_by_periodic_gate() {
        let mut v=voice(); releasing(&mut v,1,8192); tick(&mut v);
        v.set_parameter(50,96).unwrap();
        assert_eq!(v.filter_envelope.rates[2],72);
        assert_eq!(v.filter_envelope.level,12345);
        tick(&mut v);
        assert_eq!(v.filter_envelope.level,12345);
    }
    #[test]
    fn ordinary_retrigger_restarts_controller_levels_after_idle_freeze() {
        let mut v=voice(); releasing(&mut v,1,8192); tick(&mut v);
        assert_eq!(v.filter_envelope.level,12345);
        v.note_on(62,100);
        assert_eq!((v.filter_envelope.stage,v.filter_envelope.level),(Stage::Attack,640));
        assert_eq!((v.pitch_envelope.stage,v.pitch_envelope.level),(Stage::Attack,640));
        assert_ne!(v.amp.stage,Stage::Idle);
    }
}

#[cfg(test)]
mod ordinary_release_velocity_tests {
    use super::*;
    fn voice() -> Jp8000Voice {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[30, 283, 50, 57, 334, 348], &[5, 1, 64, 64, 254, 254]).unwrap();
        v
    }
    #[test]
    fn explicit_release_preserves_held_code_and_defers_dsp_target_commit() {
        let mut v = voice(); v.note_on(60, 100);
        for _ in 0..2000 { v.next_sample(RenderTap::Output); }
        let targets = (v.amp.target, v.amp.committed_rate, v.filter.cutoff_target,
            v.filter.damping_target, v.filter.cutoff_rate);
        let held = v.velocity_code;
        v.note_off_with_velocity(60, 64);
        assert_eq!((v.release_velocity_raw, v.release_velocity_code), (64, -26));
        assert_eq!(v.velocity_code, held);
        assert_eq!((v.controls[50], v.controls[57]), (38, 38));
        assert_eq!(v.amp.rates[2], envelope_rate(38));
        assert_eq!(v.filter_envelope.rates[2], envelope_rate(38));
        assert_eq!(v.amp.stage, Stage::Release);
        assert_eq!(v.filter_envelope.stage, Stage::Release);
        assert_eq!(targets, (v.amp.target, v.amp.committed_rate, v.filter.cutoff_target,
            v.filter.damping_target, v.filter.cutoff_rate));
    }
    #[test]
    fn velocity_less_api_retains_code_and_invalid_events_do_not_mutate_it() {
        let mut v = voice(); v.note_on(60, 100);
        let expected = (v.release_velocity_raw, v.release_velocity_code, v.amp.rates[2]);
        v.note_off_with_velocity(61, 0); v.note_off_with_velocity(60, 128);
        assert!(v.gate);
        v.note_off(60);
        assert_eq!(expected, (v.release_velocity_raw, v.release_velocity_code, v.amp.rates[2]));
        assert!(!v.gate);
    }
    #[test]
    fn single_voice_note_on_zero_is_direct_off64_but_explicit_off_zero_stays_zero() {
        let mut a = voice(); let mut b = voice();
        a.note_on(60, 100); b.note_on(60, 100);
        a.note_on(60, 0); b.note_off_with_velocity(60, 0);
        assert_eq!((a.release_velocity_raw, a.release_velocity_code), (64, -26));
        assert_eq!((b.release_velocity_raw, b.release_velocity_code), (0, -128));
    }
    #[test]
    fn release_getters_use_retained_release_code_on_live_assignment_and_morph_edits() {
        let mut v = voice(); v.note_on(60, 100); v.note_off_with_velocity(60, 0);
        v.apply_patch(&[334, 348, 124, 266], &[0, 0, 254, 254]).unwrap();
        v.set_morph(-64).unwrap();
        // (−128*−127 + −64*127)>>7 =63, so both releases clamp to127.
        assert_eq!((v.controls[50], v.controls[57]), (127, 127));
        assert_eq!(v.velocity_code, 54); assert_eq!(v.release_velocity_code, -128);
        assert_eq!(v.amp.rates[2], envelope_rate(127));
        assert_eq!(v.filter_envelope.rates[2], envelope_rate(127));
    }
    #[test]
    fn allocation_legato_and_controller_reset_have_distinct_release_cache_lifecycles() {
        let mut v = voice();
        assert_eq!((v.release_velocity_raw, v.release_velocity_code), (255, 0));
        v.apply_patch(&[71, 72], &[1, 1]).unwrap();
        v.note_on(60, 40); v.note_on(67, 100);
        assert_eq!((v.velocity_code, v.release_velocity_code, v.release_velocity_raw), (54, 54, 100));
        v.note_off_with_velocity(67, 0); v.reset();
        assert_eq!((v.velocity_code, v.release_velocity_code, v.release_velocity_raw), (0, 0, 255));
        assert_eq!(v.parameter(334), Some(254));
        v.set_parameter(283, 0).unwrap(); v.note_on(60, 127);
        assert_eq!((v.velocity_code, v.release_velocity_code, v.release_velocity_raw), (0, 0, 80));
    }
    #[test]
    fn neutral_release_assignments_make_different_release_velocities_pcm_identical() {
        let mut a = voice(); let mut b = voice();
        for v in [&mut a, &mut b] { v.apply_patch(&[334, 348], &[127, 127]).unwrap(); v.note_on(60, 100); }
        for _ in 0..3000 { assert_eq!(a.next_sample(RenderTap::Output), b.next_sample(RenderTap::Output)); }
        a.note_off_with_velocity(60, 0); b.note_off_with_velocity(60, 127);
        for _ in 0..8192 { assert_eq!(a.next_sample(RenderTap::Output), b.next_sample(RenderTap::Output)); }
    }
}

#[cfg(test)]
mod explicit_lfo_parameter_tests {
    use super::*;

    // H8 0x7172: both fastest free phases reset, held values/edge do not.
    #[test]
    fn repeated_fast_triangle_event_refreshes_both_lfos() {
        for (id, value) in [(16, 0), (17, 127), (19, 127)] {
            for atomic in [false, true] {
                let mut v = Jp8000Voice::new();
                v.apply_patch(&[16, 17, 19], &[0, 127, 127]).unwrap();
                assert_eq!(v.lfo.tick(), -16384);
                assert_eq!(v.lfo2.tick(), -16384);
                let held = (v.lfo.value(), v.lfo.edge(), v.lfo2.value(), v.lfo2.edge());
                if atomic { v.apply_patch(&[id], &[value]).unwrap(); }
                else { v.set_parameter(id, value).unwrap(); }
                assert_eq!((v.lfo.value(), v.lfo.edge(), v.lfo2.value(), v.lfo2.edge()), held);
                assert_eq!(v.lfo.tick(), -16384, "event {id}, atomic {atomic}");
                assert_eq!(v.lfo2.tick(), -16384, "event {id}, atomic {atomic}");
            }
        }
    }

    #[test]
    fn repeated_fast_square_event_preserves_held_edge_until_tick() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[16, 17, 19], &[2, 127, 127]).unwrap();
        assert_eq!(v.lfo.tick(), -16384);
        assert!(v.lfo.edge());
        assert_eq!(v.lfo2.tick(), -16384);
        v.set_parameter(16, 2).unwrap();
        assert_eq!(v.lfo.value(), -16384);
        assert!(v.lfo.edge());
        assert_eq!(v.lfo2.value(), -16384);
        assert_eq!(v.lfo.tick(), -16384);
        assert!(v.lfo.edge());
        assert_eq!(v.lfo2.tick(), -16384);
    }

    #[test]
    fn ordinary_rate_events_preserve_phase_progress() {
        for (id, value) in [(16, 0), (17, 64), (19, 41)] {
            let mut v = Jp8000Voice::new();
            v.apply_patch(&[16, 17, 19], &[0, 64, 41]).unwrap();
            v.lfo.tick(); v.lfo2.tick();
            let (mut expected1, mut expected2) = (v.lfo, v.lfo2);
            v.set_parameter(id, value).unwrap();
            assert_eq!(v.lfo.value(), expected1.value());
            assert_eq!(v.lfo2.value(), expected2.value());
            assert_eq!(v.lfo.tick(), expected1.tick());
            assert_eq!(v.lfo2.tick(), expected2.tick());
        }
    }

    #[test]
    fn unrelated_broad_refresh_does_not_restart_fast_phase() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[16, 17, 19], &[0, 127, 127]).unwrap();
        assert_eq!(v.lfo.tick(), -16384);
        assert_eq!(v.lfo2.tick(), -16384);
        v.set_parameter(41, 127).unwrap();
        assert_eq!(v.lfo.tick(), 16384);
        assert_eq!(v.lfo2.tick(), 16384);
    }

    #[test]
    fn rejected_atomic_event_does_not_restart_phase() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[16, 17, 19], &[0, 127, 127]).unwrap();
        v.lfo.tick(); v.lfo2.tick();
        assert!(v.apply_patch(&[17, 19], &[127, 128]).is_err());
        assert_eq!(v.parameter(19), Some(127));
        assert_eq!(v.lfo.tick(), 16384);
        assert_eq!(v.lfo2.tick(), 16384);
    }

    #[test]
    fn synced_primary_preserves_phase_while_secondary_restarts() {
        let mut v = Jp8000Voice::new();
        v.apply_patch(&[16, 17, 19, 1005], &[0, 127, 127, 1]).unwrap();
        v.lfo.tick();
        assert_eq!(v.lfo2.tick(), -16384);
        let mut expected1 = v.lfo;
        v.set_parameter(19, 127).unwrap();
        assert_eq!(v.lfo.value(), expected1.value());
        assert_eq!(v.lfo.tick(), expected1.tick());
        assert_eq!(v.lfo2.tick(), -16384);
    }
}


#[cfg(test)]
mod saw_supersaw_transfer_tests {
    use super::*;

    fn configure(v: &mut Jp8000Voice, wave: u16) {
        v.set_parameter(30, wave).unwrap();
        v.frequency_word = 24883;
        v.coefficient_fast = 0;
        v.osc1_generic_program = false;
        v.cross = 0;
        v.cross_target = 0;
        v.previous_cross_tap = 0;
        v.amp.until_tick = 881;
        if wave == 0 {
            v.supersaw_detune_target = supersaw_detune_word(64);
            v.supersaw_side_target = 102400;
            v.update_supersaw_coefficients();
        } else if wave == 5 {
            v.saw_shape_target = 64 * 65536;
        }
    }
    fn zero_saw() -> Jp8000Voice {
        let mut v = Jp8000Voice::new_pre_output();
        v.nominal_master_phase = 0;
        v.saw_phase = 0;
        v.saw_shape = 0;
        configure(&mut v, 5);
        v
    }
    // Independent sparse writer/rotation model of the source boundary, not
    // captured state. Physical current operands are even-indexed after sync.
    fn saw_clock(mut cells: [i64; 23]) -> [i64; 23] {
        let f = 24883;
        let phase = wrap24((cells[8] + f) as i32) as i64;
        let master = wrap24((cells[6] + f) as i32) as i64;
        let shape = cells[10] + (sat24(64 * 65536 - cells[10]) >> 11);
        let a1 = sat24(-4 * f);
        let a2 = sat24(3 * a1);
        cells[5] = master;
        cells[7] = phase;
        cells[9] = shape;
        cells[13] = sat24(Q23 + ((a1 * 40) >> 7) + ((a2 * 88) >> 7));
        cells[15] = sat24(sat24(((a2 * 80) >> 5) + 3 * Q23 / 32) + Q23);
        cells[17] = sat24(Q23 - if phase >= 0 { phase } else { !phase });
        cells[19] = f;
        let old = cells;
        cells[1..].copy_from_slice(&old[..22]);
        cells
    }
    fn assert_entry(v: &Jp8000Voice, cells: &[i64; 23]) {
        assert_eq!(v.supersaw_phases, [6, 8, 10, 12, 14, 16, 18].map(|i| cells[i] as i32));
        assert_eq!(v.supersaw_detune_state, cells[20] as i32);
        assert_eq!(v.supersaw_side_state, cells[22] as i32);
    }

    #[test]
    fn saw_generated_cells_transfer_without_reference_state() {
        for count in [3, 17, 2048] {
            let mut v = zero_saw();
            let mut cells = [0; 23];
            for _ in 0..count {
                v.amp.until_tick = 881;
                v.next_voice_frame();
                cells = saw_clock(cells);
            }
            configure(&mut v, 0);
            assert_entry(&v, &cells);
        }
    }

    #[test]
    fn ss_returns_preserve_unwritten_histories_at_zero_one_two_three_frames() {
        for saw_frames in 0..=3 {
            let mut v = zero_saw();
            for _ in 0..17 { v.next_voice_frame(); }
            configure(&mut v, 0);
            let mut old_phase2 = 0;
            let mut old_detune = 0;
            for _ in 0..37 {
                old_phase2 = v.supersaw_phases[2];
                old_detune = v.supersaw_detune_state;
                v.next_voice_frame();
            }
            let mut cells = [0i64; 23];
            for (address, phase) in [6, 8, 10, 12, 14, 16, 18].into_iter().zip(v.supersaw_phases) {
                cells[address] = i64::from(phase);
            }
            cells[11] = i64::from(old_phase2);
            cells[20] = i64::from(v.supersaw_detune_state);
            cells[21] = i64::from(old_detune);
            cells[22] = i64::from(v.supersaw_side_state);
            configure(&mut v, 5);
            for _ in 0..saw_frames {
                v.next_voice_frame();
                cells = saw_clock(cells);
            }
            let tail = v.osc1_tail.filter(0);
            let previous_audio = (v.previous_oscillator_1, v.previous_oscillator_2, v.output.dc);
            configure(&mut v, 0);
            assert_entry(&v, &cells);
            assert_eq!(v.osc1_tail.filter(0), tail);
            assert_eq!((v.previous_oscillator_1, v.previous_oscillator_2, v.output.dc), previous_audio);
        }
    }

    #[test]
    fn untracked_program_needs_three_saw_frames_not_constructor_defaults() {
        assert_eq!(Jp8000Voice::new_pre_output().saw_ss_history_frames, 0);
        for count in 0..=3 {
            let mut v = zero_saw();
            for _ in 0..17 { v.next_voice_frame(); }
            configure(&mut v, 0);
            for _ in 0..37 { v.next_voice_frame(); }
            configure(&mut v, 2);
            assert_eq!(v.saw_ss_history_frames, 0);
            configure(&mut v, 5);
            let previous_ss = (v.supersaw_phases, v.supersaw_detune_state, v.supersaw_side_state);
            for _ in 0..count { v.next_voice_frame(); }
            assert_eq!(v.saw_ss_history_frames, count);
            configure(&mut v, 0);
            if count < 3 {
                assert_eq!((v.supersaw_phases, v.supersaw_detune_state, v.supersaw_side_state), previous_ss);
            } else {
                assert_eq!(v.supersaw_phases[0], v.nominal_master_phase);
                assert_eq!(v.supersaw_detune_state, 24883);
                assert_eq!(v.supersaw_side_state, 24883);
                assert_ne!(v.supersaw_phases, previous_ss.0);
            }
        }
    }

    #[test]
    fn equal_ss_selector_preserves_generated_state() {
        let mut v = zero_saw();
        for _ in 0..17 { v.next_voice_frame(); }
        configure(&mut v, 0);
        for _ in 0..37 { v.next_voice_frame(); }
        let state = (v.supersaw_phases, v.supersaw_detune_state, v.supersaw_side_state,
            v.saw_ss_shape_history, v.saw_ss_shaper_cells, v.saw_ss_increment_history);
        configure(&mut v, 0);
        assert_eq!((v.supersaw_phases, v.supersaw_detune_state, v.supersaw_side_state,
            v.saw_ss_shape_history, v.saw_ss_shaper_cells, v.saw_ss_increment_history), state);
    }

    #[test]
    fn physical_shaper_stores_saturate_width_and_full_gate_a() {
        for phase in [0, -1] {
            let (_, cells) = saw_sample_with_cells(phase, 0, 0);
            assert_eq!(cells, [(Q23 - 1) as i32; 3]);
        }
        let (_, cells) = saw_sample_with_cells(123, 3_000_000, 0);
        assert_eq!(cells, [0, 0, (Q23 - 123) as i32]);
    }

    #[test]
    fn reset_clears_alias_provenance_and_mutable_ss_state() {
        let mut v = zero_saw();
        for _ in 0..17 { v.next_voice_frame(); }
        configure(&mut v, 0);
        v.next_voice_frame();
        v.reset();
        assert_eq!(v.saw_ss_history_frames, 0);
        assert_eq!(v.saw_ss_shape_history, [0; 2]);
        assert_eq!(v.saw_ss_shaper_cells, [0; 3]);
        assert_eq!(v.saw_ss_increment_history, [0; 3]);
        assert_eq!(v.supersaw_detune_state, 0);
        assert_eq!(v.supersaw_side_state, 0);
    }

    #[test]
    fn diagnostic_ss_phase_edit_preserves_older_rotated_partners() {
        let mut v = zero_saw();
        for _ in 0..17 { v.next_voice_frame(); }
        configure(&mut v, 0);
        v.next_voice_frame();
        let old_phase2 = v.saw_ss_shape_history[0];
        let increments = v.saw_ss_increment_history;
        v.set_phases([0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]).unwrap();
        assert_eq!(v.saw_ss_shape_history, [old_phase2, v.supersaw_phases[3]]);
        assert_eq!(v.saw_ss_shaper_cells, [v.supersaw_phases[4], v.supersaw_phases[5], v.supersaw_phases[6]]);
        assert_eq!(v.saw_ss_increment_history, increments);
    }

    #[test]
    fn ss_generated_center_survives_short_returns_after_untracked_entry() {
        // Check the real setter before any authored kernel-target override.
        // The old configure helper deliberately resets until_tick, so it
        // cannot establish this no-clock boundary itself.
        let select_without_clock = |v: &mut Jp8000Voice, wave: u16| {
            let published = (v.previous_master_export, v.previous_master_frequency,
                v.previous_oscillator_1, v.previous_oscillator_2, v.output.dc);
            let tail = (v.osc1_tail.cells, v.osc1_tail.pos, v.osc1_tail.first);
            let clocks = (v.amp.until_tick, format!("{:?}", v.tempo_clock));
            v.set_parameter(30, wave).unwrap();
            assert_eq!((v.previous_master_export, v.previous_master_frequency,
                v.previous_oscillator_1, v.previous_oscillator_2, v.output.dc), published);
            assert_eq!((v.osc1_tail.cells, v.osc1_tail.pos, v.osc1_tail.first), tail);
            assert_eq!((v.amp.until_tick, format!("{:?}", v.tempo_clock)), clocks);
            // Restore the same authored semantic targets used by saw_clock;
            // do not advance or reset a sample/controller clock.
            v.frequency_word = 24883;
            v.coefficient_fast = 0;
            v.osc1_generic_program = false;
            v.cross = 0;
            v.cross_target = 0;
            v.previous_cross_tap = 0;
            if wave == 0 {
                v.supersaw_detune_target = supersaw_detune_word(64);
                v.supersaw_side_target = 102400;
                v.update_supersaw_coefficients();
            } else {
                assert_eq!(wave, 5);
                v.saw_shape_target = 64 * 65536;
            }
        };
        for saw_frames in 0..=3 {
            let mut v = zero_saw();
            configure(&mut v, 2);
            for _ in 0..19 { v.next_voice_frame(); }
            configure(&mut v, 0);
            let old_phase2 = v.supersaw_phases[2];
            let old_detune = v.supersaw_detune_state;
            v.next_voice_frame();
            assert_ne!(v.nominal_master_phase, v.supersaw_phases[0]);
            let mut cells = [0i64; 23];
            for (address, phase) in [6, 8, 10, 12, 14, 16, 18].into_iter().zip(v.supersaw_phases) {
                cells[address] = i64::from(phase);
            }
            cells[11] = i64::from(old_phase2);
            cells[20] = i64::from(v.supersaw_detune_state);
            cells[21] = i64::from(old_detune);
            cells[22] = i64::from(v.supersaw_side_state);
            select_without_clock(&mut v, 5);
            assert_eq!(i64::from(v.nominal_master_phase), cells[6]);
            for _ in 0..saw_frames {
                v.next_voice_frame();
                cells = saw_clock(cells);
            }
            select_without_clock(&mut v, 0);
            assert_entry(&v, &cells);
        }
    }
}

#[cfg(test)]
mod ss_zero_boundary_tests {
    use super::*;

    fn advance(v: &mut Jp8000Voice, count: usize) {
        for _ in 0..count { v.next_voice_frame(); }
    }

    #[test]
    fn cold_currents_are_zero_but_program_targets_are_not() {
        let mut v = Jp8000Voice::new_pre_output();
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (0, 0));
        assert_eq!((v.supersaw_detune_target, v.supersaw_side_target), (32768, DEFAULT_SUPERSAW_SIDE));
        v.set_parameter(30, 0).unwrap();
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (0, 0));
        assert!(v.osc1_generic_program);
    }

    #[test]
    fn natural_ss_entry_advances_the_source_smoother_without_state_injection() {
        let mut v = Jp8000Voice::new_pre_output();
        v.set_parameter(30, 0).unwrap();
        let (mut d, mut s) = (0i32, 0i32);
        for _ in 0..16 {
            d += (7 * (32768 - d)) >> 3;
            s += (7 * (DEFAULT_SUPERSAW_SIDE - s)) >> 3;
            v.next_voice_frame();
            assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (d, s));
        }
        assert_eq!((d, s), (32767, DEFAULT_SUPERSAW_SIDE - 1));
    }

    #[test]
    fn public_reset_restores_the_cold_boundary_and_retains_parameters() {
        let mut v = Jp8000Voice::new_pre_output();
        v.set_parameter(30, 0).unwrap();
        v.set_parameter(31, 101).unwrap();
        v.set_parameter(32, 126).unwrap();
        advance(&mut v, 16);
        let parameters = v.params;
        v.reset();
        assert_eq!(v.params, parameters);
        assert_eq!(v.supersaw_phases, [0; 7]);
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (0, 0));
        assert_eq!((v.supersaw_detune_target, v.supersaw_side_target), (32768, DEFAULT_SUPERSAW_SIDE));
        assert_eq!(v.saw_ss_history_frames, 0);
        advance(&mut v, 16);
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (32767, DEFAULT_SUPERSAW_SIDE - 1));
    }

    #[test]
    fn warm_saw_prefix_falsifies_a_universal_zero_on_ss_selection() {
        let mut v = Jp8000Voice::new_pre_output();
        assert_eq!(v.controls[30], 5);
        advance(&mut v, 3);
        assert_eq!(v.frequency_word, 65536);
        assert_eq!(v.saw_ss_history_frames, 3);
        v.set_parameter(30, 0).unwrap();
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (65536, 65536));
        advance(&mut v, 16);
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state), (32768, DEFAULT_SUPERSAW_SIDE - 1));
    }

    #[test]
    fn repeated_ss_selector_preserves_current_states_without_a_clock() {
        let mut v = Jp8000Voice::new_pre_output();
        v.set_parameter(30, 0).unwrap();
        advance(&mut v, 4);
        let before = (v.supersaw_detune_state, v.supersaw_side_state, v.supersaw_phases,
                      v.previous_master_export, v.previous_oscillator_2);
        v.set_parameter(30, 0).unwrap();
        assert_eq!((v.supersaw_detune_state, v.supersaw_side_state, v.supersaw_phases,
                    v.previous_master_export, v.previous_oscillator_2), before);
    }
}

#[cfg(test)]
mod selected_trigger_current_tests {
    use super::*;

    fn voice() -> Jp8000Voice {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[30, 283, 35, 47, 48, 49, 50, 54, 55, 56, 57],
            &[5, 1, 25, 64, 64, 64, 64, 64, 64, 64, 64]).unwrap();
        v.note_on(60, 127);
        for id in [46, 47, 48, 49, 50, 54, 55, 56, 57] {
            v.params[id as usize] = 64;
            let i = control::ASSIGNMENT_DESTINATIONS.iter().position(|&d| d == id).unwrap();
            v.params[284 + 2 * i] = 167;
        }
        v.recalculate();
        v.coefficient_fast = 0;
        v.oscillator_2.set_loading_modes(false, false);
        v.amp.level = 7000;
        v.amp.stage = Stage::Sustain;
        v.amp.value = 76543;
        v.amp.target = 45678;
        v.amp.until_tick = 137;
        v.filter_envelope.level = 8191;
        v.filter_envelope.stage = Stage::Sustain;
        v.filter.cutoff_target = 87654;
        v.filter.damping_target = 54321;
        v.glide.start(700);
        v.saw_phase = 765432;
        v.previous_oscillator_1 = 3210;
        v.previous_oscillator_2 = -2110;
        v
    }
    fn envelope(e: &Envelope) -> (Stage, i32, i64, i64, i64, [i32; 3], i32, i32, i32, i32, u16) {
        (e.stage, e.level, e.value, e.target, e.committed_rate, e.rates, e.sustain,
            e.amplitude, e.smoothing, e.modulation_smoothing, e.until_tick)
    }
    fn histories(v: &Jp8000Voice) -> [i64; 27] {
        [i64::from(v.note), v.gate as i64, v.allocated as i64, v.controller_assigned as i64,
            i64::from(v.saw_phase), i64::from(v.glide.initial_cents), i64::from(v.glide.offset_cents),
            i64::from(v.glide.remaining), i64::from(v.frequency_word), v.previous_oscillator_1,
            v.previous_oscillator_2, v.previous_master_export, v.previous_master_frequency,
            v.last_dc_mixed, v.balance, v.balance_target, v.cross, v.cross_target,
            v.filter.cutoff_target, v.filter.damping_target, v.filter.cutoff_rate,
            i64::from(v.coefficient_fast), i64::from(v.release_velocity_raw), i64::from(v.velocity_code),
            i64::from(v.amp.until_tick), i64::from(v.glide_rate), v.glide_enabled as i64]
    }

    #[test]
    fn trigger_rate_cache_refresh_does_not_install_or_change_osc2_history() {
        for wide in [false, true] {
            for loading in [false, true] {
                let mut v = voice();
                v.oscillator_2.set_ratio_wide(wide);
                v.oscillator_2.set_loading_modes(loading, false);
                let installed = if loading { 0x7000 } else if wide { 0x40 } else { 0x80 };
                for range in [0, 25, 50, 50, 25] {
                    let mut peer = v.oscillator_2.clone();
                    v.params[35] = range;
                    v.refresh_controls();
                    assert_eq!(v.osc2_ratio_rate_cache, if range == 25 { 0x80 } else { 0x40 });
                    assert_eq!(v.oscillator_2.ratio_smoothing_rate(), installed);
                    for _ in 0..64 {
                        let a = v.oscillator_2.next_sample(24883);
                        let b = peer.next_sample(24883);
                        assert_eq!((a.audio, a.cross), (b.audio, b.cross));
                    }
                }
            }
        }
    }
    #[test]
    fn normal_allocation_installs_fast_then_cached_rate_while_legato_preserves_it() {
        for range in 0..=50 {
            let mut v = Jp8000Voice::new_pre_output();
            v.set_parameter(35, range).unwrap();
            v.note_on(60, 100);
            let expected = if range == 0 || range == 50 { 0x40 } else { 0x80 };
            assert_eq!((v.osc2_loader_stage, v.osc2_ratio_rate_cache,
                v.oscillator_2.ratio_smoothing_rate()), (3, expected, 0x7000));
            for _ in 0..2 {
                v.amp.until_tick = 0;
                v.next_sample(RenderTap::Output);
            }
            assert_eq!(v.oscillator_2.ratio_smoothing_rate(), expected);
            v.apply_patch(&[71, 72, 35], &[1, 1, if range == 25 { 0 } else { 25 }]).unwrap();
            v.note_on(67, 100);
            assert_eq!(v.oscillator_2.ratio_smoothing_rate(), expected);
            assert_eq!(v.osc2_ratio_rate_cache, if range == 25 { 0x40 } else { 0x80 });
        }
    }
    #[test]
    fn selected_filter_release_updates_code_and_only_filter_caches() {
        let mut v = voice();
        let before = (envelope(&v.amp), histories(&v), v.filter_scheduler, v.amp_scheduler, v.controls);
        v.trigger_filter_release(16);
        assert_eq!(v.release_velocity_code, -104);
        assert_eq!(v.filter_envelope.rates, [envelope_rate(104), envelope_rate(104), envelope_rate(31)]);
        assert_eq!((v.filter_envelope.sustain, v.filter_envelope.level, v.filter_envelope.stage),
            (129 * 104, 8191, Stage::Release));
        let mut expected_controls = before.4;
        expected_controls[46..50].fill(104);
        expected_controls[50] = 31;
        assert_eq!(v.controls, expected_controls);
        assert_eq!((envelope(&v.amp), histories(&v), v.filter_scheduler, v.amp_scheduler),
            (before.0, before.1, before.2, before.3));
    }
    #[test]
    fn selected_amp_release_updates_code_without_committing_or_releasing_keys() {
        let mut v = voice();
        let before = (envelope(&v.filter_envelope), histories(&v), v.amp.value, v.amp.target,
            v.amp.committed_rate, v.amp_scheduler, v.filter_scheduler, v.controls);
        v.trigger_amp_release(16);
        assert_eq!(v.release_velocity_code, -104);
        assert_eq!(v.amp.rates, [envelope_rate(104), envelope_rate(104), envelope_rate(31)]);
        assert_eq!((v.amp.level, v.amp.stage), (7000, Stage::Release));
        let mut expected_controls = before.7;
        expected_controls[54..57].fill(104);
        expected_controls[57] = 31;
        assert_eq!(v.controls, expected_controls);
        assert_eq!((envelope(&v.filter_envelope), histories(&v), v.amp.value, v.amp.target,
            v.amp.committed_rate, v.amp_scheduler, v.filter_scheduler),
            (before.0, before.1, before.2, before.3, before.4, before.5, before.6));
    }
    #[test]
    fn each_selected_release_keeps_the_other_cached_rate_until_its_refresh() {
        let mut v = voice();
        v.trigger_filter_release(16);
        let filter = envelope(&v.filter_envelope);
        v.trigger_amp_release(127);
        assert_eq!(v.release_velocity_code, 128);
        assert_eq!(v.amp.rates[2], envelope_rate(104));
        assert_eq!(envelope(&v.filter_envelope), filter);
        v.set_parameter(334, 254).unwrap();
        // A later explicit release-parameter handler consumes the common new
        // code38; the earlier selected release does not preempt that event.
        assert_eq!(v.filter_envelope.rates[2], envelope_rate(127));
        assert_eq!(v.release_velocity_raw, 127);
    }
    #[test]
    fn pending_pedal_release_raw_survives_selected_release_code_change() {
        let mut v = voice();
        v.retain_release_velocity(64);
        v.trigger_filter_release(0);
        assert_eq!((v.release_velocity_raw, v.release_velocity_code), (64, -128));
        assert!(v.gate);
        v.release_retained_velocity(60);
        assert_eq!((v.release_velocity_raw, v.release_velocity_code), (64, -26));
        assert_eq!((v.filter_envelope.stage, v.amp.stage), (Stage::Release, Stage::Release));
        assert!(!v.gate);
    }
    #[test]
    fn selected_release_uses_current_morph_and_already_normalized_velocity() {
        let mut v = voice();
        v.params[124] = 159; // Morph sensitivity +32 for Filter Release.
        v.morph = 64;
        v.trigger_filter_release(16);
        // 64 + floor((-104*40 + 64*32)/128) = 47.
        assert_eq!(v.controls[50], 47);
        assert_eq!(v.filter_envelope.rates[2], envelope_rate(47));
        v.params[283] = 0;
        v.trigger_amp_release(80); // Dispatcher supplies fixed80; helper does not resample the switch.
        assert_eq!(v.release_velocity_code, 0);
        assert_eq!(v.amp.rates[2], envelope_rate(64));
        assert_eq!((v.velocity_code, v.release_velocity_raw), (128, 127));
    }
    #[test]
    fn selected_amp_start_preserves_existing_clock_gain_and_filter_history() {
        let mut v = voice();
        v.amp_scheduler.retarget();
        let before = (envelope(&v.filter_envelope), v.filter_scheduler, histories(&v), v.amp.value);
        v.trigger_amp_start_after_cache();
        assert_eq!(v.amp.stage, Stage::Attack);
        assert!(v.amp.level > 0);
        assert_eq!(v.amp.committed_rate, 144);
        assert_eq!(v.amp_scheduler.selector(), 13);
        assert_eq!((envelope(&v.filter_envelope), v.filter_scheduler, histories(&v), v.amp.value), before);
    }
    #[test]
    fn selected_filter_release_publication_waits_for_an_active_controller_tick() {
        let mut v = voice();
        v.amp.stage = Stage::Idle;
        v.amp.until_tick = 0;
        v.filter_scheduler = SmoothingScheduler::default();
        let before = (v.filter_envelope.level, v.filter.cutoff_target, v.filter.damping_target);
        v.trigger_filter_release(16);
        assert_eq!((v.filter_envelope.level, v.filter.cutoff_target, v.filter.damping_target), before);
        v.next_sample(RenderTap::Output);
        assert_eq!((v.filter_envelope.level, v.filter.cutoff_target, v.filter.damping_target), before);
        v.amp.stage = Stage::Sustain;
        v.amp.until_tick = 0;
        v.next_sample(RenderTap::Output);
        assert!(v.filter_envelope.level < before.0);
        assert_ne!(v.filter.cutoff_target, before.1);
        assert_eq!(v.release_velocity_code, -104);
        assert!(v.gate);
    }
}

#[cfg(test)]
mod osc2_publication_tests {
    use super::*;
    fn rate(v: &Jp8000Voice) -> (u8, u16, u16) {
        (v.osc2_loader_stage, v.osc2_ratio_rate_cache, v.oscillator_2.ratio_smoothing_rate())
    }
    fn tick(v: &mut Jp8000Voice, owner: bool) {
        v.amp.until_tick = 0;
        v.next_voice_frame_for_owner(None, None, false, owner);
    }
    fn frames(v: &mut Jp8000Voice, n: usize) { for _ in 0..n { v.next_sample(RenderTap::Output); } }
    fn held(range: u16) -> Jp8000Voice {
        let mut v = Jp8000Voice::new_pre_output();
        v.apply_patch(&[30, 33, 34, 35, 36, 54, 55, 56, 57, 283],
            &[5, 0, 0, range, 50, 0, 0, 127, 0, 1]).unwrap();
        v.note_on(60, 80);
        v
    }
    // Only the proved ratio-cache subset of E5C4. This is not a Trigger
    // dispatcher or a claim that all other E5C4 caches/publications are wired.
    fn trigger_ratio_cache(v: &mut Jp8000Voice, velocity: u8) {
        v.velocity_code = control::velocity_code(velocity);
        v.release_velocity_raw = velocity;
        v.release_velocity_code = v.velocity_code;
        v.refresh_controls();
    }
    #[test]
    fn retained_thirteen_event_ratio_contract_with_unwired_trigger_primitives() {
        let mut v = held(25);
        v.set_parameter(308, 152).unwrap(); // authored coarse velocity sensitivity +25
        assert_eq!(rate(&v), (3, 128, 0x7000));
        frames(&mut v, 8820); assert_eq!(rate(&v), (0, 128, 128)); // step0
        trigger_ratio_cache(&mut v, 127); assert_eq!(rate(&v), (0, 64, 128));
        frames(&mut v, 8820); assert_eq!(rate(&v), (0, 64, 128)); // step1
        v.set_parameter(30, 5).unwrap(); assert_eq!(rate(&v), (2, 64, 128));
        frames(&mut v, 8820); assert_eq!(rate(&v), (0, 64, 64)); // step2
        v.set_parameter(35, 0).unwrap(); frames(&mut v, 8820);
        assert_eq!(rate(&v), (0, 128, 64)); // step3 effective range25
        v.set_parameter(33, 0).unwrap(); frames(&mut v, 8820);
        assert_eq!(rate(&v), (0, 128, 128)); // step4
        v.set_parameter(34, 0).unwrap(); assert_eq!(rate(&v), (2, 128, 128));
        frames(&mut v, 8820); assert_eq!(rate(&v), (0, 128, 128)); // step5
        v.set_parameter(35, 25).unwrap(); frames(&mut v, 8820);
        assert_eq!(rate(&v), (0, 64, 128)); // step6 effective range50
        frames(&mut v, 8820); assert_eq!(rate(&v), (0, 64, 128)); // step7 selector has no ratio event
        v.trigger_amp_release(80); frames(&mut v, 8820);
        assert_eq!(v.amp.stage, Stage::Idle); assert!(v.gate);
        assert_eq!(rate(&v), (0, 64, 128)); // step8 still held
        v.set_parameter(30, 5).unwrap(); frames(&mut v, 8820);
        assert_eq!(rate(&v), (0, 64, 128)); // step9 consumed while Idle
        trigger_ratio_cache(&mut v, 127); v.trigger_amp_start_after_cache();
        frames(&mut v, 8820); assert_ne!(v.amp.stage, Stage::Idle);
        assert_eq!(rate(&v), (0, 64, 128)); // step10 no rearm/replay
        v.note_off_with_velocity(60, 0); frames(&mut v, 8820);
        assert!(!v.gate); assert_eq!(v.amp.stage, Stage::Idle);
        v.set_controller_assigned(false); assert_eq!(rate(&v), (0, 64, 128)); // step11
        v.set_parameter(30, 5).unwrap(); frames(&mut v, 8820);
        assert_eq!(rate(&v), (0, 64, 128)); // step12 owned idle/free-equivalent
    }
    #[test]
    fn allocation_publication_follows_existing_clock_phase_not_sample_count() {
        for phase in [0, 1, 137, 881] {
            for range in [0, 1, 25, 49, 50] {
                let mut v = held(range);
                v.amp.until_tick = phase;
                let normal = if matches!(range, 0 | 50) {64} else {128};
                assert_eq!(rate(&v), (3, normal, 0x7000));
                frames(&mut v, phase as usize);
                assert_eq!(rate(&v), (3, normal, 0x7000));
                frames(&mut v, 1); assert_eq!(rate(&v), (2, normal, 0x7000));
                frames(&mut v, 881); assert_eq!(rate(&v), (2, normal, 0x7000));
                frames(&mut v, 1); assert_eq!(rate(&v), (1, normal, normal));
                frames(&mut v, 882); assert_eq!(rate(&v), (0, normal, normal));
            }
        }
    }
    #[test]
    fn stage_one_uses_latest_cache_even_after_legato_and_live_range_fine() {
        let mut v = held(25);
        tick(&mut v, true); assert_eq!(rate(&v), (2, 128, 0x7000));
        v.set_parameter(35, 50).unwrap(); v.set_parameter(36, 100).unwrap();
        v.apply_patch(&[71,72], &[1,1]).unwrap(); v.note_on(67, 127);
        assert_eq!(rate(&v), (2, 64, 0x7000));
        tick(&mut v, true); assert_eq!(rate(&v), (1, 64, 64));
        tick(&mut v, true);
        v.set_parameter(35, 25).unwrap(); v.note_on(69, 80);
        assert_eq!(rate(&v), (0, 128, 64));
        tick(&mut v, true); assert_eq!(rate(&v), (0, 128, 64));
        v.set_parameter(72, 0).unwrap(); v.note_on(72,80);
        assert_eq!(rate(&v), (3, 128, 0x7000));
    }
    #[test]
    fn resulting_amp_idle_consumes_stage_one_but_silent_sustain_publishes() {
        let mut v = held(0);
        tick(&mut v, true); tick(&mut v, true); tick(&mut v, true);
        v.set_parameter(35, 25).unwrap(); v.set_parameter(34,0).unwrap();
        v.trigger_amp_release(80); v.amp.level = 0;
        assert_eq!(v.amp.stage, Stage::Release);
        tick(&mut v, true);
        assert_eq!((v.amp.stage, rate(&v)), (Stage::Idle, (1,128,64)));
        v.trigger_amp_start_after_cache(); tick(&mut v, true);
        assert_eq!(rate(&v), (0,128,64));
        v.set_parameter(34,0).unwrap(); v.amp.stage=Stage::Sustain;v.amp.level=0;
        v.amp.sustain=0;v.set_controller_assigned(false);
        tick(&mut v, true); assert_eq!(rate(&v), (1,128,128));
    }
    #[test]
    fn unowned_tick_consumes_stage_one_without_ratio_publication() {
        let mut v=held(0);tick(&mut v,true);tick(&mut v,true);tick(&mut v,true);
        v.set_parameter(35,25).unwrap();v.set_parameter(30,5).unwrap();
        tick(&mut v,false);assert_eq!(rate(&v),(1,128,64));
        tick(&mut v,true);assert_eq!(rate(&v),(0,128,64));
        // This private owner flag gates only the scoped ratio destination;
        // unsupported owner-FF routing of the whole Instrument is not claimed.
    }
    #[test]
    fn idle_can_leave_fast_installed_after_other_sample_countdowns_expire() {
        let mut v=held(25);v.clear_controller_amp();
        frames(&mut v, 8820);
        assert_eq!(v.coefficient_fast,0); assert_eq!(rate(&v),(0,128,0x7000));
        v.trigger_amp_start_after_cache();frames(&mut v,1764);
        assert_eq!(rate(&v),(0,128,0x7000));
    }
    #[test]
    fn equal_and_changed_wave_events_rearm_once_without_immediate_install() {
        let mut v=held(0);frames(&mut v,8820);
        v.set_parameter(35,25).unwrap();
        for (id,value) in [(30,5),(30,4),(33,0),(33,1),(34,0),(34,1)] {
            v.set_parameter(id,value).unwrap(); assert_eq!(rate(&v),(2,128,64));
        }
        v.apply_patch(&[30,33,34], &[4,1,1]).unwrap();assert_eq!(rate(&v),(2,128,64));
        tick(&mut v,true);assert_eq!(rate(&v),(1,128,128));
    }
    #[test]
    fn morph_cache_refresh_and_hard_reset_are_distinct_from_silence() {
        let mut v=held(25);frames(&mut v,8820);
        let i=control::ASSIGNMENT_DESTINATIONS.iter().position(|&x|x==35).unwrap();
        v.set_parameter(control::CONTROL_ASSIGNMENTS[i],152).unwrap();
        v.set_morph(128).unwrap();assert_eq!(rate(&v),(0,64,128));
        v.set_parameter(30,5).unwrap();v.silence();assert_eq!(rate(&v),(2,64,128));
        v.reset();assert_eq!(rate(&v),(0,128,128)); // Morph resets to0 and patch cache refreshes.
        assert!(!v.gate);assert!(!v.controller_assigned);
    }
    #[test]
    fn rejected_voice_transaction_preserves_pending_publication() {
        let mut v=held(0);frames(&mut v,8820);v.set_parameter(35,25).unwrap();
        let before=(rate(&v),v.params,v.controls,v.amp.until_tick);
        assert!(v.apply_patch(&[30,34], &[4,2]).is_err());
        assert_eq!((rate(&v),v.params,v.controls,v.amp.until_tick),before);
    }
}
