import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type {
  JackDefinition,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./MidiModule.css";

const VOICES = 4;
const CC_OUTPUTS = 4;
const MIDI_ZERO_NOTE = 36;

const PARAM_CHANNEL = 0;
const PARAM_MODE = 1;
const PARAM_CC_MAP_BASE = 10;
const PARAM_VOICE_CV_BASE = 100;
const PARAM_VOICE_GATE_BASE = PARAM_VOICE_CV_BASE + VOICES;
const PARAM_CC_VALUE_BASE = PARAM_VOICE_GATE_BASE + VOICES;

const defaultCcMap = [1, 74, 71, 11] as const;
const ccLabels: Record<number, string> = {
  1: "mod",
  2: "breath",
  7: "volume",
  10: "pan",
  11: "expression",
  64: "sustain",
  71: "resonance",
  72: "release",
  73: "attack",
  74: "cutoff",
  91: "reverb",
  93: "chorus",
};

type MidiStatus = "idle" | "connecting" | "ready" | "unsupported" | "denied";

interface MidiMessageEventLike extends Event {
  data: Uint8Array;
  receivedTime?: number;
}

interface MidiInputLike extends EventTarget {
  id: string;
  name: string | null;
  manufacturer: string | null;
  state?: "connected" | "disconnected";
}

interface MidiAccessLike {
  inputs: Map<string, MidiInputLike>;
  onstatechange: ((event: Event) => void) | null;
}

interface ActiveVoice {
  note: number;
  velocity: number;
  order: number;
}

interface MidiDiagnostics {
  eventAgeMs: number | null;
  handlerMs: number;
  eventCount: number;
  lastMessage: string;
}

const params = [
  param(PARAM_CHANNEL, "channel", "channel", 1, 1, 16, 1),
  param(PARAM_MODE, "mode", "mode", 0, 0, 1, 1),
  ...Array.from({ length: CC_OUTPUTS }, (_, index) =>
    param(
      ccMapParamId(index),
      `cc${index + 1}`,
      `cc ${index + 1}`,
      defaultCcMap[index],
      0,
      127,
      1,
    ),
  ),
] satisfies ParamDefinition[];

const ccOptions = Array.from({ length: 128 }, (_, cc) => ({
  cc,
  label: ccLabels[cc] ? `${cc} ${ccLabels[cc]}` : `${cc}`,
}));

export const midiDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.midi,
  slug: "midi",
  name: "MIDI",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 604,
  minHeight: 206,
  inputs: [],
  outputs: [...voiceOutputs(), ...ccOutputs()],
  params,
  Component: MidiModule,
};

