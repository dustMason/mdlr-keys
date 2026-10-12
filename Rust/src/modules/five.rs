use super::{
    dsp::{
        blep_pulse, blep_saw, one_pole_alpha, sanitize_audio, sine, smoothing, soft_clip,
        wrap_phase, DcBlocker, SmoothedValue,
    },
    BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor,
};

const VOICES: usize = 5;

const PARAM_TUNE: u32 = 0;
const PARAM_OSC_A_FREQ: u32 = 1;
const PARAM_OSC_B_FREQ: u32 = 2;
const PARAM_OSC_B_FINE: u32 = 3;
const PARAM_PULSE_WIDTH_A: u32 = 4;
const PARAM_PULSE_WIDTH_B: u32 = 5;
const PARAM_OSC_A_SAW: u32 = 6;
const PARAM_OSC_A_PULSE: u32 = 7;
const PARAM_OSC_B_TRI: u32 = 8;
const PARAM_OSC_B_SAW: u32 = 9;
const PARAM_OSC_B_PULSE: u32 = 10;
const PARAM_NOISE: u32 = 11;
const PARAM_CUTOFF: u32 = 12;
const PARAM_RESONANCE: u32 = 13;
const PARAM_ENV_AMOUNT: u32 = 14;
const PARAM_KEY_TRACK: u32 = 15;
const PARAM_FILTER_ATTACK: u32 = 16;
const PARAM_FILTER_DECAY: u32 = 17;
const PARAM_FILTER_SUSTAIN: u32 = 18;
const PARAM_FILTER_RELEASE: u32 = 19;
const PARAM_AMP_ATTACK: u32 = 20;
const PARAM_AMP_DECAY: u32 = 21;
const PARAM_AMP_SUSTAIN: u32 = 22;
const PARAM_AMP_RELEASE: u32 = 23;
const PARAM_LFO_FREQ: u32 = 24;
const PARAM_LFO_AMOUNT: u32 = 25;
const PARAM_LFO_SHAPE: u32 = 26;
const PARAM_SOURCE_MIX: u32 = 27;
const PARAM_WHEEL_FREQ_A: u32 = 28;
const PARAM_WHEEL_FREQ_B: u32 = 29;
const PARAM_WHEEL_PW_A: u32 = 30;
const PARAM_WHEEL_PW_B: u32 = 31;
const PARAM_WHEEL_FILTER: u32 = 32;
const PARAM_POLY_ENV: u32 = 33;
const PARAM_POLY_B: u32 = 34;
const PARAM_POLY_FREQ_A: u32 = 35;
const PARAM_POLY_PW_A: u32 = 36;
const PARAM_POLY_FILTER: u32 = 37;
const PARAM_SYNC: u32 = 38;
const PARAM_OSC_B_LOW: u32 = 39;
const PARAM_OSC_B_KEYBOARD: u32 = 40;
const PARAM_REV: u32 = 41;
const PARAM_VINTAGE: u32 = 42;
const PARAM_LEVEL: u32 = 43;
const PARAM_SPREAD: u32 = 44;
const PARAM_DRIVE: u32 = 45;
const PARAM_GLIDE: u32 = 46;
const PARAM_LFO_SYNC: u32 = 47;
const PARAM_LEGATO: u32 = 48;
const PARAM_UNISON: u32 = 49;
const PARAM_OSC_A_LEVEL: u32 = 50;
const PARAM_OSC_B_LEVEL: u32 = 51;

const PARAM_SMOOTH_SECONDS: f32 = 0.018;
const FILTER_SMOOTH_SECONDS: f32 = 0.026;
const SHAPE_SMOOTH_SECONDS: f32 = 0.014;
const PITCH_SLEW_SECONDS: f32 = 0.003;

pub const KIND: u32 = 62;
pub const INPUTS: usize = 13;
pub const OUTPUTS: usize = 4;

#[derive(Clone, Copy)]
enum EnvStage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy)]
struct FiveFilter {
    stages: [f32; 4],
}

impl FiveFilter {
    const fn new() -> Self {
        Self { stages: [0.0; 4] }
    }

