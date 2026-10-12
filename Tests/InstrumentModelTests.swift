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
    var monoOutput = false
    func selectEngine(_ id: Int) { engine = id; parameters = [:] }
    func setParameter(_ id: Int, value: Float) { parameters[id] = value }
    func setMasterVolume(_ value: Float) { master = value }
    func setVelocitySensitive(_ enabled: Bool) { velocitySensitive = enabled }
    func setMonoOutput(_ enabled: Bool) { monoOutput = enabled }
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
                model.select(2); model.volume = 0.37; model.velocitySensitive = false; model.monoOutput = true
                // Only the test forces a flush so a separate process can check disk state.
                assert(defaults.synchronize())
            } else {
                assert(mode == "verify")
                assert(model.selected == 2 && model.volume == 0.37)
                assert(!model.velocitySensitive && !model.bridge.velocitySensitive)
                assert(model.monoOutput && model.bridge.monoOutput && model.voiceCount == 1)
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
        assert(!model.monoOutput && !model.bridge.monoOutput && model.voiceCount == 5)
        model.sustain = true; model.monoOutput = true
        assert(model.bridge.monoOutput && model.sustain && model.voiceCount == 5, "Mono output must not release sustain or reduce polyphony")
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
            assert(model.monoOutput && model.bridge.monoOutput && model.voiceCount == e.voices)
        }
        model.select(2); model.volume = 0.37
        // A fresh model uses a new defaults handle, like an app relaunch.
        let restored = InstrumentModel(defaults:UserDefaults(suiteName:suite)!,definitions:definitions)
        assert(restored.selected == 2 && restored.bridge.engine == 2)
        assert(restored.volume == 0.37 && restored.bridge.master == Float(0.37))
        assert(!restored.velocitySensitive && !restored.bridge.velocitySensitive)
        assert(restored.monoOutput && restored.bridge.monoOutput && restored.voiceCount == 1)
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
        assert(final.monoOutput && final.bridge.monoOutput, "Presets and Init must preserve mono output")

        final.velocitySensitive = true
        let enabled = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(enabled.velocitySensitive && enabled.bridge.velocitySensitive, "Both toggle positions must restore")
        enabled.monoOutput = false
        let stereo = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(!stereo.monoOutput && !stereo.bridge.monoOutput)
        for e in definitions { stereo.select(e.id); assert(stereo.voiceCount == e.voices) }
        final.select(stereo.selected)

        // Migrate the old switch into mono audio without reducing voice allocation.
        let stateKey = "mdlr-last-instrument-state-v1"
        let baseline = try JSONSerialization.jsonObject(with:defaults.data(forKey:stateKey)!) as! [String:Any]
        for oldSetting in [false,true] {
            var old = baseline
            old.removeValue(forKey:"monoOutput"); old["monoMode"] = oldSetting
            defaults.set(try JSONSerialization.data(withJSONObject:old),forKey:stateKey)
            let migrated = InstrumentModel(defaults:defaults,definitions:definitions)
            assert(migrated.monoOutput == oldSetting && migrated.bridge.monoOutput == oldSetting)
            assert(migrated.values == final.values && migrated.volume == final.volume && migrated.selected == final.selected)
            assert(migrated.patchName == final.patchName)
            for e in definitions { migrated.select(e.id); assert(migrated.voiceCount == e.voices) }
            migrated.monoOutput = oldSetting
            let saved = try JSONSerialization.jsonObject(with:defaults.data(forKey:stateKey)!) as! [String:Any]
            assert(saved["monoMode"] == nil && saved["monoOutput"] as? Bool == oldSetting)
        }
        var both = baseline
        both["monoOutput"] = false; both["monoMode"] = true
        defaults.set(try JSONSerialization.data(withJSONObject:both),forKey:stateKey)
        assert(!InstrumentModel(defaults:defaults,definitions:definitions).monoOutput, "New output preference wins over legacy key")

        // Migrate the real pre-option JSON shape without discarding any patches.
        var legacy = baseline
        legacy.removeValue(forKey:"velocitySensitive")
        legacy.removeValue(forKey:"monoOutput")
        legacy.removeValue(forKey:"monoMode")
        defaults.set(try JSONSerialization.data(withJSONObject:legacy),forKey:stateKey)
        let migrated = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(migrated.velocitySensitive && migrated.bridge.velocitySensitive)
        assert(!migrated.monoOutput && !migrated.bridge.monoOutput)
        assert(migrated.values == final.values && migrated.selected == final.selected)
        assert(migrated.patchName == final.patchName && migrated.volume == final.volume)

        defaults.set(Data("broken".utf8),forKey:"mdlr-last-instrument-state-v1")
        let fallback = InstrumentModel(defaults:defaults,definitions:definitions)
        assert(fallback.selected == 0 && fallback.patchName == "Init")
        assert(fallback.velocitySensitive && fallback.bridge.velocitySensitive)
        assert(!fallback.monoOutput && !fallback.bridge.monoOutput)
        for e in definitions { for p in e.params { assert(fallback.values[e.id]?[p.id] == p.defaultValue) } }
        print("PASS: all 122 parameters and global velocity/mono-output options survive switching and relaunch; legacy saves preserve patches; normal voice counts, Save/Load, Init and corrupt-data fallback passed.")
    }
}
