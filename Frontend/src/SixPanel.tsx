// Local touch adaptation. Original source is preserved under upstream/.
import { TouchFader } from "./TouchFader";
import type { ReactNode } from "react";
import { ModuleKnob } from "../upstream/src/components/Knob";
import { ModuleShell } from "../upstream/src/components/ModuleShell";
import { sixFactoryPresets } from "../upstream/src/modules/factoryPresets";
import { MODULE_KINDS } from "../upstream/src/modules/kinds";
import { paramById, valueForParam } from "../upstream/src/modules/panelSections";
import type {
  JackDefinition,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../upstream/src/modules/types";
import "../upstream/src/modules/six/SixModule.css";

const VOICES = 6;

const PARAM_TUNE = 0;
const PARAM_RANGE = 1;
const PARAM_PULSE_WIDTH = 2;
const PARAM_PWM_MODE = 3;
const PARAM_PWM_AMOUNT = 4;
const PARAM_PULSE = 5;
const PARAM_SAW = 6;
const PARAM_SUB = 7;
const PARAM_NOISE = 8;
const PARAM_HPF = 9;
const PARAM_CUTOFF = 10;
const PARAM_RESONANCE = 11;
const PARAM_ENV_DEPTH = 12;
const PARAM_LFO_FILTER = 13;
const PARAM_KEY_FOLLOW = 14;
const PARAM_VCA_MODE = 15;
const PARAM_VCA_LEVEL = 16;
const PARAM_ATTACK = 17;
const PARAM_DECAY = 18;
const PARAM_SUSTAIN = 19;
const PARAM_RELEASE = 20;
const PARAM_LFO_RATE = 21;
const PARAM_LFO_DELAY = 22;
const PARAM_CHORUS = 23;
const PARAM_CHORUS_MIX = 24;
const PARAM_SPREAD = 25;
const PARAM_ANALOG = 26;
const PARAM_DRIVE = 27;
const PARAM_FILTER_ATTACK = 28;
const PARAM_FILTER_DECAY = 29;
const PARAM_FILTER_SUSTAIN = 30;
const PARAM_FILTER_RELEASE = 31;
const PARAM_LFO_DCO = 32;

const params = [
  knob(PARAM_TUNE, "tune", "tune", -36, 24, 1, 0),
  selector(PARAM_RANGE, "range", "range", 0, 5, 1),
  knob(PARAM_PULSE_WIDTH, "pulse_width", "pw", 0.04, 0.96, 0.01, 0.52),
  selector(PARAM_PWM_MODE, "pwm_mode", "pwm src", 0, 5, 1),
  knob(PARAM_PWM_AMOUNT, "pwm_amount", "pwm", 0, 1, 0.01, 0.22),
  knob(PARAM_PULSE, "pulse", "pulse", 0, 1, 0.01, 0.46),
  knob(PARAM_SAW, "saw", "saw", 0, 1, 0.01, 0.84),
  knob(PARAM_SUB, "sub", "sub", 0, 1, 0.01, 0.38),
  knob(PARAM_NOISE, "noise", "noise", 0, 1, 0.01, 0),
  knob(PARAM_HPF, "hpf", "hpf", 0, 1, 0.01, 0.12),
  knob(PARAM_CUTOFF, "cutoff", "cut", 0, 1, 0.01, 0.62),
  knob(PARAM_RESONANCE, "resonance", "res", 0, 0.9, 0.01, 0.18),
  knob(PARAM_ENV_DEPTH, "env_depth", "env", -1, 1, 0.01, 0.32),
  knob(PARAM_LFO_FILTER, "lfo_filter", "lfo", 0, 1, 0.01, 0),
  knob(PARAM_KEY_FOLLOW, "key_follow", "key", 0, 1, 0.01, 0.42),
  selector(PARAM_VCA_MODE, "vca_mode", "vca", 0, 1, 1),
  knob(PARAM_VCA_LEVEL, "vca_level", "level", 0, 1, 0.01, 0.72),
  time(PARAM_ATTACK, "attack", "atk", 0.001, 2.5, 0.006),
  time(PARAM_DECAY, "decay", "dec", 0.01, 4, 0.72),
  knob(PARAM_SUSTAIN, "sustain", "sus", 0, 1, 0.01, 0.76),
  time(PARAM_RELEASE, "release", "rel", 0.01, 5, 0.42),
  knob(PARAM_LFO_RATE, "lfo_rate", "rate", 0, 1, 0.01, 0.22),
  knob(PARAM_LFO_DELAY, "lfo_delay", "delay", 0, 1, 0.01, 0),
  selector(PARAM_CHORUS, "chorus", "chorus", 0, 3, 1),
  knob(PARAM_CHORUS_MIX, "chorus_mix", "mix", 0, 1, 0.01, 0.42),
  knob(PARAM_SPREAD, "spread", "spread", 0, 1, 0.01, 0.34),
  knob(PARAM_ANALOG, "analog", "analog", 0, 1, 0.01, 0.12),
  knob(PARAM_DRIVE, "drive", "drive", 0, 1, 0.01, 0.18),
  time(PARAM_FILTER_ATTACK, "filter_attack", "A", 0.001, 2.5, 0.004),
  time(PARAM_FILTER_DECAY, "filter_decay", "D", 0.01, 4, 0.48),
  knob(PARAM_FILTER_SUSTAIN, "filter_sustain", "S", 0, 1, 0.01, 0.24),
  time(PARAM_FILTER_RELEASE, "filter_release", "R", 0.01, 5, 0.26),
  knob(PARAM_LFO_DCO, "lfo_dco", "dco", 0, 1, 0.01, 0),
] satisfies ParamDefinition[];

export const sixDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.six,
  slug: "six",
  name: "SIX",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 604,
  minHeight: 414,
  inputs: [
    ...voiceInputs(),
    { id: 12, label: "cutoff", kind: "cv", connectionOrder: 90 },
    { id: 13, label: "mod", kind: "cv", connectionOrder: 91 },
    { id: 14, label: "level", kind: "cv", connectionOrder: 92 },
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
  presets: sixFactoryPresets,
  Component: SixModule,
};

function SixModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="sixPanel">
        <SixSection className="sixLfoSection" title="LFO" tone="white">
          <div className="sixLfoControls">
            <SixFader {...propsForParam(props, PARAM_LFO_RATE)} label="RATE" />
            <div className="sixLfoKnobs">
              <SixKnob {...propsForParam(props, PARAM_LFO_DCO)} label="DCO" />
              <SixKnob {...propsForParam(props, PARAM_LFO_FILTER)} label="VCF" />
            </div>
          </div>
        </SixSection>

        <SixSection className="sixDcoSection" title="DCO">
          <div className="sixDcoGrid">
            <SixButtonGroup
              className="sixRangeGroup"
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_RANGE}
              label="range"
              options={[
                ["8'", 1],
                ["4'", 2],
                ["2'", 5],
                ["64'", 3],
                ["32'", 4],
                ["16'", 0],
              ]}
            />
            <div className="sixDcoMod">
              <SixFader {...propsForParam(props, PARAM_PWM_AMOUNT)} label="PWM" />
              <SixPwmSelector
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_PWM_MODE}
                label="PWM SRC"
                options={[
                  ["E2-", 3],
                  ["E2+", 2],
                  ["E1-", 5],
                  ["E1+", 4],
                  ["LFO", 1],
                  ["MAN", 0],
                ]}
              />
            </div>
            <div className="sixDcoMix">
              <div className="sixFaderGroup sixFaderGroupTwo">
                <SixFader
                  {...propsForParam(props, PARAM_PULSE)}
                  label="PULSE"
                  icon="pulse"
                />
                <SixFader {...propsForParam(props, PARAM_SAW)} label="SAW" icon="saw" />
              </div>
              <div className="sixFaderGroup sixFaderGroupTwo">
                <SixFader {...propsForParam(props, PARAM_SUB)} label="SUB" />
                <SixFader {...propsForParam(props, PARAM_NOISE)} label="NOISE" />
              </div>
            </div>
          </div>
        </SixSection>

        <SixSection className="sixHpfSection" title="HPF">
          <div className="sixSingleFader">
            <SixFader {...propsForParam(props, PARAM_HPF)} label="FREQ" />
          </div>
        </SixSection>

        <SixSection className="sixFilterSection" title="VCF">
          <div className="sixVcfGrid">
            <SixFader {...propsForParam(props, PARAM_VCA_LEVEL)} label="LEVEL" />
            <div className="sixFaderGroup sixFaderGroupTwo">
              <SixFader {...propsForParam(props, PARAM_CUTOFF)} label="FREQ" />
              <SixFader {...propsForParam(props, PARAM_RESONANCE)} label="RES" />
            </div>
            <div className="sixFaderGroup sixFaderGroupTwo">
              <SixFader {...propsForParam(props, PARAM_ENV_DEPTH)} label="ENV-1" />
              <SixFader {...propsForParam(props, PARAM_KEY_FOLLOW)} label="KYBD" />
            </div>
          </div>
        </SixSection>

        <SixSection className="sixChorusSection" title="CHORUS" tone="blue">
          <div className="sixChorusPanel">
            <SixButtonGroup
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_CHORUS}
              label="mode"
              options={[
                ["OFF", 0],
                ["I", 1],
                ["II", 2],
                ["I+II", 3],
              ]}
            />
            <div className="sixChorusFaders">
              <SixFader {...propsForParam(props, PARAM_CHORUS_MIX)} label="MIX" />
              <SixFader {...propsForParam(props, PARAM_SPREAD)} label="SPREAD" />
              <SixFader {...propsForParam(props, PARAM_ANALOG)} label="AGED" />
            </div>
          </div>
        </SixSection>

        <SixSection className="sixEnvOneSection" title="ENV-1">
          <div className="sixEnvGrid sixFaderGroup sixFaderGroupFour">
            <SixFader {...propsForParam(props, PARAM_FILTER_ATTACK)} label="A" />
            <SixFader {...propsForParam(props, PARAM_FILTER_DECAY)} label="D" />
            <SixFader {...propsForParam(props, PARAM_FILTER_SUSTAIN)} label="S" />
            <SixFader {...propsForParam(props, PARAM_FILTER_RELEASE)} label="R" />
          </div>
        </SixSection>

        <SixSection className="sixEnvTwoSection" title="ENV-2">
          <div className="sixEnvGrid sixFaderGroup sixFaderGroupFour">
            <SixFader {...propsForParam(props, PARAM_ATTACK)} label="A" />
            <SixFader {...propsForParam(props, PARAM_DECAY)} label="D" />
            <SixFader {...propsForParam(props, PARAM_SUSTAIN)} label="S" />
            <SixFader {...propsForParam(props, PARAM_RELEASE)} label="R" />
          </div>
        </SixSection>
      </div>
    </ModuleShell>
  );
}