    fn process(
        &mut self,
        input: f32,
        cutoff_hz: f32,
        resonance: f32,
        drive: f32,
        rev: f32,
        sample_rate: f32,
    ) -> f32 {
        let cutoff = cutoff_hz.clamp(16.0, sample_rate.max(1.0) * 0.43);
        let rev3 = rev.clamp(0.0, 1.0);
        let g = (one_pole_alpha(cutoff, sample_rate) * (0.92 + rev3 * 0.18)).clamp(0.000_04, 0.78);
        let resonance = resonance.clamp(0.0, 0.92);
        let feedback = resonance * (1.26 + resonance * (1.38 + rev3 * 0.28));
        let input_drive = drive.max(0.05) * (1.04 + (1.0 - rev3) * 0.18);
        let mut sample = ((input - self.stages[3] * feedback) * input_drive).tanh();

        for (index, stage) in self.stages.iter_mut().enumerate() {
            *stage += (sample - *stage) * g;
            sample = if index == 1 {
                (*stage * (1.0 + resonance * 0.11)).tanh()
            } else {
                *stage
            };
            *stage = if stage.abs() < 1.0e-20 { 0.0 } else { *stage };
        }

        sanitize_audio(self.stages[3] * (1.0 + resonance * (0.22 + rev3 * 0.14)))
    }
}

#[derive(Clone, Copy)]
struct FiveVoice {
    phase_a: f32,
    phase_b: f32,
    pitch: f32,
    filter_env: f32,
    amp_env: f32,
    filter_stage: EnvStage,
    amp_stage: EnvStage,
    last_gate: bool,
    filter: FiveFilter,
    drift_phase: f32,
    trim: f32,
}

impl FiveVoice {
    const fn new(phase: f32, drift_phase: f32, trim: f32) -> Self {
        Self {
            phase_a: phase,
            phase_b: wrap_const(phase + 0.271),
            pitch: 0.0,
            filter_env: 0.0,
            amp_env: 0.0,
            filter_stage: EnvStage::Idle,
            amp_stage: EnvStage::Idle,
            last_gate: false,
            filter: FiveFilter::new(),
            drift_phase,
            trim,
        }
    }
}

pub struct Five {
    midi_velocity: [f32; 5],
    tune: SmoothedValue,
    osc_a_freq: SmoothedValue,
    osc_b_freq: SmoothedValue,
    osc_b_fine: SmoothedValue,
    pulse_width_a: SmoothedValue,
    pulse_width_b: SmoothedValue,
    osc_a_saw: SmoothedValue,
    osc_a_pulse: SmoothedValue,
    osc_b_tri: SmoothedValue,
    osc_b_saw: SmoothedValue,
    osc_b_pulse: SmoothedValue,
    noise: SmoothedValue,
    cutoff: SmoothedValue,
    resonance: SmoothedValue,
    env_amount: SmoothedValue,
    key_track: SmoothedValue,
    filter_attack: SmoothedValue,
    filter_decay: SmoothedValue,
    filter_sustain: SmoothedValue,
    filter_release: SmoothedValue,
    amp_attack: SmoothedValue,
    amp_decay: SmoothedValue,
    amp_sustain: SmoothedValue,
    amp_release: SmoothedValue,
    lfo_freq: SmoothedValue,
    lfo_amount: SmoothedValue,
    lfo_shape: SmoothedValue,
    source_mix: SmoothedValue,
    wheel_freq_a: SmoothedValue,
    wheel_freq_b: SmoothedValue,
    wheel_pw_a: SmoothedValue,
    wheel_pw_b: SmoothedValue,
    wheel_filter: SmoothedValue,
    poly_env: SmoothedValue,
    poly_b: SmoothedValue,
    poly_freq_a: SmoothedValue,
    poly_pw_a: SmoothedValue,
    poly_filter: SmoothedValue,
    sync: SmoothedValue,
    osc_b_low: SmoothedValue,
    osc_b_keyboard: SmoothedValue,
    rev: SmoothedValue,
    vintage: SmoothedValue,
    level: SmoothedValue,
    spread: SmoothedValue,
    drive: SmoothedValue,
    glide: SmoothedValue,
    lfo_sync: SmoothedValue,
    legato: SmoothedValue,
    unison: SmoothedValue,
    osc_a_level: SmoothedValue,
    osc_b_level: SmoothedValue,
    voices: [FiveVoice; VOICES],
    lfo_phase: f32,
    noise_state: u32,
    left_dc: DcBlocker,
    right_dc: DcBlocker,
}

