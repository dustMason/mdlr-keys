import { useEffect, useState } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./EuclidModule.css";

const CHANNELS = 8;
const PATTERNS = 8;
const CV_INPUTS = 8;
const PREVIEW_STEPS = 32;

const PATTERN_SETTINGS = 8;
const PATTERN_PARAM_BASE = 0;
const PATTERN_PARAM_COUNT = CHANNELS * PATTERNS * PATTERN_SETTINGS;
const PAT_DIVIDE = 0;
const PAT_LENGTH = 1;
const PAT_EVENTS = 2;
const PAT_ROTATE = 3;
const PAT_BURST = 4;
const PAT_RATCHET = 5;
const PAT_CHANCE = 6;
const PAT_MUTE = 7;

const CHANNEL_SETTINGS = 7;
const CHANNEL_PARAM_BASE = PATTERN_PARAM_BASE + PATTERN_PARAM_COUNT;
const CH_LOGIC = 0;
const CH_WIDTH = 1;
const CH_FLOP = 2;
const CH_MUTE = 3;
const CH_CLOCK_DIV = 4;
const CH_CLOCK_MULT = 5;
const CH_DELAY = 6;

const CV_SETTINGS = 5;
const CV_PARAM_BASE = CHANNEL_PARAM_BASE + CHANNELS * CHANNEL_SETTINGS;
const CV_TARGET = 0;
const CV_CHANNEL = 1;
const CV_PATTERN = 2;
const CV_AMOUNT = 3;
const CV_RANDOM = 4;

const PARAM_ACTIVE_CHANNEL = CV_PARAM_BASE + CV_INPUTS * CV_SETTINGS;
const PARAM_ACTIVE_PATTERN = PARAM_ACTIVE_CHANNEL + 1;
const PARAM_ACTIVE_CV = PARAM_ACTIVE_CHANNEL + 2;
const PARAM_RATE = PARAM_ACTIVE_CHANNEL + 3;
const PARAM_MAIN_DIVIDE = PARAM_ACTIVE_CHANNEL + 4;
const PARAM_MAIN_MULT = PARAM_ACTIVE_CHANNEL + 5;
const PARAM_SWING = PARAM_ACTIVE_CHANNEL + 6;
const PARAM_VIEW = PARAM_ACTIVE_CHANNEL + 7;

const channelIndexes = Array.from({ length: CHANNELS }, (_, index) => index);
const patternIndexes = Array.from({ length: PATTERNS }, (_, index) => index);
const cvIndexes = Array.from({ length: CV_INPUTS }, (_, index) => index);
const previewIndexes = Array.from({ length: PREVIEW_STEPS }, (_, index) => index);
const channelLabels = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII"] as const;
const logicLabels = ["and", "or", "xor"] as const;
const cvTargetLabels = ["off", "divide", "length", "events", "rotate", "burst", "ratchet", "chance", "width", "mute"] as const;
const viewLabels = ["edit", "logic", "input"] as const;

const euclidParams = [
  ...channelIndexes.flatMap((channel) =>
    patternIndexes.flatMap((pattern) => patternParams(channel, pattern)),
  ),
  ...channelIndexes.flatMap((channel) => channelParams(channel)),
  ...cvIndexes.flatMap((input) => cvParams(input)),
  param(PARAM_ACTIVE_CHANNEL, "active_channel", "channel", 0, 0, CHANNELS - 1, 1),
  param(PARAM_ACTIVE_PATTERN, "active_pattern", "pattern", 0, 0, PATTERNS - 1, 1),
  param(PARAM_ACTIVE_CV, "active_cv", "cv", 0, 0, CV_INPUTS - 1, 1),
  param(PARAM_RATE, "rate", "rate", 1, 0, 4, 0.01),
  param(PARAM_MAIN_DIVIDE, "main_divide", "main div", 1, 1, 64, 1),
  param(PARAM_MAIN_MULT, "main_mult", "main mult", 1, 1, 16, 1),
  param(PARAM_SWING, "swing", "swing", 0, 0, 0.4, 0.01),
  param(PARAM_VIEW, "view", "view", 0, 0, viewLabels.length - 1, 1),
] satisfies ParamDefinition[];

