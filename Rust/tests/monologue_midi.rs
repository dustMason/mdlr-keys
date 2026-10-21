//! MIDI regressions exercise the public audio interface, including callback boundaries.
use mdlr_ipad_dsp::{
    modules::{
        monologue::Monologue, BlockContext, ModuleInputs, ModuleOutputs, ModuleProcessor,
        MAX_BLOCK_FRAMES,
    },
    Synth,
};

const RATE: f32 = 48_000.0;

fn render(synth: &mut Synth, frames: usize) -> Vec<f32> {
    let (mut left, mut right) = (vec![0.0; frames], vec![0.0; frames]);
    synth.render(&mut left, &mut right, RATE);
    assert!(left.iter().chain(&right).all(|x| x.is_finite()));
    assert_eq!(left, right, "The monologue voice must remain mono");
    left
}

fn energy(audio: &[f32]) -> f32 {
    audio.iter().map(|x| x * x).sum()
}

#[test]
fn filter_tracking_uses_the_key_before_oscillator_octave() {
    let render_key = |note, octave, tracking| {
        let mut synth = Synth::new();
        synth.select(4);
        synth.parameter(9, 0.4);
        synth.parameter(24, tracking);
        synth.parameter(31, octave);
        // Keep both physical oscillators at the same pitches: the ring input
        // network has a weak source2-to-source1 coupling even with VCO2 muted.
        synth.parameter(6, octave);
        synth.midi(0x90, note, 127);
        render(&mut synth, 8192)
    };
    // Same audible oscillator pitch, reached with different physical keys.
    let low = render_key(60, 0.0, 0.0);
    let high = render_key(72, -1.0, 0.0);
    assert!(low.iter().zip(&high).all(|(a, b)| (a - b).abs() < 1e-6));
    let tracked_low = render_key(60, 0.0, 1.0);
    let tracked_high = render_key(72, -1.0, 1.0);
    assert!(energy(&tracked_high[4096..])>1.2*energy(&tracked_low[4096..]),
        "An octave of key tracking must open the filter even when VCO octave cancels the pitch change");
}

fn decayed_legato_note() -> Synth {
    let mut synth = Synth::new();
    synth.select(4);
    synth.parameter(12, 0.0); // AD: the held note eventually becomes silent.
    synth.parameter(13, 0.0);
    synth.parameter(14, 0.0);
    synth.parameter(26, 1.0); // Overlapping notes must not restart the envelope.
    synth.midi(0x90, 60, 127);
    let initial = render(&mut synth, RATE as usize);
    assert!(
        energy(&initial[..1024]) > 0.001,
        "Fixture must begin with an audible note"
    );
    assert!(
        energy(&initial[initial.len() - 1024..]) < 1e-10,
        "Fixture must finish its AD envelope"
    );
    synth
}

#[test]
fn repeated_note_respects_envelope_legato() {
    let mut synth = decayed_legato_note();
    synth.midi(0x90, 60, 127); // A second note-on arrives while the first is held.
    assert!(
        energy(&render(&mut synth, 1024)) < 1e-10,
        "A repeated pitch must not inject a low gate and bypass envelope legato"
    );

    // Prove the same MIDI event can retrigger when that option is disabled.
    synth.parameter(26, 0.0);
    synth.midi(0x90, 60, 127);
    assert!(energy(&render(&mut synth, 1024)) > 0.001);
}

#[test]
fn queued_note_off_then_note_on_starts_a_new_phrase() {
    for first_callback in [1, 31, 64, 128] {
        let mut synth = decayed_legato_note();
        synth.midi(0x80, 60, 0);
        synth.midi(0x90, 64, 127);
        // No render happens between MIDI events. A gate-CV-only detector would
        // see high→high and incorrectly suppress this non-overlapping phrase.
        let mut audio = render(&mut synth, first_callback);
        audio.extend(render(&mut synth, 1024 - first_callback));
        assert!(
            energy(&audio) > 0.001,
            "New phrase was lost with a {first_callback}-frame first callback"
        );
    }
}

fn module_block(module: &mut Monologue, inputs: &ModuleInputs) -> ModuleOutputs {
    let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; 4];
    module.process_block(
        &BlockContext {
            sample_rate: RATE,
            frames: MAX_BLOCK_FRAMES,
            tempo_bpm: 120.0,
            transport_sixteenth_position: 0.0,
        },
        inputs,
        &mut outputs,
    );
    outputs
}