impl Five {
    pub fn new() -> Self {
        Self {
            midi_velocity: [1.0; 5],
            tune: SmoothedValue::new(0.0),
            osc_a_freq: SmoothedValue::new(0.0),
            osc_b_freq: SmoothedValue::new(0.0),
            osc_b_fine: SmoothedValue::new(0.07),
            pulse_width_a: SmoothedValue::new(0.5),
            pulse_width_b: SmoothedValue::new(0.5),
            osc_a_saw: SmoothedValue::new(0.82),
            osc_a_pulse: SmoothedValue::new(0.18),
            osc_b_tri: SmoothedValue::new(0.0),
            osc_b_saw: SmoothedValue::new(0.54),
            osc_b_pulse: SmoothedValue::new(0.0),
            noise: SmoothedValue::new(0.0),
            cutoff: SmoothedValue::new(0.56),
            resonance: SmoothedValue::new(0.18),
            env_amount: SmoothedValue::new(0.34),
            key_track: SmoothedValue::new(0.46),
            filter_attack: SmoothedValue::new(0.006),
            filter_decay: SmoothedValue::new(0.42),
            filter_sustain: SmoothedValue::new(0.36),
            filter_release: SmoothedValue::new(0.36),
            amp_attack: SmoothedValue::new(0.006),
            amp_decay: SmoothedValue::new(0.72),
            amp_sustain: SmoothedValue::new(0.82),
            amp_release: SmoothedValue::new(0.42),
            lfo_freq: SmoothedValue::new(0.25),
            lfo_amount: SmoothedValue::new(0.0),
            lfo_shape: SmoothedValue::new(1.0),
            source_mix: SmoothedValue::new(0.0),
            wheel_freq_a: SmoothedValue::new(0.0),
            wheel_freq_b: SmoothedValue::new(0.0),
            wheel_pw_a: SmoothedValue::new(0.0),
            wheel_pw_b: SmoothedValue::new(0.0),
            wheel_filter: SmoothedValue::new(0.0),
            poly_env: SmoothedValue::new(0.0),
            poly_b: SmoothedValue::new(0.0),
            poly_freq_a: SmoothedValue::new(0.0),
            poly_pw_a: SmoothedValue::new(0.0),
            poly_filter: SmoothedValue::new(0.0),
            sync: SmoothedValue::new(0.0),
            osc_b_low: SmoothedValue::new(0.0),
            osc_b_keyboard: SmoothedValue::new(1.0),
            rev: SmoothedValue::new(1.0),
            vintage: SmoothedValue::new(0.22),
            level: SmoothedValue::new(0.62),
            spread: SmoothedValue::new(0.42),
            drive: SmoothedValue::new(0.2),
            glide: SmoothedValue::new(0.0),
            lfo_sync: SmoothedValue::new(0.0),
            legato: SmoothedValue::new(0.0),
            unison: SmoothedValue::new(0.0),
            osc_a_level: SmoothedValue::new(0.82),
            osc_b_level: SmoothedValue::new(0.64),
            voices: [
                FiveVoice::new(0.02, 0.13, -0.58),
                FiveVoice::new(0.19, 0.31, -0.24),
                FiveVoice::new(0.41, 0.47, 0.03),
                FiveVoice::new(0.68, 0.61, 0.27),
                FiveVoice::new(0.86, 0.79, 0.51),
            ],
            lfo_phase: 0.0,
            noise_state: 0x5eed_5005,
            left_dc: DcBlocker::new(),
            right_dc: DcBlocker::new(),
        }
    }

    fn next_noise(&mut self) -> f32 {
        self.noise_state = self
            .noise_state
            .wrapping_mul(1_664_525)
            .wrapping_add(1_013_904_223);
        let normalized = ((self.noise_state >> 8) as f32) / 16_777_215.0;
        normalized * 2.0 - 1.0
    }
}

