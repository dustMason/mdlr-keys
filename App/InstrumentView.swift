import SwiftUI

struct InstrumentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model=InstrumentModel()
    @State private var originalPanel=true
    @State private var panelZoom=1.0
    @State private var keyboardVisible=false
    @State private var optionsVisible=false
    private var accent: Color { [Color(red:1,green:0.54,blue:0.32),.cyan,Color(red:0.79,green:0.85,blue:0.48),Color(red:0.93,green:0.42,blue:0.61),Color(red:0.96,green:0.54,blue:0.29),Color(red:0.86,green:0.20,blue:0.18)][model.selected] }
    var body: some View {
        GeometryReader { geometry in
            VStack(spacing:4) {
                toolbar
                if originalPanel {
                    OriginalPanelView(model:model,zoom:panelZoom).frame(maxWidth:.infinity,maxHeight:.infinity)
                } else {
                    ScrollView(.horizontal,showsIndicators:false) {
                        HStack(spacing:8) {ForEach(model.groups,id:\.self){group in
                            Button(group){model.section=group}.font(.system(size:12,weight:.semibold))
                                .padding(.horizontal,12).frame(height:44)
                                .background(model.section==group ? Color.white.opacity(0.14):Color.clear,in:Capsule())
                                .foregroundStyle(model.section==group ? .white:.gray)
                        }}.buttonStyle(.plain)
                    }
                    if !model.editsEnabled {
                        Text(model.jpState["status"] as? String ?? "Starting JP-8000…")
                            .font(.caption).foregroundStyle(accent).padding(.horizontal,8)
                    }
                    ScrollView {
                        LazyVGrid(columns:[GridItem(.adaptive(minimum:geometry.size.width<700 ? 160:205),spacing:12)],spacing:12) {
                            ForEach(model.engine.params.filter{$0.group==model.section}) { p in
                                ParameterControl(parameter:p,value:Binding(get:{model.value(p)},set:{model.set(p,$0)}),accent:accent).disabled(!model.parameterEnabled(p))
                            }
                        }.padding(8).disabled(!model.editsEnabled)
                    }.frame(maxHeight:.infinity)
                }
                if keyboardVisible {
                    HStack(spacing:12) {
                        Text(model.midiSources).font(.system(size:11)).lineLimit(1)
                        Spacer()
                        Button {model.panic();model.octave=max(0,model.octave-1)} label:{Image(systemName:"minus").frame(width:44,height:44)}
                        Text("C\(model.octave)–B\(model.octave+1)").font(.system(size:12,design:.monospaced))
                        Button {model.panic();model.octave=min(7,model.octave+1)} label:{Image(systemName:"plus").frame(width:44,height:44)}
                        Toggle("Sustain",isOn:$model.sustain).toggleStyle(.button).frame(height:44)
                            .onChange(of:model.sustain){v in model.setSustain(v)}
                            .disabled(!model.editsEnabled)
                    }.buttonStyle(.plain).tint(accent).padding(.horizontal,8)
                    PianoKeyboard(baseNote:(model.octave+1)*12,accent:accent){note,down in model.note(note,down:down)}
                        .id("\(model.selected)-\(model.octave)").frame(height:geometry.size.height<650 ? 100:130)
                        .padding(.horizontal,4).disabled(!model.editsEnabled)
                        .opacity(model.editsEnabled ? 1:0.4)
                }
                if !model.notice.isEmpty {
                    HStack {Text(model.notice).font(.caption);Spacer();Button("Dismiss"){model.notice=""}.frame(minHeight:44)}
                        .foregroundStyle(accent).padding(.horizontal,8)
                }
            }
#if os(iOS)
            // Leave a small finger landing area inside the physical screen edge.
            .padding(EdgeInsets(top:6,leading:12,bottom:6,trailing:12))
#endif
            .background(Color(red:0.065,green:0.075,blue:0.082))
        }
        .onAppear {if scenePhase == .active {model.startAudio()}}
        .onChange(of:scenePhase) {phase in if phase == .active {model.startAudio()}}
    }
    private var toolbar: some View {
        HStack(spacing:4) {
            HStack(spacing:2) {
                ForEach(model.engines) { e in
                    Button {model.select(e.id)} label: {
                        Text(e.name).font(.system(size:12,weight:.bold,design:.monospaced))
                            .frame(width:e.id == 5 ? 96:e.id == 4 ? 72:48,height:44)
                            .foregroundStyle(model.selected==e.id ? .black:.white.opacity(0.6))
                            .background(model.selected==e.id ? accent:Color.clear,in:RoundedRectangle(cornerRadius:6))
                            .contentShape(Rectangle())
                    }.accessibilityLabel("Select \(e.name), \(e.voices == 1 ? "monophonic":"\(e.voices) voices")")
                }
            }.background(Color.white.opacity(0.04),in:RoundedRectangle(cornerRadius:6))
            Menu {
                Button(model.isJP ? "Factory performance 01":"Init"){model.preset(nil)}
                ForEach(model.engine.presets.indices,id:\.self){i in Button(model.engine.presets[i].name){model.preset(model.engine.presets[i])}}
                Divider();Button("Save my patch"){model.save()};Button("Load my patch"){model.load()}
            } label: {
                Text(model.patchName).font(.system(size:12,weight:.medium)).lineLimit(1).frame(minWidth:60,maxWidth:160,minHeight:44,alignment:.leading).padding(.horizontal,6).contentShape(Rectangle())
            }.accessibilityLabel("Preset: \(model.patchName)").disabled(!model.editsEnabled)
            Spacer(minLength:0)
            Button {
                if keyboardVisible {model.sustain=false;model.setSustain(false)}
                keyboardVisible.toggle()
            } label:{Image(systemName:"pianokeys").frame(width:44,height:44).background(keyboardVisible ? accent.opacity(0.2):Color.clear,in:RoundedRectangle(cornerRadius:6)).contentShape(Rectangle())}
                .accessibilityLabel(keyboardVisible ? "Hide keyboard":"Show keyboard")
            Button {model.toggleAudio()} label:{Image(systemName:model.running ? "stop.fill":"play.fill").frame(width:44,height:44).foregroundStyle(.black).background(accent,in:RoundedRectangle(cornerRadius:6)).contentShape(Rectangle())}
                .accessibilityLabel(model.running ? "Stop audio":"Start audio")
            Button {optionsVisible.toggle()} label:{Image(systemName:"ellipsis").frame(width:44,height:44).contentShape(Rectangle())}
                .accessibilityLabel("Instrument options")
                .popover(isPresented:$optionsVisible){options.padding(20).frame(width:310).preferredColorScheme(.dark)}
        }.buttonStyle(.plain).tint(accent).padding(.horizontal,6).padding(.vertical,2)
    }
    private var options: some View {
        VStack(alignment:.leading,spacing:14) {
            HStack {Text("mdlr").font(.title2.bold());Spacer();Button("Done"){optionsVisible=false}.frame(minHeight:44)}
            Text("\(model.engine.name) · \(model.voiceCount == 1 ? "monophonic":"\(model.voiceCount) voices")").font(.caption).foregroundStyle(.secondary)
            HStack {Text("Master");Slider(value:$model.volume,in:0...1).accessibilityLabel("Master volume")}
            VStack(alignment:.leading,spacing:4) {
                Toggle("Mono output",isOn:$model.monoOutput).toggleStyle(.switch).frame(minHeight:44)
                Text("Same sound in both outputs. Keeps each synth’s polyphony.").font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment:.leading,spacing:4) {
                Toggle("Velocity sensitivity",isOn:$model.velocitySensitive).toggleStyle(.switch).frame(minHeight:44)
                Text("All engines. Off plays every note at full velocity.").font(.caption).foregroundStyle(.secondary)
            }
            Picker("Controls",selection:$originalPanel){Text("Original panel").tag(true);Text("All controls").tag(false)}.pickerStyle(.segmented).labelsHidden()
            if originalPanel {Picker("Panel size",selection:$panelZoom){Text("Fill screen").tag(1.0);Text("150%").tag(1.5);Text("200%").tag(2.0)}}
            Text("Drag knobs up or down. Hold Shift for fine adjustment with a keyboard.").font(.caption).foregroundStyle(.secondary)
            Divider()
            Text(model.status).font(.caption.monospaced())
            Text(model.midiSources).font(.caption)
            Text(model.isJP ? "USB MIDI · upper/lower receive channels follow the performance":"USB MIDI · all channels · CC1 mod · CC64 sustain · bend ±2").font(.caption2).foregroundStyle(.secondary)
            Button("Panic — release all notes"){model.panic()}.frame(minHeight:44)
        }.tint(accent)
    }
}

struct ParameterControl: View {
    let parameter: Parameter
    @Binding var value: Double
    let accent: Color
    var body: some View {
        VStack(alignment:.leading,spacing:17) {
            HStack {Text(parameter.label).font(.system(size:12,weight:.semibold));Spacer();Text(parameter.display(value)).font(.system(size:12,design:.monospaced)).foregroundStyle(accent)}
            Slider(value:Binding(get:{parameter.normalized(value)},set:{value=parameter.value($0)}),in:0...1)
                .tint(accent).accessibilityLabel(parameter.label).accessibilityValue(parameter.display(value))
        }.padding(16).background(Color.white.opacity(0.045),in:RoundedRectangle(cornerRadius:12))
    }
}
