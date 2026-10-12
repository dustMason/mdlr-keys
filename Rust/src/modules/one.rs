use super::{
    dsp::{
        blep_pulse, blep_saw, one_pole_alpha, sanitize_audio, sine, smoothing, soft_clip,
        wrap_phase, DcBlocker, SmoothedValue,
    },
    BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor,
};

const PARAM_TUNE: u32 = 0;
const PARAM_RANGE: u32 = 1;
const PARAM_PULSE_WIDTH: u32 = 2;
const PARAM_PWM_MODE: u32 = 3;
const PARAM_PWM_AMOUNT: u32 = 4;
const PARAM_VCO_MOD: u32 = 5;
const PARAM_SAW: u32 = 6;
const PARAM_PULSE: u32 = 7;
const PARAM_SUB: u32 = 8;
const PARAM_SUB_MODE: u32 = 9;
const PARAM_NOISE: u32 = 10;
const PARAM_CUTOFF: u32 = 11;
const PARAM_RESONANCE: u32 = 12;
const PARAM_ENV_DEPTH: u32 = 13;
const PARAM_LFO_FILTER: u32 = 14;
const PARAM_KEY_FOLLOW: u32 = 15;
const PARAM_VCA_MODE: u32 = 16;
const PARAM_ATTACK: u32 = 17;
const PARAM_DECAY: u32 = 18;
const PARAM_SUSTAIN: u32 = 19;
const PARAM_RELEASE: u32 = 20;
const PARAM_TRIGGER_MODE: u32 = 21;
const PARAM_LFO_RATE: u32 = 22;
const PARAM_LFO_WAVE: u32 = 23;
const PARAM_PORTAMENTO: u32 = 24;
const PARAM_PORTAMENTO_MODE: u32 = 25;
const PARAM_LEVEL: u32 = 26;
const PARAM_DRIVE: u32 = 27;
const PARAM_ANALOG: u32 = 28;

const PARAM_SMOOTH_SECONDS: f32 = 0.016;
const FILTER_SMOOTH_SECONDS: f32 = 0.024;
const LFO_MIN_HZ: f32 = 0.05;
const LFO_MAX_HZ: f32 = 35.0;

pub const KIND: u32 = 68;
pub const INPUTS: usize = 5;
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
struct OneFilter {
    stages: [f32; 4],
    self_phase: f32,
}

impl OneFilter {
    const fn new() -> Self {
        Self {
            stages: [0.0; 4],
            self_phase: 0.0,
        }
    }

    fn process(
        &mut self,
        input: f32,
        cutoff_hz: f32,
        resonance: f32,
        drive: f32,
        sample_rate: f32,
    ) -> f32 {
        let cutoff = cutoff_hz.clamp(16.0, sample_rate.max(1.0) * 0.43);
        let g = one_pole_alpha(cutoff, sample_rate).clamp(0.000_035, 0.74);
        let resonance = resonance.clamp(0.0, 1.0);
        let feedback = resonance * (1.08 + resonance * 2.62);
        self.self_phase = wrap_phase(self.self_phase + cutoff / sample_rate.max(1.0));
        let self_amount = ((resonance - 0.82) / 0.18).clamp(0.0, 1.0);
        let self_osc = sine(self.self_phase) * self_amount * self_amount * 0.18;
        let mut sample = ((input - self.stages[3] * feedback + self_osc) * drive.max(0.05)).tanh();

        for (index, stage) in self.stages.iter_mut().enumerate() {
            *stage += (sample - *stage) * g;
            sample = if index == 1 || index == 2 {
                (*stage * (1.0 + resonance * 0.12)).tanh()
            } else {
                *stage
            };
            *stage = if stage.abs() < 1.0e-20 { 0.0 } else { *stage };
        }

        sanitize_audio(self.stages[3] * (1.0 + resonance * 0.42) + self_osc * 0.65)
    }
}

