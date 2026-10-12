import { useState } from "react";
import type { CSSProperties } from "react";
import { ModuleKnob } from "../../components/Knob";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import { paramById, valueForParam } from "../panelSections";
import type {
  JackDefinition,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./HitsModule.css";

const VOICES = 8;
const PARAM_MASTER = 0;
const PARAM_ACCENT = 1;
const VOICE_PARAM_BASE = 32;
const VOICE_PARAM_STRIDE = 32;
const PARAM_LEVEL = 0;
const PARAM_PAN = 1;
const PARAM_OSC_NOISE_MIX = 2;
const PARAM_EQ_FREQ = 3;
const PARAM_EQ_GAIN = 4;
const PARAM_DISTORT = 5;
const PARAM_CHOKE = 6;
const PARAM_OUTPUT_PAIR = 7;
const PARAM_OSC_WAVE = 8;
const PARAM_OSC_FREQ = 9;
const PARAM_PITCH_MODE = 10;
const PARAM_PITCH_AMOUNT = 11;
const PARAM_PITCH_RATE = 12;
const PARAM_OSC_ATTACK = 13;
const PARAM_OSC_DECAY = 14;
const PARAM_NOISE_FILTER_MODE = 15;
const PARAM_NOISE_FREQ = 16;
const PARAM_NOISE_Q = 17;
const PARAM_NOISE_STEREO = 18;
const PARAM_NOISE_ENV_MODE = 19;
const PARAM_NOISE_ATTACK = 20;
const PARAM_NOISE_DECAY = 21;
const PARAM_OSC_VEL = 22;
const PARAM_NOISE_VEL = 23;
const PARAM_MOD_VEL = 24;

const voiceNames = ["bd", "sd", "clp", "lt", "ht", "ch", "oh", "cy"] as const;

type HitsIconKind =
  | "sine"
  | "triangle"
  | "saw"
  | "noise"
  | "decay"
  | "lowpass"
  | "bandpass"
  | "highpass"
  | "exp"
  | "linear"
  | "clip";

interface ModeOption {
  label: string;
  value: number;
  icon?: HitsIconKind;
}

const params = [
  knob(PARAM_MASTER, "master", "master", -60, 6, 1, 0, "dB"),
  knob(PARAM_ACCENT, "accent", "accent", 0, 1, 0.01, 0.7),
  ...Array.from({ length: VOICES }, (_, voice) => voiceParams(voice)).flat(),
] satisfies ParamDefinition[];

export const hitsDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.hits,
  slug: "hits",
  name: "HITS",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 980,
  minHeight: 396,
  inputs: [
    ...voiceInputs(),
    { id: VOICES * 3, label: "choke", kind: "gate" },
  ],
  outputs: [
    { id: 0, label: "l", kind: "audio" },
    { id: 1, label: "r", kind: "audio" },
    { id: 2, label: "a-l", kind: "audio" },
    { id: 3, label: "a-r", kind: "audio" },
    { id: 4, label: "b-l", kind: "audio" },
    { id: 5, label: "b-r", kind: "audio" },
    ...voiceNames.map((label, index) => ({
      id: index + 6,
      label,
      kind: "audio" as const,
      connectionGroup: `voice-${index + 1}-out`,
      connectionGroupLabel: label.toUpperCase(),
      connectionGroupOrder: index,
      connectionOrder: 0,
      connectionLabel: label.toUpperCase(),
    })),
    { id: 14, label: "env", kind: "cv" },
    { id: 15, label: "gate", kind: "gate" },
  ],
  params,
  Component: HitsModule,
};

function HitsModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange, onModuleParamsChange } = props;
  const [activeVoice, setActiveVoice] = useState(0);
  const p = (offset: number) => voiceParamId(activeVoice, offset);
  const meters = props.mixerMeterData?.levels;

  function randomizeVoice(voice: number) {
    setActiveVoice(voice);
    onModuleParamsChange(module.id, randomizedVoiceParams(voice));
  }

  return (
    <ModuleShell {...props}>
      <div className="hitsPanel">
        <div className="hitsTop">
          <div className="hitsVoiceStrip" aria-label="HITS channels">
            {voiceNames.map((name, index) => {
              const level = Math.max(0, Math.min(1, meters?.[index] ?? 0));
              return (
                <div
                  key={name}
                  className={[
                    "hitsVoiceTile",
                    index === activeVoice ? "isActive" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ "--hits-led-level": level.toFixed(3) } as CSSProperties}
                >
                  <button
                    type="button"
                    className="hitsVoiceSelect"
                    onClick={() => setActiveVoice(index)}
                  >
                    <span>{index + 1}</span>
                    <strong>{name}</strong>
                  </button>
                  <i aria-hidden="true" />
                </div>
              );
            })}
          </div>
          <section className="hitsGlobalSection">
            <div className="hitsGlobalKnobs">
              <HitsKnob {...propsForParam(props, PARAM_MASTER)} label="MASTER" />
              <HitsKnob {...propsForParam(props, PARAM_ACCENT)} label="ACCENT" />
            </div>
          </section>
        </div>

        <div className="hitsEditor">
          <section className="hitsEditorSection hitsMixSection">
            <div className="hitsPatchRow">
              <button
                type="button"
                className="hitsPatchRandom"
                aria-label={`Randomize ${voiceNames[activeVoice]}`}
                title={`Randomize ${voiceNames[activeVoice]}`}
                onClick={() => randomizeVoice(activeVoice)}
              >
                RANDOMIZE
              </button>
            </div>
            <HitsSlider
              {...propsForParam(props, p(PARAM_OSC_NOISE_MIX))}
              label="mix"
              leftLabel="osc"
              rightLabel="noise"
            />
            <HitsSlider
              {...propsForParam(props, p(PARAM_EQ_FREQ))}
              label="eq freq"
              leftLabel="20Hz"
              rightLabel="20kHz"
            />
            <div className="hitsMixLower">
              <div className="hitsMixKnobs">
                <HitsKnob {...propsForParam(props, p(PARAM_DISTORT))} label="DISTORT" />
                <HitsKnob {...propsForParam(props, p(PARAM_EQ_GAIN))} label="EQ GAIN" />
                <HitsKnob {...propsForParam(props, p(PARAM_LEVEL))} label="LEVEL" />
                <HitsKnob {...propsForParam(props, p(PARAM_PAN))} label="PAN" />
              </div>
              <div className="hitsMixButtons">
                <HitsToggle
                  {...propsForParam(props, p(PARAM_CHOKE))}
                  label="choke"
                  text="CHOKE"
                />
                <HitsTextMode
                  {...propsForParam(props, p(PARAM_OUTPUT_PAIR))}
                  label="output"
                  options={[
                    { label: "A", value: 0 },
                    { label: "B", value: 1 },
                  ]}
                />
              </div>
            </div>
          </section>

          <section className="hitsEditorSection hitsOscSection">
            <HitsIconMode
              {...propsForParam(props, p(PARAM_OSC_WAVE))}
              className="hitsWaveMode"
              label="waveform"
              options={[
                { label: "SIN", value: 0, icon: "sine" },
                { label: "TRI", value: 1, icon: "triangle" },
                { label: "SAW", value: 2, icon: "saw" },
              ]}
            />
            <HitsSlider
              {...propsForParam(props, p(PARAM_OSC_FREQ))}
              label="osc freq"
              leftLabel="20Hz"
              rightLabel="20kHz"
            />
            <div className="hitsOscLower">
              <HitsIconMode
                {...propsForParam(props, p(PARAM_PITCH_MODE))}
                className="hitsPitchMode"
                label="pitch mod"
                options={[
                  { label: "DEC", value: 0, icon: "decay" },
                  { label: "SIN", value: 1, icon: "sine" },
                  { label: "RND", value: 2, icon: "noise" },
                ]}
              />
              <div className="hitsOscKnobs">
                <HitsKnob {...propsForParam(props, p(PARAM_PITCH_AMOUNT))} label="AMOUNT" />
                <HitsKnob {...propsForParam(props, p(PARAM_PITCH_RATE))} label="RATE" />
              </div>
              <div className="hitsFaderPair">
                <HitsFader {...propsForParam(props, p(PARAM_OSC_ATTACK))} label="ATTACK" />
                <HitsFader {...propsForParam(props, p(PARAM_OSC_DECAY))} label="DECAY" />
              </div>
            </div>
          </section>

          <section className="hitsEditorSection hitsNoiseSection">
            <HitsIconMode
              {...propsForParam(props, p(PARAM_NOISE_FILTER_MODE))}
              className="hitsFilterMode"
              label="filter mode"
              options={[
                { label: "LP", value: 0, icon: "lowpass" },
                { label: "BP", value: 1, icon: "bandpass" },
                { label: "HP", value: 2, icon: "highpass" },
              ]}
            />
            <HitsSlider
              {...propsForParam(props, p(PARAM_NOISE_FREQ))}
              label="filter freq"
              leftLabel="20Hz"
              rightLabel="20kHz"
            />
            <div className="hitsNoiseLower">
              <div className="hitsNoiseLeft">
                <HitsKnob {...propsForParam(props, p(PARAM_NOISE_Q))} label="FILTER Q" />
                <HitsToggle
                  {...propsForParam(props, p(PARAM_NOISE_STEREO))}
                  className="hitsStereoMode"
                  label="stereo"
                  text="STEREO"
                />
              </div>
              <HitsIconMode
                {...propsForParam(props, p(PARAM_NOISE_ENV_MODE))}
                className="hitsEnvMode"
                label="envelope"
                options={[
                  { label: "EXP", value: 0, icon: "exp" },
                  { label: "LIN", value: 1, icon: "linear" },
                  { label: "CLP", value: 2, icon: "clip" },
                ]}
              />
              <div className="hitsFaderPair">
                <HitsFader {...propsForParam(props, p(PARAM_NOISE_ATTACK))} label="ATTACK" />
                <HitsFader {...propsForParam(props, p(PARAM_NOISE_DECAY))} label="DECAY" />
              </div>
            </div>
          </section>
        </div>
      </div>
    </ModuleShell>
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

function HitsKnob({
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
      accent="#7ecf8e"
      className="hitsKnob"
      onChange={(value) => onParamChange(module.id, param.id, value)}
    />
  );
}

function HitsSlider({
  module,
  definition,
  onParamChange,
  paramId,
  label,
  leftLabel,
  rightLabel,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
  leftLabel?: string;
  rightLabel?: string;
}) {
  const param = paramById(paramId, definition);
  const normalized = normalizeValue(valueForParam(module.params, param), param);

  return (
    <label className="hitsSlider">
      <span className="hitsSliderTrack">
        <input
          aria-label={label}
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={normalized}
          onChange={(event) =>
            onParamChange(module.id, param.id, valueFromNormalized(Number(event.target.value), param))
          }
        />
      </span>
      <span className="hitsSliderLabel">{label}</span>
      <span className="hitsSliderScale" aria-hidden="true">
        <span>{leftLabel}</span>
        <span>{rightLabel}</span>
      </span>
    </label>
  );
}

function HitsFader({
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
  const normalized = normalizeValue(valueForParam(module.params, param), param);

  return (
    <label className="hitsFader">
      <span>{label}</span>
      <input
        aria-label={label}
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={normalized}
        onChange={(event) =>
          onParamChange(module.id, param.id, valueFromNormalized(Number(event.target.value), param))
        }
      />
    </label>
  );
}

function HitsTextMode(props: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
  options: ModeOption[];
}) {
  return <HitsIconMode {...props} className="hitsTextMode" />;
}

function HitsToggle({
  module,
  definition,
  onParamChange,
  paramId,
  label,
  text,
  className,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
  text: string;
  className?: string;
}) {
  const parameter = paramById(paramId, definition);
  const isActive = valueForParam(module.params, parameter) >= 0.5;

  return (
    <div className={["hitsToggle", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <button
        type="button"
        className={isActive ? "isActive" : ""}
        aria-pressed={isActive}
        aria-label={label}
        onClick={() => onParamChange(module.id, paramId, isActive ? 0 : 1)}
      >
        {text}
      </button>
    </div>
  );
}

function HitsIconMode({
  module,
  definition,
  onParamChange,
  paramId,
  label,
  options,
  className,
}: {
  module: ModuleRenderProps["module"];
  definition: ModuleDefinition;
  onParamChange: ModuleRenderProps["onParamChange"];
  paramId: number;
  label: string;
  options: ModeOption[];
  className?: string;
}) {
  const parameter = paramById(paramId, definition);
  const value = Math.round(valueForParam(module.params, parameter));

  return (
    <div className={["hitsMode", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <div>
        {options.map((option) => (
          <button
            key={option.label}
            type="button"
            className={value === option.value ? "isActive" : ""}
            aria-label={option.label}
            title={option.label}
            onClick={() => onParamChange(module.id, paramId, option.value)}
          >
            {option.icon ? <HitsIcon kind={option.icon} /> : option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function HitsIcon({ kind }: { kind: HitsIconKind }) {
  if (kind === "noise") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M4 19 L8 11 L12 25 L16 8 L20 23 L24 10 L28 21 L32 6 L36 20 L40 13 L44 18" />
      </svg>
    );
  }
  if (kind === "decay") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M7 25 L13 6 C18 7 20 14 23 19 C27 26 35 27 42 25" />
      </svg>
    );
  }
  if (kind === "triangle") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M4 24 L24 6 L44 24" />
      </svg>
    );
  }
  if (kind === "saw") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M5 24 L39 8 L39 24" />
      </svg>
    );
  }
  if (kind === "lowpass") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M5 9 L21 9 C29 9 32 23 43 23" />
      </svg>
    );
  }
  if (kind === "bandpass") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M5 24 C13 24 15 9 24 8 C33 9 35 24 43 24" />
      </svg>
    );
  }
  if (kind === "highpass") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M5 23 C16 23 19 9 27 9 L43 9" />
      </svg>
    );
  }
  if (kind === "exp") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M7 25 L13 6 C18 7 20 14 23 19 C27 26 35 27 42 25" />
      </svg>
    );
  }
  if (kind === "linear") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M8 25 L24 7 L40 25" />
      </svg>
    );
  }
  if (kind === "clip") {
    return (
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M8 24 C12 23 14 17 17 14 C20 10 22 7 25 8 C29 9 30 16 32 19 C35 24 39 25 42 23" />
        <path d="M12 23 L12 14 M16 18 L16 9 M20 12 L20 22" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 48 32" aria-hidden="true">
      <path d="M4 16 C10 3 18 3 24 16 C30 29 38 29 44 16" />
    </svg>
  );
}

