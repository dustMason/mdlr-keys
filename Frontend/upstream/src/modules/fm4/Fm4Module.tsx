import { type CSSProperties } from "react";
import { useKnobControl } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { fm4FactoryPresets } from "../factoryPresets";
import { MODULE_KINDS } from "../kinds";
import { paramById, valueForParam } from "../panelSections";
import type {
  JackDefinition,
  KnobRenderProps,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./Fm4Module.css";

const VOICES = 4;

const PARAM_INTENSITY = 0;
const PARAM_FREQUENCY = 1;
const PARAM_TOPOLOGY = 2;
const PARAM_DETUNE = 3;
const PARAM_ATTACK = 4;
const PARAM_DECAY = 5;
const PARAM_SUSTAIN = 6;
const PARAM_RELEASE = 7;

const FM_INTENSITY_MAX = 0.55;
const FM4_KNOB_MIN_DEG = -140;
const FM4_KNOB_SWEEP_DEG = 280;
const FM4_KNOB_MAX_DEG = FM4_KNOB_MIN_DEG + FM4_KNOB_SWEEP_DEG;
const TOPOLOGY_LABELS = [
  "CHAIN",
  "SPLIT",
  "PAIRS",
  "CROSS",
  "FORK",
  "MERGE",
  "DUAL",
  "TRIO",
  "PURE",
] as const;
const MACRO_DETENT_LABELS: Record<number, readonly [string, string, string]> = {
  [PARAM_INTENSITY]: ["CLEAN", "SPARK", "TEETH"],
  [PARAM_FREQUENCY]: ["DEEP", "GRAIN", "GLASS"],
  [PARAM_DETUNE]: ["LOCK", "DRIFT", "SWARM"],
};

const macroPanels = [
  {
    id: PARAM_INTENSITY,
    key: "intensity",
    label: "intensity",
    panelLabel: "FM INTENSITY",
    accent: "#29e6f2",
    min: 0,
    max: FM_INTENSITY_MAX,
    step: 0.001,
    defaultValue: 0.22,
  },
  {
    id: PARAM_FREQUENCY,
    key: "frequency",
    label: "frequency",
    panelLabel: "FREQUENCY",
    accent: "#ffd84d",
    min: 0,
    max: 101,
    step: 1,
    defaultValue: 78,
  },
  {
    id: PARAM_TOPOLOGY,
    key: "topology",
    label: "topology",
    panelLabel: "TOPOLOGY",
    accent: "#7dffd6",
    min: 0,
    max: 8,
    step: 1,
    defaultValue: 1,
  },
  {
    id: PARAM_DETUNE,
    key: "detune",
    label: "detune",
    panelLabel: "DETUNE",
    accent: "#ff8c42",
    min: 0,
    max: 1,
    step: 0.001,
    defaultValue: 0.08,
  },
  {
    id: PARAM_ATTACK,
    key: "attack",
    label: "attack",
    panelLabel: "AMP ATTACK",
    accent: "#6dff8e",
    min: 0.001,
    max: 2,
    step: 0.001,
    defaultValue: 0.01,
    unit: "s",
    scale: "exponential",
  },
  {
    id: PARAM_DECAY,
    key: "decay",
    label: "decay",
    panelLabel: "AMP DECAY",
    accent: "#7fa7ff",
    min: 0.02,
    max: 4,
    step: 0.01,
    defaultValue: 0.72,
    unit: "s",
    scale: "exponential",
  },
  {
    id: PARAM_SUSTAIN,
    key: "sustain",
    label: "sustain",
    panelLabel: "AMP SUSTAIN",
    accent: "#ca8cff",
    min: 0,
    max: 1,
    step: 0.001,
    defaultValue: 0.74,
  },
  {
    id: PARAM_RELEASE,
    key: "release",
    label: "release",
    panelLabel: "AMP RELEASE",
    accent: "#ff9a86",
    min: 0.02,
    max: 5,
    step: 0.01,
    defaultValue: 0.03,
    unit: "s",
    scale: "exponential",
  },
] as const;

const params = macroPanels.map((panel) => {
  const unit = "unit" in panel ? panel.unit : undefined;
  const scale = "scale" in panel ? panel.scale : undefined;
  return {
    id: panel.id,
    key: panel.key,
    label: panel.label,
    min: panel.min,
    max: panel.max,
    step: panel.step,
    defaultValue: panel.defaultValue,
    unit,
    scale,
  } satisfies ParamDefinition;
});

export const fm4Definition: ModuleDefinition = {
  kind: MODULE_KINDS.fm4,
  slug: "fm4",
  name: "FM4",
  accent: "#55a8b3",
  presets: fm4FactoryPresets,
  rackWidth: "full",
  rackUnits: 2,
  width: 604,
  minHeight: 344,
  knobComponent: Fm4MacroKnob,
  inputs: [
    ...voiceInputs(),
    { id: 8, label: "intensity", kind: "cv", connectionOrder: 90 },
    { id: 9, label: "frequency", kind: "cv", connectionOrder: 91 },
    { id: 10, label: "topology", kind: "cv", connectionOrder: 92 },
    { id: 11, label: "detune", kind: "cv", connectionOrder: 93 },
  ],
  outputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "main",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "main",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
    { id: 2, label: "env", kind: "cv" },
    { id: 3, label: "gate", kind: "gate" },
  ],
  params,
  Component: Fm4Module,
};

