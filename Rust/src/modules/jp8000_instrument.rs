//! Eight physical voices with two part controllers and one shared tempo clock.
//! Handwritten synthesis and control laws; no firmware or captured state assets.
use super::control::Lfo;
use super::notes::HeldKeys;
use super::{Jp8000Voice, OutputPath, ParameterError, Stage, IMPLEMENTED_PARAMETERS, Q23};
pub const VOICE_COUNT: usize = 8;
const MAX_FFI_FRAMES: usize = 16_384;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MidiError {
    InvalidData,
    UnsupportedMessage(u8),
    UnsupportedController(u8),
    UnsupportedRouting,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
enum Status {
    Free = 0,
    Released = 1,
    Pedal = 2,
    Held = 3,
}
#[derive(Clone, Copy)]
struct Slot {
    owner: u8,
    origin: u8,
    channel: u8,
    note: u8,
    age: u32,
    status: Status,
    assigned: bool,
    key_down: bool,
    mono: bool,
}
impl Slot {
    const EMPTY: Self = Self {
        owner: 0,
        origin: 1,
        channel: 0,
        note: 0,
        age: 0,
        status: Status::Free,
        assigned: false,
        key_down: false,
        mono: false,
    };
}
struct PartState {
    params: [u16; super::PARAM_COUNT],
    extra: [u16; 7],
    settings: super::EffectSettings,
    mono_last_input: Option<u8>,
    forced_portamento_source: Option<u8>,
    held: [[u16; 128]; 2],
    mono_held: [HeldKeys; 2],
    sustain: [bool; 17],
    bend: u16,
    wheel: u8,
    volume: u8,
    expression: u8,
    pan: u8,
    morph: i32,
    last_velocity_code: i32,
    output: OutputPath,
    effects: super::effects::Effects,
    lfo: Lfo,
    lfo2: Lfo,
}
impl PartState {
    fn new(part: usize) -> Self {
        Self {
            params: super::defaults(),
            extra: [0, 0, part as u16, 24, 0, 0, 0],
            settings: super::EffectSettings::new(),
            mono_last_input: None,
            forced_portamento_source: None,
            held: [[0; 128]; 2],
            mono_held: std::array::from_fn(|_| HeldKeys::new()),
            sustain: [false; 17],
            bend: 8192,
            wheel: 0,
            volume: 127,
            expression: 127,
            pan: 64,
            morph: 0,
            last_velocity_code: 0,
            output: OutputPath::new(),
            effects: super::effects::Effects::new(),
            lfo: Lfo::new(),
            lfo2: {
                let mut l = Lfo::new();
                l.configure_second(64);
                l
            },
        }
    }
    fn highest_mono_input(&self) -> Option<u8> {
        self.mono_held.iter().filter_map(HeldKeys::highest).max()
    }
    fn mono(&self) -> bool {
        self.params[71] != 0 || self.params[30] == 3
    }
}
#[derive(Clone, Copy)]
struct Common {
    performance: [u16; 35],
    system: [u16; 16],
}
impl Common {
    fn new() -> Self {
        let mut p = [0; 35];
        p[17] = 60;
        p[19] = 50;
        p[22] = 2;
        p[28] = 3; // Native default; assignment 11 is accepted only without physical pedal input.
        p[34] = 120;
        let mut s = [0; 16];
        s[9] = 17;
        s[10] = 50;
        Self {
            performance: p,
            system: s,
        }
    }
    fn get(&self, id: u16) -> Option<u16> {
        match id {
            2000..=2034 => Some(self.performance[(id - 2000) as usize]),
            3000..=3015 => Some(self.system[(id - 3000) as usize]),
            _ => None,
        }
    }
    fn set(&mut self, id: u16, value: u16) {
        if id < 3000 {
            self.performance[(id - 2000) as usize] = value
        } else {
            self.system[(id - 3000) as usize] = value
        }
    }
    fn keyboard_mask(&self, note: u8) -> u8 {
        match self.performance[16] {
            0 => {
                if self.performance[18] == 1 {
                    2
                } else {
                    1
                }
            }
            1 => 3,
            _ => {
                if u16::from(note) < self.performance[17] {
                    2
                } else {
                    1
                }
            }
        }
    }
    fn controller_mask(&self) -> u8 {
        match self.performance[16] {
            1 => 3,
            0 => {
                if self.performance[18] == 1 {
                    2
                } else {
                    1
                }
            }
            _ => match self.performance[18] {
                0 => 1,
                1 => 2,
                _ => 3,
            },
        }
    }
    fn owner(&self, index: usize) -> u8 {
        if self.performance[16] == 0 {
            return u8::from(self.performance[18] == 1);
        }
        // Original semantic ownership sets recovered from all five allocation modes.
        let upper = match self.performance[22] {
            0 => matches!(index, 0 | 2),
            1 => matches!(index, 0 | 6 | 7),
            2 => matches!(index, 0 | 2 | 6 | 7),
            3 => matches!(index, 0 | 2 | 3 | 4 | 5),
            _ => matches!(index, 0 | 3 | 4 | 5 | 6 | 7),
        };
        u8::from(!upper)
    }
}
/// Exactly eight physical voices; independently clocked part state shares one tempo.
pub struct Jp8000Instrument {
    voices: [Jp8000Voice; VOICE_COUNT],
    oscillator_history: super::SharedOscillatorHistory,
    slots: [Slot; VOICE_COUNT],
    order: [u8; VOICE_COUNT],
    parts: [PartState; 2],
    common: Common,
    remote_keys: [Option<u8>; 128],
    remote_ribbon: u8,
    remote_wheel: u8,
    remote_bend: u16,
    remote_sustain: u8,
    remote_sustain_active: u8,
    remote_expression: u8,
    remote_expression_active: u8,
    millisecond_clock: u32,
    millisecond_remainder: u32,
    serial: u64,
    tempo_clock: super::tempo::TempoClock,
    arp: super::arp::Arpeggiator,
    until_tick: u16,
}
impl Default for Jp8000Instrument {
    fn default() -> Self {
        Self::new()
    }
}
impl Jp8000Instrument {
    /// Pure value capability for tools and hosts; no engine state is accessed.
    /// This is not a substitute for final-state transaction validation.
    pub fn parameter_value_capability(id: u16, value: u16) -> i32 {
        mdlr_jp8000_rust_parameter_value_capability(id, value)
    }

    pub fn new() -> Self {
        let mut s = Self {
            voices: std::array::from_fn(|_| Jp8000Voice::new_pre_output()),
            oscillator_history: super::SharedOscillatorHistory::new(),
            slots: [Slot::EMPTY; VOICE_COUNT],
            order: [0, 1, 2, 3, 4, 5, 6, 7],
            parts: std::array::from_fn(PartState::new),
            common: Common::new(),
            remote_keys: [None; 128],
            remote_ribbon: 127,
            remote_wheel: 0,
            remote_bend: 8192,
            remote_sustain: 0,
            remote_sustain_active: 0,
            remote_expression: 127,
            remote_expression_active: 0,
            millisecond_clock: 0,
            millisecond_remainder: 0,
            serial: 0,
            tempo_clock: super::tempo::TempoClock::new(120),
            arp: super::arp::Arpeggiator::default(),
            until_tick: 0,
        };
        for p in 0..2 {
            s.refresh_global_controls(p);
        }
        s
    }
    fn valid_part(part: usize) -> Result<(), ParameterError> {
        if part < 2 {
            Ok(())
        } else {
            Err(ParameterError::UnsupportedValue {
                id: u16::MAX,
                value: part.min(65535) as u16,
            })
        }
    }
    pub fn parameter(&self, id: u16) -> Option<u16> {
        if id >= 2000 {
            self.common.get(id)
        } else {
            self.part_parameter(0, id)
        }
    }
    pub fn part_parameter(&self, part: usize, id: u16) -> Option<u16> {
        let p = self.parts.get(part)?;
        if (id as usize) < super::PARAM_COUNT {
            Some(p.params[id as usize])
        } else if (1000..=1006).contains(&id) {
            Some(p.extra[(id - 1000) as usize])
        } else {
            None
        }
    }
    pub fn set_parameter(&mut self, id: u16, value: u16) -> Result<(), ParameterError> {
        self.apply_patch(&[id], &[value])
    }
    pub fn set_part_parameter(
        &mut self,
        part: usize,
        id: u16,
        value: u16,
    ) -> Result<(), ParameterError> {
        Self::valid_part(part)?;
        if id >= 2000 {
            return Err(ParameterError::UnsupportedParameter(id));
        }
        if part == 0 {
            self.apply_performance(&[id], &[value], &[], &[], &[], &[])
        } else {
            self.apply_performance(&[], &[], &[id], &[value], &[], &[])
        }
    }
    pub fn apply_patch(&mut self, ids: &[u16], values: &[u16]) -> Result<(), ParameterError> {
        if ids.len() != values.len() || ids.len() > 256 {
            return Err(ParameterError::UnsupportedParameter(u16::MAX));
        }
        let (mut pi, mut pv, mut ci, mut cv) = ([0; 256], [0; 256], [0; 256], [0; 256]);
        let (mut np, mut nc) = (0, 0);
        for (&id, &v) in ids.iter().zip(values) {
            if id >= 2000 {
                ci[nc] = id;
                cv[nc] = v;
                nc += 1
            } else {
                pi[np] = id;
                pv[np] = v;
                np += 1
            }
        }
        self.apply_performance(&pi[..np], &pv[..np], &[], &[], &ci[..nc], &cv[..nc])
    }
    fn validate_common(id: u16, value: u16) -> Result<(), ParameterError> {
        let max = match id {
            2016 | 2018 => 2,
            2017 => 127,
            2019 => 100,
            2020 => 1,
            2021 => 2,
            2022 => 4,
            2024 | 2026 => 3, // RPS mode4 remains unsupported.
            2025 => 89,
            2023 | 2027 => 1,
            2028 if matches!(value, 3 | 11) => return Ok(()),
            2031 => 15,
            2032 => 128,
            3009 => 17,
            2034 => 250,
            _ => {
                if super::accepted_inactive_parameter(id, value) {
                    return Ok(());
                }
                return Err(ParameterError::UnsupportedValue { id, value });
            }
        };
        if value > max {
            return Err(ParameterError::OutOfRange {
                id,
                value,
                maximum: max,
            });
        }
        if id == 2034 && value < 20 {
            return Err(ParameterError::UnsupportedValue { id, value });
        }
        Ok(())
    }
    /// No partial mutation on any rejection. Slices are scoped, unique and bounded.
    pub fn apply_performance(
        &mut self,
        upper_ids: &[u16],
        upper_values: &[u16],
        lower_ids: &[u16],
        lower_values: &[u16],
        common_ids: &[u16],
        common_values: &[u16],
    ) -> Result<(), ParameterError> {
        let lists = [
            (upper_ids, upper_values),
            (lower_ids, lower_values),
            (common_ids, common_values),
        ];
        for (ids, vs) in lists {
            if ids.len() != vs.len() || ids.len() > 256 {
                return Err(ParameterError::UnsupportedParameter(u16::MAX));
            }
            for (i, &id) in ids.iter().enumerate() {
                if ids[..i].contains(&id) {
                    return Err(ParameterError::UnsupportedValue { id, value: vs[i] });
                }
            }
        }
        let mut params = [self.parts[0].params, self.parts[1].params];
        let mut extras = [self.parts[0].extra, self.parts[1].extra];
        let mut settings = [self.parts[0].settings, self.parts[1].settings];
        let mut next = self.common;
        for part in 0..2 {
            for (&id, &v) in lists[part].0.iter().zip(lists[part].1) {
                if (id as usize) < super::PARAM_COUNT {
                    params[part][id as usize] = v
                } else if (1000..=1006).contains(&id) {
                    extras[part][(id - 1000) as usize] = v;
                    settings[part].set(id, v)
                } else {
                    return Err(ParameterError::UnsupportedParameter(id));
                }
            }
        }
        for (&id, &v) in common_ids.iter().zip(common_values) {
            if !matches!(id,2000..=2034|3000..=3015) {
                return Err(ParameterError::UnsupportedParameter(id));
            }
            Self::validate_common(id, v)?;
            next.set(id, v)
        }
        // Only the supported NORMAL formulas are admitted. Other rhythm
        // programs, RPS and IndividualTrigger remain strict errors.
        if next.performance[29] != 0 {
            return Err(ParameterError::UnsupportedValue {id:2029,value:next.performance[29]});
        }
        if next.performance[23] != 0 {
            for (id,value,valid) in [(2024,next.performance[24],super::arp::supports_mode(next.performance[24])),
                (2025,next.performance[25],super::arp::supports_pattern(next.performance[25]))] {
                if !valid {return Err(ParameterError::UnsupportedValue{id,value});}
            }
        }
        // Changing ownership/routing while generated notes are live needs its
        // own replay proof. Cold complete imports and switch/hold/mode/range/
        // tempo changes are supported; no partially-applied performance.
        if self.common.performance[23]!=0 && (self.arp.occupied() || self.remote_keys.iter().any(Option::is_some)) {
            for id in [2016,2017,2018,2021,2022,3009] {
                if common_ids.contains(&id) && next.get(id)!=self.common.get(id) {
                    return Err(ParameterError::UnsupportedValue{id,value:next.get(id).unwrap_or(0)});
                }
            }
        }
        for part in 0..2 {
            for (&id, &v) in lists[part].0.iter().zip(lists[part].1) {
                if id == 280 {
                    if v > 1 {
                        return Err(ParameterError::OutOfRange {
                            id,
                            value: v,
                            maximum: 1,
                        });
                    }
                } else if id == 1003 {
                    if v > 48 {
                        return Err(ParameterError::OutOfRange {
                            id,
                            value: v,
                            maximum: 48,
                        });
                    }
                } else if id == 1002 {
                    if v > 16 {
                        return Err(ParameterError::OutOfRange {
                            id,
                            value: v,
                            maximum: 16,
                        });
                    }
                } else {
                    Jp8000Voice::validate_parameter_for(&params[part], id, v)?
                }
            }
        }
        // 0x29d72 removes/replays changed assignment destinations. This engine
        // has no physical pedal input or generic/pan cache, so accept changes
        // between 3 and 11 only with the modeled expression family inactive.
        // Equal writes have zero old/new mask delta and preserve assignment 3.
        if next.performance[28] != self.common.performance[28]
            && (self.remote_expression != 127 || self.remote_expression_active != 0)
        {
            return Err(ParameterError::UnsupportedValue { id: 2028, value: next.performance[28] });
        }
        // Native explicit RemoteCH writes (including equal values) clear active
        // physical-controller destinations while retaining the physical caches.
        // That operation needs additional active-mask state which this model does
        // not yet retain. Refuse the whole transaction before any mutation.
        if common_ids.contains(&3009)
            && (self.remote_ribbon != 127
                || self.remote_wheel != 0
                || self.remote_bend != 8192
                || self.remote_sustain != 0
                || self.remote_sustain_active != 0
                || self.remote_expression != 127
                || self.remote_expression_active != 0
                || self.remote_keys.iter().any(Option::is_some))
        {
            return Err(ParameterError::UnsupportedValue {
                id: 3009,
                value: next.system[9],
            });
        }
        // A newly selected Remote channel would consume later direct-source
        // note/pedal releases before they reach their original part. Refuse
        // that collision before mutating any scope. A simultaneous receive-
        // channel change is safe: release_all below retires that part's state.
        let remote = next.system[9];
        if remote <= 16 && remote != self.common.system[9]
            && (0..2).any(|p| self.parts[p].extra[2] < 16
                && (remote == 16 || self.parts[p].extra[2] == remote)
                && extras[p][2] == self.parts[p].extra[2]
                && (self.parts[p].held[1].iter().any(|&n| n != 0)
                    || !self.parts[p].mono_held[1].is_empty()
                    || self.parts[p].sustain[self.parts[p].extra[2] as usize]))
        {
            return Err(ParameterError::UnsupportedValue { id: 3009, value: remote });
        }
        // Strict until the dedicated source-controller merge audit lands.
        if common_ids.contains(&2017)
            && next.performance[17] != self.common.performance[17]
            && self.remote_keys.iter().any(Option::is_some)
        {
            return Err(ParameterError::UnsupportedValue {
                id: 2017,
                value: next.performance[17],
            });
        }
        let old = self.common;
        let old_octaves = [self.parts[0].params[73], self.parts[1].params[73]];
        let old_morph_mask = old.controller_mask();
        let old_bend_mask = old_morph_mask & self.morph_bend_flags();
        let reset = (old.performance[16] == 0) != (next.performance[16] == 0)
            || (next.performance[16] != 0 && old.performance[22] != next.performance[22])
            || (next.performance[16] == 0 && old.performance[18] != next.performance[18])
            || (0..2).any(|p| self.parts[p].params[30] != 3 && params[p][30] == 3);
        for (i, voice) in self.voices.iter().enumerate() {
            let owner = if reset {
                next.owner(i)
            } else {
                self.slots[i].owner
            };
            voice.validate_fade_history(&params[owner as usize])?;
        }
        let force = common_ids.contains(&2016);
        let changed_panel =
            common_ids.contains(&2018) && old.performance[18] != next.performance[18];
        for note in 0..128 {
            if self.remote_keys[note].is_some() {
                let om = Self::remote_direct_mask(&old, note as u8);
                let nm = Self::remote_direct_mask(&next, note as u8);
                let release = if force {
                    om
                } else if changed_panel {
                    om & !nm
                } else {
                    0
                };
                for part in 0..2 {
                    if release & (1 << part) != 0 {
                        self.off(part, 0, 16, note as u8, 80)
                    }
                }
            }
        }
        let old_arp = old.performance[23] != 0;
        let new_arp = next.performance[23] != 0;
        if old_arp && !new_arp {
            let events=self.arp.switch_write(false);
            self.dispatch_arp_events(events);
        }
        if !old_arp && new_arp {
            for note in 0..128 {
                if self.remote_keys[note].is_some() {
                    let remove=Self::remote_direct_mask(&old,note as u8)&!Self::remote_direct_mask(&next,note as u8);
                    for part in 0..2 {if remove&(1<<part)!=0{self.off(part,0,16,note as u8,80);}}
                }
            }
        }
        self.common = next;
        for part in 0..2 {
            if extras[part][2] != self.parts[part].extra[2] {
                self.release_all(part);
            }
            // The receive-channel handler calls part ResetControllers. Ordinary
            // ownership edits, CC120 and CC123 do not clear the CC84 latch.
            if lists[part].0.contains(&1002) { self.parts[part].forced_portamento_source = None; }
            self.parts[part].params = params[part];
            self.parts[part].extra = extras[part];
            settings[part].tempo = next.performance[34];
            self.parts[part].settings = settings[part];
        }
        self.tempo_clock.set_tempo(next.performance[34]);
        if reset {
            self.reconfigure_owners();
        }
        // Fixed transaction dispatch: common ownership changes first, then
        // part transpose, then patch octave. Individual setters retain order.
        let transpose_sources = [self.latest_glide_source(0), self.latest_glide_source(1)];
        for i in 0..8 {
            let part = self.slots[i].owner as usize;
            let voice = &mut self.voices[i];
            let delta = next.performance[19] as i16 - 50;
            let signed = if part == 0 { delta } else { -delta };
            let detune = if next.performance[16] == 1 {
                -(-signed).div_euclid(2)
            } else {
                0
            };
            voice.set_part_pitch(extras[part][3] as u8, detune as i8);
            // Native parameter getters use the current owner, including Free
            // slots. Rebase storage without fabricating a changed-Morph event.
            voice.morph = self.parts[part].morph;
            voice.bend = self.parts[part].bend;
            voice.wheel = self.parts[part].wheel;
            voice.volume = self.parts[part].volume;
            voice.expression = self.parts[part].expression;
            voice.params = params[part];
            voice.effect_settings = settings[part];
            voice.refresh_controls();
            if lists[part]
                .0
                .iter()
                .any(|id| matches!(id, 69 | 70 | 281 | 362))
            {
                voice.refresh_glide_control();
            }
            if lists[part].0.contains(&1003) {
                voice.retarget_part_transpose(transpose_sources[part]);
            }
            if lists[part].0.contains(&73) {
                let intermediate = voice.part_effective_note_with_octave(old_octaves[part]);
                voice.retarget_patch_octave(intermediate);
            }
            if lists[part]
                .0
                .iter()
                .any(|id| matches!(id, 23 | 51 | 82 | 126 | 292 | 336))
            {
                voice.refresh_amplitude_base();
            }
            if reset || lists[part].0.contains(&30) {
                voice.set_parameter(30, params[part][30])?;
            }
            // 0x1648a IDs130/132/136 ->0x16340 reload both oscillator
            // blocks for every newly owned slot, even when controller-free.
            if reset || lists[part].0.contains(&33) || lists[part].0.contains(&34) {
                voice.set_parameter(33, params[part][33])?;
                voice.set_parameter(34, params[part][34])?;
            }
            voice.recalculate();
        }
        for part in 0..2 {
            self.refresh_global_controls(part);
            // H8 0x7172 is an explicit shared LFO parameter event, even
            // when the stored value is unchanged. Broad refreshes stay inert.
            if lists[part].0.iter().any(|id| matches!(id, 16 | 17 | 19)) {
                self.parts[part].lfo.retarget_note();
                self.parts[part].lfo2.retarget_note();
            }
        }
        self.retarget_remote_masks(old_morph_mask, old_bend_mask, force, Self::arp_sustain_mask(&old));
        for note in 0..128 {
            if let Some(velocity) = self.remote_keys[note] {
                let om = Self::remote_direct_mask(&old, note as u8);
                let nm = Self::remote_direct_mask(&next, note as u8);
                let press = if old_arp != new_arp {
                    nm & !om
                } else if force {
                    nm
                } else if changed_panel {
                    nm & !om
                } else {
                    0
                };
                for part in 0..2 {
                    if press & (1 << part) != 0 {
                        self.on(part, 0, 16, note as u8, velocity)
                    }
                }
            }
        }
        if common_ids.contains(&2026) {self.arp.range_write(next.performance[26] as u8);}
        if common_ids.contains(&2024) && super::arp::supports_mode(next.performance[24]) {self.arp.mode_write(next.performance[24] as u8);}
        if common_ids.contains(&2025) {self.arp.pattern_write(next.performance[25]);}
        self.arp.set_hold(next.performance[27]!=0);
        self.arp.set_pedal(self.remote_sustain>=64);
        if !old_arp && new_arp {
            self.arp.switch_write(true);
            for note in 0..128 {
                if let Some(velocity)=self.remote_keys[note] {
                    if Self::arp_accepts_note(&next,note as u8) {self.arp.note(note as u8,velocity,true);}
                }
            }
        } else if common_ids.contains(&2023) && !new_arp {
            let events=self.arp.switch_write(false);self.dispatch_arp_events(events);
        }
        Ok(())
    }
    fn reconfigure_owners(&mut self) {
        for i in 0..8 {
            self.voices[i].clear_controller_amp();
            self.voices[i].set_controller_assigned(false);
            self.voices[i].gate = false;
            self.voices[i].glide.offset_cents = 0;
            // 0x960e clears the cached velocity code (+0x36), not the
            // retained input note/timestamp or the physical DSP histories.
            self.voices[i].clear_velocity_state();
            self.slots[i].status = Status::Free;
            self.slots[i].key_down = false;
            self.slots[i].mono = false;
            self.slots[i].owner = self.common.owner(i);
            self.slots[i].origin = 0;
        }
        self.order = [0, 1, 2, 3, 4, 5, 6, 7];
    }
    fn refresh_global_controls(&mut self, part: usize) {
        // Shared-rate getters read the part's most recently allocated velocity,
        // while each voice retains its own velocity for local destinations.
        let controls = super::control::effective_controls(
            &self.parts[part].params,
            self.parts[part].last_velocity_code,
            self.parts[part].morph,
        );
        let settings = self.parts[part].settings;
        self.parts[part].lfo.configure_primary(
            controls[16],
            controls[17],
            settings.lfo_sync,
            settings.tempo,
            self.tempo_clock.pulses(),
        );
        self.parts[part].lfo2.configure_second(controls[19]);
        self.parts[part].output.set_tone(controls[59], controls[60]);
        self.parts[part].effects.configure(
            &controls,
            settings.delay_sync,
            settings.tempo,
            super::control::amp_lfo_depth(controls[52]),
            self.parts[part].pan,
            self.parts[part].lfo.value(),
        );
        self.parts[part]
            .effects
            .configure_chorus_sync(match settings.chorus_sync {
                0 => None,
                23 => Some(self.parts[part].lfo.increment()),
                sync => super::tempo::synced_lfo_increment(sync, settings.tempo),
            });
    }
    fn move_to_head(&mut self, slot: usize) {
        let at = self
            .order
            .iter()
            .position(|&i| usize::from(i) == slot)
            .unwrap();
        self.order[..=at].rotate_right(1);
    }
    fn move_to_tail(&mut self, slot: usize) {
        let at = self
            .order
            .iter()
            .position(|&i| usize::from(i) == slot)
            .unwrap();
        self.order[at..].rotate_left(1);
    }
    fn free_slot(&mut self, slot: usize) {
        self.voices[slot].set_controller_assigned(false);
        self.slots[slot].mono = false;
        if self.slots[slot].status != Status::Free {
            self.slots[slot].status = Status::Free;
            self.slots[slot].key_down = false;
            self.move_to_head(slot);
        }
        // Note, timestamp and glide history survive normal freeing. The source
        // scan at H8 0x1c392 does not require an active envelope or held key.
    }
    fn reap_released(&mut self) {
        for slot in 0..VOICE_COUNT {
            if self.slots[slot].status == Status::Released
                && self.voices[slot].amp.stage == Stage::Idle
            {
                self.free_slot(slot);
            }
        }
    }
    fn clear_amp(&mut self, slot: usize) {
        self.voices[slot].clear_controller_amp();
        if self.slots[slot].status == Status::Released {
            self.free_slot(slot);
        }
    }
    fn clear_mono_slot(&mut self, slot: usize) {
        self.clear_amp(slot);
        self.free_slot(slot);
    }
    fn poly_slot(&mut self, part: usize) -> Option<usize> {
        // H8 0x90fa: first free, else lowest numeric status, ties by list order.
        let mut selected = self
            .order
            .iter()
            .copied()
            .map(usize::from)
            .find(|&i| self.slots[i].owner as usize == part)?;
        for &index in &self.order {
            let slot = usize::from(index);
            if self.slots[slot].owner as usize != part {
                continue;
            }
            if self.slots[slot].status == Status::Free {
                selected = slot;
                break;
            }
            if self.slots[slot].status < self.slots[selected].status {
                selected = slot;
            }
        }
        self.clear_amp(selected);
        self.move_to_tail(selected);
        Some(selected)
    }
    fn latest_glide_source(&self, part: usize) -> Option<(u8, i32)> {
        let mut selected: Option<usize> = None;
        for &index in &self.order {
            let i = usize::from(index);
            // Declared cold-start policy: unused slots have no meaningful note
            // history. Native part+91 force-source initialization is unresolved.
            if self.slots[i].owner as usize == part
                && self.slots[i].assigned
                && selected.map_or(true, |old| self.slots[i].age >= self.slots[old].age)
            {
                selected = Some(i);
            }
        }
        selected.map(|i| (self.voices[i].note, self.voices[i].glide.offset_cents))
    }
    fn on(&mut self, part: usize, origin: usize, channel: u8, note: u8, velocity: u8) {
        // 799e/915c: a Held source match selects 77fe, not that voice slot.
        let force_legato = self.parts[part].forced_portamento_source.is_some_and(|source| {
            self.slots.iter().any(|s| s.owner as usize == part
                && s.origin as usize == origin && s.note == source && s.status == Status::Held)
        });
        self.on_inner(part, origin, channel, note, velocity, force_legato);
        // 7a08 consumes the latch after dispatch, including rejected increments.
        self.parts[part].forced_portamento_source = None;
    }
    fn on_inner(&mut self, part: usize, origin: usize, channel: u8, note: u8, velocity: u8, force_legato: bool) {
        self.reap_released();
        if force_legato || self.parts[part].mono() {
            self.mono_on_policy(part, origin, channel, note, velocity, force_legato);
            return;
        }
        let count = &mut self.parts[part].held[origin][note as usize];
        if *count == 127 {
            return;
        }
        *count += 1;
        let slot = match self.poly_slot(part) {
            Some(i) => i,
            None => return,
        };
        let source = self.latest_glide_source(part);
        self.start_voice(slot, part, origin, channel, note, velocity, source, false);
    }
    fn mono_on(&mut self, part: usize, origin: usize, channel: u8, note: u8, velocity: u8) {
        self.mono_on_policy(part, origin, channel, note, velocity, false);
    }
    fn mono_on_policy(&mut self, part: usize, origin: usize, channel: u8, note: u8, velocity: u8, force_legato: bool) {
        // 6ade searches both M source banks; increment only the incoming bank.
        let overlap = self.parts[part].highest_mono_input().is_some();
        if self.parts[part].mono_held[origin].press(note).is_none() { return; }
        let slot = match self
            .mono_slot(part)
            .or_else(|| (0..8).find(|&i| self.slots[i].owner as usize == part))
        {
            Some(i) => i,
            None => return,
        };
        let legato_enabled = force_legato || self.parts[part].params[72] != 0;
        let legato = overlap && legato_enabled;
        if !legato {
            self.clear_mono_slot(slot);
        }
        // Only Legato-enabled physical gaps suppress portamento (0x787e).
        // Nonlegato Mono continues to use the latest part history across gaps.
        let source = if !overlap && legato_enabled {
            None
        } else {
            self.latest_glide_source(part)
        };
        self.start_voice(slot, part, origin, channel, note, velocity, source, legato);
        self.parts[part].mono_last_input = Some(note);
    }
    fn start_voice(
        &mut self,
        slot: usize,
        part: usize,
        origin: usize,
        channel: u8,
        note: u8,
        velocity: u8,
        source: Option<(u8, i32)>,
        legato: bool,
    ) {
        self.serial = self.serial.wrapping_add(1);
        if !legato {
            self.slots[slot].channel = channel;
            self.slots[slot].origin = origin as u8;
            self.slots[slot].status = Status::Held;
            self.slots[slot].key_down = true;
            self.slots[slot].mono = self.parts[part].mono();
        }
        self.slots[slot].note = note;
        self.slots[slot].assigned = true;
        // The native source scan precedes this timestamp write. Timestamp ties
        // select the later list entry. Direct MIDI has no emulated UART delay;
        // its millisecond phase and counter wrap are not claimed as verified.
        self.slots[slot].age = self.millisecond_clock;
        self.parts[part].last_velocity_code = if self.parts[part].params[283] != 0 {
            super::control::velocity_code(velocity)
        } else {
            0
        };
        self.refresh_global_controls(part);
        self.parts[part].lfo.retarget_note();
        self.parts[part].lfo2.retarget_note();
        self.voices[slot].morph = self.parts[part].morph;
        // Preserve the cached faded value until the next controller tick,
        // matching the existing native-derived retarget scheduling.
        self.voices[slot].raw_lfo_value = self.parts[part].lfo.value();
        self.voices[slot].lfo2_value = self.parts[part].lfo2.value();
        self.voices[slot].bend = self.parts[part].bend;
        self.voices[slot].wheel = self.parts[part].wheel;
        self.voices[slot].volume = self.parts[part].volume;
        self.voices[slot].expression = self.parts[part].expression;
        self.voices[slot].start_note_with_forced_source(note, velocity, source, legato, self.parts[part].forced_portamento_source);
        if legato {
            // 0xecbe does not promote released/free cached voices to status3.
            self.voices[slot].gate =
                matches!(self.slots[slot].status, Status::Held | Status::Pedal);
        }
    }
    fn off(&mut self, part: usize, origin: usize, channel: u8, note: u8, velocity: u8) {
        self.reap_released();
        let count = self.parts[part].held[origin][note as usize];
        if count != 0 {
            // When both populations exist, drain the counter belonging to the
            // old mode. Native explicitly forces NONlegato fallback here.
            if !self.parts[part].mono()
                && self.mono_off(part, origin, channel, note, velocity, false)
            {
                return;
            }
            self.parts[part].held[origin][note as usize] -= 1;
            let selected = self.order.iter().copied().map(usize::from).find(|&i| {
                self.slots[i].owner as usize == part
                    && self.slots[i].status == Status::Held
                    && self.slots[i].origin as usize == origin
                    && self.slots[i].channel == channel
                    && self.slots[i].note == note
            });
            // No cached-Mono filter and no protection for stolen old keys.
            if let Some(slot) = selected {
                self.normal_off_slot(slot, part, channel, velocity);
            }
        } else {
            self.mono_off(
                part,
                origin,
                channel,
                note,
                velocity,
                self.parts[part].params[72] != 0,
            );
        }
    }
    fn mono_off(
        &mut self,
        part: usize,
        origin: usize,
        channel: u8,
        note: u8,
        velocity: u8,
        legato: bool,
    ) -> bool {
        if !self.parts[part].mono_held[origin].release(note) {
            return false;
        }
        let next = self.parts[part].highest_mono_input();
        if self.parts[part].mono_last_input == Some(note) && next.is_some() {
            if !legato {
                // 0x94f8 iterates physical indices backwards and clears every
                // matching cached Mono slot, irrespective of source/status.
                for i in (0..VOICE_COUNT).rev() {
                    if self.slots[i].owner as usize == part
                        && self.slots[i].mono
                        && self.slots[i].note == note
                    {
                        self.clear_mono_slot(i);
                    }
                }
            }
            let slot = match self
                .mono_slot(part)
                .or_else(|| (0..8).find(|&i| self.slots[i].owner as usize == part))
            {
                Some(i) => i,
                None => return true,
            };
            let source = self.latest_glide_source(part);
            let next = next.unwrap();
            self.start_voice(slot, part, origin, channel, next, velocity, source, legato);
            self.parts[part].mono_last_input = Some(next);
        } else {
            // 0x91b2 omits both source and cached-Mono filtering. Channels are
            // host receive filtering, not additional hardware part identities.
            let selected = self.order.iter().copied().map(usize::from).find(|&i| {
                self.slots[i].owner as usize == part
                    && self.slots[i].status == Status::Held
                    && self.slots[i].note == note
            });
            if let Some(slot) = selected {
                self.normal_off_slot(slot, part, channel, velocity);
            }
        }
        true
    }
    fn pedal(&mut self, part: usize, origin: usize, channel: u8, down: bool) {
        self.parts[part].sustain[channel as usize] = down;
        if !down {
            for i in 0..VOICE_COUNT {
                if self.slots[i].owner as usize == part
                    && self.slots[i].origin as usize == origin
                    && self.slots[i].channel == channel
                    && self.slots[i].status == Status::Pedal
                {
                    self.release_slot(i);
                }
            }
        }
    }
    fn all_notes_off(&mut self, part: usize, origin: usize, channel: u8) {
        self.parts[part].held[origin] = [0; 128];
        self.parts[part].mono_held[origin].clear();
        self.parts[part].mono_last_input = None;
        for i in 0..VOICE_COUNT {
            if self.slots[i].owner as usize == part
                && self.slots[i].origin as usize == origin
                && self.slots[i].channel == channel
                && self.slots[i].status == Status::Held
            {
                // Native CC123 supplies64 directly, bypassing raw283 normalization.
                self.off_slot(i, part, channel, 64);
            }
        }
    }
    fn all_sound_off(&mut self, part: usize, origin: usize, channel: u8) {
        self.parts[part].held[origin] = [0; 128];
        self.parts[part].mono_held[origin].clear();
        self.parts[part].mono_last_input = None;
        // Preserve the preexisting explicit host panic policy for DSP silence;
        // this audit reconstructs ordinary allocation, not all CC120 internals.
        for i in (0..VOICE_COUNT).rev() {
            if self.slots[i].assigned
                && self.slots[i].owner as usize == part
                && self.slots[i].origin as usize == origin
                && self.slots[i].channel == channel
            {
                self.voices[i].silence();
                self.free_slot(i);
                self.slots[i].assigned = false;
            }
        }
    }
    // Existing broad host retirement policy remains velocity-less. Native
    // receive-change8af0 is a narrower direct-source123/121 sequence, which is
    // outside this ordinary-release slice; do not silently generalize its64.
    fn release_all(&mut self, part: usize) {
        self.parts[part].held = [[0; 128]; 2];
        for keys in &mut self.parts[part].mono_held {
            keys.clear();
        }
        self.parts[part].mono_last_input = None;
        self.parts[part].sustain = [false; 17];
        for i in 0..VOICE_COUNT {
            if self.slots[i].owner as usize == part
                && matches!(self.slots[i].status, Status::Held | Status::Pedal)
            {
                self.slots[i].status = Status::Released;
                self.slots[i].key_down = false;
                self.voices[i].note_off(self.slots[i].note);
            }
        }
    }
    fn set_morph(&mut self, part: usize, value: i32) {
        // 0x104c4 dispatches only on a changed part-global Morph code.
        if self.parts[part].morph == value {
            return;
        }
        self.parts[part].morph = value;
        self.refresh_global_controls(part);
        for (voice, slot) in self.voices.iter_mut().zip(&self.slots) {
            if slot.owner as usize == part {
                voice
                    .set_morph(value)
                    .expect("bounded control-assignment source");
            }
        }
    }
    fn mono_slot(&self, part: usize) -> Option<usize> {
        self.order
            .iter()
            .copied()
            .map(usize::from)
            .find(|&i| self.slots[i].owner as usize == part && self.slots[i].mono)
    }
    fn release_slot(&mut self, slot: usize) {
        self.slots[slot].status = Status::Released;
        self.slots[slot].key_down = false;
        self.voices[slot].release_retained_velocity(self.slots[slot].note);
    }
    fn normal_off_slot(&mut self, slot: usize, part: usize, channel: u8, velocity: u8) {
        // 7c3a samples the current switch only for actual ordinary release;
        // Mono fallback uses the note initializer's own velocity normalization.
        let raw = if self.parts[part].params[283] != 0 { velocity } else { 80 };
        self.off_slot(slot, part, channel, raw);
    }
    fn off_slot(&mut self, slot: usize, part: usize, channel: u8, raw_velocity: u8) {
        self.voices[slot].retain_release_velocity(raw_velocity);
        self.slots[slot].key_down = false;
        if self.parts[part].sustain[channel as usize] {
            self.slots[slot].status = Status::Pedal;
        } else {
            self.release_slot(slot);
        }
    }
    fn remote_matches(&self, channel: u8) -> bool {
        let r = self.common.system[9];
        r == 16 || r == u16::from(channel)
    }
    fn morph_bend_flags(&self) -> u8 {
        u8::from(self.parts[0].params[280] != 0) | (u8::from(self.parts[1].params[280] != 0) << 1)
    }
    fn ribbon_morph(raw: u8) -> i32 {
        let v = i32::from(raw) - 127;
        if v.abs() > 64 {
            v + v.signum()
        } else {
            v
        }
    }
    fn ribbon_bend(raw: u8) -> u16 {
        let r = u32::from(raw);
        if r <= 127 {
            (r * 8192 / 127) as u16
        } else {
            (8192 + (r - 127) * 8191 / 127) as u16
        }
    }
    fn apply_bend_mask(&mut self, mask: u8, value: u16) {
        for part in 0..2 {
            if mask & (1 << part) != 0 {
                self.direct_midi(part, 16, 0xe0, (value & 127) as u8, (value >> 7) as u8)
                    .expect("bounded per-part bend");
            }
        }
    }
    fn apply_morph_mask(&mut self, mask: u8, value: i32) {
        for part in 0..2 {
            if mask & (1 << part) != 0 {
                self.set_morph(part, value);
            }
        }
    }
    fn retarget_remote_masks(&mut self, old_morph: u8, old_bend: u8, force_sustain: bool, old_sustain: u8) {
        let new_morph = self.common.controller_mask();
        // Independent physical wheel/bend mask handler 0x28686 runs before
        // ribbon mask replay. Centered physical caches preserve direct values.
        for (mask, wheel, bend) in [
            (old_morph & !new_morph, 0, 8192),
            (new_morph & !old_morph, self.remote_wheel, self.remote_bend),
        ] {
            if self.remote_wheel != 0 {
                for part in 0..2 {
                    if mask & (1 << part) != 0 {
                        self.direct_midi(part, 16, 0xb0, 1, wheel)
                            .expect("bounded wheel");
                    }
                }
            }
            if self.remote_bend != 8192 {
                self.apply_bend_mask(mask, bend);
            }
        }
        if self.remote_sustain != 0 {
            let new_sustain=Self::arp_sustain_mask(&self.common);
            let removed=if force_sustain {old_sustain}else{old_sustain&!new_sustain};
            let added=if force_sustain {new_sustain}else{new_sustain&!old_sustain};
            self.dispatch_remote_sustain(removed,0);
            self.dispatch_remote_sustain(added,self.remote_sustain);
        }
        // Only assignment 3 owns the modeled expression route. Unlike sustain,
        // equal KeyMode does not force removal/reapplication. The assignment
        // transaction guard prevents unmodeled live cross-domain replay.
        if self.common.performance[28] == 3 && self.remote_expression != 127 {
            self.dispatch_remote_expression(old_morph & !new_morph, 127);
            self.dispatch_remote_expression(new_morph & !old_morph, self.remote_expression);
        }
        // 0x2b7e2/0x2b820 preserve direct overrides while ribbon is centered.
        if self.remote_ribbon == 127 {
            return;
        }
        let new_bend = new_morph & self.morph_bend_flags();
        self.apply_morph_mask(old_morph & !new_morph, 0);
        self.apply_morph_mask(
            new_morph & !old_morph,
            Self::ribbon_morph(self.remote_ribbon),
        );
        self.apply_bend_mask(old_bend & !new_bend, 8192);
        self.apply_bend_mask(new_bend & !old_bend, Self::ribbon_bend(self.remote_ribbon));
    }
    fn remote_morph(&mut self, ribbon: u8) {
        if self.remote_ribbon == 127 && ribbon == 127 {
            return;
        }
        self.remote_ribbon = ribbon;
        let mask = self.common.controller_mask();
        self.apply_morph_mask(mask, Self::ribbon_morph(ribbon));
        self.apply_bend_mask(mask & self.morph_bend_flags(), Self::ribbon_bend(ribbon));
    }
    fn remote_wheel_event(&mut self, value: u8) {
        if self.remote_wheel == 0 && value == 0 {
            return;
        }
        self.remote_wheel = value;
        let mask = self.common.controller_mask();
        for part in 0..2 {
            if mask & (1 << part) != 0 {
                self.direct_midi(part, 16, 0xb0, 1, value)
                    .expect("bounded wheel");
            }
        }
    }
    fn remote_bend_event(&mut self, value: u16) {
        if self.remote_bend == 8192 && value == 8192 {
            return;
        }
        self.remote_bend = value;
        self.apply_bend_mask(self.common.controller_mask(), value);
    }
    fn dispatch_remote_sustain(&mut self, mask: u8, value: u8) {
        let selected = if value != 0 {
            self.remote_sustain_active |= mask;
            mask
        } else {
            let selected = mask & self.remote_sustain_active;
            self.remote_sustain_active &= !selected;
            selected
        };
        for part in 0..2 {
            if selected & (1 << part) != 0 {
                self.pedal(part, 0, 16, value >= 64);
            }
        }
    }
    fn remote_sustain_event(&mut self, value: u8) {
        if self.remote_sustain == 0 && value == 0 {
            return;
        }
        self.remote_sustain = value;
        self.arp.set_pedal(value>=64);
        self.dispatch_remote_sustain(Self::arp_sustain_mask(&self.common), value);
    }
    fn dispatch_remote_expression(&mut self, mask: u8, value: u8) {
        // 0x291ce: the default value retires only destinations previously used
        // by this physical controller. It must preserve unrelated direct edits.
        let selected = if value != 127 {
            self.remote_expression_active |= mask;
            mask
        } else {
            let selected = mask & self.remote_expression_active;
            self.remote_expression_active &= !selected;
            selected
        };
        for part in 0..2 {
            if selected & (1 << part) != 0 {
                self.direct_midi(part, 16, 0xb0, 11, value)
                    .expect("bounded per-part expression");
            }
        }
    }
    fn remote_expression_event(&mut self, value: u8) {
        // 0x2d6b0..2d6cc: default-map Remote CC11 reaches this family only
        // under assignment 3. Assignment 11 neither stores this MIDI value
        // nor forwards it to the physical parameter-29 writer.
        if self.common.performance[28] != 3 { return; }
        if self.remote_expression == 127 && value == 127 {
            return;
        }
        self.remote_expression = value;
        self.dispatch_remote_expression(self.common.controller_mask(), value);
    }
    fn reset_remote_controllers(&mut self) {
        // No physical pedal entry point exists in this MIDI-only domain.
        // Generic/pan caches are not fabricated from Remote CC11; assignment
        // changes require the modeled expression family to be inactive.
        // Native order is pedal-family, physical wheel/bend, then ribbon.
        // No generic per-part reset is substituted.
        self.remote_sustain_event(0);
        self.remote_expression_event(127);
        self.remote_wheel_event(0);
        self.remote_bend_event(8192);
        self.remote_morph(127);
    }
    fn arp_output_mask(common:&Common) -> u8 {
        match common.performance[16] {
            0=>if common.performance[18]==1 {2}else{1},
            1=>match common.performance[21] {1=>2,2=>1,_=>3},
            _=>2,
        }
    }
    fn arp_sustain_mask(common:&Common)->u8 {
        let mask=common.controller_mask();
        if common.performance[23]!=0 {mask&!Self::arp_output_mask(common)}else{mask}
    }
    fn arp_accepts_note(common:&Common,note:u8)->bool {
        common.performance[16]!=2 || u16::from(note)<common.performance[17]
    }
    fn remote_direct_mask(common:&Common,note:u8)->u8 {
        let mask=common.keyboard_mask(note);
        if common.performance[23]!=0 && Self::arp_accepts_note(common,note) {
            mask&!Self::arp_output_mask(common)
        }else{mask}
    }
    fn dispatch_arp_events(&mut self, events:super::arp::Events) {
        let mask=Self::arp_output_mask(&self.common);
        for event in &events.items[..events.len] {
            for part in 0..2 {
                if mask&(1<<part)!=0 {
                    if event.portamento {self.parts[part].forced_portamento_source=Some(event.note);}
                    else if event.on {self.on(part,0,16,event.note,event.velocity);}
                    else {self.off(part,0,16,event.note,event.velocity);}
                }
            }
        }
    }
    fn remote_note(&mut self, note: u8, velocity: u8, on: bool) {
        // Physical/Remote wrapper26f3e normalizes zero on BOTH80/90 messages.
        let velocity = if !on && velocity == 0 { 64 } else { velocity };
        if on {
            if self.remote_keys[note as usize].is_some() {
                return;
            }
            self.remote_keys[note as usize] = Some(velocity);
        } else if self.remote_keys[note as usize].take().is_none() {
            return;
        }
        if self.common.performance[23]!=0 && Self::arp_accepts_note(&self.common,note) {
            self.arp.note(note,velocity,on);
        }
        let mask = Self::remote_direct_mask(&self.common,note);
        for part in 0..2 {
            if mask & (1 << part) != 0 {
                if on {
                    self.on(part, 0, 16, note, velocity)
                } else {
                    self.off(part, 0, 16, note, velocity)
                }
            }
        }
    }
    /// On-screen Remote input, independent of the external MIDI receive filter.
    /// Notes and pedal share the existing Remote caches with external MIDI:
    /// same-pitch downs deduplicate, and the first up releases that shared key.
    /// No channel settings or other controls are changed by this entrypoint.
    pub fn remote_touch(&mut self, status:u8, data1:u8, data2:u8) -> Result<(),MidiError> {
        if data1>127 || data2>127 {return Err(MidiError::InvalidData);}
        match status {
            0x90 if data2!=0 => self.remote_note(data1,data2,true),
            0x80 => self.remote_note(data1,data2,false),
            0x90 => self.remote_note(data1,64,false),
            0xb0 if data1==64 => self.remote_sustain_event(data2),
            _ => return Err(MidiError::UnsupportedRouting),
        }
        Ok(())
    }
    pub fn midi(&mut self, status: u8, data1: u8, data2: u8) -> Result<(), MidiError> {
        if data1 > 127 || data2 > 127 || !(0x80..=0xef).contains(&status) {
            return Err(MidiError::InvalidData);
        }
        let channel = status & 15;
        let kind = status & 0xf0;
        if self.remote_matches(channel) && !(kind == 0xb0 && data1 == 120) {
            match kind {
                0x90 if data2 != 0 => self.remote_note(data1, data2, true),
                0x80 => self.remote_note(data1, data2, false),
                0x90 => self.remote_note(data1, 64, false),
                0xd0 => self.remote_morph(127 + data1),
                0xb0 if data1 == 2 => self.remote_morph(127 - data2),
                0xb0 if data1 == 1 => self.remote_wheel_event(data2),
                0xe0 => self.remote_bend_event(u16::from(data1) | (u16::from(data2) << 7)),
                0xb0 if matches!(data1, 7 | 10) => {
                    // Default system mappings and no MIDI-learn assignment:
                    // native Remote CC7/10 have no target in this domain.
                }
                0xb0 if data1 == 11 => self.remote_expression_event(data2),
                0xb0 if data1 == 64 => self.remote_sustain_event(data2),
                0xb0 if data1 == 121 => {
                    if data2 == 0 { self.reset_remote_controllers(); }
                },
                0xb0 if data1 == 123 && self.common.performance[23]!=0 => {
                    // 0x2e994 rejects nonzero values;0x275d8 releases only
                    // cached physical keys. Hold/pedal keep the Arp latch.
                    if data2==0 {for note in 0..128 {if self.remote_keys[note].is_some(){self.remote_note(note as u8,80,false);}}}
                }
                _ => return Err(MidiError::UnsupportedRouting),
            }
            return Ok(());
        }
        let matched = [
            self.parts[0].extra[2] == u16::from(channel),
            self.parts[1].extra[2] == u16::from(channel),
        ];
        // Ordinary controllers are shared part values across both voice sources.
        // Panic/all-notes-off with mixed sources remains separately unverified.
        if !matches!(kind, 0x80 | 0x90 | 0xd0 | 0xe0)
            && !(kind == 0xb0 && matches!(data1, 1 | 2 | 7 | 10 | 11 | 64 | 84 | 121))
            && self
                .slots
                .iter()
                .any(|s| matched[s.owner as usize] && s.origin == 0 && s.status != Status::Free)
        {
            return Err(MidiError::UnsupportedRouting);
        }
        for part in 0..2 {
            if matched[part] {
                self.direct_midi(part, channel, kind, data1, data2)?;
            }
        }
        Ok(())
    }
    fn direct_midi(
        &mut self,
        part: usize,
        channel: u8,
        kind: u8,
        data1: u8,
        data2: u8,
    ) -> Result<(), MidiError> {
        match kind {
            0x90 if data2 > 0 => self.on(part, 1, channel, data1, data2),
            0x80 => self.off(part, 1, channel, data1, data2),
            0x90 => self.off(part, 1, channel, data1, 64),
            0xb0 => match data1 {
                84 => self.parts[part].forced_portamento_source = Some(data2),
                64 => self.pedal(part, 1, channel, data2 >= 64),
                10 => {
                    self.parts[part].pan = data2;
                    self.refresh_global_controls(part);
                }
                // Native channel-mode actions require a zero value. Keep this
                // inside the existing direct route and its source-ownership guard.
                120 | 121 | 123 if data2 != 0 => {},
                120 => self.all_sound_off(part, 1, channel),
                123 => self.all_notes_off(part, 1, channel),
                121 => {
                    // Part ResetControllers; the Remote physical reset differs.
                    self.parts[part].forced_portamento_source = None;
                    self.pedal(part, 1, channel, false);
                    self.set_morph(part, 0);
                    let p = &mut self.parts[part];
                    p.bend = 8192;
                    p.wheel = 0;
                    p.expression = 127;
                    p.morph = 0;
                    p.pan = 64;
                    self.refresh_global_controls(part);
                    for (v, s) in self.voices.iter_mut().zip(&self.slots) {
                        if s.owner as usize == part && s.assigned {
                            v.bend = 8192;
                            v.wheel = 0;
                            v.expression = 127;
                            v.refresh_controls();
                            v.refresh_amplitude_base();
                            v.recalculate();
                        }
                    }
                }
                1 => {
                    self.parts[part].wheel = data2;
                    for (v, s) in self.voices.iter_mut().zip(&self.slots) {
                        if s.owner as usize == part && s.assigned {
                            v.set_modulation_wheel(data2).expect("bounded wheel");
                        }
                    }
                }
                2 => self.set_morph(part, -super::control::wheel_level(data2)),
                7 | 11 => {
                    if data1 == 7 {
                        self.parts[part].volume = data2
                    } else {
                        self.parts[part].expression = data2
                    }
                    for (v, s) in self.voices.iter_mut().zip(&self.slots) {
                        if s.owner as usize == part && s.assigned {
                            if data1 == 7 {
                                v.set_volume(data2).expect("bounded volume")
                            } else {
                                v.set_expression(data2).expect("bounded expression")
                            }
                        }
                    }
                }
                _ => return Err(MidiError::UnsupportedController(data1)),
            },
            0xe0 => {
                let raw = u16::from(data1) | (u16::from(data2) << 7);
                self.parts[part].bend = raw;
                for (v, s) in self.voices.iter_mut().zip(&self.slots) {
                    if s.owner as usize == part && s.assigned {
                        v.set_pitch_bend(raw).expect("bounded bend");
                    }
                }
            }
            0xd0 => self.set_morph(part, super::control::wheel_level(data1)),
            _ => return Err(MidiError::UnsupportedMessage(kind | channel)),
        }
        Ok(())
    }
    pub fn set_lfo_phase(&mut self, phase: f64) -> Result<(), &'static str> {
        self.set_part_lfo_phase(0, phase)
    }
    pub fn set_part_lfo_phase(&mut self, part: usize, phase: f64) -> Result<(), &'static str> {
        let p = self.parts.get_mut(part).ok_or("part must be0 or1")?;
        p.lfo.set_phase(phase)?;
        p.effects.update_lfo(p.lfo.value());
        for (v, s) in self.voices.iter_mut().zip(&self.slots) {
            if s.owner as usize == part {
                v.raw_lfo_value = p.lfo.value();
                v.lfo_value = v.fade.scale(v.raw_lfo_value);
                v.lfo_edge = false;
                v.update_modulation();
            }
        }
        Ok(())
    }
    pub fn set_lfo2_phase(&mut self, phase: f64) -> Result<(), &'static str> {
        self.set_part_lfo2_phase(0, phase)
    }
    pub fn set_part_lfo2_phase(&mut self, part: usize, phase: f64) -> Result<(), &'static str> {
        let p = self.parts.get_mut(part).ok_or("part must be0 or1")?;
        p.lfo2.set_phase(phase)?;
        for (v, s) in self.voices.iter_mut().zip(&self.slots) {
            if s.owner as usize == part {
                v.lfo2_value = p.lfo2.value();
                v.update_modulation();
            }
        }
        Ok(())
    }
    pub fn set_control_phase(&mut self, phase: u16) -> Result<(), &'static str> {
        if phase >= 882 {
            return Err("control phase must be0..882");
        }
        for v in &mut self.voices {
            v.set_control_phase(phase)?;
        }
        self.until_tick = phase;
        Ok(())
    }
    pub fn set_voice_phases(&mut self, index: usize, phases: [f64; 7]) -> Result<(), &'static str> {
        self.voices
            .get_mut(index)
            .ok_or("voice index must be0..7")?
            .set_phases(phases)
    }
    pub fn held_voice_count(&self) -> usize {
        self.voices.iter().filter(|v| v.gate).count()
    }
    pub fn sounding_voice_count(&self) -> usize {
        self.voices
            .iter()
            .filter(|v| v.gate || v.amp.level != 0 || v.amp.value != 0)
            .count()
    }
    fn clear_bookkeeping(&mut self) {
        self.slots = [Slot::EMPTY; 8];
        for i in 0..8 {
            self.slots[i].owner = self.common.owner(i);
        }
        self.order = [0, 1, 2, 3, 4, 5, 6, 7];
        self.remote_keys = [None; 128];
        self.arp=super::arp::Arpeggiator::default();
        self.arp.range_write(self.common.performance[26] as u8);
        self.arp.pattern_write(self.common.performance[25]);
        if super::arp::supports_mode(self.common.performance[24]) {self.arp.mode_write(self.common.performance[24] as u8);}
        self.arp.set_hold(self.common.performance[27]!=0);
        self.arp.switch_write(self.common.performance[23]!=0);
        self.remote_sustain = 0;
        self.remote_sustain_active = 0;
        for p in &mut self.parts {
            p.mono_last_input = None;
            p.held = [[0; 128]; 2];
            for k in &mut p.mono_held {
                k.clear()
            }
            p.sustain = [false; 17];
            p.output = OutputPath::new();
            p.effects.reset();
            p.output.set_tone(p.params[59], p.params[60]);
        }
    }
    pub fn silence(&mut self) {
        for v in &mut self.voices {
            v.silence();
            v.set_controller_assigned(false);
        }
        self.clear_bookkeeping();
    }
    pub fn reset(&mut self) {
        self.oscillator_history = super::SharedOscillatorHistory::new();
        for v in &mut self.voices {
            v.reset();
        }
        self.clear_bookkeeping();
        self.serial = 0;
        self.remote_ribbon = 127;
        self.remote_wheel = 0;
        self.remote_bend = 8192;
        self.remote_expression = 127;
        self.remote_expression_active = 0;
        self.millisecond_clock = 0;
        self.millisecond_remainder = 0;
        self.until_tick = 0;
        self.tempo_clock = super::tempo::TempoClock::new(self.common.performance[34]);
        for p in &mut self.parts {
            p.forced_portamento_source = None;
            p.bend = 8192;
            p.wheel = 0;
            p.volume = 127;
            p.expression = 127;
            p.pan = 64;
            p.morph = 0;
            p.last_velocity_code = 0;
            p.lfo = Lfo::new();
            p.lfo2 = Lfo::new();
        }
        for p in 0..2 {
            self.refresh_global_controls(p);
        }
    }
    pub fn next_sample(&mut self) -> f32 {
        self.next_stereo_sample().0
    }
    pub fn next_stereo_sample(&mut self) -> (f32, f32) {
        if let Some(pulse) = self.tempo_clock.native_sample() {
            for p in &mut self.parts {
                p.lfo.clock_pulse(pulse);
            }
            let events=self.arp.pulse(pulse);
            self.dispatch_arp_events(events);
        }
        if self.until_tick == 0 {
            for p in &mut self.parts {
                p.lfo.tick();
                p.lfo2.tick();
                p.effects.update_lfo(p.lfo.value());
            }
            self.until_tick = 882;
        }
        self.until_tick -= 1;
        let mut sums = [0i64; 2];
        for (index, (v, s)) in self.voices.iter_mut().zip(&self.slots).enumerate() {
            let p = &self.parts[s.owner as usize];
            sums[s.owner as usize] += v
                .next_voice_frame_with_history(Some((p.lfo.value(), p.lfo.edge(), p.lfo2.value())),
                    Some((&self.oscillator_history, index)), matches!(index, 2 | 5)).1;
            if let Some(writes) = v.oscillator_tail_writes() {
                self.oscillator_history.publish(index, writes);
            }
        }
        // Every physical slot has written before the one board-frame rotation.
        self.oscillator_history.advance([self.voices[2].balance, self.voices[5].balance],
            self.voices[2].last_dc_mixed);
        self.reap_released();
        self.millisecond_remainder += 1000;
        if self.millisecond_remainder >= super::NATIVE_SAMPLE_RATE {
            self.millisecond_remainder -= super::NATIVE_SAMPLE_RATE;
            self.millisecond_clock = self.millisecond_clock.wrapping_add(1);
        }
        let mut parts = [(0i64, 0i64); 2];
        for i in 0..2 {
            let p = &mut self.parts[i];
            parts[i] = p.effects.process(p.output.equalize(sums[i]));
        }
        let (l, r) = if self.common.performance[20] == 0 {
            super::pan::dac_mix(parts[0], parts[1])
        } else {
            (
                super::sat24(2 * (parts[1].0 + parts[1].1)) >> 2,
                super::sat24(2 * (parts[0].0 + parts[0].1)) >> 2,
            )
        };
        (l as f32 / Q23 as f32, r as f32 / Q23 as f32)
    }
    pub fn render_mono(&mut self, output: &mut [f32]) {
        for x in output {
            *x = self.next_sample()
        }
    }
    pub fn render_stereo(
        &mut self,
        left: &mut [f32],
        right: &mut [f32],
    ) -> Result<(), &'static str> {
        if left.len() != right.len() {
            return Err("channel lengths must match");
        }
        for (l, r) in left.iter_mut().zip(right) {
            (*l, *r) = self.next_stereo_sample()
        }
        Ok(())
    }
}
fn parameter_code(error: ParameterError) -> i32 {
    match error {
        ParameterError::UnsupportedParameter(_) => -2,
        ParameterError::OutOfRange { .. } => -3,
        ParameterError::UnsupportedValue { .. } => -4,
    }
}

