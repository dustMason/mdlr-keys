import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections, paramById, valueForParam } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "../productionPanel.css";
import "./VerbModule.css";

const PARAM_PRE_DELAY = 0;
const PARAM_SIZE = 1;
const PARAM_DECAY = 2;
const PARAM_DIFFUSION = 3;
const PARAM_INPUT_LOW = 4;
const PARAM_INPUT_HIGH = 5;
const PARAM_TANK_LOW = 6;
const PARAM_TANK_HIGH = 7;
const PARAM_MOD_RATE = 8;
const PARAM_MOD_DEPTH = 9;
const PARAM_MOD_SHAPE = 10;
const PARAM_MIX = 11;
const PARAM_LEVEL = 12;
const PARAM_FREEZE = 13;
const PARAM_MODE = 14;
const PARAM_FREE_ROOM = 15;
const PARAM_FREE_DAMP = 16;
const PARAM_FREE_WIDTH = 17;

const params = withBypass([
  knob(PARAM_PRE_DELAY, "pre_delay", "pre", 0, 0.5, 0.018, "s", "linear", 0.001),
  knob(PARAM_SIZE, "size", "size", 0, 1, 0.52),
  knob(PARAM_DECAY, "decay", "decay", 0, 1, 0.62),
  knob(PARAM_DIFFUSION, "diffusion", "diff", 0, 1, 0.86),
  knob(PARAM_INPUT_LOW, "input_low", "in lo", 20, 1_000, 20, "Hz", "exponential", 1),
  knob(PARAM_INPUT_HIGH, "input_high", "in hi", 500, 20_000, 16_000, "Hz", "exponential", 1),
  knob(PARAM_TANK_LOW, "tank_low", "lo", 20, 1_000, 24, "Hz", "exponential", 1),
  knob(PARAM_TANK_HIGH, "tank_high", "hi", 500, 20_000, 10_500, "Hz", "exponential", 1),
  knob(PARAM_MOD_RATE, "mod_rate", "rate", 0, 1, 0.08),
  knob(PARAM_MOD_DEPTH, "mod_depth", "depth", 0, 1, 0.12),
  knob(PARAM_MOD_SHAPE, "mod_shape", "shape", 0, 1, 0.5),
  knob(PARAM_MIX, "mix", "mix", 0, 1, 0.42),
  knob(PARAM_LEVEL, "level", "level", 0, 1.2, 0.86),
  toggle(PARAM_FREEZE, "freeze", "freeze", 0),
  toggle(PARAM_MODE, "mode", "mode", 0),
  knob(PARAM_FREE_ROOM, "free_room", "room", 0, 1, 0.56),
  knob(PARAM_FREE_DAMP, "free_damp", "damp", 0, 1, 0.42),
  knob(PARAM_FREE_WIDTH, "free_width", "width", 0, 1, 1),
]);

export const verbDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.verb,
  slug: "verb",
  name: "VERB",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 716,
  minHeight: 302,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
    { id: 3, label: "right", kind: "audio", connectionOrder: 1 },
    { id: 1, label: "size", kind: "cv" },
    { id: 2, label: "decay", kind: "cv" },
    { id: 4, label: "freeze", kind: "gate" },
    { id: 5, label: "mod", kind: "cv" },
  ],
  outputs: [
    { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
    { id: 2, label: "right", kind: "audio", connectionOrder: 1 },
    { id: 1, label: "wet l", kind: "audio", connectionOrder: 2 },
    { id: 3, label: "wet r", kind: "audio", connectionOrder: 3 },
  ],
  params,
  Component: VerbModule,
};

function VerbModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const modeParam = paramById(PARAM_MODE, definition);
  const mode = valueForParam(module.params, modeParam) >= 0.5 ? "free" : "dattorro";

  return (
    <ModuleShell {...props}>
      <div className="verbPanel">
        <div className="verbModeRow">
          <button
            type="button"
            className={mode === "dattorro" ? "isActive" : ""}
            aria-pressed={mode === "dattorro"}
            onClick={() => onParamChange(module.id, PARAM_MODE, 0)}
          >
            dattorro
          </button>
          <button
            type="button"
            className={mode === "free" ? "isActive" : ""}
            aria-pressed={mode === "free"}
            onClick={() => onParamChange(module.id, PARAM_MODE, 1)}
          >
            free
          </button>
        </div>
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          className="verbSections"
          sections={
            mode === "free"
              ? [
                  { title: "tank", paramIds: [PARAM_FREE_ROOM, PARAM_FREE_DAMP, PARAM_FREE_WIDTH] },
                  { title: "input", paramIds: [PARAM_INPUT_LOW, PARAM_INPUT_HIGH] },
                  {
                    title: "return",
                    paramIds: [PARAM_MIX, PARAM_LEVEL],
                    accessory: (
                      <ToggleButton
                        module={module}
                        definition={definition}
                        paramId={PARAM_FREEZE}
                        onParamChange={onParamChange}
                      />
                    ),
                  },
                ]
              : [
                  { title: "input", paramIds: [PARAM_PRE_DELAY, PARAM_INPUT_LOW, PARAM_INPUT_HIGH] },
                  { title: "plate", paramIds: [PARAM_SIZE, PARAM_DECAY, PARAM_DIFFUSION] },
                  { title: "damp", paramIds: [PARAM_TANK_LOW, PARAM_TANK_HIGH] },
                  { title: "mod", paramIds: [PARAM_MOD_RATE, PARAM_MOD_DEPTH, PARAM_MOD_SHAPE] },
                  {
                    title: "return",
                    paramIds: [PARAM_MIX, PARAM_LEVEL],
                    accessory: (
                      <ToggleButton
                        module={module}
                        definition={definition}
                        paramId={PARAM_FREEZE}
                        onParamChange={onParamChange}
                      />
                    ),
                  },
                ]
          }
        />
      </div>
    </ModuleShell>
  );
}

function ToggleButton({
  module,
  definition,
  paramId,
  onParamChange,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  paramId: number;
  onParamChange: ModuleRenderProps["onParamChange"];
}) {
  const param = paramById(paramId, definition);
  const active = valueForParam(module.params, param) >= 0.5;
  return (
    <button
      type="button"
      className={["verbFreeze", active ? "isActive" : ""].filter(Boolean).join(" ")}
      aria-pressed={active}
      onClick={() => onParamChange(module.id, param.id, active ? 0 : 1)}
    >
      hold
    </button>
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

function toggle(id: number, key: string, label: string, defaultValue: number): ParamDefinition {
  return { id, key, label, min: 0, max: 1, step: 1, defaultValue };
}