export const euclidDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.euclid,
  slug: "euclid",
  name: "EUCLID",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 3,
  width: 980,
  minHeight: 522,
  inputs: [
    { id: 0, label: "rate", kind: "cv", connectionOrder: 0 },
    { id: 1, label: "clock", kind: "gate", connectionOrder: 1 },
    { id: 2, label: "reset", kind: "gate", connectionOrder: 2 },
    ...cvIndexes.map((input) => ({
      id: 3 + input,
      label: `cv ${input + 1}`,
      kind: "cv" as const,
      connectionGroup: "cv",
      connectionGroupLabel: "CV",
      connectionGroupOrder: 1,
      connectionOrder: 3 + input,
    })),
  ],
  outputs: [
    ...channelIndexes.map((channel) => ({
      id: channel,
      label: `${channel + 1}`,
      kind: "gate" as const,
      connectionGroup: "channels",
      connectionGroupLabel: "CH",
      connectionGroupOrder: 0,
      connectionOrder: channel,
    })),
    { id: 8, label: "clk", kind: "gate", connectionGroup: "utility", connectionGroupLabel: "UTIL", connectionGroupOrder: 1, connectionOrder: 8 },
    { id: 9, label: "rst", kind: "gate", connectionGroup: "utility", connectionGroupLabel: "UTIL", connectionGroupOrder: 1, connectionOrder: 9 },
  ],
  params: euclidParams,
  Component: EuclidModule,
};

