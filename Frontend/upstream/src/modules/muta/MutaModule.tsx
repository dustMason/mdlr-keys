import { useMemo, useState, type CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./MutaModule.css";

const CHANNELS = 3;
const STEPS = 64;
const PAGE_SIZE = 8;
const PAGES = STEPS / PAGE_SIZE;
const PATTERNS = 16;

const PARAM_NOTE_BASE = 0;
const PARAM_GATE_BASE = 64;
const PARAM_GATE_LENGTH_BASE = 128;
const PARAM_SLEW_BASE = 192;
const PARAM_RATCHET_BASE = 256;
const PARAM_MOD_BASE = 320;
const PARAM_CHANNEL_STRIDE = STEPS * 6;
const PARAM_GLOBAL_BASE = CHANNELS * PARAM_CHANNEL_STRIDE;

const PARAM_LENGTH_BASE = PARAM_GLOBAL_BASE;
const PARAM_SCALE_BASE = PARAM_LENGTH_BASE + CHANNELS;
const PARAM_ORDER_BASE = PARAM_SCALE_BASE + CHANNELS;
const PARAM_RATIO_BASE = PARAM_ORDER_BASE + CHANNELS;
const PARAM_ROOT_BASE = PARAM_RATIO_BASE + CHANNELS;
const PARAM_BRANCH_BASE = PARAM_ROOT_BASE + CHANNELS;
const PARAM_PATH_BASE = PARAM_BRANCH_BASE + CHANNELS;
const PARAM_MUTATE_BASE = PARAM_PATH_BASE + CHANNELS;
const PARAM_MICRO_RATCHET_BASE = PARAM_MUTATE_BASE + CHANNELS;
const PARAM_MICRO_SLEW_BASE = PARAM_MICRO_RATCHET_BASE + CHANNELS;
const PARAM_MICRO_MOD_BASE = PARAM_MICRO_SLEW_BASE + CHANNELS;
const PARAM_PERF_RATCHET_BASE = PARAM_MICRO_MOD_BASE + CHANNELS;
const PARAM_PERF_SLEW_BASE = PARAM_PERF_RATCHET_BASE + CHANNELS;
const PARAM_PERF_MUTATE_BASE = PARAM_PERF_SLEW_BASE + CHANNELS;
const PARAM_MOD_MODE_BASE = PARAM_PERF_MUTATE_BASE + CHANNELS;
const PARAM_ROTATE_BASE = PARAM_MOD_MODE_BASE + CHANNELS;
const PARAM_SEED_BASE = PARAM_ROTATE_BASE + CHANNELS;
const PARAM_ACTIVE_CHANNEL = PARAM_SEED_BASE + CHANNELS;
const PARAM_PAGE = PARAM_ACTIVE_CHANNEL + 1;
const PARAM_TUNE_MODE = PARAM_ACTIVE_CHANNEL + 2;
const PARAM_KNOB_MODE = PARAM_ACTIVE_CHANNEL + 3;
const PARAM_RATE = PARAM_ACTIVE_CHANNEL + 4;

const TUNE_NOTE = 0;
const TUNE_GATE = 1;
const TUNE_SLEW = 2;
const TUNE_RATCHET = 3;
const TUNE_MOD = 4;

const KNOB_DEFAULT = 0;
const KNOB_MICRO = 1;
const KNOB_PERFORMANCE = 2;

const MOD_SHAPES = 0;
const MOD_VELOCITY = 1;
const MOD_SMOOTH = 2;
const MOD_ENVELOPE = 3;

const SCALE_MAJOR = 1;
const ORDER_FORWARD = 0;
const RATIO_X1 = 4;
const RATCHET_VALUES = [1, 2, 3, 4, 6, 8, 16, 32] as const;

const channelNames = ["CH 1", "CH 2", "CH 3"] as const;
const channelAccents = ["#111111", "#425a3f", "#7a4b55"] as const;
const tuneModes = [
  { id: TUNE_NOTE, label: "note" },
  { id: TUNE_GATE, label: "gate" },
  { id: TUNE_SLEW, label: "slew" },
  { id: TUNE_RATCHET, label: "ratchet" },
  { id: TUNE_MOD, label: "mod" },
] as const;
const knobModes = [
  { id: KNOB_DEFAULT, label: "default" },
  { id: KNOB_MICRO, label: "micro" },
  { id: KNOB_PERFORMANCE, label: "perform" },
] as const;
const scaleNames = [
  "chrom",
  "major",
  "minor",
  "maj pent",
  "min pent",
  "harm min",
  "whole",
  "free",
] as const;
const orderNames = [
  "fwd",
  "rev",
  "pend",
  "rnd",
  "conv",
  "div",
  "c+d",
  "page",
] as const;
const ratioNames = ["1/4", "1/3", "1/2", "3/4", "1x", "3/2", "2x", "3x", "4x"] as const;
const modModeNames = ["shape", "vel", "smooth", "env"] as const;
const majorPool = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17, 19, 21, 23, 24];
const defaultNotes = [
  [0, 2, 4, 7, 9, 7, 4, 2],
  [12, 9, 7, 4, 5, 7, 9, 12],
  [0, 7, 12, 14, 12, 7, 5, 2],
] as const;
const defaultGates = [
  [1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 1, 1, 1, 0, 1, 1],
  [1, 1, 0, 1, 1, 1, 0, 1],
] as const;

