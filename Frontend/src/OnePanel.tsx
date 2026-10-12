// Local touch adaptation. Original source is preserved under upstream/.
import { TouchFader } from "./TouchFader";
import type { CSSProperties } from "react";
import { ModuleShell } from "../upstream/src/components/ModuleShell";
import { oneFactoryPresets } from "../upstream/src/modules/factoryPresets";
import { MODULE_KINDS } from "../upstream/src/modules/kinds";
import {
  KnobList,
  ProductionSection,
  paramById,
  valueForParam,
} from "../upstream/src/modules/panelSections";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../upstream/src/modules/types";
import "../upstream/src/modules/productionPanel.css";
import "../upstream/src/modules/one/OneModule.css";

const PARAM_TUNE = 0;
const PARAM_RANGE = 1;
const PARAM_PULSE_WIDTH = 2;
const PARAM_PWM_MODE = 3;
const PARAM_PWM_AMOUNT = 4;
const PARAM_VCO_MOD = 5;
const PARAM_SAW = 6;
const PARAM_PULSE = 7;
const PARAM_SUB = 8;
const PARAM_SUB_MODE = 9;
const PARAM_NOISE = 10;
const PARAM_CUTOFF = 11;
const PARAM_RESONANCE = 12;
const PARAM_ENV_DEPTH = 13;
const PARAM_LFO_FILTER = 14;
const PARAM_KEY_FOLLOW = 15;
const PARAM_VCA_MODE = 16;
const PARAM_ATTACK = 17;
const PARAM_DECAY = 18;
const PARAM_SUSTAIN = 19;
const PARAM_RELEASE = 20;
const PARAM_TRIGGER_MODE = 21;
const PARAM_LFO_RATE = 22;
const PARAM_LFO_WAVE = 23;
const PARAM_PORTAMENTO = 24;
const PARAM_PORTAMENTO_MODE = 25;
const PARAM_LEVEL = 26;
const PARAM_DRIVE = 27;
const PARAM_ANALOG = 28;
const LFO_MIN_HZ = 0.05;
const LFO_MAX_HZ = 35;

const vcoFaders = [PARAM_VCO_MOD, PARAM_PULSE_WIDTH, PARAM_PWM_AMOUNT];
const sourceFaders = [PARAM_SAW, PARAM_PULSE, PARAM_SUB];
const filterFaders = [
  PARAM_CUTOFF,
  PARAM_RESONANCE,
  PARAM_ENV_DEPTH,
  PARAM_LFO_FILTER,
  PARAM_KEY_FOLLOW,
];
const envFaders = [PARAM_ATTACK, PARAM_DECAY, PARAM_SUSTAIN, PARAM_RELEASE];

const params = [
  knob(PARAM_TUNE, "tune", "tune", -24, 24, 1, 0),
  selector(PARAM_RANGE, "range", "range", 0, 3, 1),
  knob(PARAM_PULSE_WIDTH, "pulse_width", "pulse width", 0.04, 0.96, 0.01, 0.52),
  selector(PARAM_PWM_MODE, "pwm_mode", "pwm", 0, 2, 1),
  knob(PARAM_PWM_AMOUNT, "pwm_amount", "pwm mod", 0, 1, 0.01, 0.22),
  knob(PARAM_VCO_MOD, "vco_mod", "mod", 0, 1, 0.01, 0.04),
  knob(PARAM_SAW, "saw", "saw", 0, 1, 0.01, 0.82),
  knob(PARAM_PULSE, "pulse", "pulse", 0, 1, 0.01, 0.46),
  knob(PARAM_SUB, "sub", "sub", 0, 1, 0.01, 0.44),
  selector(PARAM_SUB_MODE, "sub_mode", "sub", 0, 2, 1),
  knob(PARAM_NOISE, "noise", "noise", 0, 1, 0.01, 0),
  knob(PARAM_CUTOFF, "cutoff", "freq", 0, 1, 0.01, 0.58),
  knob(PARAM_RESONANCE, "resonance", "res", 0, 1, 0.01, 0.2),
  knob(PARAM_ENV_DEPTH, "env_depth", "env", -1, 1, 0.01, 0.34),
  knob(PARAM_LFO_FILTER, "lfo_filter", "mod", 0, 1, 0.01, 0),
  knob(PARAM_KEY_FOLLOW, "key_follow", "kybd", 0, 1, 0.01, 0.62),
  selector(PARAM_VCA_MODE, "vca_mode", "vca", 0, 1, 1),
  time(PARAM_ATTACK, "attack", "a", 0.001, 3, 0.003),
  time(PARAM_DECAY, "decay", "d", 0.01, 4.5, 0.38),
  knob(PARAM_SUSTAIN, "sustain", "s", 0, 1, 0.01, 0.28),
  time(PARAM_RELEASE, "release", "r", 0.01, 2, 0.16),
  selector(PARAM_TRIGGER_MODE, "trigger_mode", "trig", 0, 2, 1),
  knob(PARAM_LFO_RATE, "lfo_rate", "lfo/clk rate", 0, 1, 0.01, 0.18),
  selector(PARAM_LFO_WAVE, "lfo_wave", "wave", 0, 3, 1),
  knob(PARAM_PORTAMENTO, "portamento", "portamento", 0, 1, 0.01, 0.08),
  selector(PARAM_PORTAMENTO_MODE, "portamento_mode", "mode", 0, 1, 1),
  knob(PARAM_LEVEL, "level", "volume", 0, 1, 0.01, 0.7),
  knob(PARAM_DRIVE, "drive", "drive", 0, 1, 0.01, 0.16),
  knob(PARAM_ANALOG, "analog", "drift", 0, 1, 0.01, 0.18),
] satisfies ParamDefinition[];

