import Foundation
import Combine

struct Parameter: Decodable, Identifiable {
    let id: Int
    let key, label: String
    let min, max, step, defaultValue: Double
    let exponential: Bool
    let group: String
    let labels: [String]?
    func normalized(_ value: Double) -> Double {
        let v = Swift.min(max, Swift.max(min, value))
        return exponential ? log(v/min)/log(max/min) : (v-min)/(max-min)
    }
    func value(_ fraction: Double) -> Double {
        let raw = exponential ? min * pow(max/min, fraction) : min + fraction*(max-min)
        return Swift.min(max, Swift.max(min, min + ((raw-min)/step).rounded()*step))
    }
    func display(_ value: Double) -> String {
        if let labels, labels.indices.contains(Int(value.rounded() - min)) { return labels[Int(value.rounded() - min)] }
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
    let monoOutput: Bool?
    // Read the old mislabeled switch once; new saves only write monoOutput.
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
    @Published var monoOutput = false {
        didSet { bridge.setMonoOutput(monoOutput); persist() }
    }
    @Published var sustain = false
    @Published var running = false
    @Published var status = "Audio stopped"
    @Published var midiSources = "No MIDI keyboard connected"
    @Published var peak: Float = 0
    @Published var octave = 3
    @Published var notice = ""
    @Published var jpState: [String:Any] = ["ready":false,"status":"Preparing JP-8000", "part":0]
    private var jpSnapshot = ""
    private var jpPending: [Int:(value:Double, until:Date)] = [:]
    private var jpPendingPart: (value:Int, until:Date)?
    private var jpOperationStatus = ""
    private enum TouchRoute { case channels([UInt8]), experimentalJP }
    private var heldTouchRoutes: [Int:TouchRoute] = [:]
    private var touchSustainRoute: TouchRoute?
    var isJP: Bool { engine.id == 4 }
    var editsEnabled: Bool { !isJP || jpState["ready"] as? Bool == true }
    var isExperimentalJP: Bool { isJP && jpState["backend"] as? String == "rust-experimental" }
    func parameterEnabled(_ p: Parameter) -> Bool {
        guard editsEnabled else { return false }
        guard isExperimentalJP else { return true }
        return (jpState["supported_parameter_ids"] as? [Int] ?? []).contains(p.id)
    }
    private var poll: AnyCancellable?
    private let defaults: UserDefaults
    private let stateKey = "mdlr-last-instrument-state-v1"
    private var patchNames: [Int:String] = [:]
    var engine: EngineDefinition { engines[selected] }
    var voiceCount: Int { engine.voices }
    var groups: [String] {
        let preferred = ["Oscillators","Filter","Amplitude envelope","Filter envelope","Modulation","Output & character"]
        let available = engine.params.map(\.group)
        return (preferred + available.filter { !preferred.contains($0) }).reduce(into:[]) { groups, group in
            if available.contains(group) && !groups.contains(group) { groups.append(group) }
        }
    }
    init(defaults: UserDefaults = .standard, definitions: [EngineDefinition]? = nil) {
        self.defaults = defaults
        if let definitions { engines = definitions }
        else {
            let url = Bundle.main.url(forResource: "Engines", withExtension: "json")!
            var bundled = try! JSONDecoder().decode([EngineDefinition].self, from: Data(contentsOf:url))
            if let jpURL = Bundle.main.url(forResource:"JP8000Controls",withExtension:"json"),
               let data = try? Data(contentsOf:jpURL), let jp = try? JSONDecoder().decode(EngineDefinition.self,from:data) { bundled.append(jp) }
            if let monoURL = Bundle.main.url(forResource:"MonologueControls",withExtension:"json"),
               let data = try? Data(contentsOf:monoURL), let mono = try? JSONDecoder().decode(EngineDefinition.self,from:data) { bundled.append(mono) }
            engines = bundled
        }
        for e in engines {
            values[e.id] = Dictionary(uniqueKeysWithValues:e.params.map {($0.id,$0.defaultValue)})
            patchNames[e.id] = e.id == 4 ? "JP-8000":"Init"
        }
        if let data = defaults.data(forKey:stateKey),
           let saved = try? JSONDecoder().decode(LastInstrumentState.self,from:data), saved.version == 1 {
            for e in engines {
                // JP restores its complete firmware performance on the native worker.
                // Replaying individual controls here would overwrite both parts.
                guard e.id != 4, let patch = saved.patches[e.name] else { continue }
                for p in e.params {
                    guard let v = patch.values[p.key], v.isFinite else { continue }
                    values[e.id]?[p.id] = min(p.max,max(p.min,v))
                }
                patchNames[e.id] = patch.name
            }
            if let index = engines.firstIndex(where:{$0.name == saved.selectedEngine}) { selected = index }
            if saved.volume.isFinite { volume = min(1,max(0,saved.volume)) }
            velocitySensitive = saved.velocitySensitive ?? true
            monoOutput = saved.monoOutput ?? saved.monoMode ?? false
        }
        patchName = patchNames[selected] ?? "Init"
        section = groups.first ?? section
        bridge.selectEngine(selected)
        pushParameters()
        bridge.setMasterVolume(Float(volume))
        bridge.setVelocitySensitive(velocitySensitive)
        bridge.setMonoOutput(monoOutput)
        poll = Timer.publish(every: 0.1, on: .main, in: .common).autoconnect().sink { [weak self] _ in
            guard let self else { return }
            self.running = self.bridge.running; self.status = self.bridge.status
            self.midiSources = self.bridge.midiSources; self.peak = self.bridge.peak
            self.refreshJP()
            if self.bridge.droppedEvents > 0 { self.notice = "MIDI queue overflow: notes cleared. Reconnect the controller if this repeats." }
        }
    }
    func pushParameters() {
        guard !isJP else { return }
        for p in engine.params { bridge.setParameter(p.id,value:Float(value(p))) }
    }
    func refreshJP() {
        guard let definition = engines.first(where:{$0.id == 4}) else { return }
        let text = bridge.jpSnapshot
        guard text != jpSnapshot || !jpPending.isEmpty || jpPendingPart != nil, let data = text.data(using:.utf8),
              var snapshot = (try? JSONSerialization.jsonObject(with:data)) as? [String:Any] else { return }
        if let pending = jpPendingPart, pending.until > Date(), snapshot["part"] as? Int != pending.value { return }
        jpPendingPart = nil; jpSnapshot = text
        if let parameters = snapshot["params"] as? [String:NSNumber] {
            for p in definition.params {
                guard let number = parameters[String(p.id)], number.doubleValue.isFinite else { continue }
                let value = min(p.max,max(p.min,number.doubleValue))
                if let pending = jpPending[p.id], pending.until > Date(), value != pending.value { continue }
                jpPending.removeValue(forKey:p.id); values[4]?[p.id] = value
            }
        }
        // Keep the optimistic control value until the firmware acknowledges it.
        snapshot["params"] = Dictionary(uniqueKeysWithValues:(values[4] ?? [:]).map{(String($0.key),$0.value)})
        jpState = snapshot
        if isJP, let name = snapshot["patch_name"] as? String, !name.isEmpty {
            patchName = name; patchNames[4] = name
        }
        if let operation = snapshot["operation_status"] as? String {
            let key = "\(snapshot["operation_id"] ?? 0):\(operation)"
            guard key != jpOperationStatus else { return }
            jpOperationStatus = key
            if operation == "saved" { notice = "Saved both JP-8000 parts and the performance on this device." }
            if operation == "loaded" { notice = "Loaded your saved JP-8000 performance." }
            if operation == "error" { notice = snapshot["operation_error"] as? String ?? "The JP-8000 performance could not be saved or loaded. Try again." }
        }
    }
    func jpAction(_ action: String, value: Int) {
        guard isJP, editsEnabled else { return }
        let scopedPart = action == "part" && (jpState["supported_edit_parts"] as? [Int] ?? []).contains(value)
        guard !isExperimentalJP || scopedPart else { notice = "Firmware banks and panel actions are unavailable in experimental Rust."; return }
        switch action {
        case "part" where (0...2).contains(value):
            releaseTouchNotes(); jpPending.removeAll()
            jpPendingPart = (value,Date().addingTimeInterval(1))
            jpState["part"] = value; bridge.jpSelectPart(value)
        case "patch" where (0..<128).contains(value):
            panic(); jpPending.removeAll(); bridge.jpLoadPatch(value)
        case "performance" where (0..<64).contains(value):
            panic(); jpPending.removeAll(); bridge.jpLoadPerformance(value)
        case "panel" where Self.jpPanelButtons.contains(value):
            bridge.jpPressPanel(value)
        default: return
        }
    }
    static let jpPanelButtons: Set<Int> = [64,65,66,67,72,73,74,75,80,81,82,83,84,88,89,90,91,92,128,129,130,131,132,133,134,136,137,138,139,140,141,142,160,161,162,168,169,170,176,177,178,185,186]
    // Save on every edit; UserDefaults handles disk writes away from audio rendering.
    // Stable engine/parameter names keep saved controls independent of array ordering.
    private func persist() {
        let patches = Dictionary(uniqueKeysWithValues:engines.filter { $0.id != 4 }.map { e in
            (e.name, LastInstrumentState.Patch(values:Dictionary(uniqueKeysWithValues:e.params.map {
                ($0.key, values[e.id]?[$0.id] ?? $0.defaultValue)
            }), name:patchNames[e.id] ?? "Init"))
        })
        let state = LastInstrumentState(version:1,selectedEngine:engine.name,patches:patches,volume:volume,velocitySensitive:velocitySensitive,monoOutput:monoOutput,monoMode:nil)
        if let data = try? JSONEncoder().encode(state) { defaults.set(data,forKey:stateKey) }
    }
    private func rememberPatch(_ name: String) {
        patchName = name; patchNames[selected] = name; persist()
    }
    func select(_ id: Int) {
        guard engines.indices.contains(id), id != selected else {return}
        releaseTouchNotes()
        selected=id; sustain=false; patchName=patchNames[id] ?? "Init"
        if !groups.contains(section) {section=groups.first ?? "Controls"}
        bridge.selectEngine(id); pushParameters(); persist()
    }
    func value(_ p: Parameter) -> Double {values[selected]?[p.id] ?? p.defaultValue}
    func set(_ p: Parameter, _ v: Double) {
        guard v.isFinite, parameterEnabled(p) else { return }
        let clamped = min(p.max,max(p.min,isJP ? v.rounded():v))
        if isExperimentalJP {
            if p.id == 30, let waves = jpState["supported_waveforms"] as? [Int], !waves.contains(Int(clamped)) { return }
            if let choices = (jpState["supported_parameter_values"] as? [String:[Int]])?[String(p.id)], !choices.contains(Int(clamped)) { return }
        }
        values[selected]?[p.id]=clamped
        if isJP { jpPending[p.id] = (clamped,Date().addingTimeInterval(0.5)) }
        bridge.setParameter(p.id,value:Float(clamped)); rememberPatch("Edited")
    }
    func preset(_ preset: FactoryPreset?) {
        if isJP { jpAction("performance",value:0); return }
        panic()
        for p in engine.params {
            let v=preset?.values[String(p.id)] ?? p.defaultValue
            values[selected]?[p.id]=min(p.max,max(p.min,v))
        }
        pushParameters(); rememberPatch(preset?.name ?? "Init")
    }
    func save() {
        guard !isExperimentalJP else { notice = "Firmware performance saving is unavailable in experimental Rust."; return }
        guard editsEnabled else { notice = jpState["status"] as? String ?? "JP-8000 is not ready."; return }
        if isJP { bridge.jpSavePatch(); notice = "Saving JP-8000 performance…"; return }
        let data = try? JSONEncoder().encode(values[selected] ?? [:])
        defaults.set(data,forKey:"patch-\(selected)");notice="Saved this engine’s patch on this device."
    }
    func load() {
        guard !isExperimentalJP else { notice = "Firmware performance loading is unavailable in experimental Rust."; return }
        guard editsEnabled else { notice = jpState["status"] as? String ?? "JP-8000 is not ready."; return }
        if isJP { panic(); jpPending.removeAll(); bridge.jpRestorePatch(); notice = "Loading JP-8000 performance…"; return }
        guard let data=defaults.data(forKey:"patch-\(selected)"), let saved=try? JSONDecoder().decode([Int:Double].self,from:data) else {notice="No saved patch for this engine yet.";return}
        panic()
        for p in engine.params { values[selected]?[p.id]=min(p.max,max(p.min,saved[p.id] ?? p.defaultValue)) }
        pushParameters();rememberPatch("My patch");notice="Loaded your saved patch."
    }
    private var touchChannels: [UInt8] {
        guard isJP else { return [15] }
        let channels = jpState["midi_channels"] as? [Int] ?? [0,1]
        let part = jpState["part"] as? Int ?? 0
        let indices = part == 2 ? [0,1] : [part]
        return Array(Set(indices.compactMap { index -> UInt8? in
            guard channels.indices.contains(index), (0..<16).contains(channels[index]) else { return nil }
            return UInt8(channels[index])
        })).sorted()
    }
    private var touchRoute: TouchRoute { isExperimentalJP ? .experimentalJP : .channels(touchChannels) }
    @discardableResult private func sendTouch(_ route: TouchRoute, status: UInt8, data1: UInt8, data2: UInt8) -> Bool {
        switch route {
        case .experimentalJP:
            // The audio owner resolves committed Arp/Remote/part controls in
            // queue order. No wait for the UI's pending-value reconciliation.
            let accepted = bridge.sendJPTouchStatus(status,data1:data1,data2:data2)
            if !accepted { notice = "Touch input was not queued. Release and try again." }
            return accepted
        case .channels(let channels):
            for channel in channels { bridge.sendStatus(status | channel,data1:data1,data2:data2) }
            return true
        }
    }
    func note(_ note: Int, down: Bool) {
        guard (0...127).contains(note), !down || editsEnabled else { return }
        if down {
            guard heldTouchRoutes[note] == nil else { return }
            let route = touchRoute
            if sendTouch(route,status:0x90,data1:UInt8(note),data2:100) { heldTouchRoutes[note] = route }
        } else if let route = heldTouchRoutes.removeValue(forKey:note) {
            sendTouch(route,status:0x80,data1:UInt8(note),data2:0)
        }
    }
    func setSustain(_ enabled: Bool) {
        guard !enabled || editsEnabled else { sustain = false; return }
        if enabled {
            guard touchSustainRoute == nil else { return }
            let route = touchRoute
            if sendTouch(route,status:0xb0,data1:64,data2:127) { touchSustainRoute = route }
            else { sustain = false }
        } else if let route = touchSustainRoute {
            touchSustainRoute = nil
            sendTouch(route,status:0xb0,data1:64,data2:0)
        }
    }
    private func releaseTouchNotes() {
        for (note,route) in heldTouchRoutes { sendTouch(route,status:0x80,data1:UInt8(note),data2:0) }
        heldTouchRoutes.removeAll(); setSustain(false); sustain = false
    }
    func panic(){bridge.panic();heldTouchRoutes.removeAll();touchSustainRoute=nil;sustain=false}
    func startAudio(){if !bridge.running {_=bridge.start()};running=bridge.running;status=bridge.status}
    func toggleAudio(){if bridge.running {bridge.stop();running=bridge.running;status=bridge.status} else {startAudio()}}
}
