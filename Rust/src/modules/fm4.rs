use super::{
    dsp::{sanitize_audio, sine, smoothing, soft_clip, wrap_phase, DcBlocker, SmoothedValue},
    BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor,
};

const OPERATORS: usize = 4;
const VOICES: usize = 4;
const OP_B: usize = 0;
const OP_G: usize = 1;
const OP_W: usize = 2;
const OP_O: usize = 3;

const PARAM_INTENSITY: u32 = 0;
const PARAM_FREQUENCY: u32 = 1;
const PARAM_TOPOLOGY: u32 = 2;
const PARAM_DETUNE: u32 = 3;
const PARAM_ATTACK: u32 = 4;
const PARAM_DECAY: u32 = 5;
const PARAM_SUSTAIN: u32 = 6;
const PARAM_RELEASE: u32 = 7;

const DEFAULT_INTENSITY: f32 = 0.22;
const DEFAULT_FREQUENCY: f32 = 78.0;
const DEFAULT_TOPOLOGY: f32 = 1.0;
const DEFAULT_DETUNE: f32 = 0.08;
const OP_RATIO_MIN: f32 = 1.0 / 64.0;
const OP_RATIO_MAX: f32 = 16.0;
const DEFAULT_ATTACK: f32 = 0.01;
const DEFAULT_DECAY: f32 = 0.72;
const DEFAULT_SUSTAIN: f32 = 0.74;
const DEFAULT_RELEASE: f32 = 0.03;
const MAX_INTENSITY: f32 = 0.55;
const PARAM_SMOOTH_SECONDS: f32 = 0.012;
const EVAL_ORDER: [usize; OPERATORS] = [OP_O, OP_W, OP_G, OP_B];

pub const KIND: u32 = 34;
pub const INPUTS: usize = 12;
pub const OUTPUTS: usize = 4;

#[derive(Clone, Copy, PartialEq, Eq)]
enum EnvStage {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy)]
struct Fm4Voice {
    phases: [f32; OPERATORS],
    previous: [f32; OPERATORS],
    current_pitch: f32,
    amp_env: f32,
    env_stage: EnvStage,
    last_gate: bool,
}

impl Fm4Voice {
    const fn new(phase: f32) -> Self {
        Self {
            phases: [
                wrap_const(phase),
                wrap_const(phase + 0.19),
                wrap_const(phase + 0.37),
                wrap_const(phase + 0.61),
            ],
            previous: [0.0; OPERATORS],
            current_pitch: 0.0,
            amp_env: 0.0,
            env_stage: EnvStage::Idle,
            last_gate: false,
        }
    }
}

pub struct Fm4 {
    midi_velocity: [f32; 4],
    intensity: SmoothedValue,
    frequency: SmoothedValue,
    topology: SmoothedValue,
    detune: SmoothedValue,
    attack: SmoothedValue,
    decay: SmoothedValue,
    sustain: SmoothedValue,
    release: SmoothedValue,
    voices: [Fm4Voice; VOICES],
    left_dc: DcBlocker,
    right_dc: DcBlocker,
}

impl Fm4 {
    pub fn new() -> Self {
        Self {
            midi_velocity: [1.0; 4],
            intensity: SmoothedValue::new(DEFAULT_INTENSITY),
            frequency: SmoothedValue::new(DEFAULT_FREQUENCY),
            topology: SmoothedValue::new(DEFAULT_TOPOLOGY),
            detune: SmoothedValue::new(DEFAULT_DETUNE),
            attack: SmoothedValue::new(DEFAULT_ATTACK),
            decay: SmoothedValue::new(DEFAULT_DECAY),
            sustain: SmoothedValue::new(DEFAULT_SUSTAIN),
            release: SmoothedValue::new(DEFAULT_RELEASE),
            voices: [
                Fm4Voice::new(0.0),
                Fm4Voice::new(0.17),
                Fm4Voice::new(0.31),
                Fm4Voice::new(0.47),
            ],
            left_dc: DcBlocker::new(),
            right_dc: DcBlocker::new(),
        }
    }
}

