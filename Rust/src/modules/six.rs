use super::{
    dsp::{
        blep_pulse, blep_saw, one_pole_alpha, sanitize_audio, sine, smoothing, soft_clip,
        wrap_phase, DcBlocker, SafeDelayLine, SmoothedValue,
    },
    BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor,
};

const VOICES: usize = 6;

const PARAM_TUNE: u32 = 0;
const PARAM_RANGE: u32 = 1;
const PARAM_PULSE_WIDTH: u32 = 2;
const PARAM_PWM_MODE: u32 = 3;
const PARAM_PWM_AMOUNT: u32 = 4;
const PARAM_PULSE: u32 = 5;
const PARAM_SAW: u32 = 6;
const PARAM_SUB: u32 = 7;
const PARAM_NOISE: u32 = 8;
const PARAM_HPF: u32 = 9;
const PARAM_CUTOFF: u32 = 10;
const PARAM_RESONANCE: u32 = 11;
const PARAM_ENV_DEPTH: u32 = 12;
const PARAM_LFO_FILTER: u32 = 13;
const PARAM_KEY_FOLLOW: u32 = 14;
const PARAM_VCA_MODE: u32 = 15;
const PARAM_VCA_LEVEL: u32 = 16;
const PARAM_ATTACK: u32 = 17;
const PARAM_DECAY: u32 = 18;
const PARAM_SUSTAIN: u32 = 19;
const PARAM_RELEASE: u32 = 20;
const PARAM_LFO_RATE: u32 = 21;
const PARAM_LFO_DELAY: u32 = 22;
const PARAM_CHORUS: u32 = 23;
const PARAM_CHORUS_MIX: u32 = 24;
const PARAM_SPREAD: u32 = 25;
const PARAM_ANALOG: u32 = 26;
const PARAM_DRIVE: u32 = 27;
const PARAM_FILTER_ATTACK: u32 = 28;
const PARAM_FILTER_DECAY: u32 = 29;
const PARAM_FILTER_SUSTAIN: u32 = 30;
const PARAM_FILTER_RELEASE: u32 = 31;
const PARAM_LFO_DCO: u32 = 32;

const PARAM_SMOOTH_SECONDS: f32 = 0.018;
const FILTER_SMOOTH_SECONDS: f32 = 0.026;
const PITCH_SLEW_SECONDS: f32 = 0.003;
const CHORUS_DELAY_SAMPLES: usize = 4096;

pub const KIND: u32 = 64;
pub const INPUTS: usize = 15;
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
struct SixFilter {
    stages: [f32; 4],
}

impl SixFilter {
    const fn new() -> Self {
        Self { stages: [0.0; 4] }
    }

    fn process(
        &mut self,
        input: f32,
        cutoff_hz: f32,
        resonance: f32,
        drive: f32,
        sample_rate: f32,
    ) -> f32 {
        let cutoff = cutoff_hz.clamp(18.0, sample_rate.max(1.0) * 0.43);
        let g = one_pole_alpha(cutoff, sample_rate).clamp(0.000_04, 0.78);
        let resonance = resonance.clamp(0.0, 0.9);
        let feedback = resonance * (1.14 + resonance * 1.44);
        let mut sample = ((input - self.stages[3] * feedback) * drive.max(0.05)).tanh();

        for (index, stage) in self.stages.iter_mut().enumerate() {
            *stage += (sample - *stage) * g;
            sample = if index == 2 {
                (*stage * (1.0 + resonance * 0.08)).tanh()
            } else {
                *stage
            };
            *stage = if stage.abs() < 1.0e-20 { 0.0 } else { *stage };
        }

        sanitize_audio(self.stages[3] * (1.0 + resonance * 0.28))
    }
}

#[derive(Clone, Copy)]
struct SixVoice {
    phase: f32,
    sub_phase: f32,
    pitch: f32,
    env: f32,
    stage: EnvStage,
    filter_env: f32,
    filter_stage: EnvStage,
    last_gate: bool,
    filter: SixFilter,
    hpf_state: f32,
    drift_phase: f32,
    trim: f32,
}

