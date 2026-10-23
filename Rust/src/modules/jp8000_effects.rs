//! One per-part post-EQ stereo chain. Allocate on construction, never per voice.
use super::{chorus::Chorus, delay::Delay, pan::Pan};

pub(crate) struct Effects {
    delay: Delay,
    chorus: Chorus,
    pan: Pan,
    previous_chorus: (i64, i64),
    pan_mode: u16,
    manual_pan: u16,
    auto_depth: i32,
    midi_pan: u8,
}
impl Effects {
    pub(crate) fn new() -> Self {
        Self {
            delay: Delay::new(),
            chorus: Chorus::new(),
            pan: Pan::new(),
            previous_chorus: (0, 0),
            pan_mode: 0,
            manual_pan: 64,
            auto_depth: 0,
            midi_pan: 64,
        }
    }
    pub(crate) fn configure(
        &mut self,
        controls: &[u16; 74],
        delay_sync: u16,
        bpm: u16,
        auto_depth: i32,
        midi_pan: u8,
        lfo: i32,
    ) {
        self.delay.configure(
            controls[63],
            controls[64],
            controls[65],
            controls[66],
            delay_sync,
            bpm,
        );
        self.chorus.configure(controls[61], controls[62]);
        self.pan_mode = controls[58];
        self.manual_pan = controls[52];
        self.auto_depth = auto_depth;
        self.midi_pan = midi_pan;
        self.update_lfo(lfo);
    }
    pub(crate) fn configure_chorus_sync(&mut self, increment:Option<u32>) {
        self.chorus.configure_sync(increment);
    }
    /// The shared controller advances its LFO before publishing this value.
    pub(crate) fn update_lfo(&mut self, lfo: i32) {
        self.pan.update_control(
            self.pan_mode,
            self.manual_pan,
            self.auto_depth,
            self.midi_pan,
            lfo,
        );
    }
    pub(crate) fn reset(&mut self) {
        self.delay.reset();
        self.chorus.reset();
        self.pan.reset();
        self.previous_chorus = (0, 0);
    }
    /// Signed24 EQ output in, stereo panned part output out. The caller sums
    /// both parts and applies dac_mix once. GRAM74/76 ->75/77 carries exactly
    /// one previous stereo frame; no callback queue is introduced.
    pub(crate) fn process(&mut self, equalized: i64) -> (i64, i64) {
        let d = self.delay.process(equalized);
        let c = self.chorus.process(d.0, d.1);
        let previous = std::mem::replace(&mut self.previous_chorus, c);
        self.pan.process(previous.0, previous.1)
    }
}
