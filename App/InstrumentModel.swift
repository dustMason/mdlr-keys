import Foundation
import Combine

struct Parameter: Decodable, Identifiable {
    let id: Int
    let key, label: String
    let min, max, step, defaultValue: Double
    let exponential: Bool
    let group: String
    func normalized(_ value: Double) -> Double {
        let v = Swift.min(max, Swift.max(min, value))
        return exponential ? log(v/min)/log(max/min) : (v-min)/(max-min)
    }
    func value(_ fraction: Double) -> Double {
        let raw = exponential ? min * pow(max/min, fraction) : min + fraction*(max-min)
        return Swift.min(max, Swift.max(min, min + ((raw-min)/step).rounded()*step))
    }
    func display(_ value: Double) -> String {
        if key == "topology" { return ["Chain","Split","Pairs","Cross","Fork","Merge","Dual","Trio","Pure"][Swift.min(8,Swift.max(0,Int(value.rounded())))] }
        if exponential { return value < 1 ? String(format: "%.0f ms", value*1000) : String(format: "%.2f s", value) }
        return step >= 1 ? String(format: "%.0f",value) : String(format: "%.2f",value)
    }
}
struct FactoryPreset: Decodable { let name: String; let values: [String:Double] }
struct EngineDefinition: Decodable, Identifiable {
    let id: Int
    let name: String
    let voices: Int
    let params: [Parameter]
    let presets: [FactoryPreset]
}

private struct LastInstrumentState: Codable {
    struct Patch: Codable {
        let values: [String:Double]
        let name: String
    }
    let version: Int
    let selectedEngine: String
    let patches: [String:Patch]
    let volume: Double
    // Optional so saved patches from earlier builds still decode unchanged.
    let velocitySensitive: Bool?
    let monoMode: Bool?
}

