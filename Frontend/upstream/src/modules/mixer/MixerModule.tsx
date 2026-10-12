import type { CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./MixerModule.css";

const CHANNELS = 14;
const LEGACY_CHANNELS = 8;
const EXTRA_CHANNELS = CHANNELS - LEGACY_CHANNELS;
const LEGACY_RIGHT_INPUT_OFFSET = LEGACY_CHANNELS;
const EXTRA_LEFT_INPUT_OFFSET = LEGACY_CHANNELS * 3;
const EXTRA_RIGHT_INPUT_OFFSET = EXTRA_LEFT_INPUT_OFFSET + EXTRA_CHANNELS;
const PARAM_LEVEL_BASE = 0;
const PARAM_PAN_BASE = 32;
const EXTRA_PARAM_BASE = 56;
const PARAM_MUTE_BASE = 86;
const PARAM_SOLO_BASE = PARAM_MUTE_BASE + CHANNELS;
const METER_LED_THRESHOLDS = [0.05, 0.11, 0.2, 0.34, 0.5, 0.68, 0.86];

const levelParams = Array.from({ length: CHANNELS }, (_, index) =>
  param(
    paramIdFor(PARAM_LEVEL_BASE, 0, index),
    `level${index + 1}`,
    `${index + 1}`,
    0.75,
  ),
) satisfies ParamDefinition[];
const panParams = Array.from({ length: CHANNELS }, (_, index) =>
  param(paramIdFor(PARAM_PAN_BASE, 4, index), `pan${index + 1}`, "pan", 0.5),
) satisfies ParamDefinition[];
const muteParams = Array.from({ length: CHANNELS }, (_, index) =>
  toggleParam(PARAM_MUTE_BASE + index, `mute${index + 1}`, "m"),
) satisfies ParamDefinition[];
const soloParams = Array.from({ length: CHANNELS }, (_, index) =>
  toggleParam(PARAM_SOLO_BASE + index, `solo${index + 1}`, "s"),
) satisfies ParamDefinition[];

const mixerParams = [
  ...levelParams,
  ...panParams,
  ...muteParams,
  ...soloParams,
] satisfies ParamDefinition[];

export const mixerDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.mixer,
  slug: "m14",
  name: "M14",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 356,
  minHeight: 206,
  connectionViewChrome: "minimal",
  inputs: [
    ...Array.from({ length: CHANNELS }, (_, index) => ({
      id: leftInputId(index),
      label: `${index + 1} left`,
      kind: "audio" as const,
      connectionOrder: 0,
      connectionGroup: `track-${index + 1}-in`,
      connectionGroupLabel: `${index + 1}`,
      connectionGroupOrder: index,
      connectionLabel: "L",
    })),
    ...Array.from({ length: CHANNELS }, (_, index) => ({
      id: rightInputId(index),
      label: `${index + 1} right`,
      kind: "audio" as const,
      connectionOrder: 1,
      connectionGroup: `track-${index + 1}-in`,
      connectionGroupLabel: `${index + 1}`,
      connectionGroupOrder: index,
      connectionLabel: "R",
    })),
  ],
  outputs: [
    {
      id: 0,
      label: "main left",
      kind: "audio",
      connectionOrder: 0,
      connectionGroup: "main-out",
      connectionGroupLabel: "main",
      connectionGroupOrder: 0,
      connectionLabel: "L",
    },
    {
      id: 1,
      label: "main right",
      kind: "audio",
      connectionOrder: 1,
      connectionGroup: "main-out",
      connectionGroupLabel: "main",
      connectionGroupOrder: 0,
      connectionLabel: "R",
    },
  ],
  params: mixerParams,
  Component: MixerModule,
};