export const oneDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.one,
  slug: "one",
  name: "ONE",
  accent: "#111111",
  presets: oneFactoryPresets,
  rackWidth: "full",
  rackUnits: 1,
  width: 604,
  minHeight: 206,
  inputs: [
    { id: 0, label: "pitch", kind: "cv", connectionOrder: 0 },
    { id: 1, label: "gate", kind: "gate", connectionOrder: 1 },
    { id: 2, label: "cutoff", kind: "cv", connectionOrder: 2 },
    { id: 3, label: "mod", kind: "cv", connectionOrder: 3 },
    { id: 4, label: "level", kind: "cv", connectionOrder: 4 },
  ],
  outputs: [
    { id: 0, label: "audio", kind: "audio", connectionOrder: 0 },
    { id: 1, label: "gate", kind: "gate", connectionOrder: 1 },
    { id: 2, label: "env", kind: "cv", connectionOrder: 2 },
    { id: 3, label: "lfo", kind: "cv", connectionOrder: 3 },
  ],
  params,
  Component: OneModule,
};

function OneModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="onePanel">
        <section className="productionSection oneSection oneTuneSection" aria-label="tune">
          <span className="onePilotLight" aria-hidden="true" />
          <KnobList
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramIds={[PARAM_TUNE]}
            className="oneKnobGrid oneKnobGridOne oneTuneKnob"
          />
          <KnobList
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramIds={[PARAM_ANALOG]}
            className="oneKnobGrid oneKnobGridOne oneDriftKnob"
          />
        </section>

        <ProductionSection title="modulator" className="oneSection oneModSection">
          <div className="oneModGrid">
            <div className="oneFaderBank oneFaderBankOne">
              <OneFader
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_LFO_RATE}
                className="oneLfoRateFader"
              />
            </div>
            <div className="oneWaveColumn">
              <span className="oneMiniLabel">waveform</span>
              <SegmentedParam
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_LFO_WAVE}
                className="oneWaveSwitch"
                options={[
                  ["tri", 0],
                  ["sq", 1],
                  ["rnd", 2],
                  ["nz", 3],
                ]}
              />
            </div>
          </div>
        </ProductionSection>

        <ProductionSection title="vco" className="oneSection oneVcoSection">
          <div className="oneVcoGrid">
            <div className="oneFaderBank oneFaderBankThree oneVcoFaders">
              {vcoFaders.map((paramId) => (
                <OneFader
                  key={paramId}
                  module={module}
                  definition={definition}
                  onParamChange={onParamChange}
                  paramId={paramId}
                />
              ))}
            </div>
            <div className="oneVcoSelectors">
              <SegmentedParam
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_RANGE}
                className="oneRangeSwitch"
                options={[
                  ["16", 0],
                  ["8", 1],
                  ["4", 2],
                  ["2", 3],
                ]}
              />
              <SegmentedParam
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_PWM_MODE}
                className="onePwmSwitch"
                options={[
                  ["man", 0],
                  ["lfo", 1],
                  ["env", 2],
                ]}
              />
            </div>
          </div>
        </ProductionSection>

        <ProductionSection title="source mixer" className="oneSection oneMixerSection">
          <div className="oneMixerGrid">
            <div className="oneFaderBank oneFaderBankThree">
              {sourceFaders.map((paramId) => (
                <OneFader
                  key={paramId}
                  module={module}
                  definition={definition}
                  onParamChange={onParamChange}
                  paramId={paramId}
                />
              ))}
            </div>
            <SegmentedParam
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_SUB_MODE}
              className="oneSubSwitch"
              options={[
                ["1 oct", 0],
                ["2 oct", 1],
                ["2 p", 2],
              ]}
            />
            <div className="oneFaderBank oneFaderBankOne oneNoiseFader">
              <OneFader
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_NOISE}
              />
            </div>
          </div>
        </ProductionSection>

        <ProductionSection title="vcf" className="oneSection oneFilterSection">
          <div className="oneFilterGrid">
            <div className="oneFaderBank oneFaderBankFive">
              {filterFaders.map((paramId) => (
                <OneFader
                  key={paramId}
                  module={module}
                  definition={definition}
                  onParamChange={onParamChange}
                  paramId={paramId}
                />
              ))}
            </div>
          </div>
        </ProductionSection>

        <ProductionSection title="vca" className="oneSection oneVcaSection">
          <SegmentedParam
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_VCA_MODE}
            className="oneVcaSwitch"
            options={[
              ["gate", 0],
              ["env", 1],
            ]}
          />
        </ProductionSection>

        <ProductionSection title="env" className="oneSection oneEnvSection">
          <div className="oneEnvGrid">
            <div className="oneFaderBank oneFaderBankFour">
              {envFaders.map((paramId) => (
                <OneFader
                  key={paramId}
                  module={module}
                  definition={definition}
                  onParamChange={onParamChange}
                  paramId={paramId}
                />
              ))}
            </div>
          </div>
        </ProductionSection>

        <ProductionSection title="volume" className="oneSection onePerformanceSection">
          <div className="onePerformanceGrid">
            <KnobList
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramIds={[PARAM_LEVEL]}
              className="oneKnobGrid oneKnobGridOne onePerformanceKnob"
            />
            <KnobList
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramIds={[PARAM_PORTAMENTO]}
              className="oneKnobGrid oneKnobGridOne onePerformanceKnob"
            />
            <SegmentedParam
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_PORTAMENTO_MODE}
              className="onePortamentoMode"
              options={[
                ["off", 0],
                ["on", 1],
              ]}
            />
          </div>
        </ProductionSection>
      </div>
    </ModuleShell>
  );
}