impl ModuleProcessor for Five {
    fn set_float_param(&mut self, param_id: u32, value: f32) {
        match param_id {
            PARAM_TUNE => self.tune.set_target(value.clamp(-36.0, 24.0)),
            PARAM_OSC_A_FREQ => self.osc_a_freq.set_target(value.round().clamp(-24.0, 24.0)),
            PARAM_OSC_B_FREQ => self.osc_b_freq.set_target(value.round().clamp(-24.0, 24.0)),
            PARAM_OSC_B_FINE => self.osc_b_fine.set_target(value.clamp(-1.0, 1.0)),
            PARAM_PULSE_WIDTH_A => self.pulse_width_a.set_target(value.clamp(0.04, 0.96)),
            PARAM_PULSE_WIDTH_B => self.pulse_width_b.set_target(value.clamp(0.04, 0.96)),
            PARAM_OSC_A_SAW => self.osc_a_saw.set_target(value.clamp(0.0, 1.0)),
            PARAM_OSC_A_PULSE => self.osc_a_pulse.set_target(value.clamp(0.0, 1.0)),
            PARAM_OSC_B_TRI => self.osc_b_tri.set_target(value.clamp(0.0, 1.0)),
            PARAM_OSC_B_SAW => self.osc_b_saw.set_target(value.clamp(0.0, 1.0)),
            PARAM_OSC_B_PULSE => self.osc_b_pulse.set_target(value.clamp(0.0, 1.0)),
            PARAM_NOISE => self.noise.set_target(value.clamp(0.0, 1.0)),
            PARAM_CUTOFF => self.cutoff.set_target(value.clamp(0.0, 1.0)),
            PARAM_RESONANCE => self.resonance.set_target(value.clamp(0.0, 0.92)),
            PARAM_ENV_AMOUNT => self.env_amount.set_target(value.clamp(0.0, 1.0)),
            PARAM_KEY_TRACK => self.key_track.set_target(value.clamp(0.0, 1.0)),
            PARAM_FILTER_ATTACK => self.filter_attack.set_target(value.clamp(0.001, 2.5)),
            PARAM_FILTER_DECAY => self.filter_decay.set_target(value.clamp(0.01, 4.0)),
            PARAM_FILTER_SUSTAIN => self.filter_sustain.set_target(value.clamp(0.0, 1.0)),
            PARAM_FILTER_RELEASE => self.filter_release.set_target(value.clamp(0.01, 5.0)),
            PARAM_AMP_ATTACK => self.amp_attack.set_target(value.clamp(0.001, 2.5)),
            PARAM_AMP_DECAY => self.amp_decay.set_target(value.clamp(0.01, 4.0)),
            PARAM_AMP_SUSTAIN => self.amp_sustain.set_target(value.clamp(0.0, 1.0)),
            PARAM_AMP_RELEASE => self.amp_release.set_target(value.clamp(0.01, 5.0)),
            PARAM_LFO_FREQ => self.lfo_freq.set_target(value.clamp(0.0, 1.0)),
            PARAM_LFO_AMOUNT => self.lfo_amount.set_target(value.clamp(0.0, 1.0)),
            PARAM_LFO_SHAPE => self.lfo_shape.set_target(value.round().clamp(0.0, 2.0)),
            PARAM_SOURCE_MIX => self.source_mix.set_target(value.clamp(0.0, 1.0)),
            PARAM_WHEEL_FREQ_A => self.wheel_freq_a.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_WHEEL_FREQ_B => self.wheel_freq_b.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_WHEEL_PW_A => self.wheel_pw_a.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_WHEEL_PW_B => self.wheel_pw_b.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_WHEEL_FILTER => self.wheel_filter.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_POLY_ENV => self.poly_env.set_target(value.clamp(0.0, 1.0)),
            PARAM_POLY_B => self.poly_b.set_target(value.clamp(0.0, 1.0)),
            PARAM_POLY_FREQ_A => self.poly_freq_a.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_POLY_PW_A => self.poly_pw_a.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_POLY_FILTER => self.poly_filter.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_SYNC => self.sync.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_OSC_B_LOW => self.osc_b_low.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_OSC_B_KEYBOARD => self
                .osc_b_keyboard
                .set_target(value.round().clamp(0.0, 1.0)),
            PARAM_REV => self.rev.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_VINTAGE => self.vintage.set_target(value.clamp(0.0, 1.0)),
            PARAM_LEVEL => self.level.set_target(value.clamp(0.0, 1.0)),
            PARAM_SPREAD => self.spread.set_target(value.clamp(0.0, 1.0)),
            PARAM_DRIVE => self.drive.set_target(value.clamp(0.0, 1.0)),
            PARAM_GLIDE => self.glide.set_target(value.clamp(0.0, 1.0)),
            PARAM_LFO_SYNC => self.lfo_sync.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_LEGATO => self.legato.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_UNISON => self.unison.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_OSC_A_LEVEL => self.osc_a_level.set_target(value.clamp(0.0, 1.0)),
            PARAM_OSC_B_LEVEL => self.osc_b_level.set_target(value.clamp(0.0, 1.0)),
            _ => {}
        }
    }