impl SixVoice {
    const fn new(phase: f32, drift_phase: f32, trim: f32) -> Self {
        Self {
            phase,
            sub_phase: wrap_const(phase + 0.5),
            pitch: 0.0,
            env: 0.0,
            stage: EnvStage::Idle,
            filter_env: 0.0,
            filter_stage: EnvStage::Idle,
            last_gate: false,
            filter: SixFilter::new(),
            hpf_state: 0.0,
            drift_phase,
            trim,
        }
    }
}

pub struct Six {
    midi_velocity: [f32; 6],
    tune: SmoothedValue,
    range: SmoothedValue,
    pulse_width: SmoothedValue,
    pwm_mode: SmoothedValue,
    pwm_amount: SmoothedValue,
    pulse: SmoothedValue,
    saw: SmoothedValue,
    sub: SmoothedValue,
    noise: SmoothedValue,
    hpf: SmoothedValue,
    cutoff: SmoothedValue,
    resonance: SmoothedValue,
    env_depth: SmoothedValue,
    lfo_filter: SmoothedValue,
    key_follow: SmoothedValue,
    vca_mode: SmoothedValue,
    vca_level: SmoothedValue,
    attack: SmoothedValue,
    decay: SmoothedValue,
    sustain: SmoothedValue,
    release: SmoothedValue,
    lfo_rate: SmoothedValue,
    lfo_delay: SmoothedValue,
    chorus: SmoothedValue,
    chorus_mix: SmoothedValue,
    spread: SmoothedValue,
    analog: SmoothedValue,
    drive: SmoothedValue,
    filter_attack: SmoothedValue,
    filter_decay: SmoothedValue,
    filter_sustain: SmoothedValue,
    filter_release: SmoothedValue,
    lfo_dco: SmoothedValue,
    voices: [SixVoice; VOICES],
    lfo_phase: f32,
    lfo_fade: f32,
    noise_state: u32,
    chorus_left: SafeDelayLine,
    chorus_right: SafeDelayLine,
    chorus_phase_a: f32,
    chorus_phase_b: f32,
    left_dc: DcBlocker,
    right_dc: DcBlocker,
}

