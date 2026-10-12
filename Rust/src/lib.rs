//! Single-render-thread native adapter. UI/MIDI commands are queued by the Apple bridge.
pub mod modules;
use modules::{ModuleProcessor, BlockContext, MAX_BLOCK_FRAMES as N};

pub trait Instrument: ModuleProcessor {
    fn velocity(&mut self, voice: usize, value: f32);
    fn silence(&mut self);
}

#[derive(Clone, Copy, Default)]
struct Voice { note: u8, channel: u8, velocity: u8, gate: bool, age: u64, retrigger: bool }

pub struct Synth {
    engines: [Box<dyn Instrument>; 4],
    selected: usize,
    voices: [Voice; 6],
    // Note counts preserve repeated note-ons and mono last-note priority.
    held: [[u16; 128]; 16],
    order: [[u64; 128]; 16],
    velocities: [[u8; 128]; 16],
    sustain: [bool; 16],
    bends: [f32; 16],
    wheel: f32,
    channel_volume: f32,
    expression: f32,
    serial: u64,
    gain: f32,
    target_gain: f32,
    velocity_sensitive: bool,
    mono_mode: bool,
    inputs: modules::ModuleInputs,
    outputs: modules::ModuleOutputs,
    cursor: usize,
    sample_rate: f32,
    position: f64,
}