    fn process_block(
        &mut self,
        context: &BlockContext,
        inputs: &ModuleInputs,
        outputs: &mut ModuleOutputs,
    ) {
        let sample_rate = context.sample_rate.max(1.0);
        let tempo_bps = ((context.tempo_bpm as f32) / 60.0).max(0.01);

        for frame in 0..context.frames {
            let tune = self.tune.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_a_freq = self.osc_a_freq.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_b_freq = self.osc_b_freq.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_b_fine = self.osc_b_fine.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let pulse_width_a = self.pulse_width_a.next(sample_rate, SHAPE_SMOOTH_SECONDS);
            let pulse_width_b = self.pulse_width_b.next(sample_rate, SHAPE_SMOOTH_SECONDS);
            let osc_a_saw = self.osc_a_saw.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_a_pulse = self.osc_a_pulse.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_b_tri = self.osc_b_tri.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_b_saw = self.osc_b_saw.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_b_pulse = self.osc_b_pulse.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let noise_level = self.noise.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let cutoff_param = self.cutoff.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let resonance = self.resonance.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let env_amount = self.env_amount.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let key_track = self.key_track.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_attack = self.filter_attack.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_decay = self.filter_decay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_sustain = self.filter_sustain.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_release = self.filter_release.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let amp_attack = self.amp_attack.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let amp_decay = self.amp_decay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let amp_sustain = self.amp_sustain.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let amp_release = self.amp_release.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_freq_param = self.lfo_freq.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_amount = self.lfo_amount.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_shape = self.lfo_shape.next(sample_rate, SHAPE_SMOOTH_SECONDS);
            let source_mix = self.source_mix.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let wheel_freq_a = self.wheel_freq_a.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let wheel_freq_b = self.wheel_freq_b.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let wheel_pw_a = self.wheel_pw_a.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let wheel_pw_b = self.wheel_pw_b.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let wheel_filter = self.wheel_filter.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let poly_env_amount = self.poly_env.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let poly_b_amount = self.poly_b.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let poly_freq_a = self.poly_freq_a.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let poly_pw_a = self.poly_pw_a.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let poly_filter = self.poly_filter.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sync = self.sync.next(sample_rate, PARAM_SMOOTH_SECONDS) > 0.5;
            let osc_b_low = self.osc_b_low.next(sample_rate, PARAM_SMOOTH_SECONDS) > 0.5;
            let osc_b_keyboard = self.osc_b_keyboard.next(sample_rate, PARAM_SMOOTH_SECONDS) > 0.5;
            let rev = self.rev.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let vintage = self.vintage.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let level_param = self.level.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let spread = self.spread.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let drive = self.drive.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let glide = self.glide.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_sync = self.lfo_sync.next(sample_rate, PARAM_SMOOTH_SECONDS) > 0.5;
            let legato = self.legato.next(sample_rate, PARAM_SMOOTH_SECONDS) > 0.5;
            let unison = self.unison.next(sample_rate, PARAM_SMOOTH_SECONDS) > 0.5;
            let osc_a_level = self.osc_a_level.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let osc_b_level = self.osc_b_level.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let cutoff_cv = inputs[10][frame].clamp(-1.0, 1.0);
            let mod_cv = inputs[11][frame].clamp(0.0, 1.0);
            let level_cv = inputs[12][frame].clamp(-1.0, 1.0);
            let white_noise = self.next_noise();
            let lfo = if lfo_sync {
                let rate_multiplier = 2.0_f32.powf((lfo_freq_param - 0.5) * 4.0).clamp(0.25, 4.0);
                let beat_position = (context.transport_sixteenth_position as f32) / 4.0
                    + frame as f32 * tempo_bps / sample_rate;
                lfo_sample(wrap_phase(beat_position * rate_multiplier), lfo_shape)
            } else {
                let lfo = lfo_sample(self.lfo_phase, lfo_shape);
                let lfo_frequency = 0.022_f32 * (500.0_f32 / 0.022_f32).powf(lfo_freq_param);
                self.lfo_phase = wrap_phase(self.lfo_phase + lfo_frequency / sample_rate);
                lfo
            };
            let wheel_source = blend(lfo, white_noise, source_mix);
            let wheel_mod = wheel_source * (lfo_amount + mod_cv * 0.72).clamp(0.0, 1.45);
            let filter_attack_coef = smoothing(filter_attack, sample_rate);
            let filter_decay_coef = smoothing(filter_decay, sample_rate);
            let filter_release_coef = smoothing(filter_release, sample_rate);
            let amp_attack_coef = smoothing(amp_attack, sample_rate);
            let amp_decay_coef = smoothing(amp_decay, sample_rate);
            let amp_release_coef = smoothing(amp_release, sample_rate);
            let glide_seconds = PITCH_SLEW_SECONDS + glide * glide * 0.72;
            let pitch_alpha = 1.0 - smoothing(glide_seconds, sample_rate);
            let (unison_gate, unison_pitch_cv) = unison_source(inputs, frame);
            let mut left = 0.0;
            let mut right = 0.0;
            let mut env_peak = 0.0_f32;
            let mut any_gate = false;

            for voice_index in 0..VOICES {
                let pitch_cv = if unison {
                    (unison_pitch_cv + self.voices[voice_index].trim * 0.012).clamp(-5.0, 5.0)
                } else {
                    inputs[voice_index][frame].clamp(-5.0, 5.0)
                };
                let gate = if unison {
                    unison_gate
                } else {
                    inputs[voice_index + VOICES][frame] > 0.5
                };
                let voice = &mut self.voices[voice_index];

                if gate && !voice.last_gate {
                    if !(legato && voice.amp_env > 0.02) {
                        voice.filter_stage = EnvStage::Attack;
                        voice.amp_stage = EnvStage::Attack;
                    }
                    if glide <= 0.001 {
                        voice.pitch = pitch_cv;
                    }
                } else if !gate && voice.last_gate {
                    voice.filter_stage = EnvStage::Release;
                    voice.amp_stage = EnvStage::Release;
                }
                voice.last_gate = gate;
                if gate {
                    if glide <= 0.001 {
                        voice.pitch = pitch_cv;
                    } else {
                        voice.pitch += (pitch_cv - voice.pitch) * pitch_alpha;
                    }
                    any_gate = true;
                }

                advance_envelope(
                    &mut voice.filter_env,
                    &mut voice.filter_stage,
                    filter_attack_coef,
                    filter_decay_coef,
                    filter_release_coef,
                    filter_sustain,
                );
                advance_envelope(
                    &mut voice.amp_env,
                    &mut voice.amp_stage,
                    amp_attack_coef,
                    amp_decay_coef,
                    amp_release_coef,
                    amp_sustain,
                );
                let env_curve = env_shape(voice.filter_env, rev);
                let amp_env = voice.amp_env.clamp(0.0, 1.05);
                env_peak = env_peak.max(amp_env);

                voice.drift_phase = wrap_phase(
                    voice.drift_phase + (0.018 + voice_index as f32 * 0.0065) / sample_rate,
                );
                let vintage_depth = vintage * vintage;
                let drift_semitones =
                    (voice.trim * 0.12 + sine(voice.drift_phase) * 0.075) * vintage_depth;
                let unison_detune = if unison {
                    voice.trim * (0.04 + vintage * 0.18)
                } else {
                    0.0
                };
                let base_pitch = voice.pitch + (drift_semitones + unison_detune) / 12.0;
                let keyboard_base = note_to_hz(tune) * 2.0_f32.powf(base_pitch);
                let fixed_base = note_to_hz(tune);
                let b_base = if osc_b_keyboard {
                    keyboard_base
                } else {
                    fixed_base
                };
                let b_semitones = osc_b_freq + osc_b_fine + wheel_mod * wheel_freq_b * 2.0;
                let freq_b = if osc_b_low {
                    let tracking = if osc_b_keyboard {
                        voice.pitch * 4.0
                    } else {
                        0.0
                    };
                    (0.11 * 2.0_f32.powf((b_semitones + tracking) / 12.0)).clamp(0.022, 500.0)
                } else {
                    (b_base * 2.0_f32.powf(b_semitones / 12.0)).clamp(5.0, sample_rate * 0.43)
                };
                let pw_b = (pulse_width_b + wheel_mod * wheel_pw_b * 0.24).clamp(0.04, 0.96);
                let (osc_b_wave, b_wrapped) = oscillator_b(
                    &mut voice.phase_b,
                    freq_b,
                    pw_b,
                    osc_b_tri,
                    osc_b_saw,
                    osc_b_pulse,
                    sample_rate,
                );

                let poly_source = env_curve * poly_env_amount + osc_b_wave * poly_b_amount * 0.82;
                let a_semitones =
                    osc_a_freq + wheel_mod * wheel_freq_a * 2.0 + poly_source * poly_freq_a * 24.0;
                let freq_a = (keyboard_base * 2.0_f32.powf(a_semitones / 12.0))
                    .clamp(5.0, sample_rate * 0.43);
                if sync && b_wrapped {
                    voice.phase_a = 0.0;
                }
                let pw_a =
                    (pulse_width_a + wheel_mod * wheel_pw_a * 0.24 + poly_source * poly_pw_a * 0.2)
                        .clamp(0.04, 0.96);
                let osc_a_wave = oscillator_a(
                    &mut voice.phase_a,
                    freq_a,
                    pw_a,
                    osc_a_saw,
                    osc_a_pulse,
                    sample_rate,
                );
                let osc_a_audio = osc_a_wave * osc_a_level;
                let osc_b_audio = osc_b_wave * osc_b_level;
                let level_sum = (osc_a_saw + osc_a_pulse) * osc_a_level
                    + (osc_b_tri + osc_b_saw + osc_b_pulse) * osc_b_level
                    + noise_level * 0.74;
                let normalization = 1.0 / level_sum.max(1.0).sqrt();
                let raw =
                    (osc_a_audio + osc_b_audio + white_noise * noise_level * 0.78) * normalization;
                let cutoff_octaves = cutoff_param * 7.4
                    + cutoff_cv * 1.8
                    + env_curve * env_amount * 4.8
                    + voice.pitch * key_track * 2.2
                    + wheel_mod * wheel_filter * 2.2
                    + poly_source * poly_filter * 2.1;
                let cutoff = (24.0 * 2.0_f32.powf(cutoff_octaves)).clamp(18.0, sample_rate * 0.43);
                let filter_drive = 1.0 + drive * 5.2 + level_sum.max(0.0) * 0.18;
                let filtered =
                    voice
                        .filter
                        .process(raw, cutoff, resonance, filter_drive, rev, sample_rate);
                let (left_gain, right_gain) = pan_gains(voice_index, spread);
                left += filtered * amp_env * self.midi_velocity[voice_index] * left_gain * 0.38;
                right += filtered * amp_env * self.midi_velocity[voice_index] * right_gain * 0.38;
            }

            let level = (level_param + level_cv * 0.42).clamp(0.0, 1.0);
            outputs[0][frame] = soft_clip(self.left_dc.process(left * level * (1.25 + drive)));
            outputs[1][frame] = soft_clip(self.right_dc.process(right * level * (1.25 + drive)));
            outputs[2][frame] = env_peak.clamp(0.0, 1.0);
            outputs[3][frame] = f32::from(any_gate);
        }
    }
}

