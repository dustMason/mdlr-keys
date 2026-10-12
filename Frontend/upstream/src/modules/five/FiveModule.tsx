import type { CSSProperties, ReactNode } from "react";
import { ModuleKnob } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { fiveFactoryPresets } from "../factoryPresets";
import { MODULE_KINDS } from "../kinds";
import {
  paramById,
  valueForParam,
} from "../panelSections";
import type {
  JackDefinition,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./FiveModule.css";

const VOICES = 5;

const PARAM_TUNE = 0;
const PARAM_OSC_A_FREQ = 1;
const PARAM_OSC_B_FREQ = 2;
const PARAM_OSC_B_FINE = 3;
const PARAM_PULSE_WIDTH_A = 4;
const PARAM_PULSE_WIDTH_B = 5;
const PARAM_OSC_A_SAW = 6;
const PARAM_OSC_A_PULSE = 7;
const PARAM_OSC_B_TRI = 8;
const PARAM_OSC_B_SAW = 9;
const PARAM_OSC_B_PULSE = 10;
const PARAM_NOISE = 11;
const PARAM_CUTOFF = 12;
const PARAM_RESONANCE = 13;
const PARAM_ENV_AMOUNT = 14;
const PARAM_KEY_TRACK = 15;
const PARAM_FILTER_ATTACK = 16;
const PARAM_FILTER_DECAY = 17;
const PARAM_FILTER_SUSTAIN = 18;
const PARAM_FILTER_RELEASE = 19;
const PARAM_AMP_ATTACK = 20;
const PARAM_AMP_DECAY = 21;
const PARAM_AMP_SUSTAIN = 22;
const PARAM_AMP_RELEASE = 23;
const PARAM_LFO_FREQ = 24;
const PARAM_LFO_AMOUNT = 25;
const PARAM_LFO_SHAPE = 26;
const PARAM_SOURCE_MIX = 27;
const PARAM_WHEEL_FREQ_A = 28;
const PARAM_WHEEL_FREQ_B = 29;
const PARAM_WHEEL_PW_A = 30;
const PARAM_WHEEL_PW_B = 31;
const PARAM_WHEEL_FILTER = 32;
const PARAM_POLY_ENV = 33;
const PARAM_POLY_B = 34;
const PARAM_POLY_FREQ_A = 35;
const PARAM_POLY_PW_A = 36;
const PARAM_POLY_FILTER = 37;
const PARAM_SYNC = 38;
const PARAM_OSC_B_LOW = 39;
const PARAM_OSC_B_KEYBOARD = 40;
const PARAM_REV = 41;
const PARAM_VINTAGE = 42;
const PARAM_LEVEL = 43;
const PARAM_SPREAD = 44;
const PARAM_DRIVE = 45;
const PARAM_GLIDE = 46;
const PARAM_LFO_SYNC = 47;
const PARAM_LEGATO = 48;
const PARAM_UNISON = 49;
const PARAM_OSC_A_LEVEL = 50;
const PARAM_OSC_B_LEVEL = 51;

const params = [
  knob(PARAM_TUNE, "tune", "tune", -36, 24, 1, 0),
  knob(PARAM_OSC_A_FREQ, "osc_a_freq", "a freq", -24, 24, 1, 0),
  knob(PARAM_OSC_B_FREQ, "osc_b_freq", "b freq", -24, 24, 1, 0),
  knob(PARAM_OSC_B_FINE, "osc_b_fine", "b fine", -1, 1, 0.01, 0.07),
  knob(PARAM_PULSE_WIDTH_A, "pulse_width_a", "pw a", 0.04, 0.96, 0.01, 0.5),
  knob(PARAM_PULSE_WIDTH_B, "pulse_width_b", "pw b", 0.04, 0.96, 0.01, 0.5),
  knob(PARAM_OSC_A_SAW, "osc_a_saw", "a saw", 0, 1, 0.01, 0.82),
  knob(PARAM_OSC_A_PULSE, "osc_a_pulse", "a pulse", 0, 1, 0.01, 0.18),
  knob(PARAM_OSC_B_TRI, "osc_b_tri", "b tri", 0, 1, 0.01, 0),
  knob(PARAM_OSC_B_SAW, "osc_b_saw", "b saw", 0, 1, 0.01, 0.54),
  knob(PARAM_OSC_B_PULSE, "osc_b_pulse", "b pulse", 0, 1, 0.01, 0),
  knob(PARAM_NOISE, "noise", "noise", 0, 1, 0.01, 0),
  knob(PARAM_CUTOFF, "cutoff", "cut", 0, 1, 0.01, 0.56),
  knob(PARAM_RESONANCE, "resonance", "res", 0, 0.92, 0.01, 0.18),
  knob(PARAM_ENV_AMOUNT, "env_amount", "env", 0, 1, 0.01, 0.34),
  knob(PARAM_KEY_TRACK, "key_track", "key", 0, 1, 0.01, 0.46),
  time(PARAM_FILTER_ATTACK, "filter_attack", "f atk", 0.001, 2.5, 0.006),
  time(PARAM_FILTER_DECAY, "filter_decay", "f dec", 0.01, 4, 0.42),
  knob(PARAM_FILTER_SUSTAIN, "filter_sustain", "f sus", 0, 1, 0.01, 0.36),
  time(PARAM_FILTER_RELEASE, "filter_release", "f rel", 0.01, 5, 0.36),
  time(PARAM_AMP_ATTACK, "amp_attack", "a atk", 0.001, 2.5, 0.006),
  time(PARAM_AMP_DECAY, "amp_decay", "a dec", 0.01, 4, 0.72),
  knob(PARAM_AMP_SUSTAIN, "amp_sustain", "a sus", 0, 1, 0.01, 0.82),
  time(PARAM_AMP_RELEASE, "amp_release", "a rel", 0.01, 5, 0.42),
  knob(PARAM_LFO_FREQ, "lfo_freq", "lfo hz", 0, 1, 0.01, 0.25),
  knob(PARAM_LFO_AMOUNT, "lfo_amount", "lfo amt", 0, 1, 0.01, 0),
  selector(PARAM_LFO_SHAPE, "lfo_shape", "lfo", 0, 2, 1),
  knob(PARAM_SOURCE_MIX, "source_mix", "src mix", 0, 1, 0.01, 0),
  toggle(PARAM_WHEEL_FREQ_A, "wheel_freq_a", "freq a", 0),
  toggle(PARAM_WHEEL_FREQ_B, "wheel_freq_b", "freq b", 0),
  toggle(PARAM_WHEEL_PW_A, "wheel_pw_a", "pw a", 0),
  toggle(PARAM_WHEEL_PW_B, "wheel_pw_b", "pw b", 0),
  toggle(PARAM_WHEEL_FILTER, "wheel_filter", "filter", 0),
  knob(PARAM_POLY_ENV, "poly_env", "env mod", 0, 1, 0.01, 0),
  knob(PARAM_POLY_B, "poly_b", "b mod", 0, 1, 0.01, 0),
  toggle(PARAM_POLY_FREQ_A, "poly_freq_a", "freq a", 0),
  toggle(PARAM_POLY_PW_A, "poly_pw_a", "pw a", 0),
  toggle(PARAM_POLY_FILTER, "poly_filter", "filter", 0),
  toggle(PARAM_SYNC, "sync", "sync", 0),
  toggle(PARAM_OSC_B_LOW, "osc_b_low", "lo freq", 0),
  toggle(PARAM_OSC_B_KEYBOARD, "osc_b_keyboard", "kbd", 1),
  selector(PARAM_REV, "rev", "rev", 0, 1, 1),
  knob(PARAM_VINTAGE, "vintage", "vintage", 0, 1, 0.01, 0.22),
  knob(PARAM_LEVEL, "level", "level", 0, 1, 0.01, 0.62),
  knob(PARAM_SPREAD, "spread", "spread", 0, 1, 0.01, 0.42),
  knob(PARAM_DRIVE, "drive", "drive", 0, 1, 0.01, 0.2),
  knob(PARAM_GLIDE, "glide", "glide", 0, 1, 0.01, 0),
  toggle(PARAM_LFO_SYNC, "lfo_sync", "sync", 0),
  toggle(PARAM_LEGATO, "legato", "legato", 0),
  toggle(PARAM_UNISON, "unison", "unison", 0),
  knob(PARAM_OSC_A_LEVEL, "osc_a_level", "osc 1", 0, 1, 0.01, 0.82),
  knob(PARAM_OSC_B_LEVEL, "osc_b_level", "osc 2", 0, 1, 0.01, 0.64),
] satisfies ParamDefinition[];

export const fiveDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.five,
  slug: "five",
  name: "FIVE",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 604,
  minHeight: 414,
  inputs: [
    ...voiceInputs(),
    { id: 10, label: "cutoff", kind: "cv", connectionOrder: 90 },
    { id: 11, label: "mod", kind: "cv", connectionOrder: 91 },
    { id: 12, label: "level", kind: "cv", connectionOrder: 92 },
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
  presets: fiveFactoryPresets,
  Component: FiveModule,
};

function FiveModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;

  return (
    <ModuleShell {...props}>
      <div className="fivePanel">
        <FiveSection title="oscillator 1" className="fiveOsc1Section">
          <div className="fiveOscControls fiveOsc1Controls">
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_OSC_A_FREQ}
              label="freq"
            />
            <FiveSwitchGroup label="shape" columns={2}>
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_A_SAW}
                label="saw"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_A_PULSE}
                label="pulse"
              />
            </FiveSwitchGroup>
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_PULSE_WIDTH_A}
              label="pulse width"
            />
            <FiveSwitchGroup label="sync" columns={1}>
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_SYNC}
                label="sync"
              />
            </FiveSwitchGroup>
          </div>
        </FiveSection>

        <FiveSection title="mixer" className="fiveMixerSection">
          <div className="fiveKnobRow fiveMixerControls">
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_OSC_A_LEVEL}
              label="osc 1"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_OSC_B_LEVEL}
              label="osc 2"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_NOISE}
              label="noise"
            />
          </div>
        </FiveSection>

        <FiveSection title="oscillator 2" className="fiveOsc2Section">
          <div className="fiveOscControls fiveOsc2Controls">
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_OSC_B_FREQ}
              label="freq"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_OSC_B_FINE}
              label="fine"
            />
            <FiveSwitchGroup label="shape" columns={3}>
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_B_TRI}
                label="tri"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_B_SAW}
                label="saw"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_B_PULSE}
                label="pulse"
              />
            </FiveSwitchGroup>
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_PULSE_WIDTH_B}
              label="pulse width"
            />
            <FiveSwitchGroup label="tracking" columns={2}>
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_B_LOW}
                label="lo freq"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_OSC_B_KEYBOARD}
                label="kbd"
              />
            </FiveSwitchGroup>
          </div>
        </FiveSection>

        <FiveSection title="filter" className="fiveFilterSection">
          <div className="fiveFilterControls">
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_CUTOFF}
              label="cutoff"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_RESONANCE}
              label="resonance"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_ENV_AMOUNT}
              label="env amt"
            />
            <SwitchButton
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_KEY_TRACK}
              label="kbd"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_FILTER_ATTACK}
              label="attack"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_FILTER_DECAY}
              label="decay"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_FILTER_SUSTAIN}
              label="sustain"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_FILTER_RELEASE}
              label="release"
            />
          </div>
        </FiveSection>

        <div className="fiveStandalone fiveVolumeSection">
          <FiveKnob
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_LEVEL}
            label="volume"
          />
        </div>

        <div className="fiveStandalone fiveTuneSection">
          <FiveKnob
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_TUNE}
            label="master tune"
          />
        </div>

        <FiveSection title="poly - mod" className="fivePolySection">
          <div className="fiveRouteGrid fivePolyControls">
            <div className="fiveKnobRow fivePolySources">
              <FiveKnob
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_POLY_ENV}
                label="filter env"
              />
              <FiveKnob
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_POLY_B}
                label="osc b"
              />
            </div>
            <div className="fiveSwitchBank fivePolyDestinations">
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_POLY_FREQ_A}
                label="freq 1"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_POLY_PW_A}
                label="pw 1"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_POLY_FILTER}
                label="filter"
              />
            </div>
            <span className="fiveRouteLabel fiveRouteLabelSource">src amount</span>
            <span className="fiveRouteLabel fiveRouteLabelDestination">destination</span>
          </div>
        </FiveSection>

        <FiveSection title="lfo" className="fiveLfoSection">
          <div className="fiveLfoControls">
            <SwitchButton
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_LFO_SYNC}
              label="sync"
            />
            <FiveKnob
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_LFO_FREQ}
              label="rate"
            />
            <SegmentedParam
              module={module}
              definition={definition}
              onParamChange={onParamChange}
              paramId={PARAM_LFO_SHAPE}
              options={[
                ["saw", 0],
                ["tri", 1],
                ["sqr", 2],
              ]}
            />
          </div>
        </FiveSection>

        <div className="fivePerformanceSection">
          <FiveKnob
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_GLIDE}
            label="glide"
          />
          <SwitchButton
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_LEGATO}
            label="legato"
          />
          <SwitchButton
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_UNISON}
            label="unison"
          />
          <FiveKnob
            module={module}
            definition={definition}
            onParamChange={onParamChange}
            paramId={PARAM_VINTAGE}
            label="detune"
          />
        </div>

        <FiveSection title="wheel - mod" className="fiveWheelSection">
          <div className="fiveRouteGrid fiveWheelControls">
            <div className="fiveKnobRow fiveWheelSource">
              <FiveKnob
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_SOURCE_MIX}
                label="src mix"
              />
            </div>
            <div className="fiveSwitchBank fiveWheelDestinations">
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_WHEEL_FREQ_A}
                label="freq 1"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_WHEEL_FREQ_B}
                label="freq 2"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_WHEEL_PW_A}
                label="pw 1"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_WHEEL_PW_B}
                label="pw 2"
              />
              <SwitchButton
                module={module}
                definition={definition}
                onParamChange={onParamChange}
                paramId={PARAM_WHEEL_FILTER}
                label="filter"
              />
            </div>
            <span className="fiveRouteLabel fiveRouteLabelSource">lfo/noise</span>
            <span className="fiveRouteLabel fiveRouteLabelDestination">destination</span>
          </div>
        </FiveSection>
      </div>
    </ModuleShell>
  );
}