impl Synth {
    pub fn new() -> Self {
        Self {
            engines: [Box::new(modules::five::Five::new()), Box::new(modules::fm4::Fm4::new()), Box::new(modules::one::One::new()), Box::new(modules::six::Six::new())],
            selected: 0, voices: [Voice::default(); 6], held: [[0;128];16], order: [[0;128];16], velocities: [[0;128];16],
            sustain: [false;16], bends: [0.0;16], wheel: 0.0, channel_volume: 1.0, expression: 1.0, serial: 0,
            gain: 0.65, target_gain: 0.65, velocity_sensitive: true, mono_mode: false, inputs: [[0.0;N];15], outputs: [[0.0;N];4], cursor: N, sample_rate: 48000.0, position: 0.0,
        }
    }
    fn engine_voice_count(&self) -> usize { [5,4,1,6][self.selected] }
    pub fn count(&self) -> usize { if self.mono_mode { 1 } else { self.engine_voice_count() } }
    pub fn mono_mode(&mut self, enabled: bool) {
        if self.mono_mode != enabled {
            // Release the old allocation, including release tails and sustained notes.
            self.panic(); self.mono_mode = enabled;
        }
    }
    pub fn select(&mut self, id: usize) {
        if id < 4 { self.panic(); self.selected = id; self.engines[id].silence(); }
    }
    pub fn parameter(&mut self, id: u32, value: f32) {
        if value.is_finite() { self.engines[self.selected].set_float_param(id, value); }
    }
    pub fn volume(&mut self, value: f32) {
        if value.is_finite() { self.target_gain = value.clamp(0.0,1.0); }
    }
    pub fn velocity_sensitivity(&mut self, enabled: bool) {
        self.velocity_sensitive = enabled;
        // Keep raw velocities so toggling back restores held and releasing notes.
        for slot in 0..self.count() { self.update_velocity(slot); }
    }
    fn update_velocity(&mut self, slot: usize) {
        let gain = if self.velocity_sensitive { self.voices[slot].velocity as f32 / 127.0 } else { 1.0 };
        if self.count()==1 {
            // FIVE may stack its internal voices in unison on the single MIDI note.
            for voice in 0..self.engine_voice_count() { self.engines[self.selected].velocity(voice, gain); }
        } else { self.engines[self.selected].velocity(slot, gain); }
    }
    pub fn panic(&mut self) {
        self.engines[self.selected].silence(); self.voices.fill(Voice::default());
        self.held = [[0;128];16]; self.sustain.fill(false); self.bends.fill(0.0);
        self.wheel = 0.0; self.channel_volume = 1.0; self.expression = 1.0;
        self.outputs = [[0.0;N];4]; self.cursor = N;
    }
    fn assign(&mut self, slot: usize, channel: u8, note: u8, velocity: u8) {
        let retrigger = self.voices[slot].gate && (self.selected != 2 || self.voices[slot].note == note);
        self.voices[slot] = Voice { note, channel, velocity, gate: true, age: self.serial, retrigger };
        self.update_velocity(slot);
    }
    fn note_on(&mut self, c: u8, n: u8, v: u8) {
        let (ch,no)=(c as usize,n as usize);
        self.serial += 1; self.held[ch][no] = self.held[ch][no].saturating_add(1);
        self.order[ch][no] = self.serial; self.velocities[ch][no] = v;
        let voices=&self.voices[..self.count()];
        let slot=voices.iter().position(|x| x.gate && x.channel==c && x.note==n)
            .or_else(|| voices.iter().enumerate().filter(|(_,x)| !x.gate).min_by_key(|(_,x)|x.age).map(|(i,_)|i))
            .unwrap_or_else(|| voices.iter().enumerate().min_by_key(|(_,x)|x.age).unwrap().0);
        self.assign(slot,c,n,v);
    }
    fn mono_fallback(&mut self) {
        let mut newest=None;
        for c in 0..16 { for n in 0..128 {
            if self.held[c][n]>0 && newest.map_or(true, |(_,_,age)| self.order[c][n]>age) {
                newest=Some((c,n,self.order[c][n]));
            }
        }}
        if let Some((c,n,_))=newest {
            // Preserve legato so One's own trigger and glide controls retain meaning.
            self.voices[0].note=n as u8; self.voices[0].channel=c as u8; self.voices[0].gate=true;
            self.voices[0].velocity=self.velocities[c][n];
            self.update_velocity(0);
        } else { self.voices[0].gate=false; }
    }
    fn note_off(&mut self,c:u8,n:u8) {
        let h=&mut self.held[c as usize][n as usize]; *h=h.saturating_sub(1);
        if *h>0 || self.sustain[c as usize] { return; }
        let count=self.count();
        for i in 0..count { if self.voices[i].gate && self.voices[i].channel==c && self.voices[i].note==n {
            self.voices[i].gate=false;
            if count==1 { self.mono_fallback(); }
        }}
    }
    pub fn midi(&mut self, status:u8, a:u8, b:u8) {
        if a>127 || b>127 { return; }
        let c=status&15; let ch=c as usize;
        match status&0xf0 {
            0x90 if b>0 => self.note_on(c,a,b),
            0x80 | 0x90 => self.note_off(c,a),
            0xe0 => self.bends[ch]=(((b as i32)<<7 | a as i32)-8192) as f32 /8192.0*2.0/12.0,
            0xb0 => match a {
                1 => self.wheel=b as f32/127.0,
                7 => self.channel_volume=b as f32/127.0,
                11 => self.expression=b as f32/127.0,
                64 => {
                    self.sustain[ch]=b>=64;
                    if b<64 { for i in 0..self.count() {
                        let v=&mut self.voices[i];
                        if v.channel==c && self.held[ch][v.note as usize]==0 { v.gate=false; }
                    }
                    if self.count()==1 && !self.voices[0].gate { self.mono_fallback(); }
                    }
                },
                120 => self.panic(),
                123 => {
                    self.held[ch].fill(0);
                    if !self.sustain[ch] {
                        for v in &mut self.voices {if v.channel==c {v.gate=false;}}
                        if self.count()==1 && !self.voices[0].gate { self.mono_fallback(); }
                    }
                },
                121 => {self.bends[ch]=0.0; self.wheel=0.0; self.channel_volume=1.0; self.expression=1.0; self.midi(0xb0|c,64,0);},
                _ => {}
            },
            _ => {}
        }
    }
    fn block(&mut self) {
        self.inputs = [[0.0;N];15]; let count=self.count();
        // Processor ports stay fixed even when MIDI allocation is monophonic.
        let gate_offset=self.engine_voice_count();
        for i in 0..count {
            let v=&mut self.voices[i];
            self.inputs[i].fill((v.note as f32-48.0)/12.0 + self.bends[v.channel as usize]);
            self.inputs[i+gate_offset].fill(if v.gate {1.0} else {0.0});
            if v.retrigger { self.inputs[i+gate_offset][0]=0.0; v.retrigger=false; }
        }
        self.inputs[[11,8,3,13][self.selected]].fill(self.wheel);
        let ctx=BlockContext {sample_rate:self.sample_rate,frames:N,tempo_bpm:120.0,transport_sixteenth_position:self.position};
        self.engines[self.selected].process_block(&ctx,&self.inputs,&mut self.outputs);
        self.position+=N as f64/self.sample_rate as f64*8.0;
        self.cursor=0;
    }
    pub fn render(&mut self,left:&mut [f32],right:&mut [f32],rate:f32) {
        if rate.is_finite() && rate>=8000.0 && rate!=self.sample_rate { self.sample_rate=rate; self.cursor=N; }
        let alpha=1.0-(-1.0/(0.01*self.sample_rate)).exp();
        for (l,r) in left.iter_mut().zip(right.iter_mut()) {
            if self.cursor==N { self.block(); }
            self.gain+=(self.target_gain*self.channel_volume*self.expression-self.gain)*alpha;
            let x=self.outputs[0][self.cursor]*self.gain;
            let y=self.outputs[if self.selected==2 {0} else {1}][self.cursor]*self.gain;
            *l=if x.is_finite(){x.clamp(-1.0,1.0)}else{0.0};
            *r=if y.is_finite(){y.clamp(-1.0,1.0)}else{0.0};
            self.cursor+=1;
        }
    }
}

