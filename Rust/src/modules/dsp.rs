use core::f32::consts::TAU;

const DENORMAL_LIMIT: f32 = 1.0e-20;

pub fn one_pole_alpha(cutoff_hz: f32, sample_rate: f32) -> f32 {
    let normalized = (TAU * cutoff_hz.max(1.0) / sample_rate.max(1.0)).clamp(0.0, 12.0);
    (1.0 - (-normalized).exp()).clamp(0.000_01, 0.98)
}

pub fn smoothing(seconds: f32, sample_rate: f32) -> f32 {
    (-1.0 / (seconds.max(0.000_5) * sample_rate.max(1.0))).exp()
}

pub fn soft_clip(sample: f32) -> f32 {
    let clipped = sample.clamp(-4.0, 4.0);
    clipped / (1.0 + clipped.abs() * 0.38)
}

pub fn flush_denormal(sample: f32) -> f32 {
    if sample.abs() < DENORMAL_LIMIT {
        0.0
    } else {
        sample
    }
}

pub fn sanitize_audio(sample: f32) -> f32 {
    if sample.is_finite() {
        flush_denormal(sample.clamp(-8.0, 8.0))
    } else {
        0.0
    }
}

pub fn sanitize_control(value: f32, fallback: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        fallback
    }
}

pub fn wrap_phase(phase: f32) -> f32 {
    phase.rem_euclid(1.0)
}

pub fn sine(phase: f32) -> f32 {
    (phase * TAU).sin()
}

pub fn poly_blep(phase: f32, phase_inc: f32) -> f32 {
    let dt = phase_inc.clamp(0.000_001, 0.49);
    if phase < dt {
        let t = phase / dt;
        t + t - t * t - 1.0
    } else if phase > 1.0 - dt {
        let t = (phase - 1.0) / dt;
        t * t + t + t + 1.0
    } else {
        0.0
    }
}

pub fn blep_saw(phase: f32, phase_inc: f32) -> f32 {
    phase * 2.0 - 1.0 - poly_blep(phase, phase_inc)
}

pub fn blep_pulse(phase: f32, width: f32, phase_inc: f32) -> f32 {
    let phase = wrap_phase(sanitize_control(phase, 0.0));
    let phase_inc = sanitize_control(phase_inc, 0.000_001)
        .abs()
        .clamp(0.000_001, 0.49);
    let min_width = phase_inc * 2.0;
    let max_width = 1.0 - min_width;
    if min_width >= max_width {
        return sine(phase);
    }

    let width = sanitize_control(width, 0.5).clamp(min_width, max_width);
    let mut value = if phase < width { 1.0 } else { -1.0 };
    value += poly_blep(phase, phase_inc);
    value -= poly_blep(wrap_phase(phase - width), phase_inc);
    sanitize_audio(value)
}

#[derive(Clone, Copy)]
pub struct SmoothedValue {
    current: f32,
    target: f32,
}

impl SmoothedValue {
    pub const fn new(value: f32) -> Self {
        Self {
            current: value,
            target: value,
        }
    }

    #[cfg(test)]
    pub fn current(&self) -> f32 {
        self.current
    }

    pub fn target(&self) -> f32 {
        self.target
    }

    pub fn set_target(&mut self, target: f32) {
        self.target = sanitize_control(target, self.target);
    }

    pub fn reset(&mut self, value: f32) {
        let value = sanitize_control(value, 0.0);
        self.current = value;
        self.target = value;
    }

    pub fn next(&mut self, sample_rate: f32, seconds: f32) -> f32 {
        self.next_one_pole(sample_rate, seconds)
    }

    pub fn next_one_pole(&mut self, sample_rate: f32, seconds: f32) -> f32 {
        let alpha = 1.0 - smoothing(seconds, sample_rate);
        self.current += (self.target - self.current) * alpha;
        if (self.current - self.target).abs() < 0.000_001 {
            self.current = self.target;
        }
        self.current = flush_denormal(sanitize_control(self.current, self.target));
        self.current
    }
}