function SegmentedParam({
  module,
  definition,
  onParamChange,
  paramId,
  options,
  className = "",
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  options: Array<[string, number]>;
  className?: string;
}) {
  const param = paramById(paramId, definition);
  const rawValue = Math.round(valueForParam(module.params, param));
  const value = Math.min(param.max, Math.max(param.min, rawValue));

  return (
    <div
      className={["oneSegmented", className].filter(Boolean).join(" ")}
      role="group"
      aria-label={param.label}
    >
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
  );
}

function OneFader({
  module,
  definition,
  onParamChange,
  paramId,
  className = "",
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  className?: string;
}) {
  const param = paramById(paramId, definition);
  const value = valueForParam(module.params, param);
  const isLfoRate = paramId === PARAM_LFO_RATE;
  return <TouchFader param={param} value={value} theme="one" className={className}
    style={isLfoRate ? {"--one-led-period": `${lfoPeriodSeconds(value).toFixed(3)}s`} as CSSProperties : undefined}
    decoration={isLfoRate ? <span className="oneLfoLed" aria-hidden="true" /> : null}
    onChange={next => onParamChange(module.id, param.id, next)} />;
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

function lfoPeriodSeconds(value: number) {
  const normalized = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const hz = LFO_MIN_HZ * Math.pow(LFO_MAX_HZ / LFO_MIN_HZ, normalized);
  return 1 / Math.max(LFO_MIN_HZ, hz);
}
