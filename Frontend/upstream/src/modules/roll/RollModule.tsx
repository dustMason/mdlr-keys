import { memo, useMemo, type CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./RollModule.css";

const VOICES = 4;
const STEPS = 64;
const PARAM_LENGTH = 0;
const PARAM_NOTE_BASE = 1;
const PARAM_GATE_BASE = PARAM_NOTE_BASE + VOICES * STEPS;
const PARAM_METER = PARAM_GATE_BASE + VOICES * STEPS;
const METER_FOUR_FOUR = 0;
const METER_THREE_FOUR = 1;
const lengths = [16, 32, 64] as const;
const noteRows = Array.from({ length: 37 }, (_, index) => 24 - index);
const randomScale = [0, 2, 3, 5, 7, 10, 12, 14, 15, 17, 19, 22];

const params = [
  param(PARAM_LENGTH, "length", "len", 16, 16, 64, 16),
  ...Array.from({ length: VOICES }, (_, voice) =>
    Array.from({ length: STEPS }, (_, step) =>
      param(noteParamId(voice, step), `voice${voice + 1}_note${step + 1}`, "note", defaultNote(voice, step), -36, 48, 1),
    ),
  ).flat(),
  ...Array.from({ length: VOICES }, (_, voice) =>
    Array.from({ length: STEPS }, (_, step) =>
      param(gateParamId(voice, step), `voice${voice + 1}_gate${step + 1}`, "gate", defaultGate(voice, step), 0, 1, 1),
    ),
  ).flat(),
  param(PARAM_METER, "meter", "meter", METER_FOUR_FOUR, METER_FOUR_FOUR, METER_THREE_FOUR, 1),
] satisfies ParamDefinition[];

export const rollDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.roll,
  slug: "roll",
  name: "ROLL",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 760,
  minHeight: 392,
  inputs: [],
  outputs: voiceOutputs(),
  params,
  Component: RollModule,
};