#[derive(Clone, Copy)]
pub struct Crossfade {
    position: u32,
    duration: u32,
}

impl Crossfade {
    pub const fn complete() -> Self {
        Self {
            position: 1,
            duration: 1,
        }
    }

    pub fn start_samples(&mut self, samples: u32) {
        self.duration = samples.max(1);
        self.position = 0;
    }

    pub fn start_seconds(&mut self, sample_rate: f32, seconds: f32) {
        let samples = (sample_rate.max(1.0) * seconds.max(0.0)).round() as u32;
        self.start_samples(samples);
    }

    pub fn reset_complete(&mut self) {
        self.duration = 1;
        self.position = 1;
    }

    pub fn is_active(&self) -> bool {
        self.position < self.duration
    }

    pub fn progress(&self) -> f32 {
        if self.duration <= 1 {
            1.0
        } else {
            (self.position as f32 / self.duration as f32).clamp(0.0, 1.0)
        }
    }

    pub fn advance(&mut self) -> f32 {
        let progress = self.progress();
        if self.position < self.duration {
            self.position += 1;
        }
        progress
    }

    pub fn advance_linear_gains(&mut self) -> (f32, f32) {
        let wet = self.advance();
        (1.0 - wet, wet)
    }
}

pub fn equal_power_gains(progress: f32) -> (f32, f32) {
    let progress = progress.clamp(0.0, 1.0);
    (
        (progress * core::f32::consts::FRAC_PI_2).cos(),
        (progress * core::f32::consts::FRAC_PI_2).sin(),
    )
}

#[derive(Clone, Copy)]
pub struct DeclickEnvelope {
    value: f32,
    target: f32,
}

impl DeclickEnvelope {
    pub const fn open() -> Self {
        Self {
            value: 1.0,
            target: 1.0,
        }
    }

    pub fn set_open(&mut self, open: bool) {
        self.target = if open { 1.0 } else { 0.0 };
    }

    pub fn release(&mut self) {
        self.target = 0.0;
    }

    pub fn next(&mut self, sample_rate: f32, attack_seconds: f32, release_seconds: f32) -> f32 {
        let seconds = if self.target > self.value {
            attack_seconds
        } else {
            release_seconds
        };
        let alpha = 1.0 - smoothing(seconds, sample_rate);
        self.value += (self.target - self.value) * alpha;
        if (self.value - self.target).abs() < 0.000_001 {
            self.value = self.target;
        }
        self.value = sanitize_audio(self.value).clamp(0.0, 1.0);
        self.value
    }
}

#[derive(Clone, Copy)]
pub struct SignalPresence {
    value: f32,
    hold_samples: u32,
}

impl SignalPresence {
    pub const fn new() -> Self {
        Self {
            value: 0.0,
            hold_samples: 0,
        }
    }

    pub fn process(
        &mut self,
        sample: f32,
        threshold: f32,
        sample_rate: f32,
        attack_seconds: f32,
        release_seconds: f32,
        hold_seconds: f32,
    ) -> f32 {
        if sample.abs() >= threshold.abs() {
            self.hold_samples = (sample_rate.max(1.0) * hold_seconds.max(0.0)).round() as u32;
        } else if self.hold_samples > 0 {
            self.hold_samples -= 1;
        }

        let target = if self.hold_samples > 0 { 1.0 } else { 0.0 };
        let seconds = if target > self.value {
            attack_seconds
        } else {
            release_seconds
        };
        let alpha = 1.0 - smoothing(seconds, sample_rate);
        self.value += (target - self.value) * alpha;
        if (self.value - target).abs() < 0.000_001 {
            self.value = target;
        }
        self.value = sanitize_audio(self.value).clamp(0.0, 1.0);
        self.value
    }
}

pub struct SafeDelayLine {
    buffer: Vec<f32>,
    write_index: usize,
}

impl SafeDelayLine {
    pub fn clear(&mut self) { self.buffer.fill(0.0); self.write_index = 0; }
    pub fn new(max_samples: usize) -> Self {
        Self {
            buffer: vec![0.0; max_samples.max(2)],
            write_index: 0,
        }
    }

