use mdlr_ipad_dsp::modules::jp8000::{Jp8000Instrument, Jp8000Voice, RenderTap};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicUsize, Ordering},
};
struct Counter;
static ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counter {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        System.dealloc(p, l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
        System.realloc(p, l, n)
    }
}
#[global_allocator]
static GLOBAL: Counter = Counter;
#[test]
fn raw_control_note_and_render_paths_do_not_allocate() {
    let mut voice = Jp8000Voice::new();
    let mut poly = Jp8000Instrument::new();
    let mut layered = Jp8000Instrument::new();
    let mut output = [0.0; 128];
    let mut right = [0.0; 128];
    let before = ALLOCATIONS.load(Ordering::Relaxed);
    for wave in 0..=6 {
        for note in 0..128 {
            voice.set_parameter(30, wave).unwrap();
            voice.set_parameter(31, note).unwrap();
            voice
                .set_parameter(
                    32,
                    if matches!(wave, 0 | 2 | 3) {
                        127 - note
                    } else {
                        0
                    },
                )
                .unwrap();
            voice.set_parameter(41, note).unwrap();
            voice.set_parameter(42, 127 - note).unwrap();
            voice.note_on(note as u8, 100);
            for n in [1, 7, 64, 128] {
                voice.render(&mut output[..n], RenderTap::Output);
            }
            voice.note_off(note as u8);
            voice.render(&mut output, RenderTap::Output);
        }
    }
    voice.reset();
    voice.silence();
    for n in 0..128 {
        poly.set_parameter(41, n).unwrap();
        poly.set_parameter(42, 127 - n).unwrap();
        poly.set_parameter(51, n).unwrap();
        poly.apply_patch(&[19, 26, 45, 52, 53, 67, 68], &[n, n, n, n, n, 24, 24])
            .unwrap();
        poly.apply_patch(
            &[283, 336, 316, 342, 126, 106, 98, 100, 284, 286],
            &[
                1,
                2 * n,
                254 - 2 * n,
                2 * n,
                2 * n,
                254 - 2 * n,
                2 * n,
                254 - 2 * n,
                2 * n,
                127,
            ],
        )
        .unwrap();
        poly.midi(0xb0, 2, n as u8).unwrap();
        poly.midi(0xd0, (127 - n) as u8, 0).unwrap();
        poly.midi(0xb0, 1, n as u8).unwrap();
        poly.midi(0xb0, 7, n as u8).unwrap();
        poly.midi(0xb0, 11, (127 - n) as u8).unwrap();
        poly.midi(0xe0, n as u8, n as u8).unwrap();
        if n % 11 == 0 {
            poly.midi(0xb0, 121, 0).unwrap();
        }
        poly.midi(0x90, n as u8, 100).unwrap();
        poly.midi(0xb0, 64, if n % 2 == 0 { 127 } else { 0 })
            .unwrap();
        for size in [1, 7, 64, 128] {
            poly.render_mono(&mut output[..size]);
        }
        poly.midi(0x80, n as u8, 0).unwrap();
    }
    poly.apply_patch(&[30, 32, 41, 42], &[0, 90, 80, 32])
        .unwrap();
    poly.apply_patch(&[30, 32], &[5, 0]).unwrap();
    assert!(poly.apply_patch(&[30, 32, 41], &[0, 90, 128]).is_err());
    poly.render_mono(&mut output);
    for wave in 0..=6 {
        poly.apply_patch(
            &[30, 31, 32, 25, 27, 44, 46],
            &[wave, 100, 0, 64, 64, 96, 96],
        )
        .unwrap();
        poly.apply_patch(
            &[21, 22, 23, 33, 34, 35, 36, 37, 38],
            &[1, 127, 64, 0, 1, 0, 100, 64, 127],
        )
        .unwrap();
        for note in [48, 52, 55, 60, 64, 67, 72, 76] {
            poly.midi(0x90, note, 100).unwrap();
        }
        poly.render_mono(&mut output);
        poly.reset();
    }
    for kind in 0..12 {
        poly.apply_patch(&[58,61,62,63,64,65,66,1004,1005,1006,2034,268,272,278],
            &[kind%3,kind,100,kind%5,40,100,100,kind%11,2*kind,23,120,191,191,191]).unwrap();
        poly.midi(0xb0,10,(kind*11) as u8).unwrap();
        poly.midi(0xd0,100,0).unwrap();
        poly.midi(0x90,60,127).unwrap();
        poly.render_stereo(&mut output,&mut right).unwrap();
        poly.reset();
    }
    poly.apply_patch(&[71,72,69,70,281,362],&[1,1,1,64,192,192]).unwrap();
    for n in 0..128 {
        poly.midi(0x90,n,100).unwrap();
        poly.render_stereo(&mut output,&mut right).unwrap();
        poly.midi(0x80,n,0).unwrap();
    }
    poly.midi(0xb0, 123, 0).unwrap();
    poly.midi(0xb0, 120, 0).unwrap();
    poly.reset();
    poly.silence();
    // Exercise the real two-part API, shared physical voice ownership and both
    // effect chains under the same allocation counter as the established path.
    for iteration in 0..60u16 {
        layered.reset();
        layered.apply_performance(
            &[30, 32, 18, 1002, 1003, 280, 69, 70],
            &[0, 90, 64, 0, 12 + iteration % 25, 1, 1, 100],
            &[30, 32, 18, 1002, 1003, 280, 69, 70],
            &[2, 64, 80, 1, 36 - iteration % 25, 1, 1, 64],
            &[2016, 2017, 2018, 2019, 2020, 2022, 2034, 3009],
            &[iteration % 3, 60, iteration % 3, iteration % 101,
              iteration % 2, iteration % 5, 120, 4],
        ).unwrap();
        for (index, note) in [48u8, 52, 55, 60, 64, 67, 72, 76].into_iter().enumerate() {
            layered.midi(0x90 | (index % 2) as u8, note, 100).unwrap();
        }
        for channel in 0..2u8 {
            layered.midi(0xb0 | channel, 1, iteration as u8).unwrap();
            layered.midi(0xd0 | channel, iteration as u8, 0).unwrap();
            layered.midi(0xe0 | channel, 0, 64 + channel).unwrap();
        }
        for controller in [7, 10, 11] {
            layered.midi(0xb4, controller, (iteration * 2) as u8).unwrap();
        }
        layered.midi(0xb4, 2, iteration as u8).unwrap();
        layered.midi(0x94, 60, 100).unwrap();
        layered.midi(0xb4, 64, 127).unwrap();
        layered.midi(0x84, 60, 0).unwrap();
        layered.set_parameter(2016, iteration % 3).unwrap();
        assert!(layered.set_parameter(3009, 4).is_err());
        assert!(layered.apply_performance(
            &[41], &[80], &[41], &[72], &[3009], &[4]
        ).is_err());
        for size in [1, 7, 64, 128] {
            layered.render_stereo(&mut output[..size], &mut right[..size]).unwrap();
        }
        layered.midi(0xb4, 121, 0).unwrap();
        layered.set_parameter(3009, 17).unwrap();
        layered.set_part_parameter(0, 73, 4).unwrap();
        layered.set_part_parameter(1, 73, 2).unwrap();
        assert!(layered.apply_performance(
            &[41], &[80], &[1003], &[49], &[], &[]
        ).is_err());
        layered.render_stereo(&mut output, &mut right).unwrap();
        layered.silence();
    }
    assert_eq!(ALLOCATIONS.load(Ordering::Relaxed) - before, 0);
}