fn oscillator_a(
    phase: &mut f32,
    freq: f32,
    pulse_width: f32,
    saw_level: f32,
    pulse_level: f32,
    sample_rate: f32,
) -> f32 {
    let freq = freq.clamp(5.0, sample_rate * 0.43);
    let inc = freq / sample_rate;
    let saw = blep_saw(*phase, inc) * saw_level;
    let pulse = blep_pulse(*phase, pulse_width, inc) * pulse_level;
    *phase = wrap_phase(*phase + inc);
    saw + pulse
}

fn oscillator_b(
    phase: &mut f32,
    freq: f32,
    pulse_width: f32,
    tri_level: f32,
    saw_level: f32,
    pulse_level: f32,
    sample_rate: f32,
) -> (f32, bool) {
    let freq = freq.clamp(0.022, sample_rate * 0.43);
    let inc = freq / sample_rate;
    let tri = triangle_bandlimited(*phase, inc) * tri_level;
    let saw = blep_saw(*phase, inc) * saw_level;
    let pulse = blep_pulse(*phase, pulse_width, inc) * pulse_level;
    let next = *phase + inc;
    *phase = wrap_phase(next);
    (tri + saw + pulse, next >= 1.0)
}

fn advance_envelope(
    value: &mut f32,
    stage: &mut EnvStage,
    attack_coef: f32,
    decay_coef: f32,
    release_coef: f32,
    sustain: f32,
) {
    match stage {
        EnvStage::Idle => {
            *value = 0.0;
        }
        EnvStage::Attack => {
            *value = 1.0 + (*value - 1.0) * attack_coef;
            if *value >= 0.995 {
                *value = 1.0;
                *stage = EnvStage::Decay;
            }
        }
        EnvStage::Decay => {
            *value = sustain + (*value - sustain) * decay_coef;
            if (*value - sustain).abs() < 0.002 {
                *value = sustain;
                *stage = EnvStage::Sustain;
            }
        }
        EnvStage::Sustain => {
            *value = sustain;
        }
        EnvStage::Release => {
            *value *= release_coef;
            if *value <= 0.000_5 {
                *value = 0.0;
                *stage = EnvStage::Idle;
            }
        }
    }
}