impl ModuleProcessor for Fm4 {
    fn set_float_param(&mut self, param_id: u32, value: f32) {
        match param_id {
            PARAM_INTENSITY => self.intensity.set_target(value.clamp(0.0, MAX_INTENSITY)),
            PARAM_FREQUENCY => self.frequency.set_target(value.round().clamp(0.0, 101.0)),
            PARAM_TOPOLOGY => self.topology.set_target(value.round().clamp(0.0, 8.0)),
            PARAM_DETUNE => self.detune.set_target(value.clamp(0.0, 1.0)),
            PARAM_ATTACK => self.attack.set_target(value.clamp(0.001, 2.0)),
            PARAM_DECAY => self.decay.set_target(value.clamp(0.02, 4.0)),
            PARAM_SUSTAIN => self.sustain.set_target(value.clamp(0.0, 1.0)),
            PARAM_RELEASE => self.release.set_target(value.clamp(0.02, 5.0)),
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
            let intensity = (self.intensity.next(sample_rate, PARAM_SMOOTH_SECONDS)
                + inputs[8][frame] * 0.35)
                .clamp(0.0, MAX_INTENSITY);
            let frequency = (self.frequency.next(sample_rate, PARAM_SMOOTH_SECONDS)
                + inputs[9][frame] * 24.0)
                .clamp(0.0, 101.0);
            let topology = (self.topology.next(sample_rate, PARAM_SMOOTH_SECONDS)
                + inputs[10][frame] * 4.0)
                .clamp(0.0, 8.0);
            let detune = (self.detune.next(sample_rate, PARAM_SMOOTH_SECONDS)
                + inputs[11][frame] * 0.35)
                .clamp(0.0, 1.0);
            let attack = self.attack.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let decay = self.decay.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let sustain = self.sustain.next(sample_rate, PARAM_SMOOTH_SECONDS);
            let release = self.release.next(sample_rate, PARAM_SMOOTH_SECONDS);

            let ratios = operator_ratios(frequency, detune);
            let topology = topology_for(topology.round() as usize);
            let color = intensity.powf(1.28);
            let phase_depth = 0.06 + intensity.powf(1.45) * 2.95;
            let operator_levels = [1.0, color, color, color];
            let feedback = intensity.powf(2.0) * (0.05 + detune.powf(1.3) * 0.34);
            let mut left = 0.0;
            let mut right = 0.0;
            let mut env_peak = 0.0_f32;
            let mut gate_out = 0.0;

            for voice_index in 0..VOICES {
                let pitch = inputs[voice_index][frame].clamp(-5.0, 5.0);
                let gate = inputs[voice_index + VOICES][frame] > 0.5;
                let voice = &mut self.voices[voice_index];
                if gate && !voice.last_gate {
                    voice.current_pitch = pitch;
                }
                if gate {
                    voice.current_pitch += (pitch - voice.current_pitch) * 0.16;
                    gate_out = 1.0;
                }
                let amp_env =
                    advance_envelope(voice, gate, attack, decay, sustain, release, sample_rate);
                env_peak = env_peak.max(amp_env);

                let base_hz = note_to_hz(voice.current_pitch);
                let mut ops = [0.0_f32; OPERATORS];
                for op in EVAL_ORDER {
                    let mut phase_mod = 0.0;
                    for route_index in 0..topology.route_count {
                        let route = topology.routes[route_index];
                        if route.target != op {
                            continue;
                        }
                        let source = if route.source == op {
                            voice.previous[route.source]
                        } else {
                            ops[route.source]
                        };
                        phase_mod += source * route.amount * phase_depth;
                    }
                    if op == OP_O {
                        phase_mod += voice.previous[OP_O] * feedback;
                    }
                    let freq = (base_hz * ratios[op]).clamp(1.0, sample_rate * 0.46);
                    voice.phases[op] = wrap_phase(voice.phases[op] + freq / sample_rate);
                    ops[op] = sine(wrap_phase(voice.phases[op] + phase_mod)) * operator_levels[op];
                }
                voice.previous = ops;

                let mut mono = 0.0;
                for op in 0..OPERATORS {
                    if topology.carriers[op] {
                        mono += ops[op] * topology.carrier_gains[op];
                    }
                }
                mono *= self.midi_velocity[voice_index] * amp_env * 0.74 / VOICES as f32;
                let pan = (voice_index as f32 - 1.5) * 0.13 + detune * color * 0.18;
                left += mono * (0.5 - pan * 0.5).clamp(0.0, 1.0);
                right += mono * (0.5 + pan * 0.5).clamp(0.0, 1.0);
            }

            outputs[0][frame] = sanitize_audio(self.left_dc.process(soft_clip(left * 2.0)));
            outputs[1][frame] = sanitize_audio(self.right_dc.process(soft_clip(right * 2.0)));
            outputs[2][frame] = env_peak;
            outputs[3][frame] = gate_out;
        }
    }
}