pub struct One {
    midi_velocity: [f32; 1],
    tune: SmoothedValue,
    range: SmoothedValue,
    pulse_width: SmoothedValue,
    pwm_mode: SmoothedValue,
    pwm_amount: SmoothedValue,
    vco_mod: SmoothedValue,
    saw: SmoothedValue,
    pulse: SmoothedValue,
    sub: SmoothedValue,
    sub_mode: SmoothedValue,
    noise: SmoothedValue,
    cutoff: SmoothedValue,
    resonance: SmoothedValue,
    env_depth: SmoothedValue,
    lfo_filter: SmoothedValue,
    key_follow: SmoothedValue,
    vca_mode: SmoothedValue,
    attack: SmoothedValue,
    decay: SmoothedValue,
    sustain: SmoothedValue,
    release: SmoothedValue,
    trigger_mode: SmoothedValue,
    lfo_rate: SmoothedValue,
    lfo_wave: SmoothedValue,
    portamento: SmoothedValue,
    portamento_mode: SmoothedValue,
    level: SmoothedValue,
    drive: SmoothedValue,
    analog: SmoothedValue,
    osc_phase: f32,
    sub_phase: f32,
    current_pitch: f32,
    env: f32,
    env_stage: EnvStage,
    gate_amp: f32,
    last_gate: bool,
    last_pitch_cv: f32,
    lfo_phase: f32,
    lfo_hold: f32,
    drift_phase: f32,
    noise_state: u32,
    filter: OneFilter,
    dc_blocker: DcBlocker,
}

