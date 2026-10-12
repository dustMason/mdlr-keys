import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "../productionPanel.css";
import "./CloudModule.css";

const PARAM_SIZE = 0;
const PARAM_DECAY = 1;
const PARAM_DIFFUSE = 2;
const PARAM_MOTION = 3;
const PARAM_TONE = 4;
const PARAM_TEXTURE = 5;
const PARAM_MIX = 6;
const PARAM_LEVEL = 7;
const PARAM_SEED = 8;

const params = withBypass([
  knob(PARAM_SIZE, "size", "size", 0, 1, 0.47),
  knob(PARAM_DECAY, "decay", "decay", 0, 1, 0.63),
  knob(PARAM_DIFFUSE, "diffuse", "diff", 0, 1, 0.78),
  knob(PARAM_MOTION, "motion", "move", 0, 1, 0.24),
  knob(PARAM_TONE, "tone", "tone", 0, 1, 0.42),
  knob(PARAM_TEXTURE, "texture", "tex", 0, 1, 0.52),
  knob(PARAM_MIX, "mix", "mix", 0, 1, 0.38),
  knob(PARAM_LEVEL, "level", "level", 0, 1.2, 0.86),
  knob(PARAM_SEED, "seed", "seed", 0, 1, 0.365, undefined, "linear", 0.001),
]);

export const cloudDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.cloud,
  slug: "cloud",
  name: "CLOUD",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 356,
  minHeight: 298,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
    { id: 3, label: "right", kind: "audio", connectionOrder: 1 },
    { id: 1, label: "size", kind: "cv" },
    { id: 2, label: "hold", kind: "gate" },
  ],
  outputs: [
    { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
    { id: 2, label: "right", kind: "audio", connectionOrder: 1 },
    { id: 1, label: "wet l", kind: "audio", connectionOrder: 2 },
    { id: 3, label: "wet r", kind: "audio", connectionOrder: 3 },
  ],
  params,
  Component: CloudModule,
};

function CloudModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="cloudPanel">
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          className="cloudSections"
          sections={[
            { title: "space", paramIds: [PARAM_SIZE, PARAM_DECAY, PARAM_DIFFUSE] },
            { title: "motion", paramIds: [PARAM_MOTION, PARAM_TONE, PARAM_TEXTURE] },
            { title: "return", paramIds: [PARAM_MIX, PARAM_LEVEL, PARAM_SEED] },
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
  unit?: string,
  scale: ParamDefinition["scale"] = "linear",
  step = 0.01,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue, unit, scale };
}