fn lfo_sample(phase: f32, shape: f32) -> f32 {
    match shape.round() as i32 {
        0 => phase,
        2 => {
            if phase < 0.5 {
                1.0
            } else {
                0.0
            }
        }
        _ => 1.0 - (phase - 0.5).abs() * 4.0,
    }
}

fn env_shape(value: f32, rev: f32) -> f32 {
    let value = value.clamp(0.0, 1.0);
    if rev < 0.5 {
        value
    } else {
        value * value * (3.0 - 2.0 * value)
    }
}

fn pan_gains(voice_index: usize, spread: f32) -> (f32, f32) {
    let positions = [-0.78, -0.36, 0.0, 0.36, 0.78];
    let pan = positions[voice_index.min(4)] * spread.clamp(0.0, 1.0);
    let left = ((1.0 - pan) * 0.5).sqrt();
    let right = ((1.0 + pan) * 0.5).sqrt();
    (left, right)
}

fn unison_source(inputs: &ModuleInputs, frame: usize) -> (bool, f32) {
    for voice_index in 0..VOICES {
        if inputs[voice_index + VOICES][frame] > 0.5 {
            return (true, inputs[voice_index][frame].clamp(-5.0, 5.0));
        }
    }

    (false, inputs[0][frame].clamp(-5.0, 5.0))
}