const channelIndexes = Array.from({ length: CHANNELS }, (_, index) => index);
const stepIndexes = Array.from({ length: STEPS }, (_, index) => index);
const pageIndexes = Array.from({ length: PAGES }, (_, index) => index);

const mutaParams = [
  ...channelIndexes.flatMap((channel) => [
    ...stepIndexes.map((step) =>
      param(
        noteParamId(channel, step),
        `ch${channel + 1}_note${step + 1}`,
        `C${channel + 1} note ${step + 1}`,
        defaultNote(channel, step),
        0,
        60,
        1,
      ),
    ),
    ...stepIndexes.map((step) =>
      param(
        gateParamId(channel, step),
        `ch${channel + 1}_gate${step + 1}`,
        `C${channel + 1} gate ${step + 1}`,
        defaultGate(channel, step),
        0,
        1,
        1,
      ),
    ),
    ...stepIndexes.map((step) =>
      param(
        gateLengthParamId(channel, step),
        `ch${channel + 1}_gate_length${step + 1}`,
        `C${channel + 1} length ${step + 1}`,
        0.5,
        0.05,
        1,
        0.01,
      ),
    ),
    ...stepIndexes.map((step) =>
      param(
        slewParamId(channel, step),
        `ch${channel + 1}_slew${step + 1}`,
        `C${channel + 1} slew ${step + 1}`,
        0,
        0,
        1,
        0.01,
      ),
    ),
    ...stepIndexes.map((step) =>
      param(
        ratchetParamId(channel, step),
        `ch${channel + 1}_ratchet${step + 1}`,
        `C${channel + 1} ratchet ${step + 1}`,
        0,
        0,
        RATCHET_VALUES.length - 1,
        1,
      ),
    ),
    ...stepIndexes.map((step) =>
      param(
        modParamId(channel, step),
        `ch${channel + 1}_mod${step + 1}`,
        `C${channel + 1} mod ${step + 1}`,
        0,
        0,
        1,
        0.01,
      ),
    ),
  ]),
  ...channelIndexes.flatMap((channel) => [
    param(lengthParamId(channel), `ch${channel + 1}_length`, "length", 8, 1, 64, 1),
    param(scaleParamId(channel), `ch${channel + 1}_scale`, "scale", SCALE_MAJOR, 0, 7, 1),
    param(orderParamId(channel), `ch${channel + 1}_order`, "order", ORDER_FORWARD, 0, 7, 1),
    param(ratioParamId(channel), `ch${channel + 1}_ratio`, "ratio", RATIO_X1, 0, 8, 1),
    param(rootParamId(channel), `ch${channel + 1}_root`, "root", 0, -12, 12, 1),
    param(branchParamId(channel), `ch${channel + 1}_branch`, "branch", 0, 0, 7, 1),
    param(pathParamId(channel), `ch${channel + 1}_path`, "path", 0, 0, 127, 1),
    param(mutateParamId(channel), `ch${channel + 1}_mutate`, "mutate", 0, 0, 1, 0.01),
    param(microRatchetParamId(channel), `ch${channel + 1}_micro_ratchet`, "ratchet mut", 0, 0, 1, 0.01),
    param(microSlewParamId(channel), `ch${channel + 1}_micro_slew`, "slew mut", 0, 0, 1, 0.01),
    param(microModParamId(channel), `ch${channel + 1}_micro_mod`, "mod mut", 0, 0, 1, 0.01),
    param(perfRatchetParamId(channel), `ch${channel + 1}_perf_ratchet`, "ratchet fx", 0, 0, 1, 0.01),
    param(perfSlewParamId(channel), `ch${channel + 1}_perf_slew`, "slew fx", 0, 0, 1, 0.01),
    param(perfMutateParamId(channel), `ch${channel + 1}_perf_mutate`, "ornament", 0, 0, 1, 0.01),
    param(modModeParamId(channel), `ch${channel + 1}_mod_mode`, "mod mode", MOD_SHAPES, 0, 3, 1),
    param(rotateParamId(channel), `ch${channel + 1}_rotate`, "rotate", 0, 0, 63, 1),
    param(seedParamId(channel), `ch${channel + 1}_seed`, "seed", channel + 1, 0, 1_000_000, 1),
  ]),
  param(PARAM_ACTIVE_CHANNEL, "active_channel", "channel", 0, 0, CHANNELS - 1, 1),
  param(PARAM_PAGE, "page", "page", 0, 0, PAGES - 1, 1),
  param(PARAM_TUNE_MODE, "tune_mode", "tune", TUNE_NOTE, 0, tuneModes.length - 1, 1),
  param(PARAM_KNOB_MODE, "knob_mode", "knob", KNOB_DEFAULT, 0, knobModes.length - 1, 1),
  param(PARAM_RATE, "rate", "rate", 1, 0, 4, 0.01),
] satisfies ParamDefinition[];

