import { ModuleShell } from "../../components/ModuleShell";
import { dxFactoryPresets } from "../factoryPresets";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";

const OPERATORS = 6;
const VOICES = 4;

const PARAM_TUNE = 0;
const PARAM_ALGORITHM = 1;
const PARAM_FEEDBACK = 2;
const PARAM_INDEX = 3;
const PARAM_ATTACK = 4;
const PARAM_DECAY = 5;
const PARAM_RELEASE = 6;
const PARAM_LEVEL = 7;
const PARAM_RATIO_BASE = 10;
const PARAM_OP_LEVEL_BASE = 20;

const defaultRatios = [1, 1, 2, 3, 4, 6];
const defaultLevels = [0.8, 0, 0.72, 0, 0.48, 0];

const ratioIds = Array.from({ length: OPERATORS }, (_, index) => PARAM_RATIO_BASE + index);
const levelIds = Array.from({ length: OPERATORS }, (_, index) => PARAM_OP_LEVEL_BASE + index);

const params = [
  knob(PARAM_TUNE, "tune", "tune", -36, 36, 0, 1),
  knob(PARAM_ALGORITHM, "algorithm", "alg", 0, 8, 0, 1),
  knob(PARAM_FEEDBACK, "feedback", "feed", 0, 1, 0.34, 0.01),
  knob(PARAM_INDEX, "index", "index", 0, 2.5, 0.82, 0.01),
  knob(PARAM_ATTACK, "attack", "attack", 0.001, 2, 0.004, 0.001, "s", "exponential"),
  knob(PARAM_DECAY, "decay", "decay", 0.02, 4, 0.75, 0.01, "s", "exponential"),
  knob(PARAM_RELEASE, "release", "release", 0.02, 4, 0.24, 0.01, "s", "exponential"),
  knob(PARAM_LEVEL, "level", "level", 0, 1, 0.65, 0.01),
  ...ratioIds.map((id, index) =>
    knob(id, `ratio${index + 1}`, `r${index + 1}`, 1 / 64, 16, defaultRatios[index], 0.001),
  ),
  ...levelIds.map((id, index) =>
    knob(id, `level${index + 1}`, `l${index + 1}`, 0, 1, defaultLevels[index], 0.01),
  ),
] satisfies ParamDefinition[];

export const dxDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.dx,
  slug: "dx",
  name: "DX",
  accent: "#3f9ea8",
  rackWidth: "half",
  rackUnits: 2,
  width: 376,
  minHeight: 382,
  inputs: [
    ...voiceInputs(),
    { id: 8, label: "index", kind: "cv", connectionOrder: 80 },
    { id: 9, label: "level", kind: "cv", connectionOrder: 81 },
    { id: 10, label: "width", kind: "cv", connectionOrder: 82 },
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
    { id: 2, label: "env", kind: "cv", connectionOrder: 2 },
    { id: 3, label: "gate", kind: "gate", connectionOrder: 3 },
  ],
  params,
  presets: dxFactoryPresets,
  Component: DxModule,
};

function DxModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  return (
    <ModuleShell {...props}>
      <KnobSections
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        sections={[
          {
            title: "global",
            paramIds: [
              PARAM_TUNE,
              PARAM_ALGORITHM,
              PARAM_FEEDBACK,
              PARAM_INDEX,
              PARAM_ATTACK,
              PARAM_DECAY,
              PARAM_RELEASE,
              PARAM_LEVEL,
            ],
          },
          {
            title: "ratios",
            paramIds: ratioIds,
          },
          {
            title: "levels",
            paramIds: levelIds,
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

function voiceInputs(): JackDefinition[] {
  const jacks: JackDefinition[] = [];
  for (let index = 0; index < VOICES; index += 1) {
    jacks.push({
      id: index,
      label: `pitch ${index + 1}`,
      kind: "cv",
      connectionGroup: `voice-${index}`,
      connectionGroupLabel: `${index + 1}`,
      connectionGroupOrder: index,
      connectionOrder: 0,
      connectionLabel: "V/O",
    });
    jacks.push({
      id: index + VOICES,
      label: `gate ${index + 1}`,
      kind: "gate",
      connectionGroup: `voice-${index}`,
      connectionGroupLabel: `${index + 1}`,
      connectionGroupOrder: index,
      connectionOrder: 1,
      connectionLabel: "gate",
    });
  }
  return jacks;
}
