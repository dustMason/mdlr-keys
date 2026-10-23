//! Offline-only experiment runner. The production app never links this parser.
#![recursion_limit = "256"]
use mdlr_ipad_dsp::modules::jp8000::{
    Jp8000Instrument, Jp8000Voice, ParameterError, RenderTap, IMPLEMENTED_PARAMETERS,
    MAX_RENDER_FRAMES, NATIVE_SAMPLE_RATE,
};
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, Write},
    path::Path,
    time::Instant,
};

#[derive(Clone, Copy)]
struct Event {
    frame: usize,
    status: u8,
    data1: u8,
    data2: u8,
}
enum Engine {
    Voice(Jp8000Voice),
    Poly(Jp8000Instrument),
}
impl Engine {
    fn set_parameter(&mut self, id: u16, value: u16) -> Result<(), ParameterError> {
        match self {
            Self::Voice(v) => v.set_parameter(id, value),
            Self::Poly(p) => p.set_parameter(id, value),
        }
    }
    fn apply_patch(&mut self, ids: &[u16], values: &[u16]) -> Result<(), ParameterError> {
        match self {
            Self::Voice(v) => v.apply_patch(ids, values),
            Self::Poly(p) => p.apply_patch(ids, values),
        }
    }
    fn set_lfo2_phase(&mut self, phase: f64) -> Result<(), &'static str> {
        match self {
            Self::Voice(v) => v.set_lfo2_phase(phase),
            Self::Poly(p) => p.set_lfo2_phase(phase),
        }
    }
    fn set_phases(&mut self, phases: [f64; 7]) -> Result<(), &'static str> {
        match self {
            Self::Voice(v) => v.set_phases(phases),
            Self::Poly(p) => p.set_voice_phases(0, phases),
        }
    }
    fn set_lfo_phase(&mut self, phase: f64) -> Result<(), &'static str> {
        match self {
            Self::Voice(v) => v.set_lfo_phase(phase),
            Self::Poly(p) => p.set_lfo_phase(phase),
        }
    }
    fn set_control_phase(&mut self, phase: u16) -> Result<(), &'static str> {
        match self {
            Self::Voice(v) => v.set_control_phase(phase),
            Self::Poly(p) => p.set_control_phase(phase),
        }
    }
    fn render(&mut self, out: &mut [f32], tap: RenderTap, stereo: bool) {
        if stereo {
            debug_assert_eq!(out.len() % 2, 0);
            for frame in out.chunks_exact_mut(2) {
                let (left, right) = match self {
                    Self::Voice(v) => v.next_stereo_sample(),
                    Self::Poly(p) => p.next_stereo_sample(),
                };
                frame[0] = left;
                frame[1] = right;
            }
            return;
        }
        match self {
            Self::Voice(v) => v.render(out, tap),
            Self::Poly(p) => p.render_mono(out),
        }
    }
    fn apply(&mut self, e: Event) -> Result<(), String> {
        match self {
            Self::Voice(v) => {
                if e.status & 0xf0 == 0x90 {
                    v.note_on(e.data1, e.data2)
                } else {
                    v.note_off_with_velocity(e.data1, e.data2)
                };
                Ok(())
            }
            Self::Poly(p) => p
                .midi(e.status, e.data1, e.data2)
                .map_err(|error| format!("MIDI event at frame{}: {error:?}", e.frame)),
        }
    }
    fn benchmark_on(&mut self) -> Result<usize, &'static str> {
        match self {
            Self::Voice(v) => {
                v.note_on(60, 100);
                Ok(1)
            }
            Self::Poly(p) => {
                p.silence();
                let channel = p.parameter(1002).unwrap_or(0) as u8;
                if channel > 15 {
                    return Err("cannot benchmark eight held voices with receive channel off");
                }
                for note in [60, 64, 67, 71, 74, 77, 81, 84] {
                    p.midi(0x90 | channel, note, 100)
                        .map_err(|_| "benchmark note was rejected")?;
                }
                let count = p.held_voice_count();
                if count != 8 {
                    return Err("benchmark uses the Upper receive channel and requires exactly eight held voices; this performance routing/Mono configuration does not provide that workload");
                }
                Ok(count)
            }
        }
    }
}
/// Bank/program values are provenance only when every patch sound control
/// is explicit. This boundary does not add bank loading to the runtime API.
fn resolved_selection(
    parameters: &serde_json::Map<String, Value>,
) -> Result<Option<Value>, &'static str> {
    let complete = (16..=73)
        .chain((74..=126).step_by(2))
        .chain((256..=278).step_by(2))
        .chain([280, 281, 283])
        .chain((284..=362).step_by(2))
        .all(|id| parameters.contains_key(&id.to_string()));
    if !complete || !parameters.contains_key("1000") || !parameters.contains_key("1001") {
        return Ok(None);
    }
    let bank = parameters["1000"]
        .as_u64()
        .filter(|v| *v <= 2)
        .ok_or("invalid resolved patch bank")?;
    let program = parameters["1001"]
        .as_u64()
        .filter(|v| *v <= 127)
        .ok_or("invalid resolved patch number")?;
    Ok(Some(
        json!({"bank":bank,"program":program,"source":"complete explicit patch parameters; selection metadata only"}),
    ))
}
#[derive(Default)]
struct RawScope {
    ids: Vec<u16>,
    values: Vec<u16>,
}
impl RawScope {
    fn push(&mut self, scope: &str, id: u16, value: u16) -> Result<(), String> {
        if self.ids.contains(&id) {
            return Err(format!("duplicate or conflicting {scope} parameter {id}"));
        }
        self.ids.push(id);
        self.values.push(value);
        Ok(())
    }
}
struct CaseImport {
    upper: RawScope,
    lower: RawScope,
    common: RawScope,
    resolved: [Option<Value>; 2],
    has_lower: bool,
}
impl CaseImport {
    fn parse(spec: &Value, polyphonic: bool) -> Result<Self, String> {
        let upper = spec
            .get("parameters")
            .and_then(Value::as_object)
            .ok_or("case requires parameters object")?;
        let lower = spec
            .get("lower_parameters")
            .map(|v| v.as_object().ok_or("lower_parameters must be an object"))
            .transpose()?;
        let common = spec
            .get("common_parameters")
            .map(|v| v.as_object().ok_or("common_parameters must be an object"))
            .transpose()?;
        if !polyphonic && common.is_some() {
            return Err(
                "common_parameters requires --poly; the single Voice path remains bounded".into(),
            );
        }
        let resolved_upper = resolved_selection(upper).map_err(|e| format!("upper: {e}"))?;
        let resolved_lower = if polyphonic {
            lower
                .map(resolved_selection)
                .transpose()
                .map_err(|e| format!("lower: {e}"))?
                .flatten()
        } else {
            None
        };
        if polyphonic {
            for (scope, map, resolved) in [
                ("upper", Some(upper), &resolved_upper),
                ("lower", lower, &resolved_lower),
            ] {
                if map.is_some_and(|m| m.contains_key("1000") || m.contains_key("1001"))
                    && resolved.is_none()
                {
                    return Err(format!("{scope}: bank/program metadata requires a complete explicit sound map and both selection IDs; runtime bank loading is unsupported"));
                }
            }
        }
        let mut result = Self {
            upper: RawScope::default(),
            lower: RawScope::default(),
            common: RawScope::default(),
            resolved: [resolved_upper, resolved_lower],
            has_lower: lower.is_some(),
        };
        for (scope, map) in [("upper", Some(upper)), ("lower", lower), ("common", common)] {
            // Single Voice preserves its explicitly documented muted/ignored
            // Lower fixture boundary; only the poly engine imports that scope.
            if scope == "lower" && !polyphonic {
                continue;
            }
            for (key, val) in map.into_iter().flatten() {
                let id: u16 = key
                    .parse()
                    .map_err(|_| format!("{scope}: invalid parameter ID {key}"))?;
                if key != &id.to_string() {
                    return Err(format!(
                        "{scope}: parameter ID {key} is not canonical decimal {id}"
                    ));
                }
                let raw: u16 = val
                    .as_u64()
                    .and_then(|v| v.try_into().ok())
                    .ok_or_else(|| {
                        format!("{scope} parameter {key}: expected an integer in 0..65535")
                    })?;
                let part = usize::from(scope == "lower");
                if scope != "common" && result.resolved[part].is_some() && matches!(id, 1000 | 1001)
                {
                    continue;
                }
                if scope == "lower" && id >= 2000 {
                    return Err(format!("lower parameter {id} belongs to common scope"));
                }
                if scope == "common" && id < 2000 {
                    return Err(format!("common parameter {id} belongs to a part scope"));
                }
                if scope == "common" || (scope == "upper" && polyphonic && id >= 2000) {
                    result.common.push("common", id, raw)?;
                } else if scope == "lower" {
                    result.lower.push("lower", id, raw)?;
                } else {
                    result.upper.push("upper", id, raw)?;
                }
            }
        }
        Ok(result)
    }
    fn transaction_error(&self, error: &ParameterError) -> Value {
        let (id, value) = match *error {
            ParameterError::UnsupportedParameter(id) => (id, None),
            ParameterError::UnsupportedValue { id, value }
            | ParameterError::OutOfRange { id, value, .. } => (id, Some(value)),
        };
        let mut candidates = Vec::new();
        for (scope, raw) in [
            ("upper", &self.upper),
            ("lower", &self.lower),
            ("common", &self.common),
        ] {
            for (&key, &v) in raw.ids.iter().zip(&raw.values) {
                if key == id && value.map_or(true, |wanted| wanted == v) {
                    candidates.push(json!({"scope":scope,"id":key,"value":v}));
                }
            }
        }
        json!({"scope":"performance transaction","id":id,"value":value,"error":error.to_string(),
            "matching_requested_controls":candidates,
            "atomic":true,"partial_import_allowed":false,
            "note":"Matching scopes identify candidate fields, not independently invalid controls. No part or common values were committed."})
    }
    fn apply(&self, engine: &mut Engine, strict: bool) -> Result<Vec<Value>, String> {
        if let Engine::Poly(instrument) = engine {
            instrument.apply_performance(&self.upper.ids,&self.upper.values,
                &self.lower.ids,&self.lower.values,&self.common.ids,&self.common.values)
                .map_err(|error| format!("unsupported parameters: {}. Poly performance imports are atomic; --allow-unsupported cannot partially import them.",
                    json!([self.transaction_error(&error)])))?;
            return Ok(Vec::new());
        }
        let mut unsupported = Vec::new();
        if let Err(patch_error) = engine.apply_patch(&self.upper.ids, &self.upper.values) {
            for (&id, &raw) in self.upper.ids.iter().zip(&self.upper.values) {
                if let Err(error) = engine.set_parameter(id, raw) {
                    unsupported.push(
                        json!({"scope":"upper","id":id,"value":raw,"error":error.to_string()}),
                    );
                }
            }
            if unsupported.is_empty() {
                unsupported.push(json!({"scope":"upper","patch_error":patch_error.to_string()}));
            }
        }
        if strict && !unsupported.is_empty() {
            return Err(format!("unsupported parameters: {}", json!(unsupported)));
        }
        Ok(unsupported)
    }
    fn readback(&self, engine: &Engine) -> Value {
        let mut result = serde_json::Map::new();
        for (scope, raw) in [
            ("upper", &self.upper),
            ("lower", &self.lower),
            ("common", &self.common),
        ] {
            let mut values = serde_json::Map::new();
            for &id in &raw.ids {
                let value = match engine {
                    Engine::Poly(p) if scope == "common" => p.parameter(id),
                    Engine::Poly(p) => p.part_parameter(usize::from(scope == "lower"), id),
                    Engine::Voice(v) => v.parameter(id),
                };
                values.insert(id.to_string(), json!(value));
            }
            result.insert(scope.to_string(), Value::Object(values));
        }
        Value::Object(result)
    }
}

