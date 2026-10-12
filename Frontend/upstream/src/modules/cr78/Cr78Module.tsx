import type { CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { KnobSections, paramById, valueForParam } from "../panelSections";
import type {
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "../productionPanel.css";
import "./Cr78Module.css";

const inputs = ["bd", "sd", "rim", "clave", "hat", "tamb", "cy", "fill"];
const voices = ["bd", "sd", "rim", "clave", "hat", "tamb", "cy"] as const;
const PARAM_MUTE_BASE = 20;
const params = [
  ...voices.map((label, index) =>
    knob(index, label, label, 0, 1, defaultVoiceLevel(index)),
  ),
  knob(7, "tone", "tone", 0, 1, 0.52),
  knob(8, "decay", "decay", 0, 1, 0.46),
  knob(9, "accent", "accent", 0, 1, 0.48),
  knob(10, "master", "master", 0, 1, 0.72),
  ...voices.map((label, index) =>
    switchParam(muteParamId(index), `${label}_mute`, `${label} mute`),
  ),
] satisfies ParamDefinition[];

export const cr78Definition: ModuleDefinition = {
  kind: MODULE_KINDS.cr78,
  slug: "cr78",
  name: "CR78",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 604,
  minHeight: 328,
  inputs: [
    ...inputs.map((label, id) => ({ id, label, kind: "gate" as const })),
    { id: 8, label: "accent", kind: "cv" },
  ],
  outputs: [
    { id: 0, label: "mix", kind: "audio" },
    { id: 1, label: "bd", kind: "audio" },
    { id: 2, label: "sd", kind: "audio" },
    { id: 3, label: "rim", kind: "audio" },
    { id: 4, label: "clave", kind: "audio" },
    { id: 5, label: "hat", kind: "audio" },
    { id: 6, label: "tamb", kind: "audio" },
    { id: 7, label: "cy", kind: "audio" },
    { id: 8, label: "env", kind: "cv" },
    { id: 9, label: "gate", kind: "gate" },
  ],
  params,
  Component: Cr78Module,
};

function Cr78Module(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const gateLevels = props.mixerMeterData?.levels;
  return (
    <ModuleShell {...props}>
      <div className="productionPanel">
        <div className="cr78MuteStrip">
          {voices.map((label, index) => {
            const parameter = paramById(muteParamId(index), definition);
            const muted = valueForParam(module.params, parameter) >= 0.5;
            const ledLevel = voiceLedLevel(gateLevels, index);
            const ledActive = ledLevel > 0.012;
            return (
              <button
                key={label}
                type="button"
                className={[
                  "cr78MuteSwitch",
                  muted ? "isMuted" : "",
                  ledActive ? "isPlaying" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={
                  { "--cr78-led-level": ledLevel.toFixed(3) } as CSSProperties
                }
                aria-pressed={muted}
                aria-label={`${label} ${muted ? "muted" : "on"}`}
                onClick={() =>
                  onParamChange(module.id, parameter.id, muted ? 0 : 1)
                }
              >
                <span className="cr78MuteName">{label}</span>
                <span className="cr78MuteLed" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          className="drumVoiceGrid drumVoiceGridCompact"
          sections={[
            { title: "color", paramIds: [7, 8, 9, 10] },
            { title: "bd", paramIds: [0] },
            { title: "sd", paramIds: [1] },
            { title: "rim", paramIds: [2] },
            { title: "clave", paramIds: [3] },
            { title: "hat", paramIds: [4] },
            { title: "tamb", paramIds: [5] },
            { title: "cy", paramIds: [6] },
          ]}
        />
      </div>
    </ModuleShell>
  );
}

function voiceLedLevel(
  gateLevels: Float32Array | undefined,
  voiceIndex: number,
) {
  return Math.max(0, Math.min(1, gateLevels?.[voiceIndex] ?? 0));
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min, max, step: 0.01, defaultValue };
}

function switchParam(id: number, key: string, label: string): ParamDefinition {
  return { id, key, label, min: 0, max: 1, step: 1, defaultValue: 0 };
}

function muteParamId(index: number) {
  return PARAM_MUTE_BASE + index;
}

function defaultVoiceLevel(index: number) {
  return [0.72, 0.58, 0.46, 0.42, 0.48, 0.42, 0.42][index] ?? 0.5;
}
