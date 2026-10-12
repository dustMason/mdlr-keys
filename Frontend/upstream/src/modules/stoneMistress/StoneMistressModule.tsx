import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";

const PARAM_RATE = 0;
const PARAM_PHASER_DEPTH = 1;
const PARAM_CHORUS_DEPTH = 2;
const PARAM_COLOR = 3;

const params = withBypass([
  knob(PARAM_RATE, "rate", "rate", 0.05, 8, 0.09, 0.001, "hz", "exponential"),
  knob(PARAM_PHASER_DEPTH, "phaser_depth", "phase", 0, 2000, 2000, 1),
  knob(PARAM_CHORUS_DEPTH, "chorus_depth", "chorus", 0, 0.04, 0.005, 0.0001, "s"),
  knob(PARAM_COLOR, "color", "color", 0, 1, 0, 1),
]);

export const stoneMistressDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.stoneMistress,
  slug: "stone",
  name: "STONE",
  accent: "#3f9ea8",
  rackWidth: "half",
  rackUnits: 1,
  width: 376,
  minHeight: 250,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: stereoJacks("input", "in", "main-in", 0),
  outputs: stereoJacks("output", "out", "main-out", 0),
  params,
  Component: StoneMistressModule,
};

function StoneMistressModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  return (
    <ModuleShell {...props}>
      <KnobSections
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        className="productionSectionsOne"
        sections={[
          {
            title: "stone mistress",
            paramIds: [
              PARAM_RATE,
              PARAM_PHASER_DEPTH,
              PARAM_CHORUS_DEPTH,
              PARAM_COLOR,
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