/// Off-callback allocation only. Every other handle operation must be serialized
/// by its owner; a raw handle is not an internally synchronized shared object.
#[no_mangle]
pub extern "C" fn mdlr_jp8000_rust_create() -> *mut Jp8000Instrument {
    Box::into_raw(Box::new(Jp8000Instrument::new()))
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_destroy(handle: *mut Jp8000Instrument) {
    if !handle.is_null() {
        drop(Box::from_raw(handle));
    }
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_set_parameter(
    handle: *mut Jp8000Instrument,
    id: u16,
    value: u16,
) -> i32 {
    let Some(instrument) = handle.as_mut() else {
        return -1;
    };
    match instrument.set_parameter(id, value) {
        Ok(()) => 0,
        Err(e) => parameter_code(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_apply_patch(
    handle: *mut Jp8000Instrument,
    ids: *const u16,
    values: *const u16,
    count: u32,
) -> i32 {
    let Some(instrument) = handle.as_mut() else {
        return -1;
    };
    if count == 0 {
        return 0;
    }
    if count > 256 || ids.is_null() || values.is_null() {
        return -6;
    }
    let ids = std::slice::from_raw_parts(ids, count as usize);
    let values = std::slice::from_raw_parts(values, count as usize);
    match instrument.apply_patch(ids, values) {
        Ok(()) => 0,
        Err(e) => parameter_code(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_get_parameter(
    handle: *const Jp8000Instrument,
    id: u16,
) -> i32 {
    handle
        .as_ref()
        .and_then(|i| i.parameter(id))
        .map(|v| v as i32)
        .unwrap_or(-1)
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_remote_touch(
    handle:*mut Jp8000Instrument,status:u8,a:u8,b:u8,
)->i32 {
    let Some(instrument)=handle.as_mut() else {return -1;};
    match instrument.remote_touch(status,a,b) {
        Ok(())=>0,Err(MidiError::InvalidData)=>-3,Err(_)=>-5,
    }
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_midi(
    handle: *mut Jp8000Instrument,
    status: u8,
    a: u8,
    b: u8,
) -> i32 {
    let Some(instrument) = handle.as_mut() else {
        return -1;
    };
    match instrument.midi(status, a, b) {
        Ok(()) => 0,
        Err(MidiError::InvalidData) => -3,
        Err(_) => -5,
    }
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_render(
    handle: *mut Jp8000Instrument,
    left: *mut f32,
    right: *mut f32,
    frames: u32,
) -> i32 {
    let Some(instrument) = handle.as_mut() else {
        return -1;
    };
    if frames == 0 {
        return 0;
    }
    if left.is_null() || right.is_null() || frames as usize > MAX_FFI_FRAMES {
        return -6;
    }
    // Raw writes permit left==right (left-channel mono) without aliased Rust
    // mutable slices. Other partial overlaps are a caller contract violation.
    for frame in 0..frames as usize {
        let (l, r) = instrument.next_stereo_sample();
        left.add(frame).write(l);
        if right != left {
            right.add(frame).write(r);
        }
    }
    0
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_silence(handle: *mut Jp8000Instrument) {
    if let Some(instrument) = handle.as_mut() {
        instrument.silence();
    }
}
#[no_mangle]
pub extern "C" fn mdlr_jp8000_rust_parameter_capability(id: u16) -> i32 {
    if matches!(
        id,
        280 | 1002 | 1003 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 | 2027 | 3009
    ) || IMPLEMENTED_PARAMETERS.contains(&id)
    {
        1
    } else if (16..74).contains(&id)
        || matches!(id, 280 | 283)
        || super::control::assignment_destination(id).is_some()
        || super::accepted_inactive_parameter(id, 0)
        || matches!(id, 1003 | 2019 | 2034 | 3009 | 3010)
    {
        2
    } else if id == 2028 {
        2 // Bounded selector storage/MIDI behavior; no physical pedal/ADC API.
    } else {
        0
    }
}
/// Immutable feature coverage, not final-state validation. For partially
/// implemented enums:1 means active,2 bounded or dormant storage,0 unavailable.
/// Other controls inherit their ID capability; ordinary bounds still apply.
#[no_mangle]
pub extern "C" fn mdlr_jp8000_rust_parameter_value_capability(id: u16, value: u16) -> i32 {
    match id {
        2028 => if matches!(value, 3 | 11) { 2 } else { 0 },
        2024 if value <= 3 => if super::arp::supports_mode(value) { 1 } else { 2 },
        2025 if value <= 89 => if super::arp::supports_pattern(value) { 1 } else { 2 },
        2024 | 2025 => 0,
        _ => mdlr_jp8000_rust_parameter_capability(id),
    }
}

#[no_mangle]
pub extern "C" fn mdlr_jp8000_rust_supported_waveform(raw: u16) -> i32 {
    i32::from(raw <= 6)
}

#[cfg(test)]
mod active_arp_tests {
    use super::*;
    fn synth(mode:u16,destination:u16,panel:u16)->Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[1002,30,51],&[0,5,127],&[1002,30,51],&[1,5,127],
            &[2016,2017,2018,2021,2023,2024,2025,2026,2027,3009,2034],
            &[mode,62,panel,destination,1,0,4,0,0,2,120]).unwrap();p
    }
    fn through_pulse(p:&mut Jp8000Instrument,pulse:u32) {
        while p.tempo_clock.pulses()<pulse {p.next_stereo_sample();}
    }
    #[test] fn arp_uses_existing_clock_and_direct_notes_keep_immediate_acceptance() {
        let mut p=synth(0,0,0);p.midi(0x92,60,100).unwrap();
        assert_eq!(p.held_voice_count(),0);
        for _ in 0..1940 {p.next_stereo_sample();}
        assert_eq!(p.held_voice_count(),0);p.next_stereo_sample();
        assert_eq!(p.tempo_clock.pulses(),1);assert_eq!(p.held_voice_count(),1);
        through_pulse(&mut p,6);assert_eq!(p.held_voice_count(),0);
        p.midi(0x90,72,100).unwrap();assert_eq!(p.held_voice_count(),1);
        through_pulse(&mut p,7);assert_eq!(p.held_voice_count(),2);
    }
    #[test] fn single_dual_split_output_and_passthrough_masks_match_native_events() {
        for mode in 0..3 {for destination in 0..3 {for panel in 0..2 {
            let mut p=synth(mode,destination,panel);
            p.midi(0x92,57,71).unwrap();p.midi(0x92,67,93).unwrap();
            let before:Vec<_>=p.slots.iter().filter(|s|s.key_down).map(|s|s.owner).collect();
            if mode==0 || (mode==1 && destination==0) {assert!(before.is_empty());}
            if mode==1 && destination==1 {assert_eq!(before,[0,0]);}
            if mode==1 && destination==2 {assert_eq!(before,[1,1]);}
            if mode==2 {assert_eq!(before,[0]);}
            through_pulse(&mut p,1);
            let generated:Vec<_>=p.slots.iter().filter(|s|s.key_down && s.note==57).map(|s|s.owner).collect();
            if mode==0 {assert_eq!(generated,[panel as u8]);}
            if mode==1 {assert!(generated.contains(&0)&&generated.contains(&1));}
            if mode==2 {assert_eq!(generated,[1]);}
        }}}
    }
    #[test] fn switch_replays_physical_keys_and_sustain_holds_input_not_generated_gates() {
        let mut p=synth(0,0,0);p.set_parameter(2023,0).unwrap();
        p.midi(0x92,60,100).unwrap();p.midi(0xb2,64,64).unwrap();
        assert_eq!(p.held_voice_count(),1);p.set_parameter(2023,1).unwrap();
        assert_eq!(p.held_voice_count(),0);through_pulse(&mut p,1);assert_eq!(p.held_voice_count(),1);
        p.midi(0x82,60,64).unwrap();through_pulse(&mut p,6);assert_eq!(p.held_voice_count(),0);
        through_pulse(&mut p,7);assert_eq!(p.held_voice_count(),1);
        p.midi(0xb2,64,0).unwrap();through_pulse(&mut p,8);assert_eq!(p.held_voice_count(),0);
        p.midi(0x92,67,100).unwrap();through_pulse(&mut p,9);p.set_parameter(2023,0).unwrap();
        assert_eq!(p.held_voice_count(),1);p.midi(0x82,67,64).unwrap();assert_eq!(p.held_voice_count(),0);
    }
    #[test] fn unsupported_active_generators_and_live_routing_reject_atomically() {
        let mut a=synth(0,0,0);let mut b=synth(0,0,0);
        a.midi(0x92,60,100).unwrap();b.midi(0x92,60,100).unwrap();
        for (id,value) in [(2024,4),(2025,6),(2029,1),(2018,1),(2021,2)] {
            assert!(a.apply_performance(&[41],&[32],&[51],&[0],&[id],&[value]).is_err());
            assert_eq!(a.parts[0].params,b.parts[0].params);assert_eq!(a.parts[1].params,b.parts[1].params);
            assert_eq!(a.parameter(id),b.parameter(id));
            for _ in 0..256 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        }
        a.set_parameter(2023,0).unwrap();a.set_parameter(2024,3).unwrap();a.set_parameter(2025,6).unwrap();
        assert!(a.set_parameter(2023,1).is_err());assert_eq!(a.parameter(2023),Some(0));
    }
    #[test] fn arp_audio_is_invariant_under_callback_partitions_and_reset_cleans_gates() {
        let mut reference=None;
        for size in [1,7,64,257] {
            let mut p=synth(1,0,0);let mut output=Vec::new();
            for segment in 0..3 {
                match segment {0=>{p.midi(0x92,60,100).unwrap();p.midi(0x92,67,80).unwrap();},
                    1=>{p.set_parameter(2024,2).unwrap();p.set_parameter(2034,250).unwrap();},
                    _=>{p.midi(0xb2,123,0).unwrap();}}
                let mut left=[0.0;257];let mut right=[0.0;257];let mut remaining=20000;
                while remaining!=0 {let n=remaining.min(size);p.render_stereo(&mut left[..n],&mut right[..n]).unwrap();output.extend(left[..n].iter().zip(&right[..n]).map(|(l,r)|(l.to_bits(),r.to_bits())));remaining-=n;}
            }
            if let Some(expected)=&reference {assert_eq!(&output,expected);}else{reference=Some(output);}
            assert_eq!(p.held_voice_count(),0);p.reset();assert!(!p.arp.occupied());
            p.midi(0x92,64,100).unwrap();through_pulse(&mut p,1);assert_eq!(p.held_voice_count(),2);
        }
    }
}

/// Explicit part scope; legacy setter remains an Upper/common wrapper.
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_set_part_parameter(
    handle: *mut Jp8000Instrument,
    part: u8,
    id: u16,
    value: u16,
) -> i32 {
    let Some(i) = handle.as_mut() else { return -1 };
    match i.set_part_parameter(usize::from(part), id, value) {
        Ok(()) => 0,
        Err(e) => parameter_code(e),
    }
}
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_get_part_parameter(
    handle: *const Jp8000Instrument,
    part: u8,
    id: u16,
) -> i32 {
    handle
        .as_ref()
        .and_then(|i| i.part_parameter(usize::from(part), id))
        .map(|v| i32::from(v))
        .unwrap_or(-1)
}
/// All three lists are validated before either part/common state changes.
#[no_mangle]
pub unsafe extern "C" fn mdlr_jp8000_rust_apply_performance(
    handle: *mut Jp8000Instrument,
    upper_ids: *const u16,
    upper_values: *const u16,
    upper_count: u32,
    lower_ids: *const u16,
    lower_values: *const u16,
    lower_count: u32,
    common_ids: *const u16,
    common_values: *const u16,
    common_count: u32,
) -> i32 {
    let Some(i) = handle.as_mut() else { return -1 };
    for (ids, values, count) in [
        (upper_ids, upper_values, upper_count),
        (lower_ids, lower_values, lower_count),
        (common_ids, common_values, common_count),
    ] {
        if count > 256 || (count != 0 && (ids.is_null() || values.is_null())) {
            return -6;
        }
    }
    unsafe fn values<'a>(ptr: *const u16, count: u32) -> &'a [u16] {
        if count == 0 {
            &[]
        } else {
            std::slice::from_raw_parts(ptr, count as usize)
        }
    }
    match i.apply_performance(
        values(upper_ids, upper_count),
        values(upper_values, upper_count),
        values(lower_ids, lower_count),
        values(lower_values, lower_count),
        values(common_ids, common_count),
        values(common_values, common_count),
    ) {
        Ok(()) => 0,
        Err(e) => parameter_code(e),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn feedback_forces_mono_with_the_mono_switch_off() {
        for legato in [0, 1] {
            let mut p = Jp8000Instrument::new();
            p.apply_patch(&[30, 71, 72], &[3, 0, legato]).unwrap();
            for n in [60, 64, 67] {
                p.midi(0x90, n, 100).unwrap();
                assert_eq!(p.held_voice_count(), 1);
                assert_eq!(p.voices[0].note, n);
            }
            assert_eq!(p.parameter(71), Some(0));
            assert_eq!(p.parts[0].held[1].iter().sum::<u16>(), 0);
            p.midi(0x80, 64, 0).unwrap();
            assert_eq!(p.voices[0].note, 67);
            p.midi(0x80, 67, 0).unwrap();
            assert_eq!(p.voices[0].note, 60);
            p.midi(0x80, 60, 0).unwrap();
            assert_eq!(p.held_voice_count(), 0);
        }
    }
    #[test]
    fn mono_priority_fallback_uses_release_velocity_including_zero() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(
            &[71, 72, 283, 51, 336, 17, 284],
            &[1, 1, 1, 80, 192, 64, 192],
        )
        .unwrap();
        for (note, velocity) in [(60, 40), (67, 100), (64, 80), (55, 60)] {
            p.midi(0x90, note, velocity).unwrap();
            assert_eq!(p.voices[0].note, note);
            assert_eq!(p.held_voice_count(), 1);
        }
        for (released, velocity, next) in [(55, 37, 67), (67, 99, 64), (64, 0, 60)] {
            p.midi(0x80, released, velocity).unwrap();
            assert_eq!(p.voices[0].note, next);
            assert!(p.voices[0].gate);
            let code = super::super::control::velocity_code(velocity);
            assert_eq!(p.voices[0].velocity_code, code);
            assert_eq!(p.parts[0].last_velocity_code, code);
            let controls = super::super::control::effective_controls(&p.voices[0].params, code, 0);
            assert_eq!(p.voices[0].controls[51], controls[51]);
            let mut expected = Lfo::new();
            expected.configure(controls[16], controls[17]);
            assert_eq!(p.parts[0].lfo.increment(), expected.increment());
        }
        let serial = p.serial;
        p.midi(0x80, 100, 127).unwrap();
        assert_eq!(p.serial, serial);
        p.midi(0x80, 60, 0).unwrap();
        assert!(!p.voices[0].gate);
        assert!(p.parts[0].mono_held[1].is_empty());
    }
    #[test]
    fn mono_duplicates_choose_highest_and_saturated_presses_are_ignored() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[71, 72], &[1, 1]).unwrap();
        for n in [60, 67, 60] {
            p.midi(0x90, n, 100).unwrap();
        }
        p.midi(0x80, 60, 0).unwrap();
        assert_eq!(p.voices[0].note, 67);
        p.midi(0x80, 67, 0).unwrap();
        assert_eq!(p.voices[0].note, 60);
        p.midi(0x80, 60, 0).unwrap();
        assert!(!p.voices[0].gate);
        p.reset();
        for _ in 0..127 {
            p.midi(0x90, 60, 100).unwrap();
        }
        let serial = p.serial;
        p.midi(0x90, 60, 32).unwrap();
        assert_eq!(p.serial, serial);
        for _ in 0..127 {
            p.midi(0x80, 60, 0).unwrap();
        }
        assert!(!p.voices[0].gate);
        assert!(p.parts[0].mono_held[1].is_empty());
    }
    #[test]
    fn true_legato_keeps_three_envelopes_dsp_history_and_loading_windows() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(
            &[71, 72, 54, 55, 56, 28, 29, 47, 48, 49],
            &[1, 1, 64, 96, 64, 64, 96, 64, 96, 64],
        )
        .unwrap();
        p.midi(0x90, 60, 100).unwrap();
        for _ in 0..5000 {
            p.next_sample();
        }
        let v = &p.voices[0];
        let levels = [v.amp.level, v.filter_envelope.level, v.pitch_envelope.level];
        let stages = [v.amp.stage, v.filter_envelope.stage, v.pitch_envelope.stage];
        let phase = v.saw_phase;
        let amp_value = v.amp.value;
        let filter_state = v.filter.state;
        let windows = [
            v.coefficient_fast,
            v.filter.cutoff_fast,
            v.filter.damping_fast,
        ];
        p.midi(0x90, 67, 100).unwrap();
        let v = &p.voices[0];
        assert_eq!(
            [v.amp.level, v.filter_envelope.level, v.pitch_envelope.level],
            levels
        );
        assert_eq!(
            [v.amp.stage, v.filter_envelope.stage, v.pitch_envelope.stage],
            stages
        );
        assert_eq!(v.saw_phase, phase);
        assert_eq!(v.amp.value, amp_value);
        assert_eq!(v.filter.state, filter_state);
        assert_eq!(
            [
                v.coefficient_fast,
                v.filter.cutoff_fast,
                v.filter.damping_fast
            ],
            windows
        );
        p.set_parameter(72, 0).unwrap();
        p.midi(0x90, 64, 100).unwrap();
        let v = &p.voices[0];
        assert_eq!(
            [v.amp.level, v.filter_envelope.level, v.pitch_envelope.level],
            [640; 3]
        );
        assert_eq!(v.amp.value, amp_value);
        assert!(v.coefficient_fast > 0);
    }
    #[test]
    fn pedal_only_gap_retriggers_and_does_not_glide_but_overlap_still_falls_back() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[71, 72, 69, 70, 54], &[1, 1, 1, 64, 64])
            .unwrap();
        p.midi(0x90, 60, 100).unwrap();
        for _ in 0..5000 {
            p.next_sample();
        }
        p.midi(0xb0, 64, 127).unwrap();
        p.midi(0x80, 60, 0).unwrap();
        assert!(p.voices[0].gate);
        assert!(p.parts[0].mono_held[1].is_empty());
        p.midi(0x90, 72, 100).unwrap();
        assert_eq!(p.voices[0].glide.offset_cents, 0);
        assert_eq!(p.voices[0].amp.level, 640);
        p.midi(0x90, 67, 100).unwrap();
        p.midi(0x80, 67, 0).unwrap();
        assert_eq!(p.voices[0].note, 72);
        p.midi(0x80, 72, 0).unwrap();
        assert!(p.voices[0].gate);
        p.midi(0xb0, 64, 0).unwrap();
        assert!(!p.voices[0].gate);
    }
    #[test]
    fn glide_source_survives_silence_and_tracks_the_last_voice_not_the_new_slot() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[69, 70], &[1, 64]).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0x90, 72, 100).unwrap();
        assert_eq!(p.voices[1].glide.initial_cents, -1200);
        assert_eq!(p.voices[1].glide.offset_cents, -1163);
        assert_eq!(p.voices[1].pitch_cents, 37);
        p.midi(0x90, 67, 100).unwrap();
        assert_eq!(p.voices[2].glide.initial_cents, -663);
        assert_eq!(p.voices[2].glide.offset_cents, -643);
        p.midi(0xb0, 123, 0).unwrap();
        for _ in 0..5 * 88_200 {
            p.next_sample();
        }
        p.midi(0x90, 79, 100).unwrap();
        let i = (0..VOICE_COUNT).find(|&i| p.voices[i].gate).unwrap();
        assert_eq!(p.voices[i].glide.initial_cents, -1200);
        assert_eq!(p.voices[i].glide.offset_cents, -1163);
    }
    #[test]
    fn mono_enable_preserves_old_poly_population_without_fallback_into_it() {
        let mut p = Jp8000Instrument::new();
        for n in [60, 64, 67] {
            p.midi(0x90, n, 100).unwrap();
        }
        p.set_parameter(71, 1).unwrap();
        assert_eq!(p.held_voice_count(), 3);
        p.midi(0x90, 72, 100).unwrap();
        assert_eq!(p.voices[0].note, 72);
        assert!(p.voices[1].gate && p.voices[2].gate);
        p.midi(0x80, 60, 0).unwrap();
        assert!(p.voices[0].gate);
        p.midi(0x80, 64, 0).unwrap();
        assert!(!p.voices[1].gate);
        p.midi(0x80, 72, 0).unwrap();
        assert!(!p.voices[0].gate);
        assert!(p.voices[2].gate);
        p.midi(0x80, 67, 0).unwrap();
        assert_eq!(p.held_voice_count(), 0);
    }
    #[test]
    fn mono_glide_midi_and_control_events_are_partition_independent() {
        fn run(p: &mut Jp8000Instrument, chunks: &[usize]) -> Vec<f32> {
            p.apply_patch(
                &[71, 72, 69, 70, 30, 61, 62, 58, 52],
                &[1, 1, 1, 96, 5, 1, 70, 1, 92],
            )
            .unwrap();
            let mut out = Vec::new();
            for (status, n, v) in [
                (0x90, 60, 32),
                (0x90, 72, 100),
                (0x80, 72, 0),
                (0xb0, 64, 127),
                (0x80, 60, 32),
                (0x90, 67, 80),
                (0xb0, 64, 0),
                (0x80, 67, 40),
            ] {
                p.midi(status, n, v).unwrap();
                let mut left = [0.0; 128];
                let mut right = [0.0; 128];
                for &len in chunks {
                    p.render_stereo(&mut left[..len], &mut right[..len])
                        .unwrap();
                    out.extend(
                        left[..len]
                            .iter()
                            .copied()
                            .zip(right[..len].iter().copied()),
                    );
                }
            }
            out.into_iter().flat_map(|(l, r)| [l, r]).collect()
        }
        let a = run(&mut Jp8000Instrument::new(), &[128, 128]);
        let b = run(&mut Jp8000Instrument::new(), &[1, 7, 64, 56, 128]);
        assert_eq!(a, b);
    }

    #[test]
    fn native_poly_to_mono_same_pitch_off_uses_list_not_counter_population() {
        let mut p = Jp8000Instrument::new();
        for n in [55, 60, 60] {
            p.midi(0x90, n, 100).unwrap();
        }
        p.set_parameter(71, 1).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(p.order, [0, 3, 4, 5, 6, 7, 1, 2]);
        assert_eq!(p.parts[0].held[1][60], 2);
        assert!(p.slots[0].mono);
        for (slot, remaining_poly) in [(0, 1), (1, 0), (2, 0)] {
            p.midi(0x80, 60, 0).unwrap();
            assert!(!p.voices[slot].gate);
            assert_eq!(p.parts[0].held[1][60], remaining_poly);
        }
        assert!(p.parts[0].mono_held[1].is_empty());
    }
    #[test]
    fn native_mono_to_poly_same_pitch_forces_nonlegato_fallback() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[71, 72, 54, 283], &[1, 1, 64, 1]).unwrap();
        for _ in 0..2 {
            p.midi(0x90, 60, 100).unwrap();
        }
        p.render_mono(&mut [0.0; 5000]);
        p.set_parameter(71, 0).unwrap();
        for _ in 0..2 {
            p.midi(0x90, 60, 100).unwrap();
        }
        p.midi(0x80, 60, 32).unwrap();
        assert_eq!(p.parts[0].held[1][60], 2);
        assert_eq!(p.voices[0].amp.level, 640);
        assert!(!p.slots[0].mono);
        assert_eq!(
            p.voices[0].velocity_code,
            super::super::control::velocity_code(32)
        );
        for slot in [0, 1, 2] {
            p.midi(0x80, 60, 0).unwrap();
            assert!(!p.voices[slot].gate);
        }
        assert!(p.parts[0].mono_held[1].is_empty());
        assert_eq!(p.parts[0].held[1][60], 0);
    }
    #[test]
    fn native_cached_mono_stolen_by_poly_uses_designated_zero_and_retains_keys() {
        let mut p = Jp8000Instrument::new();
        p.set_parameter(71, 1).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.set_parameter(71, 0).unwrap();
        for note in 64..72 {
            p.midi(0x90, note, 100).unwrap();
        }
        assert_eq!(p.slots[0].note, 71);
        assert!(p.mono_slot(0).is_none());
        assert_eq!(p.order, [1, 2, 3, 4, 5, 6, 7, 0]);
        p.set_parameter(71, 1).unwrap();
        p.midi(0x90, 72, 100).unwrap();
        assert_eq!(p.mono_slot(0), Some(0));
        assert_eq!(p.order, [0, 1, 2, 3, 4, 5, 6, 7]);
        p.midi(0x80, 72, 0).unwrap();
        assert_eq!(p.slots[0].note, 60);
        assert!(p.voices[0].gate);
    }
    #[test]
    fn native_nine_duplicate_poly_presses_release_first_live_and_cap_at_127() {
        let mut p = Jp8000Instrument::new();
        for _ in 0..9 {
            p.midi(0x90, 60, 100).unwrap();
        }
        assert_eq!(p.order, [1, 2, 3, 4, 5, 6, 7, 0]);
        for (step, slot) in [1, 2, 3, 4, 5, 6, 7, 0].into_iter().enumerate() {
            p.midi(0x80, 60, 0).unwrap();
            assert!(!p.voices[slot].gate);
            assert_eq!(p.held_voice_count(), 7 - step);
        }
        assert_eq!(p.parts[0].held[1][60], 1);
        p.midi(0x80, 60, 0).unwrap();
        assert_eq!(p.parts[0].held[1][60], 0);
        p.reset();
        for _ in 0..127 {
            p.midi(0x90, 60, 100).unwrap();
        }
        let serial = p.serial;
        let order = p.order;
        p.midi(0x90, 60, 32).unwrap();
        assert_eq!(p.parts[0].held[1][60], 127);
        assert_eq!(p.serial, serial);
        assert_eq!(p.order, order);
    }
    #[test]
    fn native_free_transition_uses_controller_idle_not_smoothed_dsp_zero() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[71, 54, 57], &[1, 0, 0]).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.render_mono(&mut [0.0; 5000]);
        let old_note = p.slots[0].note;
        let old_stamp = p.slots[0].age;
        p.midi(0x80, 60, 0).unwrap();
        let mut observed = false;
        for _ in 0..4000 {
            p.next_sample();
            if p.slots[0].status == Status::Free {
                assert_eq!(p.voices[0].amp.stage, Stage::Idle);
                assert!(p.voices[0].amp.value > 0);
                assert!(!p.slots[0].mono);
                assert!(p.slots[0].assigned);
                assert_eq!((p.slots[0].note, p.slots[0].age), (old_note, old_stamp));
                observed = true;
                break;
            }
        }
        assert!(observed);
        // A held note with a zero controller EG remains held/reserved.
        p.midi(0x90, 64, 100).unwrap();
        p.voices[0].amp.stage = Stage::Idle;
        p.voices[0].amp.level = 0;
        p.reap_released();
        assert_eq!(p.slots[0].status, Status::Held);
    }
    #[test]
    fn native_legato_retarget_preserves_head_order_and_released_status() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[71, 72], &[1, 1]).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.set_parameter(71, 0).unwrap();
        p.midi(0x90, 64, 100).unwrap();
        p.midi(0x80, 64, 0).unwrap();
        p.voices[1].amp.stage = Stage::Idle;
        p.reap_released();
        assert_eq!(p.order, [1, 0, 2, 3, 4, 5, 6, 7]);
        p.set_parameter(71, 1).unwrap();
        p.midi(0x90, 67, 100).unwrap();
        p.midi(0x80, 67, 0).unwrap();
        assert_eq!(p.order, [1, 0, 2, 3, 4, 5, 6, 7]);
        // Source-derived edge: the retarget routine never writes +22/+28.
        p.release_slot(0);
        p.midi(0x90, 69, 100).unwrap();
        assert_eq!(p.slots[0].status, Status::Released);
        assert!(!p.voices[0].gate);
        assert!(p.slots[0].mono);
    }
    #[test]
    fn native_nonlegato_mono_glides_across_gap_but_legato_gap_does_not() {
        for legato in [0, 1] {
            let mut p = Jp8000Instrument::new();
            p.apply_patch(&[71, 72, 69, 70, 57], &[1, legato, 1, 64, 0])
                .unwrap();
            p.midi(0x90, 60, 100).unwrap();
            p.midi(0x80, 60, 0).unwrap();
            p.render_mono(&mut [0.0; 4000]);
            p.midi(0x90, 67, 100).unwrap();
            assert_eq!(
                p.voices[0].glide.initial_cents,
                if legato == 0 { -700 } else { 0 }
            );
        }
    }
    #[test]
    fn native_poly_priority_is_free_then_released_then_pedal_then_held() {
        let mut p = Jp8000Instrument::new();
        for note in 60..68 {
            p.midi(0x90, note, 100).unwrap();
        }
        p.midi(0xb0, 64, 127).unwrap();
        p.midi(0x80, 62, 0).unwrap();
        assert_eq!(p.slots[2].status, Status::Pedal);
        p.midi(0x90, 80, 100).unwrap();
        assert_eq!(p.slots[2].note, 80);
        p.midi(0xb0, 64, 0).unwrap();
        p.midi(0x80, 65, 0).unwrap();
        p.midi(0x90, 81, 100).unwrap();
        assert_eq!(p.slots[5].note, 81);
        p.midi(0x80, 63, 0).unwrap();
        p.voices[3].amp.stage = Stage::Idle;
        p.reap_released();
        assert_eq!(p.order[0], 3);
        p.midi(0x90, 82, 100).unwrap();
        assert_eq!(p.slots[3].note, 82);
        assert_eq!(p.order[7], 3);
        p.midi(0x90, 83, 100).unwrap();
        assert_eq!(p.slots[0].note, 83);
    }

    #[test]
    fn velocity_is_per_voice_and_morph_sources_are_last_message_wins() {
        let mut instrument = Jp8000Instrument::new();
        instrument
            .apply_patch(&[51, 283, 336, 126], &[80, 1, 192, 192])
            .unwrap();
        instrument.midi(0x90, 60, 32).unwrap();
        instrument.midi(0x90, 64, 127).unwrap();
        assert_eq!(instrument.voices[0].controls[51], 40);
        assert_eq!(instrument.voices[1].controls[51], 127);
        assert_eq!(instrument.parameter(51), Some(80));
        instrument.midi(0xb0, 2, 127).unwrap();
        assert_eq!(instrument.parts[0].morph, -128);
        assert_eq!(instrument.voices[0].controls[51], 0);
        assert_eq!(instrument.voices[1].controls[51], 80);
        instrument.midi(0xd0, 127, 0).unwrap();
        assert_eq!(instrument.parts[0].morph, 128);
        assert_eq!(instrument.voices[0].controls[51], 105);
        assert_eq!(instrument.voices[1].controls[51], 127);
        instrument.midi(0xb1, 2, 127).unwrap();
        assert_eq!(instrument.parts[0].morph, 128);
        instrument.midi(0xb0, 121, 0).unwrap();
        assert_eq!(instrument.voices[0].controls[51], 40);
        assert_eq!(instrument.parts[0].morph, 0);
    }
    #[test]
    fn shared_lfo_rate_uses_the_last_note_velocity() {
        let mut instrument = Jp8000Instrument::new();
        instrument.apply_patch(&[283, 284], &[1, 192]).unwrap();
        instrument.midi(0x90, 60, 32).unwrap();
        let first = super::super::control::effective_controls(&instrument.voices[0].params, -78, 0);
        let mut expected = Lfo::new();
        expected.configure(first[16], first[17]);
        instrument.parts[0].lfo.set_phase(0.0).unwrap();
        assert_eq!(instrument.parts[0].lfo.tick(), expected.tick());
        instrument.midi(0x90, 64, 127).unwrap();
        assert_eq!(instrument.parts[0].last_velocity_code, 128);
        assert_eq!(instrument.voices[0].velocity_code, -78);
        assert_eq!(instrument.voices[1].velocity_code, 128);
    }

    use crate::modules::jp8000::RenderTap;
    #[test]
    fn reset_controllers_preserves_volume_but_resets_expression_pan_bend_and_wheel() {
        let mut p = Jp8000Instrument::new();
        p.midi(0xb0, 7, 64).unwrap();
        p.midi(0xb0, 10, 17).unwrap();
        p.midi(0xb0, 11, 64).unwrap();
        p.midi(0xb0, 1, 127).unwrap();
        p.midi(0xe0, 127, 127).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(p.voices[0].amplitude_base, 746);
        p.render_mono(&mut [0.0; 882]);
        let stage = p.voices[0].amp.stage;
        p.midi(0xb0, 121, 0).unwrap();
        assert_eq!(p.parts[0].volume, 64);
        assert_eq!(p.parts[0].expression, 127);
        assert_eq!(p.parts[0].pan, 64);
        assert_eq!(p.parts[0].bend, 8192);
        assert_eq!(p.parts[0].wheel, 0);
        assert_eq!(p.voices[0].amplitude_base, 2941);
        assert_eq!(p.voices[0].amp.stage, stage);
        p.midi(0xb0, 11, 0).unwrap();
        assert_eq!(p.voices[0].amp.amplitude, 0);
        p.midi(0xb1, 11, 127).unwrap();
        assert_eq!(p.voices[0].amp.amplitude, 0);
        p.midi(0xb0, 121, 0).unwrap();
        assert_eq!(p.voices[0].amp.amplitude, 2941);
    }
    #[test]
    fn twelve_db_resonance_gain_is_cached_until_amplitude_recalculation() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[40, 42], &[0, 96]).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(p.voices[0].amplitude_base, 8081);
        p.set_parameter(42, 127).unwrap();
        assert_eq!(p.voices[0].amplitude_base, 8081);
        p.set_parameter(51, 126).unwrap();
        assert_eq!(p.voices[0].amplitude_base, 5700);
        p.midi(0xb0, 7, 0).unwrap();
        assert_eq!(p.voices[0].amplitude_base, 0);
        p.midi(0xb0, 121, 0).unwrap();
        assert_eq!(p.voices[0].amplitude_base, 0);
    }
    #[test]
    fn bend_and_wheel_are_shared_part_state_without_retriggering() {
        let mut p = Jp8000Instrument::new();
        p.midi(0xe0, 127, 127).unwrap();
        p.midi(0xb0, 1, 127).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(
            p.voices[0].frequency_word,
            super::super::pitch_word_cents(200)
        );
        assert_eq!(p.voices[0].wheel, 127);
        p.render_mono(&mut [0.0; 1000]);
        let level = p.voices[0].amp.level;
        let gate = p.voices[0].gate;
        p.midi(0xe0, 0, 0).unwrap();
        assert_eq!(
            p.voices[0].frequency_word,
            super::super::pitch_word_cents(-200)
        );
        assert_eq!((p.voices[0].amp.level, p.voices[0].gate), (level, gate));
        p.set_parameter(1002, 1).unwrap();
        p.midi(0xe1, 127, 127).unwrap();
        // Receive filtering changes which messages reach this part; it does
        // not create a new controller lane for its previously owned voices.
        assert_eq!(p.voices[0].bend, 16383);
        p.midi(0x91, 64, 100).unwrap();
        assert_eq!(p.voices[1].bend, 16383);
        assert_eq!(p.voices[1].wheel, 127);
        p.reset();
        assert_eq!(p.parts[0].bend, 8192);
        assert_eq!(p.parts[0].wheel, 0);
    }
    #[test]
    fn atomic_patch_configures_shared_lfo2_and_tone() {
        let mut a = Jp8000Instrument::new();
        let mut b = Jp8000Instrument::new();
        a.apply_patch(&[19, 26, 59, 60], &[12, 96, 32, 100])
            .unwrap();
        for (id, value) in [(19, 12), (26, 96), (59, 32), (60, 100)] {
            b.set_parameter(id, value).unwrap();
        }
        a.reset();
        b.reset();
        for p in [&mut a, &mut b] {
            p.midi(0xb0, 1, 127).unwrap();
            p.midi(0x90, 60, 100).unwrap();
        }
        for _ in 0..10000 {
            assert_eq!(a.next_sample(), b.next_sample());
        }
    }
    #[test]
    fn global_modulation_and_patch_events_are_exact_across_callback_partitions() {
        fn run(block: usize) -> [f32; 16384] {
            let mut v = Jp8000Instrument::new();
            v.set_control_phase(314).unwrap();
            v.set_lfo_phase(0.123).unwrap();
            v.apply_patch(
                &[16, 17, 25, 27, 28, 29, 43, 44, 46, 47, 48, 49, 50, 57],
                &[2, 80, 80, 96, 64, 32, 96, 96, 80, 32, 64, 64, 32, 32],
            )
            .unwrap();
            let mut out = [0.0; 16384];
            let mut cursor = 0;
            for endpoint in [113, 919, 1537, 2021, 4096, 7001, 9000, 12013, 16384] {
                while cursor < endpoint {
                    let end = (cursor + block).min(endpoint);
                    v.render_mono(&mut out[cursor..end]);
                    cursor = end;
                }
                match endpoint {
                    113 => v.midi(0x90, 60, 100).unwrap(),
                    919 => v.midi(0x90, 60, 110).unwrap(),
                    1537 => v.midi(0x90, 67, 80).unwrap(),
                    2021 => v.midi(0x80, 60, 0).unwrap(),
                    4096 => v.apply_patch(&[30, 31, 32, 41], &[1, 96, 0, 80]).unwrap(),
                    7001 => v.midi(0xb0, 64, 127).unwrap(),
                    9000 => v.midi(0xb0, 123, 0).unwrap(),
                    12013 => v.midi(0xb0, 64, 0).unwrap(),
                    _ => {}
                }
            }
            out
        }
        let expected = run(1);
        assert!(expected.iter().all(|x| x.is_finite()));
        assert!(expected.iter().any(|x| x.abs() > 0.001));
        for block in [7, 16, 32, 64, 128, 1024] {
            assert_eq!(expected, run(block));
        }
    }
    #[test]
    fn wheel_pitch_is_common_for_all_three_pitch_destinations() {
        let mut engines = [
            Jp8000Instrument::new(),
            Jp8000Instrument::new(),
            Jp8000Instrument::new(),
        ];
        for (destination, p) in engines.iter_mut().enumerate() {
            p.apply_patch(
                &[24, 25, 26, 27, 30, 31, 32, 23, 33],
                &[destination as u16, 64, 110, 64, 5, 0, 0, 64, 1],
            )
            .unwrap();
            p.midi(0xb0, 1, 127).unwrap();
            p.midi(0x90, 60, 100).unwrap();
        }
        for frame in 0..32768 {
            let expected = engines[0].next_stereo_sample();
            for p in &mut engines[1..] {
                assert_eq!(p.next_stereo_sample(), expected, "frame{frame}");
            }
        }
    }
    #[test]
    fn synchronized_effects_and_tempo_edits_are_partition_independent() {
        fn run(block: usize) -> Vec<(f32, f32)> {
            let mut p = Jp8000Instrument::new();
            p.apply_patch(
                &[
                    16, 25, 58, 52, 61, 62, 63, 64, 65, 66, 1004, 1005, 1006, 2034,
                ],
                &[2, 78, 1, 94, 7, 110, 2, 100, 88, 92, 2, 1, 23, 250],
            )
            .unwrap();
            p.midi(0x90, 60, 100).unwrap();
            p.midi(0x90, 67, 110).unwrap();
            let mut out = Vec::with_capacity(300000);
            let mut l = [0.0; 257];
            let mut r = [0.0; 257];
            for endpoint in [110003, 190001, 300000] {
                while out.len() < endpoint {
                    let n = block.min(endpoint - out.len());
                    p.render_stereo(&mut l[..n], &mut r[..n]).unwrap();
                    out.extend(l[..n].iter().copied().zip(r[..n].iter().copied()));
                }
                if endpoint == 110003 {
                    p.set_parameter(2034, 74).unwrap();
                }
                if endpoint == 190001 {
                    p.set_parameter(1005, 3).unwrap();
                    p.set_parameter(1006, 7).unwrap();
                }
            }
            out
        }
        let expected = run(257);
        assert_eq!(expected, run(113));
        assert!(expected.iter().all(|(l, r)| l.is_finite() && r.is_finite()));
        assert!(expected.iter().any(|(l, r)| (l - r).abs() > 1e-5));
    }
    #[test]
    fn stereo_effects_preserve_tails_and_are_callback_partition_independent() {
        let mut a = Jp8000Instrument::new();
        let mut b = Jp8000Instrument::new();
        for p in [&mut a, &mut b] {
            assert!(p.voices.iter().all(|v| v.effects.is_none()));
            p.apply_patch(
                &[30, 31, 58, 52, 61, 62, 63, 64, 65, 66, 57, 1004, 2034],
                &[5, 0, 2, 52, 4, 100, 2, 120, 96, 100, 0, 0, 90],
            )
            .unwrap();
            p.midi(0x90, 60, 100).unwrap();
        }
        let mut left_a = vec![0.0; 32768];
        let mut right_a = vec![0.0; 32768];
        let mut left_b = vec![0.0; 32768];
        let mut right_b = vec![0.0; 32768];
        a.render_stereo(&mut left_a[..8192], &mut right_a[..8192])
            .unwrap();
        a.midi(0xb0, 123, 0).unwrap();
        a.render_stereo(&mut left_a[8192..], &mut right_a[8192..])
            .unwrap();
        for (start, end) in [(0, 8192), (8192, 32768)] {
            if start == 8192 {
                b.midi(0xb0, 123, 0).unwrap();
            }
            let mut cursor = start;
            while cursor < end {
                let next = (cursor + 127).min(end);
                b.render_stereo(&mut left_b[cursor..next], &mut right_b[cursor..next])
                    .unwrap();
                cursor = next;
            }
        }
        assert_eq!(left_a, left_b);
        assert_eq!(right_a, right_b);
        assert_ne!(left_a, right_a);
        assert!(left_a[20000..].iter().any(|s| s.abs() > 1e-5));
        assert_eq!(a.held_voice_count(), 0);
        a.silence();
        let mut l = [1.0; 128];
        let mut r = [1.0; 128];
        a.render_stereo(&mut l, &mut r).unwrap();
        assert!(l.iter().chain(&r).all(|s| *s == 0.0));
        a.reset();
        assert_eq!(a.parameter(1004), Some(0));
        assert_eq!(a.parameter(2034), Some(90));
        assert!(a.apply_patch(&[1004, 2034], &[10, 19]).is_err());
        assert_eq!(a.parameter(1004), Some(0));
        assert_eq!(a.parameter(2034), Some(90));
    }
    #[test]
    fn one_voice_uses_exactly_the_same_shared_output_path() {
        for wave in [0, 5] {
            let mut single = Jp8000Voice::new();
            let mut poly = Jp8000Instrument::new();
            single.set_parameter(30, wave).unwrap();
            poly.set_parameter(30, wave).unwrap();
            single.set_control_phase(314).unwrap();
            poly.set_control_phase(314).unwrap();
            for frame in 0..40_000 {
                if frame == 2000 {
                    single.note_on(60, 100);
                    poly.midi(0x90, 60, 100).unwrap();
                }
                if frame == 25_000 {
                    single.note_off(60);
                    poly.midi(0x80, 60, 0).unwrap();
                }
                assert_eq!(
                    single.next_sample(RenderTap::Output).to_bits(),
                    poly.next_sample().to_bits(),
                    "frame{frame} wave{wave}"
                );
            }
        }
    }
    #[test]
    fn eight_voice_allocator_steals_released_before_held_and_tracks_duplicates() {
        let mut p = Jp8000Instrument::new();
        for n in 60..68 {
            p.midi(0x90, n, 100).unwrap();
        }
        assert_eq!(p.held_voice_count(), 8);
        p.midi(0x80, 64, 0).unwrap();
        p.midi(0x90, 80, 100).unwrap();
        assert_eq!(p.slots[4].note, 80);
        assert_eq!(p.held_voice_count(), 8);
        p.midi(0x90, 90, 100).unwrap();
        assert_eq!(p.slots[0].note, 90);
        p.midi(0x90, 90, 100).unwrap();
        assert_eq!(p.slots[1].note, 90);
        p.midi(0x80, 90, 0).unwrap();
        assert!(!p.voices[0].gate);
        assert!(p.voices[1].gate);
        p.midi(0x80, 90, 0).unwrap();
        assert!(!p.voices[1].gate);
    }
    #[test]
    fn sustain_channel_filter_and_panic_have_explicit_lifecycles() {
        let mut p = Jp8000Instrument::new();
        p.midi(0x91, 60, 100).unwrap();
        assert_eq!(p.held_voice_count(), 0);
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0xb0, 64, 127).unwrap();
        p.midi(0x80, 60, 0).unwrap();
        assert_eq!(p.held_voice_count(), 1);
        p.midi(0xb0, 64, 0).unwrap();
        assert_eq!(p.held_voice_count(), 0);
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0xb0, 64, 127).unwrap();
        p.midi(0xb0, 123, 0).unwrap();
        assert_eq!(p.held_voice_count(), 1);
        p.midi(0xb0, 121, 0).unwrap();
        assert_eq!(p.held_voice_count(), 0);
        p.midi(0x90, 64, 100).unwrap();
        p.set_parameter(1002, 1).unwrap();
        assert_eq!(p.held_voice_count(), 0);
        p.midi(0x91, 67, 100).unwrap();
        assert_eq!(p.held_voice_count(), 1);
        p.midi(0xb1, 120, 0).unwrap();
        assert_eq!(p.held_voice_count(), 0);
        assert!(!p
            .slots
            .iter()
            .any(|slot| slot.assigned && slot.channel == 1));
        p.silence();
        assert_eq!(p.sounding_voice_count(), 0);
        p.set_parameter(1002, 16).unwrap();
        p.midi(0x91, 67, 100).unwrap();
        assert_eq!(p.held_voice_count(), 0);
    }
    #[test]
    fn held_waveform_changes_validate_the_complete_active_routing() {
        let mut p = Jp8000Instrument::new();
        p.midi(0x90, 60, 100).unwrap();
        p.set_parameter(25, 80).unwrap();
        p.set_parameter(30, 3).unwrap();
        assert_eq!(p.parameter(30), Some(3));
        p.apply_patch(&[30, 24], &[3, 1]).unwrap();
        p.set_parameter(24, 0).unwrap();
        p.set_parameter(24, 2).unwrap();
        assert_eq!(p.parameter(24), Some(2));
        p.apply_patch(&[25, 24, 30, 32, 18], &[64, 0, 0, 100, 1])
            .unwrap();
        p.set_parameter(30, 5).unwrap();
        assert_eq!(p.parameter(30), Some(5));
        assert!(p.apply_patch(&[30,18],&[0,128]).is_err());
        assert_eq!(p.parameter(30),Some(5));
        assert_eq!(p.parameter(18),Some(1));
        p.apply_patch(&[30, 18], &[5, 0]).unwrap();
        let mut out = [0.0; 4096];
        p.render_mono(&mut out);
        assert!(out.iter().all(|x| x.is_finite()));
        // Native H8 0x8956: entering Feedback clears the entire shared bank.
        assert_eq!(p.held_voice_count(), 0);
    }
    #[test]
    fn patch_application_is_atomic_and_validates_final_state() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[30, 32], &[0, 100]).unwrap();
        p.apply_patch(&[30, 32], &[5, 0]).unwrap();
        assert!(p.apply_patch(&[30, 32, 41], &[0, 100, 128]).is_err());
        assert_eq!(p.parameter(30), Some(5));
        assert_eq!(p.parameter(32), Some(0));
        assert_eq!(p.parameter(41), Some(127));
        assert!(p.apply_patch(&[41, 41], &[20, 40]).is_err());
        p.apply_patch(&[32, 30], &[100, 0]).unwrap();
        assert_eq!(p.parameter(32), Some(100));
    }
    #[test]
    fn duplicate_notes_release_fifo_even_with_sustain_and_stealing() {
        let mut p = Jp8000Instrument::new();
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0xb0, 64, 127).unwrap();
        p.midi(0x80, 60, 0).unwrap();
        assert!(!p.slots[0].key_down);
        assert!(p.slots[1].key_down);
        assert!(p.voices[0].gate && p.voices[1].gate);
        p.midi(0xb0, 64, 0).unwrap();
        assert!(!p.voices[0].gate);
        assert!(p.voices[1].gate);
        p.silence();
        for _ in 0..9 {
            p.midi(0x90, 60, 100).unwrap();
        }
        p.midi(0x80, 60, 0).unwrap();
        assert_eq!(p.held_voice_count(), 7);
        p.midi(0x80, 60, 0).unwrap();
        assert_eq!(p.held_voice_count(), 6);
    }
    #[test]
    fn ffi_checks_buffers_and_handles_and_accepts_mono_alias() {
        unsafe {
            assert_eq!(
                mdlr_jp8000_rust_midi(std::ptr::null_mut(), 0x90, 60, 100),
                -1
            );
            let p = mdlr_jp8000_rust_create();
            assert!(!p.is_null());
            let mut audio = [0.0f32; 64];
            assert_eq!(mdlr_jp8000_rust_midi(p, 0x90, 60, 100), 0);
            assert_eq!(
                mdlr_jp8000_rust_render(p, audio.as_mut_ptr(), audio.as_mut_ptr(), 64),
                0
            );
            assert!(audio.iter().all(|x| x.is_finite()));
            assert_eq!(
                mdlr_jp8000_rust_render(p, std::ptr::null_mut(), audio.as_mut_ptr(), 1),
                -6
            );
            assert_eq!(
                mdlr_jp8000_rust_render(p, std::ptr::null_mut(), std::ptr::null_mut(), 0),
                0
            );
            assert_eq!(mdlr_jp8000_rust_set_parameter(p, 1002, 17), -3);
            assert_eq!(mdlr_jp8000_rust_get_parameter(p, 1002), 0);
            mdlr_jp8000_rust_destroy(p);
            mdlr_jp8000_rust_destroy(std::ptr::null_mut());
        }
    }
}

