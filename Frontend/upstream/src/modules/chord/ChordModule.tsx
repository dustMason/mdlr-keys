import { ModuleKnob } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { paramById, valueForParam } from "../panelSections";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./ChordModule.css";

const VOICES = 4;
const PARAM_TYPE = 0;
const PARAM_INVERSION = 1;
const PARAM_SPREAD = 2;
const PARAM_TRANSPOSE = 3;

const chordTypes = [
  { label: "major", intervals: [0, 4, 7] },
  { label: "minor", intervals: [0, 3, 7] },
  { label: "dim", intervals: [0, 3, 6] },
  { label: "aug", intervals: [0, 4, 8] },
  { label: "7", intervals: [0, 4, 7, 10] },
  { label: "maj7", intervals: [0, 4, 7, 11] },
  { label: "min7", intervals: [0, 3, 7, 10] },
  { label: "9", intervals: [0, 4, 10, 14] },
  { label: "maj9", intervals: [0, 4, 11, 14] },
  { label: "min9", intervals: [0, 3, 10, 14] },
] as const;

const spreadLabels = ["close", "open", "wide"] as const;

const params = [
  param(PARAM_TYPE, "type", "type", 0, 0, chordTypes.length - 1, 1),
  param(PARAM_INVERSION, "inversion", "inv", 0, 0, 3, 1),
  param(PARAM_SPREAD, "spread", "spread", 0, 0, 2, 1),
  param(PARAM_TRANSPOSE, "transpose", "xpose", 0, -24, 24, 1),
] satisfies ParamDefinition[];

export const chordDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.chord,
  slug: "chord",
  name: "CHORD",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 356,
  minHeight: 286,
  inputs: [
    {
      id: 0,
      label: "pitch",
      kind: "cv",
      connectionGroup: "control-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "CV",
    },
    {
      id: 1,
      label: "gate",
      kind: "gate",
      connectionGroup: "control-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "GATE",
    },
  ],
  outputs: voiceOutputs(),
  params,
  Component: ChordModule,
};

function ChordModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const typeParam = paramById(PARAM_TYPE, definition);
  const inversionParam = paramById(PARAM_INVERSION, definition);
  const spreadParam = paramById(PARAM_SPREAD, definition);
  const transposeParam = paramById(PARAM_TRANSPOSE, definition);
  const chordType = clampIndex(
    Math.round(valueForParam(module.params, typeParam)),
    chordTypes.length,
  );
  const inversion = Math.round(valueForParam(module.params, inversionParam));
  const spread = Math.round(valueForParam(module.params, spreadParam));
  const intervals = chordIntervals(chordType, inversion, spread);

  return (
    <ModuleShell {...props}>
      <div className="chordPanel">
        <div className="chordTypeSelect">
          <label>
            <span>chord</span>
            <select
              value={chordType}
              onChange={(event) =>
                onParamChange(module.id, PARAM_TYPE, Number(event.target.value))
              }
            >
              {chordTypes.map((type, index) => (
                <option key={type.label} value={index}>
                  {type.label}
                </option>
              ))}
            </select>
          </label>
          <div className="chordSpreadControl" role="group" aria-label="voicing spread">
            {spreadLabels.map((label, index) => (
              <button
                key={label}
                type="button"
                className={spread === index ? "isActive" : ""}
                onClick={() => onParamChange(module.id, PARAM_SPREAD, index)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="chordVoices" aria-hidden="true">
          {intervals.map((interval, index) => (
            <span key={index}>
              <strong>{index + 1}</strong>
              {formatInterval(interval)}
            </span>
          ))}
        </div>

        <div className="chordKnobs">
          <ModuleKnob
            definition={definition}
            param={inversionParam}
            value={valueForParam(module.params, inversionParam)}
            onChange={(value) => onParamChange(module.id, PARAM_INVERSION, value)}
          />
          <ModuleKnob
            definition={definition}
            param={transposeParam}
            value={valueForParam(module.params, transposeParam)}
            onChange={(value) => onParamChange(module.id, PARAM_TRANSPOSE, value)}
          />
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

function chordIntervals(typeIndex: number, inversion: number, spread: number) {
  const pattern = chordTypes[clampIndex(typeIndex, chordTypes.length)].intervals;
  const intervals = Array.from({ length: VOICES }, (_, voice) => {
    const sequenceIndex = voice + Math.max(0, Math.min(3, inversion));
    return pattern[sequenceIndex % pattern.length] + Math.floor(sequenceIndex / pattern.length) * 12;
  });

  if (spread === 1) {
    intervals[2] += 12;
    intervals[3] += 12;
  } else if (spread === 2) {
    intervals[1] += 12;
    intervals[2] += 12;
    intervals[3] += 24;
  }
  return intervals;
}

function formatInterval(interval: number) {
  if (interval === 0) {
    return "root";
  }
  return `+${interval}`;
}

function clampIndex(value: number, length: number) {
  return Math.max(0, Math.min(length - 1, value));
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
