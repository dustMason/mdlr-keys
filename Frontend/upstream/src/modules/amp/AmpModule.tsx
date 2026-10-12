import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type {
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "../productionPanel.css";
import "./AmpModule.css";

const PARAM_GAIN = 0;
const PARAM_LOW = 1;
const PARAM_MID = 2;
const PARAM_HIGH = 3;
const PARAM_PRESENCE = 4;
const PARAM_CAB = 5;
const PARAM_SAG = 6;
const PARAM_LEVEL = 7;
const PARAM_MIX = 8;

const ampParams = [
  knob(PARAM_GAIN, "gain", "gain", 0, 1, 0.42),
  knob(PARAM_LOW, "low", "low", 0, 1, 0.56),
  knob(PARAM_MID, "mid", "mid", 0, 1, 0.48),
  knob(PARAM_HIGH, "high", "high", 0, 1, 0.58),
  knob(PARAM_PRESENCE, "presence", "pres", 0, 1, 0.46),
  knob(PARAM_CAB, "cab", "cab", 0, 3, 1, 1),
  knob(PARAM_SAG, "sag", "sag", 0, 1, 0.24),
  knob(PARAM_LEVEL, "level", "level", 0, 1.25, 0.72),
  knob(PARAM_MIX, "mix", "mix", 0, 1, 1),
] satisfies ParamDefinition[];

export const ampDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.amp,
  slug: "amp",
  name: "AMP",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 356,
  minHeight: 292,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
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
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-in",
      connectionGroupLabel: "in",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
    {
      id: 2,
      label: "drive",
      kind: "cv",
      connectionGroup: "drive-cv",
      connectionGroupLabel: "drive",
      connectionGroupOrder: 1,
    },
  ],
  outputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "out",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "out",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ],
  params: withBypass(ampParams),
  Component: AmpModule,
};

function AmpModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="productionPanel ampPanel">
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          className="ampSections"
          sections={[
            { title: "preamp", paramIds: [PARAM_GAIN, PARAM_SAG] },
            {
              title: "tone stack",
              paramIds: [PARAM_LOW, PARAM_MID, PARAM_HIGH],
            },
            { title: "cabinet", paramIds: [PARAM_CAB, PARAM_PRESENCE] },
            { title: "output", paramIds: [PARAM_LEVEL, PARAM_MIX] },
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
  step = 0.01,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue };
}
