// Compile with App/InstrumentModel.swift to exercise persistence without audio hardware.
import Foundation

final class SynthBridge {
    var running = false
    var status = "Audio stopped"
    var midiSources = ""
    var peak: Float = 0
    var droppedEvents = 0
    var engine = 0
    var jpSnapshot = "{}"
    var jpActions: [(String,Int)] = []
    var midi: [(UInt8,UInt8,UInt8)] = []
    var touchMidi: [(UInt8,UInt8,UInt8)] = []
    var acceptTouch = true
    func sendJPTouchStatus(_ status:UInt8,data1:UInt8,data2:UInt8) -> Bool {
        guard acceptTouch else { return false };touchMidi.append((status,data1,data2));return true
    }
    func jpSelectPart(_ value: Int) { jpActions.append(("part",value)) }
    func jpLoadPatch(_ value: Int) { jpActions.append(("patch",value)) }
    func jpLoadPerformance(_ value: Int) { jpActions.append(("performance",value)) }
    func jpPressPanel(_ value: Int) { jpActions.append(("panel",value)) }
    func jpSavePatch() { jpActions.append(("save",0)) }
    func jpRestorePatch() { jpActions.append(("load",0)) }
    var parameters: [Int:Float] = [:]
    var master: Float = 0
    var velocitySensitive = false
    var monoOutput = false
    func selectEngine(_ id: Int) { engine = id; parameters = [:] }
    func setParameter(_ id: Int, value: Float) { parameters[id] = value }
    func setMasterVolume(_ value: Float) { master = value }
    func setVelocitySensitive(_ enabled: Bool) { velocitySensitive = enabled }
    func setMonoOutput(_ enabled: Bool) { monoOutput = enabled }
    func sendStatus(_ status: UInt8, data1: UInt8, data2: UInt8) { midi.append((status,data1,data2)) }
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
        // The firmware engine restores complete native state, not synthetic defaults.
        let jpURL = URL(fileURLWithPath:CommandLine.arguments[1]).deletingLastPathComponent().appendingPathComponent("JP8000Controls.json")
        let jpDefinition = try JSONDecoder().decode(EngineDefinition.self,from:Data(contentsOf:jpURL))
        let jpModel = InstrumentModel(defaults:defaults,definitions:definitions + [jpDefinition])
        jpModel.select(4)
        assert(jpModel.bridge.parameters.isEmpty, "Selecting JP must not overwrite its firmware state with UI defaults")
        assert(jpModel.voiceCount == 8 && !jpModel.groups.isEmpty)
        jpModel.bridge.jpSnapshot = "{\"ready\":true,\"part\":1,\"params\":{\"41\":73},\"midi_channels\":[4,7],\"patch_name\":\"Native patch\"}"
        jpModel.refreshJP()
        assert(jpModel.values[4]?[41] == 73 && jpModel.patchName == "Native patch")
        jpModel.note(60,down:true); jpModel.note(60,down:false)
        assert(jpModel.bridge.midi.suffix(2).map{$0.0} == [0x97,0x87], "Touch MIDI must follow the selected part's receive channel")
        jpModel.jpAction("part",value:2)
        jpModel.note(61,down:true); jpModel.note(61,down:false)
        assert(jpModel.bridge.midi.suffix(4).map{$0.0} == [0x94,0x97,0x84,0x87], "BOTH must play both receive channels")
        let actionCount = jpModel.bridge.jpActions.count
        jpModel.jpAction("part",value:3); jpModel.jpAction("patch",value:128); jpModel.jpAction("panel",value:255)
        assert(jpModel.bridge.jpActions.count == actionCount)
        jpModel.preset(nil)
        assert(jpModel.bridge.jpActions.last?.0 == "performance" && jpModel.bridge.parameters.isEmpty)
        jpModel.save(); assert(jpModel.bridge.jpActions.last?.0 == "save")
        jpModel.load(); assert(jpModel.bridge.jpActions.last?.0 == "load")
        let jpRestored = InstrumentModel(defaults:defaults,definitions:definitions + [jpDefinition])
        assert(jpRestored.selected == 4 && jpRestored.bridge.parameters.isEmpty)
        let cutoff = jpDefinition.params.first{$0.id == 41}!
        assert(!jpRestored.editsEnabled)
        jpRestored.set(cutoff,91.8); jpRestored.jpAction("performance",value:0)
        jpRestored.save(); jpRestored.load(); jpRestored.note(60,down:true)
        jpRestored.setSustain(true)
        assert(jpRestored.bridge.parameters.isEmpty && jpRestored.bridge.jpActions.isEmpty && jpRestored.bridge.midi.isEmpty, "Startup must reject edits, preset actions, storage actions and fresh notes at the model boundary")
        jpRestored.bridge.jpSnapshot = jpModel.bridge.jpSnapshot
        jpRestored.refreshJP(); assert(jpRestored.editsEnabled)
        jpRestored.set(cutoff,91.8)
        assert(jpRestored.bridge.parameters[41] == 92, "Firmware parameter bytes must be integers")
        assert(jpDefinition.params.first{$0.id == 2022}!.display(4) == "Lower 2 · Upper 6")
        jpRestored.bridge.jpSnapshot = "{\"ready\":true,\"backend\":\"rust-experimental\",\"part\":0,\"params\":{\"41\":73,\"30\":5},\"supported_parameter_ids\":[30,41],\"supported_waveforms\":[0,5],\"midi_channels\":[0,16]}"
        jpRestored.refreshJP()
        let effect = jpDefinition.params.first{$0.id == 61}!
        let wave = jpDefinition.params.first{$0.id == 30}!
        assert(jpRestored.isExperimentalJP && jpRestored.parameterEnabled(cutoff) && !jpRestored.parameterEnabled(effect))
        let beforeRustValues = jpRestored.bridge.parameters
        let beforeRustActions = jpRestored.bridge.jpActions.count
        jpRestored.set(effect,1); jpRestored.set(wave,1)
        jpRestored.jpAction("patch",value:0); jpRestored.save(); jpRestored.load()
        assert(jpRestored.bridge.parameters == beforeRustValues && jpRestored.bridge.jpActions.count == beforeRustActions, "Experimental UI rejects unsupported controls, waves and firmware actions")
        jpRestored.set(wave,0)
        assert(jpRestored.bridge.parameters[30] == 0)
        let osc2 = jpDefinition.params.first{$0.id == 33}!
        assert(!jpRestored.parameterEnabled(osc2))
        jpRestored.bridge.jpSnapshot = #"{"ready":true,"backend":"rust-experimental","part":0,"params":{"41":73,"30":5,"33":0},"supported_parameter_ids":[30,33,34,41],"supported_waveforms":[0,1,2,3,4,5,6],"midi_channels":[0,16]}"#
        jpRestored.refreshJP()
        assert(jpRestored.parameterEnabled(osc2) && !jpRestored.parameterEnabled(effect))
        jpRestored.set(osc2,2); jpRestored.set(wave,4)
        assert(jpRestored.bridge.parameters[33] == 2 && jpRestored.bridge.parameters[30] == 4, "New ABI capabilities and waveforms must enable controls without a hardcoded UI list")
        jpRestored.bridge.jpSnapshot = #"{"ready":true,"backend":"rust-experimental","part":0,"params":{"2024":3,"2025":51},"supported_parameter_ids":[2023,2024,2025,2026,2027],"supported_parameter_values":{"2024":[0,1,2],"2025":[4]},"midi_channels":[0,1]}"#
        jpRestored.refreshJP()
        let arpMode = jpDefinition.params.first{$0.id == 2024}!
        let arpPattern = jpDefinition.params.first{$0.id == 2025}!
        let beforeEnumChanges = jpRestored.bridge.parameters
        jpRestored.set(arpMode,3); jpRestored.set(arpMode,4); jpRestored.set(arpPattern,51)
        assert(jpRestored.bridge.parameters == beforeEnumChanges)
        assert(jpRestored.value(arpMode) == 3 && jpRestored.value(arpPattern) == 51, "Unsupported stored values stay visible until an accepted edit")
        jpRestored.set(arpMode,2); jpRestored.set(arpPattern,4)
        assert(jpRestored.bridge.parameters[2024] == 2 && jpRestored.bridge.parameters[2025] == 4)
        jpRestored.bridge.jpSnapshot = #"{"ready":true,"backend":"rust-experimental","part":0,"params":{"2024":2,"2025":4},"supported_parameter_ids":[2023,2024,2025,2026,2027],"supported_parameter_values":{"2024":[0,1,2,3],"2025":[4]},"midi_channels":[0,1]}"#
        jpRestored.refreshJP();jpRestored.set(arpMode,3)
        assert(jpRestored.bridge.parameters[2024] == 3 && jpRestored.value(arpMode) == 3, "Random becomes editable from the engine value capability snapshot")
        print("PASS: experimental JP capabilities reject unsupported controls and enum values, preserve readback, and react to updated ABI coverage.")
        // Experimental touch events carry no guessed MIDI channel. The host
        // resolves controls in the same queue, including pending/rejected edits.
        let touchDefaults=UserDefaults(suiteName:"touch-routing-"+UUID().uuidString)!
        let touch=InstrumentModel(defaults:touchDefaults,definitions:definitions+[jpDefinition])
        touch.select(4)
        touch.bridge.jpSnapshot = #"{"ready":true,"backend":"rust-experimental","part":0,"params":{"2023":0,"3009":2},"supported_parameter_ids":[2023,3009,2018],"supported_edit_parts":[0,1,2],"midi_channels":[0,1]}"#
        touch.refreshJP()
        let arpSwitch=jpDefinition.params.first{$0.id==2023}!
        let remoteChannel=jpDefinition.params.first{$0.id==3009}!
        touch.set(arpSwitch,1);touch.set(remoteChannel,5)
        touch.note(60,down:true);touch.note(60,down:true)
        assert(touch.bridge.midi.isEmpty && touch.bridge.touchMidi.count==1)
        assert(touch.bridge.touchMidi[0].0==0x90 && touch.bridge.touchMidi[0].1==60)
        // Even incomplete snapshots and rejected optimistic values cannot
        // overwrite a gesture's release route.
        touch.bridge.jpSnapshot = #"{"ready":true,"backend":"rust-experimental","state_syncing":true}"#
        touch.refreshJP();touch.note(60,down:false);touch.note(60,down:false)
        assert(touch.bridge.touchMidi.count==2 && touch.bridge.touchMidi.last!.0==0x80)
        touch.setSustain(true);touch.setSustain(true)
        assert(touch.bridge.touchMidi.count==3 && touch.bridge.touchMidi.last!.2==127)
        touch.bridge.jpSnapshot = #"{"ready":false,"status":"Audio changing"}"#
        touch.refreshJP();touch.setSustain(false)
        assert(touch.bridge.touchMidi.count==4 && touch.bridge.touchMidi.last!.2==0)
        touch.bridge.jpSnapshot = #"{"ready":true,"backend":"rust-experimental","part":0,"supported_edit_parts":[0,1,2]}"#
        touch.refreshJP();touch.bridge.acceptTouch=false
        touch.note(61,down:true);touch.note(61,down:false);touch.setSustain(true)
        assert(touch.bridge.touchMidi.count==4 && !touch.sustain && !touch.notice.isEmpty)
        touch.bridge.acceptTouch=true;touch.note(61,down:true);touch.setSustain(true)
        touch.jpAction("part",value:1)
        assert(touch.bridge.touchMidi.suffix(2).map{$0.0}==[0x80,0xb0])
        assert(touch.bridge.jpActions.last!.0=="part")
        let beforePanic=touch.bridge.touchMidi.count
        touch.note(62,down:true);touch.panic();touch.note(62,down:false)
        assert(touch.bridge.touchMidi.count==beforePanic+1)
        touch.note(-1,down:true);touch.note(128,down:true)
        assert(touch.bridge.touchMidi.count==beforePanic+1)
        var key=TouchKeyOrigin()
        assert(key.press(60)==60 && key.press(72)==nil)
        assert(key.release()==60 && key.release()==nil)
        assert(key.press(72)==72 && key.release()==72)
        print("PASS: typed touch queue, pending/syncing snapshots, original release route, duplicate gestures, fail-fast errors, part edits, panic and octave changes.")
        let monoURL = jpURL.deletingLastPathComponent().appendingPathComponent("MonologueControls.json")
        let monoDefinition = try JSONDecoder().decode(EngineDefinition.self,from:Data(contentsOf:monoURL))
        let allDefinitions = definitions + [jpDefinition,monoDefinition]
        let mono = InstrumentModel(defaults:defaults,definitions:allDefinitions)
        mono.select(5)
        assert(mono.engine.id == 5 && mono.bridge.engine == 5 && mono.voiceCount == 1 && !mono.isJP)
        assert(monoDefinition.params.count == 48 && Set(monoDefinition.params.map(\.id)).count == 48)
        for p in monoDefinition.params {
            assert(mono.value(p) == p.defaultValue && mono.bridge.parameters[p.id] == Float(p.defaultValue))
        }
        let monoCutoff = monoDefinition.params.first{$0.id == 9}!
        let octave2 = monoDefinition.params.first{$0.id == 6}!
        let tuning = monoDefinition.params.first{$0.id == 59}!
        assert(octave2.min == -1 && octave2.max == 2 && octave2.display(-1) == "16′")
        mono.set(monoCutoff,2); assert(mono.value(monoCutoff) == 1)
        mono.set(monoCutoff,.nan); assert(mono.value(monoCutoff) == 1)
        mono.set(tuning,-12); mono.set(octave2,-1); mono.save()
        let monoSaved = mono.values[5]
        mono.preset(monoDefinition.presets[0]); assert(mono.patchName == "Round bass")
        mono.load(); assert(mono.values[5] == monoSaved && mono.patchName == "My patch")
        mono.note(60,down:true); mono.note(60,down:false)
        assert(mono.bridge.midi.suffix(2).map{$0.0} == [0x9f,0x8f], "Monologue touch notes use the ordinary Rust MIDI route")
        mono.select(4); mono.select(5)
        assert(mono.values[5] == monoSaved && mono.bridge.parameters[59] == -12)
        let monoRestored = InstrumentModel(defaults:defaults,definitions:allDefinitions)
        assert(monoRestored.selected == 5 && monoRestored.values[5] == monoSaved && monoRestored.patchName == "My patch")
        monoRestored.preset(nil)
        for p in monoDefinition.params { assert(monoRestored.value(p) == p.defaultValue) }
        print("PASS: monologue metadata, defaults, parameter bounds, touch MIDI, preset/save/load, engine switching and relaunch persistence.")
        print("PASS: native JP state is preserved on selection/relaunch; metadata, touch MIDI parts, action validation and native Save/Load routing passed.")
        print("PASS: all 122 parameters and global velocity/mono-output options survive switching and relaunch; legacy saves preserve patches; normal voice counts, Save/Load, Init and corrupt-data fallback passed.")
    }
}
