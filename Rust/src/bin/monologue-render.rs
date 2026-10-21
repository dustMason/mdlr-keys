//! Offline renderer and CPU timing tool. Never linked into the iPad audio path.
use mdlr_ipad_dsp::modules::{
    monologue::{program_parameters, Monologue},
    BlockContext, ModuleProcessor, MAX_BLOCK_FRAMES,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Write},
    path::Path,
    time::Instant,
};

fn main() {
    if let Err(e) = run() {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = env::args().skip(1).collect();
    let arg = |key: &str| {
        args.iter()
            .position(|x| x == key)
            .and_then(|i| args.get(i + 1))
            .map(String::as_str)
    };
    if args.iter().any(|x| x == "--help") {
        println!("monologue-render --output file.wav [--program raw.prog_bin] [--params params.json] [--events events.json] [--calibration model.json] [--oscillator-phases 0.137,0.731] [--lfo-phase 0] [--idle-seconds 12] [--triangle-aa on|off] [--ring-model product|product-aa|bridge|coupled-product|bridge-coupled|bridge-coupled-aa] [--duration 2] [--sample-rate 48000] [--benchmark 100]");
        return Ok(());
    }
    let rate: f32 = arg("--sample-rate").unwrap_or("48000").parse()?;
    let duration: f64 = arg("--duration").unwrap_or("2").parse()?;
    let idle_seconds: f64 = arg("--idle-seconds").unwrap_or("0").parse()?;
    if !rate.is_finite()
        || !(8000.0..=192000.0).contains(&rate)
        || !duration.is_finite()
        || !(0.001..=600.0).contains(&duration)
        || !idle_seconds.is_finite()
        || !(0.0..=30.0).contains(&idle_seconds)
    {
        return Err("invalid sample rate/duration".into());
    }
    let mut synth = Monologue::new();
    if let Some(path) = arg("--program") {
        let bytes = fs::read(path)?;
        let params = program_parameters(&bytes)?;
        if bytes[38] != 0 {
            eprintln!(
                "Warning: built-in microtuning scale {} requires explicit tuning offsets",
                bytes[38]
            );
        }
        for (id, v) in params.into_iter().enumerate() {
            synth.set_float_param(id as u32, v);
        }
    }
    if let Some(path) = arg("--params") {
        let value: Value = serde_json::from_slice(&fs::read(path)?)?;
        let values = value
            .get("params")
            .unwrap_or(&value)
            .as_object()
            .ok_or("params must be an object")?;
        for (k, v) in values {
            synth.set_float_param(
                k.parse()?,
                v.as_f64().ok_or("parameter must be numeric")? as f32,
            );
        }
    }
    if let Some(path) = arg("--calibration") {
        let value: Value = serde_json::from_slice(&fs::read(path)?)?;
        for (k, v) in value.as_object().ok_or("calibration must be an object")? {
            synth
                .calibration
                .set(k, v.as_f64().ok_or("calibration must be numeric")? as f32)?;
        }
    }
    synth.settle_parameters();
    if let Some(phases) = arg("--oscillator-phases") {
        let parsed: Vec<f32> = phases
            .split(',')
            .map(str::parse)
            .collect::<Result<_, _>>()?;
        synth.set_analysis_phases(
            parsed
                .try_into()
                .map_err(|_| "expected two oscillator phases")?,
        )?;
    }
    if let Some(phase) = arg("--lfo-phase") {
        synth.set_analysis_lfo_phase(phase.parse()?)?;
    }
    if let Some(model) = arg("--ring-model") {
        synth.set_analysis_ring_model(model)?;
    }
    if let Some(value) = arg("--triangle-aa") {
        synth.set_analysis_triangle_antialias(match value {
            "on" => true,
            "off" => false,
            _ => return Err("triangle-aa must be on or off".into()),
        });
    }
    let events: Value = if let Some(path) = arg("--events") {
        serde_json::from_slice(&fs::read(path)?)?
    } else {
        json!([{"time":0.05,"type":"on","note":60,"velocity":100},{"time":duration*0.7,"type":"off","note":60}])
    };
    let raw_events = events
        .as_array()
        .or_else(|| events.get("events").and_then(Value::as_array))
        .ok_or("events must be an array")?;
    let mut notes = Vec::new();
    for event in raw_events {
        let time = event
            .get("time")
            .and_then(Value::as_f64)
            .ok_or("event requires time")?;
        let note = event
            .get("note")
            .and_then(Value::as_u64)
            .ok_or("event requires note")?;
        if !time.is_finite() || time < 0.0 || note > 127 {
            return Err("invalid event time/note".into());
        }
        let on = match event.get("type").and_then(Value::as_str) {
            Some("on" | "note_on") => true,
            Some("off" | "note_off") => false,
            _ => return Err("event type must be on or off".into()),
        };
        let velocity = event
            .get("velocity")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        if !velocity.is_finite() || !(0.0..=127.0).contains(&velocity) {
            return Err("invalid event velocity".into());
        }
        let velocity = if velocity <= 1.0 {
            velocity as f32
        } else {
            velocity as f32 / 127.0
        };
        notes.push((
            (time * rate as f64).round() as usize,
            note as u8,
            on,
            velocity,
        ));
    }
    notes.sort_by_key(|e| e.0);
    let total = (duration * rate as f64).round() as usize;
    let mut audio = Vec::with_capacity(total);
    let mut index = 0;
    let mut event_index = 0;
    let mut held = [0u16; 128];
    let mut order = [0u64; 128];
    let mut velocities = [1.0f32; 128];
    let mut serial = 0;
    let mut inputs = [[0.0; MAX_BLOCK_FRAMES]; 15];
    let mut outputs = [[0.0; MAX_BLOCK_FRAMES]; 4];
    let idle_start = Instant::now();
    if idle_seconds > 0.0 {
        let (_, note, _, velocity) = notes
            .iter()
            .copied()
            .find(|e| e.2 && e.3 > 0.0)
            .unwrap_or((0, 48, true, 1.0));
        synth.prepare_analysis_idle(note, velocity);
        inputs[0].fill((note as f32 - 48.0) / 12.0 + synth.tuning_cents(note) / 1200.0);
        let idle_frames = (idle_seconds * rate as f64).round() as usize;
        let mut rendered = 0;
        while rendered < idle_frames {
            let frames = (idle_frames - rendered).min(MAX_BLOCK_FRAMES);
            synth.process_block(
                &BlockContext {
                    sample_rate: rate,
                    frames,
                    tempo_bpm: 120.0,
                    transport_sixteenth_position: (rendered as f64 / rate as f64 - idle_seconds)
                        * 8.0,
                },
                &inputs,
                &mut outputs,
            );
            rendered += frames;
        }
    }
    let idle_elapsed = idle_start.elapsed().as_secs_f64();
    let start = Instant::now();
    while index < total {
        while event_index < notes.len() && notes[event_index].0 <= index {
            let (_, note, on, velocity) = notes[event_index];
            let on = on && velocity > 0.0;
            let new_phrase = held.iter().all(|x| *x == 0);
            let previous = (0..128).filter(|n| held[*n] > 0).max_by_key(|n| order[*n]);
            held[note as usize] = if on {
                held[note as usize].saturating_add(1)
            } else {
                held[note as usize].saturating_sub(1)
            };
            serial += 1;
            if on {
                order[note as usize] = serial;
                velocities[note as usize] = velocity;
                synth.note_on(new_phrase);
            } else if held[note as usize] == 0
                && previous == Some(note as usize)
                && held.iter().any(|x| *x > 0)
            {
                synth.note_on(false);
            }
            event_index += 1;
        }
        let frames = (total - index).min(MAX_BLOCK_FRAMES).min(
            notes
                .get(event_index)
                .map(|e| e.0 - index)
                .unwrap_or(MAX_BLOCK_FRAMES),
        );
        let active = (0..128).filter(|n| held[*n] > 0).max_by_key(|n| order[*n]);
        if let Some(n) = active {
            synth.set_key_note(n as u8);
            synth.set_velocity(velocities[n]);
            inputs[0].fill((n as f32 - 48.0) / 12.0 + synth.tuning_cents(n as u8) / 1200.0);
        }
        inputs[1].fill(if active.is_some() { 1.0 } else { 0.0 });
        synth.process_block(
            &BlockContext {
                sample_rate: rate,
                frames,
                tempo_bpm: 120.0,
                transport_sixteenth_position: index as f64 / rate as f64 * 8.0,
            },
            &inputs,
            &mut outputs,
        );
        audio.extend_from_slice(&outputs[0][..frames]);
        index += frames;
    }
    let elapsed = start.elapsed().as_secs_f64();
    if let Some(path) = arg("--output") {
        write_wav(Path::new(path), &audio, rate as u32)?;
    }
    let mut benchmark = Value::Null;
    if let Some(n) = arg("--benchmark") {
        let iterations: usize = n.parse()?;
        if iterations == 0 || iterations > 100000 {
            return Err("benchmark count out of bounds".into());
        }
        inputs[1].fill(1.0);
        let ctx = BlockContext {
            sample_rate: rate,
            frames: 64,
            tempo_bpm: 120.0,
            transport_sixteenth_position: 0.0,
        };
        let mut timings = Vec::with_capacity(iterations);
        for _ in 0..iterations {
            let t = Instant::now();
            synth.process_block(&ctx, &inputs, &mut outputs);
            std::hint::black_box(&outputs);
            timings.push(t.elapsed().as_secs_f64() * 1e6);
        }
        timings.sort_by(f64::total_cmp);
        benchmark = json!({"buffer_frames":64,"deadline_us":64e6/rate as f64,"median_us":timings[iterations/2],"p99_us":timings[((iterations as f64*0.99) as usize).min(iterations-1)],"max_us":timings[iterations-1]});
    }
    println!(
        "{}",
        json!({"frames":total,"sample_rate":rate,"duration_seconds":duration,"idle_seconds":idle_seconds,"idle_render_seconds":idle_elapsed,"render_seconds":elapsed,"realtime_factor":duration/elapsed,"peak":audio.iter().fold(0.0f32,|a,x|a.max(x.abs())),"benchmark":benchmark})
    );
    Ok(())
}
fn write_wav(path: &Path, audio: &[f32], rate: u32) -> io::Result<()> {
    let mut f = io::BufWriter::new(fs::File::create(path)?);
    let bytes = (audio.len() * 4) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + bytes).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&3u16.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&rate.to_le_bytes())?;
    f.write_all(&(rate * 4).to_le_bytes())?;
    f.write_all(&4u16.to_le_bytes())?;
    f.write_all(&32u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&bytes.to_le_bytes())?;
    for x in audio {
        f.write_all(&x.to_le_bytes())?;
    }
    f.flush()
}
