import type { CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { ProductionSection, paramById, valueForParam } from "../panelSections";
import type {
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "../productionPanel.css";
import "./FarfisaModule.css";

const PARAM_BASS = 0;
const PARAM_FLUTE = 1;
const PARAM_REED = 2;
const PARAM_BRIGHT = 3;
const PARAM_VIBRATO = 4;
const PARAM_TREMOLO = 5;
const PARAM_DRIVE = 6;
const PARAM_LEVEL = 7;
const PARAM_ATTACK = 8;
const PARAM_DECAY = 9;
const PARAM_SUSTAIN = 10;
const PARAM_RELEASE = 11;

const params = [
  knob(PARAM_BASS, "bass", "bass", 0, 1, 0.46),
  knob(PARAM_FLUTE, "flute", "flute", 0, 1, 0.72),
  knob(PARAM_REED, "reed", "reed", 0, 1, 0.58),
  knob(PARAM_BRIGHT, "bright", "bright", 0, 1, 0.66),
  knob(PARAM_VIBRATO, "vibrato", "vib", 0, 1, 0.42),
  knob(PARAM_TREMOLO, "tremolo", "trem", 0, 1, 0.32),
  knob(PARAM_DRIVE, "drive", "drive", 0, 1, 0.28),
  knob(PARAM_LEVEL, "level", "level", 0, 1, 0.66),
  timeParam(PARAM_ATTACK, "attack", "atk", 0.001, 1.5, 0.004),
  timeParam(PARAM_DECAY, "decay", "decay", 0.01, 2.5, 0.16),
  knob(PARAM_SUSTAIN, "sustain", "sus", 0, 1, 0.92),
  timeParam(PARAM_RELEASE, "release", "rel", 0.01, 3.5, 0.08),
] satisfies ParamDefinition[];

export const farfisaDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.farfisa,
  slug: "farf",
  name: "FARF",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 512,
  minHeight: 318,
  inputs: [
    { id: 0, label: "pitch", kind: "cv" },
    { id: 1, label: "gate", kind: "gate" },
    { id: 2, label: "vib", kind: "cv" },
    { id: 3, label: "swell", kind: "cv" },
  ],
  outputs: [
    { id: 0, label: "audio", kind: "audio" },
    { id: 1, label: "reed", kind: "audio" },
    { id: 2, label: "env", kind: "cv" },
    { id: 3, label: "gate", kind: "gate" },
  ],
  params,
  Component: FarfisaModule,
};

function FarfisaModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const sections = [
    {
      title: "tone",
      className: "farfToneSection",
      paramIds: [PARAM_BASS, PARAM_FLUTE, PARAM_REED, PARAM_BRIGHT],
    },
    {
      title: "motion",
      className: "farfMotionSection",
      paramIds: [PARAM_VIBRATO, PARAM_TREMOLO],
    },
    {
      title: "envelope",
      className: "farfEnvelopeSection",
      paramIds: [PARAM_ATTACK, PARAM_DECAY, PARAM_SUSTAIN, PARAM_RELEASE],
    },
    {
      title: "amp",
      className: "farfAmpSection",
      paramIds: [PARAM_DRIVE, PARAM_LEVEL],
    },
  ];

  return (
    <ModuleShell {...props}>
      <div className="productionPanel farfPanel">
        <div className="farfSections">
          {sections.map((section) => (
            <ProductionSection
              key={section.title}
              title={section.title}
              className={section.className}
            >
              <div className="farfDrawbars">
                {section.paramIds.map((paramId) => (
                  <FarfDrawbar
                    key={paramId}
                    module={module}
                    definition={definition}
                    onParamChange={onParamChange}
                    paramId={paramId}
                  />
                ))}
              </div>
            </ProductionSection>
          ))}
        </div>
      </div>
    </ModuleShell>
  );
}

function FarfDrawbar({
  module,
  definition,
  onParamChange,
  paramId,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
}) {
  const param = paramById(paramId, definition);
  const value = valueForParam(module.params, param);
  const normalized = normalizeParamValue(value, param);

  return (
    <label
      className="farfDrawbar"
      style={{ "--farf-drawbar-fill": `${normalized * 100}%` } as CSSProperties}
    >
      <span className="farfDrawbarLabel">{param.label}</span>
      <span className="farfDrawbarRail" aria-hidden="true">
        <span className="farfDrawbarFill" />
        <span className="farfDrawbarCap" />
      </span>
      <span className="farfDrawbarValue">
        {formatDrawbarValue(value, param)}
      </span>
      <input
        className="farfDrawbarInput"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={normalized}
        aria-label={param.label}
        onChange={(event) => {
          const next = valueFromNormalized(Number(event.target.value), param);
          onParamChange(module.id, param.id, snapValue(next, param));
        }}
      />
    </label>
  );
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

function timeParam(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
): ParamDefinition {
  return {
    id,
    key,
    label,
    min,
    max,
    step: 0.001,
    defaultValue,
    scale: "exponential",
    unit: "s",
  };
}

function normalizeParamValue(value: number, param: ParamDefinition) {
  const clamped = clamp(value, param.min, param.max);
  if (param.scale === "exponential" && param.min > 0 && param.max > param.min) {
    return clamp01(
      Math.log(clamped / param.min) / Math.log(param.max / param.min),
    );
  }

  return clamp01((clamped - param.min) / (param.max - param.min));
}

function valueFromNormalized(normalized: number, param: ParamDefinition) {
  const clamped = clamp01(normalized);
  if (param.scale === "exponential" && param.min > 0 && param.max > param.min) {
    return param.min * Math.pow(param.max / param.min, clamped);
  }

  return param.min + clamped * (param.max - param.min);
}

function snapValue(value: number, param: ParamDefinition) {
  const step = param.step > 0 ? param.step : 0.01;
  const snapped = Math.round((value - param.min) / step) * step + param.min;
  const clamped = clamp(snapped, param.min, param.max);
  return Number(clamped.toFixed(Math.min(8, decimalPlaces(step) + 2)));
}

function formatDrawbarValue(value: number, param: ParamDefinition) {
  if (!Number.isFinite(value)) {
    return `0${param.unit ?? ""}`;
  }
  const decimals = param.step < 0.01 ? 2 : param.step < 1 ? 1 : 0;
  return `${value.toFixed(decimals)}${param.unit ?? ""}`;
}

function decimalPlaces(value: number) {
  const text = value.toString();
  if (!text.includes(".")) {
    return 0;
  }
  return text.split(".")[1]?.length ?? 0;
}

function clamp01(value: number) {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