function MidiModule(props: ModuleRenderProps) {
  const { module, onParamChange, onRuntimeParamChange } = props;
  const [status, setStatus] = useState<MidiStatus>("idle");
  const [inputNames, setInputNames] = useState<string[]>([]);
  const [voiceDisplays, setVoiceDisplays] =
    useState<Array<ActiveVoice | null>>(emptyVoiceDisplays);
  const [ccValues, setCcValues] = useState(
    () => Array(CC_OUTPUTS).fill(0) as number[],
  );
  const [diagnostics, setDiagnostics] = useState<MidiDiagnostics>(() =>
    emptyDiagnostics(),
  );
  const midiAccessRef = useRef<MidiAccessLike | null>(null);
  const boundInputsRef = useRef(new Set<MidiInputLike>());
  const activeVoicesRef =
    useRef<Array<ActiveVoice | null>>(emptyVoiceDisplays());
  const pendingVoiceDisplaysRef =
    useRef<Array<ActiveVoice | null>>(emptyVoiceDisplays());
  const pendingCcValuesRef = useRef(Array(CC_OUTPUTS).fill(0) as number[]);
  const pendingDiagnosticsRef = useRef<MidiDiagnostics>(emptyDiagnostics());
  const displayFrameRef = useRef(0);
  const voiceOrderRef = useRef(0);
  const moduleIdRef = useRef(module.id);
  const runtimeChangeRef = useRef(onRuntimeParamChange);
  const channel = clampChannel(module.params[PARAM_CHANNEL]);
  const monoMode = clampMode(module.params[PARAM_MODE]) === 1;
  const ccMap = useMemo(
    () =>
      Array.from({ length: CC_OUTPUTS }, (_, index) =>
        clampCc(module.params[ccMapParamId(index)], defaultCcMap[index]),
      ),
    [module.params],
  );
  const channelRef = useRef(channel);
  const monoModeRef = useRef(monoMode);
  const ccMapRef = useRef(ccMap);
  const heldNotesRef = useRef<ActiveVoice[]>([]);
  const handlerRef = useRef<(event: MidiMessageEventLike) => void>(() => {});
  const midiListenerRef = useRef((event: Event) => {
    handlerRef.current(event as MidiMessageEventLike);
  });

  handlerRef.current = handleMidiMessage;

  useEffect(() => {
    moduleIdRef.current = module.id;
  }, [module.id]);

  useEffect(() => {
    runtimeChangeRef.current = onRuntimeParamChange;
  }, [onRuntimeParamChange]);

  useEffect(() => {
    channelRef.current = channel;
    clearAllVoices();
  }, [channel]);

  useEffect(() => {
    monoModeRef.current = monoMode;
    clearAllVoices();
  }, [monoMode]);

  useEffect(() => {
    ccMapRef.current = ccMap;
  }, [ccMap]);

  useEffect(() => {
    return () => {
      unbindMidiInputs();
      if (displayFrameRef.current) {
        window.cancelAnimationFrame(displayFrameRef.current);
        displayFrameRef.current = 0;
      }
      const access = midiAccessRef.current;
      if (access) {
        access.onstatechange = null;
      }
    };
  }, []);

  async function connectMidi() {
    const midiNavigator = navigator as Navigator & {
      requestMIDIAccess?: (options?: {
        sysex?: boolean;
      }) => Promise<MidiAccessLike>;
    };
    if (!midiNavigator.requestMIDIAccess) {
      setStatus("unsupported");
      return;
    }

    setStatus("connecting");
    try {
      const access = await midiNavigator.requestMIDIAccess.call(navigator, {
        sysex: false,
      });
      midiAccessRef.current = access;
      access.onstatechange = () => refreshMidiInputs(access);
      refreshMidiInputs(access);
      setStatus("ready");
    } catch {
      setStatus("denied");
    }
  }

  function refreshMidiInputs(access: MidiAccessLike) {
    unbindMidiInputs();
    const listener = midiListenerRef.current;
    const inputs = Array.from(access.inputs.values()).filter(
      (input) => input.state !== "disconnected",
    );
    for (const input of inputs) {
      input.addEventListener("midimessage", listener);
      boundInputsRef.current.add(input);
    }
    setInputNames(inputs.map(inputLabel));
  }

  function unbindMidiInputs() {
    const listener = midiListenerRef.current;
    for (const input of boundInputsRef.current) {
      input.removeEventListener("midimessage", listener);
    }
    boundInputsRef.current.clear();
  }

  function handleMidiMessage(event: MidiMessageEventLike) {
    const handlerStart = performance.now();
    const [statusByte = 0, data1 = 0, data2 = 0] = event.data;
    if (statusByte < 0x80 || statusByte >= 0xf0) {
      return;
    }

    const messageChannel = (statusByte & 0x0f) + 1;
    if (messageChannel !== channelRef.current) {
      return;
    }

    const command = statusByte & 0xf0;
    let messageLabel = "";
    if (command === 0x90 && data2 > 0) {
      noteOn(data1, data2);
      messageLabel = `on ${midiNoteName(data1)}`;
    } else if (command === 0x80 || (command === 0x90 && data2 === 0)) {
      noteOff(data1);
      messageLabel = `off ${midiNoteName(data1)}`;
    } else if (command === 0xb0) {
      controlChange(data1, data2);
      messageLabel = `cc ${data1}`;
    }

    if (messageLabel) {
      publishDiagnostics(event, handlerStart, messageLabel);
    }
  }

  function noteOn(note: number, velocity: number) {
    if (monoModeRef.current) {
      monoNoteOn(note, velocity);
      return;
    }

    const voices = activeVoicesRef.current;
    let voice = voices.findIndex((candidate) => candidate?.note === note);
    if (voice === -1) {
      voice = voices.findIndex((candidate) => candidate === null);
    }
    if (voice === -1) {
      voice = oldestVoiceIndex(voices);
    }

    voices[voice] = {
      note,
      velocity,
      order: (voiceOrderRef.current += 1),
    };
    sendRuntimeParam(voiceCvParamId(voice), midiNoteToCv(note));
    sendRuntimeParam(voiceGateParamId(voice), 1);
    publishVoiceDisplays(voices);
  }

  function noteOff(note: number) {
    if (monoModeRef.current) {
      monoNoteOff(note);
      return;
    }

    const voices = activeVoicesRef.current;
    const voice = voices.findIndex((candidate) => candidate?.note === note);
    if (voice === -1) {
      return;
    }

    voices[voice] = null;
    sendRuntimeParam(voiceGateParamId(voice), 0);
    publishVoiceDisplays(voices);
  }

  function monoNoteOn(note: number, velocity: number) {
    const held = heldNotesRef.current.filter((candidate) => candidate.note !== note);
    const activeNote = {
      note,
      velocity,
      order: (voiceOrderRef.current += 1),
    };
    held.push(activeNote);
    heldNotesRef.current = held;

    const voices = emptyVoiceDisplays();
    voices[0] = activeNote;
    activeVoicesRef.current = voices;
    sendRuntimeParam(voiceCvParamId(0), midiNoteToCv(note));
    sendRuntimeParam(voiceGateParamId(0), 1);
    for (let voice = 1; voice < VOICES; voice += 1) {
      sendRuntimeParam(voiceGateParamId(voice), 0);
    }
    publishVoiceDisplays(voices);
  }

  function monoNoteOff(note: number) {
    const held = heldNotesRef.current.filter((candidate) => candidate.note !== note);
    heldNotesRef.current = held;
    const nextNote = held.at(-1);
    const voices = emptyVoiceDisplays();

    if (nextNote) {
      voices[0] = nextNote;
      activeVoicesRef.current = voices;
      sendRuntimeParam(voiceCvParamId(0), midiNoteToCv(nextNote.note));
      sendRuntimeParam(voiceGateParamId(0), 1);
    } else {
      activeVoicesRef.current = voices;
      sendRuntimeParam(voiceGateParamId(0), 0);
    }
    publishVoiceDisplays(voices);
  }

  function controlChange(cc: number, rawValue: number) {
    if (cc === 120 || cc === 121 || cc === 123) {
      clearAllVoices();
    }

    const mappedOutputs = ccMapRef.current
      .map((mappedCc, index) => (mappedCc === cc ? index : -1))
      .filter((index) => index >= 0);
    if (mappedOutputs.length === 0) {
      return;
    }

    const value = rawValue / 127;
    for (const output of mappedOutputs) {
      sendRuntimeParam(ccValueParamId(output), value);
    }
    const next = [...pendingCcValuesRef.current];
    for (const output of mappedOutputs) {
      next[output] = value;
    }
    publishCcValues(next);
  }

  function clearAllVoices() {
    heldNotesRef.current = [];
    activeVoicesRef.current = emptyVoiceDisplays();
    for (let voice = 0; voice < VOICES; voice += 1) {
      sendRuntimeParam(voiceGateParamId(voice), 0);
    }
    publishVoiceDisplays(activeVoicesRef.current);
  }

  function sendRuntimeParam(paramId: number, value: number) {
    runtimeChangeRef.current(moduleIdRef.current, paramId, value);
  }

  function publishVoiceDisplays(voices: Array<ActiveVoice | null>) {
    pendingVoiceDisplaysRef.current = [...voices];
    scheduleDisplayPublish();
  }

  function publishCcValues(values: number[]) {
    pendingCcValuesRef.current = [...values];
    scheduleDisplayPublish();
  }

  function publishDiagnostics(
    event: MidiMessageEventLike,
    handlerStart: number,
    messageLabel: string,
  ) {
    const now = performance.now();
    pendingDiagnosticsRef.current = {
      eventAgeMs:
        typeof event.receivedTime === "number"
          ? Math.max(0, handlerStart - event.receivedTime)
          : null,
      handlerMs: now - handlerStart,
      eventCount: pendingDiagnosticsRef.current.eventCount + 1,
      lastMessage: messageLabel,
    };
    scheduleDisplayPublish();
  }

  function scheduleDisplayPublish() {
    if (displayFrameRef.current) {
      return;
    }
    displayFrameRef.current = window.requestAnimationFrame(() => {
      displayFrameRef.current = 0;
      setVoiceDisplays([...pendingVoiceDisplaysRef.current]);
      setCcValues([...pendingCcValuesRef.current]);
      setDiagnostics({ ...pendingDiagnosticsRef.current });
    });
  }

  return (
    <ModuleShell {...props}>
      <div className="midiPanel">
        <section className="midiAccessPanel" aria-label="MIDI access">
          <div className="midiStatusDisplay">
            <span
              className={`midiStatusLight midiStatus-${status}`}
              aria-hidden="true"
            />
            <strong>{statusLabel(status)}</strong>
            <span>{inputSummary(status, inputNames)}</span>
          </div>
          <div className="midiLatencyDisplay" aria-label="MIDI timing">
            <span>event {formatMidiMs(diagnostics.eventAgeMs)}</span>
            <span>main {formatMidiMs(diagnostics.handlerMs)}</span>
            <span>{diagnostics.lastMessage || "no events"}</span>
          </div>
          <button
            type="button"
            className="midiConnectButton"
            onClick={connectMidi}
            disabled={status === "connecting"}
          >
            {status === "ready" ? "scan" : "connect"}
          </button>
        </section>

        <section className="midiConfigPanel" aria-label="MIDI configuration">
          <label className="midiConfigControl midiConfigControlChannel">
            <span>channel</span>
            <select
              value={channel}
              onChange={(event) =>
                onParamChange(
                  module.id,
                  PARAM_CHANNEL,
                  Number(event.target.value),
                )
              }
            >
              {Array.from({ length: 16 }, (_, index) => index + 1).map(
                (option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="midiConfigControl">
            <span>mode</span>
            <select
              value={monoMode ? 1 : 0}
              onChange={(event) =>
                onParamChange(module.id, PARAM_MODE, Number(event.target.value))
              }
            >
              <option value={0}>poly</option>
              <option value={1}>mono</option>
            </select>
          </label>
        </section>

        <div className="midiVoicePanel" aria-label="MIDI voices">
          {voiceDisplays.map((voice, index) => (
            <span
              key={index}
              className={voice ? "isActive" : ""}
              style={
                {
                  "--midi-velocity": voice
                    ? (voice.velocity / 127).toFixed(3)
                    : "0",
                } as CSSProperties
              }
            >
              <strong>{index + 1}</strong>
              <em>{voice ? midiNoteName(voice.note) : "--"}</em>
            </span>
          ))}
        </div>

        <div className="midiCcPanel" aria-label="CC to CV mapping">
          {ccMap.map((mappedCc, index) => (
            <label key={index} className="midiCcControl">
              <span>cv {index + 1}</span>
              <select
                value={mappedCc}
                onChange={(event) =>
                  onParamChange(
                    module.id,
                    ccMapParamId(index),
                    Number(event.target.value),
                  )
                }
              >
                {ccOptions.map((option) => (
                  <option key={option.cc} value={option.cc}>
                    {option.label}
                  </option>
                ))}
              </select>
              <i
                aria-hidden="true"
                style={
                  {
                    "--midi-level": ccValues[index].toFixed(3),
                  } as CSSProperties
                }
              />
            </label>
          ))}
        </div>
      </div>
    </ModuleShell>
  );
}

function voiceOutputs(): JackDefinition[] {
  return Array.from({ length: VOICES }, (_, voice) => [
    {
      id: voice * 2,
      label: `${voice + 1} cv`,
      kind: "cv" as const,
      connectionGroup: `voice-${voice + 1}-out`,
      connectionGroupLabel: `${voice + 1}`,
      connectionGroupOrder: voice,
      connectionOrder: 0,
      connectionLabel: "CV",
    },
    {
      id: voice * 2 + 1,
      label: `${voice + 1} gate`,
      kind: "gate" as const,
      connectionGroup: `voice-${voice + 1}-out`,
      connectionGroupLabel: `${voice + 1}`,
      connectionGroupOrder: voice,
      connectionOrder: 1,
      connectionLabel: "GATE",
    },
  ]).flat();
}

function ccOutputs(): JackDefinition[] {
  return Array.from({ length: CC_OUTPUTS }, (_, index) => ({
    id: VOICES * 2 + index,
    label: `cc ${index + 1}`,
    kind: "cv" as const,
    connectionGroup: "cc-out",
    connectionGroupLabel: "CC",
    connectionGroupOrder: VOICES,
    connectionOrder: index,
    connectionLabel: `${index + 1}`,
  }));
}

function param(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue };
}

function ccMapParamId(index: number) {
  return PARAM_CC_MAP_BASE + index;
}

function voiceCvParamId(voice: number) {
  return PARAM_VOICE_CV_BASE + voice;
}

function voiceGateParamId(voice: number) {
  return PARAM_VOICE_GATE_BASE + voice;
}

function ccValueParamId(output: number) {
  return PARAM_CC_VALUE_BASE + output;
}

function clampChannel(value: number | undefined) {
  return clampInteger(value ?? 1, 1, 16);
}

function clampMode(value: number | undefined) {
  return clampInteger(value ?? 0, 0, 1);
}

function clampCc(value: number | undefined, fallback: number) {
  return clampInteger(value ?? fallback, 0, 127);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function emptyVoiceDisplays(): Array<ActiveVoice | null> {
  return Array.from({ length: VOICES }, () => null);
}

function emptyDiagnostics(): MidiDiagnostics {
  return {
    eventAgeMs: null,
    handlerMs: 0,
    eventCount: 0,
    lastMessage: "",
  };
}

function oldestVoiceIndex(voices: Array<ActiveVoice | null>) {
  let oldestIndex = 0;
  let oldestOrder = Number.POSITIVE_INFINITY;
  for (let index = 0; index < voices.length; index += 1) {
    const voice = voices[index];
    if (voice && voice.order < oldestOrder) {
      oldestOrder = voice.order;
      oldestIndex = index;
    }
  }
  return oldestIndex;
}

function midiNoteToCv(note: number) {
  return (note - MIDI_ZERO_NOTE) / 12;
}

function midiNoteName(note: number) {
  const names = [
    "C",
    "C#",
    "D",
    "D#",
    "E",
    "F",
    "F#",
    "G",
    "G#",
    "A",
    "A#",
    "B",
  ];
  const normalized = ((note % 12) + 12) % 12;
  return `${names[normalized]}${Math.floor(note / 12) - 1}`;
}

function statusLabel(status: MidiStatus) {
  switch (status) {
    case "connecting":
      return "connecting";
    case "ready":
      return "ready";
    case "unsupported":
      return "no webmidi";
    case "denied":
      return "blocked";
    default:
      return "offline";
  }
}

function inputSummary(status: MidiStatus, inputNames: string[]) {
  if (status === "ready") {
    return inputNames.length > 0
      ? inputNames.slice(0, 2).join(", ")
      : "no input";
  }
  if (status === "unsupported") {
    return "browser";
  }
  if (status === "denied") {
    return "permission";
  }
  return "all inputs";
}

function inputLabel(input: MidiInputLike) {
  return input.name || input.manufacturer || input.id || "MIDI input";
}

function formatMidiMs(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  if (value >= 100) {
    return `${Math.round(value)}ms`;
  }
  return `${value.toFixed(1)}ms`;
}