#[test]
fn square_pitch_lfo_matches_firmware_depth_in_rendered_audio() {
    let mut modulated = Monologue::new();
    let mut tuned = Monologue::new();
    for module in [&mut modulated, &mut tuned] {
        module.set_float_param(17, 2.0); // Square, initially positive.
        module.set_float_param(18, 0.0);
        module.set_float_param(19, 0.0); // Slow enough to stay positive throughout.
        module.set_float_param(21, 0.0);
        module.set_float_param(25, 1.0);
    }
    modulated.set_float_param(20, 38.0 / 511.0); // Raw intensity 550.
    tuned.set_float_param(28, 39.453125); // Encoder 0x90bc: 101 Q8 pitch units.
    modulated.settle_parameters();
    tuned.settle_parameters();
    let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; 15];
    inputs[0].fill(1.75);
    inputs[1].fill(1.0);
    for _ in 0..8 {
        let a = module_block(&mut modulated, &inputs);
        let b = module_block(&mut tuned, &inputs);
        assert!(
            a[0].iter().zip(&b[0]).all(|(x, y)| (x - y).abs() < 1e-6),
            "LFO pitch target must use the nonlinear depth in actual rendered audio"
        );
    }
}

#[test]
fn completed_one_shot_resumes_when_switched_to_slow_or_fast() {
    for next_mode in [0.0, 1.0] {
        let mut module = Monologue::new();
        module.set_float_param(18, 2.0);
        module.set_float_param(19, 1.0);
        module.set_float_param(25, 0.0); // No key-sync can hide a frozen LFO.
        module.settle_parameters();
        let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; 15];
        inputs[0].fill(1.0);
        inputs[1].fill(1.0);
        for _ in 0..400 {
            module_block(&mut module, &inputs);
        }
        // Output 3 is the public LFO phase signal. Establish that One-shot
        // has stopped before switching mode, without relying on private state.
        let finished = module_block(&mut module, &inputs)[3];
        assert!(finished.iter().all(|x| *x == finished[0]));
        assert!(finished[0] > 0.0);
        assert_eq!(finished, module_block(&mut module, &inputs)[3]);

        module.set_float_param(18, next_mode);
        let phase = module_block(&mut module, &inputs)[3];
        assert!(
            phase
                .windows(2)
                .any(|pair| (pair[1] - pair[0]).abs() > 1e-6),
            "Completed One-shot froze LFO mode {next_mode}"
        );
    }
}

fn held_pitch(glide: f32) -> Synth {
    let mut synth = Synth::new();
    synth.select(4);
    synth.parameter(22, glide);
    synth.parameter(29, 1.0); // First note is immediate; only overlapping notes glide.
    synth.midi(0x90, 69, 127);
    render(&mut synth, 4096);
    synth
}

#[test]
fn bend_bypasses_glide_without_disabling_note_portamento() {
    let mut glide = held_pitch(1.0);
    let mut immediate = held_pitch(0.0);
    let mut unbent = held_pitch(0.0);
    for synth in [&mut glide, &mut immediate] {
        synth.midi(0xe0, 127, 127);
    }
    let bent = render(&mut glide, 512);
    let reference = render(&mut immediate, 512);
    let unchanged = render(&mut unbent, 512);
    assert!(
        bent.iter()
            .zip(&reference)
            .all(|(a, b)| (a - b).abs() < 1e-6),
        "Pitch bend must affect the next callback independently of the glide time"
    );
    assert!(
        bent.iter()
            .zip(&unchanged)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>()
            > 0.001,
        "Fixture must exercise an audible bend"
    );

    // A fix that bypasses all portamento would pass the bend comparison.
    for synth in [&mut glide, &mut immediate] {
        synth.midi(0x90, 81, 127);
    }
    let sliding = render(&mut glide, 512);
    let jumped = render(&mut immediate, 512);
    assert!(
        sliding
            .iter()
            .zip(&jumped)
            .map(|(a, b)| (a - b).powi(2))
            .sum::<f32>()
            > 0.001,
        "Overlapping notes must still use portamento"
    );
}
