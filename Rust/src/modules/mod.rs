// Standalone contract: upstream block types with only the required ports.
pub mod dsp;
pub mod five;
pub mod fm4;
pub mod one;
pub mod six;
pub mod monologue;
pub mod jp8000;
pub const MAX_BLOCK_FRAMES: usize = 128;
pub const MAX_INPUTS: usize = 15;
pub const MAX_OUTPUTS: usize = 4;

pub type PortBlock = [f32; MAX_BLOCK_FRAMES];
pub type ModuleInputs = [PortBlock; MAX_INPUTS];
pub type ModuleOutputs = [PortBlock; MAX_OUTPUTS];

const TRANSPORT_EPSILON: f64 = 1.0e-9;

#[derive(Clone, Copy)]
pub struct BlockContext {
    pub sample_rate: f32,
    pub frames: usize,
    pub tempo_bpm: f32,
    pub transport_sixteenth_position: f64,
}

#[derive(Clone, Copy)]
pub struct SixteenthClock {
    pub absolute_step: u64,
    pub phase: f32,
}

impl BlockContext {
    pub fn sixteenth_position_at(&self, frame: usize) -> f64 {
        let sample_rate = self.sample_rate.max(1.0) as f64;
        let sixteenths_per_second = (self.tempo_bpm.max(0.0) as f64 / 60.0) * 4.0;
        self.transport_sixteenth_position + (frame as f64 * sixteenths_per_second / sample_rate)
    }

    pub fn sixteenth_at(&self, frame: usize) -> SixteenthClock {
        step_clock(self.sixteenth_position_at(frame))
    }

    pub fn scaled_step_at(
        &self,
        frame: usize,
        steps_per_cycle: usize,
        sixteenth_span: usize,
    ) -> SixteenthClock {
        let scale = steps_per_cycle.max(1) as f64 / sixteenth_span.max(1) as f64;
        step_clock(self.sixteenth_position_at(frame) * scale)
    }
}

fn step_clock(position: f64) -> SixteenthClock {
    let adjusted_position = position + TRANSPORT_EPSILON;
    let step = adjusted_position.floor().max(0.0);

    SixteenthClock {
        absolute_step: step as u64,
        phase: (adjusted_position - step) as f32,
    }
}

pub trait ModuleProcessor {
    fn set_float_param(&mut self, param_id: u32, value: f32);
    fn process_block(
        &mut self,
        context: &BlockContext,
        inputs: &ModuleInputs,
        outputs: &mut ModuleOutputs,
    );
}