fn instrument_pedal_coverage() -> Value {
    json!({"accepted_selector_values":[3,11],"physical_pedal_input":false,"adc_model":false,
        "remote_cc11":{"assignment3":"expression","assignment11":"ignored"},"direct_cc11":"expression",
        "assignment_changes":"Require default Remote expression cache and no active expression destinations; equal selector writes are allowed."})
}

fn instrument_arpeggiator_coverage() -> Value {
    // Use the same predicates as atomic validation, the C ABI and host/UI.
    let modes: Vec<u16> = (0..=4).filter(|&v| Jp8000Instrument::parameter_value_capability(2024, v) == 1).collect();
    let patterns: Vec<u16> = (0..=89).filter(|&v| Jp8000Instrument::parameter_value_capability(2025, v) == 1).collect();
    json!({"scope":"polyphonic Instrument only","mode_ids":modes,"pattern_ids":patterns,
        "clock":"internal24PPQ pulse events; no emulated UART/MCU dispatch delay",
        "input":"Remote MIDI channel; current Instrument routing guards apply",
        "unsupported":["other patterns","RPS","Individual Trigger","external MIDI clock/transport"]})
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args().skip(1);
    let (mut case, mut output, mut raw_output, mut report) = (None, None, None, None);
    let mut polyphonic = false;
    let mut stereo = false;
    let mut validate_only = false;
    let mut benchmark = None;
    let mut block = MAX_RENDER_FRAMES;
    let mut tap = RenderTap::Output;
    let mut strict = true;
    let mut phases = None;
    let mut lfo_phase: Option<f64> = None;
    let mut lfo2_phase: Option<f64> = None;
    let mut control_phase: u16 = 0;
    while let Some(key) = args.next() {
        match key.as_str() {
            "--help" => {
                println!("jp8000-render --case case.json --output file.wav [--raw-output file.f32le] [--report receipt.json] [--tap output|oscillator] [--phases p0,...,p6] [--block-frames 128] [--control-phase 0] [--lfo-phase 0] [--lfo2-phase 0] [--allow-unsupported] [--benchmark iterations] [--poly] [--stereo] [--validate-only]\nFixed sample rate: 88200 Hz. --case uses raw JP canonical IDs and integer MIDI event frames. Default is the comparison voice; --poly uses the bounded eight-voice two-part instrument; lower_parameters is imported atomically and common IDs may be supplied in parameters or common_parameters. Default audio is the left mono channel; --stereo writes interleaved L/R. --validate-only checks controls and event syntax without settling or rendering audio. Unsupported controls are rejected by default; --allow-unsupported is a single-Voice diagnostic override. Poly performance imports always remain atomic and reject unsupported controls.");
                return Ok(());
            }
            "--poly" => polyphonic = true,
            "--stereo" => stereo = true,
            "--validate-only" => validate_only = true,
            "--strict" => strict = true,
            "--allow-unsupported" => strict = false,
            "--lfo2-phase" => {
                lfo2_phase = Some(args.next().ok_or("--lfo2-phase needs cycles")?.parse()?)
            }
            "--lfo-phase" => {
                lfo_phase = Some(args.next().ok_or("--lfo-phase needs cycles")?.parse()?)
            }
            "--control-phase" => {
                control_phase = args
                    .next()
                    .ok_or("--control-phase needs frames until tick")?
                    .parse()?
            }
            "--case" => case = Some(args.next().ok_or("--case needs a path")?),
            "--output" => output = Some(args.next().ok_or("--output needs a path")?),
            "--raw-output" => raw_output = Some(args.next().ok_or("--raw-output needs a path")?),
            "--report" => report = Some(args.next().ok_or("--report needs a path")?),
            "--tap" => {
                tap = match args.next().as_deref() {
                    Some("output") => RenderTap::Output,
                    Some("oscillator") => RenderTap::Oscillator,
                    _ => return Err("tap must be output or oscillator".into()),
                }
            }
            "--phases" => {
                let text = args
                    .next()
                    .ok_or("--phases needs seven comma-separated values")?;
                let p: Vec<f64> = text.split(',').map(str::parse).collect::<Result<_, _>>()?;
                phases = Some(
                    p.try_into()
                        .map_err(|_| "--phases needs exactly seven values")?,
                );
            }
            "--block-frames" => {
                block = args.next().ok_or("--block-frames needs a value")?.parse()?
            }
            "--benchmark" => {
                benchmark = Some(
                    args.next()
                        .ok_or("--benchmark needs iterations")?
                        .parse::<usize>()?,
                )
            }
            _ => return Err(format!("unknown argument: {key}").into()),
        }
    }
    if !(1..=MAX_RENDER_FRAMES).contains(&block) {
        return Err("block size must be 1..128".into());
    }
    if (polyphonic || stereo) && tap == RenderTap::Oscillator {
        return Err("--poly and --stereo require output tap".into());
    }
    if validate_only && (!strict || output.is_some() || raw_output.is_some() || benchmark.is_some())
    {
        return Err("--validate-only requires strict mode and does not accept audio outputs or benchmarking".into());
    }
    let channels = if stereo { 2 } else { 1 };
    let case_path = case.ok_or("--case is required")?;
    let spec: Value = serde_json::from_slice(&fs::read(&case_path)?)?;
    if spec.get("schema").and_then(Value::as_u64) != Some(1) {
        return Err("case schema must be 1".into());
    }
    if spec.get("sample_rate").and_then(Value::as_u64) != Some(NATIVE_SAMPLE_RATE as u64) {
        return Err("only the fixed native 88200 Hz rate is supported".into());
    }
    let frames = integer(&spec, "frames", 0)?;
    let settle_frames = integer(&spec, "settle_frames", 0)?;
    if frames == 0
        || frames > NATIVE_SAMPLE_RATE as usize * 600
        || settle_frames > NATIVE_SAMPLE_RATE as usize * 60
    {
        return Err(
            "invalid frame count (audio 1 frame..600 seconds, settling <=60 seconds)".into(),
        );
    }
    let import = CaseImport::parse(&spec, polyphonic)?;
    let lower_status = if polyphonic {
        if import.has_lower {
            "imported into the Lower part; routing follows common performance controls"
        } else {
            "no Lower map supplied; instrument defaults and common performance routing apply"
        }
    } else if let Some(lower) = spec.get("lower_parameters") {
        let lower = lower
            .as_object()
            .ok_or("lower_parameters must be an object")?;
        if lower.get("51").and_then(Value::as_u64) == Some(0)
            && lower.get("1002").and_then(Value::as_u64) == Some(16)
        {
            "explicitly muted fixture; not rendered by the single Voice engine"
        } else if strict {
            return Err("single Voice requires lower amp51=0 and receive1002=16, or no lower_parameters; use --poly for an active Lower part".into());
        } else {
            "IGNORED despite active or unknown Lower settings (--allow-unsupported single Voice diagnostic)"
        }
    } else {
        "not supplied; single Voice diagnostic engine"
    };
    let mut voice = if polyphonic {
        Engine::Poly(Jp8000Instrument::new())
    } else {
        Engine::Voice(Jp8000Voice::new())
    };
    let unsupported = import.apply(&mut voice, strict)?;
    let resolved_patch_selection = import.resolved[0].clone();
    let resolved_patch_selections = json!({"upper":import.resolved[0],"lower":import.resolved[1]});
    let parameter_readback = import.readback(&voice);
    let ignored_case_fields = if !polyphonic && import.has_lower {
        vec!["lower_parameters"]
    } else {
        Vec::<&str>::new()
    };
    if let Some(p) = phases {
        voice.set_phases(p)?;
    }
    voice.set_control_phase(control_phase)?;
    if let Some(phase) = lfo_phase {
        voice.set_lfo_phase(phase)?;
    }
    if let Some(phase) = lfo2_phase {
        voice.set_lfo2_phase(phase)?;
    }
    let mut events = Vec::new();
    for e in spec
        .get("events")
        .and_then(Value::as_array)
        .ok_or("case requires events array")?
    {
        let frame = integer(e, "frame", 0)?;
        let byte = |key, maximum| -> Result<u8, Box<dyn std::error::Error>> {
            let value = integer(e, key, 0)?;
            if value > maximum {
                return Err(format!("invalid event {key}").into());
            }
            Ok(value as u8)
        };
        let status = byte("status", 255)?;
        if frame > frames {
            return Err("event lies past case frames".into());
        }
        if !polyphonic && status & 0x0f != 0 {
            return Err("prototype only accepts MIDI channel 1".into());
        }
        if !polyphonic && !matches!(status & 0xf0, 0x80 | 0x90) {
            return Err("prototype only accepts note on/off events".into());
        }
        events.push(Event {
            frame,
            status,
            data1: byte("data1", 127)?,
            data2: byte("data2", 127)?,
        });
    }
    events.sort_by_key(|e| e.frame);
    if validate_only {
        let receipt = json!({
            "schema":1,"case":case_path,"name":spec.get("name"),
            "engine":"firmware-free JP8000 prototype","validation_only":true,
            "strict":true,"parameters_valid":true,"audio_rendered":false,
            "events_executed":false,"event_count":events.len(),
            "validation_scope":"Complete parameter validation plus event format and frame bounds. No settling, audio samples, runtime MIDI execution, or sound comparison.",
            "polyphonic":polyphonic,"requested_channels":channels,
            "sample_rate":NATIVE_SAMPLE_RATE,"frames_requested":frames,
            "settle_frames_requested":settle_frames,"resolved_patch_selection":resolved_patch_selection,
            "lower_part_status":lower_status,"unsupported_parameters":unsupported,
            "part_count":if polyphonic {2}else{1},"instrument_import_scope":if polyphonic {json!({"parts":["upper","lower"],"common":"performance and system controls","validation":"One final-state transaction; values and routing still have explicit supported bounds.","pedal":instrument_pedal_coverage()})}else{Value::Null},"resolved_patch_selections":resolved_patch_selections,"phase_override_scope":{"phases":"physical slot 0 only in --poly","lfo_phase":"Upper part only in --poly","lfo2_phase":"Upper part only in --poly"},"parameter_readback":parameter_readback,"ignored_case_fields":ignored_case_fields,"performance_import_atomic":polyphonic,
            "implemented_parameter_ids":IMPLEMENTED_PARAMETERS,"implemented_parameter_ids_scope":"comparison Voice sound controls only","voice_implemented_parameter_ids":IMPLEMENTED_PARAMETERS,"capability_scope":"This list describes shared Voice sound controls. Part/common values are accepted by atomic performance validation when --poly is selected.",
        });
        let text = serde_json::to_string_pretty(&receipt)?;
        if let Some(path) = report {
            fs::write(path, &text)?;
        }
        println!("{text}");
        return Ok(());
    }
    let start = Instant::now();
    let mut scratch = [0.0; MAX_RENDER_FRAMES * 2];
    let mut settled = 0;
    while settled < settle_frames {
        let n = (settle_frames - settled).min(block);
        voice.render(&mut scratch[..n * channels], tap, stereo);
        settled += n;
    }
    let settle_seconds = start.elapsed().as_secs_f64();
    let start = Instant::now();
    let mut audio = vec![0.0; frames * channels];
    let mut cursor = 0;
    let mut event_index = 0;
    while cursor < frames {
        while event_index < events.len() && events[event_index].frame <= cursor {
            voice.apply(events[event_index])?;
            event_index += 1;
        }
        let next_event = events.get(event_index).map(|e| e.frame).unwrap_or(frames);
        let n = (frames - cursor).min(block).min(next_event - cursor);
        voice.render(
            &mut audio[cursor * channels..(cursor + n) * channels],
            tap,
            stereo,
        );
        cursor += n;
    }
    let render_seconds = start.elapsed().as_secs_f64();
    if audio.iter().any(|v| !v.is_finite()) {
        return Err("nonfinite audio output".into());
    }
    if let Some(path) = output.as_deref() {
        write_wav(Path::new(path), &audio, channels as u16)?;
    }
    if let Some(path) = raw_output.as_deref() {
        let mut file = io::BufWriter::new(fs::File::create(path)?);
        for sample in &audio {
            file.write_all(&sample.to_le_bytes())?;
        }
        file.flush()?;
    }
    let mut receipt = json!({
        "schema":1,"case":case_path,"name":spec.get("name"),"engine":"firmware-free JP8000 prototype","diagnostic_allow_unsupported":!strict,"validation_only":false,"audio_rendered":true,
        "polyphonic":polyphonic,"voice_capacity":if polyphonic {8}else{1},"implemented_parameter_ids":IMPLEMENTED_PARAMETERS,"implemented_parameter_ids_scope":"comparison Voice sound controls only","voice_implemented_parameter_ids":IMPLEMENTED_PARAMETERS,"capability_scope":"This list describes shared Voice sound controls. Part/common values are accepted by atomic performance validation when --poly is selected.",
        "instrument_receive_channel_parameter":if polyphonic {Some(1002)}else{None::<u16>},"sample_rate":NATIVE_SAMPLE_RATE,"frames":frames,"settle_frames":settle_frames,
        "block_frames":block,"control_phase":control_phase,"lfo2_phase":lfo2_phase,"lfo_phase":lfo_phase,"tap":format!("{tap:?}"),"channels":channels,"samples":audio.len(),"channel_layout":if stereo {"interleaved left/right"} else {"left mono"},"wav_format":"IEEE float32",
        "model_status":{"load_timing":"approximate: fast cutoff ends at first future 100Hz tick; shape/detune/mix/resonance at second; original command transport is not replayed","pitch":"recovered coarse/fine exponential quantization, global and SuperSaw frequency caps","oscillator":"seven OSC1 algorithms plus Pulse/Saw/Triangle OSC2; one-frame mixer pipeline, exact sync phase/edge arithmetic and recovered ring/linearFM; feedback uses a generated bounded delay line, with unknown boot history",
            "supersaw":"piecewise detune/linear side mix, constant center and integer smoothing recovered; generic scalar defaults before allocation, recovered fast-load and ordinary smoothing arithmetic; unknown phase history","amp_envelope":"recovered 100Hz integer envelope, squared sustain and amp level, immediate attack and exact split-MAC gain smoothing",
            "filter":"recovered dual-SVF, joint cutoff/resonance, linear filter sustain, keyfollow, filter envelope and global LFO1 (triangle/saw/square/random); dynamic cutoff smoothing",
            "assignments":"per-note cached velocity and signed CC2/channel-pressure matrix for oscillator/filter/amp and shared LFO rates, plus global EQ/chorus/delay assignments; raw patch values preserved; unsupported active destinations rejected",
            "modulation":"shared100Hz LFO1 and triangle LFO2; internal tempo sync and phase resets; pitch/filter/amp, shape/PWM, common wheel pitch, LFO1/EG destinations including X-MOD; Feedback excitation FM with nominal delay period",
            "arpeggiator":if polyphonic {instrument_arpeggiator_coverage()}else{Value::Null},
            "lfo_fade":"voice-local LFO1 fade raw 0..127 with Morph/velocity assignments; 78 generated rates, 49 independently observed functional coefficients plus zero; recovered allocation/legato/release/free lifecycle; shared pan and LFO2 unfaded",
            "not_implemented":["remaining selector routes rejected by strict validation","runtime bank/program loading","external MIDI clock/transport"],
            "allocation":"eight fixed physical slots; source-derived ordered list, status-priority stealing, Poly/Mono key counters and release lookup; cached Mono selection and Feedback forced Mono; cold boot history and timestamp wrap remain bounded",
            "output":"recovered pre-filter DC blocker, bass/treble EQ, dry-path multipliers, stereo delay/chorus, manual/automatic pan and DAC divide; squared channel volume/expression and cached 12 dB resonance compensation"},
        "resolved_patch_selection":resolved_patch_selection,"resolved_patch_selections":resolved_patch_selections,"phase_override_scope":{"phases":"physical slot 0 only in --poly","lfo_phase":"Upper part only in --poly","lfo2_phase":"Upper part only in --poly"},"unsupported_parameters":unsupported,"lower_part_status":lower_status,"ignored_case_fields":ignored_case_fields,"parameter_readback":parameter_readback,"part_count":if polyphonic {2}else{1},"instrument_import_scope":if polyphonic {json!({"parts":["upper","lower"],"common":"performance and system controls","validation":"One final-state transaction; values and routing still have explicit supported bounds.","pedal":instrument_pedal_coverage()})}else{Value::Null},"performance_import_atomic":polyphonic,
        "settle_seconds":settle_seconds,"render_seconds":render_seconds,
        "render_realtime_ratio":(frames as f64/NATIVE_SAMPLE_RATE as f64)/render_seconds,
        "peak":audio.iter().map(|v|v.abs()).fold(0.0f32,f32::max),
        "rms":(audio.iter().map(|v|(*v as f64).powi(2)).sum::<f64>()/audio.len() as f64).sqrt(),
        "output":output,"raw_output":raw_output,
    });
    if let Some(iterations) = benchmark {
        if !(10..=1_000_000).contains(&iterations) {
            return Err("benchmark must be 10..1000000 iterations".into());
        }
        let benchmark_held_voices = voice.benchmark_on()?;
        for _ in 0..1000 {
            voice.render(&mut scratch[..block * channels], tap, stereo);
            std::hint::black_box(&scratch[..block * channels]);
        }
        let mut timings = vec![0.0f64; iterations];
        for timing in &mut timings {
            let now = Instant::now();
            voice.render(&mut scratch[..block * channels], tap, stereo);
            std::hint::black_box(&scratch[..block * channels]);
            *timing = now.elapsed().as_secs_f64() * 1e6;
        }
        timings.sort_unstable_by(f64::total_cmp);
        receipt["benchmark"] = json!({"iterations":iterations,"held_voices":benchmark_held_voices,"frames_per_call":block,"channels":channels,
            "median_us":timings[iterations/2],"p99_us":timings[(iterations*99/100).min(iterations-1)],
            "max_us":timings[iterations-1],"block_budget_us":block as f64/NATIVE_SAMPLE_RATE as f64*1e6,
            "scope":if polyphonic {"eight offline voices on this host; not native callback or end-to-end latency"} else {"single offline voice on this host; not native callback or end-to-end latency"}});
    }
    let receipt_text = serde_json::to_string_pretty(&receipt)?;
    if let Some(path) = report {
        fs::write(path, &receipt_text)?;
    }
    println!("{receipt_text}");
    Ok(())
}
fn integer(value: &Value, key: &str, default: usize) -> Result<usize, Box<dyn std::error::Error>> {
    match value.get(key) {
        None => Ok(default),
        Some(v) => Ok(v
            .as_u64()
            .ok_or("expected nonnegative integer")?
            .try_into()?),
    }
}
fn write_wav(path: &Path, samples: &[f32], channels: u16) -> io::Result<()> {
    if !matches!(channels, 1 | 2) || samples.len() % usize::from(channels) != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid audio channel layout",
        ));
    }
    let bytes = samples
        .len()
        .checked_mul(4)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n <= u32::MAX - 36)
        .ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "WAV exceeds RIFF size limit")
        })?;
    let mut out = io::BufWriter::new(fs::File::create(path)?);
    out.write_all(b"RIFF")?;
    out.write_all(&(36 + bytes).to_le_bytes())?;
    out.write_all(b"WAVEfmt ")?;
    out.write_all(&16u32.to_le_bytes())?;
    out.write_all(&3u16.to_le_bytes())?;
    out.write_all(&channels.to_le_bytes())?;
    out.write_all(&NATIVE_SAMPLE_RATE.to_le_bytes())?;
    out.write_all(&(NATIVE_SAMPLE_RATE * 4 * u32::from(channels)).to_le_bytes())?;
    out.write_all(&(channels * 4).to_le_bytes())?;
    out.write_all(&32u16.to_le_bytes())?;
    out.write_all(b"data")?;
    out.write_all(&bytes.to_le_bytes())?;
    for sample in samples {
        out.write_all(&sample.to_le_bytes())?;
    }
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pedal_receipt_distinguishes_midi_selector_support_from_physical_input() {
        let coverage = instrument_pedal_coverage();
        assert_eq!(coverage["accepted_selector_values"], json!([3, 11]));
        assert_eq!(coverage["physical_pedal_input"], json!(false));
        assert_eq!(coverage["adc_model"], json!(false));
        assert_eq!(coverage["remote_cc11"]["assignment3"], json!("expression"));
        assert_eq!(coverage["remote_cc11"]["assignment11"], json!("ignored"));
        assert_eq!(coverage["direct_cc11"], json!("expression"));
        for value in [3, 11] {
            assert_eq!(Jp8000Instrument::parameter_value_capability(2028, value), 2);
        }
    }

    #[test]
    fn arp_receipt_coverage_matches_the_active_value_predicate() {
        let coverage=instrument_arpeggiator_coverage();
        assert_eq!(coverage["mode_ids"],json!([0,1,2,3]));
        assert_eq!(coverage["pattern_ids"],json!([4,5,11,13,21,39,51]));
        assert!(coverage["unsupported"].as_array().unwrap().contains(&json!("RPS")));
        for (id,key,maximum) in [(2024,"mode_ids",4),(2025,"pattern_ids",89)] {
            for value in 0..=maximum {
                assert_eq!(coverage[key].as_array().unwrap().contains(&json!(value)),Jp8000Instrument::parameter_value_capability(id,value)==1);
            }
        }
    }

    #[test]
    fn stereo_renderer_preserves_frame_advancement_and_left_mono() {
        let mut mono = Engine::Voice(Jp8000Voice::new());
        let mut stereo = Engine::Voice(Jp8000Voice::new());
        for engine in [&mut mono, &mut stereo] {
            for (id, raw) in [(30, 5), (54, 0), (55, 0), (56, 127), (57, 0)] {
                engine.set_parameter(id, raw).unwrap();
            }
            engine
                .apply(Event {
                    frame: 0,
                    status: 0x90,
                    data1: 60,
                    data2: 100,
                })
                .unwrap();
        }
        let mut left = [0.0; 128];
        let mut pair = [0.0; 256];
        mono.render(&mut left, RenderTap::Output, false);
        stereo.render(&mut pair, RenderTap::Output, true);
        for (a, frame) in left.iter().zip(pair.chunks_exact(2)) {
            assert_eq!(a.to_bits(), frame[0].to_bits());
        }
        assert!(left.iter().any(|x| *x != 0.0));
    }
    #[test]
    fn stereo_wav_header_and_interleaving_are_exact() {
        let path =
            std::env::temp_dir().join(format!("jp8000-stereo-wav-{}.wav", std::process::id()));
        let samples = [0.25, -0.5, 0.75, -1.0];
        write_wav(&path, &samples, 2).unwrap();
        let bytes = fs::read(&path).unwrap();
        fs::remove_file(path).unwrap();
        assert_eq!(bytes.len(), 60);
        assert_eq!(&bytes[22..24], &2u16.to_le_bytes());
        assert_eq!(&bytes[28..32], &(NATIVE_SAMPLE_RATE * 8).to_le_bytes());
        assert_eq!(&bytes[32..34], &8u16.to_le_bytes());
        assert_eq!(&bytes[40..44], &16u32.to_le_bytes());
        for (sample, raw) in samples.iter().zip(bytes[44..].chunks_exact(4)) {
            assert_eq!(sample.to_le_bytes(), raw);
        }
    }
    #[test]
    fn bank_metadata_requires_complete_explicit_sound_controls() {
        let mut p = serde_json::Map::new();
        p.insert("1000".into(), json!(2));
        p.insert("1001".into(), json!(127));
        assert!(resolved_selection(&p).unwrap().is_none());
        for id in (16..=73)
            .chain((74..=126).step_by(2))
            .chain((256..=278).step_by(2))
            .chain([280, 281, 283])
            .chain((284..=362).step_by(2))
        {
            p.insert(id.to_string(), json!(0));
        }
        let result = resolved_selection(&p).unwrap().unwrap();
        assert_eq!(result["bank"], 2);
        assert_eq!(result["program"], 127);
        p.remove("336");
        assert!(resolved_selection(&p).unwrap().is_none());
        p.insert("336".into(), json!(127));
        p.insert("1001".into(), json!(128));
        assert!(resolved_selection(&p).is_err());
    }
}

