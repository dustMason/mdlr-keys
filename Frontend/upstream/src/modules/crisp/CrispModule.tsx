import { ModuleKnob } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections, paramById, valueForParam } from "../panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "../productionPanel.css";
import "./CrispModule.css";

const PARAM_AMOUNT = 0;
const PARAM_MODE = 1;
const PARAM_STEREO = 2;
const PARAM_RM_LPF_FREQ = 3;
const PARAM_RM_LPF_Q = 4;
const PARAM_NOISE_HPF_FREQ = 5;
const PARAM_NOISE_HPF_Q = 6;
const PARAM_NOISE_LPF_FREQ = 7;
const PARAM_NOISE_LPF_Q = 8;
const PARAM_OUTPUT_DB = 9;
const PARAM_WET_ONLY = 10;

const MODE_LABELS = ["soggy", "crisp", "alt"] as const;

const params = withBypass([
  knob(PARAM_AMOUNT, "amount", "amt", 0, 1, 0.35),
  knob(PARAM_MODE, "mode", "mode", 0, 2, 1, undefined, "linear", 1),
  knob(PARAM_STEREO, "stereo", "stereo", 0, 1, 1, undefined, "linear", 1),
  knob(PARAM_RM_LPF_FREQ, "rmLp", "rm lp", 5, 22_000, 22_000, "Hz", "exponential", 1),
  knob(PARAM_RM_LPF_Q, "rmQ", "rm q", 0.5, 10, 0.707, undefined, "linear", 0.01),
  knob(PARAM_NOISE_HPF_FREQ, "noiseHp", "nz hp", 5, 22_000, 5, "Hz", "exponential", 1),
  knob(PARAM_NOISE_HPF_Q, "noiseHpQ", "hp q", 0.5, 10, 0.707, undefined, "linear", 0.01),
  knob(PARAM_NOISE_LPF_FREQ, "noiseLp", "nz lp", 5, 22_000, 22_000, "Hz", "exponential", 1),
  knob(PARAM_NOISE_LPF_Q, "noiseLpQ", "lp q", 0.5, 10, 0.707, undefined, "linear", 0.01),
  knob(PARAM_OUTPUT_DB, "output", "out", -24, 0, 0, "dB", "linear", 0.1),
  knob(PARAM_WET_ONLY, "wetOnly", "wet", 0, 1, 0, undefined, "linear", 1),
]);

export const crispDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.crisp,
  slug: "crisp",
  name: "CRISP",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 720,
  minHeight: 286,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "stereo-in",
      connectionGroupLabel: "stereo in",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "stereo-in",
      connectionGroupLabel: "stereo in",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
    {
      id: 2,
      label: "amount",
      kind: "cv",
      connectionGroup: "mod-in",
      connectionGroupLabel: "amount",
      connectionGroupOrder: 1,
    },
  ],
  outputs: [
    {
      id: 0,
      label: "left",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "main out",
      connectionGroupOrder: 0,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "right",
      kind: "audio",
      connectionGroup: "main-out",
      connectionGroupLabel: "main out",
      connectionGroupOrder: 0,
      connectionOrder: 1,
      connectionLabel: "R",
    },
    {
      id: 2,
      label: "wet left",
      kind: "audio",
      connectionGroup: "wet-out",
      connectionGroupLabel: "wet out",
      connectionGroupOrder: 1,
      connectionOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 3,
      label: "wet right",
      kind: "audio",
      connectionGroup: "wet-out",
      connectionGroupLabel: "wet out",
      connectionGroupOrder: 1,
      connectionOrder: 1,
      connectionLabel: "R",
    },
  ],
  params,
  Component: CrispModule,
};

function CrispModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const amount = valueForParam(module.params, paramById(PARAM_AMOUNT, definition));
  const mode = Math.round(valueForParam(module.params, paramById(PARAM_MODE, definition)));
  const stereo = valueForParam(module.params, paramById(PARAM_STEREO, definition)) >= 0.5;
  const wetOnly = valueForParam(module.params, paramById(PARAM_WET_ONLY, definition)) >= 0.5;
  const output = valueForParam(module.params, paramById(PARAM_OUTPUT_DB, definition));

  return (
    <ModuleShell {...props}>
      <div className="crispPanel">
        <div className="crispDisplay" aria-hidden="true">
          <div className="crispNoiseBars">
            {Array.from({ length: 21 }, (_, index) => {
              const curve = Math.sin(index * 1.7 + mode * 0.83);
              const height = 18 + Math.abs(curve) * (42 + amount * 28);
              return (
                <span
                  key={index}
                  style={{
                    height: `${height}%`,
                    opacity: 0.34 + amount * 0.46,
                  }}
                />
              );
            })}
          </div>
          <div className="crispDisplayReadout">
            <strong>{MODE_LABELS[Math.max(0, Math.min(2, mode))]}</strong>
            <span>{stereo ? "stereo" : "mono"}</span>
            <span>{wetOnly ? "wet" : "mix"}</span>
          </div>
        </div>

        <div className="crispControls">
          <div className="crispSwitchPanel">
            <div className="crispModeSwitches" role="group" aria-label="CRISP mode">
              {MODE_LABELS.map((label, index) => (
                <button
                  key={label}
                  type="button"
                  className={index === mode ? "isActive" : ""}
                  onClick={() => onParamChange(module.id, PARAM_MODE, index)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="crispPrimaryBlock">
            <div className="crispPrimaryKnobs">
              <ModuleKnob
                definition={definition}
                param={paramById(PARAM_AMOUNT, definition)}
                value={amount}
                onChange={(value) => onParamChange(module.id, PARAM_AMOUNT, value)}
              />
              <ModuleKnob
                definition={definition}
                param={paramById(PARAM_OUTPUT_DB, definition)}
                value={output}
                onChange={(value) => onParamChange(module.id, PARAM_OUTPUT_DB, value)}
              />
            </div>
            <div className="crispToggles">
              <button
                type="button"
                className={stereo ? "isActive" : ""}
                onClick={() => onParamChange(module.id, PARAM_STEREO, stereo ? 0 : 1)}
              >
                stereo
              </button>
              <button
                type="button"
                className={wetOnly ? "isActive" : ""}
                onClick={() => onParamChange(module.id, PARAM_WET_ONLY, wetOnly ? 0 : 1)}
              >
                wet only
              </button>
            </div>
          </div>

          <KnobSections
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            className="crispSections"
            sections={[
              { title: "ring input", paramIds: [PARAM_RM_LPF_FREQ, PARAM_RM_LPF_Q] },
              {
                title: "noise filter",
                paramIds: [
                  PARAM_NOISE_HPF_FREQ,
                  PARAM_NOISE_HPF_Q,
                  PARAM_NOISE_LPF_FREQ,
                  PARAM_NOISE_LPF_Q,
                ],
              },
            ]}
          />
        </div>
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
