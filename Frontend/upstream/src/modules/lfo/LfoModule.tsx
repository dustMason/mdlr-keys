import type { CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./LfoModule.css";

const PARAM_SHAPE = 0;
const PARAM_RATE = 1;
const PARAM_DEPTH = 2;
const PARAM_CENTER = 3;
const PARAM_MODE = 4;

const LOW_RATE_MIN = 0.02;
const LOW_RATE_MAX = 20;
const LOW_RATE_DEFAULT = 0.25;
const HIGH_RATE_MIN = 20;
const HIGH_RATE_MAX = 2000;
const HIGH_RATE_DEFAULT = 110;

const shapeOptions: Array<[string, number]> = [
  ["sin", 0],
  ["tri", 1],
  ["saw", 2],
  ["sq", 3],
  ["rnd", 4],
];

const modeOptions: Array<[string, number]> = [
  ["low", 0],
  ["high", 1],
];

export const lfoDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.lfo,
  slug: "lfo",
  name: "LFO",
  accent: "#111111",
  rackWidth: "half",
  rackUnits: 1,
  width: 304,
  minHeight: 286,
  inputs: [
    { id: 0, label: "rate", kind: "cv" },
    { id: 1, label: "reset", kind: "gate" },
  ],
  outputs: [
    { id: 0, label: "out", kind: "cv" },
    { id: 1, label: "inv", kind: "cv" },
  ],
  params: [
    {
      id: PARAM_SHAPE,
      key: "shape",
      label: "shape",
      min: 0,
      max: 4,
      step: 1,
      defaultValue: 0,
    },
    {
      id: PARAM_RATE,
      key: "rate",
      label: "rate",
      min: LOW_RATE_MIN,
      max: LOW_RATE_MAX,
      step: 0.01,
      defaultValue: LOW_RATE_DEFAULT,
      unit: "Hz",
      scale: "exponential",
    },
    {
      id: PARAM_DEPTH,
      key: "depth",
      label: "depth",
      min: 0,
      max: 2,
      step: 0.01,
      defaultValue: 0.5,
    },
    {
      id: PARAM_CENTER,
      key: "center",
      label: "center",
      min: -2,
      max: 2,
      step: 0.01,
      defaultValue: 0,
    },
    {
      id: PARAM_MODE,
      key: "mode",
      label: "mode",
      min: 0,
      max: 1,
      step: 1,
      defaultValue: 0,
    },
  ],
  Component: LfoModule,
};

function LfoModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange } = props;
  const shapeValue = Math.round(
    valueFor(module.params, param(PARAM_SHAPE, definition)),
  );
  const modeValue = Math.round(valueFor(module.params, param(PARAM_MODE, definition)));
  const centerValue = valueFor(module.params, param(PARAM_CENTER, definition));
  const depthValue = valueFor(module.params, param(PARAM_DEPTH, definition));
  const meterLevels = props.mixerMeterData?.levels;
  const indicatorPhase = clamp01(meterNumber(meterLevels, 1, 0));
  const fallbackWaveValue = waveValue(shapeValue, indicatorPhase);
  const outputValue = meterNumber(
    meterLevels,
    0,
    centerValue + fallbackWaveValue * depthValue,
  );
  const indicatorValue =
    depthValue > 0.001
      ? clampSigned((outputValue - centerValue) / depthValue)
      : fallbackWaveValue;
  const rateParam = rateParamForMode(param(PARAM_RATE, definition), modeValue);
  const knobParams = [
    rateParam,
    param(PARAM_DEPTH, definition),
    param(PARAM_CENTER, definition),
  ];

  function changeMode(value: number) {
    const currentRate = module.params[PARAM_RATE] ?? LOW_RATE_DEFAULT;
    const nextRate =
      value === 1
        ? currentRate < HIGH_RATE_MIN
          ? HIGH_RATE_DEFAULT
          : Math.min(HIGH_RATE_MAX, currentRate)
        : Math.min(LOW_RATE_MAX, Math.max(LOW_RATE_MIN, currentRate));

    onParamChange(module.id, PARAM_MODE, value);
    if (nextRate !== currentRate) {
      onParamChange(module.id, PARAM_RATE, nextRate);
    }
  }

  return (
    <ModuleShell {...props}>
      <div className="lfoPanel">
        <div className="lfoScope" style={{ color: definition.accent }} aria-hidden="true">
          {modeValue === 1 ? (
            <HighRatePreview
              shape={shapeValue}
              phase={indicatorPhase}
              value={indicatorValue}
              rate={valueForKnob(module.params, rateParam)}
              rateParam={rateParam}
            />
          ) : (
            <WavePreview
              shape={shapeValue}
              phase={indicatorPhase}
              value={indicatorValue}
            />
          )}
        </div>

        <div className="lfoSegments">
          <SegmentControl
            label="shape"
            options={shapeOptions}
            value={shapeValue}
            onChange={(value) => onParamChange(module.id, PARAM_SHAPE, value)}
          />

          <SegmentControl
            className="lfoSegmentMode"
            label="mode"
            options={modeOptions}
            value={modeValue}
            onChange={changeMode}
          />
        </div>

        <div className="lfoFaders">
          {knobParams.map((knobParam) => (
            <LfoFader
              key={knobParam.id}
              param={knobParam}
              value={valueForKnob(module.params, knobParam)}
              onChange={(value) => onParamChange(module.id, knobParam.id, value)}
            />
          ))}
        </div>
      </div>
    </ModuleShell>
  );
}