#[cfg(test)]
mod two_part_tests {
    use super::*;
    fn step(p: &mut Jp8000Instrument) {
        for _ in 0..4410 {
            p.next_stereo_sample();
        }
    }
    fn held(p: &Jp8000Instrument) -> Vec<(usize, u8, u8, u8)> {
        p.slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.status == Status::Held)
            .map(|(i, s)| (i, s.owner, s.origin, s.note))
            .collect()
    }
    fn dual() -> Jp8000Instrument {
        let mut p = Jp8000Instrument::new();
        p.set_parameter(2016, 1).unwrap();
        p
    }
    #[test]
    fn all_five_physical_partitions_fill_without_cross_part_borrowing() {
        let patterns = ["01011111", "01111100", "01011100", "01000011", "01100000"];
        for (assign, pattern) in patterns.iter().enumerate() {
            let mut p = dual();
            p.set_parameter(2022, assign as u16).unwrap();
            assert_eq!(
                p.slots
                    .iter()
                    .map(|s| char::from(b'0' + s.owner))
                    .collect::<String>(),
                *pattern
            );
            for n in 40..49 {
                p.midi(0x90, n, 100).unwrap();
            }
            assert_eq!(held(&p).len(), assign + 2);
            for n in 60..69 {
                p.midi(0x91, n, 100).unwrap();
            }
            assert_eq!(held(&p).len(), 8);
            assert_eq!(p.parts[0].held[1].iter().sum::<u16>(), 9);
            assert_eq!(p.parts[1].held[1].iter().sum::<u16>(), 9);
        }
    }
    #[test]
    fn single_lower_owns_all_and_inactive_direct_part_still_counts_keys() {
        let mut p = Jp8000Instrument::new();
        p.set_part_parameter(0, 1002, 2).unwrap();
        p.set_part_parameter(1, 1002, 3).unwrap();
        p.set_parameter(2018, 1).unwrap();
        p.set_parameter(3009, 0).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(held(&p), vec![(0, 1, 0, 60)]);
        p.midi(0x92, 64, 100).unwrap();
        assert_eq!(p.parts[0].held[1][64], 1);
        assert_eq!(held(&p), vec![(0, 1, 0, 60)]);
        assert!(p.slots.iter().all(|s| s.owner == 1));
    }
    #[test]
    fn equal_direct_channels_multiply_but_remote_keys_deduplicate() {
        let mut p = dual();
        p.set_part_parameter(1, 1002, 0).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(held(&p), vec![(0, 0, 1, 60), (1, 1, 1, 60)]);
        p.midi(0x90, 60, 100).unwrap();
        assert_eq!(held(&p).len(), 4);
        p.midi(0x80, 60, 64).unwrap();
        assert_eq!(held(&p).len(), 2);
        // Keep the Remote source on a distinct channel; moving it onto
        // channel0 with held direct keys would intercept their later releases.
        p.set_parameter(3009, 2).unwrap();
        p.midi(0x92, 67, 100).unwrap();
        let before = held(&p);
        p.midi(0x92, 67, 80).unwrap();
        assert_eq!(held(&p), before);
        assert_eq!(p.parts[0].held[0][67], 1);
        assert_eq!(p.parts[1].held[0][67], 1);
        p.midi(0x82, 67, 64).unwrap();
        assert_eq!(held(&p).len(), 2);
        assert!(held(&p).iter().all(|s| s.2 == 1));
    }
    #[test]
    fn remote_all_shares_keys_across_channels() {
        let mut p = dual();
        p.set_parameter(3009, 16).unwrap();
        p.midi(0x92, 60, 100).unwrap();
        let first = held(&p);
        p.midi(0x9a, 60, 70).unwrap();
        assert_eq!(held(&p), first);
        p.midi(0x8f, 60, 64).unwrap();
        assert!(held(&p).is_empty());
    }
    #[test]
    fn split_uses_original_boundary_and_direct_midi_bypasses_it() {
        let mut p = dual();
        p.set_parameter(2016, 2).unwrap();
        p.set_parameter(2017, 60).unwrap();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0x94, 59, 100).unwrap();
        p.midi(0x94, 60, 100).unwrap();
        assert_eq!(held(&p), vec![(0, 0, 0, 60), (1, 1, 0, 59)]);
        p.midi(0x90, 48, 100).unwrap();
        p.midi(0x91, 72, 100).unwrap();
        assert!(held(&p).iter().any(|s| s.1 == 0 && s.2 == 1 && s.3 == 48));
        assert!(held(&p).iter().any(|s| s.1 == 1 && s.2 == 1 && s.3 == 72));
    }
    #[test]
    fn owner_reinitialization_preserves_counters_notes_timestamps_but_clears_liveness() {
        let mut p = dual();
        p.set_part_parameter(0, 283, 1).unwrap();
        p.set_part_parameter(1, 283, 1).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        step(&mut p);
        p.midi(0x91, 67, 100).unwrap();
        let old = p.slots;
        let counts = [p.parts[0].held, p.parts[1].held];
        assert!(p.voices.iter().any(|v| v.velocity_code != 0));
        p.set_parameter(2022, 1).unwrap();
        assert_eq!([p.parts[0].held, p.parts[1].held], counts);
        assert_eq!(p.order, [0, 1, 2, 3, 4, 5, 6, 7]);
        for i in 0..8 {
            assert_eq!(p.slots[i].age, old[i].age);
            assert_eq!(p.slots[i].note, old[i].note);
            assert_eq!(p.slots[i].status, Status::Free);
            assert!(!p.voices[i].controller_assigned);
            assert_eq!(p.voices[i].velocity_code, 0);
        }
    }
    #[test]
    fn dual_split_preserves_direct_notes_but_retriggers_virtual_notes() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0x94, 60, 100).unwrap();
        step(&mut p);
        p.set_parameter(2016, 2).unwrap();
        assert_eq!(held(&p), vec![(2, 0, 0, 60)]);
        assert_eq!(p.parts[0].held[0][60], 1);
        assert_eq!(p.parts[1].held[0][60], 0);
        p.midi(0x90, 48, 100).unwrap();
        let direct = held(&p)
            .into_iter()
            .filter(|s| s.2 == 1)
            .collect::<Vec<_>>();
        p.set_parameter(2016, 1).unwrap();
        assert_eq!(
            held(&p)
                .into_iter()
                .filter(|s| s.2 == 1)
                .collect::<Vec<_>>(),
            direct
        );
    }
    #[test]
    fn unchanged_keymode_retriggers_but_equivalent_panel_clears_without_retrigger() {
        let mut p = Jp8000Instrument::new();
        p.set_parameter(3009, 0).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        step(&mut p);
        p.set_parameter(2016, 0).unwrap();
        assert_eq!(held(&p), vec![(1, 0, 0, 60)]);
        step(&mut p);
        p.set_parameter(2018, 2).unwrap();
        assert!(held(&p).is_empty());
        assert_eq!(p.parts[0].held[0][60], 1);
        p.set_parameter(2016, 0).unwrap();
        assert_eq!(held(&p), vec![(0, 0, 0, 60)]);
        p.midi(0x80, 60, 64).unwrap();
        assert!(held(&p).is_empty());
    }
    #[test]
    fn source_pedals_and_same_pitch_releases_do_not_alias() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0x94, 60, 100).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        step(&mut p);
        p.midi(0xb4, 64, 127).unwrap();
        p.midi(0x80, 60, 64).unwrap();
        assert_eq!(
            p.slots
                .iter()
                .filter(|s| s.status == Status::Released && s.origin == 1)
                .count(),
            1
        );
        p.midi(0x84, 60, 64).unwrap();
        assert_eq!(
            p.slots
                .iter()
                .filter(|s| s.status == Status::Pedal && s.origin == 0)
                .count(),
            2
        );
        p.midi(0xb4, 64, 0).unwrap();
        assert!(p.slots.iter().all(|s| s.status != Status::Pedal));
    }
    #[test]
    fn feedback_entry_resets_both_parts_exit_preserves_cached_mono_and_reopens_poly_slots() {
        let mut p = dual();
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0x91, 67, 100).unwrap();
        p.set_part_parameter(0, 30, 3).unwrap();
        assert!(held(&p).is_empty());
        assert_eq!(p.parts[0].held[1][60], 1);
        assert_eq!(p.parts[1].held[1][67], 1);
        p.midi(0x90, 62, 100).unwrap();
        p.midi(0x90, 64, 100).unwrap();
        assert_eq!(held(&p), vec![(0, 0, 1, 64)]);
        p.set_part_parameter(0, 30, 5).unwrap();
        assert_eq!(held(&p), vec![(0, 0, 1, 64)]);
        p.midi(0x90, 65, 100).unwrap();
        assert_eq!(held(&p), vec![(0, 0, 1, 64), (2, 0, 1, 65)]);
    }
    #[test]
    fn transaction_rejection_does_not_partially_write_either_part_or_common() {
        let mut p = dual();
        let before = [p.parts[0].params, p.parts[1].params];
        let common = p.common.performance;
        assert!(p
            .apply_performance(&[30, 31], &[1, 100], &[41], &[128], &[2018], &[1])
            .is_err());
        assert_eq!([p.parts[0].params, p.parts[1].params], before);
        assert_eq!(p.common.performance, common);
        assert!(p
            .apply_performance(&[30, 30], &[1, 2], &[], &[], &[], &[])
            .is_err());
    }
    #[test]
    fn one_clock_drives_independent_part_lfos_and_fixed_eight_voices() {
        let mut p = dual();
        p.set_part_parameter(0, 17, 20).unwrap();
        p.set_part_parameter(1, 17, 90).unwrap();
        p.set_parameter(2034, 120).unwrap();
        for _ in 0..88200 {
            p.next_stereo_sample();
        }
        assert_eq!(p.tempo_clock.pulses(), 48);
        assert_ne!(p.parts[0].lfo.value(), p.parts[1].lfo.value());
        assert_eq!(p.voices.len(), 8);
    }
    #[test]
    fn parallel_output_isolates_parts_and_has_no_extra_delay_buffer() {
        for part in 0..2 {
            let mut p = dual();
            p.set_parameter(2020, 1).unwrap();
            p.midi(0x90 | part as u8, 60, 100).unwrap();
            let mut selected = 0.0f64;
            for _ in 0..4410 {
                let (l, r) = p.next_stereo_sample();
                let (z, x) = if part == 0 { (l, r) } else { (r, l) };
                assert_eq!(z, 0.0);
                selected += f64::from(x * x);
            }
            assert!(selected > 0.001);
        }
    }
    #[test]
    fn direct_controllers_are_shared_by_both_voice_sources_in_the_addressed_part() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0x94, 72, 100).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0x91, 67, 100).unwrap();
        p.midi(0xb0, 2, 127).unwrap();
        p.midi(0xe0, 0, 32).unwrap();
        p.midi(0xb0, 1, 64).unwrap();
        p.midi(0xb0, 7, 80).unwrap();
        for (v, s) in p.voices.iter().zip(&p.slots) {
            if s.assigned {
                assert_eq!(v.morph, if s.owner == 0 { -128 } else { 0 });
                assert_eq!(v.bend, if s.owner == 0 { 4096 } else { 8192 });
                assert_eq!(v.wheel, if s.owner == 0 { 64 } else { 0 });
                assert_eq!(v.volume, if s.owner == 0 { 80 } else { 127 });
            }
        }
        p.midi(0xb0, 121, 0).unwrap();
        for (v, s) in p.voices.iter().zip(&p.slots) {
            if s.assigned && s.owner == 0 {
                assert_eq!((v.morph, v.bend, v.wheel, v.volume), (0, 8192, 0, 80));
            }
        }
    }
    #[test]
    fn remote_ribbon_routes_shared_values_and_replays_noncenter_mask_deltas() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.set_part_parameter(0, 280, 1).unwrap();
        p.midi(0xd4, 64, 0).unwrap();
        assert_eq!((p.parts[0].morph, p.parts[1].morph), (64, 64));
        assert_eq!((p.parts[0].bend, p.parts[1].bend), (12319, 8192));
        p.set_part_parameter(1, 280, 1).unwrap();
        assert_eq!((p.parts[0].bend, p.parts[1].bend), (12319, 12319));
        p.set_parameter(2016, 2).unwrap();
        assert_eq!((p.parts[0].morph, p.parts[1].morph), (64, 0));
        assert_eq!((p.parts[0].bend, p.parts[1].bend), (12319, 8192));
        p.midi(0xb1, 2, 127).unwrap();
        p.midi(0xe1, 0, 48).unwrap();
        p.midi(0xd4, 0, 0).unwrap();
        assert_eq!((p.parts[0].morph, p.parts[1].morph), (0, -128));
        assert_eq!((p.parts[0].bend, p.parts[1].bend), (8192, 6144));
        p.set_parameter(2018, 1).unwrap();
        p.midi(0xd4, 0, 0).unwrap();
        p.midi(0xe4, 0, 64).unwrap();
        assert_eq!((p.parts[1].morph, p.parts[1].bend), (-128, 6144));
    }
    #[test]
    fn remote_default_caches_preserve_direct_overrides_and_nondefaults_repeat() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0xb0, 1, 64).unwrap();
        p.midi(0xe0, 0, 32).unwrap();
        p.midi(0xb4, 1, 0).unwrap();
        p.midi(0xe4, 0, 64).unwrap();
        assert_eq!((p.parts[0].wheel, p.parts[0].bend), (64, 4096));
        p.midi(0xb4, 1, 127).unwrap();
        p.midi(0xe4, 0, 96).unwrap();
        p.midi(0xb0, 1, 12).unwrap();
        p.midi(0xe0, 0, 32).unwrap();
        p.midi(0xb4, 1, 127).unwrap();
        p.midi(0xe4, 0, 96).unwrap();
        for part in &p.parts {
            assert_eq!((part.wheel, part.bend), (127, 12288));
        }
    }
    #[test]
    fn centered_ribbon_mask_changes_do_not_destroy_direct_part_overrides() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0xd0, 64, 0).unwrap();
        p.midi(0xd1, 32, 0).unwrap();
        p.midi(0xe0, 0, 100).unwrap();
        p.midi(0xe1, 0, 20).unwrap();
        for (mode, panel) in [(0, 0), (0, 1), (1, 0), (2, 2), (2, 1)] {
            p.apply_patch(&[2016, 2018], &[mode, panel]).unwrap();
            p.set_part_parameter(0, 280, 1).unwrap();
            p.set_part_parameter(1, 280, 1).unwrap();
            p.midi(0xd4, 0, 0).unwrap();
            p.midi(0xe4, 0, 64).unwrap();
            assert_eq!((p.parts[0].morph, p.parts[1].morph), (64, 32));
            assert_eq!((p.parts[0].bend, p.parts[1].bend), (12800, 2560));
        }
    }
    #[test]
    fn independent_part_pitch_uses_dual_detune_and_octave_fold() {
        let mut p = dual();
        p.apply_performance(&[1003], &[25], &[1003], &[23], &[2019], &[51])
            .unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.midi(0x91, 60, 100).unwrap();
        let u = p
            .slots
            .iter()
            .position(|s| s.owner == 0 && s.status == Status::Held)
            .unwrap();
        let l = p
            .slots
            .iter()
            .position(|s| s.owner == 1 && s.status == Status::Held)
            .unwrap();
        assert_eq!(
            (
                p.voices[u].part_effective_note(),
                p.voices[l].part_effective_note()
            ),
            (61, 59)
        );
        assert_eq!(
            (p.voices[u].part_base_cents(), p.voices[l].part_base_cents()),
            (101, -100)
        );
        p.set_parameter(2016, 2).unwrap();
        assert_eq!(
            (p.voices[u].part_base_cents(), p.voices[l].part_base_cents()),
            (100, -100)
        );
        p.midi(0x90, 127, 100).unwrap();
        let edge = p
            .slots
            .iter()
            .position(|s| s.owner == 0 && s.note == 127 && s.status == Status::Held)
            .unwrap();
        assert_eq!(p.voices[edge].part_effective_note(), 116);
    }
    #[test]
    fn atomic_pitch_commits_part_transpose_before_patch_octave() {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[69, 70, 1003, 73], &[1, 64, 25, 3]).unwrap();
        p.midi(0x90, 60, 100).unwrap();
        p.set_parameter(69, 1).unwrap();
        let i = p
            .slots
            .iter()
            .position(|s| s.status == Status::Held)
            .unwrap();
        assert_eq!(p.voices[i].part_effective_note(), 73);
        p.apply_patch(&[73, 1003], &[4, 26]).unwrap();
        assert_eq!(p.voices[i].part_effective_note(), 86);
        assert_eq!(p.voices[i].glide.initial_cents, -1200);
        assert_eq!(p.voices[i].glide.remaining, 8192);
        assert_eq!(p.voices[i].glide.offset_cents, 0);
        assert!(p.voices[i].glide_enabled);
    }
    #[test]
    fn morph_refresh_reaches_free_owners_and_cc121_uses_changed_value_dispatch() {
        let mut p = Jp8000Instrument::new();
        p.set_parameter(69, 1).unwrap();
        p.midi(0xb0, 2, 127).unwrap();
        assert!(p.voices.iter().all(|v| v.glide_enabled));
        p.midi(0x90, 60, 100).unwrap();
        let i = p
            .slots
            .iter()
            .position(|s| s.status == Status::Held)
            .unwrap();
        assert!(!p.voices[i].glide_enabled);
        p.midi(0xb0, 2, 127).unwrap();
        assert!(!p.voices[i].glide_enabled);
        p.midi(0xb0, 121, 0).unwrap();
        assert!(p.voices.iter().all(|v| v.glide_enabled));
        assert_eq!(p.parts[0].morph, 0);
    }
    #[test]
    fn physical_remote_masks_replay_before_ribbon_bend_override() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.set_part_parameter(0, 280, 1).unwrap();
        p.midi(0xb4, 1, 96).unwrap();
        p.midi(0xe4, 127, 127).unwrap();
        p.midi(0xd4, 64, 0).unwrap();
        for (mode, panel, wheels, bends) in [
            (0, 0, [96, 0], [12319, 8192]),
            (0, 1, [0, 96], [8192, 16383]),
            (0, 2, [96, 0], [12319, 8192]),
            (1, 0, [96, 96], [12319, 16383]),
            (2, 2, [96, 96], [12319, 16383]),
            (2, 0, [96, 0], [12319, 8192]),
            (2, 1, [0, 96], [8192, 16383]),
        ] {
            p.apply_patch(&[2016, 2018], &[mode, panel]).unwrap();
            assert_eq!([p.parts[0].wheel, p.parts[1].wheel], wheels);
            assert_eq!([p.parts[0].bend, p.parts[1].bend], bends);
        }
    }
    #[test]
    fn ownership_reset_rebases_controller_mirrors_without_morph_event() {
        let mut p = dual();
        p.set_part_parameter(0, 69, 1).unwrap();
        for (channel, values) in [(0, [64, 10, 32, 30, 40]), (1, [95, 90, 96, 60, 70])] {
            p.midi(0xb0 | channel, 2, values[0]).unwrap();
            p.midi(0xb0 | channel, 1, values[1]).unwrap();
            p.midi(0xe0 | channel, 0, values[2]).unwrap();
            p.midi(0xb0 | channel, 7, values[3]).unwrap();
            p.midi(0xb0 | channel, 11, values[4]).unwrap();
        }
        let before: [bool; 8] = std::array::from_fn(|i| p.voices[i].glide_enabled);
        p.apply_patch(&[2016, 2018], &[0, 1]).unwrap();
        for (i, v) in p.voices.iter().enumerate() {
            assert_eq!(
                (v.morph, v.bend, v.wheel, v.volume, v.expression),
                (-96, 12288, 90, 60, 70)
            );
            assert_eq!(v.glide_enabled, before[i]);
        }
        p.midi(0xb1, 2, 95).unwrap();
        for (i, v) in p.voices.iter().enumerate() {
            assert_eq!(v.glide_enabled, before[i]);
        }
    }
    #[test]
    fn remote_sustain_tracks_all_nine_masks_and_preserves_cache_on_mode_replay() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        for (mode, panels) in [(0, [1, 2, 1]), (1, [3, 3, 3]), (2, [1, 2, 3])] {
            for (panel, mask) in panels.into_iter().enumerate() {
                p.apply_patch(&[2016, 2018], &[mode, panel as u16]).unwrap();
                p.midi(0xb4, 64, 127).unwrap();
                assert_eq!(p.remote_sustain_active, mask);
                assert_eq!(
                    [p.parts[0].sustain[16], p.parts[1].sustain[16]],
                    [mask & 1 != 0, mask & 2 != 0]
                );
                p.midi(0xb4, 64, 0).unwrap();
                assert_eq!(p.remote_sustain_active, 0);
            }
        }
        p.apply_patch(&[2016, 2018], &[2, 2]).unwrap();
        p.midi(0xb4, 64, 127).unwrap();
        p.midi(0xb4, 64, 127).unwrap();
        for (mode, panel, mask) in [(0, 0, 1), (0, 1, 2), (1, 0, 3)] {
            p.apply_patch(&[2016, 2018], &[mode, panel]).unwrap();
            assert_eq!(p.remote_sustain, 127);
            assert_eq!(p.remote_sustain_active, mask);
        }
        p.midi(0xb4, 64, 0).unwrap();
        p.midi(0xb4, 64, 0).unwrap();
        assert_eq!(p.remote_sustain_active, 0);
        p.midi(0xb4, 64, 1).unwrap();
        assert_eq!(p.remote_sustain_active, 3);
        assert!(!p.parts[0].sustain[16] && !p.parts[1].sustain[16]);
        p.midi(0xb4, 121, 0).unwrap();
        assert_eq!(p.remote_sustain_active, 0);
        assert_eq!(p.remote_sustain, 0);
    }
    #[test]
    fn remote_cc121_resets_only_changed_supported_physical_caches() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.set_part_parameter(0, 280, 1).unwrap();
        p.midi(0xb0, 1, 64).unwrap();
        p.midi(0xe0, 0, 32).unwrap();
        p.midi(0xd0, 64, 0).unwrap();
        p.midi(0xb0, 10, 24).unwrap();
        p.midi(0xb0, 11, 72).unwrap();
        p.midi(0xb0, 7, 80).unwrap();
        p.midi(0xb4, 121, 0).unwrap();
        assert_eq!(
            (p.parts[0].wheel, p.parts[0].bend, p.parts[0].morph),
            (64, 4096, 64)
        );
        p.midi(0xb4, 1, 96).unwrap();
        p.midi(0xe4, 127, 127).unwrap();
        p.midi(0xd4, 64, 0).unwrap();
        p.midi(0xb4, 64, 127).unwrap();
        p.midi(0xb4, 121, 0).unwrap();
        for part in &p.parts {
            assert_eq!((part.wheel, part.bend, part.morph), (0, 8192, 0));
        }
        assert_eq!(
            (p.parts[0].pan, p.parts[0].expression, p.parts[0].volume),
            (24, 72, 80)
        );
        assert_eq!(p.remote_sustain_active, 0);
    }
    #[test]
    fn active_remote_channel_writes_reject_atomically_even_when_unchanged() {
        // Independent native proof: both a changed and repeated RemoteCH write
        // clear physical-active destinations, without clearing their caches.
        for event in [
            Some((0xd4, 64, 0)),
            Some((0xb4, 1, 96)),
            Some((0xe4, 127, 127)),
            Some((0xb4, 64, 1)),
            Some((0x94, 60, 100)),
            None,
        ] {
            for channel in [4, 5] {
                let mut actual = dual();
                let mut baseline = dual();
                for p in [&mut actual, &mut baseline] {
                    p.set_parameter(3009, 4).unwrap();
                    p.midi(0x90, 67, 100).unwrap();
                    if let Some((status, a, b)) = event {
                        p.midi(status, a, b).unwrap();
                    } else {
                        // Also explicitly cover the independently retained mask.
                        p.remote_sustain_active = 1;
                    }
                    for _ in 0..128 {
                        p.next_stereo_sample();
                    }
                }
                assert!(matches!(
                    actual.apply_performance(
                        &[41],
                        &[32],
                        &[31],
                        &[127],
                        &[3009, 2019],
                        &[channel, 51]
                    ),
                    Err(ParameterError::UnsupportedValue { id: 3009, .. })
                ));
                assert_eq!(actual.common.system, baseline.common.system);
                assert_eq!(actual.common.performance, baseline.common.performance);
                for part in 0..2 {
                    assert_eq!(actual.parts[part].params, baseline.parts[part].params);
                    assert_eq!(actual.parts[part].extra, baseline.parts[part].extra);
                }
                assert_eq!(actual.remote_keys, baseline.remote_keys);
                assert_eq!(actual.remote_ribbon, baseline.remote_ribbon);
                assert_eq!(actual.remote_wheel, baseline.remote_wheel);
                assert_eq!(actual.remote_bend, baseline.remote_bend);
                assert_eq!(actual.remote_sustain, baseline.remote_sustain);
                assert_eq!(actual.remote_sustain_active, baseline.remote_sustain_active);
                for _ in 0..1024 {
                    assert_eq!(actual.next_stereo_sample(), baseline.next_stereo_sample());
                }
            }
        }
    }
    #[test]
    fn cold_remote_channel_imports_and_same_value_writes_remain_supported() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.set_parameter(3009, 4).unwrap();
        p.apply_performance(&[41], &[32], &[31], &[127], &[3009], &[17])
            .unwrap();
        assert_eq!(p.parameter(3009), Some(17));
        assert_eq!(p.part_parameter(0, 41), Some(32));
        assert_eq!(p.part_parameter(1, 31), Some(127));
    }

    #[test]
    fn explicit_same_keymode_releases_pedal_voices_then_replays_cached_sustain() {
        let mut p = dual();
        p.set_parameter(3009, 4).unwrap();
        p.midi(0x94, 60, 100).unwrap();
        p.midi(0xb4, 64, 127).unwrap();
        p.midi(0x84, 60, 64).unwrap();
        let slots: Vec<_> = p
            .slots
            .iter()
            .enumerate()
            .filter(|(_, s)| s.status == Status::Pedal)
            .map(|(i, _)| i)
            .collect();
        assert_eq!(slots.len(), 2);
        // Centered physical caches must not overwrite these direct values.
        p.midi(0xb0, 1, 32).unwrap();
        p.midi(0xe0, 0, 80).unwrap();
        p.midi(0xb0, 2, 64).unwrap();
        let controls = (p.parts[0].wheel, p.parts[0].bend, p.parts[0].morph);
        p.set_parameter(2016, 1).unwrap();
        for i in slots {
            assert_eq!(p.slots[i].status, Status::Released);
        }
        assert_eq!(p.remote_sustain, 127);
        assert_eq!(p.remote_sustain_active, 3);
        assert_eq!(
            (p.parts[0].wheel, p.parts[0].bend, p.parts[0].morph),
            controls
        );
    }
}