    pub fn len(&self) -> usize {
        self.buffer.len()
    }

    pub fn push(&mut self, sample: f32) {
        self.buffer[self.write_index] = sanitize_audio(sample);
        self.write_index = (self.write_index + 1) % self.buffer.len();
    }

    pub fn read_linear(&self, delay_samples: f32) -> f32 {
        let delay = sanitize_control(delay_samples, 0.0).clamp(0.0, (self.buffer.len() - 1) as f32);
        let read = self.write_index as f32 - delay;
        let wrapped = read.rem_euclid(self.buffer.len() as f32);
        let index_a = wrapped.floor() as usize % self.buffer.len();
        let index_b = (index_a + 1) % self.buffer.len();
        let frac = wrapped - wrapped.floor();
        sanitize_audio(self.buffer[index_a] * (1.0 - frac) + self.buffer[index_b] * frac)
    }
}

#[derive(Clone, Copy)]
pub struct DcBlocker {
    previous_input: f32,
    previous_output: f32,
}

impl DcBlocker {
    pub const fn new() -> Self {
        Self {
            previous_input: 0.0,
            previous_output: 0.0,
        }
    }

    pub fn process(&mut self, input: f32) -> f32 {
        let output = input - self.previous_input + self.previous_output * 0.995;
        self.previous_input = input;
        self.previous_output = flush_denormal(output);
        self.previous_output
    }
}

#[derive(Clone, Copy)]
pub struct OnePole {
    state: f32,
}

impl OnePole {
    pub const fn new() -> Self {
        Self { state: 0.0 }
    }

    pub fn lowpass(&mut self, input: f32, cutoff_hz: f32, sample_rate: f32) -> f32 {
        self.state += (input - self.state) * one_pole_alpha(cutoff_hz, sample_rate);
        self.state = flush_denormal(self.state);
        self.state
    }
}

#[derive(Clone, Copy)]
pub struct TwelvePoleLowpass {
    stages: [f32; 12],
}

#[derive(Clone, Copy)]
pub struct LowpassTaps {
    pub twelve_pole: f32,
}

impl TwelvePoleLowpass {
    pub const fn new() -> Self {
        Self { stages: [0.0; 12] }
    }

    pub fn process(
        &mut self,
        input: f32,
        cutoff_hz: f32,
        resonance: f32,
        drive: f32,
        sample_rate: f32,
    ) -> f32 {
        self.process_tapped(input, cutoff_hz, resonance, drive, sample_rate)
            .twelve_pole
    }