function MixerModule(props: ModuleRenderProps) {
  const { module, onParamChange } = props;
  const meterLevels = props.mixerMeterData?.levels;

  return (
    <ModuleShell {...props}>
      <div className="mixerPanel">
        <div className="mixerChannels">
          {levelParams.map((levelParam, index) => {
            const value = valueFor(module.params, levelParam);
            const panParam = panParams[index];
            const muteParam = muteParams[index];
            const soloParam = soloParams[index];
            const leftMeter = meterValue(meterLevels, index * 2);
            const rightMeter = meterValue(meterLevels, index * 2 + 1);
            const meterLevel = Math.max(leftMeter, rightMeter);
            return (
              <div
                className="mixerStrip"
                key={levelParam.id}
                style={
                  {
                    "--fader-fill": `${value * 100}%`,
                    "--meter-left": `${leftMeter * 100}%`,
                    "--meter-right": `${rightMeter * 100}%`,
                  } as CSSProperties
                }
              >
                <div className="mixerControlStack">
                  <div className="mixerPanBox">
                    <TinyKnob
                      moduleId={module.id}
                      param={panParam}
                      value={valueFor(module.params, panParam)}
                      onParamChange={onParamChange}
                    />
                    <div className="mixerToggleRow">
                      <MixerToggle
                        moduleId={module.id}
                        param={muteParam}
                        value={valueFor(module.params, muteParam)}
                        onParamChange={onParamChange}
                      />
                      <MixerToggle
                        moduleId={module.id}
                        param={soloParam}
                        value={valueFor(module.params, soloParam)}
                        onParamChange={onParamChange}
                      />
                    </div>
                  </div>
                </div>
                <label className="mixerFaderControl">
                  <span className="mixerFaderVisual" aria-hidden="true">
                    <MixerMeterLeds level={meterLevel} />
                    <span className="mixerFaderSlot" />
                    <span className="mixerFaderFill" />
                    <span className="mixerFaderThumb" />
                  </span>
                  <input
                    className="mixerFaderInput"
                    type="range"
                    min={levelParam.min}
                    max={levelParam.max}
                    step={levelParam.step}
                    value={value}
                    aria-label={`input ${levelParam.label} level`}
                    onChange={(event) =>
                      onParamChange(module.id, levelParam.id, Number(event.target.value))
                    }
                  />
                  <span className="mixerTrackNumber" aria-hidden="true">
                    {index + 1}
                  </span>
                </label>
              </div>
            );
          })}
        </div>
      </div>
    </ModuleShell>
  );
}

function MixerMeterLeds({ level }: { level: number }) {
  return (
    <span className="mixerFaderMeter">
      {METER_LED_THRESHOLDS.map((threshold) => (
        <span
          key={threshold}
          className={level >= threshold ? "isActive" : ""}
        />
      ))}
    </span>
  );
}

function paramIdFor(legacyBase: number, kindIndex: number, channel: number) {
  if (channel < LEGACY_CHANNELS) {
    return legacyBase + channel;
  }
  return (
    EXTRA_PARAM_BASE +
    kindIndex * EXTRA_CHANNELS +
    (channel - LEGACY_CHANNELS)
  );
}

function leftInputId(channel: number) {
  return channel < LEGACY_CHANNELS
    ? channel
    : EXTRA_LEFT_INPUT_OFFSET + (channel - LEGACY_CHANNELS);
}

function rightInputId(channel: number) {
  return channel < LEGACY_CHANNELS
    ? LEGACY_RIGHT_INPUT_OFFSET + channel
    : EXTRA_RIGHT_INPUT_OFFSET + (channel - LEGACY_CHANNELS);
}

function valueFor(params: Record<number, number>, parameter: ParamDefinition) {
  return params[parameter.id] ?? parameter.defaultValue;
}

function meterValue(levels: Float32Array | undefined, index: number) {
  return Math.min(1, Math.max(0, levels?.[index] ?? 0));
}

function MixerToggle({
  moduleId,
  param,
  value,
  onParamChange,
}: {
  moduleId: number;
  param: ParamDefinition;
  value: number;
  onParamChange: ModuleRenderProps["onParamChange"];
}) {
  const active = value >= 0.5;
  return (
    <button
      aria-label={param.key}
      aria-pressed={active}
      className={`mixerTrackToggle${active ? " isActive" : ""}`}
      type="button"
      onClick={() => onParamChange(moduleId, param.id, active ? 0 : 1)}
    >
      {param.label}
    </button>
  );
}

function TinyKnob({
  moduleId,
  param,
  value,
  onParamChange,
}: {
  moduleId: number;
  param: ParamDefinition;
  value: number;
  onParamChange: ModuleRenderProps["onParamChange"];
}) {
  const normalized = normalizeValue(value, param);
  return (
    <label
      className="mixerTinyKnob"
      style={
        {
          "--knob-deg": `${-135 + normalized * 270}deg`,
          "--knob-sweep": `${normalized * 100}%`,
        } as CSSProperties
      }
    >
      <span className="mixerTinyKnobFace" aria-hidden="true">
        <span />
      </span>
      <span className="mixerTinyKnobLabel">{param.label}</span>
      <input
        className="mixerTinyKnobInput"
        type="range"
        min={param.min}
        max={param.max}
        step={param.step}
        value={value}
        aria-label={param.key}
        onChange={(event) => onParamChange(moduleId, param.id, Number(event.target.value))}
      />
    </label>
  );
}

function normalizeValue(value: number, parameter: ParamDefinition) {
  if (!Number.isFinite(value) || parameter.max <= parameter.min) {
    return 0;
  }
  return Math.min(
    1,
    Math.max(0, (value - parameter.min) / (parameter.max - parameter.min)),
  );
}

function param(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
): ParamDefinition {
  return { id, key, label, min: 0, max: 1, step: 0.01, defaultValue };
}

function toggleParam(id: number, key: string, label: string): ParamDefinition {
  return { id, key, label, min: 0, max: 1, step: 1, defaultValue: 0 };
}
