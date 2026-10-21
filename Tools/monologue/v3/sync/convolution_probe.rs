#[allow(dead_code)]
#[path = "../../../../Rust/src/modules/monologue_sync.rs"]
mod sync;
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let v: Vec<f32> = line.split_whitespace().map(|s| s.parse().unwrap()).collect();
        let mut osc = sync::SyncOscillator::default();
        let reset = |t: f32| if t < 0.0 { None } else { Some(t) };
        osc.sample(v[0], v[1], reset(v[2]), v[5]);
        let out = osc.sample(v[3], v[1], reset(v[4]), v[5]);
        println!("{} {}", out[0], out[1]);
    }
}