function normalizeValue(value: number, parameter: ParamDefinition) {
  if (!Number.isFinite(value) || parameter.max <= parameter.min) {
    return 0;
  }
  const clamped = Math.max(parameter.min, Math.min(parameter.max, value));
  if (
    parameter.scale === "exponential" &&
    parameter.min > 0 &&
    parameter.max > parameter.min
  ) {
    return clamp01(Math.log(clamped / parameter.min) / Math.log(parameter.max / parameter.min));
  }

  return clamp01((clamped - parameter.min) / (parameter.max - parameter.min));
}

function valueFromNormalized(normalized: number, parameter: ParamDefinition) {
  const clamped = clamp01(normalized);
  if (
    parameter.scale === "exponential" &&
    parameter.min > 0 &&
    parameter.max > parameter.min
  ) {
    return snapParamValue(
      parameter.min * Math.pow(parameter.max / parameter.min, clamped),
      parameter,
    );
  }

  return snapParamValue(parameter.min + clamped * (parameter.max - parameter.min), parameter);
}

function snapParamValue(value: number, parameter: ParamDefinition) {
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

function clamp01(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function voiceInputs(): JackDefinition[] {
  return Array.from({ length: VOICES }, (_, voice) => [
    {
      id: voice,
      label: `${voiceNames[voice]} gate`,
      kind: "gate" as const,
      connectionGroup: `hits-${voice + 1}-in`,
      connectionGroupLabel: voiceNames[voice].toUpperCase(),
      connectionGroupOrder: voice,
      connectionOrder: 1,
      connectionLabel: "GATE",
    },
    {
      id: voice + VOICES,
      label: `${voiceNames[voice]} pitch`,
      kind: "cv" as const,
      connectionGroup: `hits-${voice + 1}-in`,
      connectionGroupLabel: voiceNames[voice].toUpperCase(),
      connectionGroupOrder: voice,
      connectionOrder: 0,
      connectionLabel: "CV",
    },
    {
      id: voice + VOICES * 2,
      label: `${voiceNames[voice]} accent`,
      kind: "cv" as const,
      connectionGroup: `hits-${voice + 1}-in`,
      connectionGroupLabel: voiceNames[voice].toUpperCase(),
      connectionGroupOrder: voice,
      connectionOrder: 2,
      connectionLabel: "ACC",
    },
  ]).flat();
}

function voiceParams(voice: number): ParamDefinition[] {
  const prefix = `voice_${voice + 1}`;
  const defaults = defaultVoiceParams(voice);
  const id = (offset: number) => voiceParamId(voice, offset);
  return [
    knob(id(PARAM_LEVEL), `${prefix}_level`, "level", -60, 10, 1, defaults.levelDb, "dB"),
    knob(id(PARAM_PAN), `${prefix}_pan`, "pan", -1, 1, 0.01, defaults.pan),
    knob(id(PARAM_OSC_NOISE_MIX), `${prefix}_mix`, "o/n", 0, 1, 0.01, defaults.mix),
    knob(id(PARAM_EQ_FREQ), `${prefix}_eq_freq`, "eq hz", 20, 20000, 1, defaults.eqFreq, "hz", "exponential"),
    knob(id(PARAM_EQ_GAIN), `${prefix}_eq_gain`, "eq", -40, 40, 1, defaults.eqGain, "dB"),
    knob(id(PARAM_DISTORT), `${prefix}_distort`, "dist", 0, 1, 0.01, defaults.distort),
    mode(id(PARAM_CHOKE), `${prefix}_choke`, "choke", defaults.choke),
    mode(id(PARAM_OUTPUT_PAIR), `${prefix}_output_pair`, "out", defaults.outputPair),
    mode(id(PARAM_OSC_WAVE), `${prefix}_osc_wave`, "wave", defaults.oscWave, 2),
    knob(id(PARAM_OSC_FREQ), `${prefix}_osc_freq`, "freq", 20, 20000, 1, defaults.oscFreq, "hz", "exponential"),
    mode(id(PARAM_PITCH_MODE), `${prefix}_pitch_mode`, "p mod", defaults.pitchMode, 2),
    knob(id(PARAM_PITCH_AMOUNT), `${prefix}_pitch_amount`, "p amt", -96, 96, 1, defaults.pitchAmount, "st"),
    knob(id(PARAM_PITCH_RATE), `${prefix}_pitch_rate`, "p rate", 0, 1, 0.01, defaults.pitchRate),
    knob(id(PARAM_OSC_ATTACK), `${prefix}_osc_attack`, "atk", 0.0005, 10, 0.001, defaults.oscAttack, "s", "exponential"),
    knob(id(PARAM_OSC_DECAY), `${prefix}_osc_decay`, "decay", 0.01, 10, 0.001, defaults.oscDecay, "s", "exponential"),
    mode(id(PARAM_NOISE_FILTER_MODE), `${prefix}_noise_filter_mode`, "filter", defaults.noiseFilterMode, 2),
    knob(id(PARAM_NOISE_FREQ), `${prefix}_noise_freq`, "n hz", 20, 20000, 1, defaults.noiseFreq, "hz", "exponential"),
    knob(id(PARAM_NOISE_Q), `${prefix}_noise_q`, "q", 0.1, 50, 0.01, defaults.noiseQ, "", "exponential"),
    mode(id(PARAM_NOISE_STEREO), `${prefix}_noise_stereo`, "stereo", defaults.noiseStereo),
    mode(id(PARAM_NOISE_ENV_MODE), `${prefix}_noise_env_mode`, "n env", defaults.noiseEnvMode, 2),
    knob(id(PARAM_NOISE_ATTACK), `${prefix}_noise_attack`, "n atk", 0.0005, 10, 0.001, defaults.noiseAttack, "s", "exponential"),
    knob(id(PARAM_NOISE_DECAY), `${prefix}_noise_decay`, "n dec", 0.01, 10, 0.001, defaults.noiseDecay, "s", "exponential"),
    knob(id(PARAM_OSC_VEL), `${prefix}_osc_vel`, "osc vel", 0, 2, 0.01, defaults.oscVel),
    knob(id(PARAM_NOISE_VEL), `${prefix}_noise_vel`, "n vel", 0, 2, 0.01, defaults.noiseVel),
    knob(id(PARAM_MOD_VEL), `${prefix}_mod_vel`, "mod vel", 0, 2, 0.01, defaults.modVel),
  ];
}

function voiceParamId(voice: number, offset: number) {
  return VOICE_PARAM_BASE + voice * VOICE_PARAM_STRIDE + offset;
}

function knob(
  id: number,
  key: string,
  label: string,
  min: number,
  max: number,
  step: number,
  defaultValue: number,
  unit?: string,
  scale: ParamDefinition["scale"] = "linear",
): ParamDefinition {
  return { id, key, label, min, max, step, defaultValue, unit, scale };
}

function mode(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
  max = 1,
): ParamDefinition {
  return { id, key, label, min: 0, max, step: 1, defaultValue };
}

function randomizedVoiceParams(voice: number): Record<number, number> {
  const defaults = defaultVoiceParams(voice);
  const id = (offset: number) => voiceParamId(voice, offset);
  const isBass = voice === 0;
  const isSnare = voice === 1 || voice === 2;
  const isTom = voice === 3 || voice === 4;
  const isMetal = voice >= 5;

  const oscFreq = isBass
    ? expRandom(36, 96)
    : isTom
      ? expRandom(78, 245)
      : isSnare
        ? expRandom(150, 620)
        : expRandom(900, 9_500);
  const noiseFreq = isBass
    ? expRandom(650, 4_800)
    : isTom
      ? expRandom(850, 5_200)
      : isSnare
        ? expRandom(1_200, 7_800)
        : expRandom(3_800, 16_000);
  const noiseFilterMode = isMetal ? 2 : isSnare ? randomChoice([1, 1, 2]) : randomChoice([0, 0, 1]);
  const noiseEnvMode = isSnare ? randomChoice([0, 1, 2]) : randomChoice([0, 0, 1]);
  const pitchMode = isMetal ? randomChoice([1, 2, 2]) : randomChoice([0, 0, 1, 2]);
  const oscWave = isMetal ? randomChoice([1, 2, 2]) : randomChoice([0, 0, 1, 2]);
  const mix = isBass
    ? randomRange(0.08, 0.38)
    : isTom
      ? randomRange(0.16, 0.48)
      : isSnare
        ? randomRange(0.48, 0.92)
        : randomRange(0.72, 1);

  return {
    [id(PARAM_LEVEL)]: snap(randomRange(defaults.levelDb - 5, defaults.levelDb + 4), 1),
    [id(PARAM_PAN)]: snap(randomRange(-0.38, 0.38), 0.01),
    [id(PARAM_OSC_NOISE_MIX)]: snap(mix, 0.01),
    [id(PARAM_EQ_FREQ)]: snap(expRandom(isBass ? 45 : 700, isMetal ? 14_000 : 6_500), 1),
    [id(PARAM_EQ_GAIN)]: snap(randomRange(-7, 10), 1),
    [id(PARAM_DISTORT)]: snap(randomRange(isMetal ? 0 : 0.02, isBass ? 0.42 : 0.26), 0.01),
    [id(PARAM_CHOKE)]: defaults.choke,
    [id(PARAM_OUTPUT_PAIR)]: defaults.outputPair,
    [id(PARAM_OSC_WAVE)]: oscWave,
    [id(PARAM_OSC_FREQ)]: snap(oscFreq, 1),
    [id(PARAM_PITCH_MODE)]: pitchMode,
    [id(PARAM_PITCH_AMOUNT)]: snap(randomRange(isBass ? 16 : -18, isBass ? 56 : 34), 1),
    [id(PARAM_PITCH_RATE)]: snap(randomRange(0.12, 0.94), 0.01),
    [id(PARAM_OSC_ATTACK)]: snap(expRandom(0.0005, isMetal ? 0.006 : 0.035), 0.001),
    [id(PARAM_OSC_DECAY)]: snap(expRandom(isMetal ? 0.018 : 0.06, isBass ? 0.85 : 1.6), 0.001),
    [id(PARAM_NOISE_FILTER_MODE)]: noiseFilterMode,
    [id(PARAM_NOISE_FREQ)]: snap(noiseFreq, 1),
    [id(PARAM_NOISE_Q)]: snap(expRandom(0.45, isMetal ? 3.8 : 2.2), 0.01),
    [id(PARAM_NOISE_STEREO)]: isBass ? 0 : randomChoice([0, 1]),
    [id(PARAM_NOISE_ENV_MODE)]: noiseEnvMode,
    [id(PARAM_NOISE_ATTACK)]: snap(expRandom(0.0005, isSnare ? 0.08 : 0.018), 0.001),
    [id(PARAM_NOISE_DECAY)]: snap(expRandom(isMetal ? 0.035 : 0.025, isMetal ? 1.4 : 0.55), 0.001),
    [id(PARAM_OSC_VEL)]: snap(randomRange(0, 0.95), 0.01),
    [id(PARAM_NOISE_VEL)]: snap(randomRange(0.18, 1.35), 0.01),
    [id(PARAM_MOD_VEL)]: snap(randomRange(0, 1.1), 0.01),
  };
}

function randomRange(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function expRandom(min: number, max: number) {
  return min * Math.pow(max / min, Math.random());
}

function randomChoice<T>(values: readonly T[]) {
  return values[Math.floor(Math.random() * values.length)] ?? values[0];
}

function snap(value: number, step: number) {
  return Number((Math.round(value / step) * step).toFixed(4));
}

function defaultVoiceParams(voice: number) {
  return [
  {
    levelDb: 0,
    pan: 0,
    mix: 0.18,
    eqFreq: 68,
    eqGain: 8,
    distort: 0.14,
    choke: 0,
    outputPair: 0,
    oscWave: 0,
    oscFreq: 54,
    pitchMode: 0,
    pitchAmount: 34,
    pitchRate: 0.86,
    oscAttack: 0.0005,
    oscDecay: 0.42,
    noiseFilterMode: 0,
    noiseFreq: 1900,
    noiseQ: 0.72,
    noiseStereo: 0,
    noiseEnvMode: 0,
    noiseAttack: 0.0005,
    noiseDecay: 0.045,
    oscVel: 0.18,
    noiseVel: 0.45,
    modVel: 0.34,
  },
  {
    levelDb: -1,
    pan: -0.08,
    mix: 0.58,
    eqFreq: 2300,
    eqGain: 4.5,
    distort: 0.08,
    choke: 0,
    outputPair: 0,
    oscWave: 1,
    oscFreq: 182,
    pitchMode: 0,
    pitchAmount: 9,
    pitchRate: 0.62,
    oscAttack: 0.0005,
    oscDecay: 0.18,
    noiseFilterMode: 1,
    noiseFreq: 2600,
    noiseQ: 1.35,
    noiseStereo: 1,
    noiseEnvMode: 1,
    noiseAttack: 0.0005,
    noiseDecay: 0.19,
    oscVel: 0.32,
    noiseVel: 0.72,
    modVel: 0.18,
  },
  {
    levelDb: -4,
    pan: 0.28,
    mix: 0.86,
    eqFreq: 1900,
    eqGain: 3,
    distort: 0.04,
    choke: 0,
    outputPair: 0,
    oscWave: 0,
    oscFreq: 245,
    pitchMode: 1,
    pitchAmount: 2,
    pitchRate: 0.24,
    oscAttack: 0.0005,
    oscDecay: 0.08,
    noiseFilterMode: 1,
    noiseFreq: 1850,
    noiseQ: 0.92,
    noiseStereo: 1,
    noiseEnvMode: 2,
    noiseAttack: 0.048,
    noiseDecay: 0.18,
    oscVel: 0,
    noiseVel: 0.58,
    modVel: 0,
  },
  {
    levelDb: -2,
    pan: -0.24,
    mix: 0.24,
    eqFreq: 116,
    eqGain: 4,
    distort: 0.08,
    choke: 0,
    outputPair: 0,
    oscWave: 1,
    oscFreq: 92,
    pitchMode: 0,
    pitchAmount: 18,
    pitchRate: 0.48,
    oscAttack: 0.0005,
    oscDecay: 0.54,
    noiseFilterMode: 0,
    noiseFreq: 1200,
    noiseQ: 0.76,
    noiseStereo: 0,
    noiseEnvMode: 0,
    noiseAttack: 0.0005,
    noiseDecay: 0.07,
    oscVel: 0.44,
    noiseVel: 0.28,
    modVel: 0.26,
  },
  {
    levelDb: -3,
    pan: 0.22,
    mix: 0.24,
    eqFreq: 184,
    eqGain: 3.5,
    distort: 0.08,
    choke: 0,
    outputPair: 0,
    oscWave: 1,
    oscFreq: 156,
    pitchMode: 0,
    pitchAmount: 15,
    pitchRate: 0.55,
    oscAttack: 0.0005,
    oscDecay: 0.38,
    noiseFilterMode: 0,
    noiseFreq: 1600,
    noiseQ: 0.82,
    noiseStereo: 0,
    noiseEnvMode: 0,
    noiseAttack: 0.0005,
    noiseDecay: 0.055,
    oscVel: 0.42,
    noiseVel: 0.25,
    modVel: 0.24,
  },
  {
    levelDb: -5,
    pan: -0.16,
    mix: 0.93,
    eqFreq: 8400,
    eqGain: 5.5,
    distort: 0.02,
    choke: 1,
    outputPair: 0,
    oscWave: 2,
    oscFreq: 6200,
    pitchMode: 2,
    pitchAmount: 16,
    pitchRate: 0.88,
    oscAttack: 0.0005,
    oscDecay: 0.045,
    noiseFilterMode: 2,
    noiseFreq: 6600,
    noiseQ: 0.95,
    noiseStereo: 0,
    noiseEnvMode: 0,
    noiseAttack: 0.0005,
    noiseDecay: 0.052,
    oscVel: 0.26,
    noiseVel: 0.82,
    modVel: 0.68,
  },
  {
    levelDb: -6,
    pan: 0.18,
    mix: 0.9,
    eqFreq: 7600,
    eqGain: 4,
    distort: 0.02,
    choke: 1,
    outputPair: 0,
    oscWave: 2,
    oscFreq: 5400,
    pitchMode: 2,
    pitchAmount: 13,
    pitchRate: 0.72,
    oscAttack: 0.0005,
    oscDecay: 0.08,
    noiseFilterMode: 2,
    noiseFreq: 5200,
    noiseQ: 0.86,
    noiseStereo: 1,
    noiseEnvMode: 0,
    noiseAttack: 0.0005,
    noiseDecay: 0.56,
    oscVel: 0.12,
    noiseVel: 0.72,
    modVel: 0.48,
  },
  {
    levelDb: -7,
    pan: 0,
    mix: 0.78,
    eqFreq: 5900,
    eqGain: 3,
    distort: 0.06,
    choke: 0,
    outputPair: 1,
    oscWave: 2,
    oscFreq: 1220,
    pitchMode: 1,
    pitchAmount: 11,
    pitchRate: 0.67,
    oscAttack: 0.001,
    oscDecay: 0.85,
    noiseFilterMode: 1,
    noiseFreq: 4100,
    noiseQ: 1.2,
    noiseStereo: 1,
    noiseEnvMode: 0,
    noiseAttack: 0.0005,
    noiseDecay: 1.15,
    oscVel: 0.18,
    noiseVel: 0.58,
    modVel: 0.34,
  },
  ][voice];
}
