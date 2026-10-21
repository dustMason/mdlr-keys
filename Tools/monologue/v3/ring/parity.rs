#![allow(dead_code)]
//! Standalone native/analysis parity probe; outputs little-endian f32 samples.
use std::io::Write;
#[path = "../../../../Rust/src/modules/monologue.rs"]
pub mod monologue;
mod modules {
    pub const MAX_BLOCK_FRAMES: usize = 128;
    pub type ModuleInputs = [[f32; 128]; 15];
    pub type ModuleOutputs = [[f32; 128]; 4];
    pub struct BlockContext {
        pub sample_rate: f32,
        pub frames: usize,
        pub tempo_bpm: f32,
        pub transport_sixteenth_position: f64,
    }
    pub trait ModuleProcessor {
        fn set_float_param(&mut self, id: u32, value: f32);
        fn process_block(
            &mut self,
            context: &BlockContext,
            inputs: &ModuleInputs,
            outputs: &mut ModuleOutputs,
        );
    }
    pub use super::monologue;
}
use modules::{BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor, MAX_BLOCK_FRAMES};
pub trait Instrument: ModuleProcessor {
    fn velocity(&mut self, voice: usize, value: f32);
    fn silence(&mut self);
    fn tuning_cents(&self, _note: u8) -> f32 {
        0.0
    }
    fn midi_cc(&mut self, _cc: u8, _value: u8) {}
    fn note_on(&mut self, _from_silence: bool) {}
    fn key_note(&mut self, _voice: usize, _note: u8) {}
}
fn main() {
    let mut file = std::fs::File::create(std::env::args().nth(1).unwrap()).unwrap();
    for initial_rate in [48_000.0, 96_000.0] {
        for scenario in 0..3 {
            let mut synth = modules::monologue::Monologue::new();
            for (id, value) in [
                (2, 0.7),
                (5, 0.8),
                (1, 0.6),
                (4, 0.9),
                (6, 1.0),
                (7, 17.0),
                (9, 0.8),
                (10, 0.3),
                (12, 1.0),
                (13, 0.04),
                (14, 0.4),
                (20, 0.3),
                (21, 1.0),
            ] {
                synth.set_float_param(id, value);
            }
            synth.settle_parameters();
            let mut input = [[0.0; 128]; 15];
            let mut output = [[0.0; 128]; 4];
            for block in 0..120 {
                let mode = if scenario == 2 {
                    (block / 8) % 3
                } else {
                    scenario + 1
                };
                synth.set_float_param(8, mode as f32);
                synth.set_float_param(
                    0,
                    if scenario == 1 {
                        2.0
                    } else {
                        ((block / 20) % 2) as f32
                    },
                );
                synth.set_float_param(3, ((block / 15) % 3) as f32);
                let rate = if scenario == 2 && block % 30 >= 15 {
                    initial_rate * 0.5
                } else {
                    initial_rate
                };
                let note = 48 + ((block / 12) % 3) * 7;
                let gate = block % 12 < 9;
                if block % 12 == 0 {
                    synth.note_on(true);
                    synth.set_key_note(note as u8);
                }
                input[0].fill((note as f32 - 48.0) / 12.0);
                input[1].fill(if gate { 1.0 } else { 0.0 });
                input[2].fill(0.07);
                if block == 17 {
                    input[0][2] = f32::NAN;
                    input[2][4] = f32::INFINITY;
                }
                synth.process_block(
                    &BlockContext {
                        sample_rate: rate,
                        frames: 128,
                        tempo_bpm: 120.0,
                        transport_sixteenth_position: 0.0,
                    },
                    &input,
                    &mut output,
                );
                for port in output {
                    for sample in port {
                        assert!(sample.is_finite());
                        file.write_all(&sample.to_bits().to_le_bytes()).unwrap();
                    }
                }
            }
        }
    }
}