#[cfg(test)]
mod performance_import_tests {
    use super::*;
    fn engine() -> Engine {
        Engine::Poly(Jp8000Instrument::new())
    }
    fn complete_patch(bank: u16, program: u16) -> Value {
        let voice = Jp8000Voice::new();
        let mut map = serde_json::Map::new();
        for id in (16..=73)
            .chain((74..=126).step_by(2))
            .chain((256..=278).step_by(2))
            .chain([280, 281, 283])
            .chain((284..=362).step_by(2))
        {
            map.insert(id.to_string(), json!(voice.parameter(id).unwrap()));
        }
        map.insert("1000".into(), json!(bank));
        map.insert("1001".into(), json!(program));
        Value::Object(map)
    }
    #[test]
    fn active_lower_map_is_rendered_and_read_back() {
        let spec = json!({"parameters":{"51":0,"2016":1},"lower_parameters":{
            "30":5,"31":0,"32":0,"38":0,"41":127,"42":0,"51":127,
            "54":0,"55":0,"56":127,"57":0,"62":0,"66":0,"1002":1}});
        let import = CaseImport::parse(&spec, true).unwrap();
        let mut e = engine();
        assert!(import.apply(&mut e, true).unwrap().is_empty());
        let read = import.readback(&e);
        assert_eq!(read["lower"]["30"], 5);
        assert_eq!(read["upper"]["51"], 0);
        e.apply(Event {
            frame: 0,
            status: 0x91,
            data1: 60,
            data2: 100,
        })
        .unwrap();
        let mut peak = 0.0f32;
        let mut out = [0.0; 256];
        for _ in 0..70 {
            e.render(&mut out, RenderTap::Output, true);
            peak = peak.max(out.iter().fold(0.0f32, |p, v| p.max(v.abs())));
        }
        assert!(
            peak > 0.001,
            "active Lower must produce audio, observed peak {peak}"
        );
        let Engine::Poly(p) = e else { unreachable!() };
        assert_eq!(p.held_voice_count(), 1);
    }
    #[test]
    fn lower_and_common_errors_never_fall_back_to_partial_performance() {
        for bad in [
            json!({"parameters":{"30":1,"31":100},"lower_parameters":{"41":128},"common_parameters":{"2016":1}}),
            json!({"parameters":{"30":1},"lower_parameters":{"30":5},"common_parameters":{"2019":101}}),
        ] {
            for strict in [true, false] {
                let import = CaseImport::parse(&bad, true).unwrap();
                let mut e = engine();
                let mut control = engine();
                let before = import.readback(&e);
                let err = import.apply(&mut e, strict).unwrap_err();
                assert!(err.contains("Poly performance imports are atomic"));
                assert!(err.contains("matching_requested_controls"));
                assert_eq!(before, import.readback(&e));
                for x in [&mut e, &mut control] {
                    x.apply(Event {
                        frame: 0,
                        status: 0x90,
                        data1: 60,
                        data2: 100,
                    })
                    .unwrap();
                }
                let (mut a, mut b) = ([0.0; 256], [0.0; 256]);
                for _ in 0..20 {
                    e.render(&mut a, RenderTap::Output, true);
                    control.render(&mut b, RenderTap::Output, true);
                    assert_eq!(a, b);
                }
            }
        }
    }
    #[test]
    fn scopes_and_numeric_aliases_cannot_conflict() {
        for spec in [
            json!({"parameters":{"2016":1},"common_parameters":{"2016":1}}),
            json!({"parameters":{"2016":1},"common_parameters":{"2016":2}}),
            json!({"parameters":{},"lower_parameters":{"2016":1}}),
            json!({"parameters":{},"common_parameters":{"30":5}}),
            json!({"parameters":{"30":5,"030":1}}),
            json!({"parameters":{},"lower_parameters":{"30":1.5}}),
            json!({"parameters":{},"common_parameters":[]}),
        ] {
            assert!(CaseImport::parse(&spec, true).is_err(), "{spec}");
        }
        let spec = json!({"parameters":{"30":5},"lower_parameters":{"30":1}});
        let p = CaseImport::parse(&spec, true).unwrap();
        let mut e = engine();
        p.apply(&mut e, true).unwrap();
        let got = p.readback(&e);
        assert_eq!(got["upper"]["30"], 5);
        assert_eq!(got["lower"]["30"], 1);
    }
    #[test]
    fn both_complete_selections_remain_metadata_only() {
        let spec = json!({"parameters":complete_patch(1,17),"lower_parameters":complete_patch(2,127),"common_parameters":{"2016":1}});
        let p = CaseImport::parse(&spec, true).unwrap();
        assert_eq!(p.resolved[0].as_ref().unwrap()["bank"], 1);
        assert_eq!(p.resolved[1].as_ref().unwrap()["program"], 127);
        assert!(!p.upper.ids.contains(&1000));
        assert!(!p.lower.ids.contains(&1001));
        let mut e = engine();
        p.apply(&mut e, true).unwrap();
        let Engine::Poly(inst) = e else {
            unreachable!()
        };
        assert_eq!(inst.part_parameter(0, 1000), Some(0));
        assert_eq!(inst.part_parameter(1, 1001), Some(0));
        let mut broken = spec.clone();
        broken["lower_parameters"]
            .as_object_mut()
            .unwrap()
            .remove("336");
        assert!(CaseImport::parse(&broken, true)
            .err()
            .unwrap()
            .contains("bank/program metadata"));
        let mut broken = spec;
        broken["lower_parameters"]["1001"] = json!(128);
        assert!(CaseImport::parse(&broken, true).is_err());
    }
    #[test]
    fn unresolved_bank_requests_are_not_loaded() {
        for bank in [0, 1] {
            let p = CaseImport::parse(
                &json!({"parameters":{"1000":bank,"1001":0},"lower_parameters":{}}),
                true,
            );
            assert!(p.err().unwrap().contains("bank/program metadata"));
        }
    }
    #[test]
    fn legacy_common_map_and_explicit_common_map_are_equivalent() {
        let a = CaseImport::parse(
            &json!({"parameters":{"30":5,"2016":1,"2019":25},"lower_parameters":{"30":6}}),
            true,
        )
        .unwrap();
        let b=CaseImport::parse(&json!({"parameters":{"30":5},"lower_parameters":{"30":6},"common_parameters":{"2016":1,"2019":25}}),true).unwrap();
        let (mut x, mut y) = (engine(), engine());
        a.apply(&mut x, true).unwrap();
        b.apply(&mut y, true).unwrap();
        assert_eq!(a.readback(&x), b.readback(&y));
        for e in [&mut x, &mut y] {
            for ch in [0x90, 0x91] {
                e.apply(Event {
                    frame: 0,
                    status: ch,
                    data1: 60,
                    data2: 100,
                })
                .unwrap();
            }
        }
        let (mut xa, mut ya) = ([0.0; 256], [0.0; 256]);
        for _ in 0..20 {
            x.render(&mut xa, RenderTap::Output, true);
            y.render(&mut ya, RenderTap::Output, true);
            assert_eq!(xa, ya);
        }
    }
}