fn triangle_bandlimited(phase: f32, phase_inc: f32) -> f32 {
    let triangle = 1.0 - (phase - 0.5).abs() * 4.0;
    let sine_fallback = sine(phase);
    let high_pitch_mix = ((phase_inc - 0.08) / 0.18).clamp(0.0, 1.0);
    blend(triangle, sine_fallback, high_pitch_mix)
}

fn blend(a: f32, b: f32, mix: f32) -> f32 {
    a + (b - a) * mix.clamp(0.0, 1.0)
}

fn note_to_hz(tune_semitones: f32) -> f32 {
    let midi = 48.0 + tune_semitones;
    440.0 * 2.0_f32.powf((midi - 69.0) / 12.0)
}

const fn wrap_const(value: f32) -> f32 {
    if value >= 1.0 {
        value - 1.0
    } else if value < 0.0 {
        value + 1.0
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::super::{MAX_BLOCK_FRAMES, MAX_INPUTS, MAX_OUTPUTS};
    use super::*;

    fn context() -> BlockContext {
        BlockContext {
            sample_rate: 48_000.0,
            frames: 64,
            tempo_bpm: 120.0,
            transport_sixteenth_position: 0.0,
        }
    }

    #[test]
    fn five_gated_voices_produce_bounded_stereo() {
        let mut module = Five::new();
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        for frame in 0..64 {
            inputs[0][frame] = 0.0;
            inputs[1][frame] = 4.0 / 12.0;
            inputs[2][frame] = 7.0 / 12.0;
            inputs[3][frame] = 12.0 / 12.0;
            inputs[4][frame] = 16.0 / 12.0;
            for gate in 5..10 {
                inputs[gate][frame] = 1.0;
            }
            inputs[12][frame] = 1.0;
        }

        module.process_block(&context(), &inputs, &mut outputs);

        assert!(outputs[0][40].abs() > 0.000_1);
        assert!(outputs[1][40].abs() > 0.000_1);
        assert!(outputs[0][40].abs() <= 1.0);
        assert!(outputs[1][40].abs() <= 1.0);
        assert!(outputs[2][40] > 0.0);
        assert_eq!(outputs[3][40], 1.0);
    }

    #[test]
    fn poly_mod_changes_sync_tone() {
        let mut plain = Five::new();
        let mut modded = Five::new();
        modded.set_float_param(PARAM_SYNC, 1.0);
        modded.set_float_param(PARAM_POLY_ENV, 0.8);
        modded.set_float_param(PARAM_POLY_FREQ_A, 1.0);

        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut plain_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        let mut mod_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[5][..64].fill(1.0);
        inputs[12][..64].fill(1.0);

        for _ in 0..5 {
            plain.process_block(&context(), &inputs, &mut plain_outputs);
            modded.process_block(&context(), &inputs, &mut mod_outputs);
        }

        let mut difference = 0.0;
        for frame in 16..64 {
            difference += (plain_outputs[0][frame] - mod_outputs[0][frame]).abs();
            difference += (plain_outputs[1][frame] - mod_outputs[1][frame]).abs();
        }

        assert!(difference > 0.01);
    }
}

// Native MIDI adapter: per-voice velocity and allocation-free panic/reset.
impl crate::Instrument for Five {
    fn velocity(&mut self, voice: usize, value: f32) {
        if let Some(v) = self.midi_velocity.get_mut(voice) { *v = value.clamp(0.0, 1.0); }
    }
    fn silence(&mut self) { self.voices = [
                FiveVoice::new(0.02, 0.13, -0.58),
                FiveVoice::new(0.19, 0.31, -0.24),
                FiveVoice::new(0.41, 0.47, 0.03),
                FiveVoice::new(0.68, 0.61, 0.27),
                FiveVoice::new(0.86, 0.79, 0.51),
            ];
self.left_dc = DcBlocker::new(); self.right_dc = DcBlocker::new(); }
}
