//! Handwritten formulas for Arp patterns 4, 5, 11, 13, 21 and 39.
//! Pattern 51 uses the documented semantic articulation in its child provider.
//! No packed ROM pattern records are included.
//! Input transitions and pulse dispatch are separate: native deferred start/stop
//! states0/1/2/3 are preserved, without emulating UART or MCU processing delay.
// Shared by final-state validation and the host value-capability query.
// Other patterns, RPS and Individual Trigger retain their separate guards.
pub(super) fn supports_mode(raw: u16) -> bool { raw <= 3 }
pub(super) fn supports_pattern(raw: u16) -> bool { matches!(raw, 4 | 5 | 11 | 13 | 21 | 39 | 51) }


// Original scalar records validated against native record fields and ordered
// scheduler traces. No vendor pattern arrays or captured state are included.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PatternStep {
    interval: u16,
    gate: u16,
    accent: u8,
    marker: bool,
    portamento: bool,
    next_index: u8,
}
#[path = "jp8000_arp_pattern51.rs"]
mod pattern51;

fn b5_interval(pulse: u8) -> u8 {
    let beat = pulse / 24;
    let within = pulse % 24;
    if (beat >= 2 && within < 12) || (beat % 3 == 0 && within >= 12) { 6 } else { 12 }
}
fn pattern_step(pattern: u8, index: u8) -> PatternStep {
    let (interval, gate, accent, marker, portamento, next_index) = match pattern {
        4 => (6, 5, if index == 0 {127} else {100}, index == 0, false, (index + 1) & 3),
        5 => (3, 2, if index == 0 {127} else {100}, index == 0, false, (index + 1) & 7),
        11 => {
            let tail = index >= 3;
            let rem = index % 3;
            (6, if tail && rem == 0 {7} else if tail && rem == 1 {5} else {2},
             127, index % 4 == 0, tail && rem == 1, (index + 1) & 7)
        }
        13 => (6, if index == 3 {4} else {7}, 127, index == 0, true, (index + 1) & 3),
        21 => {
            assert!(index < 12);
            // Walk the twelve-event musical subdivision, never stored records.
            // This bounded control-rate loop does not run per audio sample.
            let mut pulse = 0_u8;
            for _ in 0..index { pulse += b5_interval(pulse); }
            let beat = pulse / 24;
            let within = pulse % 24;
            let gate = if beat == 2 || (beat == 0 && within >= 12) {3} else {2};
            let accent = if beat < 2 { if within == 12 {127} else {111} }
                else if beat == 2 {127 - ((11 * within as u16 + 11) / 12) as u8}
                else {127};
            (b5_interval(pulse) as u16, gate, accent, within == 0, index % 4 == 2,
             if index == 11 {0} else {index + 1})
        }
        39 => {
            assert!(index < 17);
            // Sixteenths with the second subdivision split into two 32nds.
            let pulse = if index == 0 {0} else if index == 1 {6}
                else if index == 2 {9} else {6 * (index - 1)};
            let interval = if index == 1 || index == 2 {3} else {6};
            let accent = if pulse % 24 == 0 || (pulse < 18 && pulse % 6 == 0) {127} else {100};
            (interval, 1, accent, pulse % 24 == 0, false,
             if index == 16 {0} else {index + 1})
        }
        51 => return pattern51::step(index),
        _ => unreachable!("unsupported active pattern bypassed Instrument validation"),
    };
    PatternStep { interval, gate, accent, marker, portamento, next_index }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Event {
    pub on: bool,
    pub portamento: bool,
    pub note: u8,
    pub velocity: u8,
    pub pulse: u16,
}
#[derive(Clone, Copy, Debug)]
pub(super) struct Events {
    pub items: [Event; 10],
    pub len: usize,
}
impl Events {
    fn new() -> Self {
        Self {
            items: [Event::default(); 10],
            len: 0,
        }
    }
    fn push(&mut self, e: Event) {
        assert!(self.len < self.items.len());
        self.items[self.len] = e;
        self.len += 1;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn chord(mode: u8, range: u8) -> Arpeggiator {
        let mut a = Arpeggiator::default();
        a.mode_write(mode);
        a.range_write(range);
        a.switch_write(true);
        for (n, v) in [(67, 71), (60, 93), (64, 117)] {
            a.note(n, v, true);
        }
        a
    }
    fn notes(a: &mut Arpeggiator, count: u32) -> Vec<Event> {
        let mut result = vec![];
        for p in 1..=count {
            let es = a.pulse(p);
            result.extend(es.items[..es.len].iter().copied().filter(|e| e.on));
        }
        result
    }
    #[test]
    fn ordered_chords_accent_and_gate_are_integer_pulses() {
        let mut a = chord(0, 0);
        let es = notes(&mut a, 19);
        assert_eq!(
            es.iter()
                .map(|e| (e.pulse, e.note, e.velocity))
                .collect::<Vec<_>>(),
            [(1, 60, 93), (7, 64, 92), (13, 67, 55), (19, 60, 73)]
        );
        let off = a.pulse(24);
        assert_eq!(
            &off.items[..off.len],
            &[Event {
                portamento: false, on: false,
                note: 60,
                velocity: 80,
                pulse: 24
            }]
        );
        let mut down = chord(1, 1);
        assert_eq!(
            notes(&mut down, 31)
                .iter()
                .map(|e| e.note)
                .collect::<Vec<_>>(),
            [72, 67, 64, 60, 79, 76]
        );
        let mut both = chord(2, 0);
        assert_eq!(
            notes(&mut both, 31)
                .iter()
                .map(|e| e.note)
                .collect::<Vec<_>>(),
            [60, 64, 67, 64, 60, 64]
        );
    }
    #[test]
    fn pending_stop_retrigger_preserves_cursor_but_consumed_stop_restarts() {
        let mut a = Arpeggiator::default();
        a.switch_write(true);
        a.note(60, 100, true);
        a.pulse(1);
        a.note(60, 64, false);
        a.note(67, 90, true);
        assert_eq!(a.state, 2);
        assert_eq!(a.pulse(2).len, 0);
        for pulse in 3..=6 {
            a.pulse(pulse);
        }
        let event = a.pulse(7);
        assert_eq!(
            &event.items[..event.len],
            &[Event {
                portamento: false, on: true,
                note: 67,
                velocity: 70,
                pulse: 7
            }]
        );
        a.note(67, 64, false);
        a.pulse(8);
        assert_eq!(a.state, 0);
        a.note(64, 80, true);
        let e = a.pulse(9);
        assert!(e.items[e.len - 1].on);
        assert_eq!(e.items[e.len - 1].note, 64);
    }
    #[test]
    fn hold_replacement_preserves_cursor_and_duplicates_keep_first_velocity() {
        let mut a = chord(0, 0);
        a.set_hold(true);
        notes(&mut a, 7);
        for n in [60, 64, 67] {
            a.note(n, 64, false);
        }
        for (n, v) in [(62, 71), (65, 93), (69, 117)] {
            a.note(n, v, true);
        }
        a.note(65, 1, true);
        let e = a.pulse(13);
        assert_eq!(
            (e.items[e.len - 1].note, e.items[e.len - 1].velocity),
            (65, 73)
        );
        a.set_pedal(true);
        a.set_hold(false);
        for n in [62, 65, 69] {
            a.note(n, 64, false);
        }
        assert!(a.any_latched());
        a.set_pedal(false);
        a.pulse(14);
        assert!(!a.occupied());
    }
    #[test]
    fn same_on_preserves_and_same_pattern_restarts_notes_without_immediate_accent_reset() {
        let mut a = chord(0, 0);
        a.pulse(1);
        a.switch_write(true);
        let e = a.pulse(7);
        assert_eq!(e.items[e.len - 1].note, 64);
        a.pattern_write(4);
        let e = a.pulse(13);
        assert_eq!(
            (e.items[e.len - 1].note, e.items[e.len - 1].velocity),
            (60, 73)
        );
    }
    #[test]
    fn byte_cursor_endpoint_and_sixteen_bit_clock_wrap_are_preserved() {
        let mut a = Arpeggiator::default();
        a.range_write(3);
        a.switch_write(true);
        a.note(0, 100, true);
        let e = a.pulse(65535);
        assert_eq!(
            (e.items[e.len - 1].note, e.items[e.len - 1].pulse),
            (12, 65535)
        );
        let e = a.pulse(65540);
        assert_eq!((e.items[0].on, e.items[0].pulse), (false, 4));
        let e = a.pulse(65541);
        assert_eq!(
            (e.items[0].on, e.items[0].note, e.items[0].pulse),
            (true, 24, 5)
        );
    }
    #[test]
    fn maximum_keyset_and_dense_edits_never_exceed_fixed_event_capacity() {
        let mut a = Arpeggiator::default();
        a.range_write(3);
        a.switch_write(true);
        for n in 0..128 {
            a.note(n, 127, true);
        }
        for pulse in 1..10000 {
            if pulse % 17 == 0 {
                a.mode_write((pulse % 3) as u8);
                a.range_write((pulse % 4) as u8);
            }
            let e = a.pulse(pulse);
            assert!(e.len <= 9);
        }
        for note in 0..128 {
            a.note(note, 80, false);
        }
        let e = a.pulse(10000);
        assert!(e.items[..e.len].iter().all(|e| !e.on));
        assert!(!a.occupied());
    }
}
#[derive(Clone, Copy, Debug, Default)]
struct Gate {
    note: u8,
    due: u16,
    active: bool,
}
#[cfg_attr(test, derive(Clone, Debug))]
pub(super) struct Arpeggiator {
    physical: [u8; 128],
    latched: [u8; 128],
    gates: [Gate; 8],
    enabled: bool,
    hold: bool,
    pedal: bool,
    mode: u8,
    range: u8,
    state: u8,
    note_cursor: u8,
    octave: i16,
    direction: i16,
    next_due: u16,
    pattern_index: u8,
    // Stable native 0x209f39 identifies the next record examined at a due
    // preparation. The transient count value before 0x1e924 wrap is not stored.
    requested_pattern: u8,
    loaded_pattern: u8,
    pending_full: bool,
    last_pulse: u16,
    random_state: u16,
    last_generated_note: Option<u8>,
}
impl Default for Arpeggiator {
    fn default() -> Self {
        Self {
            physical: [0; 128],
            latched: [0; 128],
            gates: [Gate::default(); 8],
            enabled: false,
            hold: false,
            pedal: false,
            mode: 0,
            range: 0,
            state: 0,
            note_cursor: 254,
            octave: 0,
            direction: 1,
            next_due: 0,
            pattern_index: 0,
            requested_pattern: 4,
            loaded_pattern: 4,
            pending_full: false,
            last_pulse: 0,
            random_state: 0x7ab7,
            last_generated_note: None,
        }
    }
}
impl Arpeggiator {
    pub(super) fn occupied(&self) -> bool {
        self.latched.iter().any(|&v| v != 0) || self.gates.iter().any(|g| g.active)
    }
    fn any_physical(&self) -> bool {
        self.physical.iter().any(|&v| v != 0)
    }
    fn any_latched(&self) -> bool {
        self.latched.iter().any(|&v| v != 0)
    }
    fn request_stop_if_empty(&mut self) {
        if !self.any_latched() {
            self.state = match self.state {
                1 => 0,
                2 => 3,
                s => s,
            };
        }
    }
    pub(super) fn note(&mut self, note: u8, velocity: u8, on: bool) {
        if !self.enabled {
            return;
        }
        let n = note as usize;
        if on {
            if self.physical[n] != 0 {
                return;
            }
            let had_latched = self.any_latched();
            if had_latched && !self.any_physical() {
                self.latched.fill(0);
            }
            self.physical[n] = velocity.max(1);
            self.latched[n] = velocity.max(1);
            if !had_latched {
                self.state = match self.state {
                    0 => 1,
                    3 => 2,
                    s => s,
                };
            }
        } else {
            self.physical[n] = 0;
            if !self.hold && !self.pedal {
                self.latched[n] = 0;
            }
            self.request_stop_if_empty();
        }
    }
    pub(super) fn set_hold(&mut self, hold: bool) {
        self.hold = hold;
        self.release_unheld();
    }
    pub(super) fn set_pedal(&mut self, pedal: bool) {
        self.pedal = pedal;
        self.release_unheld();
    }
    fn release_unheld(&mut self) {
        if !self.hold && !self.pedal {
            self.latched = self.physical;
            self.request_stop_if_empty();
        }
    }
    fn reset_order(&mut self) {
        let low = self
            .latched
            .iter()
            .position(|&v| v != 0)
            .map_or(255, |n| n as u8);
        self.direction = if self.mode == 1 { -1 } else { 1 };
        self.octave = if self.mode == 1 { self.range as i16 } else { 0 };
        // Native byte wrap is observable at the lowest MIDI endpoint.
        self.note_cursor = if self.mode == 1 {
            low.wrapping_add(1)
        } else {
            low.wrapping_sub(1)
        };
        // H8 0x1f7ac resets note order only. Mode and pattern setters must not
        // restart the independent loaded-record/accent position.
    }
    pub(super) fn mode_write(&mut self, mode: u8) {
        assert!(mode <= 3);
        self.mode = mode;
        self.reset_order();
    }
    pub(super) fn pattern_write(&mut self, pattern: u16) {
        // Dormant values retain their identity; final-state validation prevents
        // enabling any unsupported pattern, so none is silently substituted.
        assert!(pattern <= 89);
        self.requested_pattern = pattern as u8;
        // H8 0x23916 -> 0x1ec24 sets this even on a same-value selector write.
        // The current loaded record remains active until its marker is due.
        self.pending_full = true;
        self.reset_order();
    }
    pub(super) fn range_write(&mut self, range: u8) {
        assert!(range <= 3);
        self.range = range;
    }
    pub(super) fn switch_write(&mut self, enabled: bool) -> Events {
        let changed = enabled != self.enabled;
        self.enabled = enabled;
        let mut out = Events::new();
        if !enabled {
            self.flush(&mut out, self.last_pulse);
            self.physical.fill(0);
            self.latched.fill(0);
            self.state = 0;
        }
        if changed && enabled {
            self.state = 0;
        }
        out
    }
    fn flush(&mut self, out: &mut Events, pulse: u16) {
        for g in &mut self.gates {
            if g.active {
                out.push(Event {
                portamento: false, on: false,
                    note: g.note,
                    velocity: 80,
                    pulse,
                });
                g.active = false;
            }
        }
    }
    // H8 0x203be..0x20424 prepares two octave/rank pairs for every due
    // pattern event. NORMAL 1/16 and 1/32 consume only the first pair;
    // advancing all four draws also preserves later Up/Down -> Random changes.
    fn random_pair(&mut self) -> (u8, u8) {
        let mut draws = [0u8; 4];
        for draw in &mut draws {
            self.random_state = self.random_state.wrapping_mul(0x497d).wrapping_add(1);
            *draw = (self.random_state >> 8) as u8;
        }
        (draws[0], draws[1])
    }
    fn step_note(&mut self, random: (u8, u8)) -> (u8, u8) {
        let low = self.latched.iter().position(|&v| v != 0).unwrap() as i16;
        let high = self.latched.iter().rposition(|&v| v != 0).unwrap() as i16;
        let (mut note, mut octave) = (self.note_cursor as i16, self.octave);
        if self.mode == 3 {
            let count = self.latched.iter().filter(|&&v| v != 0).count();
            let rank = random.1 as usize % count;
            note = self.latched.iter().enumerate().filter(|(_, &v)| v != 0)
                .nth(rank).unwrap().0 as i16;
            octave = (random.0 % (self.range + 1)) as i16;
            // H8 0x1fabe: an identical input-key/octave pair advances exactly
            // one ascending held key. Compare before MIDI endpoint folding.
            if note == self.note_cursor as i16 && octave == self.octave {
                if let Some(next) = ((note + 1) as usize..128).find(|&n| self.latched[n] != 0) {
                    note = next as i16;
                } else {
                    note = low;
                    octave += 1;
                    if octave > self.range as i16 { octave = 0; }
                }
            }
        } else if self.mode == 2 {
            let min = low;
            let max = self.range as i16 * 128 + high;
            let mut pos = octave * 128 | note;
            if min == max {
                pos = min;
            } else if pos < min {
                self.direction = 1;
                pos = min;
            } else if pos > max {
                self.direction = -1;
                pos = max;
            } else {
                if pos == min {
                    self.direction = 1;
                } else if pos == max {
                    self.direction = -1;
                }
                // At most128 pitches between two present keys, regardless of range.
                for _ in 0..128 {
                    pos += self.direction;
                    if self.latched[(pos & 127) as usize] != 0 {
                        break;
                    }
                }
            }
            note = pos & 127;
            octave = pos >> 7;
        } else {
            for _ in 0..129 {
                if self.mode == 0 {
                    note += 1;
                    if note > high {
                        note = low;
                        octave += 1;
                        if octave > self.range as i16 {
                            octave = 0;
                        }
                    }
                } else {
                    note -= 1;
                    if note < low {
                        note = high;
                        octave -= 1;
                        if octave < 0 {
                            octave = self.range as i16;
                        }
                    }
                }
                if self.latched[note as usize] != 0 {
                    break;
                }
            }
        }
        self.note_cursor = note as u8;
        self.octave = octave;
        let mut output = note + 12 * octave;
        while output > 127 {
            output -= 12;
        }
        while output < 0 {
            output += 12;
        }
        (output as u8, self.latched[note as usize])
    }
    pub(super) fn pulse(&mut self, pulse: u32) -> Events {
        let now = pulse as u16;
        self.last_pulse = now;
        let mut out = Events::new();
        if !self.enabled {
            return out;
        }
        if self.state == 3 {
            self.state = 0;
            self.flush(&mut out, now);
        }
        if self.state == 1 {
            self.state = 2;
            self.reset_order();
            // A new phrase separately resets the loaded-record position before
            // due preparation. A pending-stop retrigger does not take this path.
            self.pattern_index = 0;
            self.next_due = now;
        }
        for g in &mut self.gates {
            if g.active && now.wrapping_sub(g.due) as i16 >= 0 {
                out.push(Event {
                portamento: false, on: false,
                    note: g.note,
                    velocity: 80,
                    pulse: now,
                });
                g.active = false;
            }
        }
        if self.state != 2 || !self.any_latched() || (now.wrapping_sub(self.next_due) as i16) < 0 {
            return out;
        }
        // A pending request loads only at a due marker of the current record.
        let marker = pattern_step(self.loaded_pattern, self.pattern_index).marker;
        if self.pending_full && marker {
            self.loaded_pattern = self.requested_pattern;
            self.pending_full = false;
            self.pattern_index = 0;
            self.reset_order();
        }
        let step = pattern_step(self.loaded_pattern, self.pattern_index);
        let gate = step.gate;
        let portamento = step.portamento;
        let random = self.random_pair();
        let (note, velocity) = self.step_note(random);
        let velocity = ((velocity as u16 * step.accent as u16) / 127).max(1) as u8;
        let due = self.next_due;
        self.next_due = self.next_due.wrapping_add(step.interval);
        self.pattern_index = step.next_index;
        // 1f674 emits CC84 before scheduling, hence before any duplicate-note
        // off. last-generated-note survives phrase/switch-off and pattern edits;
        // only broad reset/default construction clears it.
        if portamento {
            if let Some(source) = self.last_generated_note {
                out.push(Event {
                on:false,portamento:true,note:source,velocity:0,pulse:due});
            }
        }
        // Same output note replaces its pending gate off-before-on. All other
        // paths have the firmware's fixed eight-slot capacity; no growing queue.
        let slot = if let Some(i) = self.gates.iter().position(|g| g.active && g.note == note) {
            out.push(Event {
                portamento: false, on: false,
                note,
                velocity: 80,
                pulse: now,
            });
            i
        } else if let Some(i) = self.gates.iter().position(|g| !g.active) {
            i
        } else {
            self.gates.copy_within(1..8, 0);
            7
        };
        self.gates[slot] = Gate {
            note,
            due: due.wrapping_add(gate),
            active: true,
        };
        out.push(Event {
                portamento: false, on: true,
            note,
            velocity,
            pulse: due,
        });
        self.last_generated_note = Some(note);
        out
    }
}

#[cfg(test)]
mod random_tests {
    use super::*;
    fn chord(mode: u8) -> Arpeggiator {
        let mut a = Arpeggiator::default();
        a.mode_write(mode); a.range_write(2); a.switch_write(true);
        for (note, velocity) in [(67,71),(60,93),(64,117)] { a.note(note,velocity,true); }
        a
    }
    #[test]
    fn native_cold_random_pattern4_sequence() {
        // Independently observed at native schedule_note; no fitted seed.
        let expected = [91,60,64,84,67,72,67,76,72,76,88,79,60,91,79,84];
        let mut a = chord(3);
        for (index,note) in expected.into_iter().enumerate() {
            let out=a.pulse((index*6) as u32);
            assert_eq!(out.items[..out.len].iter().find(|e|e.on).unwrap().note,note);
        }
    }
    #[test]
    fn nonrandom_history_advances_random_and_mode_write_preserves_it() {
        let mut a=chord(0);
        for i in 0..16 { a.pulse(i*6); }
        let state=a.random_state;
        a.mode_write(3); a.pattern_write(4); a.range_write(2);
        assert_eq!(a.random_state,state);
        for (i,note) in [67,64,91,88].into_iter().enumerate() {
            let out=a.pulse((i as u32+16)*6);
            assert_eq!(out.items[..out.len].iter().find(|e|e.on).unwrap().note,note);
        }
        let state=a.random_state;
        a.switch_write(false); a.switch_write(true);
        assert_eq!(a.random_state,state);
    }
    #[test]
    fn random_single_key_at_midi_limits_is_bounded() {
        for note in [0,127] {
            for range in 0..=3 {
                let mut a=Arpeggiator::default();
                a.mode_write(3);a.range_write(range);a.switch_write(true);a.note(note,100,true);
                for tick in 0..1024 {
                    let out=a.pulse(tick);
                    assert!(out.len<=9);
                    for e in &out.items[..out.len] {
                        assert!(e.note<=127);
                        assert_eq!(e.note%12,note%12);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod normal5_tests {
    use super::*;
    fn chord(pattern:u16,mode:u8,range:u8)->Arpeggiator {
        let mut a=Arpeggiator::default();a.pattern_write(pattern);a.mode_write(mode);a.range_write(range);a.switch_write(true);
        for (n,v) in [(67,71),(60,93),(64,117)] {a.note(n,v,true);}a
    }
    fn on(events:Events)->Event {events.items[..events.len].iter().copied().find(|e|e.on).unwrap()}
    #[test]
    fn formula_has_eight_steps_and_two_pulse_gates_without_order_reset_at_cycle() {
        let mut a=chord(5,0,0);let mut ons=vec![];let mut offs=vec![];
        for p in 1..=72 {let es=a.pulse(p);for e in &es.items[..es.len] {if e.on {ons.push(*e);} else {offs.push(*e);}}}
        assert_eq!((ons.len(),offs.len()),(24,24));
        for i in 0..24 {
            let (note,velocity)=[(60,93u16),(64,117),(67,71)][i%3];
            let expected_velocity=if i%8==0 {velocity}else{(velocity*100/127).max(1)} as u8;
            assert_eq!(ons[i],Event {
                portamento: false, on:true,note,velocity:expected_velocity,pulse:1+3*i as u16});
            assert_eq!(offs[i],Event {
                portamento: false, on:false,note,velocity:80,pulse:3+3*i as u16});
        }
        assert_eq!((ons[8].note,ons[8].velocity),(67,71));
        assert_eq!((ons[16].note,ons[16].velocity),(64,117));
    }
    #[test]
    fn pattern5_preserves_order_and_random_draws_of_pattern4_per_due_event() {
        for mode in 0..=3 {for range in 0..=3 {
            let mut a=chord(4,mode,range);let mut b=chord(5,mode,range);
            for i in 0..128 {
                let ea=on(a.pulse(1+6*i));let eb=on(b.pulse(1+3*i));assert_eq!(ea.note,eb.note);
                assert_eq!(a.random_state,b.random_state);
                if i%8==0||i%4!=0 {assert_eq!(ea.velocity,eb.velocity);}
            }
        }}
    }
    #[test]
    fn dense_timing_wraps_clock_and_keeps_fixed_capacity() {
        let mut a=Arpeggiator::default();a.pattern_write(5);a.switch_write(true);a.note(60,1,true);
        assert_eq!(on(a.pulse(65534)),Event {
                portamento: false, on:true,note:60,velocity:1,pulse:65534});
        assert_eq!(a.pulse(65536).items[0],Event {
                portamento: false, on:false,note:60,velocity:80,pulse:0});
        assert_eq!(on(a.pulse(65537)),Event {
                portamento: false, on:true,note:60,velocity:1,pulse:1});
        for note in 0..128 {a.note(note,127,true);}
        for pulse in 65538..70000 {
            if pulse%17==0 {a.mode_write((pulse%4) as u8);a.range_write((pulse%4) as u8);}
            let e=a.pulse(pulse);assert!(e.len<=9);
        }
    }
    #[test]
    fn hold_duplicate_sustain_and_pending_stop_semantics_are_unchanged() {
        let mut a=chord(5,0,0);a.set_hold(true);on(a.pulse(1));on(a.pulse(4));
        for note in [60,64,67] {a.note(note,64,false);}
        for (note,velocity) in [(62,71),(65,93),(69,117)] {a.note(note,velocity,true);}
        a.note(65,1,true);assert_eq!((on(a.pulse(7)).note,a.physical[65]),(65,93));
        a.set_pedal(true);a.set_hold(false);for note in [62,65,69] {a.note(note,64,false);}
        assert!(a.any_latched());a.set_pedal(false);a.note(72,90,true);
        assert_eq!(a.state,2);assert_eq!(on(a.pulse(10)).note,72);
        a.note(72,64,false);a.pulse(11);assert_eq!(a.state,0);
        a.note(67,80,true);assert_eq!(on(a.pulse(12)).velocity,80);
    }
}

#[cfg(test)]
mod pending_loader_tests {
    use super::*;

    fn chord(pattern: u16) -> Arpeggiator {
        let mut a = Arpeggiator::default();
        a.pattern_write(pattern);
        a.mode_write(0);
        a.switch_write(true);
        for (note, velocity) in [(60, 93), (64, 117), (67, 71)] {
            a.note(note, velocity, true);
        }
        a
    }
    fn collect(a: &mut Arpeggiator, first: u32, last: u32) -> Vec<Event> {
        let mut events = Vec::new();
        for tick in first..=last {
            let out = a.pulse(tick);
            events.extend_from_slice(&out.items[..out.len]);
        }
        events
    }
    fn ons(events: &[Event]) -> Vec<(u16, u8, u8)> {
        events.iter().filter(|e| e.on).map(|e| (e.pulse, e.note, e.velocity)).collect()
    }

    #[test]
    fn four_to_five_waits_for_the_old_marker_and_keeps_old_gates() {
        let mut a = chord(4);
        assert_eq!(ons(&collect(&mut a, 100, 100)), [(100, 60, 93)]);
        a.pattern_write(5);
        assert_eq!((a.requested_pattern, a.loaded_pattern, a.pending_full), (5, 4, true));
        assert_eq!((a.pattern_index, a.next_due), (1, 106));
        let events = collect(&mut a, 101, 124);
        assert_eq!(ons(&events), [(106, 60, 73), (112, 64, 92), (118, 67, 55), (124, 60, 93)]);
        assert_eq!(events.iter().filter(|e| !e.on).map(|e| e.pulse).collect::<Vec<_>>(), [105, 111, 117, 123]);
        assert_eq!((a.loaded_pattern, a.pending_full, a.pattern_index, a.next_due), (5, false, 1, 127));
        assert_eq!(collect(&mut a, 125, 126), [Event {
                portamento: false, on: false, note: 60, velocity: 80, pulse: 126 }]);
    }

    #[test]
    fn five_to_four_finishes_the_old_eight_step_cycle() {
        let mut a = chord(5);
        collect(&mut a, 100, 100);
        a.pattern_write(4);
        let events = collect(&mut a, 101, 130);
        assert_eq!(ons(&events).iter().map(|e| e.0).collect::<Vec<_>>(), [103, 106, 109, 112, 115, 118, 121, 124, 130]);
        assert_eq!(ons(&events)[0], (103, 60, 73));
        assert_eq!(ons(&events)[7], (124, 60, 93));
        assert_eq!(events.iter().filter(|e| !e.on).map(|e| e.pulse).collect::<Vec<_>>(), [102, 105, 108, 111, 114, 117, 120, 123, 129]);
        assert_eq!((a.loaded_pattern, a.pending_full, a.next_due), (4, false, 136));
    }

    #[test]
    fn request_at_wrapped_index_zero_still_waits_until_next_due() {
        let mut a = chord(4);
        collect(&mut a, 100, 119);
        // The last emitted record was index 3 at118. Stable index0 names the
        // next record, whose due time is124, not a record already being emitted.
        assert_eq!((a.pattern_index, a.next_due, a.last_pulse), (0, 124, 119));
        a.pattern_write(5);
        collect(&mut a, 120, 123);
        assert_eq!((a.loaded_pattern, a.pending_full, a.pattern_index), (4, true, 0));
        assert_eq!(ons(&collect(&mut a, 124, 124)), [(124, 60, 93)]);
        assert_eq!((a.loaded_pattern, a.pending_full, a.next_due), (5, false, 127));
    }

    #[test]
    fn same_pattern_request_restarts_notes_now_and_again_at_reload_not_accents_now() {
        let mut a = chord(5);
        collect(&mut a, 100, 106);
        assert_eq!(a.pattern_index, 3);
        a.pattern_write(5);
        assert_eq!((a.pattern_index, a.pending_full), (3, true));
        let events = collect(&mut a, 107, 124);
        assert_eq!(ons(&events), [(109, 60, 73), (112, 64, 92), (115, 67, 55), (118, 60, 73), (121, 64, 92), (124, 60, 93)]);
        assert!(!a.pending_full);
    }

    #[test]
    fn mode_edits_do_not_reset_the_loaded_index_or_request_a_reload() {
        let mut a = chord(5);
        collect(&mut a, 100, 103);
        let before = (a.pattern_index, a.next_due, a.random_state, a.loaded_pattern, a.pending_full);
        a.mode_write(0);
        assert_eq!((a.pattern_index, a.next_due, a.random_state, a.loaded_pattern, a.pending_full), before);
        assert_eq!(ons(&collect(&mut a, 104, 106)), [(106, 60, 73)]);
        let before = (a.pattern_index, a.next_due, a.random_state, a.pending_full);
        a.mode_write(3);
        assert_eq!((a.pattern_index, a.next_due, a.random_state, a.pending_full), before);
        let event = ons(&collect(&mut a, 107, 109))[0];
        let base = match event.1 { 60 => 93, 64 => 117, 67 => 71, _ => unreachable!() };
        assert_eq!(event.2, (base * 100 / 127) as u8);
    }

    #[test]
    fn range_only_changes_preserve_order_loaded_position_and_pending_request() {
        let mut a = chord(4);
        collect(&mut a, 100, 106);
        a.pattern_write(5);
        let before = (a.note_cursor, a.octave, a.direction, a.pattern_index, a.next_due, a.random_state, a.pending_full);
        a.range_write(1);
        a.range_write(1);
        assert_eq!((a.note_cursor, a.octave, a.direction, a.pattern_index, a.next_due, a.random_state, a.pending_full), before);
        assert_eq!(a.range, 1);
    }

    #[test]
    fn marker_without_pending_request_continues_note_order() {
        let mut a = chord(4);
        let events = collect(&mut a, 100, 124);
        assert_eq!(ons(&events), [(100, 60, 93), (106, 64, 92), (112, 67, 55), (118, 60, 73), (124, 64, 117)]);
        assert!(!a.pending_full);
    }

    #[test]
    fn new_phrase_consumes_pending_loader_but_stop_preserves_rng() {
        let mut a = chord(5);
        assert_eq!((a.loaded_pattern, a.pending_full), (4, true));
        collect(&mut a, 100, 100);
        let rng = a.random_state;
        a.pattern_write(4);
        a.switch_write(false);
        collect(&mut a, 101, 111);
        assert_eq!((a.loaded_pattern, a.pending_full, a.random_state), (5, true, rng));
        a.switch_write(true);
        a.note(67, 71, true);
        assert_eq!(ons(&collect(&mut a, 112, 112)), [(112, 67, 71)]);
        assert_eq!((a.loaded_pattern, a.pending_full, a.pattern_index), (4, false, 1));
    }

    #[test]
    fn pending_request_uses_the_latest_selector_without_extra_draws() {
        let mut a = chord(4);
        let mut expected_rng = 0x7ab7u16;
        for tick in 100..=150 {
            if tick == 102 { a.pattern_write(5); }
            if tick == 104 { a.pattern_write(4); }
            if tick == 109 { a.mode_write(3); }
            let out = a.pulse(tick);
            for _ in out.items[..out.len].iter().filter(|e| e.on) {
                for _ in 0..4 { expected_rng = expected_rng.wrapping_mul(0x497d).wrapping_add(1); }
            }
            assert_eq!(a.random_state, expected_rng);
            assert_eq!(a.loaded_pattern, 4);
        }
        assert!(!a.pending_full);
    }
}

#[cfg(test)]
mod portamento_pattern_tests {
 use super::*;
 fn active(pattern:u16)->Arpeggiator {
  let mut a=Arpeggiator::default();a.pattern_write(pattern);a.switch_write(true);
  a.note(60,100,true);a.note(64,80,true);a
 }
 #[test] fn a8_overlap_and_duplicate_off_follow_source_event_order(){
  let mut a=active(13);let first=a.pulse(0);assert_eq!(first.len,1);assert!(first.items[0].on);
  let next=a.pulse(6);assert_eq!(next.len,2);assert!(next.items[0].portamento);assert_eq!(next.items[0].note,60);assert!(next.items[1].on);
  let off=a.pulse(7);assert_eq!(off.len,1);assert!(!off.items[0].on&&!off.items[0].portamento);
  let mut a=Arpeggiator::default();a.pattern_write(13);a.switch_write(true);a.note(60,100,true);a.pulse(0);
  let next=a.pulse(6);assert_eq!(next.len,3);assert!(next.items[0].portamento);assert!(!next.items[1].on&&!next.items[1].portamento);assert!(next.items[2].on);
 }
 #[test] fn a6_formula_gate_accent_and_marker_are_original_integer_rules(){
  let mut a=active(11);
  for (i,gate) in [2,2,2,7,5,2,7,5].into_iter().enumerate(){
   let due=(i*6)as u32;let o=a.pulse(due);let on=o.items[..o.len].iter().find(|e|e.on).unwrap();
   assert_eq!(on.velocity,if i%2==0{100}else{80});assert_eq!(a.gates.iter().find(|g|g.active&&g.note==on.note).unwrap().due,due as u16+gate);
   assert_eq!(o.items[..o.len].iter().filter(|e|e.portamento).count(),usize::from(i==4||i==7));
  }
  let mut a=active(11);for i in 0..4{a.pulse(i*6);}assert_eq!(a.pattern_index,4);
  a.pattern_write(5);a.pulse(23);assert_eq!(a.loaded_pattern,11);let o=a.pulse(24);assert_eq!(a.loaded_pattern,5);assert_eq!(a.next_due,27);assert!(!o.items[..o.len].iter().any(|e|e.portamento));
 }
 #[test] fn last_generated_note_survives_phrase_switch_and_pattern_changes(){
  let mut a=active(4);a.pulse(0);a.switch_write(false);a.pattern_write(13);a.switch_write(true);a.note(67,100,true);
  let o=a.pulse(100);assert!(o.items[0].portamento);assert_eq!(o.items[0].note,60);assert!(o.items[1].on);assert_eq!(o.items[1].note,67);
  assert_eq!(Arpeggiator::default().last_generated_note,None);
 }
 #[test] fn eight_expiries_plus_cc84_plus_on_fit_fixed_ten_events(){
  let mut a=active(13);a.pulse(0);a.next_due=6;a.last_generated_note=Some(59);
  for i in 0..8{a.gates[i]=Gate{note:40+i as u8,due:6,active:true};}
  let o=a.pulse(6);assert_eq!(o.len,10);assert!(o.items[..8].iter().all(|e|!e.on&&!e.portamento));assert!(o.items[8].portamento);assert!(o.items[9].on);
 }
}

#[cfg(test)]
mod pattern51_source_tests {
    use super::*;

    fn active(pattern: u16, notes: &[(u8, u8)]) -> Arpeggiator {
        let mut a = Arpeggiator::default();
        a.pattern_write(pattern);
        a.switch_write(true);
        for &(note, velocity) in notes { a.note(note, velocity, true); }
        a
    }
    fn ons(events: Events) -> Vec<Event> {
        events.items[..events.len].iter().copied().filter(|e| e.on).collect()
    }

    #[test]
    fn pattern51_has_21_events_eight_quarter_markers_and_exact_192_pulse_wrap() {
        let (mut index, mut pulse, mut markers) = (0u8, 0u16, Vec::new());
        for ordinal in 0..21 {
            assert_eq!(index, ordinal);
            let step = pattern_step(51, index);
            if step.marker { markers.push(pulse); }
            assert!(!step.portamento);
            assert!(step.gate > 0 && step.gate < step.interval);
            pulse += step.interval;
            index = step.next_index;
        }
        assert_eq!(pulse, pattern51::CYCLE_PULSES);
        assert_eq!(index, 0);
        assert_eq!(markers, (0..8).map(|quarter| quarter * 24).collect::<Vec<_>>());
    }

    #[test]
    fn pattern51_is_admitted_only_in_this_isolated_timeline_candidate() {
        assert!(supports_pattern(51));
        for old in [4, 5, 11, 13, 21, 39] { assert!(supports_pattern(old)); }
    }

    #[test]
    fn pattern51_repeated_selector_waits_for_nonzero_loaded_marker() {
        let mut a = active(51, &[(60, 127)]);
        assert_eq!(ons(a.pulse(0))[0].velocity, 127);
        a.pattern_write(51);
        assert!(a.pending_full);
        for pulse in 1..24 {
            let events = ons(a.pulse(pulse));
            if pulse == 16 { assert_eq!(events[0].velocity, 112); }
            assert!(a.pending_full);
            assert_eq!(a.loaded_pattern, 51);
        }
        assert_eq!(ons(a.pulse(24))[0].velocity, 127);
        assert!(!a.pending_full);
        assert_eq!((a.pattern_index, a.next_due), (1, 40));
    }

    #[test]
    fn pattern51_leave_uses_old_marker_then_first_new_step() {
        let mut a = active(51, &[(60, 127)]);
        a.pulse(0);
        a.pattern_write(4);
        for pulse in 1..24 { a.pulse(pulse); assert_eq!(a.loaded_pattern, 51); }
        let first = ons(a.pulse(24))[0];
        assert_eq!((first.pulse, first.velocity), (24, 127));
        assert_eq!((a.loaded_pattern, a.pattern_index, a.next_due), (4, 1, 30));
    }

    #[test]
    fn pattern51_enter_preserves_the_old_pattern11_gate_until_its_deadline() {
        let mut a = active(11, &[(60, 127), (64, 127), (67, 127)]);
        a.range_write(1);
        for pulse in 0..=21 { a.pulse(pulse); }
        // Pattern 11 emitted note 72 at pulse 18 with a seven-pulse gate.
        assert!(a.gates.iter().any(|gate| gate.active && gate.note == 72 && gate.due == 25));
        a.pattern_write(51);
        a.pulse(22); a.pulse(23);
        let new = ons(a.pulse(24))[0];
        assert_eq!((new.note, new.velocity, new.portamento), (60, 127, false));
        assert_eq!(a.loaded_pattern, 51);
        assert!(a.gates.iter().any(|gate| gate.active && gate.note == 72 && gate.due == 25));
        let expiry = a.pulse(25);
        assert!(expiry.items[..expiry.len].iter().any(|e| !e.on && e.note == 72 && e.pulse == 25));
    }

    #[test]
    fn pattern51_markers_without_pending_reload_do_not_reset_note_order() {
        let mut a = active(51, &[(60, 127), (64, 127), (67, 127)]);
        a.range_write(1);
        let mut notes = Vec::new();
        for pulse in 0..=48 { notes.extend(ons(a.pulse(pulse)).iter().map(|e| e.note)); }
        assert_eq!(notes, [60, 64, 67, 72, 76, 79]);
    }

    #[test]
    fn pattern51_two_cycles_keep_draw_count_and_clock_wrap_exact() {
        let mut a = active(51, &[(60, 127)]);
        a.mode_write(3);
        let start = 65520u32;
        let mut onsets = Vec::new();
        for pulse in start..start + 384 { onsets.extend(ons(a.pulse(pulse))); }
        assert_eq!(onsets.len(), 42);
        assert_eq!((onsets[0].pulse, onsets[1].pulse, onsets[2].pulse), (65520, 0, 8));
        assert_eq!(onsets[21].pulse, start.wrapping_add(192) as u16);
        assert!(onsets.iter().all(|event| event.note == 60 && !event.portamento));
        let mut expected = 0x7ab7u16;
        for _ in 0..42 * 4 { expected = expected.wrapping_mul(0x497d).wrapping_add(1); }
        assert_eq!(a.random_state, expected);
    }

    #[test]
    #[should_panic]
    fn pattern51_rejects_an_invalid_loaded_index_instead_of_modulo_substitution() {
        pattern_step(51, 21);
    }
}