#[cfg(test)]
mod release_midi_forwarding_tests {
    use super::*;

    fn rendered_release(status: u8, velocity: u8, assignment: u16) -> Vec<f32> {
        let mut engine = Engine::Voice(Jp8000Voice::new());
        engine.apply_patch(
            &[30, 23, 41, 42, 51, 54, 55, 56, 57, 283, 348],
            &[5, 0, 127, 0, 127, 0, 0, 127, 64, 1, assignment],
        ).unwrap();
        engine.apply(Event { frame: 0, status: 0x90, data1: 60, data2: 100 }).unwrap();
        let mut held = vec![0.0; 4096];
        engine.render(&mut held, RenderTap::Output, false);
        assert!(held.iter().any(|sample| *sample != 0.0));
        engine.apply(Event { frame: held.len(), status, data1: 60, data2: velocity }).unwrap();
        let mut release = vec![0.0; 16384];
        engine.render(&mut release, RenderTap::Output, false);
        release
    }

    #[test]
    fn explicit_off_velocity_changes_assigned_release_and_note_on_zero_means_off64() {
        let off_zero = rendered_release(0x80, 0, 254);
        let off_sixty_four = rendered_release(0x80, 64, 254);
        let on_zero = rendered_release(0x90, 0, 254);
        assert!(off_zero != off_sixty_four, "explicit Note Off release velocity was discarded");
        assert_eq!(on_zero, off_sixty_four);
        assert_eq!(rendered_release(0x80, 0, 127), rendered_release(0x80, 127, 127));
    }
}