function LfoFader({
  param,
  value,
  onChange,
}: {
  param: ParamDefinition;
  value: number;
  onChange: (value: number) => void;
}) {
  const normalized = normalizeParamValue(value, param);

  return (
    <label
      className="lfoFader"
      style={{ "--lfo-fader-fill": `${normalized * 100}%` } as CSSProperties}
    >
      <span className="lfoFaderLabel">{param.label}</span>
      <span className="lfoFaderTrack" aria-hidden="true">
        <span className="lfoFaderFill" />
        <span className="lfoFaderCap" />
      </span>
      <span className="lfoFaderValue">{formatValue(value, param)}</span>
      <input
        className="lfoFaderInput"
        type="range"
        min={0}
        max={1}
        step={0.001}
        value={normalized}
        aria-label={param.label}
        onChange={(event) => {
          const nextValue = valueFromNormalized(Number(event.target.value), param);
          onChange(snapValue(nextValue, param));
        }}
      />
    </label>
  );
}

function WavePreview({
  shape,
  phase,
  value,
}: {
  shape: number;
  phase: number;
  value: number;
}) {
  const points = Array.from({ length: 64 }, (_, index) => {
    const phase = index / 63;
    const y = waveValue(shape, phase);
    const xPosition = phase * 120;
    const yPosition = 28 - y * 21;
    return `${xPosition.toFixed(2)},${yPosition.toFixed(2)}`;
  }).join(" ");

  return (
    <svg
      className="lfoWave"
      viewBox="0 0 120 56"
      role="img"
      aria-label="LFO shape"
    >
      <line x1="0" x2="120" y1="28" y2="28" />
      <polyline points={points} />
      <circle className="lfoWaveDot" cx={phase * 120} cy={28 - value * 21} r="3.2" />
    </svg>
  );
}

function HighRatePreview({
  shape,
  phase,
  value,
  rate,
  rateParam,
}: {
  shape: number;
  phase: number;
  value: number;
  rate: number;
  rateParam: ParamDefinition;
}) {
  const rateAmount = normalizeParamValue(rate, rateParam);
  const ringRadius = 11 + rateAmount * 14;
  const innerRadius = 3 + Math.abs(value) * 7;
  const spokes = 8 + Math.round(rateAmount * 12);
  const bars = Array.from({ length: spokes }, (_, index) => {
    const angle = (index / spokes) * Math.PI * 2 + phase * Math.PI * 2;
    const shapePulse = 0.65 + Math.abs(waveValue(shape, (phase + index / spokes) % 1)) * 0.35;
    const outer = ringRadius + shapePulse * 9;
    const x1 = 60 + Math.cos(angle) * innerRadius;
    const y1 = 28 + Math.sin(angle) * innerRadius;
    const x2 = 60 + Math.cos(angle) * outer;
    const y2 = 28 + Math.sin(angle) * outer;
    return (
      <line
        key={index}
        x1={x1.toFixed(2)}
        y1={y1.toFixed(2)}
        x2={x2.toFixed(2)}
        y2={y2.toFixed(2)}
      />
    );
  });

  return (
    <svg
      className="lfoWave lfoHighPreview"
      viewBox="0 0 120 56"
      role="img"
      aria-label="audio-rate modulation"
    >
      <circle className="lfoHighPreviewRing" cx="60" cy="28" r={ringRadius.toFixed(2)} />
      <g>{bars}</g>
      <circle className="lfoWaveDot" cx={60 + value * 25} cy="28" r="3.2" />
    </svg>
  );
}

