import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";

const PARAM_THRESHOLD = 0;
const PARAM_RATIO = 1;
const PARAM_KNEE = 2;
const PARAM_ATTACK = 3;
const PARAM_RELEASE = 4;
const PARAM_RMS = 5;
const PARAM_LINK = 6;
const PARAM_MAKEUP = 7;
const PARAM_AUTO_MAKEUP = 8;
const PARAM_WET = 9;
const PARAM_DESIGN = 10;
const PARAM_CURVE = 11;
const PARAM_GAIN_STAGE = 12;

const params = withBypass([
  knob(PARAM_THRESHOLD, "threshold", "thresh", -60, 0, -12, 0.1, "db"),
  knob(PARAM_RATIO, "ratio", "ratio", 1, 20, 2, 0.1),
  knob(PARAM_KNEE, "knee", "knee", 0, 24, 0, 0.1, "db"),
  knob(PARAM_ATTACK, "attack", "attack", 0, 500, 10, 0.1, "ms", "exponential"),
  knob(PARAM_RELEASE, "release", "release", 0, 2000, 100, 1, "ms", "exponential"),
  knob(PARAM_RMS, "rms", "rms", 0, 200, 10, 0.1, "ms", "exponential"),
  knob(PARAM_LINK, "link", "link", 0, 100, 100, 1, "%"),
  knob(PARAM_MAKEUP, "makeup", "makeup", -24, 24, 0, 0.1, "db"),
  knob(PARAM_AUTO_MAKEUP, "auto_makeup", "auto", 0, 1, 0, 1),
  knob(PARAM_WET, "wet", "wet", 0, 1, 1, 0.01),
  knob(PARAM_DESIGN, "design", "design", 0, 1, 0, 1),
  knob(PARAM_CURVE, "curve", "curve", 0, 2, 2, 1),
  knob(PARAM_GAIN_STAGE, "gain_stage", "stage", 0, 1, 0, 1),
]);

export const squeezerDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.squeezer,
  slug: "squeeze",
  name: "SQUEEZE",
  accent: "#3f9ea8",
  rackWidth: "half",
  rackUnits: 2,
  width: 376,
  minHeight: 356,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: stereoJacks("input", "in", "main-in", 0),
  outputs: stereoJacks("output", "out", "main-out", 0),
  params,
  Component: SqueezerModule,
};

function SqueezerModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  return (
    <ModuleShell {...props}>
      <KnobSections
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        sections={[
          {
            title: "detector",
            paramIds: [PARAM_THRESHOLD, PARAM_RATIO, PARAM_KNEE, PARAM_RMS],
          },
          {
            title: "ballistics",
            paramIds: [PARAM_ATTACK, PARAM_RELEASE, PARAM_CURVE, PARAM_GAIN_STAGE],
          },
          {
            title: "mix",
            paramIds: [
              PARAM_LINK,
              PARAM_DESIGN,
              PARAM_MAKEUP,
              PARAM_AUTO_MAKEUP,
              PARAM_WET,
            ],
          },
        ]}
      />
    </ModuleShell>
  );
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
  step: number,
  unit?: string,
  scale?: ParamDefinition["scale"],
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue, unit, scale };
}

function stereoJacks(
  direction: "input" | "output",
  label: string,
  group: string,
  id: number,
): JackDefinition[] {
  return [
    {
      id,
      label: direction === "input" || label === "out" ? "left" : `${label} left`,
      kind: "audio",
      connectionGroup: group,
      connectionGroupLabel: label,
      connectionGroupOrder: id,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: id + 1,
      label: direction === "input" || label === "out" ? "right" : `${label} right`,
      kind: "audio",
      connectionGroup: group,
      connectionGroupLabel: label,
      connectionGroupOrder: id,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ];
}
