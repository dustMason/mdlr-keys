//! Handwritten fixed-point bass/treble shelves. Coefficients are generated from
//! the recovered pole/zero laws; no firmware table or program is stored here.

use super::sat24;

// Order: bass zero/pole, treble zero/pole, interstage gain, output gain.
pub(super) fn tone_coefficients(bass: u16, treble: u16) -> [i64; 6] {
    let bass = bass.min(127) as i64;
    let treble = treble.min(127) as i64;
    [
        (-32768 + bass.min(64) * 16) >> 1,
        (31743 + (bass - 64).max(0) * 16) >> 1,
        -(22397 + treble.min(64) * 128) >> 1,
        (30589 - (treble - 64).max(0) * 128) >> 1,
        (16384 * 2179 / (10371 - treble.min(64) * 128)) >> 1,
        (4096 * (2179 + (treble - 64).max(0) * 128) / 2179) >> 1,
    ]
}

// The continuation multiplies the already shifted input. A single Q14
// multiplication would discard different low bits, especially below silence.
fn extended_multiply(input: i64, coefficient: i64, shift: u32) -> i64 {
    ((input * (coefficient >> 7)) >> shift)
        + (((input >> 7) * (coefficient & 127)) >> shift)
}

#[derive(Clone, Copy)]
pub(super) struct ToneEq {
    coefficients: [i64; 6],
    history: [i64; 5],
}

impl ToneEq {
    pub(super) fn new() -> Self {
        Self {
            coefficients: tone_coefficients(64, 64),
            history: [0; 5],
        }
    }

    pub(super) fn configure(&mut self, bass: u16, treble: u16) {
        self.coefficients = tone_coefficients(bass, treble);
    }

    pub(super) fn publish(&mut self, coefficients: [i64; 6]) {
        self.coefficients = coefficients;
    }

    pub(super) fn process(&mut self, input: i64) -> i64 {
        let [zero_b, pole_b, zero_t, pole_t, gain_b, gain_t] = self.coefficients;
        let [x_prev, a_prev, middle_prev, middle_prev2, b_prev] = self.history;
        let a = sat24(
            input
                + extended_multiply(x_prev, zero_b, 7)
                + extended_multiply(a_prev, pole_b, 7),
        );
        let b = sat24(
            middle_prev
                + extended_multiply(middle_prev2, zero_t, 7)
                + extended_multiply(b_prev, pole_t, 7),
        );
        let middle = sat24(extended_multiply(a, gain_b, 6));
        self.history = [input, a, middle, middle_prev, b];
        sat24(extended_multiply(b, gain_t, 6))
    }
}

#[cfg(test)]
impl ToneEq {
    pub(crate) fn shared_cache_test_coefficients(&self) -> [i64; 6] {
        self.coefficients
    }
    pub(crate) fn shared_cache_test_history(&self) -> [i64; 5] {
        self.history
    }
}