#[cfg(test)]
mod dormant_settings_tests {
    use super::*;
    fn render_equal(a: &mut Jp8000Instrument, b: &mut Jp8000Instrument) {
        for _ in 0..1024 {
            assert_eq!(a.next_stereo_sample(), b.next_stereo_sample());
        }
    }
    fn configure(p: &mut Jp8000Instrument, mode: u16) {
        p.apply_performance(
            &[30, 31, 41, 51, 280, 18],
            &[5, 127, 100, 100, 1, 64],
            &[30, 31, 41, 51, 280, 18, 1002],
            &[6, 64, 90, 100, 1, 64, 14],
            &[2016, 2017, 2018, 3009],
            &[mode, 60, 2, 4],
        )
        .unwrap();
        for note in [48, 72] {
            p.midi(0x94, note, 100).unwrap();
        }
        p.midi(0xb4, 64, 127).unwrap();
        p.midi(0xb4, 1, 64).unwrap();
        p.midi(0xe4, 0, 80).unwrap();
        p.midi(0xd4, 64, 0).unwrap();
        p.midi(0xb0, 10, 32).unwrap();
        p.midi(0xb0, 11, 80).unwrap();
    }
    #[test]
    fn dormant_edits_preserve_live_pcm_and_note_routing_in_all_key_modes() {
        for mode in 0..=2 {
            let mut a = Jp8000Instrument::new();
            let mut b = Jp8000Instrument::new();
            configure(&mut a, mode);
            configure(&mut b, mode);
            render_equal(&mut a, &mut b);
            a.apply_performance(
                &[],
                &[],
                &[],
                &[],
                &[2021, 2023, 2024, 2025, 2026, 2027, 2028, 2029, 2031, 2032],
                &[2, 0, 3, 89, 3, 1, 3, 0, 14, 128],
            )
            .unwrap();
            render_equal(&mut a, &mut b);
            a.set_parameter(2028, 3).unwrap();
            for p in [&mut a, &mut b] {
                for note in [48, 72] {
                    p.midi(0x84, note, 0).unwrap();
                }
                p.midi(0xb4, 64, 0).unwrap();
                // A matching disabled-trigger channel still receives ordinary notes.
                p.midi(0x9e, 64, 100).unwrap();
            }
            render_equal(&mut a, &mut b);
            a.midi(0x8e, 64, 0).unwrap();
            b.midi(0x8e, 64, 0).unwrap();
            render_equal(&mut a, &mut b);
        }
    }
    #[test]
    fn active_generators_and_unproved_assignment_edits_reject_atomically() {
        for (id, value) in [
            (2023, 1),
            (2024, 4),
            (2028, 0),
            (2028, 1),
            (2028, 2),
            (2028, 12),
            (2029, 1),
            (2021, 3),
            (2025, 90),
            (2026, 4),
            (2027, 2),
            (2031, 16),
            (2032, 129),
        ] {
            let mut a = Jp8000Instrument::new();
            let mut b = Jp8000Instrument::new();
            configure(&mut a, 1);
            configure(&mut b, 1);
            render_equal(&mut a, &mut b);
            assert!(a
                .apply_performance(&[41], &[70], &[41], &[71], &[id], &[value])
                .is_err());
            for part in 0..2 {
                assert_eq!(a.part_parameter(part, 41), b.part_parameter(part, 41));
            }
            assert_eq!(a.parameter(id), b.parameter(id));
            assert_eq!(a.remote_keys, b.remote_keys);
            assert_eq!(a.remote_ribbon, b.remote_ribbon);
            assert_eq!(a.remote_sustain_active, b.remote_sustain_active);
            render_equal(&mut a, &mut b);
        }
    }
    #[test]
    fn dormant_range_readback_and_default_assignment_are_explicit() {
        let mut p = Jp8000Instrument::new();
        assert_eq!(p.parameter(2028), Some(3));
        assert_eq!(mdlr_jp8000_rust_parameter_capability(2028), 2);
        for (id, max) in [
            (2021, 2),
            (2024, 3),
            (2025, 89),
            (2026, 3),
            (2027, 1),
            (2031, 15),
            (2032, 128),
        ] {
            for value in 0..=max {
                p.set_parameter(id, value).unwrap();
                assert_eq!(p.parameter(id), Some(value));
            }
        }
        p.set_parameter(2028, 3).unwrap();
        p.reset();
        assert_eq!(p.parameter(2028), Some(3));
    }
}