#[derive(Clone, Copy)]
struct Route {
    source: usize,
    target: usize,
    amount: f32,
}

#[derive(Clone, Copy)]
struct Topology {
    routes: [Route; 4],
    route_count: usize,
    carriers: [bool; OPERATORS],
    carrier_gains: [f32; OPERATORS],
}

fn topology_for(index: usize) -> Topology {
    let empty = Route {
        source: OP_O,
        target: OP_O,
        amount: 0.0,
    };
    match index % 9 {
        0 => topology(
            [
                route(OP_O, OP_W, 1.0),
                route(OP_W, OP_G, 1.0),
                route(OP_G, OP_B, 1.0),
                empty,
            ],
            3,
            [true, false, false, false],
        ),
        1 => topology(
            [route(OP_O, OP_G, 1.0), route(OP_G, OP_B, 1.0), empty, empty],
            2,
            [true, false, true, false],
        ),
        2 => topology(
            [route(OP_W, OP_B, 1.0), route(OP_O, OP_G, 1.0), empty, empty],
            2,
            [true, true, false, false],
        ),
        3 => topology(
            [
                route(OP_O, OP_W, 1.0),
                route(OP_O, OP_G, 1.0),
                route(OP_W, OP_B, 1.0),
                route(OP_G, OP_B, 1.0),
            ],
            4,
            [true, false, false, false],
        ),
        4 => topology(
            [
                route(OP_O, OP_W, 1.0),
                route(OP_W, OP_G, 1.0),
                route(OP_W, OP_B, 1.0),
                empty,
            ],
            3,
            [true, true, false, false],
        ),
        5 => topology(
            [route(OP_O, OP_G, 1.0), route(OP_W, OP_G, 1.0), empty, empty],
            2,
            [true, true, false, false],
        ),
        6 => topology(
            [route(OP_O, OP_G, 1.0), route(OP_W, OP_B, 1.0), empty, empty],
            2,
            [true, true, false, false],
        ),
        7 => topology(
            [route(OP_O, OP_G, 1.0), empty, empty, empty],
            1,
            [true, true, true, false],
        ),
        _ => topology([empty, empty, empty, empty], 0, [true; OPERATORS]),
    }
}

const fn route(source: usize, target: usize, amount: f32) -> Route {
    Route {
        source,
        target,
        amount,
    }
}

fn topology(routes: [Route; 4], route_count: usize, carriers: [bool; OPERATORS]) -> Topology {
    let count = carriers.iter().filter(|carrier| **carrier).count().max(1) as f32;
    let shared = 1.0 / count.sqrt();
    let mut carrier_gains = [0.0; OPERATORS];
    for op in 0..OPERATORS {
        carrier_gains[op] = if carriers[op] { shared } else { 0.0 };
    }
    Topology {
        routes,
        route_count,
        carriers,
        carrier_gains,
    }
}

fn operator_ratios(frequency: f32, detune: f32) -> [f32; OPERATORS] {
    let (green, white, orange) = FM4_FREQUENCY_SETS[frequency.round().clamp(0.0, 101.0) as usize];
    let detune = detune.clamp(0.0, 1.0).powf(1.35);
    [
        1.0,
        detuned_ratio(green, -0.22 * detune),
        detuned_ratio(white, 0.54 * detune),
        detuned_ratio(orange, -1.18 * detune),
    ]
}

