import { useEffect, useState } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { ModuleKnob } from "../../components/Knob";
import { paramById, valueForParam } from "../panelSections";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import { rhythmTrackLabelsForConnections } from "./trackLabels";
import "./RhythmSequencerModule.css";

const LANES = 11;
const PAGE_STEPS = 16;
const MAX_STEPS = 64;
const LEGACY_STEPS = 16;
const PATTERNS = 8;
const PARAM_LEGACY_PATTERN_STRIDE = LANES * LEGACY_STEPS;
const PARAM_ACTIVE_PATTERN = PATTERNS * PARAM_LEGACY_PATTERN_STRIDE;
const PARAM_METER = PARAM_ACTIVE_PATTERN + 1;
const PARAM_MUTE_BASE = PARAM_METER + 1;
const PARAM_SHUFFLE = PARAM_MUTE_BASE + LANES;
const PARAM_PATTERN_LENGTH = PARAM_SHUFFLE + 1;
const PARAM_EXTENDED_STEP_BASE = PARAM_PATTERN_LENGTH + 1;
const PARAM_EXTENDED_PATTERN_STRIDE = LANES * (MAX_STEPS - LEGACY_STEPS);
const METER_FOUR_FOUR = 0;
const METER_THREE_FOUR = 1;
const THREE_FOUR_STEPS = 12;
const STEP_OFF = 0;
const STEP_ON = 1;
const STEP_ACCENT = 2;
const STEP_STATE_COUNT = 3;
const RATCHET_OPTIONS = [1, 2, 3, 4] as const;
const MAX_PACKED_STEP_VALUE =
  STEP_ACCENT + STEP_STATE_COUNT * (RATCHET_OPTIONS.length - 1);
const PATTERN_LENGTH_OPTIONS = [16, 32, 64] as const;
const trackLabels = Array.from({ length: LANES }, (_, index) => `${index + 1}`);
const patternIndexes = Array.from({ length: PATTERNS }, (_, index) => index);
const visibleStepIndexes = Array.from({ length: PAGE_STEPS }, (_, index) => index);
const randomTrackProbabilities = [
  0.42,
  0.22,
  0.14,
  0.52,
  0.28,
  0.16,
  0.3,
  0.18,
  0.24,
  0.18,
  0.16,
];
const rhythmParams = [
  ...patternIndexes.flatMap((pattern) =>
    Array.from({ length: LANES * LEGACY_STEPS }, (_, index) => {
      const track = Math.floor(index / LEGACY_STEPS);
      const step = index % LEGACY_STEPS;
      return stepParamDefinition(pattern, track, step);
    }),
  ),
  {
    id: PARAM_ACTIVE_PATTERN,
    key: "active_pattern",
    label: "pattern",
    min: 0,
    max: PATTERNS - 1,
    step: 1,
    defaultValue: 0,
  },
  {
    id: PARAM_METER,
    key: "meter",
    label: "meter",
    min: METER_FOUR_FOUR,
    max: METER_THREE_FOUR,
    step: 1,
    defaultValue: METER_FOUR_FOUR,
  },
  ...trackLabels.map((label, index) => ({
    id: PARAM_MUTE_BASE + index,
    key: `track${index + 1}_mute`,
    label: `${label} mute`,
    min: 0,
    max: 1,
    step: 1,
    defaultValue: 0,
  })),
  {
    id: PARAM_SHUFFLE,
    key: "shuffle",
    label: "shuffle",
    min: 0,
    max: 1,
    step: 0.01,
    defaultValue: 0,
  },
  {
    id: PARAM_PATTERN_LENGTH,
    key: "pattern_length",
    label: "length",
    min: 0,
    max: PATTERN_LENGTH_OPTIONS.length - 1,
    step: 1,
    defaultValue: 0,
  },
  ...patternIndexes.flatMap((pattern) =>
    Array.from(
      { length: LANES * (MAX_STEPS - LEGACY_STEPS) },
      (_, index) => {
        const track = Math.floor(index / (MAX_STEPS - LEGACY_STEPS));
        const step = LEGACY_STEPS + (index % (MAX_STEPS - LEGACY_STEPS));
        return stepParamDefinition(pattern, track, step);
      },
    ),
  ),
] satisfies ParamDefinition[];

export const rhythmSequencerDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.rhythmSequencer,
  slug: "rhythm-sequencer",
  name: "RHY16",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 2,
  width: 716,
  minHeight: 374,
  sparseParams: true,
  inputs: [],
  outputs: [
    ...trackLabels.map((label, index) => ({
      id: index,
      label,
      kind: "gate" as const,
      connectionGroup: `rhy16-${index + 1}-out`,
      connectionGroupLabel: label,
      connectionGroupOrder: index,
      connectionOrder: 0,
      connectionLabel: "GATE",
    })),
    ...trackLabels.map((label, index) => ({
      id: LANES + index,
      label: `${label} acc`,
      kind: "cv" as const,
      connectionGroup: `rhy16-${index + 1}-out`,
      connectionGroupLabel: label,
      connectionGroupOrder: index,
      connectionOrder: 1,
      connectionLabel: "ACC",
    })),
  ],
  params: rhythmParams,
  Component: RhythmSequencerModule,
};