    pub fn process_tapped(
        &mut self,
        input: f32,
        cutoff_hz: f32,
        resonance: f32,
        drive: f32,
        sample_rate: f32,
    ) -> LowpassTaps {
        let cutoff = cutoff_hz.clamp(12.0, sample_rate.max(1.0) * 0.43);
        let g = one_pole_alpha(cutoff, sample_rate).clamp(0.000_04, 0.82);
        let resonance = resonance.clamp(0.0, 0.62);
        let resonance_shape = resonance / 0.62;
        let feedback = resonance_shape * (0.48 + resonance_shape * 1.05);
        let mut sample = ((input - self.stages[11] * feedback) * drive.max(0.05)).tanh();

        for (index, stage) in self.stages.iter_mut().enumerate() {
            *stage += (sample - *stage) * g;
            sample = if index == 2 || index == 5 || index == 8 {
                (*stage * (1.0 + resonance_shape * 0.08)).tanh()
            } else {
                *stage
            };
            *stage = flush_denormal(*stage);
        }

        LowpassTaps {
            twelve_pole: sanitize_audio(self.stages[11] * (1.0 + resonance_shape * 0.55)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoothed_value_reaches_target_without_stepping() {
        let mut value = SmoothedValue::new(0.0);
        value.set_target(1.0);
        assert_eq!(value.target(), 1.0);

        let first = value.next(48_000.0, 0.01);
        assert!(first > 0.0);
        assert!(first < 0.01);

        for _ in 0..48_000 {
            value.next(48_000.0, 0.01);
        }
        assert!(value.current > 0.999);
    }

    #[test]
    fn smoothed_value_preserves_control_range() {
        let mut frequency = SmoothedValue::new(1_000.0);
        frequency.set_target(12_000.0);
        for _ in 0..48_000 {
            frequency.next(48_000.0, 0.01);
        }
        assert!(frequency.current > 11_999.0);

        let mut tune = SmoothedValue::new(-24.0);
        tune.set_target(24.0);
        for _ in 0..48_000 {
            tune.next(48_000.0, 0.01);
        }
        assert!(tune.current > 23.999);
    }

    #[test]
    fn crossfade_advances_to_completion() {
        let mut fade = Crossfade::complete();
        fade.start_seconds(4.0, 1.0);
        let mut last = 0.0;
        for _ in 0..4 {
            let (_, wet) = equal_power_gains(fade.advance());
            assert!(wet >= last);
            last = wet;
        }
        assert!(!fade.is_active());
        fade.reset_complete();
        assert_eq!(fade.progress(), 1.0);

        fade.start_samples(2);
        let (_, wet) = fade.advance_linear_gains();
        assert_eq!(wet, 0.0);
    }

    #[test]
    fn declick_envelope_opens_and_releases() {
        let mut envelope = DeclickEnvelope {
            value: 0.0,
            target: 0.0,
        };
        let open = DeclickEnvelope::open();
        assert_eq!(open.value, 1.0);
        envelope.set_open(true);
        let first = envelope.next(48_000.0, 0.002, 0.005);
        assert!(first > 0.0);
        assert!(first < 1.0);

        for _ in 0..48_000 {
            envelope.next(48_000.0, 0.002, 0.005);
        }
        assert!(envelope.value > 0.999);

        envelope.release();
        for _ in 0..48_000 {
            envelope.next(48_000.0, 0.002, 0.005);
        }
        assert!(envelope.value <= 0.000_01 && envelope.target <= 0.0);
    }

    #[test]
    fn signal_presence_holds_then_releases() {
        let mut presence = SignalPresence::new();
        let active = presence.process(0.1, 0.001, 48_000.0, 0.001, 0.05, 0.01);
        assert!(active > 0.0);

        for _ in 0..480 {
            presence.process(0.0, 0.001, 48_000.0, 0.001, 0.05, 0.01);
        }
        assert!(presence.value > 0.01);

        for _ in 0..48_000 {
            presence.process(0.0, 0.001, 48_000.0, 0.001, 0.05, 0.01);
        }
        assert!(presence.value < 0.001);
    }

    #[test]
    fn safe_delay_line_reads_are_bounded_and_finite() {
        let mut delay = SafeDelayLine::new(8);
        assert_eq!(delay.len(), 8);
        for sample in [0.0, 1.0, 0.0, -1.0] {
            delay.push(sample);
        }

        assert!(delay.read_linear(1.5).is_finite());
        assert_eq!(delay.read_linear(f32::NAN), 0.0);
    }

    #[test]
    fn sanitize_helpers_remove_bad_values() {
        assert_eq!(sanitize_audio(f32::NAN), 0.0);
        assert_eq!(sanitize_control(f32::INFINITY, 0.25), 0.25);
        assert_eq!(flush_denormal(1.0e-30), 0.0);
    }

    #[test]
    fn blep_pulse_is_safe_at_extreme_phase_increments() {
        let increments = [
            f32::NAN,
            0.0,
            0.000_001,
            0.1,
            0.24,
            0.25,
            0.33,
            0.49,
            0.75,
            f32::INFINITY,
        ];
        let widths = [f32::NAN, -1.0, 0.01, 0.5, 0.99, 2.0];

        for phase_index in 0..128 {
            let phase = phase_index as f32 / 128.0;
            for phase_inc in increments {
                for width in widths {
                    let sample = blep_pulse(phase, width, phase_inc);
                    assert!(sample.is_finite());
                    assert!(sample.abs() <= 2.0);
                }
            }
        }
    }
}
