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
import "./PluckModule.css";

const PARAM_TUNE = 0;
const PARAM_DECAY = 1;
const PARAM_DAMPING = 2;
const PARAM_BRIGHT = 3;
const PARAM_BODY = 4;
const PARAM_PLUCK = 5;
const PARAM_PICKUP = 6;
const PARAM_DETUNE = 7;
const PARAM_WIDTH = 8;
const PARAM_ATTACK = 9;
const PARAM_RELEASE = 10;
const PARAM_LEVEL = 11;

const params = [
  knob(PARAM_TUNE, "tune", "tune", -24, 36, 1, 24),
  knob(PARAM_DECAY, "decay", "decay", 0, 1, 0.01, 0.72),
  knob(PARAM_DAMPING, "damping", "damp", 0, 1, 0.01, 0.32),
  knob(PARAM_BRIGHT, "bright", "bright", 0, 1, 0.01, 0.68),
  knob(PARAM_BODY, "body", "body", 0, 1, 0.01, 0.54),
  knob(PARAM_PLUCK, "pluck", "pluck", 0, 1, 0.01, 0.42),
  knob(PARAM_PICKUP, "pickup", "pickup", 0, 1, 0.01, 0.38),
  knob(PARAM_DETUNE, "detune", "det", 0, 1, 0.01, 0.22),
  knob(PARAM_WIDTH, "width", "width", 0, 1, 0.01, 0.58),
  time(PARAM_ATTACK, "attack", "atk", 0.001, 1, 0.004),
  time(PARAM_RELEASE, "release", "rel", 0.02, 5, 0.95),
  knob(PARAM_LEVEL, "level", "level", 0, 1, 0.01, 0.72),
] satisfies ParamDefinition[];

export const pluckDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.pluck,
  slug: "pluck",
  name: "PLUCK",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 560,
  minHeight: 318,
  inputs: [
    { id: 0, label: "pitch", kind: "cv" },
    { id: 1, label: "gate", kind: "gate" },
    { id: 2, label: "damp", kind: "cv" },
    { id: 3, label: "tone", kind: "cv" },
    { id: 4, label: "excite", kind: "cv" },
  ],
  outputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main",
      connectionGroupLabel: "main out",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main",
      connectionGroupLabel: "main out",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
    { id: 2, label: "env", kind: "cv" },
    { id: 3, label: "gate", kind: "gate" },
  ],
  params,
  Component: PluckModule,
};

function PluckModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const faderSections = [
    {
      title: "voice",
      paramIds: [PARAM_TUNE, PARAM_DETUNE, PARAM_WIDTH],
    },
    {
      title: "exciter",
      paramIds: [PARAM_PLUCK, PARAM_PICKUP, PARAM_BODY],
    },
    {
      title: "string",
      paramIds: [PARAM_DECAY, PARAM_DAMPING, PARAM_BRIGHT],
    },
    {
      title: "amp",
      paramIds: [PARAM_ATTACK, PARAM_RELEASE, PARAM_LEVEL],
    },
  ];

  return (
    <ModuleShell {...props}>
      <div className="productionPanel pluckPanel">
        <div className="productionSections pluckSections">
          {faderSections.map((section) => (
            <ProductionSection
              key={section.title}
              title={section.title}
              className="pluckFaderSection"
            >
              <div className="pluckFaderGrid">
                {section.paramIds.map((paramId) => (
                  <PluckFader
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

function PluckFader({
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
  const normalized = normalizeValue(value, param);

  return (
    <label
      className="pluckFader"
      style={{ "--pluck-fader-fill": `${normalized * 100}%` } as CSSProperties}
    >
      <span className="pluckFaderLabel">{param.label}</span>
      <span className="pluckFaderTrack" aria-hidden="true">
        <span className="pluckFaderFill" />
        <span className="pluckFaderCap" />
      </span>
      <input
        className="pluckFaderInput"
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        aria-label={param.label}
        onChange={(event) =>
          onParamChange(module.id, param.id, Number(event.target.value))
        }
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
  step: number,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue };
}

function time(
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
    step: 0.01,
    defaultValue,
    unit: "s",
    scale: "exponential",
  };
}

function normalizeValue(value: number, parameter: ParamDefinition) {
  if (!Number.isFinite(value) || parameter.max <= parameter.min) {
    return 0;
  }
  return Math.min(
    1,
    Math.max(0, (value - parameter.min) / (parameter.max - parameter.min)),
  );
}