impl One {
    pub fn new() -> Self {
        Self {
            midi_velocity: [1.0; 1],
            tune: SmoothedValue::new(0.0),
            range: SmoothedValue::new(1.0),
            pulse_width: SmoothedValue::new(0.52),
            pwm_mode: SmoothedValue::new(1.0),
            pwm_amount: SmoothedValue::new(0.22),
            vco_mod: SmoothedValue::new(0.04),
            saw: SmoothedValue::new(0.82),
            pulse: SmoothedValue::new(0.46),
            sub: SmoothedValue::new(0.44),
            sub_mode: SmoothedValue::new(0.0),
            noise: SmoothedValue::new(0.0),
            cutoff: SmoothedValue::new(0.58),
            resonance: SmoothedValue::new(0.2),
            env_depth: SmoothedValue::new(0.34),
            lfo_filter: SmoothedValue::new(0.0),
            key_follow: SmoothedValue::new(0.62),
            vca_mode: SmoothedValue::new(1.0),
            attack: SmoothedValue::new(0.003),
            decay: SmoothedValue::new(0.38),
            sustain: SmoothedValue::new(0.28),
            release: SmoothedValue::new(0.16),
            trigger_mode: SmoothedValue::new(1.0),
            lfo_rate: SmoothedValue::new(0.18),
            lfo_wave: SmoothedValue::new(0.0),
            portamento: SmoothedValue::new(0.08),
            portamento_mode: SmoothedValue::new(1.0),
            level: SmoothedValue::new(0.7),
            drive: SmoothedValue::new(0.16),
            analog: SmoothedValue::new(0.18),
            osc_phase: 0.01,
            sub_phase: 0.52,
            current_pitch: 0.0,
            env: 0.0,
            env_stage: EnvStage::Idle,
            gate_amp: 0.0,
            last_gate: false,
            last_pitch_cv: 0.0,
            lfo_phase: 0.0,
            lfo_hold: 0.0,
            drift_phase: 0.13,
            noise_state: 0x5101_1982,
            filter: OneFilter::new(),
            dc_blocker: DcBlocker::new(),
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

    fn advance_random(&mut self) -> f32 {
        let mut state = self.noise_state;
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        self.noise_state = state;
        self.lfo_hold = (state as f32 / u32::MAX as f32) * 2.0 - 1.0;
        self.lfo_hold
    }
}

impl ModuleProcessor for One {
    fn set_float_param(&mut self, param_id: u32, value: f32) {
        match param_id {
            PARAM_TUNE => self.tune.set_target(value.clamp(-24.0, 24.0)),
            PARAM_RANGE => self.range.set_target(value.round().clamp(0.0, 3.0)),
            PARAM_PULSE_WIDTH => self.pulse_width.set_target(value.clamp(0.04, 0.96)),
            PARAM_PWM_MODE => self.pwm_mode.set_target(value.round().clamp(0.0, 2.0)),
            PARAM_PWM_AMOUNT => self.pwm_amount.set_target(value.clamp(0.0, 1.0)),
            PARAM_VCO_MOD => self.vco_mod.set_target(value.clamp(0.0, 1.0)),
            PARAM_SAW => self.saw.set_target(value.clamp(0.0, 1.0)),
            PARAM_PULSE => self.pulse.set_target(value.clamp(0.0, 1.0)),
            PARAM_SUB => self.sub.set_target(value.clamp(0.0, 1.0)),
            PARAM_SUB_MODE => self.sub_mode.set_target(value.round().clamp(0.0, 2.0)),
            PARAM_NOISE => self.noise.set_target(value.clamp(0.0, 1.0)),
            PARAM_CUTOFF => self.cutoff.set_target(value.clamp(0.0, 1.0)),
            PARAM_RESONANCE => self.resonance.set_target(value.clamp(0.0, 1.0)),
            PARAM_ENV_DEPTH => self.env_depth.set_target(value.clamp(-1.0, 1.0)),
            PARAM_LFO_FILTER => self.lfo_filter.set_target(value.clamp(0.0, 1.0)),
            PARAM_KEY_FOLLOW => self.key_follow.set_target(value.clamp(0.0, 1.0)),
            PARAM_VCA_MODE => self.vca_mode.set_target(value.round().clamp(0.0, 1.0)),
            PARAM_ATTACK => self.attack.set_target(value.clamp(0.001, 3.0)),
            PARAM_DECAY => self.decay.set_target(value.clamp(0.01, 4.5)),
            PARAM_SUSTAIN => self.sustain.set_target(value.clamp(0.0, 1.0)),
            PARAM_RELEASE => self.release.set_target(value.clamp(0.01, 2.0)),
            PARAM_TRIGGER_MODE => self.trigger_mode.set_target(value.round().clamp(0.0, 2.0)),
            PARAM_LFO_RATE => self.lfo_rate.set_target(value.clamp(0.0, 1.0)),
            PARAM_LFO_WAVE => self.lfo_wave.set_target(value.round().clamp(0.0, 3.0)),
            PARAM_PORTAMENTO => self.portamento.set_target(value.clamp(0.0, 1.0)),
            PARAM_PORTAMENTO_MODE => self
                .portamento_mode
                .set_target(value.round().clamp(0.0, 1.0)),
            PARAM_LEVEL => self.level.set_target(value.clamp(0.0, 1.0)),
            PARAM_DRIVE => self.drive.set_target(value.clamp(0.0, 1.0)),
            PARAM_ANALOG => self.analog.set_target(value.clamp(0.0, 1.0)),
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
            let vco_mod = self.vco_mod.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let saw = self.saw.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let pulse = self.pulse.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sub = self.sub.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sub_mode = self
                .sub_mode
                .next(sample_rate, PARAM_SMOOTH_SECONDS)
                .round() as i32;
            let noise_level = self.noise.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let cutoff_param = self.cutoff.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let resonance = self.resonance.next(sample_rate, FILTER_SMOOTH_SECONDS);
            let env_depth = self.env_depth.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_filter = self.lfo_filter.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let key_follow = self.key_follow.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let vca_mode = self.vca_mode.next(sample_rate, PARAM_SMOOTH_SECONDS) >= 0.5;
            let attack = self.attack.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let decay = self.decay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sustain = self.sustain.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let release = self.release.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let trigger_mode = self
                .trigger_mode
                .next(sample_rate, PARAM_SMOOTH_SECONDS)
                .round() as i32;
            let lfo_rate = self.lfo_rate.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let lfo_wave = self
                .lfo_wave
                .next(sample_rate, PARAM_SMOOTH_SECONDS)
                .round() as i32;
            let portamento = self.portamento.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let portamento_mode = self
                .portamento_mode
                .next(sample_rate, PARAM_SMOOTH_SECONDS)
                .round() as i32;
            let level_param = self.level.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let drive = self.drive.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let analog = self.analog.next(sample_rate, PARAM_SMOOTH_SECONDS);

            let raw_pitch_cv = inputs[0][frame].clamp(-5.0, 5.0);
            let gate = inputs[1][frame] > 0.5;
            let cutoff_cv = inputs[2][frame].clamp(-1.0, 1.0);
            let mod_cv = inputs[3][frame].clamp(-1.0, 1.0);
            let level_cv = inputs[4][frame].clamp(-1.0, 1.0);
            let white_noise = self.next_noise();

            if gate && !self.last_gate && trigger_mode == 2 {
                self.lfo_phase = 0.0;
                self.advance_random();
            }
            let old_lfo_phase = self.lfo_phase;
            let lfo_hz = LFO_MIN_HZ * (LFO_MAX_HZ / LFO_MIN_HZ).powf(lfo_rate);
            self.lfo_phase = wrap_phase(self.lfo_phase + lfo_hz / sample_rate);
            let lfo_wrapped = self.lfo_phase < old_lfo_phase;
            if lfo_wrapped {
                self.advance_random();
            }
            let lfo = match lfo_wave {
                1 => {
                    if self.lfo_phase < 0.5 {
                        1.0
                    } else {
                        -1.0
                    }
                }
                2 => self.lfo_hold,
                3 => white_noise,
                _ => 1.0 - (self.lfo_phase - 0.5).abs() * 4.0,
            };

            let pitch_changed = (raw_pitch_cv - self.last_pitch_cv).abs() > 0.006;
            let trigger_env = gate
                && (!self.last_gate
                    || (trigger_mode == 1 && pitch_changed)
                    || (trigger_mode == 2 && lfo_wrapped));
            if trigger_env {
                self.env_stage = EnvStage::Attack;
            } else if !gate && self.last_gate {
                self.env_stage = EnvStage::Release;
            }

            let should_glide = portamento_mode == 1;
            if !gate || !should_glide {
                self.current_pitch = raw_pitch_cv;
            } else {
                let glide_seconds = 0.004 + portamento * portamento * 0.78;
                let glide_alpha = 1.0 - smoothing(glide_seconds, sample_rate);
                self.current_pitch += (raw_pitch_cv - self.current_pitch) * glide_alpha;
            }

            advance_envelope(
                &mut self.env,
                &mut self.env_stage,
                smoothing(attack, sample_rate),
                smoothing(decay, sample_rate),
                smoothing(release, sample_rate),
                sustain,
            );

            let env = self.env.clamp(0.0, 1.05);
            let gate_target = f32::from(gate);
            self.gate_amp += (gate_target - self.gate_amp) * (1.0 - smoothing(0.003, sample_rate));

            self.drift_phase = wrap_phase(self.drift_phase + 0.017 / sample_rate);
            let analog_depth = analog * analog;
            let drift = (sine(self.drift_phase) * 0.09 + white_noise * 0.006) * analog_depth;
            let range_offset = match range {
                0 => -12.0,
                2 => 12.0,
                3 => 24.0,
                _ => 0.0,
            };
            let mod_signal = (lfo + mod_cv * 0.85).clamp(-1.6, 1.6);
            let pitch_mod_semitones = mod_signal * vco_mod * vco_mod * 20.0;
            let base = note_to_hz(tune + range_offset + pitch_mod_semitones + drift)
                * 2.0_f32.powf(self.current_pitch);
            let pwm_mod = match pwm_mode {
                2 => env * 2.0 - 1.0,
                1 => mod_signal,
                _ => 0.0,
            };
            let width = (pulse_width + pwm_mod * pwm_amount * 0.43).clamp(0.035, 0.965);
            let osc = oscillator_sample(
                &mut self.osc_phase,
                &mut self.sub_phase,
                base,
                width,
                sub_mode,
                saw,
                pulse,
                sub,
                white_noise * noise_level,
                sample_rate,
            );

            let cutoff_octaves = cutoff_param * 7.7
                + cutoff_cv * 2.1
                + env * env_depth * 5.2
                + mod_signal * lfo_filter * 2.35
                + self.current_pitch * key_follow * 1.85;
            let cutoff = (22.0 * 2.0_f32.powf(cutoff_octaves)).clamp(16.0, sample_rate * 0.43);
            let filtered =
                self.filter
                    .process(osc, cutoff, resonance, 1.0 + drive * 5.0, sample_rate);
            let amp = if vca_mode { env } else { self.gate_amp };
            let level = (level_param + level_cv * 0.42).clamp(0.0, 1.0);
            let output = self
                .dc_blocker
                .process(filtered * amp * level * (1.42 + drive * 0.92));

            outputs[0][frame] = soft_clip(output) * self.midi_velocity[0];
            outputs[1][frame] = f32::from(gate);
            outputs[2][frame] = env.clamp(0.0, 1.0);
            outputs[3][frame] = lfo.clamp(-1.0, 1.0);

            self.last_gate = gate;
            self.last_pitch_cv = raw_pitch_cv;
        }
    }
}

fn oscillator_sample(
    phase: &mut f32,
    sub_phase: &mut f32,
    freq: f32,
    pulse_width: f32,
    sub_mode: i32,
    saw_level: f32,
    pulse_level: f32,
    sub_level: f32,
    noise: f32,
    sample_rate: f32,
) -> f32 {
    let freq = freq.clamp(6.0, sample_rate * 0.43);
    let inc = freq / sample_rate;
    let sub_ratio = if sub_mode <= 0 { 0.5 } else { 0.25 };
    let sub_width = if sub_mode == 2 { 0.25 } else { 0.5 };
    let sub_inc = (freq * sub_ratio) / sample_rate;
    let saw = -blep_saw(*phase, inc) * saw_level;
    let pulse = blep_pulse(*phase, pulse_width, inc) * pulse_level;
    let sub = blep_pulse(*sub_phase, sub_width, sub_inc) * sub_level * 0.9;
    *phase = wrap_phase(*phase + inc);
    *sub_phase = wrap_phase(*sub_phase + sub_inc);
    let level_sum = saw_level + pulse_level + sub_level + noise.abs() * 0.56;
    (saw + pulse + sub + noise * 0.58) / level_sum.max(1.0).sqrt()
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

fn note_to_hz(tune_semitones: f32) -> f32 {
    let midi = 48.0 + tune_semitones;
    440.0 * 2.0_f32.powf((midi - 69.0) / 12.0)
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
    fn gated_voice_produces_bounded_audio_and_controls() {
        let mut module = One::new();
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[1][..64].fill(1.0);
        inputs[4][..64].fill(0.7);

        for _ in 0..8 {
            module.process_block(&context(), &inputs, &mut outputs);
        }

        assert!(outputs[0][40].abs() > 0.000_1);
        assert!(outputs[0][40].abs() <= 1.0);
        assert_eq!(outputs[1][40], 1.0);
        assert!(outputs[2][40] > 0.0);
        assert!(outputs[3][40].abs() <= 1.0);
    }

    #[test]
    fn high_resonance_remains_bounded() {
        let mut module = One::new();
        module.set_float_param(PARAM_RESONANCE, 1.0);
        module.set_float_param(PARAM_CUTOFF, 0.72);
        module.set_float_param(PARAM_LEVEL, 1.0);
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[1][..64].fill(1.0);

        for _ in 0..24 {
            module.process_block(&context(), &inputs, &mut outputs);
        }

        for sample in &outputs[0][..64] {
            assert!(sample.is_finite());
            assert!(sample.abs() <= 1.0);
        }
    }

    #[test]
    fn gate_trig_mode_restarts_envelope_on_pitch_change() {
        let mut module = One::new();
        module.set_float_param(PARAM_TRIGGER_MODE, 1.0);
        module.set_float_param(PARAM_ATTACK, 0.001);
        module.set_float_param(PARAM_DECAY, 0.05);
        module.set_float_param(PARAM_SUSTAIN, 0.0);
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[1][..64].fill(1.0);

        for _ in 0..40 {
            module.process_block(&context(), &inputs, &mut outputs);
        }
        module.env = 0.0;
        module.env_stage = EnvStage::Sustain;
        for frame in 0..64 {
            inputs[0][frame] = 7.0 / 12.0;
        }
        module.process_block(&context(), &inputs, &mut outputs);

        assert!(outputs[2][8] > 0.02);
    }
}

// Native MIDI adapter: per-voice velocity and allocation-free panic/reset.
impl crate::Instrument for One {
    fn velocity(&mut self, voice: usize, value: f32) {
        if let Some(v) = self.midi_velocity.get_mut(voice) { *v = value.clamp(0.0, 1.0); }
    }
    fn silence(&mut self) { self.env = 0.0; self.env_stage = EnvStage::Idle; self.gate_amp = 0.0; self.last_gate = false; self.filter = OneFilter::new(); self.dc_blocker = DcBlocker::new(); }
}