export const mutaDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.muta,
  slug: "muta",
  name: "MUTA",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 3,
  width: 820,
  minHeight: 522,
  inputs: [
    { id: 0, label: "rate", kind: "cv", connectionOrder: 0 },
    { id: 1, label: "clock", kind: "gate", connectionOrder: 1 },
    { id: 2, label: "reset", kind: "gate", connectionOrder: 2 },
    { id: 3, label: "reseed", kind: "gate", connectionOrder: 3 },
    { id: 4, label: "branch", kind: "cv", connectionOrder: 4 },
    { id: 5, label: "path", kind: "cv", connectionOrder: 5 },
    { id: 6, label: "mutate", kind: "cv", connectionOrder: 6 },
    { id: 7, label: "root", kind: "cv", connectionOrder: 7 },
  ],
  outputs: [
    ...channelIndexes.flatMap((channel) => [
      {
        id: channel * 3,
        label: `note ${channel + 1}`,
        kind: "cv" as const,
        connectionGroup: `ch${channel + 1}`,
        connectionGroupLabel: channelNames[channel],
        connectionGroupOrder: channel,
        connectionOrder: channel * 3,
      },
      {
        id: channel * 3 + 1,
        label: `gate ${channel + 1}`,
        kind: "gate" as const,
        connectionGroup: `ch${channel + 1}`,
        connectionGroupLabel: channelNames[channel],
        connectionGroupOrder: channel,
        connectionOrder: channel * 3 + 1,
      },
      {
        id: channel * 3 + 2,
        label: `mod ${channel + 1}`,
        kind: "cv" as const,
        connectionGroup: `ch${channel + 1}`,
        connectionGroupLabel: channelNames[channel],
        connectionGroupOrder: channel,
        connectionOrder: channel * 3 + 2,
      },
    ]),
    { id: 9, label: "clock", kind: "gate", connectionOrder: 9 },
  ],
  params: mutaParams,
  Component: MutaModule,
};