#[no_mangle] pub extern "C" fn mdlr_create() -> *mut Synth { Box::into_raw(Box::new(Synth::new())) }
/// Caller must stop rendering and submitting commands before destroying.
#[no_mangle] pub unsafe extern "C" fn mdlr_destroy(p:*mut Synth) { if !p.is_null(){drop(Box::from_raw(p));} }
#[no_mangle] pub unsafe extern "C" fn mdlr_command(p:*mut Synth,kind:u32,a:u32,b:u32,value:f32) {
    if let Some(s)=p.as_mut(){match kind {0=>s.midi(a as u8,b as u8,value as u8),1=>s.select(a as usize),2=>s.parameter(a,value),3=>s.volume(value),4=>s.panic(),5=>s.velocity_sensitivity(a!=0),6=>s.mono_mode(a!=0),_=>{}}}
}
#[no_mangle] pub unsafe extern "C" fn mdlr_render(p:*mut Synth,l:*mut f32,r:*mut f32,frames:u32,rate:f32) {
    if p.is_null()||l.is_null()||r.is_null(){return;}
    (*p).render(std::slice::from_raw_parts_mut(l,frames as usize),std::slice::from_raw_parts_mut(r,frames as usize),rate);
}

#[cfg(test)] mod tests {
    use super::*;
    fn audio(s: &mut Synth) -> Vec<f32> {
        let (mut l, mut r) = (vec![0.0;8192], vec![0.0;8192]);
        s.render(&mut l,&mut r,48000.0);
        l.extend(r); l
    }
    fn note_synth(engine: usize, sensitive: bool, velocity: u8) -> Synth {
        let mut s=Synth::new(); s.select(engine); s.velocity_sensitivity(sensitive);
        s.midi(0x90,60,velocity); s
    }
    #[test] fn mono_uses_one_note_with_last_note_priority_in_every_engine() {
        for engine in 0..4 {
            let mut s=Synth::new(); s.mono_mode(true); s.select(engine);
            s.midi(0x90,60,32); s.midi(0x91,64,100); s.midi(0x90,67,80);
            assert_eq!(s.count(),1);
            assert_eq!(s.voices.iter().filter(|v|v.gate).count(),1);
            assert_eq!(s.voices[0].note,67);
            s.midi(0x90,67,0);
            assert_eq!((s.voices[0].note,s.voices[0].channel,s.voices[0].velocity),(64,1,100));
            s.midi(0xb1,123,0);
            assert_eq!((s.voices[0].note,s.voices[0].channel,s.voices[0].velocity),(60,0,32));
            s.midi(0x80,60,0); assert!(!s.voices[0].gate);
        }
    }
    #[test] fn mono_keeps_processor_gate_ports_and_stereo_audio() {
        for engine in 0..4 {
            let mut s=Synth::new(); s.select(engine); s.mono_mode(true); s.midi(0x90,60,100);
            let mono=audio(&mut s);
            assert_eq!(mono,audio(&mut note_synth(engine,true,100)),"Mono must drive the same processor voice and stereo effects");
            assert!(mono.iter().map(|x|x*x).sum::<f32>()>0.01);
            for i in 1..s.engine_voice_count() { assert!(s.inputs[i+s.engine_voice_count()].iter().all(|x|*x==0.0)); }
        }
    }
    #[test] fn mono_sustain_repeated_notes_and_bend_keep_working() {
        for engine in 0..4 {
            let mut s=Synth::new(); s.select(engine); s.mono_mode(true);
            s.midi(0x90,60,40); s.midi(0x90,64,100); s.midi(0x90,64,100);
            s.midi(0x80,64,0); assert_eq!(s.voices[0].note,64);
            s.midi(0xb0,64,127); s.midi(0x90,64,0);
            assert!(s.voices[0].gate); assert_eq!(s.voices[0].note,64);
            s.midi(0xb0,64,0); assert_eq!(s.voices[0].note,60);
            s.midi(0xe0,0,0); s.block(); assert_eq!(s.inputs[0][0],1.0-2.0/12.0);
            s.midi(0x80,60,0); assert!(!s.voices[0].gate);
        }
    }
    #[test] fn mono_toggle_clears_notes_and_restores_polyphony() {
        for engine in 0..4 {
            let mut s=Synth::new(); s.select(engine);
            for n in 60..66 { s.midi(0x90,n,100); }
            audio(&mut s); s.midi(0xb0,64,127);
            unsafe { mdlr_command(&mut s,6,1,0,0.0); }
            assert_eq!(s.count(),1);
            assert!(s.voices.iter().all(|v|!v.gate)); assert!(s.held.iter().flatten().all(|n|*n==0));
            assert!(audio(&mut s).iter().all(|x|x.abs()<0.00001));
            s.midi(0x90,60,100); s.mono_mode(true);
            assert!(s.voices[0].gate,"Reapplying the same mode must not cut notes");
            unsafe { mdlr_command(&mut s,6,0,0,0.0); }
            assert_eq!(s.count(),[5,4,1,6][engine]);
            for n in 60..66 { s.midi(0x90,n,100); }
            assert_eq!(s.voices.iter().filter(|v|v.gate).count(),[5,4,1,6][engine]);
        }
    }
    #[test] fn global_velocity_controls_actual_audio_for_every_engine() {
        for engine in 0..4 {
            let soft=audio(&mut note_synth(engine,true,32));
            let loud=audio(&mut note_synth(engine,true,127));
            let fixed_soft=audio(&mut note_synth(engine,false,32));
            let fixed_hard=audio(&mut note_synth(engine,false,127));
            assert_eq!(fixed_soft,fixed_hard,"Engine {engine}: velocity off must be constant");
            assert_eq!(fixed_soft,loud,"Engine {engine}: velocity off must use full velocity");
            let energy=|xs: &[f32]| xs.iter().map(|x|x*x).sum::<f32>();
            assert!(energy(&loud)>0.01);
            assert!(energy(&soft)<energy(&loud)*0.1,"Engine {engine}: velocity on must respond");
        }
    }
    #[test] fn velocity_toggle_updates_held_notes_and_restores_raw_velocity() {
        for engine in 0..4 {
            let mut s=note_synth(engine,true,32);
            // Exercise the same FFI command used by the native options switch.
            unsafe { mdlr_command(&mut s,5,0,0,0.0); }
            assert_eq!(audio(&mut s),audio(&mut note_synth(engine,false,32)));
            let mut s=note_synth(engine,false,32);
            unsafe { mdlr_command(&mut s,5,1,0,0.0); }
            assert_eq!(audio(&mut s),audio(&mut note_synth(engine,true,32)));
        }
    }
    #[test] fn velocity_off_keeps_note_off_sustain_and_global_scope() {
        let mut s=Synth::new(); s.velocity_sensitivity(false);
        for engine in 0..4 {
            s.select(engine); s.panic(); s.parameter(0,0.5);
            assert!(!s.velocity_sensitive);
            s.midi(0x90,60,12); s.midi(0xb0,64,127); s.midi(0x90,60,0);
            assert_eq!(s.held[0][60],0); assert!(s.voices[0].gate);
            s.midi(0xb0,64,0); assert!(!s.voices[0].gate);
            s.midi(0x90,61,12); s.midi(0x90,61,0);
            assert!(s.voices.iter().all(|v|!v.gate));
            s.midi(0x9f,60,100); s.midi(0x8f,60,0);
            assert!(s.voices.iter().all(|v|!v.gate),"Touch keyboard must release too");
        }
    }
    #[test] fn mono_fallback_respects_global_velocity_and_retains_raw_value() {
        for sensitive in [false,true] {
            let mut s=note_synth(2,sensitive,32);
            s.midi(0x90,64,110); s.midi(0x80,64,0);
            assert_eq!(s.voices[0].note,60); assert_eq!(s.voices[0].velocity,32);
            assert_eq!(audio(&mut s),audio(&mut note_synth(2,sensitive,32)));
        }
    }
    #[test] fn polyphony_and_stealing() { for (engine,count) in [5,4,1,6].into_iter().enumerate(){let mut s=Synth::new();s.select(engine);for n in 60..68{s.midi(0x90,n,100);} assert_eq!(s.voices.iter().filter(|v|v.gate).count(),count);s.midi(0x80,60,0);assert_eq!(s.voices.iter().filter(|v|v.gate).count(),count);}}
    #[test] fn mono_returns_to_held_note(){let mut s=Synth::new();s.select(2);s.midi(0x90,60,100);s.midi(0x90,64,90);s.midi(0x80,64,0);assert_eq!(s.voices[0].note,60);assert!(s.voices[0].gate);}
    #[test] fn sustain_and_zero_velocity(){let mut s=Synth::new();s.midi(0x90,60,100);s.midi(0xb0,64,127);s.midi(0x90,60,0);assert!(s.voices[0].gate);s.midi(0xb0,64,0);assert!(!s.voices[0].gate);}
    #[test] fn repeated_notes_and_channels(){let mut s=Synth::new();s.midi(0x90,60,100);s.midi(0x90,60,100);s.midi(0x91,60,100);s.midi(0x80,60,0);assert_eq!(s.voices.iter().filter(|v|v.gate).count(),2);s.midi(0x80,60,0);assert_eq!(s.voices.iter().filter(|v|v.gate).count(),1);}
    #[test] fn all_engines_render_variable_buffers_and_panic(){for e in 0..4{let mut s=Synth::new();s.select(e);for n in 60..60+s.count() as u8{s.midi(0x90,n,110);}let(mut l,mut r)=([0.0;257],[0.0;257]);let mut energy=0.0;for _ in 0..80{s.render(&mut l,&mut r,48000.0);for x in l.iter().chain(r.iter()){assert!(x.is_finite()&&x.abs()<=1.0);energy+=x*x;}if e==2{assert_eq!(l,r);}}assert!(energy>0.01);s.panic();s.render(&mut l,&mut r,48000.0);assert!(l.iter().chain(r.iter()).all(|x|x.abs()<0.00001));}}
    #[test] fn bend_two_semitones(){let mut s=Synth::new();s.midi(0xe0,0,0);assert_eq!(s.bends[0],-2.0/12.0);s.midi(0xe0,0,64);assert_eq!(s.bends[0],0.0);}
}