@MainActor final class InstrumentModel: ObservableObject {
    let engines: [EngineDefinition]
    let bridge = SynthBridge()
    @Published var selected = 0
    @Published var values: [Int:[Int:Double]] = [:]
    @Published var section = "Oscillators"
    @Published var patchName = "Init"
    @Published var volume = 0.65 {
        didSet { bridge.setMasterVolume(Float(volume)); persist() }
    }
    @Published var velocitySensitive = true {
        didSet { bridge.setVelocitySensitive(velocitySensitive); persist() }
    }
    @Published var monoMode = false {
        didSet { bridge.setMonoMode(monoMode); sustain=false; persist() }
    }
    @Published var sustain = false
    @Published var running = false
    @Published var status = "Audio stopped"
    @Published var midiSources = "No MIDI keyboard connected"
    @Published var peak: Float = 0
    @Published var octave = 3
    @Published var notice = ""
    private var poll: AnyCancellable?
    private let defaults: UserDefaults
    private let stateKey = "mdlr-last-instrument-state-v1"
    private var patchNames: [Int:String] = [:]
    var engine: EngineDefinition { engines[selected] }
    var voiceCount: Int { monoMode ? 1 : engine.voices }
    var groups: [String] {
        ["Oscillators","Filter","Amplitude envelope","Filter envelope","Modulation","Output & character"].filter { g in engine.params.contains { $0.group == g } }
    }
    init(defaults: UserDefaults = .standard, definitions: [EngineDefinition]? = nil) {
        self.defaults = defaults
        if let definitions { engines = definitions }
        else {
            let url = Bundle.main.url(forResource: "Engines", withExtension: "json")!
            engines = try! JSONDecoder().decode([EngineDefinition].self, from: Data(contentsOf:url))
        }
        for e in engines {
            values[e.id] = Dictionary(uniqueKeysWithValues:e.params.map {($0.id,$0.defaultValue)})
            patchNames[e.id] = "Init"
        }
        if let data = defaults.data(forKey:stateKey),
           let saved = try? JSONDecoder().decode(LastInstrumentState.self,from:data), saved.version == 1 {
            for e in engines {
                guard let patch = saved.patches[e.name] else { continue }
                for p in e.params {
                    guard let v = patch.values[p.key], v.isFinite else { continue }
                    values[e.id]?[p.id] = min(p.max,max(p.min,v))
                }
                patchNames[e.id] = patch.name
            }
            if let index = engines.firstIndex(where:{$0.name == saved.selectedEngine}) { selected = index }
            if saved.volume.isFinite { volume = min(1,max(0,saved.volume)) }
            velocitySensitive = saved.velocitySensitive ?? true
            monoMode = saved.monoMode ?? false
        }
        patchName = patchNames[selected] ?? "Init"
        section = groups.first ?? section
        bridge.selectEngine(selected)
        pushParameters()
        bridge.setMasterVolume(Float(volume))
        bridge.setVelocitySensitive(velocitySensitive)
        bridge.setMonoMode(monoMode)
        poll = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            guard let self else { return }
            self.running = self.bridge.running; self.status = self.bridge.status
            self.midiSources = self.bridge.midiSources; self.peak = self.bridge.peak
            if self.bridge.droppedEvents > 0 { self.notice = "MIDI queue overflow: notes cleared. Reconnect the controller if this repeats." }
        }
    }
    func pushParameters() { for p in engine.params { bridge.setParameter(p.id,value:Float(value(p))) } }
    // Save on every edit; UserDefaults handles disk writes away from audio rendering.
    // Stable engine/parameter names keep saved controls independent of array ordering.
    private func persist() {
        let patches = Dictionary(uniqueKeysWithValues:engines.map { e in
            (e.name, LastInstrumentState.Patch(values:Dictionary(uniqueKeysWithValues:e.params.map {
                ($0.key, values[e.id]?[$0.id] ?? $0.defaultValue)
            }), name:patchNames[e.id] ?? "Init"))
        })
        let state = LastInstrumentState(version:1,selectedEngine:engine.name,patches:patches,volume:volume,velocitySensitive:velocitySensitive,monoMode:monoMode)
        if let data = try? JSONEncoder().encode(state) { defaults.set(data,forKey:stateKey) }
    }
    private func rememberPatch(_ name: String) {
        patchName = name; patchNames[selected] = name; persist()
    }
    func select(_ id: Int) {
        guard engines.indices.contains(id), id != selected else {return}
        selected=id; sustain=false; patchName=patchNames[id] ?? "Init"
        if !groups.contains(section) {section=groups[0]}
        bridge.selectEngine(id); pushParameters(); persist()
    }
    func value(_ p: Parameter) -> Double {values[selected]?[p.id] ?? p.defaultValue}
    func set(_ p: Parameter, _ v: Double) {
        guard v.isFinite else { return }
        let clamped = min(p.max,max(p.min,v))
        values[selected]?[p.id]=clamped; bridge.setParameter(p.id,value:Float(clamped)); rememberPatch("Edited")
    }
    func preset(_ preset: FactoryPreset?) {
        panic()
        for p in engine.params {
            let v=preset?.values[String(p.id)] ?? p.defaultValue
            values[selected]?[p.id]=min(p.max,max(p.min,v))
        }
        pushParameters(); rememberPatch(preset?.name ?? "Init")
    }
    func save() {
        let data = try? JSONEncoder().encode(values[selected] ?? [:])
        defaults.set(data,forKey:"patch-\(selected)");notice="Saved this engine’s patch on this device."
    }
    func load() {
        guard let data=defaults.data(forKey:"patch-\(selected)"), let saved=try? JSONDecoder().decode([Int:Double].self,from:data) else {notice="No saved patch for this engine yet.";return}
        panic()
        for p in engine.params { values[selected]?[p.id]=min(p.max,max(p.min,saved[p.id] ?? p.defaultValue)) }
        pushParameters();rememberPatch("My patch");notice="Loaded your saved patch."
    }
    func note(_ note: Int, down: Bool) {bridge.sendStatus(down ? 0x9f:0x8f,data1:UInt8(note),data2:down ? 100:0)}
    func panic(){bridge.panic();sustain=false}
    func startAudio(){if !bridge.running {_=bridge.start()};running=bridge.running;status=bridge.status}
    func toggleAudio(){if bridge.running {bridge.stop();running=bridge.running;status=bridge.status} else {startAudio()}}
}