fn advance_envelope(
    voice: &mut Fm4Voice,
    gate: bool,
    attack: f32,
    decay: f32,
    sustain: f32,
    release: f32,
    sample_rate: f32,
) -> f32 {
    if gate && !voice.last_gate {
        voice.env_stage = EnvStage::Attack;
    } else if !gate && voice.last_gate {
        voice.env_stage = EnvStage::Release;
    }

    if gate {
        match voice.env_stage {
            EnvStage::Idle | EnvStage::Release => {
                voice.env_stage = EnvStage::Attack;
            }
            EnvStage::Attack => {
                let alpha = 1.0 - smoothing(attack, sample_rate);
                voice.amp_env += (1.0 - voice.amp_env) * alpha;
                if attack <= 0.0015 || voice.amp_env >= 0.995 {
                    voice.amp_env = 1.0;
                    voice.env_stage = EnvStage::Decay;
                }
            }
            EnvStage::Decay => {
                voice.amp_env = sustain + (voice.amp_env - sustain) * smoothing(decay, sample_rate);
                if (voice.amp_env - sustain).abs() < 0.002 {
                    voice.amp_env = sustain;
                    voice.env_stage = EnvStage::Sustain;
                }
            }
            EnvStage::Sustain => {
                voice.amp_env = sustain;
            }
        }
    } else if voice.amp_env > 0.000_01 {
        voice.amp_env *= smoothing(release, sample_rate);
    } else {
        voice.amp_env = 0.0;
        voice.env_stage = EnvStage::Idle;
    }

    voice.last_gate = gate;
    voice.amp_env.clamp(0.0, 1.0)
}