function RollModule(props: ModuleRenderProps) {
  const { module, onParamChange } = props;
  const length = lengthValue(module.params[PARAM_LENGTH]);
  const meter = meterValue(module.params[PARAM_METER]);
  const visibleLength = effectiveLength(length, meter);

  function setLength(nextLength: number) {
    onParamChange(module.id, PARAM_LENGTH, nextLength);
  }

  function setMeter(nextMeter: number) {
    onParamChange(module.id, PARAM_METER, meterValue(nextMeter));
  }

  function clearPattern() {
    for (let voice = 0; voice < VOICES; voice += 1) {
      for (let step = 0; step < STEPS; step += 1) {
        onParamChange(module.id, gateParamId(voice, step), 0);
      }
    }
  }

  function randomizePattern() {
    clearPattern();
    for (let step = 0; step < visibleLength; step += 1) {
      if (Math.random() > 0.56) {
        continue;
      }
      const chordSize = Math.random() > 0.72 ? 3 : Math.random() > 0.42 ? 2 : 1;
      const root = randomScale[Math.floor(Math.random() * randomScale.length)] ?? 0;
      const chord = [root, root + 7, root + 12, root + 16];
      for (let voice = 0; voice < chordSize; voice += 1) {
        onParamChange(module.id, noteParamId(voice, step), clampNote(chord[voice] ?? root));
        onParamChange(module.id, gateParamId(voice, step), 1);
      }
    }
  }

  function toggleCell(step: number, note: number) {
    const existingVoice = voiceAtStepNote(module.params, step, note);
    if (existingVoice !== null) {
      onParamChange(module.id, gateParamId(existingVoice, step), 0);
      return;
    }

    const targetVoice = firstOpenVoice(module.params, step);
    onParamChange(module.id, noteParamId(targetVoice, step), note);
    onParamChange(module.id, gateParamId(targetVoice, step), 1);
  }

  return (
    <ModuleShell {...props}>
      <div className="rollPanel">
        <div className="rollToolbar">
          <div className="rollLengthControl" aria-label="roll length">
            {lengths.map((option) => (
              <button
                key={option}
                className={option === length ? "isActive" : ""}
                type="button"
                onClick={() => setLength(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="rollMeterControl" aria-label="roll meter">
            <button
              className={meter === METER_FOUR_FOUR ? "isActive" : ""}
              type="button"
              onClick={() => setMeter(METER_FOUR_FOUR)}
            >
              4/4
            </button>
            <button
              className={meter === METER_THREE_FOUR ? "isActive" : ""}
              type="button"
              onClick={() => setMeter(METER_THREE_FOUR)}
            >
              3/4
            </button>
          </div>
          <button type="button" onClick={randomizePattern}>
            random
          </button>
          <button type="button" onClick={clearPattern}>
            clear
          </button>
        </div>

        <RollGrid
          length={visibleLength}
          params={module.params}
          onToggleCell={toggleCell}
        />
      </div>
    </ModuleShell>
  );
}

const RollGrid = memo(
  function RollGrid({
    length,
    params,
    onToggleCell,
  }: {
    length: number;
    params: Record<number, number>;
    onToggleCell: (step: number, note: number) => void;
  }) {
    const visibleSteps = useMemo(
      () => Array.from({ length }, (_, index) => index),
      [length],
    );
    const activeCells = useMemo(
      () => activeCellMap(params, length),
      [params, length],
    );

    return (
      <div
        className="rollGrid"
        data-roll-length={length}
        style={{ "--roll-steps": length } as CSSProperties}
        aria-label="polyphonic piano roll"
      >
        <div className="rollPlayhead" aria-hidden="true" />
        <div className="rollCorner" />
        {visibleSteps.map((step) => (
          <div key={`head-${step}`} className="rollStepHead" data-step={step}>
            {step + 1}
          </div>
        ))}
        {noteRows.map((note) => (
          <div key={`row-${note}`} className="rollRowContents">
            <div className={["rollKeyboardCell", isBlackKey(note) ? "isBlack" : ""].join(" ")}>
              {noteName(note)}
            </div>
            {visibleSteps.map((step) => {
              const voice = activeCells.get(cellKey(step, note)) ?? null;
              const active = voice !== null;
              return (
                <button
                  key={`${note}-${step}`}
                  type="button"
                  className={[
                    "rollCell",
                    active ? "isActive" : "",
                    active ? `voice${voice + 1}` : "",
                    step % 4 === 0 ? "isBeat" : "",
                  ].filter(Boolean).join(" ")}
                  data-step={step}
                  aria-label={`${noteName(note)} step ${step + 1}`}
                  onClick={() => onToggleCell(step, note)}
                />
              );
            })}
          </div>
        ))}
      </div>
    );
  },
  (previous, next) =>
    previous.length === next.length && previous.params === next.params,
);

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

function voiceAtStepNote(params: Record<number, number>, step: number, note: number) {
  for (let voice = 0; voice < VOICES; voice += 1) {
    if (
      params[gateParamId(voice, step)] >= 0.5 &&
      Math.round(params[noteParamId(voice, step)] ?? 0) === note
    ) {
      return voice;
    }
  }
  return null;
}

function activeCellMap(params: Record<number, number>, length: number) {
  const activeCells = new Map<string, number>();
  for (let step = 0; step < length; step += 1) {
    for (let voice = 0; voice < VOICES; voice += 1) {
      if ((params[gateParamId(voice, step)] ?? 0) < 0.5) {
        continue;
      }
      const note = Math.round(params[noteParamId(voice, step)] ?? 0);
      activeCells.set(cellKey(step, note), voice);
    }
  }
  return activeCells;
}

function cellKey(step: number, note: number) {
  return `${step}:${note}`;
}

function firstOpenVoice(params: Record<number, number>, step: number) {
  for (let voice = 0; voice < VOICES; voice += 1) {
    if ((params[gateParamId(voice, step)] ?? 0) < 0.5) {
      return voice;
    }
  }
  return 0;
}

function defaultNote(voice: number, step: number) {
  const defaults = [
    [0, 3, 5, -2],
    [7, 10, 12, 7],
    [12, 0, 17, 14],
    [16, 0, 0, 0],
  ];
  if (step % 4 !== 0) {
    return 0;
  }
  const chord = Math.floor(step / 4) % 4;
  return defaults[voice]?.[chord] ?? 0;
}

function defaultGate(voice: number, step: number) {
  if (step >= 16 || step % 4 !== 0) {
    return 0;
  }
  if (voice === 0) {
    return 1;
  }
  if (voice === 1) {
    return 1;
  }
  if (voice === 2) {
    return step >= 8 ? 1 : 0;
  }
  return step === 0 ? 1 : 0;
}

function noteParamId(voice: number, step: number) {
  return PARAM_NOTE_BASE + voice * STEPS + step;
}

function gateParamId(voice: number, step: number) {
  return PARAM_GATE_BASE + voice * STEPS + step;
}

function lengthValue(value: number | undefined) {
  if ((value ?? 16) < 24) {
    return 16;
  }
  if ((value ?? 16) < 48) {
    return 32;
  }
  return 64;
}

function meterValue(value: number | undefined) {
  return (value ?? METER_FOUR_FOUR) >= 0.5 ? METER_THREE_FOUR : METER_FOUR_FOUR;
}

function effectiveLength(length: number, meter: number) {
  return meter === METER_THREE_FOUR ? Math.max(1, Math.floor(length * 3 / 4)) : length;
}

function noteName(note: number) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const normalized = ((note % 12) + 12) % 12;
  const octave = 2 + Math.floor(note / 12);
  return `${names[normalized]}${octave}`;
}

function isBlackKey(note: number) {
  return [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
}

function clampNote(note: number) {
  return Math.max(-36, Math.min(48, Math.round(note)));
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
