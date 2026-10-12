import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps } from "../types";
import "./DroneModule.css";

const NOTE_MIN = -24;
const NOTE_MAX = 36;
const OUTPUT_COUNT = 8;
const PARAM_GATE_BASE = OUTPUT_COUNT;
const defaultNotes = [0, 7, 12, 15, 19, 24, 27, 31];

const noteOptions = Array.from(
  { length: NOTE_MAX - NOTE_MIN + 1 },
  (_, index) => NOTE_MIN + index,
);

export const droneDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.drone,
  slug: "drone",
  name: "DRONE",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 304,
  minHeight: 206,
  inputs: [],
  outputs: [
    ...Array.from({ length: OUTPUT_COUNT }, (_, index) => ({
      id: index,
      label: `p${index + 1}`,
      kind: "cv" as const,
      connectionOrder: index,
    })),
    ...Array.from({ length: OUTPUT_COUNT }, (_, index) => ({
      id: OUTPUT_COUNT + index,
      label: `g${index + 1}`,
      kind: "gate" as const,
      connectionOrder: index,
    })),
  ],
  params: [
    ...Array.from({ length: OUTPUT_COUNT }, (_, index) => ({
      id: noteParamId(index),
      key: `note${index + 1}`,
      label: `note ${index + 1}`,
      min: NOTE_MIN,
      max: NOTE_MAX,
      step: 1,
      defaultValue: defaultNotes[index],
    })),
    ...Array.from({ length: OUTPUT_COUNT }, (_, index) => ({
      id: gateParamId(index),
      key: `gate${index + 1}`,
      label: `gate ${index + 1}`,
      min: 0,
      max: 1,
      step: 1,
      defaultValue: 0,
    })),
  ],
  Component: DroneModule,
};

function DroneModule(props: ModuleRenderProps) {
  const { module, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="dronePanel">
        {Array.from({ length: OUTPUT_COUNT }, (_, index) => {
          const gateOn = (module.params[gateParamId(index)] ?? 0) >= 0.5;
          return (
            <div className={["droneTrack", gateOn ? "isOn" : ""].join(" ")} key={index}>
              <span className="droneTrackLabel">{`p${index + 1}/g${index + 1}`}</span>
              <select
                aria-label={`DRONE ${index + 1} note`}
                value={noteValue(module.params[noteParamId(index)], index)}
                onChange={(event) =>
                  onParamChange(
                    module.id,
                    noteParamId(index),
                    Number(event.target.value),
                  )
                }
              >
                {noteOptions.map((option) => (
                  <option key={option} value={option}>
                    {noteLabel(option)}
                  </option>
                ))}
              </select>
              <button
                aria-label={`DRONE ${index + 1} gate`}
                aria-pressed={gateOn}
                className={["droneGate", gateOn ? "isOn" : ""]
                  .filter(Boolean)
                  .join(" ")}
                type="button"
                onClick={() =>
                  onParamChange(module.id, gateParamId(index), gateOn ? 0 : 1)
                }
              >
                {gateOn ? "on" : "off"}
              </button>
            </div>
          );
        })}
      </div>
    </ModuleShell>
  );
}

function noteParamId(index: number) {
  return index;
}

function gateParamId(index: number) {
  return PARAM_GATE_BASE + index;
}

function noteValue(value: number | undefined, index: number) {
  return clampInteger(value ?? defaultNotes[index] ?? 0, NOTE_MIN, NOTE_MAX);
}

function clampInteger(value: number, min: number, max: number) {
  const finiteValue = Number.isFinite(value) ? value : min;
  return Math.min(max, Math.max(min, Math.round(finiteValue)));
}

function noteLabel(semitone: number) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const normalized = ((semitone % 12) + 12) % 12;
  const octave = Math.floor((semitone + 12) / 12) + 1;
  return `${names[normalized]}${octave}`;
}