function Fm4Module(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="fm4Panel">
        {macroPanels.map((panel) => {
          const param = paramById(panel.id, definition);
          const value = valueForParam(module.params, param);
          const detentLabels = MACRO_DETENT_LABELS[panel.id];
          return (
            <section
              key={panel.id}
              className="fm4MacroPanel"
              style={{ "--fm4-accent": panel.accent } as CSSProperties}
            >
              <div className="fm4MacroHeader">
                <span>{panel.panelLabel}</span>
              </div>
              {panel.id === PARAM_TOPOLOGY ? (
                <div className="fm4TopologyControl">
                  <TopologyDetentMap />
                  <Fm4MacroKnob
                    param={param}
                    value={value}
                    accent={panel.accent}
                    className="fm4MacroKnob fm4TopologyKnob"
                    onChange={(nextValue) =>
                      onParamChange(module.id, param.id, nextValue)
                    }
                  />
                  <strong className="fm4MacroValue">
                    {formatMacroValue(panel.id, value)}
                  </strong>
                </div>
              ) : (
                <div className="fm4MacroControl">
                  {detentLabels ? (
                    <MacroDetentMap labels={detentLabels} />
                  ) : null}
                  <Fm4MacroKnob
                    param={param}
                    value={value}
                    accent={panel.accent}
                    className="fm4MacroKnob"
                    onChange={(nextValue) =>
                      onParamChange(module.id, param.id, nextValue)
                    }
                  />
                  <strong className="fm4MacroValue">
                    {formatMacroValue(panel.id, value)}
                  </strong>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </ModuleShell>
  );
}

function MacroDetentMap({
  labels,
}: {
  labels: readonly [string, string, string];
}) {
  const center = { x: 90, y: 69 };
  const detents = [
    { angle: FM4_KNOB_MIN_DEG, label: labels[0] },
    { angle: 0, label: labels[1] },
    { angle: FM4_KNOB_MAX_DEG, label: labels[2] },
  ];
  return (
    <svg
      aria-hidden="true"
      className="fm4DetentMap"
      focusable="false"
      viewBox="0 0 180 132"
    >
      {detents.map((detent) => {
        const tickEnd = polarPoint(center, detent.angle, 47);
        const textPoint = polarPoint(center, detent.angle, 55);
        const anchor =
          detent.angle < 0 ? "end" : detent.angle > 0 ? "start" : "middle";
        return (
          <g key={detent.label}>
            <line
              className="fm4DetentLeader"
              x1={center.x}
              y1={center.y}
              x2={tickEnd.x}
              y2={tickEnd.y}
            />
            <text
              className="fm4DetentLabel"
              textAnchor={anchor}
              x={textPoint.x}
              y={textPoint.y}
            >
              {detent.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function TopologyDetentMap() {
  const center = { x: 110, y: 77 };
  return (
    <svg
      aria-hidden="true"
      className="fm4TopologyMap"
      focusable="false"
      viewBox="0 0 220 156"
    >
      {TOPOLOGY_LABELS.map((label, index) => {
        const angle =
          FM4_KNOB_MIN_DEG + index * (FM4_KNOB_SWEEP_DEG / (TOPOLOGY_LABELS.length - 1));
        const tickEnd = polarPoint(center, angle, 54);
        const textPoint = polarPoint(center, angle, 62);
        const anchor =
          textPoint.x < center.x - 8
            ? "end"
            : textPoint.x > center.x + 8
              ? "start"
              : "middle";
        return (
          <g key={label}>
            <line
              className="fm4TopologyLeader"
              x1={center.x}
              y1={center.y}
              x2={tickEnd.x}
              y2={tickEnd.y}
            />
            <text
              className="fm4TopologyLabel"
              textAnchor={anchor}
              x={textPoint.x}
              y={textPoint.y}
            >
              {index + 1} {label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function polarPoint(
  center: { x: number; y: number },
  angle: number,
  radius: number,
) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: center.x + Math.sin(radians) * radius,
    y: center.y - Math.cos(radians) * radius,
  };
}

function Fm4MacroKnob({
  param,
  value,
  accent,
  className,
  onChange,
}: KnobRenderProps) {
  const control = useKnobControl({ param, value, onChange });
  const visualDegrees =
    FM4_KNOB_MIN_DEG + control.normalized * FM4_KNOB_SWEEP_DEG;
  const visualSweep = control.normalized * FM4_KNOB_SWEEP_DEG;

  return (
    <label
      className={["knob", "fm4MovementKnob", className]
        .filter(Boolean)
        .join(" ")}
      htmlFor={control.inputId}
      onClick={control.handleClick}
      style={{ "--fm4-accent": accent } as CSSProperties}
    >
      <span
        {...control.faceProps}
        className="knobFace fm4MovementKnobFace"
        style={
          {
            ...control.faceStyle,
            "--knob-deg": `${visualDegrees}deg`,
            "--knob-sweep": `${visualSweep}deg`,
            "--fm4-knob-start": `${FM4_KNOB_MIN_DEG}deg`,
            "--fm4-knob-sweep": `${FM4_KNOB_SWEEP_DEG}deg`,
          } as CSSProperties
        }
      >
        <span className="fm4MovementKnobArc" aria-hidden="true" />
        <span className="knobNeedle fm4MovementKnobNeedle" />
        <span className="fm4MovementKnobHub" aria-hidden="true" />
      </span>
      <input
        {...control.inputProps}
        aria-label={param.label}
        className="knobInput"
      />
    </label>
  );
}

function formatMacroValue(paramId: number, value: number) {
  if (paramId === PARAM_FREQUENCY) {
    return `${Math.round(value) + 1}/102`;
  }
  if (paramId === PARAM_TOPOLOGY) {
    return `${Math.round(value) + 1}/9`;
  }
  if (
    paramId === PARAM_ATTACK ||
    paramId === PARAM_DECAY ||
    paramId === PARAM_RELEASE
  ) {
    return `${value >= 1 ? value.toFixed(1) : value.toFixed(2)}s`;
  }
  return `${Math.round(value * 100)}%`;
}

function voiceInputs(): JackDefinition[] {
  return Array.from({ length: VOICES }, (_, voice) => [
    {
      id: voice,
      label: `${voice + 1} pitch`,
      kind: "cv" as const,
      connectionGroup: `voice-${voice + 1}-in`,
      connectionGroupLabel: `${voice + 1}`,
      connectionGroupOrder: voice,
      connectionOrder: 0,
      connectionLabel: "CV",
    },
    {
      id: voice + VOICES,
      label: `${voice + 1} gate`,
      kind: "gate" as const,
      connectionGroup: `voice-${voice + 1}-in`,
      connectionGroupLabel: `${voice + 1}`,
      connectionGroupOrder: voice,
      connectionOrder: 1,
      connectionLabel: "GATE",
    },
  ]).flat();
}
