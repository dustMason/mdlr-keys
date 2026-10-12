// Compile with App/InstrumentModel.swift to exercise persistence without audio hardware.
import Foundation

final class SynthBridge {
    var running = false
    var status = "Audio stopped"
    var midiSources = ""
    var peak: Float = 0
    var droppedEvents = 0
    var engine = 0
    var parameters: [Int:Float] = [:]
    var master: Float = 0
    var velocitySensitive = false
    var monoMode = false
    func selectEngine(_ id: Int) { engine = id; parameters = [:] }
    func setParameter(_ id: Int, value: Float) { parameters[id] = value }
    func setMasterVolume(_ value: Float) { master = value }
    func setVelocitySensitive(_ enabled: Bool) { velocitySensitive = enabled }
    func setMonoMode(_ enabled: Bool) { monoMode = enabled }
    func sendStatus(_ status: UInt8, data1: UInt8, data2: UInt8) {}
    func panic() {}
    func start() -> Bool { running = true; return true }
    func stop() { running = false }
}

@main struct InstrumentModelTests {
    @MainActor static func main() throws {
        let definitions = try JSONDecoder().decode([EngineDefinition].self,
            from:Data(contentsOf:URL(fileURLWithPath:CommandLine.arguments[1])))
        if CommandLine.arguments.count == 4 {
            let mode = CommandLine.arguments[2], suite = CommandLine.arguments[3]
            let defaults = UserDefaults(suiteName:suite)!
            let model = InstrumentModel(defaults:defaults,definitions:definitions)
            if mode == "seed" {
                for e in definitions {
                    model.select(e.id)
                    for p in e.params { model.set(p,p.value(0.31 + Double(e.id)*0.13)) }
                }
                model.select(2); model.volume = 0.37; model.velocitySensitive = false; model.monoMode = true
                // Only the test forces a flush so a separate process can check disk state.
                assert(defaults.synchronize())
            } else {
                assert(mode == "verify")
                assert(model.selected == 2 && model.volume == 0.37)
                assert(!model.velocitySensitive && !model.bridge.velocitySensitive)
                assert(model.monoMode && model.bridge.monoMode && model.voiceCount == 1)
                for e in definitions {
                    model.select(e.id)
                    assert(model.patchName == "Edited")
                    for p in e.params { assert(model.value(p) == p.value(0.31 + Double(e.id)*0.13)) }
                }
                defaults.removePersistentDomain(forName:suite)
                print("PASS: separate process restored all four engines from disk.")
            }
            return
        }
        let suite = "mdlr-persistence-test-" + UUID().uuidString
        let defaults = UserDefaults(suiteName:suite)!
        defer { defaults.removePersistentDomain(forName:suite) }
        let model = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(model.velocitySensitive && model.bridge.velocitySensitive, "New installs keep velocity response enabled")
        assert(!model.monoMode && !model.bridge.monoMode && model.voiceCount == 5)
        model.sustain = true; model.monoMode = true
        assert(model.bridge.monoMode && !model.sustain)
        model.velocitySensitive = false
        assert(!model.bridge.velocitySensitive)
        var expected: [Int:[Int:Double]] = [:]
        for e in definitions {
            model.select(e.id)
            for p in e.params { model.set(p,p.value(0.31 + Double(e.id)*0.13)) }
            expected[e.id] = model.values[e.id]
        }
        for e in definitions {
            model.select(e.id)
            assert(model.values[e.id] == expected[e.id], "Switching changed \(e.name)")
            assert(model.patchName == "Edited")
            for p in e.params { assert(model.bridge.parameters[p.id] == Float(expected[e.id]![p.id]!)) }
            assert(!model.velocitySensitive && !model.bridge.velocitySensitive, "Engine switching must keep the global option")
            assert(model.monoMode && model.bridge.monoMode && model.voiceCount == 1)
        }
        model.select(2); model.volume = 0.37
        // A fresh model uses a new defaults handle, like an app relaunch.
        let restored = InstrumentModel(defaults:UserDefaults(suiteName:suite)!,definitions:definitions)
        assert(restored.selected == 2 && restored.bridge.engine == 2)
        assert(restored.volume == 0.37 && restored.bridge.master == Float(0.37))
        assert(!restored.velocitySensitive && !restored.bridge.velocitySensitive)
        assert(restored.monoMode && restored.bridge.monoMode && restored.voiceCount == 1)
        assert(restored.values == expected, "All four engines must survive relaunch")
        assert(!restored.running && !restored.sustain, "Do not restore held notes or start audio")
        for p in restored.engine.params { assert(restored.bridge.parameters[p.id] == Float(expected[2]![p.id]!)) }

        restored.preset(restored.engine.presets[0])
        let presetName = restored.patchName
        restored.save()
        let savedValues = restored.values[2]
        restored.set(restored.engine.params[0],restored.engine.params[0].max)
        restored.load()
        assert(restored.values[2] == savedValues && restored.patchName == "My patch")
        restored.select(0); restored.preset(nil)
        let final = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(final.selected == 0 && final.patchName == "Init")
        final.select(2)
        assert(final.patchName == "My patch" && final.values[2] == savedValues)
        final.preset(final.engine.presets[0]); final.select(3); final.select(2)
        assert(final.patchName == presetName, "Preset labels belong to each engine")
        assert(!final.velocitySensitive && !final.bridge.velocitySensitive, "Presets, Init, Save/Load and Panic must preserve velocity preference")
        assert(final.monoMode && final.bridge.monoMode, "Presets and Init must preserve mono mode")

        final.velocitySensitive = true
        let enabled = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(enabled.velocitySensitive && enabled.bridge.velocitySensitive, "Both toggle positions must restore")
        enabled.monoMode = false
        let poly = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(!poly.monoMode && !poly.bridge.monoMode)
        for e in definitions { poly.select(e.id); assert(poly.voiceCount == e.voices) }
        final.select(poly.selected)

        // Migrate the real pre-option JSON shape without discarding any patches.
        let stateKey = "mdlr-last-instrument-state-v1"
        var legacy = try JSONSerialization.jsonObject(with:defaults.data(forKey:stateKey)!) as! [String:Any]
        legacy.removeValue(forKey:"velocitySensitive")
        legacy.removeValue(forKey:"monoMode")
        defaults.set(try JSONSerialization.data(withJSONObject:legacy),forKey:stateKey)
        let migrated = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(migrated.velocitySensitive && migrated.bridge.velocitySensitive)
        assert(!migrated.monoMode && !migrated.bridge.monoMode)
        assert(migrated.values == final.values && migrated.selected == final.selected)
        assert(migrated.patchName == final.patchName && migrated.volume == final.volume)

        defaults.set(Data("broken".utf8),forKey:"mdlr-last-instrument-state-v1")
        let fallback = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(fallback.selected == 0 && fallback.patchName == "Init")
        assert(fallback.velocitySensitive && fallback.bridge.velocitySensitive)
        assert(!fallback.monoMode && !fallback.bridge.monoMode)
        for e in definitions { for p in e.params { assert(fallback.values[e.id]?[p.id] == p.defaultValue) } }
        print("PASS: all 122 parameters and global velocity/mono options survive switching and relaunch; legacy saves preserve patches; voice counts, Save/Load, Init and corrupt-data fallback passed.")
    }
}