#[cfg(test)]
mod remote_expression_tests {
    use super::*;

    fn fixture(mode: u16, panel: u16) -> Jp8000Instrument {
        let mut p = Jp8000Instrument::new();
        p.apply_performance(&[], &[], &[], &[], &[2016, 2018, 3009], &[mode, panel, 2])
            .unwrap();
        p
    }
    fn expressions(p: &Jp8000Instrument) -> [u8; 2] {
        [p.parts[0].expression, p.parts[1].expression]
    }

    #[test]
    fn native_fixed_assignment_remote_volume_pan_are_noops() {
        // 23-step native default-routing fixture: Remote CC7/10 do not move
        // the direct-channel values or physical expression cache at assign3.
        let mut a = fixture(1, 0);
        let mut b = fixture(1, 0);
        for p in [&mut a, &mut b] {
            for (channel, volume, pan, expression) in [(0, 32, 17, 32), (1, 96, 111, 96)] {
                p.midi(0xb0 | channel, 7, volume).unwrap();
                p.midi(0xb0 | channel, 10, pan).unwrap();
                p.midi(0xb0 | channel, 11, expression).unwrap();
            }
            p.midi(0x92, 60, 100).unwrap();
        }
        for value in 0..128 {
            a.midi(0xb2, 7, value).unwrap();
            a.midi(0xb2, 10, value).unwrap();
            assert_eq!(a.next_stereo_sample(), b.next_stereo_sample());
        }
        assert_eq!((a.remote_expression, a.remote_expression_active), (127, 0));
        assert_eq!(expressions(&a), [32, 96]);
        assert_eq!((a.parts[0].volume, a.parts[1].volume), (32, 96));
        assert_eq!((a.parts[0].pan, a.parts[1].pan), (17, 111));
        // A default Remote expression/reset also leaves these direct overrides.
        a.midi(0xb2, 11, 127).unwrap();
        a.midi(0xb2, 121, 0).unwrap();
        assert_eq!(expressions(&a), [32, 96]);
        assert_eq!((a.parts[0].pan, a.parts[1].pan), (17, 111));
    }