impl Six {
    pub fn new() -> Self {
        Self {
            midi_velocity: [1.0; 6],
            tune: SmoothedValue::new(0.0),
            range: SmoothedValue::new(1.0),
            pulse_width: SmoothedValue::new(0.52),
            pwm_mode: SmoothedValue::new(1.0),
            pwm_amount: SmoothedValue::new(0.22),
            pulse: SmoothedValue::new(0.46),
            saw: SmoothedValue::new(0.84),
            sub: SmoothedValue::new(0.38),
            noise: SmoothedValue::new(0.0),
            hpf: SmoothedValue::new(0.12),
            cutoff: SmoothedValue::new(0.62),
            resonance: SmoothedValue::new(0.18),
            env_depth: SmoothedValue::new(0.32),
            lfo_filter: SmoothedValue::new(0.0),
            key_follow: SmoothedValue::new(0.42),
            vca_mode: SmoothedValue::new(1.0),
            vca_level: SmoothedValue::new(0.72),
            attack: SmoothedValue::new(0.006),
            decay: SmoothedValue::new(0.72),
            sustain: SmoothedValue::new(0.76),
            release: SmoothedValue::new(0.42),
            lfo_rate: SmoothedValue::new(0.22),
            lfo_delay: SmoothedValue::new(0.0),
            chorus: SmoothedValue::new(1.0),
            chorus_mix: SmoothedValue::new(0.42),
            spread: SmoothedValue::new(0.34),
            analog: SmoothedValue::new(0.12),
            drive: SmoothedValue::new(0.18),
            filter_attack: SmoothedValue::new(0.004),
            filter_decay: SmoothedValue::new(0.48),
            filter_sustain: SmoothedValue::new(0.24),
            filter_release: SmoothedValue::new(0.26),
            lfo_dco: SmoothedValue::new(0.0),
            voices: [
                SixVoice::new(0.01, 0.09, -0.58),
                SixVoice::new(0.17, 0.23, -0.34),
                SixVoice::new(0.34, 0.39, -0.12),
                SixVoice::new(0.52, 0.57, 0.14),
                SixVoice::new(0.71, 0.73, 0.32),
                SixVoice::new(0.88, 0.91, 0.53),
            ],
            lfo_phase: 0.0,
            lfo_fade: 1.0,
            noise_state: 0x1060_1984,
            chorus_left: SafeDelayLine::new(CHORUS_DELAY_SAMPLES),
            chorus_right: SafeDelayLine::new(CHORUS_DELAY_SAMPLES),
            chorus_phase_a: 0.0,
            chorus_phase_b: 0.31,
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

impl ModuleProcessor for Six {
    fn set_float_param(&mut self, param_id: u32, value: f32) {
        match param_id {
            PARAM_TUNE => self.tune.set_target(value.clamp(-36.0, 24.0)),
            PARAM_RANGE => self.range.set_target(value.round().clamp(0.0, 5.0)),
            PARAM_PULSE_WIDTH => self.pulse_width.set_target(value.clamp(0.04, 0.96)),
            PARAM_PWM_MODE => self.pwm_mode.set_target(value.round().clamp(0.0, 5.0)),
            PARAM_PWM_AMOUNT => self.pwm_amount.set_target(value.clamp(0.0, 1.0)),
            PARAM_PULSE => self.pulse.set_target(value.clamp(0.0, 1.0)),
            PARAM_SAW => self.saw.set_target(value.clamp(0.0, 1.0)),
            PARAM_SUB => self.sub.set_target(value.clamp(0.0, 1.0)),
            PARAM_NOISE => self.noise.set_target(value.clamp(0.0, 1.0)),
            PARAM_HPF => self.hpf.set_target(value.clamp(0.0, 1.0)),
            PARAM_CUTOFF => self.cutoff.set_target(value.clamp(0.0, 1.0)),
            PARAM_RESONANCE => self.resonance.set_target(value.clamp(0.0, 0.9)),
            PARAM_ENV_DEPTH => self.env_depth.set_target(value.clamp(-1.0, 1.0)),
            PARAM_LFO_FILTER => self.lfo_filter.set_target(value.clamp(0.0, 1.0)),
            PARAM_KEY_FOLLOW => self.key_follow.set_target(value.clamp(0.0, 1.0)),
            PARAM_VCA_MODE => self.vca_mode.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_VCA_LEVEL => self.vca_level.set_target(value.clamp(0.0, 1.0)),
            PARAM_ATTACK => self.attack.set_target(value.clamp(0.001, 2.5)),
            PARAM_DECAY => self.decay.set_target(value.clamp(0.01, 4.0)),
            PARAM_SUSTAIN => self.sustain.set_target(value.clamp(0.0, 1.0)),
            PARAM_RELEASE => self.release.set_target(value.clamp(0.01, 5.0)),
            PARAM_LFO_RATE => self.lfo_rate.set_target(value.clamp(0.0, 1.0)),
            PARAM_LFO_DELAY => self.lfo_delay.set_target(value.clamp(0.0, 1.0)),
            PARAM_CHORUS => self.chorus.set_target(value.round().clamp(0.0, 3.0)),
            PARAM_CHORUS_MIX => self.chorus_mix.set_target(value.clamp(0.0, 1.0)),
            PARAM_SPREAD => self.spread.set_target(value.clamp(0.0, 1.0)),
            PARAM_ANALOG => self.analog.set_target(value.clamp(0.0, 1.0)),
            PARAM_DRIVE => self.drive.set_target(value.clamp(0.0, 1.0)),
            PARAM_FILTER_ATTACK => self.filter_attack.set_target(value.clamp(0.001, 2.5)),
            PARAM_FILTER_DECAY => self.filter_decay.set_target(value.clamp(0.01, 4.0)),
            PARAM_FILTER_SUSTAIN => self.filter_sustain.set_target(value.clamp(0.0, 1.0)),
            PARAM_FILTER_RELEASE => self.filter_release.set_target(value.clamp(0.01, 5.0)),
            PARAM_LFO_DCO => self.lfo_dco.set_target(value.clamp(0.0, 1.0)),
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

        for frame in 0..context.frames {
            let tune = self.tune.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let range = self.range.next(sample_rate, PARAM_SMOOTH_SECONDS).round() as i32;
            let pulse_width = self.pulse_width.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let pwm_mode = self
                .pwm_mode
                .next(sample_rate, PARAM_SMOOTH_SECONDS)
                .round() as i32;
            let pwm_amount = self.pwm_amount.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let pulse = self.pulse.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let saw = self.saw.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sub = self.sub.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let noise_level = self.noise.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let hpf = self.hpf.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let cutoff_param = self.cutoff.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let resonance = self.resonance.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let env_depth = self.env_depth.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_filter = self.lfo_filter.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let key_follow = self.key_follow.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let vca_mode = self.vca_mode.next(sample_rate, PARAM_SMOOTH_SECONDS) >= 0.5;
            let vca_level = self.vca_level.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let attack = self.attack.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let decay = self.decay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sustain = self.sustain.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let release = self.release.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_attack = self.filter_attack.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_decay = self.filter_decay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_sustain = self.filter_sustain.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let filter_release = self.filter_release.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_rate = self.lfo_rate.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_delay = self.lfo_delay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_dco = self.lfo_dco.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let chorus = self.chorus.next(sample_rate, PARAM_SMOOTH_SECONDS).round() as i32;
            let chorus_mix = self.chorus_mix.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let spread = self.spread.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let analog = self.analog.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let drive = self.drive.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let cutoff_cv = inputs[12][frame].clamp(-1.0, 1.0);
            let mod_cv = inputs[13][frame].clamp(0.0, 1.0);
            let level_cv = inputs[14][frame].clamp(-1.0, 1.0);
            let white_noise = self.next_noise();
            let old_lfo_phase = self.lfo_phase;
            let lfo_hz = 0.04_f32 * (22.0_f32 / 0.04_f32).powf(lfo_rate);
            self.lfo_phase = wrap_phase(self.lfo_phase + lfo_hz / sample_rate);
            let lfo = 1.0 - (self.lfo_phase - 0.5).abs() * 4.0;
            if self.lfo_phase < old_lfo_phase && lfo_delay > 0.0 {
                self.lfo_fade = 0.0;
            }
            let fade_alpha = 1.0 - smoothing(0.015 + lfo_delay * lfo_delay * 1.9, sample_rate);
            self.lfo_fade += (1.0 - self.lfo_fade) * fade_alpha;
            let lfo = lfo * self.lfo_fade.clamp(0.0, 1.0);
            let attack_coef = smoothing(attack, sample_rate);
            let decay_coef = smoothing(decay, sample_rate);
            let release_coef = smoothing(release, sample_rate);
            let filter_attack_coef = smoothing(filter_attack, sample_rate);
            let filter_decay_coef = smoothing(filter_decay, sample_rate);
            let filter_release_coef = smoothing(filter_release, sample_rate);
            let pitch_alpha = 1.0 - smoothing(PITCH_SLEW_SECONDS, sample_rate);
            let range_offset = match range {
                0 => -12.0,
                2 => 12.0,
                3 => -36.0,
                4 => -24.0,
                5 => 24.0,
                _ => 0.0,
            };
            let mut left = 0.0;
            let mut right = 0.0;
            let mut env_peak = 0.0_f32;
            let mut any_gate = false;

            for voice_index in 0..VOICES {
                let pitch_cv = inputs[voice_index][frame].clamp(-5.0, 5.0);
                let gate = inputs[voice_index + VOICES][frame] > 0.5;
                let voice = &mut self.voices[voice_index];

                if gate && !voice.last_gate {
                    voice.stage = EnvStage::Attack;
                    voice.filter_stage = EnvStage::Attack;
                    voice.pitch = pitch_cv;
                    self.lfo_fade = if lfo_delay > 0.0 { 0.0 } else { self.lfo_fade };
                } else if !gate && voice.last_gate {
                    voice.stage = EnvStage::Release;
                    voice.filter_stage = EnvStage::Release;
                }
                voice.last_gate = gate;
                if gate {
                    voice.pitch += (pitch_cv - voice.pitch) * pitch_alpha;
                    any_gate = true;
                }

                advance_envelope(
                    &mut voice.env,
                    &mut voice.stage,
                    attack_coef,
                    decay_coef,
                    release_coef,
                    sustain,
                );
                advance_envelope(
                    &mut voice.filter_env,
                    &mut voice.filter_stage,
                    filter_attack_coef,
                    filter_decay_coef,
                    filter_release_coef,
                    filter_sustain,
                );
                let amp_env = voice.env.clamp(0.0, 1.05);
                let filter_env = voice.filter_env.clamp(0.0, 1.05);
                env_peak = env_peak.max(amp_env);
                voice.drift_phase = wrap_phase(
                    voice.drift_phase + (0.019 + voice_index as f32 * 0.0055) / sample_rate,
                );
                let analog_depth = analog * analog;
                let drift = (voice.trim * 0.07 + sine(voice.drift_phase) * 0.045) * analog_depth;
                let vibrato = lfo * lfo_dco * 0.7;
                let base = note_to_hz(tune + range_offset)
                    * 2.0_f32.powf(voice.pitch + (drift + vibrato) / 12.0);
                let pw_mod = match pwm_mode {
                    2 => amp_env,
                    3 => -amp_env,
                    4 => filter_env,
                    5 => -filter_env,
                    1 => lfo + mod_cv * 0.8,
                    _ => 0.0,
                };
                let width = (pulse_width + pw_mod * pwm_amount * 0.36).clamp(0.04, 0.96);
                let osc = dco_sample(
                    voice,
                    base,
                    width,
                    saw,
                    pulse,
                    sub,
                    white_noise * noise_level,
                    sample_rate,
                );
                let hpf_cutoff = 18.0 + hpf * hpf * 1_900.0;
                let hpf_alpha = one_pole_alpha(hpf_cutoff, sample_rate);
                voice.hpf_state += (osc - voice.hpf_state) * hpf_alpha;
                let highpassed = osc - voice.hpf_state * hpf;
                let cutoff_octaves = cutoff_param * 7.5
                    + cutoff_cv * 1.9
                    + filter_env * env_depth * 4.9
                    + lfo * lfo_filter * 1.65
                    + mod_cv * 0.8
                    + voice.pitch * key_follow * 1.8;
                let cutoff = (22.0 * 2.0_f32.powf(cutoff_octaves)).clamp(18.0, sample_rate * 0.43);
                let filtered = voice.filter.process(
                    highpassed,
                    cutoff,
                    resonance,
                    1.0 + drive * 4.8,
                    sample_rate,
                );
                let amp = if vca_mode { amp_env } else { f32::from(gate) };
                let (left_gain, right_gain) = pan_gains(voice_index, spread);
                left += filtered * amp * self.midi_velocity[voice_index] * left_gain * 0.33;
                right += filtered * amp * self.midi_velocity[voice_index] * right_gain * 0.33;
            }

            let level = (vca_level + level_cv * 0.42).clamp(0.0, 1.0);
            let dry_left = self.left_dc.process(left * level * (1.32 + drive));
            let dry_right = self.right_dc.process(right * level * (1.32 + drive));
            let (chorus_left, chorus_right) =
                self.process_chorus(dry_left, dry_right, chorus, chorus_mix, sample_rate);
            outputs[0][frame] = soft_clip(chorus_left);
            outputs[1][frame] = soft_clip(chorus_right);
            outputs[2][frame] = env_peak.clamp(0.0, 1.0);
            outputs[3][frame] = f32::from(any_gate);
        }
    }
}

impl Six {
    fn process_chorus(
        &mut self,
        left: f32,
        right: f32,
        mode: i32,
        mix: f32,
        sample_rate: f32,
    ) -> (f32, f32) {
        self.chorus_left.push(left);
        self.chorus_right.push(right);
        if mode <= 0 || mix <= 0.000_1 {
            return (left, right);
        }

        let (rate_a, depth_a, rate_b, depth_b) = match mode {
            2 => (0.78, 11.0, 0.92, 9.5),
            3 => (0.42, 13.5, 0.86, 11.5),
            _ => (0.36, 8.0, 0.47, 7.0),
        };
        self.chorus_phase_a = wrap_phase(self.chorus_phase_a + rate_a / sample_rate);
        self.chorus_phase_b = wrap_phase(self.chorus_phase_b + rate_b / sample_rate);
        let base_delay = 690.0;
        let left_delay = base_delay + sine(self.chorus_phase_a) * depth_a;
        let right_delay = base_delay + sine(wrap_phase(self.chorus_phase_b + 0.5)) * depth_b;
        let wet_left = self.chorus_right.read_linear(left_delay);
        let wet_right = self.chorus_left.read_linear(right_delay);
        let mix = mix.clamp(0.0, 1.0);
        (
            left * (1.0 - mix * 0.48) + wet_left * mix * 0.72,
            right * (1.0 - mix * 0.48) + wet_right * mix * 0.72,
        )
    }
}

fn dco_sample(
    voice: &mut SixVoice,
    freq: f32,
    pulse_width: f32,
    saw_level: f32,
    pulse_level: f32,
    sub_level: f32,
    noise: f32,
    sample_rate: f32,
) -> f32 {
    let freq = freq.clamp(7.0, sample_rate * 0.43);
    let inc = freq / sample_rate;
    let saw = blep_saw(voice.phase, inc) * saw_level;
    let pulse = blep_pulse(voice.phase, pulse_width, inc) * pulse_level;
    let sub = blep_pulse(voice.sub_phase, 0.5, (freq * 0.5) / sample_rate) * sub_level;
    voice.phase = wrap_phase(voice.phase + inc);
    voice.sub_phase = wrap_phase(voice.sub_phase + inc * 0.5);
    let level_sum = saw_level + pulse_level + sub_level + noise.abs() * 0.5;
    (saw + pulse + sub * 0.82 + noise * 0.58) / level_sum.max(1.0).sqrt()
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

fn pan_gains(voice_index: usize, spread: f32) -> (f32, f32) {
    let positions = [-0.76, -0.44, -0.14, 0.14, 0.44, 0.76];
    let pan = positions[voice_index.min(VOICES - 1)] * spread.clamp(0.0, 1.0);
    (((1.0 - pan) * 0.5).sqrt(), ((1.0 + pan) * 0.5).sqrt())
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
    fn six_gated_voices_produce_bounded_stereo() {
        let mut module = Six::new();
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        for frame in 0..64 {
            inputs[0][frame] = 0.0;
            inputs[1][frame] = 4.0 / 12.0;
            inputs[2][frame] = 7.0 / 12.0;
            inputs[3][frame] = 12.0 / 12.0;
            inputs[4][frame] = 16.0 / 12.0;
            inputs[5][frame] = 19.0 / 12.0;
            for gate in 6..12 {
                inputs[gate][frame] = 1.0;
            }
            inputs[14][frame] = 0.75;
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
    fn chorus_changes_stereo_render() {
        let mut dry = Six::new();
        let mut wet = Six::new();
        dry.set_float_param(PARAM_CHORUS, 0.0);
        wet.set_float_param(PARAM_CHORUS, 2.0);
        wet.set_float_param(PARAM_CHORUS_MIX, 0.8);

        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut dry_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        let mut wet_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[6][..64].fill(1.0);
        inputs[14][..64].fill(0.8);

        for _ in 0..14 {
            dry.process_block(&context(), &inputs, &mut dry_outputs);
            wet.process_block(&context(), &inputs, &mut wet_outputs);
        }

        let mut difference = 0.0;
        for frame in 16..64 {
            difference += (dry_outputs[0][frame] - wet_outputs[0][frame]).abs();
            difference += (dry_outputs[1][frame] - wet_outputs[1][frame]).abs();
        }

        assert!(difference > 0.01);
    }
}

// Native MIDI adapter: per-voice velocity and allocation-free panic/reset.
impl crate::Instrument for Six {
    fn velocity(&mut self, voice: usize, value: f32) {
        if let Some(v) = self.midi_velocity.get_mut(voice) { *v = value.clamp(0.0, 1.0); }
    }
    fn silence(&mut self) { self.voices = [
                SixVoice::new(0.01, 0.09, -0.58),
                SixVoice::new(0.17, 0.23, -0.34),
                SixVoice::new(0.34, 0.39, -0.12),
                SixVoice::new(0.52, 0.57, 0.14),
                SixVoice::new(0.71, 0.73, 0.32),
                SixVoice::new(0.88, 0.91, 0.53),
            ];
self.left_dc = DcBlocker::new(); self.right_dc = DcBlocker::new();
self.chorus_left.clear(); self.chorus_right.clear(); }
}
