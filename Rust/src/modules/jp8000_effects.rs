//! One per-part post-EQ stereo chain. Allocate on construction, never per voice.
use super::{chorus::Chorus, delay::Delay, pan::Pan};

/// Controller caches, distinct from installed DSP coefficients and history.
/// Native 6C92/9E40 update these; the periodic part pass selects publications.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PartControlCache {
    pub eq: [i64; 6],
    pub delay: super::delay::Targets,
    pub chorus_level: i64,
    pub chorus_step: i64,
    pan_mode: u16,
    manual_pan: u16,
    auto_depth: i32,
    midi_pan: u8,
}
impl PartControlCache {
    pub(crate) fn new() -> Self {
        Self {
            eq: super::output::tone_coefficients(64, 64),
            delay: super::delay::Targets::calculate(0, 64, 0, 0, 0, 120),
            chorus_level: 0,
            chorus_step: Chorus::free_step(0),
            pan_mode: 0,
            manual_pan: 64,
            auto_depth: 0,
            midi_pan: 64,
        }
    }
    pub(crate) fn refresh(
        &mut self,
        controls: &[u16; 74],
        settings: super::EffectSettings,
        primary_step: u32,
        midi_pan: u8,
        refresh_free_rates: bool,
        refresh_synchronized_rates: bool,
    ) {
        self.eq = super::output::tone_coefficients(controls[59], controls[60]);
        let delay = super::delay::Targets::calculate(
            controls[63],
            controls[64],
            controls[65],
            controls[66],
            settings.delay_sync,
            settings.tempo,
        );
        self.delay.feedback = delay.feedback;
        self.delay.level = delay.level;
        // Dedicated sync refresh skips a free-time address/rate cache write.
        // Full note/Morph/effect-group getters explicitly recompute free values.
        if (settings.delay_sync == 0 && refresh_free_rates)
            || (settings.delay_sync != 0 && refresh_synchronized_rates)
        {
            self.delay.time = delay.time;
        }
        self.chorus_level = Chorus::level_target(controls[62]);
        match settings.chorus_sync {
            0 if refresh_free_rates => self.chorus_step = Chorus::free_step(controls[61]),
            0 => {}
            23 if refresh_free_rates || refresh_synchronized_rates => {
                self.chorus_step = i64::from(primary_step) / (882 * 256)
            }
            sync if refresh_synchronized_rates => {
                self.chorus_step = i64::from(
                    super::tempo::synced_lfo_increment(sync, settings.tempo)
                        .expect("validated musical division"),
                ) / (882 * 256)
            }
            _ => {}
        }
        self.pan_mode = controls[58];
        self.manual_pan = controls[52];
        self.auto_depth = super::control::amp_lfo_depth(controls[52]);
        self.midi_pan = midi_pan;
    }
}

/// Destination selection is separate from cache freshness. The current
/// Instrument uses SETTLED; native recall/load transitions remain unmodeled.
/// These independent groups support the later 16/6/4/3 load-state actions
/// without interpreting a dirty bit as a native load-state selector.
#[derive(Clone, Copy)]
pub(crate) struct PublicationGroups {
    pub eq: bool,
    pub delay_time_and_feedback: bool,
    pub delay_level_shift: Option<u32>,
    pub chorus: bool,
}
impl PublicationGroups {
    pub(crate) const SETTLED: Self = Self {
        eq: true,
        delay_time_and_feedback: true,
        delay_level_shift: Some(0),
        chorus: true,
    };
}

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
    pub(crate) fn load_programs(&mut self, delay_kind: Option<u16>, chorus_kind: Option<u16>) {
        if let Some(kind) = delay_kind {
            self.delay.select_kind(kind);
        }
        if let Some(kind) = chorus_kind {
            self.chorus.load_kind(kind);
        }
    }
    pub(crate) fn publish(&mut self, cache: &PartControlCache, groups: PublicationGroups) {
        self.delay.publish(
            cache.delay,
            groups.delay_time_and_feedback,
            groups.delay_level_shift,
        );
        if groups.chorus {
            self.chorus.publish(cache.chorus_level, cache.chorus_step);
        }
    }
    // Pan precedes the part-load action and uses the just-advanced shared LFO.
    pub(crate) fn publish_pan(&mut self, cache: &PartControlCache, lfo: i32) {
        self.pan_mode = cache.pan_mode;
        self.manual_pan = cache.manual_pan;
        self.auto_depth = cache.auto_depth;
        self.midi_pan = cache.midi_pan;
        self.update_lfo(lfo);
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

#[cfg(test)]
impl Effects {
    pub(crate) fn shared_cache_test_targets(&self) -> ([i64; 4], [i64; 3], [i64; 2]) {
        (
            self.delay.shared_cache_test_targets(),
            self.chorus.shared_cache_test_targets(),
            self.pan.shared_cache_test_targets(),
        )
    }
    pub(crate) fn shared_cache_test_history(&self) -> ([i64; 8], [i64; 13], [i64; 2], (i64, i64)) {
        (
            self.delay.shared_cache_test_history(),
            self.chorus.shared_cache_test_history(),
            self.pan.shared_cache_test_gains(),
            self.previous_chorus,
        )
    }
}
