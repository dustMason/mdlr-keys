import { useEffect, useState } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type { ModuleDefinition, ModuleRenderProps, ParamDefinition } from "../types";
import "./MelodicSequencerModule.css";

const STEPS = 16;
const SEQUENCES = 8;
const PARAM_NOTE_BASE = 0;
const PARAM_GATE_BASE = 16;
const PARAM_ACCENT_BASE = 32;
const PARAM_SLIDE_BASE = 48;
const PARAM_SEQUENCE_STRIDE = STEPS * 4;
const PARAM_ACTIVE_SEQUENCE = SEQUENCES * PARAM_SEQUENCE_STRIDE;
const PARAM_TRANSPOSE = PARAM_ACTIVE_SEQUENCE + 1;
const PARAM_MODE = PARAM_ACTIVE_SEQUENCE + 2;
const PARAM_METER = PARAM_ACTIVE_SEQUENCE + 3;
const MODE_PROGRAM = 0;
const MODE_PERFORM = 1;
const METER_FOUR_FOUR = 0;
const METER_THREE_FOUR = 1;
const FOUR_FOUR_STEPS = 16;
const THREE_FOUR_STEPS = 12;
const TRANSPOSE_ROOT_NOTE = 12;
const TRANSPOSE_MIN = -12;
const TRANSPOSE_MAX = 11;

const defaultNotes = [0, 0, 7, 10, 12, 10, 7, 3, 0, 0, 12, 10, 7, 5, 3, 0];
const defaultGates = [
  1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1,
];
const defaultAccents = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];
const defaultSlides = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

const sequenceIndexes = Array.from({ length: SEQUENCES }, (_, index) => index);
const keyboardNotes = Array.from({ length: 24 }, (_, index) => index);
const whiteKeyOffsets = [0, 2, 4, 5, 7, 9, 11];
const randomNotePool = [0, 2, 3, 5, 7, 10, 12, 14, 15, 17, 19, 22];
const blackKeySlots = new Map([
  [1, 0.72],
  [3, 1.72],
  [6, 3.72],
  [8, 4.72],
  [10, 5.72],
]);

const melodicParams: ParamDefinition[] = [
  ...sequenceIndexes.flatMap((sequence) => [
    ...Array.from({ length: STEPS }, (_, step) =>
      stepParam(
        noteParamId(sequence, step),
        `seq${sequence + 1}_note${step + 1}`,
        defaultNote(sequence, step),
        -24,
        36,
      ),
    ),
    ...Array.from({ length: STEPS }, (_, step) =>
      stepParam(
        gateParamId(sequence, step),
        `seq${sequence + 1}_gate${step + 1}`,
        defaultGate(sequence, step),
        0,
        1,
      ),
    ),
    ...Array.from({ length: STEPS }, (_, step) =>
      stepParam(
        accentParamId(sequence, step),
        `seq${sequence + 1}_accent${step + 1}`,
        defaultAccent(sequence, step),
        0,
        1,
      ),
    ),
    ...Array.from({ length: STEPS }, (_, step) =>
      stepParam(
        slideParamId(sequence, step),
        `seq${sequence + 1}_slide${step + 1}`,
        defaultSlide(sequence, step),
        0,
        1,
      ),
    ),
  ]),
  stepParam(PARAM_ACTIVE_SEQUENCE, "active_sequence", 0, 0, SEQUENCES - 1),
  stepParam(PARAM_TRANSPOSE, "transpose", 0, TRANSPOSE_MIN, TRANSPOSE_MAX),
  stepParam(PARAM_MODE, "mode", MODE_PROGRAM, MODE_PROGRAM, MODE_PERFORM),
  stepParam(PARAM_METER, "meter", METER_FOUR_FOUR, METER_FOUR_FOUR, METER_THREE_FOUR),
];

export const melodicSequencerDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.melodicSequencer,
  slug: "melodic-sequencer",
  name: "SEQ16",
  accent: "#111111",
  rackWidth: "full",
  rackUnits: 1,
  width: 716,
  minHeight: 320,
  inputs: [],
  outputs: [
    { id: 0, label: "pitch", kind: "cv" },
    { id: 1, label: "gate", kind: "gate" },
    { id: 2, label: "accent", kind: "cv" },
    { id: 3, label: "slide", kind: "gate" },
  ],
  params: melodicParams,
  Component: MelodicSequencerModule,
};

