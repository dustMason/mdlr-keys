//! Semantic articulation for raw Arp pattern 51, independent of ROM at runtime.
//!
//! The rhythm and quarter markers below are authored musical rules. Gate/accent
//! annotations are explicit behavioral data transcribed during private source
//! analysis; they are deliberately not presented as a discovered generator.
//! No packed ROM records, pattern flags, pitches, firmware or factory bank are
//! included. Native chronology is tested separately from these semantic records.

use super::PatternStep;

pub(super) const EVENT_COUNT: u8 = 21;
pub(super) const CYCLE_PULSES: u16 = 192;

#[derive(Clone, Copy)]
struct Articulation {
    gate_pulses: u16,
    accent: u8,
}

// Each line names semantic units. Half-bars 1..3 have five events because the
// first triplet is lengthened; half-bar 4 has six ordinary triplets.
const ARTICULATION: [Articulation; EVENT_COUNT as usize] = [
    // Half-bar 1.
    Articulation { gate_pulses: 11, accent: 127 },
    Articulation { gate_pulses: 6, accent: 112 },
    Articulation { gate_pulses: 5, accent: 102 },
    Articulation { gate_pulses: 5, accent: 94 },
    Articulation { gate_pulses: 7, accent: 112 },
    // Half-bar 2.
    Articulation { gate_pulses: 10, accent: 122 },
    Articulation { gate_pulses: 5, accent: 117 },
    Articulation { gate_pulses: 5, accent: 112 },
    Articulation { gate_pulses: 5, accent: 102 },
    Articulation { gate_pulses: 6, accent: 117 },
    // Half-bar 3.
    Articulation { gate_pulses: 9, accent: 117 },
    Articulation { gate_pulses: 6, accent: 117 },
    Articulation { gate_pulses: 5, accent: 112 },
    Articulation { gate_pulses: 5, accent: 102 },
    Articulation { gate_pulses: 5, accent: 112 },
    // Half-bar 4.
    Articulation { gate_pulses: 6, accent: 112 },
    Articulation { gate_pulses: 6, accent: 102 },
    Articulation { gate_pulses: 6, accent: 112 },
    Articulation { gate_pulses: 6, accent: 112 },
    Articulation { gate_pulses: 6, accent: 107 },
    Articulation { gate_pulses: 5, accent: 112 },
];

pub(super) fn step(index: u8) -> PatternStep {
    assert!(index < EVENT_COUNT);
    // Three five-event half-bars, then six triplets in the closing half-bar.
    let pulse = if index < 15 {
        let within = index % 5;
        48 * (index / 5) as u16
            + if within == 0 { 0 } else { 8 * (within + 1) as u16 }
    } else {
        144 + 8 * (index - 15) as u16
    };
    let interval = if index < 15 && index % 5 == 0 { 16 } else { 8 };
    let expression = ARTICULATION[index as usize];
    PatternStep {
        interval,
        gate: expression.gate_pulses,
        accent: expression.accent,
        marker: pulse % 24 == 0,
        portamento: false,
        next_index: if index + 1 == EVENT_COUNT { 0 } else { index + 1 },
    }
}
