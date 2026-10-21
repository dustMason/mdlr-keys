#[path = "monologue_ring.rs"]
mod monologue_ring;

use std::hint::black_box;
use std::time::Instant;

fn measure(mut f: impl FnMut(f32,f32)->f32, inputs: &[(f32,f32)]) -> f64 {
    let count=2_000_000usize;
    let start=Instant::now();
    let mut sum=0.0f32;
    for i in 0..count {
        let (a,b)=black_box(inputs[i & (inputs.len()-1)]);
        sum+=black_box(f(a,b));
    }
    black_box(sum);
    start.elapsed().as_nanos() as f64/count as f64
}

fn main() {
    let inputs:Vec<_>=(0..1024).map(|i| {
        ((i as f32*0.307).sin()*2.2,(i as f32*0.491).sin()*2.2)
    }).collect();
    for _ in 0..5 {
        let product=measure(|a,b|a*b,&inputs);
        let table=measure(monologue_ring::transfer,&inputs);
        let mut ring=monologue_ring::RingModulator::new(192_000.0);
        let complete=measure(|a,b| { let (a,b)=ring.process(a,b,true);a+b },&inputs);
        println!("{{\"product_ns\":{product:.3},\"lut_ns\":{table:.3},\"coupled_ring_ns\":{complete:.3}}}");
    }
}