function MelodicSequencerModule(props: ModuleRenderProps) {
  const { module, onParamChange } = props;
  const [activeStep, setActiveStep] = useState(0);
  const modeParam = module.params[PARAM_MODE];
  const transposeParam = module.params[PARAM_TRANSPOSE];
  const [uiMode, setUiMode] = useState(() => modeValue(module));
  const [uiTranspose, setUiTranspose] = useState(() => transposeValue(module));
  const activeSequence = activeSequenceValue(module);
  const meter = meterValue(module);
  const activeStepCount = meterStepCount(meter);
  const mode = uiMode;
  const isProgramMode = mode === MODE_PROGRAM;
  const activeTranspose = uiTranspose;
  const activeNote = noteValue(module, activeSequence, activeStep);
  const activeGate = gateValue(module, activeSequence, activeStep);
  const activeKeyboardNote = isProgramMode
    ? activeGate
      ? activeNote
      : null
    : TRANSPOSE_ROOT_NOTE + activeTranspose;

  useEffect(() => {
    setUiMode(modeValue(module));
  }, [modeParam]);

  useEffect(() => {
    setUiTranspose(transposeValue(module));
  }, [transposeParam]);

  useEffect(() => {
    if (activeStep >= activeStepCount) {
      setActiveStep(0);
    }
  }, [activeStep, activeStepCount]);

  function setMode(nextMode: number) {
    if (nextMode === mode) {
      return;
    }

    setUiMode(nextMode);
    onParamChange(module.id, PARAM_MODE, nextMode);
    if (nextMode === MODE_PROGRAM) {
      setUiTranspose(0);
      onParamChange(module.id, PARAM_TRANSPOSE, 0);
    }
  }

  function selectSequence(sequence: number) {
    onParamChange(module.id, PARAM_ACTIVE_SEQUENCE, sequence);
  }

  function setMeter(nextMeter: number) {
    const normalized = meterValueForParam(nextMeter);
    onParamChange(module.id, PARAM_METER, normalized);
    if (activeStep >= meterStepCount(normalized)) {
      setActiveStep(0);
    }
  }

  function chooseStep(step: number) {
    if (isProgramMode && step < activeStepCount) {
      setActiveStep(step);
    }
  }

  function advanceFrom(step: number) {
    setActiveStep((step + 1) % activeStepCount);
  }

  function writeNote(semitone: number) {
    if (!isProgramMode) {
      const nextTranspose = clampTranspose(semitone - TRANSPOSE_ROOT_NOTE);
      setUiMode(MODE_PERFORM);
      setUiTranspose(nextTranspose);
      onParamChange(module.id, PARAM_MODE, MODE_PERFORM);
      onParamChange(module.id, PARAM_TRANSPOSE, nextTranspose);
      return;
    }

    onParamChange(module.id, noteParamId(activeSequence, activeStep), semitone);
    onParamChange(module.id, gateParamId(activeSequence, activeStep), 1);
    onParamChange(module.id, accentParamId(activeSequence, activeStep), 0);
    onParamChange(module.id, slideParamId(activeSequence, activeStep), 0);
    advanceFrom(activeStep);
  }

  function writeRestOrRoot() {
    if (!isProgramMode) {
      setUiMode(MODE_PERFORM);
      setUiTranspose(0);
      onParamChange(module.id, PARAM_MODE, MODE_PERFORM);
      onParamChange(module.id, PARAM_TRANSPOSE, 0);
      return;
    }

    onParamChange(module.id, noteParamId(activeSequence, activeStep), 0);
    onParamChange(module.id, gateParamId(activeSequence, activeStep), 0);
    onParamChange(module.id, accentParamId(activeSequence, activeStep), 0);
    onParamChange(module.id, slideParamId(activeSequence, activeStep), 0);
    advanceFrom(activeStep);
  }

  function randomizePattern() {
    for (let step = 0; step < activeStepCount; step += 1) {
      const gate = Math.random() < 0.78 ? 1 : 0;
      const note =
        randomNotePool[Math.floor(Math.random() * randomNotePool.length)] ?? 0;
      onParamChange(module.id, noteParamId(activeSequence, step), note);
      onParamChange(module.id, gateParamId(activeSequence, step), gate);
      onParamChange(
        module.id,
        accentParamId(activeSequence, step),
        gate && Math.random() < 0.28 ? 1 : 0,
      );
      onParamChange(
        module.id,
        slideParamId(activeSequence, step),
        gate && Math.random() < 0.18 ? 1 : 0,
      );
    }
    setActiveStep(0);
  }

  return (
    <ModuleShell {...props}>
      <div
        className={[
          "melodicSeqPanel",
          isProgramMode ? "isProgramMode" : "isPerformMode",
          meter === METER_THREE_FOUR ? "isThreeFour" : "isFourFour",
        ]
          .filter(Boolean)
          .join(" ")}
        data-loop-steps={activeStepCount}
      >
        <div className="melodicSeqControls">
          <div className="melodicSeqMode" role="group" aria-label="sequencer mode">
            <button
              type="button"
              className={isProgramMode ? "isActive" : ""}
              aria-pressed={isProgramMode}
              onClick={() => setMode(MODE_PROGRAM)}
            >
              program
            </button>
            <button
              type="button"
              className={!isProgramMode ? "isActive" : ""}
              aria-pressed={!isProgramMode}
              onClick={() => setMode(MODE_PERFORM)}
            >
              perform
            </button>
          </div>

          <div className="melodicSeqMeter" role="group" aria-label="sequencer meter">
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

          <div className="melodicSeqBanks" role="group" aria-label="sequence slots">
            {sequenceIndexes.map((sequence) => (
              <button
                key={sequence}
                type="button"
                className={[
                  sequence === activeSequence ? "isActive" : "",
                  sequenceHasNotes(module, sequence) ? "hasNotes" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`sequence ${sequence + 1}`}
                aria-pressed={sequence === activeSequence}
                onClick={() => selectSequence(sequence)}
              >
                {sequence + 1}
              </button>
            ))}
          </div>

          <button
            type="button"
            className="melodicSeqRandom"
            aria-label={`randomize sequence ${activeSequence + 1}`}
            onClick={randomizePattern}
          >
            random
          </button>

          <output className="melodicSeqTranspose">
            {formatTranspose(isProgramMode ? 0 : activeTranspose)}
          </output>
        </div>

        <div className="melodicSeqSteps">
          {Array.from({ length: STEPS }, (_, step) => {
            const hasNote = gateValue(module, activeSequence, step);
            const outsideMeter = step >= activeStepCount;
            return (
              <button
                key={step}
                type="button"
                className={[
                  "melodicSeqStep",
                  isProgramMode && step === activeStep ? "isActive" : "",
                  hasNote ? "hasNote" : "",
                  outsideMeter ? "isOutsideMeter" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-step={step}
                aria-label={`step ${step + 1}`}
                aria-pressed={isProgramMode && step === activeStep}
                disabled={outsideMeter}
                onClick={() => chooseStep(step)}
              >
                <strong>{step + 1}</strong>
                <span>{hasNote ? noteLabel(noteValue(module, activeSequence, step)) : "REST"}</span>
              </button>
            );
          })}
        </div>

        <div className="melodicSeqKeys">
          <button
            className={[
              "melodicSeqRest",
              isProgramMode
                ? activeGate
                  ? ""
                  : "isActive"
                : activeTranspose === 0
                  ? "isActive"
                  : "",
            ]
              .filter(Boolean)
              .join(" ")}
            type="button"
            aria-label={
              isProgramMode
                ? `set sequence ${activeSequence + 1} step ${activeStep + 1} to rest`
                : "reset transpose to C3"
            }
            onClick={writeRestOrRoot}
          >
            {isProgramMode ? "REST" : "ROOT"}
          </button>
          <div
            className="melodicKeyboard"
            role="group"
            aria-label={
              isProgramMode ? "two octave keyboard" : "transpose keyboard"
            }
          >
            <div className="melodicWhiteKeys">
              {keyboardNotes
                .filter((note) => isWhiteKey(note))
                .map((note) => (
                  <button
                    key={note}
                    type="button"
                    className={[
                      "melodicWhiteKey",
                      note === TRANSPOSE_ROOT_NOTE ? "isRoot" : "",
                      activeKeyboardNote === note ? "isActive" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-label={keyboardAriaLabel(
                      note,
                      activeSequence,
                      activeStep,
                      isProgramMode,
                    )}
                    onClick={() => writeNote(note)}
                  >
                    {noteLabel(note)}
                  </button>
                ))}
            </div>
            <div className="melodicBlackKeys">
              {keyboardNotes
                .filter((note) => !isWhiteKey(note))
                .map((note) => (
                  <button
                    key={note}
                    type="button"
                    className={[
                      "melodicBlackKey",
                      activeKeyboardNote === note ? "isActive" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ left: `${blackKeyLeft(note)}%` }}
                    aria-label={keyboardAriaLabel(
                      note,
                      activeSequence,
                      activeStep,
                      isProgramMode,
                    )}
                    onClick={() => writeNote(note)}
                  >
                    {noteLabel(note)}
                  </button>
                ))}
            </div>
          </div>
        </div>
      </div>
    </ModuleShell>
  );
}

function stepParam(
  id: number,
  key: string,
  defaultValue: number,
  min: number,
  max: number,
): ParamDefinition {
  return {
    id,
    key,
    label: key,
    min,
    max,
    step: 1,
    defaultValue,
  };
}

function sequenceBase(sequence: number) {
  return sequence * PARAM_SEQUENCE_STRIDE;
}

function noteParamId(sequence: number, step: number) {
  return sequenceBase(sequence) + PARAM_NOTE_BASE + step;
}

function gateParamId(sequence: number, step: number) {
  return sequenceBase(sequence) + PARAM_GATE_BASE + step;
}

function accentParamId(sequence: number, step: number) {
  return sequenceBase(sequence) + PARAM_ACCENT_BASE + step;
}

function slideParamId(sequence: number, step: number) {
  return sequenceBase(sequence) + PARAM_SLIDE_BASE + step;
}

function defaultNote(sequence: number, step: number) {
  return sequence === 0 ? defaultNotes[step] : 0;
}

function defaultGate(sequence: number, step: number) {
  return sequence === 0 ? defaultGates[step] : 0;
}

function defaultAccent(sequence: number, step: number) {
  return sequence === 0 ? defaultAccents[step] : 0;
}

function defaultSlide(sequence: number, step: number) {
  return sequence === 0 ? defaultSlides[step] : 0;
}

function activeSequenceValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_ACTIVE_SEQUENCE] ?? 0,
    0,
    SEQUENCES - 1,
  );
}

function modeValue(module: ModuleRenderProps["module"]) {
  return (module.params[PARAM_MODE] ?? MODE_PROGRAM) >= 0.5
    ? MODE_PERFORM
    : MODE_PROGRAM;
}

function transposeValue(module: ModuleRenderProps["module"]) {
  return clampTranspose(module.params[PARAM_TRANSPOSE] ?? 0);
}

function meterValue(module: ModuleRenderProps["module"]) {
  return meterValueForParam(module.params[PARAM_METER] ?? METER_FOUR_FOUR);
}

function meterValueForParam(value: number) {
  return value >= 0.5 ? METER_THREE_FOUR : METER_FOUR_FOUR;
}

function meterStepCount(meter: number) {
  return meter === METER_THREE_FOUR ? THREE_FOUR_STEPS : FOUR_FOUR_STEPS;
}

function noteValue(
  module: ModuleRenderProps["module"],
  sequence: number,
  step: number,
) {
  return (
    module.params[noteParamId(sequence, step)] ?? defaultNote(sequence, step)
  );
}

function gateValue(
  module: ModuleRenderProps["module"],
  sequence: number,
  step: number,
) {
  return (
    module.params[gateParamId(sequence, step)] ?? defaultGate(sequence, step)
  ) >= 0.5;
}

function sequenceHasNotes(module: ModuleRenderProps["module"], sequence: number) {
  return Array.from({ length: STEPS }, (_, step) =>
    gateValue(module, sequence, step),
  ).some(Boolean);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampTranspose(value: number) {
  return clampInteger(value, TRANSPOSE_MIN, TRANSPOSE_MAX);
}

function isWhiteKey(semitone: number) {
  return whiteKeyOffsets.includes(semitone % 12);
}

function blackKeyLeft(semitone: number) {
  const octave = Math.floor(semitone / 12);
  const slot = blackKeySlots.get(semitone % 12) ?? 0;
  return ((octave * 7 + slot) / 14) * 100;
}

function noteLabel(semitone: number) {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const normalized = ((semitone % 12) + 12) % 12;
  const octave = Math.floor((semitone + 12) / 12) + 1;
  return `${names[normalized]}${octave}`;
}

function formatTranspose(semitones: number) {
  return semitones === 0 ? "+0" : `${semitones > 0 ? "+" : ""}${semitones}`;
}

function keyboardAriaLabel(
  note: number,
  sequence: number,
  step: number,
  isProgramMode: boolean,
) {
  if (isProgramMode) {
    return `set sequence ${sequence + 1} step ${step + 1} to ${noteLabel(note)}`;
  }

  return `transpose sequence ${formatTranspose(note - TRANSPOSE_ROOT_NOTE)}`;
}
