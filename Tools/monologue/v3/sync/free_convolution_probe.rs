#[path = "../../../../Rust/src/modules/monologue_sync.rs"]
mod sync;
use std::io::{self, BufRead};
fn main() {
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        let v: Vec<f32> = line.split_whitespace().map(|s| s.parse().unwrap()).collect();
        let mut osc = sync::FreeTriangle::default();
        osc.sample(v[0], v[1]);
        println!("{}", osc.sample(v[2], v[1]));
    }
}