function RhythmSequencerModule(props: ModuleRenderProps) {
  const { module, definition, onParamChange, onModuleParamsChange } = props;
  const [activePage, setActivePage] = useState(0);
  const activePattern = activePatternValue(module);
  const meter = meterValue(module);
  const patternLength = patternLengthValue(module);
  const activePageCount = pageCountForLength(patternLength);
  const shuffleParam = paramById(PARAM_SHUFFLE, definition);
  const displayTrackLabels = rhythmTrackLabelsForConnections({
    module,
    definition,
    rackModules: props.rackModules,
    patchCables: props.patchCables,
    definitionsByKind: props.definitionsByKind,
    fallbackLabels: trackLabels,
  });

  useEffect(() => {
    setActivePage((page) => Math.min(page, activePageCount - 1));
  }, [activePageCount]);

  function selectPattern(pattern: number) {
    onParamChange(module.id, PARAM_ACTIVE_PATTERN, pattern);
  }

  function setMeter(nextMeter: number) {
    onParamChange(module.id, PARAM_METER, meterValueForParam(nextMeter));
  }

  function setPatternLength(length: number) {
    const nextIndex = patternLengthIndexForLength(length);
    onParamChange(module.id, PARAM_PATTERN_LENGTH, nextIndex);
  }

  function toggleTrack(trackIndex: number) {
    const muted = trackMuted(module, trackIndex);
    onParamChange(module.id, PARAM_MUTE_BASE + trackIndex, muted ? 0 : 1);
  }

  function clearPattern() {
    onModuleParamsChange(module.id, patternStepValues(activePattern, () => 0));
  }

  function randomizePattern() {
    onModuleParamsChange(
      module.id,
      patternStepValues(activePattern, (track, step) =>
        randomStepValue(track, step, meter, patternLength),
      ),
    );
  }

  function cycleStep(track: number, step: number) {
    const param = stepParam(definition, activePattern, track, step);
    const current = stepValueForParam(module, param);
    const nextState = (current.state + 1) % STEP_STATE_COUNT;
    onParamChange(
      module.id,
      param.id,
      packStepValue(nextState, current.ratchetIndex),
    );
  }

  function cycleRatchet(track: number, step: number) {
    const param = stepParam(definition, activePattern, track, step);
    const current = stepValueForParam(module, param);
    const nextRatchet = (current.ratchetIndex + 1) % RATCHET_OPTIONS.length;
    onParamChange(module.id, param.id, packStepValue(current.state, nextRatchet));
  }

  return (
    <ModuleShell {...props}>
      <div
        className={[
          "rhythmSeqPanel",
          meter === METER_THREE_FOUR ? "isThreeFour" : "isFourFour",
        ]
          .filter(Boolean)
          .join(" ")}
        data-loop-steps={patternLength}
      >
        <div className="rhythmSeqTop">
          <div className="rhythmSeqBanks" role="group" aria-label="rhythm patterns">
            <span className="rhythmSeqBanksLabel">presets</span>
            {patternIndexes.map((pattern) => (
              <button
                key={pattern}
                type="button"
                className={[
                  pattern === activePattern ? "isActive" : "",
                  patternHasNotes(module, pattern) ? "hasNotes" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`rhythm pattern ${pattern + 1}`}
                aria-pressed={pattern === activePattern}
                onClick={() => selectPattern(pattern)}
              >
                {pattern + 1}
              </button>
            ))}
          </div>
          <div className="rhythmSeqLength" role="group" aria-label="rhythm length">
            <span className="rhythmSeqBanksLabel">len</span>
            {PATTERN_LENGTH_OPTIONS.map((length) => (
              <button
                key={length}
                type="button"
                className={length === patternLength ? "isActive" : ""}
                aria-pressed={length === patternLength}
                onClick={() => setPatternLength(length)}
              >
                {length}
              </button>
            ))}
          </div>
          <div className="rhythmSeqPages" role="group" aria-label="rhythm pages">
            <span className="rhythmSeqBanksLabel">page</span>
            {Array.from({ length: 4 }, (_, page) => (
              <button
                key={page}
                type="button"
                className={[
                  page === activePage ? "isActive" : "",
                  page >= activePageCount ? "isDisabled" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`page ${page + 1}`}
                aria-pressed={page === activePage}
                disabled={page >= activePageCount}
                onClick={() => setActivePage(page)}
              >
                {page + 1}
              </button>
            ))}
          </div>
          <div className="rhythmSeqMeter" role="group" aria-label="rhythm meter">
            <button
              type="button"
              className={meter === METER_FOUR_FOUR ? "isActive" : ""}
              aria-pressed={meter === METER_FOUR_FOUR}
              onClick={() => setMeter(METER_FOUR_FOUR)}
            >
              4/4
            </button>
            <button
              type="button"
              className={meter === METER_THREE_FOUR ? "isActive" : ""}
              aria-pressed={meter === METER_THREE_FOUR}
              onClick={() => setMeter(METER_THREE_FOUR)}
            >
              3/4
            </button>
          </div>
          <div className="rhythmSeqShuffle">
            <ModuleKnob
              definition={definition}
              param={shuffleParam}
              value={valueForParam(module.params, shuffleParam)}
              onChange={(value) => onParamChange(module.id, PARAM_SHUFFLE, value)}
            />
          </div>
          <div className="rhythmSeqActions" role="group" aria-label="rhythm pattern actions">
            <button type="button" onClick={clearPattern}>
              clear
            </button>
            <button type="button" onClick={randomizePattern}>
              random
            </button>
          </div>
        </div>

        <div className="rhythmSeqGrid">
          {trackLabels.map((_, trackIndex) => {
            const track = displayTrackLabels[trackIndex] ?? trackLabels[trackIndex];
            const trackActive = trackHasNotes(module, activePattern, trackIndex);
            const muted = trackMuted(module, trackIndex);

            return (
              <div
                className={`rhythmSeqRow${muted ? " isMuted" : ""}`}
                key={trackIndex}
              >
                <button
                  type="button"
                  className={[
                    "rhythmSeqTrack",
                    trackActive ? "hasNotes" : "",
                    muted ? "isMuted" : "isActive",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={`${muted ? "Unmute" : "Mute"} ${track}`}
                  aria-pressed={muted}
                  onClick={() => toggleTrack(trackIndex)}
                >
                  {track}
                </button>
                {visibleStepIndexes.map((stepOnPage) => {
                  const step = activePage * PAGE_STEPS + stepOnPage;
                  const param = stepParam(definition, activePattern, trackIndex, step);
                  const stepValue = stepValueForParam(module, param);
                  const active = stepValue.state !== STEP_OFF;
                  const accented = stepValue.state === STEP_ACCENT;
                  const outsideMeter = !isStepEditable(step, meter, patternLength);
                  return (
                    <div
                      key={`${trackIndex}-${stepOnPage}`}
                      className={[
                        "rhythmSeqStepCell",
                        active ? "isOn" : "",
                        accented ? "isAccented" : "",
                        stepValue.ratchetIndex > 0 ? "hasRatchet" : "",
                        outsideMeter ? "isOutsideMeter" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      data-step={step}
                    >
                      <button
                        type="button"
                        className="rhythmSeqStepState"
                        aria-label={`${track} step ${step + 1} ${stepStateLabel(stepValue.state)}`}
                        disabled={outsideMeter}
                        onClick={() => cycleStep(trackIndex, step)}
                      />
                      <button
                        type="button"
                        className="rhythmSeqStepRatchet"
                        aria-label={`${track} step ${step + 1} ratchet ${RATCHET_OPTIONS[stepValue.ratchetIndex]}x`}
                        disabled={outsideMeter}
                        onClick={() => cycleRatchet(trackIndex, step)}
                      >
                        {stepValue.ratchetIndex === 0
                          ? ""
                          : RATCHET_OPTIONS[stepValue.ratchetIndex]}
                      </button>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </ModuleShell>
  );
}

function stepParamDefinition(pattern: number, track: number, step: number): ParamDefinition {
  return {
    id: stepParamId(pattern, track, step),
    key: `pattern${pattern + 1}_track${track + 1}_step${step + 1}`,
    label: `P${pattern + 1} ${trackLabels[track]} ${step + 1}`,
    min: 0,
    max: MAX_PACKED_STEP_VALUE,
    step: 1,
    defaultValue: defaultStepValue(pattern, track, step),
  };
}

function stepParamId(pattern: number, track: number, step: number) {
  if (step < LEGACY_STEPS) {
    return pattern * PARAM_LEGACY_PATTERN_STRIDE + track * LEGACY_STEPS + step;
  }
  return (
    PARAM_EXTENDED_STEP_BASE +
    pattern * PARAM_EXTENDED_PATTERN_STRIDE +
    track * (MAX_STEPS - LEGACY_STEPS) +
    (step - LEGACY_STEPS)
  );
}

function defaultStepValue(_pattern: number, _track: number, _step: number) {
  return 0;
}

function activePatternValue(module: ModuleRenderProps["module"]) {
  const value = module.params[PARAM_ACTIVE_PATTERN] ?? 0;
  if (!Number.isFinite(value)) {
    return 0;
  }
  return clampInteger(value, 0, PATTERNS - 1);
}

function patternLengthValue(module: ModuleRenderProps["module"]) {
  const value = module.params[PARAM_PATTERN_LENGTH] ?? 0;
  return PATTERN_LENGTH_OPTIONS[
    clampInteger(value, 0, PATTERN_LENGTH_OPTIONS.length - 1)
  ];
}

function patternLengthIndexForLength(length: number) {
  const index = PATTERN_LENGTH_OPTIONS.findIndex((candidate) => candidate === length);
  return index === -1 ? 0 : index;
}

function pageCountForLength(patternLength: number) {
  return Math.max(1, Math.ceil(patternLength / PAGE_STEPS));
}

function meterValue(module: ModuleRenderProps["module"]) {
  return meterValueForParam(module.params[PARAM_METER] ?? METER_FOUR_FOUR);
}

function meterValueForParam(value: number) {
  return value >= 0.5 ? METER_THREE_FOUR : METER_FOUR_FOUR;
}

function isStepEditable(step: number, meter: number, patternLength: number) {
  if (step < 0 || step >= patternLength) {
    return false;
  }
  if (meter !== METER_THREE_FOUR) {
    return true;
  }
  return step % PAGE_STEPS < THREE_FOUR_STEPS;
}

function trackMuted(module: ModuleRenderProps["module"], track: number) {
  return (module.params[PARAM_MUTE_BASE + track] ?? 0) >= 0.5;
}

function stepParam(
  definition: ModuleDefinition,
  pattern: number,
  track: number,
  step: number,
) {
  return definition.params[stepParamId(pattern, track, step)];
}

function patternStepValues(
  pattern: number,
  valueForStep: (track: number, step: number) => number,
) {
  const values: Record<number, number> = {};
  for (let track = 0; track < LANES; track += 1) {
    for (let step = 0; step < MAX_STEPS; step += 1) {
      values[stepParamId(pattern, track, step)] = valueForStep(track, step);
    }
  }
  return values;
}

function randomStepValue(
  track: number,
  step: number,
  meter: number,
  patternLength: number,
) {
  if (!isStepEditable(step, meter, patternLength)) {
    return 0;
  }

  const phraseStep = step % PAGE_STEPS;
  const accent = Math.random() < 0.18;
  if (track === 0 && phraseStep % 4 === 0) {
    return packRandomStep(accent);
  }
  if (track === 1 && (phraseStep === 4 || phraseStep === 12)) {
    return packRandomStep(accent);
  }
  if (track === 3 && phraseStep % 2 === 0) {
    return Math.random() < 0.88 ? packRandomStep(accent) : 0;
  }

  return Math.random() < (randomTrackProbabilities[track] ?? 0.18)
    ? packRandomStep(accent)
    : 0;
}

function packRandomStep(accent: boolean) {
  return packStepValue(accent ? STEP_ACCENT : STEP_ON, 0);
}

function patternHasNotes(module: ModuleRenderProps["module"], pattern: number) {
  for (let track = 0; track < LANES; track += 1) {
    if (trackHasNotes(module, pattern, track)) {
      return true;
    }
  }
  return false;
}

function trackHasNotes(
  module: ModuleRenderProps["module"],
  pattern: number,
  track: number,
) {
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const id = stepParamId(pattern, track, step);
    const value = unpackStepValue(
      module.params[id] ?? defaultStepValue(pattern, track, step),
    );
    if (value.state !== STEP_OFF) {
      return true;
    }
  }
  return false;
}

function stepValueForParam(
  module: ModuleRenderProps["module"],
  param: ParamDefinition,
) {
  return unpackStepValue(module.params[param.id] ?? param.defaultValue);
}

function packStepValue(state: number, ratchetIndex: number) {
  const normalizedState = clampInteger(state, STEP_OFF, STEP_ACCENT);
  if (normalizedState === STEP_OFF && ratchetIndex === 0) {
    return 0;
  }
  return (
    normalizedState +
    STEP_STATE_COUNT * clampInteger(ratchetIndex, 0, RATCHET_OPTIONS.length - 1)
  );
}

function unpackStepValue(value: number) {
  const rounded = clampInteger(value, 0, MAX_PACKED_STEP_VALUE);
  if (rounded <= STEP_ACCENT) {
    return {
      state: rounded,
      ratchetIndex: 0,
    };
  }
  return {
    state: rounded % STEP_STATE_COUNT,
    ratchetIndex: Math.floor(rounded / STEP_STATE_COUNT) % RATCHET_OPTIONS.length,
  };
}

function stepStateLabel(state: number) {
  if (state === STEP_ACCENT) {
    return "accent";
  }
  if (state === STEP_ON) {
    return "on";
  }
  return "off";
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}