    #[test]
    fn native_expression_matches_all_nine_destination_masks() {
        // Native local destination high bits: Single[U,L,U], Dual[UL,UL,UL],
        // Split[U,L,UL]. A centered event retires only the current active mask.
        for (mode, masks) in [(0, [1, 2, 1]), (1, [3, 3, 3]), (2, [1, 2, 3])] {
            for (panel, mask) in masks.into_iter().enumerate() {
                let mut p = fixture(mode, panel as u16);
                p.midi(0xb0, 11, 32).unwrap();
                p.midi(0xb1, 11, 96).unwrap();
                p.midi(0xb2, 11, 18).unwrap();
                assert_eq!(p.remote_expression_active, mask);
                assert_eq!(expressions(&p), [if mask & 1 != 0 {18} else {32}, if mask & 2 != 0 {18} else {96}]);
                p.midi(0xb2, 11, 127).unwrap();
                assert_eq!(p.remote_expression_active, 0);
                assert_eq!(expressions(&p), [if mask & 1 != 0 {127} else {32}, if mask & 2 != 0 {127} else {96}]);
            }
        }
    }

    #[test]
    fn native_expression_repeated_values_mask_replay_and_reset() {
        let mut p = fixture(0, 0);
        p.midi(0xb2, 11, 0).unwrap();
        p.midi(0xb0, 11, 64).unwrap();
        p.midi(0xb2, 11, 0).unwrap();
        assert_eq!(expressions(&p), [0, 127]);
        p.midi(0xb2, 11, 127).unwrap();
        p.midi(0xb0, 11, 64).unwrap();
        p.midi(0xb2, 11, 127).unwrap();
        assert_eq!(expressions(&p), [64, 127]);
        p.midi(0xb2, 11, 63).unwrap();
        p.midi(0xb0, 11, 0).unwrap();
        p.set_parameter(2016, 0).unwrap();
        p.set_parameter(2018, 0).unwrap();
        assert_eq!(expressions(&p), [0, 127]);
        p.set_parameter(2018, 1).unwrap();
        assert_eq!(expressions(&p), [127, 63]);
        assert_eq!(p.remote_expression_active, 2);
        p.set_parameter(2018, 0).unwrap();
        assert_eq!(expressions(&p), [63, 127]);
        assert_eq!(p.remote_expression_active, 1);
        p.midi(0xb0, 10, 17).unwrap();
        p.midi(0xb0, 7, 32).unwrap();
        p.midi(0xb1, 11, 96).unwrap();
        p.midi(0xb2, 121, 0).unwrap();
        assert_eq!(expressions(&p), [127, 96]);
        assert_eq!((p.parts[0].pan, p.parts[0].volume), (17, 32));
        assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
    }

    #[test]
    fn native_equal_mode_panel_preserve_direct_override_with_active_expression() {
        let mut p = fixture(2, 2);
        p.midi(0xb2, 11, 18).unwrap();
        p.midi(0xb0, 11, 32).unwrap();
        p.midi(0xb1, 11, 96).unwrap();
        p.set_parameter(2016, 2).unwrap();
        p.set_parameter(2018, 2).unwrap();
        assert_eq!(expressions(&p), [32, 96]);
        assert_eq!((p.remote_expression, p.remote_expression_active), (18, 3));
        p.midi(0xb2, 121, 0).unwrap();
        assert_eq!(expressions(&p), [127, 127]);
    }

    #[test]
    fn expression_remote_channel_guards_are_transactional() {
        // Native equal/changed3009 retires active destinations but retains the
        // cache. The bounded engine still rejects this operation before mutation.
        for (cache, active) in [(0, 3), (64, 3), (64, 0), (127, 1)] {
            for channel in [2, 3] {
                let mut a = fixture(1, 0);
                let mut b = fixture(1, 0);
                for p in [&mut a, &mut b] {
                    p.midi(0x90, 67, 100).unwrap();
                    p.midi(0xb2, 11, cache).unwrap();
                    p.remote_expression_active = active;
                    for _ in 0..32 {p.next_stereo_sample();}
                }
                assert!(matches!(a.apply_performance(&[41], &[32], &[31], &[127], &[3009, 2019], &[channel, 51]), Err(ParameterError::UnsupportedValue {id: 3009, ..})));
                assert_eq!(a.common.system, b.common.system);
                assert_eq!(a.common.performance, b.common.performance);
                for part in 0..2 {
                    assert_eq!(a.parts[part].params, b.parts[part].params);
                    assert_eq!(a.parts[part].extra, b.parts[part].extra);
                }
                assert_eq!((a.remote_expression, a.remote_expression_active), (b.remote_expression, b.remote_expression_active));
                for _ in 0..128 {assert_eq!(a.next_stereo_sample(), b.next_stereo_sample());}
            }
        }
        let mut p = fixture(1, 0);
        p.midi(0xb0, 11, 32).unwrap();
        p.midi(0xb1, 11, 96).unwrap();
        p.midi(0xb2, 11, 127).unwrap();
        p.set_parameter(3009, 2).unwrap();
        p.set_parameter(3009, 3).unwrap();
        assert_eq!(expressions(&p), [32, 96]);
    }

    #[test]
    fn remote_expression_updates_assigned_voices_and_reset_state() {
        let mut p = fixture(1, 0);
        p.midi(0x92, 60, 100).unwrap();
        p.midi(0xb2, 11, 64).unwrap();
        for (v, s) in p.voices.iter().zip(&p.slots) {
            if s.assigned {assert_eq!(v.expression, 64);}
        }
        // Engine silence preserves controls, so a later Remote reset must still
        // retire expression destinations. Full reset restores default controls.
        p.silence();
        assert_eq!((p.remote_expression, p.remote_expression_active), (64, 3));
        p.midi(0xb2, 121, 0).unwrap();
        assert_eq!(expressions(&p), [127, 127]);
        p.midi(0xb2, 11, 0).unwrap();
        p.reset();
        assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
        assert_eq!(expressions(&p), [127, 127]);
        assert!(p.set_parameter(2028, 2).is_err());
    }
    #[test]
    fn arp_cc123_releases_physical_keys_without_defeating_hold_or_pedal() {
        for use_pedal in [false,true] {
            let mut p=Jp8000Instrument::new();
            p.apply_performance(&[],&[],&[],&[],&[2023,2024,2025,2027,3009],&[1,0,4,if use_pedal{0}else{1},2]).unwrap();
            if use_pedal {p.midi(0xb2,64,64).unwrap();}
            p.midi(0x92,60,100).unwrap();
            for _ in 0..2205 {p.next_stereo_sample();}
            p.midi(0xb2,123,1).unwrap();
            assert!(p.remote_keys[60].is_some());
            p.midi(0xb2,123,0).unwrap();
            assert!(p.remote_keys.iter().all(Option::is_none));
            for _ in 0..8820 {p.next_stereo_sample();}
            assert!(p.arp.occupied(),"native Hold/pedal keeps the sequence alive");
            p.midi(0xb2,123,0).unwrap();
            assert!(p.arp.occupied());
            if use_pedal {p.midi(0xb2,64,0).unwrap();} else {p.set_parameter(2027,0).unwrap();}
            for _ in 0..2205 {p.next_stereo_sample();}
            assert!(!p.arp.occupied());
        }
    }

}

#[cfg(test)]
mod arp_capability_tests {
    use super::*;
    #[test]
    fn active_enum_support_matches_atomic_validation() {
        for id in [2021,2023,2024,2025,2026,2027] {
            assert_eq!(mdlr_jp8000_rust_parameter_capability(id),1);
        }
        assert_eq!(mdlr_jp8000_rust_parameter_capability(2028),2);
        assert_eq!(mdlr_jp8000_rust_parameter_capability(2029),2);
        let mut p=Jp8000Instrument::new();
        for mode in 0..=4 {
            let active=mdlr_jp8000_rust_parameter_value_capability(2024,mode)==1;
            let before=p.part_parameter(0,41);
            let result=p.apply_performance(&[41],&[32],&[],&[],&[2023,2024,2025],&[1,mode,4]);
            assert_eq!(result.is_ok(),active);
            if !active {assert_eq!(p.part_parameter(0,41),before);}
            p.set_parameter(2023,0).unwrap();
        }
        for pattern in 0..=90 {
            let active=mdlr_jp8000_rust_parameter_value_capability(2025,pattern)==1;
            assert_eq!(p.apply_performance(&[],&[],&[],&[],&[2023,2024,2025],&[1,0,pattern]).is_ok(),active);
            p.set_parameter(2023,0).unwrap();
        }
        // Cold factory imports preserve inactive values verbatim. UI support
        // is intentionally narrower than this truthful dormant-storage path.
        p.apply_performance(&[],&[],&[],&[],&[2023,2024,2025],&[0,3,52]).unwrap();
        assert_eq!(p.parameter(2024),Some(3));assert_eq!(p.parameter(2025),Some(52));
        assert_eq!(mdlr_jp8000_rust_parameter_value_capability(2024,4),0);
        assert_eq!(mdlr_jp8000_rust_parameter_value_capability(2025,52),2);
        assert!(p.set_parameter(2023,1).is_err());assert_eq!(p.parameter(2023),Some(0));
    }
}

