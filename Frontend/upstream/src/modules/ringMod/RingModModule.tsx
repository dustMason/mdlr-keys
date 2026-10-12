import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "../productionPanel.css";
import "./RingModModule.css";

const params = withBypass([
  knob(0, "freq", "freq", 0, 1, 0.34),
  knob(1, "depth", "depth", 0, 1, 0.82),
  knob(2, "shape", "shape", 0, 1, 0.36),
  knob(5, "mix", "mix", 0, 1, 0.72),
  knob(6, "level", "level", 0, 1.2, 0.72),
]);

export const ringModDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.ringMod,
  slug: "ring",
  name: "RING",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 356,
  minHeight: 292,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    ...stereoJacks("input", "in", "main-in", 0),
    {
      id: 2,
      label: "carrier",
      kind: "audio",
      connectionGroup: "carrier-in",
      connectionGroupLabel: "carrier",
      connectionGroupOrder: 2,
    },
    {
      id: 3,
      label: "freq",
      kind: "cv",
      connectionGroup: "freq-cv",
      connectionGroupLabel: "freq",
      connectionGroupOrder: 3,
    },
  ],
  outputs: [
    ...stereoJacks("output", "out", "main-out", 0),
    ...stereoJacks("output", "wet", "wet-out", 2),
    { id: 4, label: "car", kind: "cv", connectionOrder: 4 },
  ],
  params,
  Component: RingModModule,
};

function RingModModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  return (
    <ModuleShell {...props}>
      <div className="ringPanel">
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          sections={[
            { title: "carrier", paramIds: [0, 1, 2] },
            { title: "mix", paramIds: [5, 6] },
          ]}
        />
      </div>
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
): ParamDefinition {
  return { id, key, label, min, max, step: 0.01, defaultValue };
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