function FiveSection({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={["fiveSection", className].filter(Boolean).join(" ")}>
      <h3 className="fiveSectionTitle">{title}</h3>
      {children}
    </section>
  );
}

function FiveKnob({
  module,
  definition,
  onParamChange,
  paramId,
  label,
  className = "",
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label?: string;
  className?: string;
}) {
  const param = paramById(paramId, definition);
  const displayParam = label === undefined ? param : { ...param, label };

  return (
    <ModuleKnob
      definition={definition}
      param={displayParam}
      accent="#d6d9d7"
      value={valueForParam(module.params, param)}
      onChange={(value) => onParamChange(module.id, param.id, value)}
      className={["fiveKnob", className].filter(Boolean).join(" ")}
    />
  );
}

function FiveSwitchGroup({
  label,
  columns,
  children,
}: {
  label: string;
  columns: number;
  children: ReactNode;
}) {
  return (
    <div
      className="fiveSwitchGroup"
      style={{ "--five-switch-columns": columns } as CSSProperties}
    >
      <div className="fiveSwitchBank">{children}</div>
      <span className="fiveGroupLabel">{label}</span>
    </div>
  );
}

function SwitchButton({
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
  label?: string;
}) {
  const param = paramById(paramId, definition);
  const active = valueForParam(module.params, param) >= 0.5;

  return (
    <button
      type="button"
      className={["fiveSwitch", active ? "isActive" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-pressed={active}
      onClick={() => onParamChange(module.id, param.id, active ? 0 : 1)}
    >
      <span className="fiveSwitchToggle" aria-hidden="true" />
      <span className="fiveSwitchLabel">{label ?? param.label}</span>
    </button>
  );
}

function SegmentedParam({
  module,
  definition,
  onParamChange,
  paramId,
  options,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  options: Array<[string, number]>;
}) {
  const param = paramById(paramId, definition);
  const value = Math.round(valueForParam(module.params, param));

  return (
    <div className="fiveSegmented" role="group" aria-label={param.label}>
      {options.map(([label, optionValue]) => (
        <button
          key={label}
          type="button"
          className={["fiveSwitch", value === optionValue ? "isActive" : ""]
            .filter(Boolean)
            .join(" ")}
          aria-pressed={value === optionValue}
          onClick={() => onParamChange(module.id, param.id, optionValue)}
        >
          <span className="fiveSwitchToggle" aria-hidden="true" />
          <span className="fiveSwitchLabel">{label}</span>
        </button>
      ))}
    </div>
  );
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

function toggle(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min: 0, max: 1, step: 1, defaultValue };
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
