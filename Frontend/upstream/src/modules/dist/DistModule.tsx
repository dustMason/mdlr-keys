import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "../productionPanel.css";
import "./DistModule.css";

const PARAM_CUTOFF = 0;
const PARAM_RESONANCE = 1;
const PARAM_CURVE = 2;
const PARAM_DRIVE = 3;
const PARAM_SATURATION = 4;
const PARAM_FEEDBACK = 5;
const PARAM_LEVEL = 6;
const PARAM_MIX = 7;
const PARAM_FOLD = 8;
const PARAM_FOLD_SHAPE = 9;
const PARAM_CHOW = 10;
const PARAM_RECT = 11;
const PARAM_FLIP = 12;

const params = withBypass([
  knob(PARAM_CUTOFF, "cutoff", "cut", 100, 20_000, 20_000, "Hz", "exponential", 1),
  knob(PARAM_RESONANCE, "resonance", "res", 1, 8, 1, undefined, "linear", 0.01),
  knob(PARAM_CURVE, "curve", "curve", 0.1, 4, 1, undefined, "linear", 0.01),
  knob(PARAM_DRIVE, "drive", "drive", -10, 10, 4, undefined, "linear", 0.01),
  knob(PARAM_SATURATION, "saturation", "sat", 0, 1, 1, undefined, "linear", 0.01),
  knob(PARAM_FEEDBACK, "feedback", "fb", -60, -24, -60, "dB", "linear", 1),
  knob(PARAM_LEVEL, "level", "level", -24, 24, -3, "dB", "linear", 1),
  knob(PARAM_MIX, "mix", "mix", 0, 1, 1, undefined, "linear", 0.01),
  knob(PARAM_FOLD, "fold", "fold", 0, 1, 0.22, undefined, "linear", 0.01),
  knob(PARAM_FOLD_SHAPE, "fold_shape", "wrap", 0, 1, 0.42, undefined, "linear", 0.01),
  knob(PARAM_CHOW, "chow", "chew", 0, 1, 0.26, undefined, "linear", 0.01),
  knob(PARAM_RECT, "rect", "rect", 0, 1, 0.18, undefined, "linear", 0.01),
  knob(PARAM_FLIP, "flip", "flip", 0, 1, 0, undefined, "linear", 0.01),
]);

export const distDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.dist,
  slug: "dist",
  name: "DIST",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 716,
  minHeight: 292,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
    { id: 3, label: "right", kind: "audio", connectionOrder: 1 },
    { id: 1, label: "cut", kind: "cv" },
    { id: 2, label: "drive", kind: "cv" },
  ],
  outputs: [
    { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
    { id: 2, label: "right", kind: "audio", connectionOrder: 1 },
    { id: 1, label: "wet l", kind: "audio", connectionOrder: 2 },
    { id: 3, label: "wet r", kind: "audio", connectionOrder: 3 },
  ],
  params,
  Component: DistModule,
};

function DistModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const curve = module.params[PARAM_CURVE] ?? 1;
  const drive = module.params[PARAM_DRIVE] ?? 4;
  const saturation = module.params[PARAM_SATURATION] ?? 1;
  const feedback = module.params[PARAM_FEEDBACK] ?? -60;
  const fold = module.params[PARAM_FOLD] ?? 0.22;
  const chow = module.params[PARAM_CHOW] ?? 0.26;
  const rect = module.params[PARAM_RECT] ?? 0.18;

  return (
    <ModuleShell {...props}>
      <div className="distPanel">
        <div className="distDisplay" aria-hidden="true">
          {Array.from({ length: 13 }, (_, index) => {
            const center = index - 6;
            const skew = center * (0.7 + curve * 0.16);
            const height = 20 + Math.abs(center) * (4 + fold * 4) + saturation * 14 + chow * 12;
            return (
              <span
                key={index}
                style={{
                  height: `${height}%`,
                  opacity: 0.32 + Math.min(0.42, Math.abs(drive) * 0.022 + rect * 0.12),
                  transform: `skewY(${skew}deg) scaleY(${1 + (feedback + 60) / 110})`,
                }}
              />
            );
          })}
        </div>
        <KnobSections
          module={module}
          definition={definition}
          onParamChange={onParamChange}
          className="distSections"
          sections={[
            { title: "filter", paramIds: [PARAM_CUTOFF, PARAM_RESONANCE] },
            { title: "drive", paramIds: [PARAM_CURVE, PARAM_DRIVE, PARAM_SATURATION] },
            { title: "fold", paramIds: [PARAM_FOLD, PARAM_FOLD_SHAPE] },
            { title: "chow", paramIds: [PARAM_CHOW, PARAM_RECT, PARAM_FLIP] },
            { title: "out", paramIds: [PARAM_FEEDBACK, PARAM_LEVEL, PARAM_MIX] },
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