function EuclidModule(props: ModuleRenderProps) {
  const { module, onParamChange, onModuleParamsChange } = props;
  const activeChannel = intValue(module, PARAM_ACTIVE_CHANNEL, 0, CHANNELS - 1);
  const activePattern = intValue(module, PARAM_ACTIVE_PATTERN, 0, PATTERNS - 1);
  const activeCv = intValue(module, PARAM_ACTIVE_CV, 0, CV_INPUTS - 1);
  const selectedPatternId = (offset: number) => patternParam(activeChannel, activePattern, offset);
  const selectedChannelId = (offset: number) => channelParam(activeChannel, offset);
  const length = intValue(module, selectedPatternId(PAT_LENGTH), 1, 999);
  const events = intValue(module, selectedPatternId(PAT_EVENTS), 0, length);
  const rotate = intValue(module, selectedPatternId(PAT_ROTATE), 0, Math.max(0, length - 1));
  const muted = boolValue(module, selectedPatternId(PAT_MUTE));

  function setParam(paramId: number, next: number) {
    onParamChange(module.id, paramId, next);
  }

  function setParams(values: Record<number, number>) {
    onModuleParamsChange(module.id, values);
  }

  function selectPattern(channel: number, pattern: number) {
    setParams({
      [PARAM_ACTIVE_CHANNEL]: channel,
      [PARAM_ACTIVE_PATTERN]: pattern,
    });
  }

  function randomizePattern() {
    const nextLength = randomChoice([8, 9, 11, 12, 13, 15, 16, 24, 32]);
    const nextEvents = randomInt(1, Math.max(1, Math.min(nextLength, 12)));
    setParams({
      [selectedPatternId(PAT_DIVIDE)]: randomChoice([1, 1, 1, 2, 3, 4, 5, 7]),
      [selectedPatternId(PAT_LENGTH)]: nextLength,
      [selectedPatternId(PAT_EVENTS)]: nextEvents,
      [selectedPatternId(PAT_ROTATE)]: randomInt(0, nextLength - 1),
      [selectedPatternId(PAT_BURST)]: randomInt(1, Math.max(1, Math.min(8, Math.floor(nextLength / nextEvents)))),
      [selectedPatternId(PAT_RATCHET)]: randomChoice([1, 1, 1, 2, 3, 4, 5, 7]),
      [selectedPatternId(PAT_CHANCE)]: randomFloat(0.42, 1),
      [selectedPatternId(PAT_MUTE)]: 0,
    });
  }

  function resetPattern() {
    const values: Record<number, number> = {};
    for (const nextParam of patternParams(activeChannel, activePattern)) {
      values[nextParam.id] = nextParam.defaultValue;
    }
    setParams(values);
  }

  function randomizeChannel() {
    const values: Record<number, number> = {
      [selectedChannelId(CH_LOGIC)]: randomInt(0, logicLabels.length - 1),
      [selectedChannelId(CH_WIDTH)]: randomFloat(0.05, 0.55),
      [selectedChannelId(CH_FLOP)]: Math.random() < 0.18 ? 1 : 0,
      [selectedChannelId(CH_MUTE)]: 0,
      [selectedChannelId(CH_CLOCK_DIV)]: randomChoice([1, 1, 2, 3, 4, 5, 7]),
      [selectedChannelId(CH_CLOCK_MULT)]: randomChoice([1, 1, 2, 3, 4]),
      [selectedChannelId(CH_DELAY)]: randomChoice([0, 0, 0.02, 0.05, 0.08, 0.12]),
    };
    for (const pattern of patternIndexes) {
      const nextLength = randomChoice([8, 12, 16, 16, 24, 32]);
      const nextEvents = randomInt(1, Math.max(1, Math.min(nextLength, 10)));
      values[patternParam(activeChannel, pattern, PAT_LENGTH)] = nextLength;
      values[patternParam(activeChannel, pattern, PAT_EVENTS)] = nextEvents;
      values[patternParam(activeChannel, pattern, PAT_ROTATE)] = randomInt(0, nextLength - 1);
      values[patternParam(activeChannel, pattern, PAT_BURST)] = randomChoice([1, 1, 1, 2, 3, 4]);
      values[patternParam(activeChannel, pattern, PAT_RATCHET)] = randomChoice([1, 1, 2, 3, 5]);
      values[patternParam(activeChannel, pattern, PAT_CHANCE)] = pattern < 2 ? randomFloat(0.55, 1) : randomFloat(0.18, 0.72);
      values[patternParam(activeChannel, pattern, PAT_MUTE)] = pattern < randomInt(2, 5) ? 0 : 1;
    }
    setParams(values);
  }

  const selectedCvTarget = intValue(module, cvParam(activeCv, CV_TARGET), 0, cvTargetLabels.length - 1);

  return (
    <ModuleShell {...props}>
      <div className="euclidPanel">
        <div className="euclidTop">
          <ButtonGroup
            label="channel"
            options={channelLabels}
            value={activeChannel}
            onChange={(next) => setParam(PARAM_ACTIVE_CHANNEL, next)}
          />
          <ButtonGroup
            label="pattern"
            options={patternIndexes.map((index) => `P${index + 1}`)}
            value={activePattern}
            onChange={(next) => setParam(PARAM_ACTIVE_PATTERN, next)}
          />
          <ButtonGroup
            label="view"
            options={viewLabels}
            value={intValue(module, PARAM_VIEW, 0, viewLabels.length - 1)}
            onChange={(next) => setParam(PARAM_VIEW, next)}
          />
          <Field
            label="rate"
            value={value(module, PARAM_RATE)}
            min={0}
            max={4}
            step={0.01}
            display={(next) => (next <= 0.001 ? "ext" : `${next.toFixed(2)}x`)}
            onChange={(next) => setParam(PARAM_RATE, next)}
          />
          <button type="button" className="euclidAction" onClick={randomizePattern}>
            random
          </button>
          <button type="button" className="euclidAction" onClick={resetPattern}>
            init
          </button>
        </div>

        <div className="euclidMain">
          <section className="euclidBlock euclidMatrixBlock">
            <BlockHeader title="constellation" value={`CH ${activeChannel + 1} / P${activePattern + 1}`} />
            <div className="euclidMatrix">
              <div className="euclidMatrixHeader">
                <span />
                {patternIndexes.map((pattern) => (
                  <span key={pattern}>P{pattern + 1}</span>
                ))}
              </div>
              {channelIndexes.map((channel) => (
                <div key={channel} className="euclidMatrixRow">
                  <button
                    type="button"
                    className={channel === activeChannel ? "isSelected" : ""}
                    onClick={() => setParam(PARAM_ACTIVE_CHANNEL, channel)}
                  >
                    {channel + 1}
                  </button>
                  {patternIndexes.map((pattern) => {
                    const isMuted = boolValue(module, patternParam(channel, pattern, PAT_MUTE));
                    const selected = channel === activeChannel && pattern === activePattern;
                    const density = patternDensity(module, channel, pattern);
                    return (
                      <button
                        key={pattern}
                        type="button"
                        className={[
                          "euclidCell",
                          !isMuted ? "isActive" : "",
                          selected ? "isSelected" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        aria-pressed={!isMuted}
                        onClick={() => selectPattern(channel, pattern)}
                      >
                        <span style={{ height: `${Math.max(8, density * 100)}%` }} />
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="euclidOutputs">
              {channelIndexes.map((channel) => (
                <button
                  key={channel}
                  type="button"
                  className={[
                    channel === activeChannel ? "isSelected" : "",
                    boolValue(module, channelParam(channel, CH_MUTE)) ? "isMuted" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => setParam(PARAM_ACTIVE_CHANNEL, channel)}
                >
                  <span>CH {channel + 1}</span>
                  <strong>{logicLabels[intValue(module, channelParam(channel, CH_LOGIC), 0, logicLabels.length - 1)]}</strong>
                </button>
              ))}
            </div>
          </section>

          <section className="euclidBlock">
            <BlockHeader title="channel" value={channelLabels[activeChannel]} />
            <div className="euclidControls">
              <SelectField label="logic" value={intValue(module, selectedChannelId(CH_LOGIC), 0, logicLabels.length - 1)} options={logicLabels} onChange={(next) => setParam(selectedChannelId(CH_LOGIC), next)} />
              <Field label="width" value={value(module, selectedChannelId(CH_WIDTH))} min={0.01} max={1} step={0.01} display={formatPercent} onChange={(next) => setParam(selectedChannelId(CH_WIDTH), next)} />
              <ToggleField label="flop" value={boolValue(module, selectedChannelId(CH_FLOP))} onChange={(next) => setParam(selectedChannelId(CH_FLOP), next ? 1 : 0)} />
              <ToggleField label="mute" value={boolValue(module, selectedChannelId(CH_MUTE))} onChange={(next) => setParam(selectedChannelId(CH_MUTE), next ? 1 : 0)} />
              <Field label="clock /" value={value(module, selectedChannelId(CH_CLOCK_DIV))} min={1} max={64} step={1} onChange={(next) => setParam(selectedChannelId(CH_CLOCK_DIV), next)} />
              <Field label="clock x" value={value(module, selectedChannelId(CH_CLOCK_MULT))} min={1} max={16} step={1} onChange={(next) => setParam(selectedChannelId(CH_CLOCK_MULT), next)} />
              <Field label="delay" value={value(module, selectedChannelId(CH_DELAY))} min={0} max={0.95} step={0.01} display={formatPercent} onChange={(next) => setParam(selectedChannelId(CH_DELAY), next)} />
              <button type="button" className="euclidAction euclidWideAction" onClick={randomizeChannel}>
                random ch
              </button>
            </div>
            <div className="euclidClockControls">
              <Field label="main /" value={value(module, PARAM_MAIN_DIVIDE)} min={1} max={64} step={1} onChange={(next) => setParam(PARAM_MAIN_DIVIDE, next)} />
              <Field label="main x" value={value(module, PARAM_MAIN_MULT)} min={1} max={16} step={1} onChange={(next) => setParam(PARAM_MAIN_MULT, next)} />
              <Field label="swing" value={value(module, PARAM_SWING)} min={0} max={0.4} step={0.01} display={(next) => `${Math.round(50 + next * 100)}%`} onChange={(next) => setParam(PARAM_SWING, next)} />
            </div>
          </section>

          <section className="euclidBlock euclidPatternBlock">
            <BlockHeader title="pattern" value={`P${activePattern + 1} ${muted ? "muted" : "live"}`} />
            <div className="euclidPreview" aria-hidden="true">
              {previewIndexes.map((step) => {
                const active = step < Math.min(length, PREVIEW_STEPS) && euclideanActive(step, length, events, rotate);
                return <span key={step} className={active ? "isActive" : ""} />;
              })}
            </div>
            <div className="euclidControls euclidPatternControls">
              <Field label="divide" value={value(module, selectedPatternId(PAT_DIVIDE))} min={1} max={255} step={1} onChange={(next) => setParam(selectedPatternId(PAT_DIVIDE), next)} />
              <Field label="length" value={value(module, selectedPatternId(PAT_LENGTH))} min={1} max={999} step={1} editableValue onChange={(next) => setParam(selectedPatternId(PAT_LENGTH), next)} />
              <Field label="events" value={value(module, selectedPatternId(PAT_EVENTS))} min={0} max={length} step={1} onChange={(next) => setParam(selectedPatternId(PAT_EVENTS), next)} />
              <Field label="rotate" value={value(module, selectedPatternId(PAT_ROTATE))} min={0} max={Math.max(0, length - 1)} step={1} onChange={(next) => setParam(selectedPatternId(PAT_ROTATE), next)} />
              <Field label="burst" value={value(module, selectedPatternId(PAT_BURST))} min={1} max={Math.max(1, Math.min(64, Math.floor(length / Math.max(1, events))))} step={1} onChange={(next) => setParam(selectedPatternId(PAT_BURST), next)} />
              <Field label="ratchet" value={value(module, selectedPatternId(PAT_RATCHET))} min={1} max={255} step={1} onChange={(next) => setParam(selectedPatternId(PAT_RATCHET), next)} />
              <Field label="chance" value={value(module, selectedPatternId(PAT_CHANCE))} min={0} max={1} step={0.01} display={formatPercent} onChange={(next) => setParam(selectedPatternId(PAT_CHANCE), next)} />
              <ToggleField label="mute" value={muted} onChange={(next) => setParam(selectedPatternId(PAT_MUTE), next ? 1 : 0)} />
            </div>
          </section>

          <section className="euclidBlock">
            <BlockHeader title="cv input" value={`I${activeCv + 1} ${cvTargetLabels[selectedCvTarget]}`} />
            <ButtonGroup
              label="cv"
              options={cvIndexes.map((index) => `${index + 1}`)}
              value={activeCv}
              onChange={(next) => setParam(PARAM_ACTIVE_CV, next)}
            />
            <div className="euclidControls">
              <SelectField label="target" value={selectedCvTarget} options={cvTargetLabels} onChange={(next) => setParam(cvParam(activeCv, CV_TARGET), next)} />
              <SelectField label="channel" value={intValue(module, cvParam(activeCv, CV_CHANNEL), 0, CHANNELS - 1)} options={channelLabels} onChange={(next) => setParam(cvParam(activeCv, CV_CHANNEL), next)} />
              <SelectField label="pattern" value={intValue(module, cvParam(activeCv, CV_PATTERN), 0, PATTERNS - 1)} options={patternIndexes.map((index) => `P${index + 1}`)} onChange={(next) => setParam(cvParam(activeCv, CV_PATTERN), next)} />
              <Field label="amount" value={value(module, cvParam(activeCv, CV_AMOUNT))} min={-1} max={1} step={0.01} display={(next) => next.toFixed(2)} onChange={(next) => setParam(cvParam(activeCv, CV_AMOUNT), next)} />
              <ToggleField label="random" value={boolValue(module, cvParam(activeCv, CV_RANDOM))} onChange={(next) => setParam(cvParam(activeCv, CV_RANDOM), next ? 1 : 0)} />
            </div>
            <div className="euclidCvMap">
              {cvIndexes.map((input) => {
                const target = intValue(module, cvParam(input, CV_TARGET), 0, cvTargetLabels.length - 1);
                return (
                  <button
                    key={input}
                    type="button"
                    className={input === activeCv ? "isSelected" : ""}
                    onClick={() => setParam(PARAM_ACTIVE_CV, input)}
                  >
                    <span>I{input + 1}</span>
                    <strong>{cvTargetLabels[target]}</strong>
                  </button>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </ModuleShell>
  );
}

function ButtonGroup({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly string[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="euclidButtonGroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option}
          type="button"
          className={value === index ? "isActive" : ""}
          aria-pressed={value === index}
          onClick={() => onChange(index)}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function BlockHeader({ title, value }: { title: string; value: string }) {
  return (
    <header className="euclidBlockHeader">
      <strong>{title}</strong>
      <span>{value}</span>
    </header>
  );
}

function Field({
  label,
  value,
  min,
  max,
  step,
  display,
  editableValue = false,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display?: (value: number) => string;
  editableValue?: boolean;
  onChange: (value: number) => void;
}) {
  const safeValue = clamp(value, min, max);
  const formattedValue = display ? display(safeValue) : `${Math.round(safeValue)}`;
  return (
    <label className="euclidField">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={safeValue}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {editableValue ? (
        <EditableValueInput
          label={label}
          value={safeValue}
          min={min}
          max={max}
          step={step}
          display={display}
          onChange={onChange}
        />
      ) : (
        <output>{formattedValue}</output>
      )}
    </label>
  );
}

function EditableValueInput({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const formattedValue = display ? display(value) : `${Math.round(value)}`;
  const [draft, setDraft] = useState(formattedValue);

  useEffect(() => {
    setDraft(formattedValue);
  }, [formattedValue]);

  function commit(nextDraft = draft) {
    const parsed = Number(nextDraft);
    if (!Number.isFinite(parsed)) {
      setDraft(formattedValue);
      return;
    }
    const nextValue = quantize(clamp(parsed, min, max), step);
    onChange(nextValue);
    setDraft(display ? display(nextValue) : `${Math.round(nextValue)}`);
  }

  return (
    <input
      className="euclidValueInput"
      type="text"
      inputMode="numeric"
      aria-label={`${label} value`}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => commit()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setDraft(formattedValue);
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: number;
  options: readonly string[];
  onChange: (value: number) => void;
}) {
  return (
    <label className="euclidField euclidSelect">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {options.map((option, index) => (
          <option key={option} value={index}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function ToggleField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={value ? "euclidToggle isActive" : "euclidToggle"}
      aria-pressed={value}
      onClick={() => onChange(!value)}
    >
      <span>{label}</span>
      <strong>{value ? "on" : "off"}</strong>
    </button>
  );
}

function patternParams(channel: number, pattern: number) {
  const defaults = defaultPattern(channel, pattern);
  return [
    param(patternParam(channel, pattern, PAT_DIVIDE), `ch${channel + 1}_p${pattern + 1}_divide`, "divide", defaults.divide, 1, 255, 1),
    param(patternParam(channel, pattern, PAT_LENGTH), `ch${channel + 1}_p${pattern + 1}_length`, "length", defaults.length, 1, 999, 1),
    param(patternParam(channel, pattern, PAT_EVENTS), `ch${channel + 1}_p${pattern + 1}_events`, "events", defaults.events, 0, defaults.length, 1),
    param(patternParam(channel, pattern, PAT_ROTATE), `ch${channel + 1}_p${pattern + 1}_rotate`, "rotate", defaults.rotate, 0, Math.max(0, defaults.length - 1), 1),
    param(patternParam(channel, pattern, PAT_BURST), `ch${channel + 1}_p${pattern + 1}_burst`, "burst", defaults.burst, 1, 64, 1),
    param(patternParam(channel, pattern, PAT_RATCHET), `ch${channel + 1}_p${pattern + 1}_ratchet`, "ratchet", defaults.ratchet, 1, 255, 1),
    param(patternParam(channel, pattern, PAT_CHANCE), `ch${channel + 1}_p${pattern + 1}_chance`, "chance", defaults.chance, 0, 1, 0.01),
    param(patternParam(channel, pattern, PAT_MUTE), `ch${channel + 1}_p${pattern + 1}_mute`, "mute", defaults.mute ? 1 : 0, 0, 1, 1),
  ];
}

function channelParams(channel: number) {
  const widthDefaults = [0.12, 0.16, 0.08, 0.18, 0.12, 0.1, 0.1, 0.22];
  return [
    param(channelParam(channel, CH_LOGIC), `ch${channel + 1}_logic`, "logic", 1, 0, logicLabels.length - 1, 1),
    param(channelParam(channel, CH_WIDTH), `ch${channel + 1}_width`, "width", widthDefaults[channel], 0.01, 1, 0.01),
    param(channelParam(channel, CH_FLOP), `ch${channel + 1}_flop`, "flop", 0, 0, 1, 1),
    param(channelParam(channel, CH_MUTE), `ch${channel + 1}_mute`, "mute", 0, 0, 1, 1),
    param(channelParam(channel, CH_CLOCK_DIV), `ch${channel + 1}_clock_div`, "clock /", 1, 1, 64, 1),
    param(channelParam(channel, CH_CLOCK_MULT), `ch${channel + 1}_clock_mult`, "clock x", 1, 1, 16, 1),
    param(channelParam(channel, CH_DELAY), `ch${channel + 1}_delay`, "delay", 0, 0, 0.95, 0.01),
  ];
}

function cvParams(input: number) {
  const defaults = [
    { target: 7, channel: 0, pattern: 1, amount: 0.55, random: 0 },
    { target: 4, channel: 2, pattern: 0, amount: 0.4, random: 0 },
  ][input] ?? { target: 0, channel: 0, pattern: 0, amount: 0, random: 0 };
  return [
    param(cvParam(input, CV_TARGET), `cv${input + 1}_target`, "target", defaults.target, 0, cvTargetLabels.length - 1, 1),
    param(cvParam(input, CV_CHANNEL), `cv${input + 1}_channel`, "channel", defaults.channel, 0, CHANNELS - 1, 1),
    param(cvParam(input, CV_PATTERN), `cv${input + 1}_pattern`, "pattern", defaults.pattern, 0, PATTERNS - 1, 1),
    param(cvParam(input, CV_AMOUNT), `cv${input + 1}_amount`, "amount", defaults.amount, -1, 1, 0.01),
    param(cvParam(input, CV_RANDOM), `cv${input + 1}_random`, "random", defaults.random, 0, 1, 1),
  ];
}

function defaultPattern(channel: number, pattern: number) {
  if (pattern === 0) {
    return {
      divide: 1,
      length: 16,
      events: [4, 2, 8, 2, 3, 5, 7, 1][channel],
      rotate: [0, 4, 0, 6, 2, 1, 3, 8][channel],
      burst: 1,
      ratchet: 1,
      chance: 1,
      mute: false,
    };
  }
  if (pattern === 1) {
    const length = [12, 16, 9, 11, 14, 15, 13, 10][channel];
    return {
      divide: 1,
      length,
      events: [2, 3, 2, 4, 5, 2, 4, 3][channel],
      rotate: (channel * 2 + 1) % length,
      burst: channel % 3 === 0 ? 2 : 1,
      ratchet: channel % 4 === 2 ? 2 : 1,
      chance: 0.28 + channel * 0.05,
      mute: channel > 4,
    };
  }
  return {
    divide: 1,
    length: 16,
    events: 4,
    rotate: 0,
    burst: 1,
    ratchet: 1,
    chance: 1,
    mute: true,
  };
}

function patternParam(channel: number, pattern: number, offset: number) {
  return PATTERN_PARAM_BASE + channel * PATTERNS * PATTERN_SETTINGS + pattern * PATTERN_SETTINGS + offset;
}

function channelParam(channel: number, offset: number) {
  return CHANNEL_PARAM_BASE + channel * CHANNEL_SETTINGS + offset;
}

function cvParam(input: number, offset: number) {
  return CV_PARAM_BASE + input * CV_SETTINGS + offset;
}

function param(
  id: number,
  key: string,
  label: string,
  defaultValue: number,
  min: number,
  max: number,
  step: number,
): ParamDefinition {
  return { id, key, label, defaultValue, min, max, step };
}

function value(module: ModuleRenderProps["module"], paramId: number) {
  return module.params[paramId] ?? euclidParams.find((paramDefinition) => paramDefinition.id === paramId)?.defaultValue ?? 0;
}

function intValue(module: ModuleRenderProps["module"], paramId: number, min: number, max: number) {
  return Math.round(clamp(value(module, paramId), min, max));
}

function boolValue(module: ModuleRenderProps["module"], paramId: number) {
  return value(module, paramId) >= 0.5;
}

function patternDensity(module: ModuleRenderProps["module"], channel: number, pattern: number) {
  const length = Math.max(1, value(module, patternParam(channel, pattern, PAT_LENGTH)));
  const events = clamp(value(module, patternParam(channel, pattern, PAT_EVENTS)), 0, length);
  const chance = clamp(value(module, patternParam(channel, pattern, PAT_CHANCE)), 0, 1);
  const burst = Math.max(1, value(module, patternParam(channel, pattern, PAT_BURST)));
  return clamp((events / length) * chance * Math.min(2.5, burst), 0, 1);
}

function euclideanActive(step: number, length: number, events: number, rotate: number) {
  if (length <= 0 || events <= 0) {
    return false;
  }
  if (events >= length) {
    return true;
  }
  const rotated = (step + length - (rotate % length)) % length;
  return (rotated * events) % length < events;
}

function formatPercent(next: number) {
  return `${Math.round(next * 100)}%`;
}

function clamp(next: number, min: number, max: number) {
  if (!Number.isFinite(next)) {
    return min;
  }
  return Math.min(max, Math.max(min, next));
}

function quantize(next: number, step: number) {
  if (step <= 0) {
    return next;
  }
  return Number((Math.round(next / step) * step).toFixed(6));
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number) {
  return Math.random() * (max - min) + min;
}

function randomChoice<T>(values: readonly T[]) {
  return values[Math.floor(Math.random() * values.length)];
}