function waveValue(shape: number, phase: number) {
  switch (shape) {
    case 1:
      return 1 - Math.abs(phase - 0.5) * 4;
    case 2:
      return phase * 2 - 1;
    case 3:
      return phase < 0.5 ? 1 : -1;
    case 4: {
      const bucket = Math.floor(phase * 8);
      return pseudoRandom(bucket);
    }
    default:
      return Math.sin(Math.PI * 2 * phase);
  }
}

function pseudoRandom(index: number) {
  const x = Math.sin(index * 91.417 + 13.31) * 43758.5453;
  return (x - Math.floor(x)) * 2 - 1;
}

function SegmentControl({
  className = "",
  label,
  options,
  value,
  onChange,
}: {
  className?: string;
  label: string;
  options: Array<[string, number]>;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className={["lfoSegment", className].filter(Boolean).join(" ")}>
      <span>{label}</span>
      <div>
        {options.map(([name, optionValue]) => (
          <button
            key={name}
            type="button"
            className={value === optionValue ? "isActive" : ""}
            onClick={() => onChange(optionValue)}
          >
            {name}
          </button>
        ))}
      </div>
    </div>
  );
}

function rateParamForMode(
  baseParam: ParamDefinition,
  modeValue: number,
): ParamDefinition {
  if (modeValue === 1) {
    return {
      ...baseParam,
      min: HIGH_RATE_MIN,
      max: HIGH_RATE_MAX,
      step: 1,
      defaultValue: HIGH_RATE_DEFAULT,
    };
  }

  return {
    ...baseParam,
    min: LOW_RATE_MIN,
    max: LOW_RATE_MAX,
    step: 0.01,
    defaultValue: LOW_RATE_DEFAULT,
  };
}

function param(paramId: number, definition: ModuleDefinition): ParamDefinition {
  const found = definition.params.find((candidate) => candidate.id === paramId);
  if (!found) {
    throw new Error(`Missing LFO param ${paramId}`);
  }
  return found;
}

function valueFor(params: Record<number, number>, parameter: ParamDefinition) {
  return params[parameter.id] ?? parameter.defaultValue;
}

function valueForKnob(params: Record<number, number>, parameter: ParamDefinition) {
  const value = valueFor(params, parameter);
  return Math.max(parameter.min, Math.min(parameter.max, value));
}

function normalizeParamValue(value: number, parameter: ParamDefinition) {
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
    return parameter.min * Math.pow(parameter.max / parameter.min, clamped);
  }

  return parameter.min + clamped * (parameter.max - parameter.min);
}

function snapValue(value: number, parameter: ParamDefinition) {
  const step = parameter.step > 0 ? parameter.step : 0.01;
  const snapped = Math.round((value - parameter.min) / step) * step + parameter.min;
  const clamped = Math.max(parameter.min, Math.min(parameter.max, snapped));
  const decimals = decimalPlaces(step);
  return Number(clamped.toFixed(Math.min(8, decimals + 2)));
}

function formatValue(value: number, parameter: ParamDefinition) {
  if (!Number.isFinite(value)) {
    return `0${parameter.unit ?? ""}`;
  }
  const decimals = parameter.step < 0.01 ? 2 : parameter.step < 1 ? 1 : 0;
  return `${value.toFixed(decimals)}${parameter.unit ?? ""}`;
}

function decimalPlaces(value: number) {
  const text = value.toString();
  if (!text.includes(".")) {
    return 0;
  }
  return text.split(".")[1]?.length ?? 0;
}

function meterNumber(
  levels: Float32Array | undefined,
  index: number,
  fallback: number,
) {
  const value = levels?.[index];
  return Number.isFinite(value) ? Number(value) : fallback;
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number) {
  return Math.max(-1, Math.min(1, value));
}