#[cfg(test)]
mod random_capability_integration_tests {
    use super::*;
    fn fixture(enabled:bool)->Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[1002,30,51],&[0,5,127],&[],&[],
            &[2023,2024,2025,2026,3009,2034],&[u16::from(enabled),3,4,2,2,120]).unwrap();p
    }
    fn chord(p:&mut Jp8000Instrument) {
        for (note,velocity) in [(67,71),(60,93),(64,117)] {p.midi(0x92,note,velocity).unwrap();}
    }
    fn through(p:&mut Jp8000Instrument,pulse:u32) {
        while p.tempo_clock.pulses()<pulse {p.next_stereo_sample();}
    }
    #[test]
    fn full_and_dormant_random_imports_reach_native_verified_cold_notes() {
        for dormant in [false,true] {
            let mut p=fixture(!dormant);
            if dormant {p.set_parameter(2023,1).unwrap();}
            chord(&mut p);
            // Same source/event-verified pattern4 cold sequence as the isolated helper.
            for (i,note) in [91,60,64,84,67,72,67,76,72,76,88,79,60,91,79,84].into_iter().enumerate() {
                through(&mut p,1+6*i as u32);
                let held:Vec<_>=p.slots.iter().filter(|s|s.key_down).map(|s|s.note).collect();
                assert_eq!(held,[note]);
            }
        }
    }
    #[test]
    fn rejected_random_transactions_preserve_history_and_future_audio() {
        let mut a=fixture(true);let mut b=fixture(true);chord(&mut a);chord(&mut b);
        for _ in 0..20000 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        for (id,value) in [(2024,4),(2025,52),(2028,1),(2029,1)] {
            let history=format!("{:?}",a.arp);
            assert!(a.apply_performance(&[41],&[12],&[51],&[0],&[id],&[value]).is_err());
            assert_eq!(format!("{:?}",a.arp),history);
            assert_eq!(a.parts[0].params,b.parts[0].params);assert_eq!(a.parts[1].params,b.parts[1].params);
            assert_eq!(a.common.performance,b.common.performance);
            for _ in 0..16384 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        }
    }
    #[test]
    fn same_mode_write_and_hard_silence_forward_random_configuration() {
        let mut p=fixture(true);chord(&mut p);through(&mut p,25);
        let mut expected=p.arp.clone();expected.mode_write(3);
        p.set_parameter(2024,3).unwrap();assert_eq!(format!("{:?}",p.arp),format!("{:?}",expected));
        // Explicit hard silence clears history and reseeds, retaining the selected controls.
        // Ordinary note release/mode edits preserve the RNG; isolated native tests cover them.
        p.silence();let clean=fixture(true);
        assert_eq!(format!("{:?}",p.arp),format!("{:?}",clean.arp));
        assert_eq!(p.parameter(2024),Some(3));assert_eq!(p.parameter(2025),Some(4));
    }
    #[test]
    fn random_audio_and_mode_edits_are_callback_partition_invariant() {
        let mut reference=None;
        for size in [1,7,64,257] {
            let mut p=fixture(true);chord(&mut p);let mut output=Vec::new();
            for segment in 0..3 {
                if segment==1 {p.set_parameter(2024,3).unwrap();p.set_parameter(2026,1).unwrap();}
                if segment==2 {p.midi(0xb2,123,0).unwrap();}
                let mut l=[0.0;257];let mut r=[0.0;257];let mut remaining=16000;
                while remaining!=0 {let n=remaining.min(size);p.render_stereo(&mut l[..n],&mut r[..n]).unwrap();output.extend(l[..n].iter().zip(&r[..n]).map(|(l,r)|(l.to_bits(),r.to_bits())));remaining-=n;}
            }
            if let Some(expected)=&reference {assert_eq!(&output,expected);}else{reference=Some(output);}
        }
    }
}

#[cfg(test)]
mod remote_direct_collision_tests {
    use super::*;
    fn instrument() -> Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[30,1002],&[5,0],&[1002],&[1],&[3009],&[2]).unwrap();p
    }
    #[test] fn remote_collision_rejects_before_any_scope_or_audio_changes() {
        let mut a=instrument();let mut b=instrument();
        a.midi(0x90,60,100).unwrap();b.midi(0x90,60,100).unwrap();
        let cutoff=a.parameter(41);
        assert!(a.apply_performance(&[41],&[12],&[],&[],&[3009],&[0]).is_err());
        assert_eq!(a.parameter(41),cutoff);assert_eq!(a.parameter(3009),Some(2));
        for _ in 0..8192 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        a.midi(0x80,60,0).unwrap();assert_eq!(a.held_voice_count(),0);
        a.set_parameter(3009,0).unwrap();
    }
    #[test] fn collision_checks_mono_keys_and_direct_pedal_even_without_voices() {
        for mono in [0,1] {
            let mut p=instrument();p.set_parameter(71,mono).unwrap();
            p.midi(0x90,60,100).unwrap();assert!(p.set_parameter(3009,0).is_err());
            p.midi(0x80,60,0).unwrap();p.midi(0xb0,64,127).unwrap();
            assert!(p.set_parameter(3009,0).is_err());
            p.midi(0x90,60,100).unwrap();p.midi(0x80,60,0).unwrap();
            assert!(p.set_parameter(3009,0).is_err());
            p.midi(0xb0,64,0).unwrap();assert_eq!(p.held_voice_count(),0);
            p.set_parameter(3009,0).unwrap();
        }
    }
    #[test] fn unrelated_remote_edits_and_atomic_receive_retirement_remain_valid() {
        let mut p=instrument();p.midi(0x90,60,100).unwrap();p.midi(0xb0,64,127).unwrap();
        p.set_parameter(3009,3).unwrap();p.set_parameter(3009,17).unwrap();
        assert!(p.set_parameter(3009,16).is_err());
        p.apply_performance(&[1002],&[5],&[],&[],&[3009],&[0]).unwrap();
        assert_eq!(p.part_parameter(0,1002),Some(5));assert_eq!(p.parameter(3009),Some(0));
        assert!(p.parts[0].held[1].iter().all(|&n|n==0));assert!(!p.parts[0].sustain[0]);
        assert_eq!(p.held_voice_count(),0);
        p.midi(0x80,60,0).unwrap();p.midi(0xb0,64,0).unwrap();
    }
    #[test] fn every_colliding_part_must_retire_before_atomic_remote_change() {
        let mut p=instrument();p.set_part_parameter(1,1002,0).unwrap();p.midi(0x90,60,100).unwrap();
        assert!(p.apply_performance(&[1002],&[5],&[],&[],&[3009],&[0]).is_err());
        assert_eq!(p.part_parameter(0,1002),Some(0));
        p.apply_performance(&[1002],&[5],&[1002],&[6],&[3009],&[0]).unwrap();
        assert_eq!(p.held_voice_count(),0);
    }
}

#[cfg(test)]
mod semantic_remote_touch_tests {
    use super::*;
    fn instrument(remote:u16)->Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[30],&[5],&[],&[],&[2023,2024,2025,2027,3009],&[1,0,4,0,remote]).unwrap();p
    }
    #[test] fn semantic_input_matches_channel_remote_without_changing_controls() {
        for remote in [2,16,17] {
            let mut actual=instrument(remote);let mut expected=instrument(2);
            for (status,a,b) in [(0x90,60,100),(0x90,60,100),(0xb0,64,127),(0x80,60,0),(0xb0,64,0)] {
                actual.remote_touch(status,a,b).unwrap();expected.midi(status|2,a,b).unwrap();
                for _ in 0..16000 {assert_eq!(actual.next_stereo_sample(),expected.next_stereo_sample());}
                assert_eq!(actual.parameter(3009),Some(remote));
            }
            assert!(actual.remote_keys.iter().all(Option::is_none));assert_eq!(actual.remote_sustain,0);
        }
    }
    #[test] fn external_remote_and_touch_intentionally_share_key_and_pedal_caches() {
        for touch_first in [false,true] {for external_off_first in [false,true] {
            let mut p=instrument(2);p.set_parameter(2023,0).unwrap();
            if touch_first {p.remote_touch(0x90,60,100).unwrap();p.midi(0x92,60,100).unwrap();}
            else {p.midi(0x92,60,100).unwrap();p.remote_touch(0x90,60,100).unwrap();}
            assert_eq!(p.held_voice_count(),1);
            if external_off_first {p.midi(0x82,60,0).unwrap();}else{p.remote_touch(0x80,60,0).unwrap();}
            assert_eq!(p.held_voice_count(),0);
            p.remote_touch(0x80,60,0).unwrap();p.midi(0x82,60,0).unwrap();assert_eq!(p.held_voice_count(),0);
            p.remote_touch(0xb0,64,127).unwrap();p.midi(0xb2,64,0).unwrap();assert_eq!(p.remote_sustain,0);
        }}
    }
    #[test] fn zero_velocity_note_on_matches_remote_midi_mono_fallback() {
        for remote in [2,16,17] {
            let mut actual=instrument(remote);let mut expected=instrument(2);
            for p in [&mut actual,&mut expected] {p.set_parameter(2023,0).unwrap();p.apply_patch(&[71,283,51,336],&[1,1,80,192]).unwrap();}
            for (status,note,velocity) in [(0x90,60,100),(0x90,64,110),(0x90,64,0),(0x80,60,0)] {
                actual.remote_touch(status,note,velocity).unwrap();expected.midi(status|2,note,velocity).unwrap();
                assert_eq!(actual.parts[0].last_velocity_code,expected.parts[0].last_velocity_code);
                for _ in 0..4096 {assert_eq!(actual.next_stereo_sample(),expected.next_stereo_sample());}
            }
            assert_eq!(actual.held_voice_count(),0);
        }
    }
    #[test] fn invalid_touch_messages_are_rejected_without_side_effects() {
        let mut a=instrument(2);let mut b=instrument(2);
        for (s,n,v) in [(0x91,60,100),(0xe0,0,64),(0xb0,1,127),(0x90,128,1),(0x90,60,128)] {assert!(a.remote_touch(s,n,v).is_err());}
        for _ in 0..8192 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        unsafe {assert_eq!(mdlr_jp8000_rust_remote_touch(std::ptr::null_mut(),0x90,60,100),-1);}
    }
}

#[cfg(test)]
mod normal5_integration_tests {
    use super::*;
    fn fixture(enabled:bool)->Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[1002,30,51],&[0,5,127],&[],&[],&[2023,2024,2025,2026,3009,2034],&[u16::from(enabled),0,5,0,2,120]).unwrap();p
    }
    fn chord(p:&mut Jp8000Instrument) {for (n,v) in [(67,71),(60,93),(64,117)] {p.midi(0x92,n,v).unwrap();}}
    fn through(p:&mut Jp8000Instrument,pulse:u32) {while p.tempo_clock.pulses()<pulse {p.next_stereo_sample();}}
    #[test]
    fn pattern5_reaches_the_scheduler_from_direct_or_dormant_transactions() {
        for dormant in [false,true] {
            let mut p=fixture(!dormant);if dormant {p.set_parameter(2023,1).unwrap();}chord(&mut p);
            for (i,note) in [60,64,67,60,64,67,60,64,67].into_iter().enumerate() {
                through(&mut p,1+3*i as u32);let held:Vec<_>=p.slots.iter().filter(|s|s.key_down).map(|s|s.note).collect();assert_eq!(held,[note]);
                through(&mut p,3+3*i as u32);assert!(p.slots.iter().all(|s|!s.key_down));
            }
        }
    }
    #[test]
    fn only_verified_patterns_are_active_and_unsupported_transactions_are_atomic() {
        let mut a=fixture(true);let mut b=fixture(true);chord(&mut a);chord(&mut b);
        for _ in 0..4096 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        for pattern in 0..=90 {
            let capability=mdlr_jp8000_rust_parameter_value_capability(2025,pattern);
            assert_eq!(capability,if matches!(pattern,4|5|11|13|21|39|51){1}else if pattern<=89{2}else{0});
            if matches!(pattern,4|5|11|13|21|39|51){continue;}
            let arp=format!("{:?}",a.arp);
            assert!(a.apply_performance(&[41],&[12],&[51],&[0],&[2025,2034],&[pattern,150]).is_err());
            assert_eq!(format!("{:?}",a.arp),arp);assert_eq!(a.common.performance,b.common.performance);
            for part in 0..2 {assert_eq!(a.parts[part].params,b.parts[part].params);}
            for _ in 0..32 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        }
        for (id,value) in [(2024,4),(2029,1),(2028,12)] {
            assert!(a.apply_performance(&[41],&[12],&[],&[],&[id],&[value]).is_err());
            for _ in 0..128 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
        }
        a.silence();a.set_parameter(2023,0).unwrap();
        for pattern in 0..=89 {a.set_parameter(2025,pattern).unwrap();assert_eq!(a.parameter(2025),Some(pattern));if !matches!(pattern,4|5|11|13|21|39|51){assert!(a.set_parameter(2023,1).is_err());}}
    }
    #[test]
    fn same_pattern_write_and_silence_reset_preserve_selected_pattern() {
        let mut p=fixture(true);chord(&mut p);through(&mut p,10);
        let mut expected=p.arp.clone();expected.pattern_write(5);p.set_parameter(2025,5).unwrap();assert_eq!(format!("{:?}",p.arp),format!("{:?}",expected));
        p.silence();let clean=fixture(true);assert_eq!(format!("{:?}",p.arp),format!("{:?}",clean.arp));assert_eq!(p.parameter(2025),Some(5));
        chord(&mut p);through(&mut p,14);p.reset();assert_eq!(format!("{:?}",p.arp),format!("{:?}",clean.arp));assert_eq!(p.parameter(2025),Some(5));
    }
    #[test]
    fn pattern_switching_audio_is_callback_partition_invariant() {
        let mut reference=None;
        for size in [1,7,64,257] {
            let mut p=fixture(true);chord(&mut p);let mut output=Vec::new();
            for segment in 0..4 {
                if segment==1 {p.set_parameter(2025,4).unwrap();}
                if segment==2 {p.set_parameter(2025,5).unwrap();p.set_parameter(2024,3).unwrap();}
                if segment==3 {p.midi(0xb2,123,0).unwrap();}
                let mut l=[0.0;257];let mut r=[0.0;257];let mut remaining=12000;
                while remaining!=0 {let n=remaining.min(size);p.render_stereo(&mut l[..n],&mut r[..n]).unwrap();output.extend(l[..n].iter().zip(&r[..n]).map(|(l,r)|(l.to_bits(),r.to_bits())));remaining-=n;}
            }
            if let Some(expected)=&reference {assert_eq!(&output,expected);} else {reference=Some(output);}
        }
    }
}

#[cfg(test)]
mod cc84_lifecycle_tests {
 use super::*;
 fn patch()->Jp8000Instrument{
  let mut p=Jp8000Instrument::new();p.apply_performance(&[69,70,71,72],&[0,33,0,0],&[],&[],&[3009],&[2]).unwrap();p
 }
 #[test] fn valid_latch_without_held_source_forces_glide_but_remains_poly(){
  let mut p=patch();p.midi(0x90,60,100).unwrap();p.midi(0xb0,84,60).unwrap();p.midi(0x80,60,64).unwrap();
  assert_eq!(p.parts[0].forced_portamento_source,Some(60));p.midi(0x90,67,100).unwrap();
  let i=p.slots.iter().position(|s|s.status==Status::Held&&s.note==67).unwrap();
  assert_eq!(p.parts[0].held[1][67],1);assert!(p.parts[0].mono_held[1].is_empty());
  assert_eq!(p.voices[i].glide.initial_cents,-700);assert!(p.voices[i].glide_enabled);assert_eq!(p.parts[0].forced_portamento_source,None);
 }
 #[test] fn held_cc84_source_selects_special_handler_not_matching_slot(){
  let mut p=patch();for note in 52..60{p.midi(0x90,note,100).unwrap();}
  let original=p.slots.iter().position(|s|s.note==59).unwrap();assert_ne!(original,0);
  p.midi(0xb0,84,59).unwrap();p.midi(0x90,72,100).unwrap();
  assert_eq!(p.slots[original].note,59);assert_eq!(p.slots[0].note,72);assert_eq!(p.parts[0].held[1][52],1);
  assert_eq!(p.parts[0].mono_held[1].highest(),Some(72));assert!(!p.slots[0].mono);assert_eq!(p.voices[0].glide.initial_cents,-1300);
 }
 #[test] fn mixed_banks_fallback_preserves_incoming_source_and_unconsumed_latch(){
  let mut p=patch();p.apply_patch(&[71,72],&[1,1]).unwrap();p.midi(0x92,60,100).unwrap();p.apply_patch(&[71,72],&[0,0]).unwrap();
  p.midi(0x90,64,96).unwrap();p.midi(0xb0,84,64).unwrap();p.midi(0x90,67,93).unwrap();
  assert_eq!(p.slots[0].origin,0);assert_eq!(p.slots[0].note,67);assert!(p.slots[0].mono);
  p.midi(0xb0,84,64).unwrap();p.midi(0x80,67,48).unwrap();
  assert_eq!(p.slots[0].note,60);assert_eq!(p.slots[0].origin,1);assert!(!p.slots[0].mono);
  assert_eq!(p.voices[0].glide.initial_cents,400);assert!(p.voices[0].glide_enabled);assert_eq!(p.parts[0].forced_portamento_source,Some(64));
  p.midi(0x90,69,90).unwrap();assert_eq!(p.voices[0].glide.initial_cents,-500);assert_eq!(p.parts[0].forced_portamento_source,None);
  p.midi(0x80,69,37).unwrap();assert_eq!(p.slots[0].note,60);assert!(!p.voices[0].glide_enabled);
 }
 #[test] fn identical_poly_and_forced_mono_pitch_consume_separate_counts(){
  let mut p=patch();p.midi(0x90,60,100).unwrap();p.midi(0xb0,84,60).unwrap();p.midi(0x90,60,100).unwrap();
  assert_eq!(p.parts[0].held[1][60],1);assert_eq!(p.parts[0].mono_held[1].highest(),Some(60));
  p.midi(0x80,60,64).unwrap();assert_eq!(p.parts[0].held[1][60],1);assert!(p.parts[0].mono_held[1].is_empty());
  p.midi(0x80,60,64).unwrap();assert_eq!(p.parts[0].held[1][60],0);
 }
 #[test] fn latch_reset_scope_and_explicit_equal_glide_setter_remain_distinct(){
  let mut p=patch();p.midi(0xb0,84,55).unwrap();p.midi(0xb0,120,0).unwrap();p.midi(0xb0,123,0).unwrap();
  p.midi(0xb2,121,0).unwrap();assert_eq!(p.parts[0].forced_portamento_source,Some(55));
  p.midi(0xb0,121,0).unwrap();assert_eq!(p.parts[0].forced_portamento_source,None);
  p.midi(0xb0,84,60).unwrap();p.midi(0x90,67,100).unwrap();let i=p.slots.iter().position(|s|s.note==67&&s.status==Status::Held).unwrap();
  let before=p.voices[i].glide;p.set_parameter(70,33).unwrap();assert!(!p.voices[i].glide_enabled);
  assert_eq!((p.voices[i].glide.initial_cents,p.voices[i].glide.offset_cents,p.voices[i].glide.remaining),(before.initial_cents,before.offset_cents,before.remaining));
  p.voices[i].tick_glide();assert_eq!(p.voices[i].glide.offset_cents,0);
 }
 #[test] fn full_m_counter_rejects_allocation_but_consumes_cc84(){
  let mut p=patch();p.set_parameter(71,1).unwrap();for _ in 0..127{p.parts[0].mono_held[1].press(60);}
  p.midi(0xb0,84,55).unwrap();p.midi(0x90,60,100).unwrap();assert_eq!(p.parts[0].forced_portamento_source,None);assert_eq!(p.held_voice_count(),0);
 }
 #[test] fn exact_new_patterns_are_admitted_without_loosening_other_guards(){
  let mut p=patch();for pattern in [4,5,11,13,21,39]{p.apply_performance(&[],&[],&[],&[],&[2023,2025],&[1,pattern]).unwrap();}
  for pattern in [0,3,6,10,12,14,89]{assert!(p.set_parameter(2025,pattern).is_err());assert_eq!(p.parameter(2025),Some(39));}
  assert!(p.set_parameter(2024,4).is_err());assert!(p.set_parameter(2029,1).is_err());
 }
}

#[cfg(test)]
mod reset_value_tests {
    use super::*;

    fn sounding(remote: bool) -> Jp8000Instrument {
        let mut p = Jp8000Instrument::new();
        p.apply_performance(&[30, 51, 69, 70], &[5, 100, 1, 37],
            &[30, 51, 69, 70], &[5, 100, 1, 37], &[2016, 3009], &[1, 2]).unwrap();
        for channel in 0..2 {
            for (cc, value) in [(1, 73), (2, 48), (7, 91), (10, 26), (11, 82), (64, 127)] {
                p.midi(0xb0 | channel, cc, value).unwrap();
            }
            p.midi(0xe0 | channel, 12, 81).unwrap();
            p.midi(0x90 | channel, 60, 103).unwrap();
            p.midi(0x90 | channel, 67, 97).unwrap();
            p.midi(0x80 | channel, 60, 44).unwrap();
            p.midi(0xb0 | channel, 84, 55).unwrap();
        }
        if remote {
            for (cc, value) in [(1, 99), (2, 61), (11, 51), (64, 127)] {
                p.midi(0xb2, cc, value).unwrap();
            }
            p.midi(0xe2, 11, 100).unwrap();
            p.midi(0x92, 72, 101).unwrap();
            p.midi(0x82, 72, 53).unwrap();
        }
        for _ in 0..1024 { p.next_stereo_sample(); }
        p
    }

    // Inspect routing, key accounting and controller caches without reading
    // object padding or claiming this is a complete DSP-state fingerprint.
    fn caches(p: &Jp8000Instrument) -> String {
        let slots: Vec<_> = p.slots.iter().map(|s|
            (s.owner, s.origin, s.channel, s.note, s.age, s.status, s.assigned, s.key_down, s.mono)).collect();
        let mut text = format!("{:?}{:?}{:?}{:?}{:?}{:?}{:?}",
            p.common.performance, p.common.system, p.order, slots, p.remote_keys,
            (p.remote_ribbon, p.remote_wheel, p.remote_bend, p.remote_sustain,
             p.remote_sustain_active, p.remote_expression, p.remote_expression_active),
            (p.millisecond_clock, p.millisecond_remainder, p.serial, p.until_tick));
        for part in &p.parts {
            let counts: Vec<_> = part.mono_held.iter().map(|keys| {
                let mut copy = keys.clone();
                std::array::from_fn::<_, 128, _>(|note| {
                    let mut count = 0u16;
                    while copy.release(note as u8) { count += 1; }
                    count
                })
            }).collect();
            text.push_str(&format!("{:?}{:?}{:?}{:?}{:?}{:?}", part.params,
                part.extra, part.held, counts, part.sustain,
                (part.mono_last_input, part.forced_portamento_source, part.bend,
                 part.wheel, part.volume, part.expression, part.pan, part.morph, part.last_velocity_code)));
        }
        text
    }

    fn unchanged_audio(a: &mut Jp8000Instrument, b: &mut Jp8000Instrument, frames: usize) {
        for frame in 0..frames {
            assert_eq!(a.next_stereo_sample(), b.next_stereo_sample(), "frame {frame}");
        }
    }

    #[test]
    fn nonzero_direct_channel_mode_values_preserve_active_state_and_future_audio() {
        for cc in [120, 121, 123] {
            for channel in 0..2 {
                let (mut actual, mut reference) = (sounding(false), sounding(false));
                for value in 1..=127 {
                    actual.midi(0xb0 | channel, cc, value).unwrap();
                    assert_eq!(caches(&actual), caches(&reference), "CC{cc} channel{channel} value{value}");
                    unchanged_audio(&mut actual, &mut reference, 16);
                }
                actual.midi(0x90 | channel, 74, 96).unwrap();
                reference.midi(0x90 | channel, 74, 96).unwrap();
                assert_eq!(caches(&actual), caches(&reference));
                unchanged_audio(&mut actual, &mut reference, 4096);
            }
        }
    }

    #[test]
    fn nonzero_remote_reset_preserves_physical_caches_and_future_audio() {
        let (mut actual, mut reference) = (sounding(true), sounding(true));
        for value in 1..=127 {
            actual.midi(0xb2, 121, value).unwrap();
            assert_eq!(caches(&actual), caches(&reference), "Remote CC121 value{value}");
            unchanged_audio(&mut actual, &mut reference, 16);
        }
        actual.midi(0x92, 76, 93).unwrap();
        reference.midi(0x92, 76, 93).unwrap();
        assert_eq!(caches(&actual), caches(&reference));
        unchanged_audio(&mut actual, &mut reference, 4096);
    }

    #[test]
    fn nonzero_values_do_not_expand_unverified_routes_or_bypass_data_validation() {
        let (mut actual, mut reference) = (sounding(true), sounding(true));
        for (status, cc, value, expected) in [
            (0xb0, 120, 1, MidiError::UnsupportedRouting),
            (0xb1, 123, 127, MidiError::UnsupportedRouting),
            (0xb2, 123, 1, MidiError::UnsupportedRouting),
            (0xb0, 121, 128, MidiError::InvalidData),
            (0xb2, 121, 255, MidiError::InvalidData),
        ] {
            assert_eq!(actual.midi(status, cc, value), Err(expected));
            assert_eq!(caches(&actual), caches(&reference));
            unchanged_audio(&mut actual, &mut reference, 64);
        }
    }
}

