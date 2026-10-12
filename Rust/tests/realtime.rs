use mdlr_ipad_dsp::Synth;
use std::{alloc::{GlobalAlloc,Layout,System},sync::atomic::{AtomicUsize,Ordering}};
struct Counter;
static ALLOCATIONS: AtomicUsize=AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self,l:Layout)->*mut u8{ALLOCATIONS.fetch_add(1,Ordering::Relaxed);System.alloc(l)}
    unsafe fn dealloc(&self,p:*mut u8,l:Layout){System.dealloc(p,l)}
    unsafe fn realloc(&self,p:*mut u8,l:Layout,n:usize)->*mut u8{ALLOCATIONS.fetch_add(1,Ordering::Relaxed);System.realloc(p,l,n)}
}
#[global_allocator]static GLOBAL:Counter=Counter;
#[test]
fn rendering_switching_and_midi_do_not_allocate(){
    let mut s=Synth::new();let(mut l,mut r)=([0.0;511],[0.0;511]);
    let before=ALLOCATIONS.load(Ordering::Relaxed);
    for e in 0..4{
      for mono in [false,true] {
        s.mono_mode(mono);
        s.select(e);s.parameter(0,0.1);s.volume(0.5);
        for n in 48..60{s.midi(0x90,n,90);s.velocity_sensitivity(n%2==0);s.render(&mut l,&mut r,48000.0);}
        s.midi(0xb0,64,127);for n in 48..60{s.midi(0x80,n,0);}
        s.render(&mut l,&mut r,48000.0);s.midi(0xb0,64,0);s.panic();
      }
    }
    assert_eq!(ALLOCATIONS.load(Ordering::Relaxed)-before,0);
}
