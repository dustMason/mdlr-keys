import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type {
  JackDefinition,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "../productionPanel.css";
import "./ChorusModule.css";

const params = withBypass([
  knob(0, "rate", "rate", 0, 1, 0.22),
  knob(1, "depth", "depth", 0, 1, 0.58),
  knob(2, "delay", "delay", 0, 1, 0.42),
  knob(3, "feedback", "feed", 0, 0.88, 0.18),
  knob(4, "tone", "tone", 0, 1, 0.62),
  knob(5, "mix", "mix", 0, 1, 0.58),
  knob(6, "level", "level", 0, 1.2, 0.78),
]);

export const chorusDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.chorus,
  slug: "chorus",
  name: "CHORUS",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 380,
  minHeight: 206,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    ...stereoInputJacks(),
    {
      id: 1,
      label: "rate",
      kind: "cv",
      connectionGroup: "rate-cv",
      connectionGroupLabel: "rate",
      connectionGroupOrder: 2,
    },
    {
      id: 2,
      label: "depth",
      kind: "cv",
      connectionGroup: "depth-cv",
      connectionGroupLabel: "depth",
      connectionGroupOrder: 3,
    },
  ],
  outputs: [
    { id: 0, label: "left", kind: "audio" },
    { id: 1, label: "right", kind: "audio" },
    { id: 2, label: "wet l", kind: "audio" },
    { id: 3, label: "wet r", kind: "audio" },
  ],
  params,
  Component: ChorusModule,
};

function ChorusModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  return (
    <ModuleShell {...props}>
      <div className="productionPanel moogerFoogerPanel chorusPanel">
        <div className="productionDisplay" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} />
          ))}
        </div>
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          accent="#111111"
          className="chorusSections"
          sections={[
            { title: "lfo", paramIds: [0, 1] },
            { title: "bucket", paramIds: [2, 3, 4] },
            { title: "mix", paramIds: [5, 6] },
          ]}
        />
      </div>
    </ModuleShell>
  );
}

function knob(id: number, key: string, label: string, min: number, max: number, defaultValue: number): ParamDefinition {
  return { id, key, label, min, max, step: 0.01, defaultValue };
}

function stereoInputJacks(): JackDefinition[] {
  return [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 3,
      label: "right",
      kind: "audio",
      connectionGroup: "main-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ];
}