fn detuned_ratio(ratio: f32, semitones: f32) -> f32 {
    (ratio * 2.0_f32.powf(semitones / 12.0)).clamp(OP_RATIO_MIN, OP_RATIO_MAX)
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

fn note_to_hz(pitch_cv: f32) -> f32 {
    130.812_79 * 2.0_f32.powf(pitch_cv)
}

#[rustfmt::skip]
const FM4_FREQUENCY_SETS: [(f32, f32, f32); 102] = [
    (1.0 / 64.0, 2.0, 1.0 / 16.0),
    (1.0 / 64.0, 2.0, 2.0),
    (1.0 / 64.0, 1.5, 5.0 / 8.0),
    (1.0 / 64.0, 1.5, 4.0),
    (1.0 / 64.0, 1.0, 1.75),
    (1.0 / 64.0, 0.5, 7.0 / 16.0),
    (1.0 / 64.0, 0.5, 3.5),
    (1.0 / 64.0, 3.0 / 4.0, 1.0),
    (1.0 / 64.0, 1.0 / 4.0, 1.0 / 16.0),
    (1.0 / 64.0, 1.0 / 4.0, 2.0),
    (1.0 / 64.0, 5.0 / 32.0, 5.0 / 8.0),
    (1.0 / 64.0, 1.0 / 32.0, 1.0 / 16.0),
    (1.0 / 64.0, 1.0 / 32.0, 2.0),
    (3.0 / 32.0, 2.0, 5.0 / 8.0),
    (3.0 / 32.0, 2.0, 4.0),
    (3.0 / 32.0, 1.5, 1.75),
    (3.0 / 32.0, 1.0, 7.0 / 16.0),
    (3.0 / 32.0, 1.0, 3.5),
    (3.0 / 32.0, 0.5, 1.0),
    (3.0 / 32.0, 3.0 / 4.0, 1.0 / 16.0),
    (3.0 / 32.0, 3.0 / 4.0, 3.5),
    (3.0 / 32.0, 1.0 / 4.0, 1.0),
    (3.0 / 32.0, 5.0 / 32.0, 1.0 / 16.0),
    (3.0 / 32.0, 5.0 / 32.0, 2.0),
    (3.0 / 32.0, 1.0 / 32.0, 5.0 / 8.0),
    (3.0 / 32.0, 1.0 / 32.0, 4.0),
    (1.0 / 8.0, 2.0, 1.75),
    (1.0 / 8.0, 1.5, 7.0 / 16.0),
    (1.0 / 8.0, 1.5, 3.5),
    (1.0 / 8.0, 1.0, 1.0),
    (1.0 / 8.0, 0.5, 1.0 / 16.0),
    (1.0 / 8.0, 0.5, 2.0),
    (1.0 / 8.0, 3.0 / 4.0, 5.0 / 8.0),
    (1.0 / 8.0, 1.0 / 4.0, 1.0 / 16.0),
    (1.0 / 8.0, 1.0 / 4.0, 2.0),
    (1.0 / 8.0, 5.0 / 32.0, 5.0 / 8.0),
    (1.0 / 8.0, 5.0 / 32.0, 4.0),
    (1.0 / 8.0, 1.0 / 32.0, 1.75),
    (5.0 / 16.0, 2.0, 7.0 / 16.0),
    (5.0 / 16.0, 2.0, 3.5),
    (5.0 / 16.0, 1.5, 1.0),
    (5.0 / 16.0, 1.0, 1.0 / 16.0),
    (5.0 / 16.0, 1.0, 2.0),
    (5.0 / 16.0, 0.5, 1.0),
    (5.0 / 16.0, 3.0 / 4.0, 1.0 / 16.0),
    (5.0 / 16.0, 3.0 / 4.0, 2.0),
    (5.0 / 16.0, 1.0 / 4.0, 5.0 / 8.0),
    (5.0 / 16.0, 1.0 / 4.0, 4.0),
    (5.0 / 16.0, 5.0 / 32.0, 1.75),
    (5.0 / 16.0, 1.0 / 32.0, 7.0 / 16.0),
    (5.0 / 16.0, 1.0 / 32.0, 3.5),
    (0.5, 2.0, 1.0),
    (0.5, 1.5, 1.0 / 16.0),
    (0.5, 1.5, 2.0),
    (0.5, 1.0, 1.0),
    (0.5, 0.5, 1.0 / 16.0),
    (0.5, 0.5, 2.0),
    (0.5, 0.5, 5.0 / 8.0),
    (0.5, 3.0 / 4.0, 4.0),
    (0.5, 1.0 / 4.0, 1.75),
    (0.5, 5.0 / 32.0, 7.0 / 16.0),
    (0.5, 5.0 / 32.0, 3.5),
    (0.5, 1.0 / 32.0, 1.0),
    (5.0 / 8.0, 2.0, 1.0 / 16.0),
    (5.0 / 8.0, 2.0, 2.0),
    (5.0 / 8.0, 1.5, 1.0),
    (5.0 / 8.0, 1.0, 1.0 / 16.0),
    (5.0 / 8.0, 1.0, 2.0),
    (5.0 / 8.0, 0.5, 5.0 / 8.0),
    (5.0 / 8.0, 0.5, 4.0),
    (5.0 / 8.0, 3.0 / 4.0, 1.75),
    (5.0 / 8.0, 1.0 / 4.0, 7.0 / 16.0),
    (5.0 / 8.0, 1.0 / 4.0, 3.5),
    (5.0 / 8.0, 5.0 / 32.0, 1.0),
    (5.0 / 8.0, 1.0 / 32.0, 7.0 / 16.0),
    (5.0 / 8.0, 1.0 / 32.0, 3.5),
    (1.0, 2.0, 1.0),
    (1.0, 1.5, 1.0 / 16.0),
    (1.0, 1.5, 2.0),
    (1.0, 1.0, 5.0 / 8.0),
    (1.0, 1.0, 4.0),
    (1.0, 0.5, 1.75),
    (1.0, 3.0 / 4.0, 7.0 / 16.0),
    (1.0, 3.0 / 4.0, 3.5),
    (1.0, 1.0 / 4.0, 1.75),
    (1.0, 5.0 / 32.0, 7.0 / 16.0),
    (1.0, 5.0 / 32.0, 3.5),
    (1.0, 1.0 / 32.0, 1.0),
    (2.0, 2.0, 1.0 / 16.0),
    (2.0, 2.0, 2.0),
    (2.0, 1.5, 5.0 / 8.0),
    (2.0, 1.5, 4.0),
    (2.0, 1.0, 1.75),
    (2.0, 0.5, 7.0 / 16.0),
    (2.0, 0.5, 4.0),
    (2.0, 3.0 / 4.0, 1.75),
    (2.0, 1.0 / 4.0, 7.0 / 16.0),
    (2.0, 1.0 / 4.0, 3.5),
    (2.0, 5.0 / 32.0, 1.0),
    (2.0, 1.0 / 32.0, 1.0 / 16.0),
    (2.0, 1.0 / 32.0, 2.0),
    (2.0, 1.0 / 32.0, 4.0),
];

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
    fn gate_produces_bounded_audio() {
        let mut fm = Fm4::new();
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[4][..64].fill(1.0);

        for _ in 0..4 {
            fm.process_block(&context(), &inputs, &mut outputs);
        }

        assert!(outputs[0][48].is_finite());
        assert!(outputs[1][48].is_finite());
        assert!(outputs[0][48].abs() < 1.0);
        assert!(outputs[1][48].abs() < 1.0);
        assert!(outputs[2][48] > 0.1);
    }

    #[test]
    fn movement_macros_change_timbre() {
        let mut plain = Fm4::new();
        let mut bright = Fm4::new();
        plain.set_float_param(PARAM_INTENSITY, 0.04);
        plain.set_float_param(PARAM_FREQUENCY, 0.0);
        plain.set_float_param(PARAM_TOPOLOGY, 0.0);
        plain.set_float_param(PARAM_DETUNE, 0.0);
        bright.set_float_param(PARAM_INTENSITY, 0.94);
        bright.set_float_param(PARAM_FREQUENCY, 101.0);
        bright.set_float_param(PARAM_TOPOLOGY, 8.0);
        bright.set_float_param(PARAM_DETUNE, 0.46);

        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut plain_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        let mut bright_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[4][..64].fill(1.0);

        for _ in 0..8 {
            plain.process_block(&context(), &inputs, &mut plain_outputs);
            bright.process_block(&context(), &inputs, &mut bright_outputs);
        }

        let mut difference = 0.0;
        for frame in 16..64 {
            difference += (plain_outputs[0][frame] - bright_outputs[0][frame]).abs();
            difference += (plain_outputs[1][frame] - bright_outputs[1][frame]).abs();
        }

        assert!(difference > 0.05);
    }

    #[test]
    fn minimum_intensity_ignores_frequency_topology_and_detune() {
        let mut first = Fm4::new();
        let mut second = Fm4::new();
        first.intensity.reset(0.0);
        first.frequency.reset(0.0);
        first.topology.reset(0.0);
        first.detune.reset(0.0);
        second.intensity.reset(0.0);
        second.frequency.reset(101.0);
        second.topology.reset(0.0);
        second.detune.reset(1.0);

        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut first_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        let mut second_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        inputs[4][..64].fill(1.0);

        for _ in 0..8 {
            first.process_block(&context(), &inputs, &mut first_outputs);
            second.process_block(&context(), &inputs, &mut second_outputs);
        }

        let mut difference = 0.0;
        for frame in 16..64 {
            difference += (first_outputs[0][frame] - second_outputs[0][frame]).abs();
            difference += (first_outputs[1][frame] - second_outputs[1][frame]).abs();
        }

        assert!(difference < 0.000_1, "difference {difference}");
    }

    #[test]
    fn minimum_intensity_keeps_base_audible_for_all_topologies() {
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        inputs[4][..64].fill(1.0);

        for topology in 0..=8 {
            let mut synth = Fm4::new();
            synth.intensity.reset(0.0);
            synth.topology.reset(topology as f32);

            let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
            for _ in 0..8 {
                synth.process_block(&context(), &inputs, &mut outputs);
            }

            let energy: f32 = outputs[0][16..64]
                .iter()
                .chain(outputs[1][16..64].iter())
                .map(|sample| sample.abs())
                .sum();
            assert!(energy > 0.05, "topology {topology} energy {energy}");
        }
    }

    #[test]
    fn amp_release_controls_tail() {
        let mut short = Fm4::new();
        let mut long = Fm4::new();
        short.set_float_param(PARAM_RELEASE, 0.02);
        long.set_float_param(PARAM_RELEASE, 1.2);

        let mut gated_inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let release_inputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_INPUTS];
        let mut short_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        let mut long_outputs = [[0.0; MAX_BLOCK_FRAMES]; MAX_OUTPUTS];
        gated_inputs[4][..64].fill(1.0);

        for _ in 0..20 {
            short.process_block(&context(), &gated_inputs, &mut short_outputs);
            long.process_block(&context(), &gated_inputs, &mut long_outputs);
        }
        for _ in 0..20 {
            short.process_block(&context(), &release_inputs, &mut short_outputs);
            long.process_block(&context(), &release_inputs, &mut long_outputs);
        }

        assert!(long_outputs[2][63] > short_outputs[2][63] * 2.0);
    }
}

// Native MIDI adapter: per-voice velocity and allocation-free panic/reset.
impl crate::Instrument for Fm4 {
    fn velocity(&mut self, voice: usize, value: f32) {
        if let Some(v) = self.midi_velocity.get_mut(voice) { *v = value.clamp(0.0, 1.0); }
    }
    fn silence(&mut self) { self.voices = [
                Fm4Voice::new(0.0),
                Fm4Voice::new(0.17),
                Fm4Voice::new(0.31),
                Fm4Voice::new(0.47),
            ];
self.left_dc = DcBlocker::new(); self.right_dc = DcBlocker::new(); }
}