function SixSection({
  title,
  tone = "red",
  className,
  children,
}: {
  title: string;
  tone?: "red" | "blue" | "white";
  className: string;
  children: ReactNode;
}) {
  return (
    <section className={["sixSection", `sixSection-${tone}`, className].join(" ")}>
      <h2>{title}</h2>
      <div className="sixSectionBody">{children}</div>
    </section>
  );
}

function SixButtonGroup({
  className,
  module,
  definition,
  onParamChange,
  paramId,
  label,
  options,
}: {
  className?: string;
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
  options: Array<[string, number]>;
}) {
  const param = paramById(paramId, definition);
  const value = Math.round(valueForParam(module.params, param));

  return (
    <div
      className={["sixButtonGroup", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={param.label}
    >
      <span>{label}</span>
      <div className="sixButtonRow">
        {options.map(([optionLabel, optionValue]) => (
          <button
            key={optionLabel}
            type="button"
            className={value === optionValue ? "isActive" : ""}
            aria-pressed={value === optionValue}
            onClick={() => onParamChange(module.id, param.id, optionValue)}
          >
            {optionLabel}
          </button>
        ))}
      </div>
    </div>
  );
}

function SixPwmSelector({
  module,
  definition,
  onParamChange,
  paramId,
  label,
  options,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
  options: Array<[string, number]>;
}) {
  const param = paramById(paramId, definition);
  const value = Math.round(valueForParam(module.params, param));

  return (
    <div className="sixVerticalSelector" role="group" aria-label={param.label}>
      <span>{label}</span>
      <div className="sixVerticalSwitch">
        {options.map(([label, optionValue]) => (
          <button
            key={label}
            type="button"
            className={value === optionValue ? "isActive" : ""}
            aria-pressed={value === optionValue}
            onClick={() => onParamChange(module.id, param.id, optionValue)}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function propsForParam(props: ModuleRenderProps, paramId: number) {
  return {
    module: props.module,
    definition: props.definition,
    onParamChange: props.onParamChange,
    paramId,
  };
}

function SixKnob({
  module,
  definition,
  onParamChange,
  paramId,
  label,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
}) {
  const param = paramById(paramId, definition);

  return (
    <ModuleKnob
      definition={definition}
      param={{ ...param, label }}
      value={valueForParam(module.params, param)}
      accent="#f3f3ee"
      className="sixModKnob"
      onChange={(value) => onParamChange(module.id, param.id, value)}
    />
  );
}

function SixFader({
  module,
  definition,
  onParamChange,
  paramId,
  label,
  icon,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label?: string;
  icon?: "pulse" | "saw";
}) {
  const param = paramById(paramId, definition);
  const value = valueForParam(module.params, param);
  return <TouchFader param={param} value={value} theme="six" label={label}
    decoration={icon ? <span className={`sixWaveIcon sixWaveIcon-${icon}`} aria-hidden="true" /> : null}
    onChange={next => onParamChange(module.id, param.id, next)} />;
}

function voiceInputs(): JackDefinition[] {
  return Array.from({ length: VOICES }, (_, voice) => [
    {
      id: voice,
      label: `${voice + 1} pitch`,
      kind: "cv" as const,
      connectionGroup: `voice-${voice + 1}-in`,
      connectionGroupLabel: `${voice + 1}`,
      connectionGroupOrder: voice,
      connectionOrder: 0,
      connectionLabel: "CV",
    },
    {
      id: voice + VOICES,
      label: `${voice + 1} gate`,
      kind: "gate" as const,
      connectionGroup: `voice-${voice + 1}-in`,
      connectionGroupLabel: `${voice + 1}`,
      connectionGroupOrder: voice,
      connectionOrder: 1,
      connectionLabel: "GATE",
    },
  ]).flat();
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue };
}

function time(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min, max, step: 0.001, defaultValue, unit: "s", scale: "exponential" };
}

function selector(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min, max, step: 1, defaultValue };
}



function snapValue(value: number, parameter: ParamDefinition) {
  const step = parameter.step > 0 ? parameter.step : 0.01;
  const snapped = Math.round((value - parameter.min) / step) * step + parameter.min;
  const clamped = Math.max(parameter.min, Math.min(parameter.max, snapped));
  const decimals = decimalPlaces(step);
  return Number(clamped.toFixed(Math.min(8, decimals + 2)));
}

function decimalPlaces(value: number) {
  const text = value.toString();
  if (!text.includes(".")) {
    return 0;
  }
  return text.split(".")[1]?.length ?? 0;
}

