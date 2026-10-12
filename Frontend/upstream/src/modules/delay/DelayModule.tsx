import { ModuleShell } from "../../components/ModuleShell";
import { BYPASS_PARAM_ID, withBypass } from "../bypass";
import { MODULE_KINDS } from "../kinds";
import { KnobSections } from "../panelSections";
import type { JackDefinition, ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";

const PARAM_DELAY_TIME = 0;
const PARAM_LFO_AMOUNT = 1;
const PARAM_LFO_FREQUENCY = 2;
const PARAM_DRIFT_AMOUNT = 3;
const PARAM_DRIFT_SPEED = 4;
const PARAM_TEMPO_SYNC = 5;
const PARAM_FEEDBACK = 6;
const PARAM_STEREO_OFFSET = 7;
const PARAM_PAN_MODE = 8;
const PARAM_PAN = 9;
const PARAM_DUCK_AMOUNT = 10;
const PARAM_DUCK_ATTACK = 11;
const PARAM_DUCK_RELEASE = 12;
const PARAM_FILTER_MODE = 13;
const PARAM_LOW_PASS = 14;
const PARAM_HIGH_PASS = 15;
const PARAM_DRIVE_GAIN = 16;
const PARAM_DRIVE_MIX = 17;
const PARAM_DRIVE_CUTOFF = 18;
const PARAM_DRIVE_ITERATIONS = 19;
const PARAM_DRY_VOLUME = 20;
const PARAM_WET_VOLUME = 21;

const params = withBypass([
  knob(PARAM_DELAY_TIME, "delay_time", "time", 0.001, 2, 0.2, 0.001, "s", "exponential"),
  knob(PARAM_LFO_AMOUNT, "lfo_amount", "lfo", 0, 0.5, 0, 0.001),
  knob(PARAM_LFO_FREQUENCY, "lfo_frequency", "rate", 0.1, 10, 2, 0.01, "hz", "exponential"),
  knob(PARAM_DRIFT_AMOUNT, "drift_amount", "drift", 0, 0.05, 0.001, 0.001),
  knob(PARAM_DRIFT_SPEED, "drift_speed", "speed", 0.1, 10, 1, 0.01, "", "exponential"),
  knob(PARAM_TEMPO_SYNC, "tempo_sync", "sync", 0, 19, 0, 1),
  knob(PARAM_FEEDBACK, "feedback", "feed", -1, 1, 0.5, 0.01),
  knob(PARAM_STEREO_OFFSET, "stereo_offset", "offset", -0.5, 0.5, 0, 0.01),
  knob(PARAM_PAN_MODE, "pan_mode", "pan mode", 0, 2, 0, 1),
  knob(PARAM_PAN, "pan", "pan", -1.57, 1.57, 0, 0.01),
  knob(PARAM_DUCK_AMOUNT, "duck_amount", "duck", 0, 10, 0, 0.01),
  knob(PARAM_DUCK_ATTACK, "duck_attack", "attack", 0.1, 100, 10, 0.1, "", "exponential"),
  knob(PARAM_DUCK_RELEASE, "duck_release", "release", 0.1, 100, 10, 0.1, "", "exponential"),
  knob(PARAM_FILTER_MODE, "filter_mode", "filter", 0, 3, 0, 1),
  knob(PARAM_LOW_PASS, "low_pass", "low", 0.01, 1, 0.75, 0.01),
  knob(PARAM_HIGH_PASS, "high_pass", "high", 0.001, 0.99, 0.001, 0.001, "", "exponential"),
  knob(PARAM_DRIVE_GAIN, "drive_gain", "drive", 0, 10, 0.1, 0.01, "", "exponential"),
  knob(PARAM_DRIVE_MIX, "drive_mix", "drive mix", 0, 1, 1, 0.01),
  knob(PARAM_DRIVE_CUTOFF, "drive_cutoff", "drive cut", 0.01, 1, 1, 0.01),
  knob(PARAM_DRIVE_ITERATIONS, "drive_iterations", "iters", 1, 16, 1, 1),
  knob(PARAM_DRY_VOLUME, "dry_volume", "dry", 0, 2, 1, 0.01),
  knob(PARAM_WET_VOLUME, "wet_volume", "wet", 0, 2, 0.5, 0.01),
]);

export const delayDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.delay,
  slug: "delay",
  name: "DELAY",
  accent: "#3f9ea8",
  rackWidth: "half",
  rackUnits: 2,
  width: 376,
  minHeight: 382,
  bypassParamId: BYPASS_PARAM_ID,
  inputs: stereoJacks("input", "in", "main-in", 0),
  outputs: stereoJacks("output", "out", "main-out", 0),
  params,
  Component: DelayModule,
};

function DelayModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  return (
    <ModuleShell {...props}>
      <KnobSections
        module={module}
        definition={definition}
        onParamChange={onParamChange}
        sections={[
          {
            title: "delay",
            paramIds: [
              PARAM_DELAY_TIME,
              PARAM_TEMPO_SYNC,
              PARAM_FEEDBACK,
              PARAM_STEREO_OFFSET,
            ],
          },
          {
            title: "motion",
            paramIds: [
              PARAM_LFO_AMOUNT,
              PARAM_LFO_FREQUENCY,
              PARAM_DRIFT_AMOUNT,
              PARAM_DRIFT_SPEED,
              PARAM_PAN_MODE,
              PARAM_PAN,
            ],
          },
          {
            title: "tone",
            paramIds: [
              PARAM_FILTER_MODE,
              PARAM_LOW_PASS,
              PARAM_HIGH_PASS,
              PARAM_DRIVE_GAIN,
              PARAM_DRIVE_MIX,
              PARAM_DRIVE_CUTOFF,
              PARAM_DRIVE_ITERATIONS,
            ],
          },
          {
            title: "mix",
            paramIds: [
              PARAM_DUCK_AMOUNT,
              PARAM_DUCK_ATTACK,
              PARAM_DUCK_RELEASE,
              PARAM_DRY_VOLUME,
              PARAM_WET_VOLUME,
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