#[cfg(test)]
mod explicit_lfo_parameter_tests {
    use super::*;

    fn fast_parts() -> Jp8000Instrument {
        let mut p = Jp8000Instrument::new();
        p.apply_performance(&[16, 17, 19], &[0, 127, 127],
                            &[16, 17, 19], &[0, 127, 127], &[], &[]).unwrap();
        for part in &mut p.parts {
            assert_eq!(part.lfo.tick(), -16384);
            assert_eq!(part.lfo2.tick(), -16384);
        }
        p
    }

    #[test]
    fn scoped_equal_event_restarts_only_the_addressed_part() {
        for part in 0..2 {
            for (id, value) in [(16, 0), (17, 127), (19, 127)] {
                let mut p = fast_parts();
                p.set_part_parameter(part, id, value).unwrap();
                for n in 0..2 {
                    assert_eq!(p.parts[n].lfo.value(), -16384);
                    assert_eq!(p.parts[n].lfo2.value(), -16384);
                    let next = if n == part { -16384 } else { 16384 };
                    assert_eq!(p.parts[n].lfo.tick(), next);
                    assert_eq!(p.parts[n].lfo2.tick(), next);
                }
            }
        }
    }

    #[test]
    fn paired_atomic_events_refresh_both_parts_without_recomputing_output() {
        let mut p = fast_parts();
        p.apply_performance(&[16, 17], &[0, 127], &[19], &[127], &[], &[]).unwrap();
        for part in &mut p.parts {
            assert_eq!(part.lfo.value(), -16384);
            assert_eq!(part.lfo2.value(), -16384);
            assert_eq!(part.lfo.tick(), -16384);
            assert_eq!(part.lfo2.tick(), -16384);
        }
    }

    #[test]
    fn rejected_performance_keeps_all_lfo_histories() {
        let mut p = fast_parts();
        assert!(p.apply_performance(&[17], &[127], &[19], &[128], &[], &[]).is_err());
        for part in &mut p.parts {
            assert_eq!(part.lfo.value(), -16384);
            assert_eq!(part.lfo2.value(), -16384);
            assert_eq!(part.lfo.tick(), 16384);
            assert_eq!(part.lfo2.tick(), 16384);
        }
    }

    #[test]
    fn unrelated_part_control_preserves_both_fast_phases() {
        let mut p = fast_parts();
        p.set_part_parameter(0, 41, 127).unwrap();
        for part in &mut p.parts {
            assert_eq!(part.lfo.tick(), 16384);
            assert_eq!(part.lfo2.tick(), 16384);
        }
    }
}

#[cfg(test)]
mod ordinary_release_velocity_tests {
    use super::*;
    fn instrument() -> Jp8000Instrument {
        let mut p = Jp8000Instrument::new();
        p.apply_patch(&[30, 283, 50, 57, 334, 348, 1002, 3009],
            &[5, 1, 64, 64, 254, 254, 0, 17]).unwrap();
        p
    }
    fn slot(p: &Jp8000Instrument) -> usize {
        (0..8).find(|&i| p.slots[i].owner == 0 && p.slots[i].status == Status::Held).unwrap()
    }
    #[test]
    fn direct_normalization_and_current_velocity_switch_are_event_specific() {
        for (status, value, enabled, raw, code) in [
            (0x80, 0, 1, 0, -128), (0x90, 0, 1, 64, -26),
            (0x80, 127, 0, 80, 0), (0x90, 0, 0, 80, 0)] {
            let mut p = instrument(); p.midi(0x90, 60, 100).unwrap(); let i = slot(&p);
            p.set_parameter(283, enabled).unwrap(); p.midi(status, 60, value).unwrap();
            assert_eq!((p.voices[i].release_velocity_raw, p.voices[i].release_velocity_code), (raw, code));
            assert_eq!(p.voices[i].velocity_code, 54);
        }
    }
    #[test]
    fn semantic_and_external_remote_explicit_off_zero_both_normalize_to64() {
        for semantic in [false, true] {
            let mut p = instrument(); p.set_parameter(3009, 2).unwrap();
            if semantic { p.remote_touch(0x90, 60, 100).unwrap(); }
            else { p.midi(0x92, 60, 100).unwrap(); }
            let i = slot(&p);
            if semantic { p.remote_touch(0x80, 60, 0).unwrap(); }
            else { p.midi(0x82, 60, 0).unwrap(); }
            assert_eq!((p.voices[i].release_velocity_raw, p.voices[i].release_velocity_code), (64, -26));
            assert_eq!(p.slots[i].status, Status::Released);
        }
    }
    #[test]
    fn sustain_caches_raw_only_and_pedal_up_does_not_resample_switch() {
        let mut p = instrument(); p.midi(0x90, 60, 64).unwrap(); let i = slot(&p);
        p.midi(0xb0, 64, 127).unwrap(); let rate = p.voices[i].amp.rates[2];
        p.midi(0x80, 60, 0).unwrap();
        assert_eq!(p.slots[i].status, Status::Pedal);
        assert_eq!((p.voices[i].release_velocity_raw, p.voices[i].release_velocity_code), (0, -26));
        assert_eq!(p.voices[i].amp.rates[2], rate);
        p.set_parameter(283, 0).unwrap(); p.midi(0xb0, 64, 0).unwrap();
        assert_eq!((p.voices[i].release_velocity_raw, p.voices[i].release_velocity_code), (0, -128));
        assert_eq!(p.voices[i].velocity_code, -26);
        assert_eq!(p.slots[i].status, Status::Released);
    }
    #[test]
    fn cc123_uses64_even_when_switch_is_off_and_cc121_uses_the_retained_raw() {
        for sustained in [false, true] {
            let mut p = instrument(); p.set_parameter(283, 0).unwrap();
            p.midi(0x90, 60, 100).unwrap(); let i = slot(&p);
            if sustained { p.midi(0xb0, 64, 127).unwrap(); }
            p.midi(0xb0, 123, 0).unwrap();
            assert_eq!(p.voices[i].release_velocity_raw, 64);
            assert_eq!(p.voices[i].release_velocity_code, if sustained {0} else {-26});
            if sustained { p.midi(0xb0, 121, 0).unwrap(); }
            assert_eq!(p.voices[i].release_velocity_code, -26);
        }
        let mut p = instrument(); p.midi(0x90, 60, 100).unwrap(); let i = slot(&p);
        p.midi(0xb0, 64, 127).unwrap(); p.midi(0x80, 60, 0).unwrap();
        p.midi(0xb0, 121, 0).unwrap();
        assert_eq!((p.voices[i].release_velocity_raw, p.voices[i].release_velocity_code), (0, -128));
    }
    #[test]
    fn explicit_host_retirement_remains_velocity_less_and_ownership_reset_clears_codes() {
        let mut p = instrument(); p.midi(0x90, 60, 100).unwrap(); let i = slot(&p);
        p.midi(0xb0, 64, 127).unwrap(); p.midi(0x80, 60, 0).unwrap();
        p.release_all(0);
        assert_eq!((p.voices[i].release_velocity_raw, p.voices[i].release_velocity_code), (0, 54));
        assert_eq!(p.slots[i].status, Status::Released);
        p.reconfigure_owners();
        for v in &p.voices {
            assert_eq!((v.velocity_code, v.release_velocity_code, v.release_velocity_raw), (0, 0, 255));
        }
    }
    #[test]
    fn release_audio_is_independent_of_render_partition_after_an_exact_event_boundary() {
        let mut a = instrument(); let mut b = instrument();
        a.midi(0x90, 60, 100).unwrap(); b.midi(0x90, 60, 100).unwrap();
        for _ in 0..1234 { assert_eq!(a.next_stereo_sample(), b.next_stereo_sample()); }
        a.midi(0x80, 60, 32).unwrap(); b.midi(0x80, 60, 32).unwrap();
        let mut al=[0.0;1024]; let mut ar=[0.0;1024]; let mut bl=[0.0;1024]; let mut br=[0.0;1024];
        a.render_stereo(&mut al, &mut ar).unwrap();
        for (l,r) in bl.chunks_mut(63).zip(br.chunks_mut(63)) { b.render_stereo(l,r).unwrap(); }
        assert_eq!(al,bl); assert_eq!(ar,br);
    }
}

#[cfg(test)]
mod shared_history_lifecycle_tests {
    use super::*;
    fn state(s:&Jp8000Instrument)->([i64;79],[i64;79],[i64;59],[i64;2],[usize;3]) {
        let h=&s.oscillator_history;
        (h.three_voice[0].cells,h.three_voice[1].cells,h.two_voice.cells,h.voice2_dc_route,
         [h.three_voice[0].pos,h.three_voice[1].pos,h.two_voice.pos])
    }
    fn active()->Jp8000Instrument {
        let mut s=Jp8000Instrument::new();
        s.apply_patch(&[30,31,32,23,41,42,54,55,56,57],&[2,64,0,64,127,0,0,0,127,64]).unwrap();
        for n in [48,52,55,60,64,67,72,76] {s.midi(0x90,n,100).unwrap();}
        for _ in 0..2400 {s.next_stereo_sample();}
        s
    }
    #[test]
    fn silence_preserves_shared_history_but_hard_reset_clears_it() {
        let mut s=active();let old=state(&s);
        assert!(old.0.iter().chain(&old.1).chain(&old.2).any(|v|*v!=0));
        s.silence();assert_eq!(state(&s),old);
        s.reset();assert_eq!(state(&s),([0;79],[0;79],[0;59],[0;2],[0;3]));
    }
    #[test]
    fn parameter_and_owner_changes_do_not_clear_or_advance_shared_history() {
        let mut s=active();let old=state(&s);
        s.set_parameter(30,4).unwrap();assert_eq!(state(&s),old);
        s.set_parameter(2016,1).unwrap();assert_eq!(state(&s),old);
        s.set_parameter(30,2).unwrap();assert_eq!(state(&s),old);
        assert!(s.apply_patch(&[30,23],&[2,128]).is_err());assert_eq!(state(&s),old);
    }
    #[test]
    fn block_partitioning_matches_pcm_and_shared_state_across_wave_edits() {
        let(mut a,mut b)=(active(),active());
        for (wave,frames) in [(2,127),(4,67),(2,129),(0,91),(5,31),(2,256)] {
            a.set_parameter(30,wave).unwrap();b.set_parameter(30,wave).unwrap();
            let(mut left,mut right)=([0.0;256],[0.0;256]);
            let(mut bl,mut br)=([0.0;256],[0.0;256]);
            a.render_stereo(&mut left[..frames],&mut right[..frames]).unwrap();
            let mut start=0;
            for width in [1,7,19,3,41,128,256] {
                let end=(start+width).min(frames);
                b.render_stereo(&mut bl[start..end],&mut br[start..end]).unwrap();start=end;
            }
            assert_eq!(&left[..frames],&bl[..frames]);assert_eq!(&right[..frames],&br[..frames]);
            assert_eq!(state(&a),state(&b));
        }
    }
    #[test]
    fn free_owned_balance_targets_refresh_without_rendering_or_history_reset() {
        let mut s=Jp8000Instrument::new();let old=state(&s);
        assert!(s.voices.iter().all(|v|!v.controller_assigned));
        s.set_parameter(23,64).unwrap();
        assert!(s.voices.iter().all(|v|v.balance_target==super::super::balance_target(64)));
        assert_eq!(state(&s),old);
    }
}

#[cfg(test)]
mod patterns21_39_admission_tests {
    use super::*;
    fn fixture(pattern:u16,mode:u16,destination:u16,panel:u16)->Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[30,31,51,54,55,56,57,69,70,71,72,283],
            &[5,0,127,0,0,127,0,0,40,0,0,1],
            &[30,31,51,54,55,56,57,69,70,71,72,283],
            &[5,0,127,0,0,127,0,0,40,0,0,1],
            &[2016,2017,2018,2021,2023,2024,2025,2026,2027,2034,3009],
            &[mode,62,panel,destination,1,0,pattern,0,0,250,2]).unwrap();p
    }
    fn through(p:&mut Jp8000Instrument,pulse:u32) {
        while p.tempo_clock.pulses()<pulse {p.next_stereo_sample();}
    }
    #[test]
    fn authored_first_subdivisions_reach_real_voices_and_cc84_is_consumed() {
        // Expected notes follow the unsorted three-key chord in Up order.
        // These few authored constraints are not a copied vendor record table.
        for pattern in [21,39] {
            let mut p=fixture(pattern,0,0,0);
            for (n,v) in [(67,71),(60,93),(64,117)] {p.midi(0x92,n,v).unwrap();}
            let observations=if pattern==21 {[(1,60,81),(13,64,117),(19,67,62)]}
                else {[(1,60,93),(7,64,117),(10,67,55)]};
            for (pulse,note,velocity) in observations {
                through(&mut p,pulse);
                let held:Vec<_>=p.slots.iter().enumerate().filter(|(_,s)|s.status==Status::Held).collect();
                assert_eq!(held.len(),1);
                let (i,s)=held[0];assert_eq!((s.owner,s.origin,s.channel,s.note),(0,0,16,note));
                assert_eq!(p.voices[i].velocity_code,super::super::control::velocity_code(velocity));
                assert_eq!(p.parts[0].held[0][note as usize],1);
                assert!(p.parts[0].mono_held[0].is_empty());
                assert_eq!(p.parts[0].forced_portamento_source,None);
                if pattern==21 && pulse==19 {
                    // The preceding short gate is already off: CC84 still
                    // forces glide, but cannot select a Held-source Mono path.
                    assert!(p.voices[i].glide_enabled);
                    assert_eq!(p.voices[i].glide.initial_cents,-300);
                    assert!(!s.mono);
                }
            }
        }
    }
    #[test]
    fn new_patterns_use_existing_single_dual_split_routing() {
        for pattern in [21,39] {for mode in 0..3 {for destination in 0..3 {for panel in 0..2 {
            let mut p=fixture(pattern,mode,destination,panel);
            p.midi(0x92,57,71).unwrap();p.midi(0x92,67,93).unwrap();through(&mut p,1);
            let mut owners:Vec<_>=p.slots.iter().filter(|s|s.status==Status::Held&&s.note==57).map(|s|s.owner).collect();owners.sort();
            assert_eq!(owners,match mode {0=>vec![panel as u8],1=>vec![0,1],_=>vec![1]});
            assert!(p.slots.iter().filter(|s|s.status==Status::Held).all(|s|s.origin==0&&s.channel==16));
            // Direct receive-channel notes remain immediate and source1.
            p.midi(0x90,72,100).unwrap();
            assert_eq!(p.parts[0].held[1][72],1);
            if mode!=0 || panel==0 {assert!(p.slots.iter().any(|s|s.status==Status::Held&&s.owner==0&&s.origin==1&&s.note==72));}
        }}}}
    }
    #[test]
    fn new_admission_does_not_mask_other_atomic_guards() {
        for pattern in [21,39] {
            let mut a=fixture(pattern,0,0,0);let mut b=fixture(pattern,0,0,0);
            a.midi(0x92,60,100).unwrap();b.midi(0x92,60,100).unwrap();
            for (id,value) in [(2024,4),(2025,52),(2028,12),(2029,1)] {
                let before=format!("{:?}",a.arp);
                assert!(a.apply_performance(&[41],&[22],&[51],&[1],&[2025,id],&[pattern,value]).is_err());
                assert_eq!(a.parts[0].params,b.parts[0].params);assert_eq!(a.parts[1].params,b.parts[1].params);
                assert_eq!(a.common.performance,b.common.performance);assert_eq!(format!("{:?}",a.arp),before);
                for _ in 0..2048 {assert_eq!(a.next_stereo_sample(),b.next_stereo_sample());}
            }
        }
    }
    #[test]
    fn new_pattern_switches_are_partition_invariant_and_reset_clears_latches() {
        let mut expected=None;
        for block in [1,7,64,257] {
            let mut p=fixture(21,1,0,0);for n in [60,64,67] {p.remote_touch(0x90,n,100).unwrap();}
            let mut output=Vec::new();let mut l=[0.0;257];let mut r=[0.0;257];
            for pattern in [21,39,11,21,39] {
                p.set_parameter(2025,pattern).unwrap();let mut remaining=12288;
                while remaining>0 {let n=remaining.min(block);p.render_stereo(&mut l[..n],&mut r[..n]).unwrap();
                    output.extend(l[..n].iter().zip(&r[..n]).map(|(a,b)|(a.to_bits(),b.to_bits())));remaining-=n;}
            }
            if let Some(ref reference)=expected {assert_eq!(&output,reference);}else{expected=Some(output);}
            p.reset();assert!(!p.arp.occupied());assert!(p.parts.iter().all(|s|s.forced_portamento_source.is_none()));
            assert_eq!(p.parameter(2025),Some(39));p.remote_touch(0x90,60,100).unwrap();through(&mut p,1);
            assert_eq!(p.held_voice_count(),2);
        }
    }
}

#[cfg(test)]
mod pattern51_natural_api_tests {
    use super::*;
    fn fixture()->Jp8000Instrument {
        let mut p=Jp8000Instrument::new();
        p.apply_performance(&[30,31,51,54,55,56,57,69,70,71,72,283],
            &[5,0,127,0,0,127,0,0,40,0,0,1],&[],&[],
            &[2016,2018,2021,2023,2024,2025,2026,2034,3009],
            &[0,0,0,1,0,51,0,250,2]).unwrap();p
    }
    fn through(p:&mut Jp8000Instrument,pulse:u32){
        while p.tempo_clock.pulses()<pulse {p.next_stereo_sample();}
    }
    fn held(p:&Jp8000Instrument,note:u8,velocity:u8){
        let slots:Vec<_>=p.slots.iter().enumerate().filter(|(_,s)|s.status==Status::Held).collect();
        assert_eq!(slots.len(),1);
        let (index,slot)=slots[0];
        assert_eq!((slot.owner,slot.origin,slot.channel,slot.note),(0,0,16,note));
        assert_eq!(p.voices[index].velocity_code,super::super::control::velocity_code(velocity));
        assert_eq!(p.parts[0].forced_portamento_source,None);
    }
    #[test]
    fn pattern51_public_performance_and_remote_midi_reach_actual_voice_gates_and_accents(){
        let mut p=fixture();
        assert_eq!(mdlr_jp8000_rust_parameter_value_capability(2025,51),1);
        assert_eq!(p.parameter(2025),Some(51));
        p.midi(0x92,60,127).unwrap();
        through(&mut p,1);held(&p,60,127);
        through(&mut p,12);assert_eq!(p.held_voice_count(),0);
        through(&mut p,17);held(&p,60,112);
        through(&mut p,23);assert_eq!(p.held_voice_count(),0);
        through(&mut p,25);held(&p,60,102);
        through(&mut p,30);assert_eq!(p.held_voice_count(),0);
    }
    #[test]
    fn pattern51_public_repeat_uses_marker_and_other_rejections_remain_atomic(){
        let mut p=fixture();p.midi(0x92,60,127).unwrap();through(&mut p,18);
        p.set_parameter(2025,51).unwrap();
        through(&mut p,24);assert_eq!(p.held_voice_count(),0);
        through(&mut p,25);held(&p,60,127); // reload's first accent, not ordinary index 2
        for (id,value) in [(2025,52),(2024,4),(2028,12),(2029,1)]{
            let before=format!("{:?}",p.arp);let cutoff=p.parameter(41);
            assert!(p.apply_performance(&[41],&[22],&[],&[],&[id],&[value]).is_err());
            assert_eq!(p.parameter(41),cutoff);assert_eq!(format!("{:?}",p.arp),before);
            assert_eq!(p.parameter(2025),Some(51));
        }
    }
}

#[cfg(test)]
mod pedal11_midi_domain_tests {
    use super::*;

    fn fixture() -> Jp8000Instrument {
        let mut p = Jp8000Instrument::new();
        p.apply_performance(&[1002, 29, 30, 51], &[0, 64, 5, 100],
            &[1002, 29, 30, 51], &[1, 64, 4, 100],
            &[2016, 2018, 2025, 3009], &[1, 0, 4, 2]).unwrap();
        p
    }
    fn expressions(p: &Jp8000Instrument) -> [u8; 2] {
        [p.parts[0].expression, p.parts[1].expression]
    }

    #[test]
    fn no_touch_selector_leaves_patch_and_key_ownership_unchanged() {
        let mut p = fixture();
        p.midi(0x90, 60, 100).unwrap(); p.midi(0x91, 67, 100).unwrap();
        let params = [p.parts[0].params, p.parts[1].params];
        let owned: Vec<_> = p.slots.iter().map(|s| (s.owner, s.origin, s.note, s.status)).collect();
        for value in [11, 11, 3, 3, 11] {
            p.set_parameter(2028, value).unwrap();
            assert_eq!(p.parameter(2028), Some(value));
            assert_eq!([p.parts[0].params, p.parts[1].params], params);
            assert_eq!(p.slots.iter().map(|s| (s.owner, s.origin, s.note, s.status)).collect::<Vec<_>>(), owned);
            assert_eq!(p.parts[0].held[1][60], 1); assert_eq!(p.parts[1].held[1][67], 1);
            assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
        }
    }

    #[test]
    fn remote_cc11_and_reset_preserve_direct_expression_under_assignment11() {
        for mode in 0..3 { for panel in 0..3 {
            let mut p = fixture();
            p.apply_performance(&[], &[], &[], &[], &[2016, 2018, 2028], &[mode, panel, 11]).unwrap();
            p.midi(0xb0, 11, 64).unwrap(); p.midi(0xb1, 11, 96).unwrap();
            for value in [0, 64, 127, 32] {
                p.midi(0xb2, 11, value).unwrap();
                assert_eq!(expressions(&p), [64, 96]);
                assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
                assert_eq!(p.part_parameter(0, 29), Some(64));
                assert_eq!(p.part_parameter(1, 29), Some(64));
            }
            p.midi(0xb2, 121, 0).unwrap();
            assert_eq!(expressions(&p), [64, 96]);
            assert_eq!(p.part_parameter(0, 29), Some(64));
            assert_eq!(p.part_parameter(1, 29), Some(64));
        }}
    }

    #[test]
    fn equal_assignment3_preserves_active_expression_and_direct_overrides() {
        let mut p = fixture();
        p.midi(0xb2, 11, 18).unwrap();
        p.midi(0xb0, 11, 32).unwrap(); p.midi(0xb1, 11, 96).unwrap();
        assert_eq!((p.remote_expression, p.remote_expression_active), (18, 3));
        p.set_parameter(2028, 3).unwrap();
        assert_eq!(expressions(&p), [32, 96]);
        assert_eq!((p.remote_expression, p.remote_expression_active), (18, 3));
        p.midi(0xb2, 11, 127).unwrap();
        assert_eq!(expressions(&p), [127, 127]);
        assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
    }

    #[test]
    fn assignment_domain_change_rejection_is_atomic_until_expression_is_default() {
        let mut a = fixture(); let mut b = fixture();
        for p in [&mut a, &mut b] {
            p.midi(0x90, 60, 100).unwrap(); p.midi(0x91, 67, 100).unwrap();
            p.midi(0xb2, 11, 64).unwrap();
        }
        assert!(a.apply_performance(&[29], &[17], &[51], &[1], &[2028, 2026], &[11, 2]).is_err());
        assert_eq!(a.common.performance, b.common.performance);
        assert_eq!([a.parts[0].params, a.parts[1].params], [b.parts[0].params, b.parts[1].params]);
        assert_eq!((a.remote_expression, a.remote_expression_active), (64, 3));
        assert_eq!(expressions(&a), expressions(&b));
        for _ in 0..4096 { assert_eq!(a.next_stereo_sample(), b.next_stereo_sample()); }
        a.midi(0xb2, 11, 127).unwrap();
        a.midi(0xb0, 11, 32).unwrap(); a.midi(0xb1, 11, 96).unwrap();
        a.set_parameter(2028, 11).unwrap();
        assert_eq!(expressions(&a), [32, 96]);
        assert_eq!((a.remote_expression, a.remote_expression_active), (127, 0));
    }

    #[test]
    fn clean_return_to_assignment3_uses_new_remote_events() {
        let mut p = fixture(); p.set_parameter(2028, 11).unwrap();
        p.midi(0xb2, 11, 0).unwrap();
        p.midi(0xb0, 11, 32).unwrap(); p.midi(0xb1, 11, 96).unwrap();
        p.set_parameter(2028, 3).unwrap();
        assert_eq!(expressions(&p), [32, 96]);
        assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
        p.midi(0xb2, 11, 64).unwrap();
        assert_eq!(expressions(&p), [64, 64]);
        p.reset();
        assert_eq!(p.parameter(2028), Some(3));
        assert_eq!((p.remote_expression, p.remote_expression_active), (127, 0));
    }

    #[test]
    fn pedal_capability_stays_partial_and_other_feature_guards_stay_closed() {
        let mut p = fixture(); p.set_parameter(2023, 1).unwrap();
        for (id, value) in [(2028, 0), (2028, 1), (2028, 2), (2028, 4),
                            (2028, 12), (2028, 44), (2028, 45), (2029, 1), (2024, 4), (2025, 52)] {
            assert!(p.set_parameter(id, value).is_err());
        }
        assert_eq!(mdlr_jp8000_rust_parameter_capability(2028), 2);
        for value in [3, 11] {
            assert_eq!(Jp8000Instrument::parameter_value_capability(2028, value), 2);
            p.set_parameter(2028, value).unwrap();
        }
        for value in [0, 1, 2, 4, 12, 44, 45] {
            assert_eq!(Jp8000Instrument::parameter_value_capability(2028, value), 0);
        }
    }
}