function MutaModule(props: ModuleRenderProps) {
  const { module, onParamChange, onModuleParamsChange } = props;
  const activeChannel = channelValue(module.params[PARAM_ACTIVE_CHANNEL]);
  const length = lengthValue(module.params[lengthParamId(activeChannel)]);
  const page = pageValue(module.params[PARAM_PAGE], length);
  const tuneMode = tuneModeValue(module.params[PARAM_TUNE_MODE]);
  const knobMode = knobModeValue(module.params[PARAM_KNOB_MODE]);
  const modMode = integerValue(module.params[modModeParamId(activeChannel)], MOD_SHAPES, 0, 3);
  const selectedSteps = useMemo(
    () =>
      Array.from({ length: PAGE_SIZE }, (_, index) => {
        const step = page * PAGE_SIZE + index;
        return step < STEPS ? step : null;
      }),
    [page],
  );
  const [undoSnapshot, setUndoSnapshot] = useState<Record<number, number> | null>(null);
  const [patternSlot, setPatternSlot] = useState(0);
  const [patterns, setPatterns] = useState<Array<Record<number, number> | null>>(
    () => Array(PATTERNS).fill(null),
  );

  function setParam(paramId: number, value: number) {
    onParamChange(module.id, paramId, value);
  }

  function setChannel(channel: number) {
    setParam(PARAM_ACTIVE_CHANNEL, channel);
    const nextLength = lengthValue(module.params[lengthParamId(channel)]);
    setParam(PARAM_PAGE, pageValue(module.params[PARAM_PAGE], nextLength));
  }

  function setPage(nextPage: number) {
    setParam(PARAM_PAGE, pageValue(nextPage, length));
  }

  function setLength(nextLength: number) {
    resizeChannel(activeChannel, lengthValue(nextLength));
  }

  function setTuneMode(nextMode: number) {
    setParam(PARAM_TUNE_MODE, tuneModeValue(nextMode));
  }

  function setKnobMode(nextMode: number) {
    setParam(PARAM_KNOB_MODE, knobModeValue(nextMode));
  }

  function setModMode(nextMode: number) {
    setParam(modModeParamId(activeChannel), integerValue(nextMode, MOD_SHAPES, 0, 3));
  }

  function setStepValue(paramId: number, value: number) {
    onParamChange(module.id, paramId, value);
  }

  function toggleGate(step: number) {
    const paramId = gateParamId(activeChannel, step);
    setStepValue(paramId, gateValue(module.params, activeChannel, step) ? 0 : 1);
  }

  function reseedChannel() {
    captureUndo(activeChannel);
    const values: Record<number, number> = {};
    for (let step = 0; step < STEPS; step += 1) {
      randomizeStepValues(activeChannel, step, values);
    }
    values[lengthParamId(activeChannel)] = 16;
    values[seedParamId(activeChannel)] = nextSeed(module.params[seedParamId(activeChannel)]);
    onModuleParamsChange(module.id, values);
  }

  function randomizePage() {
    captureUndo(activeChannel);
    const values: Record<number, number> = {};
    for (const step of selectedSteps) {
      if (step === null || step >= length) {
        continue;
      }
      randomizeStepValues(activeChannel, step, values);
    }
    values[seedParamId(activeChannel)] = nextSeed(module.params[seedParamId(activeChannel)]);
    onModuleParamsChange(module.id, values);
  }

  function regenerateBranches() {
    setParam(seedParamId(activeChannel), nextSeed(module.params[seedParamId(activeChannel)]));
  }

  function mutateChannel() {
    captureUndo(activeChannel);
    const mutate = valueOrDefault(module.params, mutateParamId(activeChannel));
    const values: Record<number, number> = {};
    for (let step = 0; step < length; step += 1) {
      const noteChance = mutate < 0.5 ? mutate * 2 : 0.75;
      const gateChance = mutate < 0.5 ? 0 : (mutate - 0.5) * 2;
      if (Math.random() < noteChance) {
        values[noteParamId(activeChannel, step)] = clamp(
          noteValue(module.params, activeChannel, step) + randomInteger(-7, 7),
          0,
          60,
        );
      }
      if (Math.random() < gateChance) {
        if (Math.random() < 0.7) {
          values[gateLengthParamId(activeChannel, step)] = round(0.05 + Math.random() * 0.95, 2);
        } else {
          values[gateParamId(activeChannel, step)] = gateValue(module.params, activeChannel, step)
            ? 0
            : 1;
        }
      }
    }
    values[seedParamId(activeChannel)] = nextSeed(module.params[seedParamId(activeChannel)]);
    onModuleParamsChange(module.id, values);
  }

  function microMutateChannel() {
    captureUndo(activeChannel);
    const ratchetChance = valueOrDefault(module.params, microRatchetParamId(activeChannel));
    const slewChance = valueOrDefault(module.params, microSlewParamId(activeChannel));
    const modChance = valueOrDefault(module.params, microModParamId(activeChannel));
    const values: Record<number, number> = {};
    for (let step = 0; step < length; step += 1) {
      if (Math.random() < ratchetChance) {
        values[ratchetParamId(activeChannel, step)] = randomInteger(0, RATCHET_VALUES.length - 1);
      }
      if (Math.random() < slewChance) {
        values[slewParamId(activeChannel, step)] = round(Math.random(), 2);
      }
      if (Math.random() < modChance) {
        values[modParamId(activeChannel, step)] = round(Math.random(), 2);
      }
    }
    onModuleParamsChange(module.id, values);
  }

  function resizeChannel(channel: number, nextLength: number) {
    const currentLength = lengthValue(module.params[lengthParamId(channel)]);
    if (nextLength === currentLength) {
      return;
    }
    captureUndo(channel);
    const values: Record<number, number> = { [lengthParamId(channel)]: nextLength };
    for (let step = 0; step < STEPS; step += 1) {
      if (step >= nextLength) {
        values[gateParamId(channel, step)] = 0;
        continue;
      }
      const source =
        nextLength <= 1 || currentLength <= 1
          ? 0
          : Math.round((step / Math.max(1, nextLength - 1)) * (currentLength - 1));
      copyStep(module.params, channel, source, channel, step, values);
    }
    onModuleParamsChange(module.id, values);
    setPage(pageValue(page, nextLength));
  }

  function rotateChannel(amount: number) {
    captureUndo(activeChannel);
    const values: Record<number, number> = {};
    for (let step = 0; step < length; step += 1) {
      const source = (step - amount + length) % length;
      copyStep(module.params, activeChannel, source, activeChannel, step, values);
    }
    onModuleParamsChange(module.id, values);
  }

  function transposeChannel(amount: number) {
    captureUndo(activeChannel);
    const values: Record<number, number> = {};
    for (let step = 0; step < length; step += 1) {
      values[noteParamId(activeChannel, step)] = clamp(
        noteValue(module.params, activeChannel, step) + amount,
        0,
        60,
      );
    }
    onModuleParamsChange(module.id, values);
  }

  function factoryResetChannel() {
    captureUndo(activeChannel);
    const values = defaultChannelValues(activeChannel);
    onModuleParamsChange(module.id, values);
  }

  function captureUndo(channel: number) {
    setUndoSnapshot(snapshotChannel(module.params, channel));
  }

  function unmutate() {
    if (!undoSnapshot) {
      return;
    }
    onModuleParamsChange(module.id, undoSnapshot);
    setUndoSnapshot(null);
  }

  function storePattern() {
    setPatterns((current) => {
      const next = [...current];
      next[patternSlot] = snapshotChannelAs(module.params, activeChannel, 0);
      return next;
    });
  }

  function loadPattern() {
    const snapshot = patterns[patternSlot];
    if (!snapshot) {
      return;
    }
    captureUndo(activeChannel);
    onModuleParamsChange(module.id, remapSnapshotToChannel(snapshot, activeChannel));
  }

  return (
    <ModuleShell {...props}>
      <div
        className="mutaPanel"
        style={{ "--muta-channel": channelAccents[activeChannel] } as CSSProperties}
      >
        <div className="mutaTop">
          <div className="mutaSegment" aria-label="channel">
            {channelIndexes.map((channel) => (
              <button
                key={channel}
                type="button"
                className={channel === activeChannel ? "isActive" : ""}
                aria-pressed={channel === activeChannel}
                onClick={() => setChannel(channel)}
              >
                {channelNames[channel]}
              </button>
            ))}
          </div>
          <div className="mutaSegment mutaPages" aria-label="page">
            {pageIndexes.map((pageIndex) => {
              const active = pageIndex === page;
              const inLength = pageIndex * PAGE_SIZE < length;
              return (
                <button
                  key={pageIndex}
                  type="button"
                  className={[active ? "isActive" : "", inLength ? "isInLength" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  aria-pressed={active}
                  onClick={() => setPage(pageIndex)}
                >
                  {pageIndex + 1}
                </button>
              );
            })}
          </div>
          <RangeControl
            label="rate"
            value={valueOrDefault(module.params, PARAM_RATE)}
            min={0}
            max={4}
            step={0.01}
            display={formatRate}
            onChange={(value) => setParam(PARAM_RATE, value)}
          />
        </div>

        <div className="mutaModes">
          <div className="mutaSegment" aria-label="tune mode">
            {tuneModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={mode.id === tuneMode ? "isActive" : ""}
                aria-pressed={mode.id === tuneMode}
                onClick={() => setTuneMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="mutaSegment" aria-label="knob mode">
            {knobModes.map((mode) => (
              <button
                key={mode.id}
                type="button"
                className={mode.id === knobMode ? "isActive" : ""}
                aria-pressed={mode.id === knobMode}
                onClick={() => setKnobMode(mode.id)}
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="mutaSegment" aria-label="mod mode">
            {modModeNames.map((label, mode) => (
              <button
                key={label}
                type="button"
                className={mode === modMode ? "isActive" : ""}
                aria-pressed={mode === modMode}
                onClick={() => setModMode(mode)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mutaMain">
          <div className="mutaMacro">
            <MacroPanel
              module={module}
              channel={activeChannel}
              knobMode={knobMode}
              length={length}
              setParam={setParam}
              setLength={setLength}
            />
            <div className="mutaActions">
              <button type="button" onClick={randomizePage}>random</button>
              <button type="button" onClick={reseedChannel}>reseed</button>
              <button type="button" onClick={regenerateBranches}>branches</button>
              <button type="button" onClick={mutateChannel}>mutate</button>
              <button type="button" onClick={microMutateChannel}>micro</button>
              <button type="button" onClick={unmutate} disabled={!undoSnapshot}>undo</button>
              <button type="button" onClick={factoryResetChannel}>reset</button>
            </div>
            <div className="mutaTransform">
              <button type="button" onClick={() => resizeChannel(activeChannel, Math.max(1, Math.floor(length / 2)))}>halve</button>
              <button type="button" onClick={() => resizeChannel(activeChannel, Math.min(64, length * 2))}>double</button>
              <button type="button" onClick={() => rotateChannel(-1)}>rot -</button>
              <button type="button" onClick={() => rotateChannel(1)}>rot +</button>
              <button type="button" onClick={() => transposeChannel(-1)}>trn -</button>
              <button type="button" onClick={() => transposeChannel(1)}>trn +</button>
            </div>
            <div className="mutaPattern">
              <select
                aria-label="pattern slot"
                value={patternSlot}
                onChange={(event) => setPatternSlot(Number(event.target.value))}
              >
                {Array.from({ length: PATTERNS }, (_, index) => (
                  <option key={index} value={index}>
                    patt {index + 1}
                  </option>
                ))}
              </select>
              <button type="button" onClick={storePattern}>store</button>
              <button type="button" onClick={loadPattern} disabled={!patterns[patternSlot]}>
                load
              </button>
            </div>
          </div>

          <div className="mutaEditor">
            <div className="mutaTree" aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <span
                  key={index}
                  className={index <= branchValue(module.params, activeChannel) ? "isActive" : ""}
                />
              ))}
            </div>
            <div className="mutaSteps">
              {selectedSteps.map((step, slot) =>
                step === null ? (
                  <div key={slot} className="mutaStep isEmpty" />
                ) : (
                  <StepEditor
                    key={step}
                    module={module}
                    channel={activeChannel}
                    step={step}
                    inLength={step < length}
                    tuneMode={tuneMode}
                    onToggleGate={toggleGate}
                    onStepValue={setStepValue}
                  />
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    </ModuleShell>
  );
}

function MacroPanel({
  module,
  channel,
  knobMode,
  length,
  setParam,
  setLength,
}: {
  module: ModuleRenderProps["module"];
  channel: number;
  knobMode: number;
  length: number;
  setParam: (paramId: number, value: number) => void;
  setLength: (value: number) => void;
}) {
  return (
    <div className="mutaMacroGrid">
      <RangeControl
        label="length"
        value={length}
        min={1}
        max={64}
        step={1}
        display={(value) => `${Math.round(value)}`}
        onChange={setLength}
      />
      <SelectControl
        label="scale"
        value={integerValue(module.params[scaleParamId(channel)], SCALE_MAJOR, 0, 7)}
        options={scaleNames}
        onChange={(value) => setParam(scaleParamId(channel), value)}
      />
      <SelectControl
        label="order"
        value={integerValue(module.params[orderParamId(channel)], ORDER_FORWARD, 0, 7)}
        options={orderNames}
        onChange={(value) => setParam(orderParamId(channel), value)}
      />
      <SelectControl
        label="ratio"
        value={integerValue(module.params[ratioParamId(channel)], RATIO_X1, 0, 8)}
        options={ratioNames}
        onChange={(value) => setParam(ratioParamId(channel), value)}
      />
      <RangeControl
        label="root"
        value={valueOrDefault(module.params, rootParamId(channel))}
        min={-12}
        max={12}
        step={1}
        display={formatSigned}
        onChange={(value) => setParam(rootParamId(channel), value)}
      />
      <RangeControl
        label="branch"
        value={valueOrDefault(module.params, branchParamId(channel))}
        min={0}
        max={7}
        step={1}
        display={(value) => `${Math.round(value)}`}
        onChange={(value) => setParam(branchParamId(channel), value)}
      />
      <RangeControl
        label="path"
        value={valueOrDefault(module.params, pathParamId(channel))}
        min={0}
        max={127}
        step={1}
        display={(value) => `${Math.round(value)}`}
        onChange={(value) => setParam(pathParamId(channel), value)}
      />
      <RangeControl
        label="mutate"
        value={valueOrDefault(module.params, mutateParamId(channel))}
        min={0}
        max={1}
        step={0.01}
        display={formatPercent}
        onChange={(value) => setParam(mutateParamId(channel), value)}
      />
      {knobMode === KNOB_MICRO ? (
        <>
          <RangeControl
            label="rat mut"
            value={valueOrDefault(module.params, microRatchetParamId(channel))}
            min={0}
            max={1}
            step={0.01}
            display={formatPercent}
            onChange={(value) => setParam(microRatchetParamId(channel), value)}
          />
          <RangeControl
            label="slew mut"
            value={valueOrDefault(module.params, microSlewParamId(channel))}
            min={0}
            max={1}
            step={0.01}
            display={formatPercent}
            onChange={(value) => setParam(microSlewParamId(channel), value)}
          />
          <RangeControl
            label="mod mut"
            value={valueOrDefault(module.params, microModParamId(channel))}
            min={0}
            max={1}
            step={0.01}
            display={formatPercent}
            onChange={(value) => setParam(microModParamId(channel), value)}
          />
        </>
      ) : null}
      {knobMode === KNOB_PERFORMANCE ? (
        <>
          <RangeControl
            label="rat fx"
            value={valueOrDefault(module.params, perfRatchetParamId(channel))}
            min={0}
            max={1}
            step={0.01}
            display={formatPercent}
            onChange={(value) => setParam(perfRatchetParamId(channel), value)}
          />
          <RangeControl
            label="slew fx"
            value={valueOrDefault(module.params, perfSlewParamId(channel))}
            min={0}
            max={1}
            step={0.01}
            display={formatPercent}
            onChange={(value) => setParam(perfSlewParamId(channel), value)}
          />
          <RangeControl
            label="orn"
            value={valueOrDefault(module.params, perfMutateParamId(channel))}
            min={0}
            max={1}
            step={0.01}
            display={formatPercent}
            onChange={(value) => setParam(perfMutateParamId(channel), value)}
          />
        </>
      ) : null}
    </div>
  );
}

function StepEditor({
  module,
  channel,
  step,
  inLength,
  tuneMode,
  onToggleGate,
  onStepValue,
}: {
  module: ModuleRenderProps["module"];
  channel: number;
  step: number;
  inLength: boolean;
  tuneMode: number;
  onToggleGate: (step: number) => void;
  onStepValue: (paramId: number, value: number) => void;
}) {
  const gate = gateValue(module.params, channel, step);
  const note = noteValue(module.params, channel, step);
  const gateLength = valueOrDefault(module.params, gateLengthParamId(channel, step));
  const slew = valueOrDefault(module.params, slewParamId(channel, step));
  const ratchet = integerValue(module.params[ratchetParamId(channel, step)], 0, 0, RATCHET_VALUES.length - 1);
  const mod = valueOrDefault(module.params, modParamId(channel, step));

  return (
    <div className={["mutaStep", gate ? "hasGate" : "", inLength ? "" : "isMuted"]
      .filter(Boolean)
      .join(" ")}
    >
      <button
        type="button"
        className="mutaStepHead"
        aria-pressed={gate}
        disabled={!inLength}
        onClick={() => onToggleGate(step)}
      >
        <strong>{step + 1}</strong>
        <span>{gate ? noteLabel(note) : "rest"}</span>
      </button>
      {tuneMode === TUNE_NOTE ? (
        <StepRange
          value={note}
          min={0}
          max={60}
          step={1}
          disabled={!inLength}
          display={noteLabel}
          onChange={(value) => onStepValue(noteParamId(channel, step), value)}
        />
      ) : null}
      {tuneMode === TUNE_GATE ? (
        <StepRange
          value={gateLength}
          min={0.05}
          max={1}
          step={0.01}
          disabled={!inLength}
          display={formatPercent}
          onChange={(value) => onStepValue(gateLengthParamId(channel, step), value)}
        />
      ) : null}
      {tuneMode === TUNE_SLEW ? (
        <StepRange
          value={slew}
          min={0}
          max={1}
          step={0.01}
          disabled={!inLength}
          display={formatPercent}
          onChange={(value) => onStepValue(slewParamId(channel, step), value)}
        />
      ) : null}
      {tuneMode === TUNE_RATCHET ? (
        <StepRange
          value={ratchet}
          min={0}
          max={RATCHET_VALUES.length - 1}
          step={1}
          disabled={!inLength}
          display={(value) => `x${RATCHET_VALUES[Math.round(value)] ?? 1}`}
          onChange={(value) => onStepValue(ratchetParamId(channel, step), value)}
        />
      ) : null}
      {tuneMode === TUNE_MOD ? (
        <StepRange
          value={mod}
          min={0}
          max={1}
          step={0.01}
          disabled={!inLength}
          display={formatPercent}
          onChange={(value) => onStepValue(modParamId(channel, step), value)}
        />
      ) : null}
    </div>
  );
}

function RangeControl({
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
  display: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mutaRange">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{display(value)}</output>
    </label>
  );
}

function SelectControl({
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
    <label className="mutaSelect">
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

function StepRange({
  value,
  min,
  max,
  step,
  disabled,
  display,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  display: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="mutaStepRange">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{display(value)}</output>
    </label>
  );
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

function channelBase(channel: number) {
  return channel * PARAM_CHANNEL_STRIDE;
}

function noteParamId(channel: number, step: number) {
  return channelBase(channel) + PARAM_NOTE_BASE + step;
}

function gateParamId(channel: number, step: number) {
  return channelBase(channel) + PARAM_GATE_BASE + step;
}

function gateLengthParamId(channel: number, step: number) {
  return channelBase(channel) + PARAM_GATE_LENGTH_BASE + step;
}

function slewParamId(channel: number, step: number) {
  return channelBase(channel) + PARAM_SLEW_BASE + step;
}

function ratchetParamId(channel: number, step: number) {
  return channelBase(channel) + PARAM_RATCHET_BASE + step;
}

function modParamId(channel: number, step: number) {
  return channelBase(channel) + PARAM_MOD_BASE + step;
}

function lengthParamId(channel: number) {
  return PARAM_LENGTH_BASE + channel;
}

function scaleParamId(channel: number) {
  return PARAM_SCALE_BASE + channel;
}

function orderParamId(channel: number) {
  return PARAM_ORDER_BASE + channel;
}

function ratioParamId(channel: number) {
  return PARAM_RATIO_BASE + channel;
}

function rootParamId(channel: number) {
  return PARAM_ROOT_BASE + channel;
}

function branchParamId(channel: number) {
  return PARAM_BRANCH_BASE + channel;
}

function pathParamId(channel: number) {
  return PARAM_PATH_BASE + channel;
}

function mutateParamId(channel: number) {
  return PARAM_MUTATE_BASE + channel;
}

function microRatchetParamId(channel: number) {
  return PARAM_MICRO_RATCHET_BASE + channel;
}

function microSlewParamId(channel: number) {
  return PARAM_MICRO_SLEW_BASE + channel;
}

function microModParamId(channel: number) {
  return PARAM_MICRO_MOD_BASE + channel;
}

function perfRatchetParamId(channel: number) {
  return PARAM_PERF_RATCHET_BASE + channel;
}

function perfSlewParamId(channel: number) {
  return PARAM_PERF_SLEW_BASE + channel;
}

function perfMutateParamId(channel: number) {
  return PARAM_PERF_MUTATE_BASE + channel;
}

function modModeParamId(channel: number) {
  return PARAM_MOD_MODE_BASE + channel;
}

function rotateParamId(channel: number) {
  return PARAM_ROTATE_BASE + channel;
}

function seedParamId(channel: number) {
  return PARAM_SEED_BASE + channel;
}

function defaultNote(channel: number, step: number) {
  return step < PAGE_SIZE ? (defaultNotes[channel]?.[step] ?? 0) : 0;
}

function defaultGate(channel: number, step: number) {
  return step < PAGE_SIZE ? (defaultGates[channel]?.[step] ?? 0) : 0;
}

function noteValue(params: Record<number, number>, channel: number, step: number) {
  return valueOrDefault(params, noteParamId(channel, step));
}

function gateValue(params: Record<number, number>, channel: number, step: number) {
  return valueOrDefault(params, gateParamId(channel, step)) >= 0.5;
}

function branchValue(params: Record<number, number>, channel: number) {
  return integerValue(params[branchParamId(channel)], 0, 0, 7);
}

function valueOrDefault(params: Record<number, number>, paramId: number) {
  const found = mutaParams.find((candidate) => candidate.id === paramId);
  return params[paramId] ?? found?.defaultValue ?? 0;
}

function channelValue(value: number | undefined) {
  return integerValue(value, 0, 0, CHANNELS - 1);
}

function lengthValue(value: number | undefined) {
  return integerValue(value, 8, 1, STEPS);
}

function pageValue(value: number | undefined, length: number) {
  const maxPage = Math.max(0, Math.ceil(length / PAGE_SIZE) - 1);
  return integerValue(value, 0, 0, maxPage);
}

function tuneModeValue(value: number | undefined) {
  return integerValue(value, TUNE_NOTE, 0, tuneModes.length - 1);
}

function knobModeValue(value: number | undefined) {
  return integerValue(value, KNOB_DEFAULT, 0, knobModes.length - 1);
}

function integerValue(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value ?? fallback)));
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round(value: number, digits: number) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function randomInteger(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomNote() {
  const octave = randomInteger(0, 3) * 12;
  return clamp(octave + majorPool[randomInteger(0, majorPool.length - 1)], 0, 60);
}

function randomizeStepValues(
  channel: number,
  step: number,
  values: Record<number, number>,
) {
  values[noteParamId(channel, step)] = randomNote();
  values[gateParamId(channel, step)] = Math.random() < 0.82 ? 1 : 0;
  values[gateLengthParamId(channel, step)] = round(
    Math.max(0.08, Math.random() * 0.92),
    2,
  );
  values[slewParamId(channel, step)] =
    Math.random() < 0.22 ? round(Math.random() * 0.65, 2) : 0;
  values[ratchetParamId(channel, step)] =
    Math.random() < 0.2 ? randomInteger(1, 4) : 0;
  values[modParamId(channel, step)] = round(Math.random(), 2);
}

function nextSeed(value: number | undefined) {
  return (integerValue(value, 1, 0, 1_000_000) + randomInteger(1, 9973)) % 1_000_000;
}

function copyStep(
  params: Record<number, number>,
  sourceChannel: number,
  sourceStep: number,
  targetChannel: number,
  targetStep: number,
  values: Record<number, number>,
) {
  values[noteParamId(targetChannel, targetStep)] = noteValue(params, sourceChannel, sourceStep);
  values[gateParamId(targetChannel, targetStep)] = gateValue(params, sourceChannel, sourceStep) ? 1 : 0;
  values[gateLengthParamId(targetChannel, targetStep)] = valueOrDefault(
    params,
    gateLengthParamId(sourceChannel, sourceStep),
  );
  values[slewParamId(targetChannel, targetStep)] = valueOrDefault(params, slewParamId(sourceChannel, sourceStep));
  values[ratchetParamId(targetChannel, targetStep)] = valueOrDefault(
    params,
    ratchetParamId(sourceChannel, sourceStep),
  );
  values[modParamId(targetChannel, targetStep)] = valueOrDefault(params, modParamId(sourceChannel, sourceStep));
}

function snapshotChannel(params: Record<number, number>, channel: number) {
  return snapshotChannelAs(params, channel, channel);
}

function snapshotChannelAs(
  params: Record<number, number>,
  sourceChannel: number,
  targetChannel: number,
) {
  const values: Record<number, number> = {};
  for (let step = 0; step < STEPS; step += 1) {
    copyStep(params, sourceChannel, step, targetChannel, step, values);
  }
  const controlPairs = [
    [lengthParamId(sourceChannel), lengthParamId(targetChannel)],
    [scaleParamId(sourceChannel), scaleParamId(targetChannel)],
    [orderParamId(sourceChannel), orderParamId(targetChannel)],
    [ratioParamId(sourceChannel), ratioParamId(targetChannel)],
    [rootParamId(sourceChannel), rootParamId(targetChannel)],
    [branchParamId(sourceChannel), branchParamId(targetChannel)],
    [pathParamId(sourceChannel), pathParamId(targetChannel)],
    [mutateParamId(sourceChannel), mutateParamId(targetChannel)],
    [microRatchetParamId(sourceChannel), microRatchetParamId(targetChannel)],
    [microSlewParamId(sourceChannel), microSlewParamId(targetChannel)],
    [microModParamId(sourceChannel), microModParamId(targetChannel)],
    [perfRatchetParamId(sourceChannel), perfRatchetParamId(targetChannel)],
    [perfSlewParamId(sourceChannel), perfSlewParamId(targetChannel)],
    [perfMutateParamId(sourceChannel), perfMutateParamId(targetChannel)],
    [modModeParamId(sourceChannel), modModeParamId(targetChannel)],
    [rotateParamId(sourceChannel), rotateParamId(targetChannel)],
    [seedParamId(sourceChannel), seedParamId(targetChannel)],
  ] as const;
  for (const [source, target] of controlPairs) {
    values[target] = valueOrDefault(params, source);
  }
  return values;
}

function remapSnapshotToChannel(snapshot: Record<number, number>, channel: number) {
  const values: Record<number, number> = {};
  for (let step = 0; step < STEPS; step += 1) {
    copyStep(snapshot, 0, step, channel, step, values);
  }
  const sourceControls = snapshotChannel(snapshot, 0);
  for (const [paramId, value] of Object.entries(sourceControls)) {
    const sourceParamId = Number(paramId);
    const targetParamId = remapControlParam(sourceParamId, channel);
    if (targetParamId !== null) {
      values[targetParamId] = value;
    }
  }
  return values;
}

function remapControlParam(paramId: number, targetChannel: number) {
  const controlBases = [
    PARAM_LENGTH_BASE,
    PARAM_SCALE_BASE,
    PARAM_ORDER_BASE,
    PARAM_RATIO_BASE,
    PARAM_ROOT_BASE,
    PARAM_BRANCH_BASE,
    PARAM_PATH_BASE,
    PARAM_MUTATE_BASE,
    PARAM_MICRO_RATCHET_BASE,
    PARAM_MICRO_SLEW_BASE,
    PARAM_MICRO_MOD_BASE,
    PARAM_PERF_RATCHET_BASE,
    PARAM_PERF_SLEW_BASE,
    PARAM_PERF_MUTATE_BASE,
    PARAM_MOD_MODE_BASE,
    PARAM_ROTATE_BASE,
    PARAM_SEED_BASE,
  ];
  for (const base of controlBases) {
    if (paramId >= base && paramId < base + CHANNELS) {
      return base + targetChannel;
    }
  }
  return null;
}

function defaultChannelValues(channel: number) {
  const values: Record<number, number> = {};
  for (const param of mutaParams) {
    const inChannelStep =
      param.id >= channelBase(channel) && param.id < channelBase(channel) + PARAM_CHANNEL_STRIDE;
    const inChannelControl =
      [
        lengthParamId(channel),
        scaleParamId(channel),
        orderParamId(channel),
        ratioParamId(channel),
        rootParamId(channel),
        branchParamId(channel),
        pathParamId(channel),
        mutateParamId(channel),
        microRatchetParamId(channel),
        microSlewParamId(channel),
        microModParamId(channel),
        perfRatchetParamId(channel),
        perfSlewParamId(channel),
        perfMutateParamId(channel),
        modModeParamId(channel),
        rotateParamId(channel),
        seedParamId(channel),
      ].includes(param.id);
    if (inChannelStep || inChannelControl) {
      values[param.id] = param.defaultValue;
    }
  }
  return values;
}

function noteLabel(note: number) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const rounded = Math.round(note);
  const normalized = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12);
  return `${names[normalized]}${octave}`;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatSigned(value: number) {
  const rounded = Math.round(value);
  return rounded === 0 ? "+0" : `${rounded > 0 ? "+" : ""}${rounded}`;
}

function formatRate(value: number) {
  return value <= 0.001 ? "ext" : `${round(value, 2)}x`;
}
