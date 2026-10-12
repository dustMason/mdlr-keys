import { useState, type CSSProperties } from "react";
import { ModuleShell } from "../../components/ModuleShell";
import { MODULE_KINDS } from "../kinds";
import type {
  JackDefinition,
  ModuleDefinition,
  ModuleRenderProps,
  ParamDefinition,
} from "../types";
import "./StepsModule.css";

const STAGES = 8;
const VOICES = 4;
const SCALE_NOTE_COUNT = 12;
const PARAM_NOTE_BASE = 0;
const PARAM_CHORD_BASE = PARAM_NOTE_BASE + STAGES;
const PARAM_STAGE_STEPS_BASE = PARAM_CHORD_BASE + STAGES;
const PARAM_TRIG_BASE = PARAM_STAGE_STEPS_BASE + STAGES;
const PARAM_SKIP_BASE = PARAM_TRIG_BASE + STAGES;
const PARAM_LOCK_BASE = PARAM_SKIP_BASE + STAGES;
const PARAM_SEQUENCE_STEPS = PARAM_LOCK_BASE + STAGES;
const PARAM_DIRECTION = PARAM_SEQUENCE_STEPS + 1;
const PARAM_RANGE_LOW = PARAM_DIRECTION + 1;
const PARAM_RANGE_HIGH = PARAM_RANGE_LOW + 1;
const PARAM_NOTE_LENGTH = PARAM_RANGE_HIGH + 1;
const PARAM_SCALE_ROOT = PARAM_NOTE_LENGTH + 1;
const PARAM_SCALE_PRESET = PARAM_SCALE_ROOT + 1;
const PARAM_SCALE_MASK_BASE = PARAM_SCALE_PRESET + 1;
const PARAM_CHORD_INVERSION = PARAM_SCALE_MASK_BASE + SCALE_NOTE_COUNT;
const PARAM_PITCH_BEND = PARAM_CHORD_INVERSION + 1;
const PARAM_BEND_RANGE = PARAM_PITCH_BEND + 1;
const PARAM_QUANTIZE_BEND = PARAM_BEND_RANGE + 1;
const PARAM_VELOCITY = PARAM_QUANTIZE_BEND + 1;
const PARAM_TIME_BEND = PARAM_VELOCITY + 1;
const PARAM_B_AMOUNT = PARAM_TIME_BEND + 1;
const PARAM_B_START = PARAM_B_AMOUNT + 1;
const DIRECTION_FORWARD = 0;
const DIRECTION_REVERSE = 1;
const DIRECTION_PING_PONG = 2;
const DIRECTION_RANDOM = 3;
const NOTE_MIN = 0;
const NOTE_MAX = 36;
const SEQUENCE_STEPS_MIN = 1;
const SEQUENCE_STEPS_MAX = 64;
const STAGE_STEPS_MIN = 1;
const STAGE_STEPS_MAX = 16;
const TRIG_MIN = 1;
const TRIG_MAX = 16;
const CHORD_INVERSION_MIN = -24;
const CHORD_INVERSION_MAX = 24;
const PITCH_BEND_MIN = -1;
const PITCH_BEND_MAX = 1;
const BEND_RANGE_MIN = 1;
const BEND_RANGE_MAX = 48;
const B_START_MIN = 0;
const B_START_MAX = 63;

const stageIndexes = Array.from({ length: STAGES }, (_, index) => index);
const scaleNoteIndexes = Array.from(
  { length: SCALE_NOTE_COUNT },
  (_, index) => index,
);
const sequenceStepOptions = Array.from(
  { length: SEQUENCE_STEPS_MAX },
  (_, index) => index + 1,
);
const bendRangeOptions = Array.from(
  { length: BEND_RANGE_MAX },
  (_, index) => index + BEND_RANGE_MIN,
);
const noteOptions = Array.from(
  { length: NOTE_MAX - NOTE_MIN + 1 },
  (_, index) => NOTE_MIN + index,
);
const scaleRootOptions = Array.from(
  { length: SCALE_NOTE_COUNT },
  (_, index) => index,
);
const defaultNotes = [8, 5, 10, 5, 10, 5, 5, 10];
const NOTE_NAMES = [
  "C",
  "C#",
  "D",
  "D#",
  "E",
  "F",
  "F#",
  "G",
  "G#",
  "A",
  "A#",
  "B",
];
const directionButtons = [
  { value: DIRECTION_FORWARD, label: ">>", aria: "forward" },
  { value: DIRECTION_REVERSE, label: "<<", aria: "reverse" },
  { value: DIRECTION_PING_PONG, label: "><", aria: "ping pong" },
  { value: DIRECTION_RANDOM, label: "??", aria: "random" },
] as const;
const chordShapes = [
  { label: "root", shortLabel: "RT" },
  { label: "5th", shortLabel: "5" },
  { label: "major", shortLabel: "MAJ" },
  { label: "minor", shortLabel: "MIN" },
  { label: "dim", shortLabel: "DIM" },
  { label: "aug", shortLabel: "AUG" },
  { label: "sus4", shortLabel: "S4" },
  { label: "sus2", shortLabel: "S2" },
  { label: "7", shortLabel: "7" },
  { label: "maj7", shortLabel: "M7" },
  { label: "min7", shortLabel: "m7" },
  { label: "dim7", shortLabel: "d7" },
  { label: "add9", shortLabel: "9" },
  { label: "madd9", shortLabel: "m9" },
  { label: "9no3", shortLabel: "n9" },
] as const;
const scalePresets = [
  { label: "Chrom", mask: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1] },
  { label: "Major", mask: [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1] },
  { label: "Minor", mask: [1, 0, 1, 1, 0, 1, 0, 1, 1, 0, 1, 0] },
  { label: "Maj P", mask: [1, 0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 0] },
  { label: "Min P", mask: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0] },
  { label: "Dorian", mask: [1, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0] },
  { label: "Phryg", mask: [1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 1, 0] },
  { label: "Whole", mask: [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0] },
] as const;

const params = [
  ...stageIndexes.map((stage) =>
    param(
      noteParamId(stage),
      `stage${stage + 1}_note`,
      "note",
      defaultNotes[stage],
      NOTE_MIN,
      NOTE_MAX,
      1,
    ),
  ),
  ...stageIndexes.map((stage) =>
    param(
      chordParamId(stage),
      `stage${stage + 1}_chord`,
      "chord",
      0,
      0,
      chordShapes.length - 1,
      1,
    ),
  ),
  ...stageIndexes.map((stage) =>
    param(
      stageStepsParamId(stage),
      `stage${stage + 1}_steps`,
      "steps",
      1,
      STAGE_STEPS_MIN,
      STAGE_STEPS_MAX,
      1,
    ),
  ),
  ...stageIndexes.map((stage) =>
    param(
      trigParamId(stage),
      `stage${stage + 1}_trigs`,
      "trigs",
      1,
      TRIG_MIN,
      TRIG_MAX,
      1,
    ),
  ),
  ...stageIndexes.map((stage) =>
    param(skipParamId(stage), `stage${stage + 1}_skip`, "skip", 0, 0, 1, 1),
  ),
  ...stageIndexes.map((stage) =>
    param(lockParamId(stage), `stage${stage + 1}_lock`, "lock", 0, 0, 1, 1),
  ),
  param(
    PARAM_SEQUENCE_STEPS,
    "sequence_steps",
    "steps",
    16,
    SEQUENCE_STEPS_MIN,
    SEQUENCE_STEPS_MAX,
    1,
  ),
  param(
    PARAM_DIRECTION,
    "direction",
    "dir",
    DIRECTION_FORWARD,
    DIRECTION_FORWARD,
    DIRECTION_RANDOM,
    1,
  ),
  param(PARAM_RANGE_LOW, "range_low", "low", NOTE_MIN, NOTE_MIN, NOTE_MAX - 1, 1),
  param(
    PARAM_RANGE_HIGH,
    "range_high",
    "high",
    NOTE_MAX,
    NOTE_MIN + 1,
    NOTE_MAX,
    1,
  ),
  param(PARAM_NOTE_LENGTH, "note_length", "note len", 0.72, 0.04, 1, 0.01),
  param(PARAM_SCALE_ROOT, "scale_root", "root", 0, 0, SCALE_NOTE_COUNT - 1, 1),
  param(
    PARAM_SCALE_PRESET,
    "scale_preset",
    "scale",
    0,
    0,
    scalePresets.length - 1,
    1,
  ),
  ...scaleNoteIndexes.map((note) =>
    param(
      scaleMaskParamId(note),
      `scale_note_${note}`,
      "scale note",
      1,
      0,
      1,
      1,
    ),
  ),
  param(
    PARAM_CHORD_INVERSION,
    "chord_inversion",
    "inv",
    0,
    CHORD_INVERSION_MIN,
    CHORD_INVERSION_MAX,
    1,
  ),
  param(
    PARAM_PITCH_BEND,
    "pitch_bend",
    "bend",
    0,
    PITCH_BEND_MIN,
    PITCH_BEND_MAX,
    0.01,
  ),
  param(
    PARAM_BEND_RANGE,
    "bend_range",
    "range",
    12,
    BEND_RANGE_MIN,
    BEND_RANGE_MAX,
    1,
  ),
  param(PARAM_QUANTIZE_BEND, "quantize_bend", "quant", 1, 0, 1, 1),
  param(PARAM_VELOCITY, "velocity", "vel", 0.8, 0, 1, 0.01),
  param(PARAM_TIME_BEND, "time_bend", "time", 0, -1, 1, 0.01),
  param(PARAM_B_AMOUNT, "b_amount", "b amt", 1, 0, 1, 0.01),
  param(PARAM_B_START, "b_start", "b start", 0, B_START_MIN, B_START_MAX, 1),
] satisfies ParamDefinition[];

export const stepsDefinition: ModuleDefinition = {
  kind: MODULE_KINDS.steps,
  slug: "steps",
  name: "STEPS",
  accent: "#6da595",
  rackWidth: "full",
  rackUnits: 3,
  width: 980,
  minHeight: 522,
  inputs: [],
  outputs: voiceOutputs(),
  params,
  Component: StepsModule,
};

function StepsModule(props: ModuleRenderProps) {
  const { module, onParamChange, onModuleParamsChange } = props;
  const [showLabels, setShowLabels] = useState(true);
  const sequenceSteps = sequenceStepsValue(module);
  const direction = directionValue(module);
  const low = rangeLowValue(module);
  const high = rangeHighValue(module, low);
  const stageStepValues = stageIndexes.map((stage) =>
    stageStepsValue(module, stage),
  );
  const skipValues = stageIndexes.map((stage) => skipValue(module, stage));
  const availableNotes = noteOptions.filter(
    (note) => note >= low && note <= high,
  );
  const scaleRoot = scaleRootValue(module);
  const scalePreset = scalePresetValue(module);
  const scaleMask = scaleMaskValues(module);
  const chordInversion = chordInversionValue(module);
  const pitchBend = pitchBendValue(module);
  const bendRange = bendRangeValue(module);
  const quantizeBend = quantizeBendValue(module);
  const velocity = velocityValue(module);
  const noteLength = noteLengthValue(module);
  const timeBend = timeBendValue(module);
  const bAmount = bAmountValue(module);
  const bStart = bStartValue(module);

  function setSequenceSteps(value: number) {
    onParamChange(
      module.id,
      PARAM_SEQUENCE_STEPS,
      clampInteger(value, SEQUENCE_STEPS_MIN, SEQUENCE_STEPS_MAX),
    );
  }

  function setRangeLow(value: number) {
    const nextLow = clampInteger(value, NOTE_MIN, high - 1);
    const updates: Record<number, number> = { [PARAM_RANGE_LOW]: nextLow };
    for (const stage of stageIndexes) {
      const note = noteValue(module, stage);
      if (note < nextLow) {
        updates[noteParamId(stage)] = nextLow;
      }
    }
    onModuleParamsChange(module.id, updates);
  }

  function setRangeHigh(value: number) {
    const nextHigh = clampInteger(value, low + 1, NOTE_MAX);
    const updates: Record<number, number> = { [PARAM_RANGE_HIGH]: nextHigh };
    for (const stage of stageIndexes) {
      const note = noteValue(module, stage);
      if (note > nextHigh) {
        updates[noteParamId(stage)] = nextHigh;
      }
    }
    onModuleParamsChange(module.id, updates);
  }

  function setStageNote(stage: number, value: number) {
    onParamChange(module.id, noteParamId(stage), clampInteger(value, low, high));
  }

  function setStageSteps(stage: number, value: number) {
    onParamChange(
      module.id,
      stageStepsParamId(stage),
      clampInteger(value, STAGE_STEPS_MIN, STAGE_STEPS_MAX),
    );
  }

  function setStageTrigs(stage: number, value: number) {
    onParamChange(
      module.id,
      trigParamId(stage),
      clampInteger(value, TRIG_MIN, TRIG_MAX),
    );
  }

  function toggleLock(stage: number) {
    onParamChange(module.id, lockParamId(stage), lockValue(module, stage) ? 0 : 1);
  }

  function toggleSkip(stage: number) {
    onParamChange(module.id, skipParamId(stage), skipValue(module, stage) ? 0 : 1);
  }

  function setScalePreset(value: number) {
    const presetIndex = clampInteger(value, 0, scalePresets.length - 1);
    const preset = scalePresets[presetIndex];
    const updates: Record<number, number> = { [PARAM_SCALE_PRESET]: presetIndex };
    preset.mask.forEach((enabled, note) => {
      updates[scaleMaskParamId(note)] = enabled;
    });
    onModuleParamsChange(module.id, updates);
  }

  function toggleScaleNote(note: number) {
    if (scaleMask[note] && scaleMask.filter(Boolean).length <= 1) {
      return;
    }
    onParamChange(module.id, scaleMaskParamId(note), scaleMask[note] ? 0 : 1);
  }

  function randomizeStages() {
    const updates: Record<number, number> = {};
    let activeStages = 0;

    for (const stage of stageIndexes) {
      const skipped = Math.random() < 0.14 ? 1 : 0;
      activeStages += skipped ? 0 : 1;
      updates[noteParamId(stage)] = randomInteger(low, high);
      updates[chordParamId(stage)] = randomChordShape();
      updates[stageStepsParamId(stage)] =
        Math.random() < 0.76 ? 1 : randomInteger(2, 4);
      updates[trigParamId(stage)] =
        Math.random() < 0.72 ? 1 : randomInteger(2, 6);
      updates[skipParamId(stage)] = skipped;
    }

    if (activeStages === 0) {
      updates[skipParamId(randomInteger(0, STAGES - 1))] = 0;
    }

    onModuleParamsChange(module.id, updates);
  }

  return (
    <ModuleShell {...props}>
      <div
        className={["stepsPanel", showLabels ? "showLabels" : "hideLabels"]
          .filter(Boolean)
          .join(" ")}
        data-direction={direction}
        data-loop-steps={sequenceSteps}
        data-stage-skips={skipValues.map((skip) => (skip ? "1" : "0")).join(",")}
        data-stage-steps={stageStepValues.join(",")}
      >
        <div className="stepsTopBar">
          <button
            type="button"
            className={["stepsInfoButton", showLabels ? "isActive" : ""]
              .filter(Boolean)
              .join(" ")}
            aria-label={`${showLabels ? "Hide" : "Show"} STEPS labels`}
            aria-pressed={showLabels}
            onClick={() => setShowLabels((current) => !current)}
          >
            i
          </button>
          <div className="stepsDirection" role="group" aria-label="playback direction">
            {directionButtons.map((button) => (
              <button
                key={button.value}
                type="button"
                className={direction === button.value ? "isActive" : ""}
                aria-label={button.aria}
                aria-pressed={direction === button.value}
                onClick={() => onParamChange(module.id, PARAM_DIRECTION, button.value)}
              >
                {button.label}
              </button>
            ))}
          </div>
          <label className="stepsTopSelect">
            <span>Steps</span>
            <select
              value={sequenceSteps}
              onChange={(event) => setSequenceSteps(Number(event.target.value))}
            >
              {sequenceStepOptions.map((step) => (
                <option key={step} value={step}>
                  {step}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="stepsRandom" onClick={randomizeStages}>
            RND
          </button>
          <div className="stepsRange">
            <span>Range</span>
            <select
              aria-label="range low"
              value={low}
              onChange={(event) => setRangeLow(Number(event.target.value))}
            >
              {noteOptions.slice(0, -1).map((note) => (
                <option key={note} value={note}>
                  {noteLabel(note)}
                </option>
              ))}
            </select>
            <span>-</span>
            <select
              aria-label="range high"
              value={high}
              onChange={(event) => setRangeHigh(Number(event.target.value))}
            >
              {noteOptions.slice(1).map((note) => (
                <option key={note} value={note}>
                  {noteLabel(note)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          className="stepsMatrix"
          style={{ "--stage-count": STAGES } as CSSProperties}
        >
          <div className="stepsLabels" aria-hidden="true">
            <span>Lock</span>
            <span>Pitch</span>
            <span>Chord</span>
            <span>Steps</span>
            <span>Trigs</span>
            <span>Skip</span>
          </div>
          {stageIndexes.map((stage) => {
            const note = clampInteger(noteValue(module, stage), low, high);
            const chord = chordValue(module, stage);
            const locked = lockValue(module, stage);
            const skipped = skipValue(module, stage);
            return (
              <div
                key={stage}
                className={[
                  "stepsStage",
                  locked ? "isLocked" : "",
                  skipped ? "isSkipped" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                data-stage={stage}
              >
                <button
                  type="button"
                  className="stepsLock"
                  aria-label={`${locked ? "Unlock" : "Lock"} stage ${stage + 1}`}
                  aria-pressed={locked}
                  onClick={() => toggleLock(stage)}
                >
                  <span />
                </button>
                <label className="stepsPitch">
                  <span
                    className="stepsPitchFill"
                    style={{ height: `${pitchRatio(note, low, high) * 100}%` }}
                  />
                  <input
                    type="range"
                    min={low}
                    max={high}
                    step={1}
                    value={note}
                    aria-label={`stage ${stage + 1} pitch`}
                    onChange={(event) => setStageNote(stage, Number(event.target.value))}
                  />
                </label>
                <div className="stepsChordCell">
                  <select
                    aria-label={`stage ${stage + 1} root note`}
                    value={note}
                    onChange={(event) => setStageNote(stage, Number(event.target.value))}
                  >
                    {availableNotes.map((option) => (
                      <option key={option} value={option}>
                        {noteName(option)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label={`stage ${stage + 1} chord shape`}
                    value={chord}
                    onChange={(event) =>
                      onParamChange(module.id, chordParamId(stage), Number(event.target.value))
                    }
                  >
                    {chordShapes.map((shape, index) => (
                      <option key={shape.label} value={index}>
                        {shape.shortLabel}
                      </option>
                    ))}
                  </select>
                </div>
                <NumberStepper
                  label={`stage ${stage + 1} steps`}
                  value={stageStepsValue(module, stage)}
                  min={STAGE_STEPS_MIN}
                  max={STAGE_STEPS_MAX}
                  onChange={(value) => setStageSteps(stage, value)}
                />
                <NumberStepper
                  label={`stage ${stage + 1} trigs`}
                  value={trigValue(module, stage)}
                  min={TRIG_MIN}
                  max={TRIG_MAX}
                  onChange={(value) => setStageTrigs(stage, value)}
                />
                <button
                  type="button"
                  className="stepsSkip"
                  aria-label={`${skipped ? "Enable" : "Skip"} stage ${stage + 1}`}
                  aria-pressed={skipped}
                  onClick={() => toggleSkip(stage)}
                />
              </div>
            );
          })}
        </div>

        <div className="stepsLowerPanel">
          <section className="stepsQuantPanel" aria-label="quantizer">
            <div className="stepsPanelHeader">Quantiser</div>
            <div className="stepsScaleKeyboard" role="group" aria-label="scale notes">
              {scaleNoteIndexes.map((note) => {
                const active = scaleMask[note];
                return (
                  <button
                    key={note}
                    type="button"
                    className={active ? "isActive" : ""}
                    aria-label={`${active ? "Mute" : "Enable"} ${noteName(scaleRoot + note)}`}
                    aria-pressed={active}
                    onClick={() => toggleScaleNote(note)}
                  >
                    {noteName(scaleRoot + note)}
                  </button>
                );
              })}
            </div>
            <div className="stepsQuantControls">
              <label className="stepsMiniSelect">
                <span>Root</span>
                <select
                  value={scaleRoot}
                  onChange={(event) =>
                    onParamChange(
                      module.id,
                      PARAM_SCALE_ROOT,
                      Number(event.target.value),
                    )
                  }
                >
                  {scaleRootOptions.map((note) => (
                    <option key={note} value={note}>
                      {noteName(note)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stepsMiniSelect">
                <span>Scale</span>
                <select
                  value={scalePreset}
                  onChange={(event) => setScalePreset(Number(event.target.value))}
                >
                  {scalePresets.map((preset, index) => (
                    <option key={preset.label} value={index}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="stepsMiniStepper">
                <span>Inv</span>
                <NumberStepper
                  label="chord inversion"
                  value={chordInversion}
                  min={CHORD_INVERSION_MIN}
                  max={CHORD_INVERSION_MAX}
                  onChange={(value) =>
                    onParamChange(module.id, PARAM_CHORD_INVERSION, value)
                  }
                />
              </div>
              <MiniSlider
                label="Bend"
                value={pitchBend}
                min={PITCH_BEND_MIN}
                max={PITCH_BEND_MAX}
                step={0.01}
                display={formatSignedPercent}
                onChange={(value) =>
                  onParamChange(module.id, PARAM_PITCH_BEND, value)
                }
              />
              <label className="stepsMiniSelect">
                <span>Range</span>
                <select
                  value={bendRange}
                  onChange={(event) =>
                    onParamChange(
                      module.id,
                      PARAM_BEND_RANGE,
                      Number(event.target.value),
                    )
                  }
                >
                  {bendRangeOptions.map((range) => (
                    <option key={range} value={range}>
                      {range}st
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={["stepsQuantizeButton", quantizeBend ? "isActive" : ""]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`${quantizeBend ? "Disable" : "Enable"} pitch bend quantize`}
                aria-pressed={quantizeBend}
                onClick={() =>
                  onParamChange(
                    module.id,
                    PARAM_QUANTIZE_BEND,
                    quantizeBend ? 0 : 1,
                  )
                }
              >
                Quant
              </button>
            </div>
          </section>

          <section className="stepsSeqModsPanel" aria-label="seq mods">
            <div className="stepsPanelHeader">Seq Mods</div>
            <div className="stepsSeqModsGrid">
              <MiniSlider
                label="Vel"
                value={velocity}
                min={0}
                max={1}
                step={0.01}
                display={formatPercent}
                onChange={(value) =>
                  onParamChange(module.id, PARAM_VELOCITY, value)
                }
              />
              <MiniSlider
                label="Note Len"
                value={noteLength}
                min={0.04}
                max={1}
                step={0.01}
                display={formatPercent}
                onChange={(value) =>
                  onParamChange(module.id, PARAM_NOTE_LENGTH, value)
                }
              />
              <MiniSlider
                label="Time Bend"
                value={timeBend}
                min={-1}
                max={1}
                step={0.01}
                display={formatSignedPercent}
                onChange={(value) =>
                  onParamChange(module.id, PARAM_TIME_BEND, value)
                }
              />
              <MiniSlider
                label="B Amt"
                value={bAmount}
                min={0}
                max={1}
                step={0.01}
                display={formatPercent}
                onChange={(value) =>
                  onParamChange(module.id, PARAM_B_AMOUNT, value)
                }
              />
              <div className="stepsMiniStepper">
                <span>B Start</span>
                <NumberStepper
                  label="b start"
                  value={bStart}
                  min={B_START_MIN}
                  max={B_START_MAX}
                  onChange={(value) =>
                    onParamChange(module.id, PARAM_B_START, value)
                  }
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </ModuleShell>
  );
}

function NumberStepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="stepsNumberStepper">
      <button
        type="button"
        aria-label={`decrease ${label}`}
        onClick={() => onChange(value <= min ? max : value - 1)}
      >
        -
      </button>
      <output aria-label={label}>{value}</output>
      <button
        type="button"
        aria-label={`increase ${label}`}
        onClick={() => onChange(value >= max ? min : value + 1)}
      >
        +
      </button>
    </div>
  );
}

function MiniSlider({
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
    <label className="stepsMiniSlider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{display(value)}</output>
    </label>
  );
}

function voiceOutputs(): JackDefinition[] {
  return [
    ...Array.from({ length: VOICES }, (_, voice) => [
      {
        id: voice * 2,
        label: `${voice + 1} cv`,
        kind: "cv" as const,
        connectionGroup: `voice-${voice + 1}-out`,
        connectionGroupLabel: `${voice + 1}`,
        connectionGroupOrder: voice,
        connectionOrder: 0,
        connectionLabel: "CV",
      },
      {
        id: voice * 2 + 1,
        label: `${voice + 1} gate`,
        kind: "gate" as const,
        connectionGroup: `voice-${voice + 1}-out`,
        connectionGroupLabel: `${voice + 1}`,
        connectionGroupOrder: voice,
        connectionOrder: 1,
        connectionLabel: "GATE",
      },
    ]).flat(),
    { id: 8, label: "vel", kind: "cv" as const, connectionOrder: 90 },
    { id: 9, label: "b amt", kind: "cv" as const, connectionOrder: 91 },
    { id: 10, label: "b start", kind: "cv" as const, connectionOrder: 92 },
  ];
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

function noteParamId(stage: number) {
  return PARAM_NOTE_BASE + stage;
}

function chordParamId(stage: number) {
  return PARAM_CHORD_BASE + stage;
}

function stageStepsParamId(stage: number) {
  return PARAM_STAGE_STEPS_BASE + stage;
}

function trigParamId(stage: number) {
  return PARAM_TRIG_BASE + stage;
}

function skipParamId(stage: number) {
  return PARAM_SKIP_BASE + stage;
}

function lockParamId(stage: number) {
  return PARAM_LOCK_BASE + stage;
}

function scaleMaskParamId(note: number) {
  return PARAM_SCALE_MASK_BASE + note;
}

function sequenceStepsValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_SEQUENCE_STEPS] ?? 16,
    SEQUENCE_STEPS_MIN,
    SEQUENCE_STEPS_MAX,
  );
}

function directionValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_DIRECTION] ?? DIRECTION_FORWARD,
    DIRECTION_FORWARD,
    DIRECTION_RANDOM,
  );
}

function rangeLowValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_RANGE_LOW] ?? NOTE_MIN,
    NOTE_MIN,
    NOTE_MAX - 1,
  );
}

function rangeHighValue(module: ModuleRenderProps["module"], low: number) {
  return clampInteger(
    module.params[PARAM_RANGE_HIGH] ?? NOTE_MAX,
    low + 1,
    NOTE_MAX,
  );
}

function noteValue(module: ModuleRenderProps["module"], stage: number) {
  return module.params[noteParamId(stage)] ?? defaultNotes[stage] ?? NOTE_MIN;
}

function chordValue(module: ModuleRenderProps["module"], stage: number) {
  return clampInteger(
    module.params[chordParamId(stage)] ?? 0,
    0,
    chordShapes.length - 1,
  );
}

function stageStepsValue(module: ModuleRenderProps["module"], stage: number) {
  return clampInteger(
    module.params[stageStepsParamId(stage)] ?? 1,
    STAGE_STEPS_MIN,
    STAGE_STEPS_MAX,
  );
}

function trigValue(module: ModuleRenderProps["module"], stage: number) {
  return clampInteger(module.params[trigParamId(stage)] ?? 1, TRIG_MIN, TRIG_MAX);
}

function skipValue(module: ModuleRenderProps["module"], stage: number) {
  return (module.params[skipParamId(stage)] ?? 0) >= 0.5;
}

function lockValue(module: ModuleRenderProps["module"], stage: number) {
  return (module.params[lockParamId(stage)] ?? 0) >= 0.5;
}

function scaleRootValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_SCALE_ROOT] ?? 0,
    0,
    SCALE_NOTE_COUNT - 1,
  );
}

function scalePresetValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_SCALE_PRESET] ?? 0,
    0,
    scalePresets.length - 1,
  );
}

function scaleMaskValues(module: ModuleRenderProps["module"]) {
  return scaleNoteIndexes.map((note) => scaleMaskValue(module, note));
}

function scaleMaskValue(module: ModuleRenderProps["module"], note: number) {
  return (module.params[scaleMaskParamId(note)] ?? 1) >= 0.5;
}

function chordInversionValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_CHORD_INVERSION] ?? 0,
    CHORD_INVERSION_MIN,
    CHORD_INVERSION_MAX,
  );
}

function pitchBendValue(module: ModuleRenderProps["module"]) {
  return clampNumber(
    module.params[PARAM_PITCH_BEND] ?? 0,
    PITCH_BEND_MIN,
    PITCH_BEND_MAX,
  );
}

function bendRangeValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_BEND_RANGE] ?? 12,
    BEND_RANGE_MIN,
    BEND_RANGE_MAX,
  );
}

function quantizeBendValue(module: ModuleRenderProps["module"]) {
  return (module.params[PARAM_QUANTIZE_BEND] ?? 1) >= 0.5;
}

function velocityValue(module: ModuleRenderProps["module"]) {
  return clampNumber(module.params[PARAM_VELOCITY] ?? 0.8, 0, 1);
}

function noteLengthValue(module: ModuleRenderProps["module"]) {
  return clampNumber(module.params[PARAM_NOTE_LENGTH] ?? 0.72, 0.04, 1);
}

function timeBendValue(module: ModuleRenderProps["module"]) {
  return clampNumber(module.params[PARAM_TIME_BEND] ?? 0, -1, 1);
}

function bAmountValue(module: ModuleRenderProps["module"]) {
  return clampNumber(module.params[PARAM_B_AMOUNT] ?? 1, 0, 1);
}

function bStartValue(module: ModuleRenderProps["module"]) {
  return clampInteger(
    module.params[PARAM_B_START] ?? 0,
    B_START_MIN,
    B_START_MAX,
  );
}

function pitchRatio(note: number, low: number, high: number) {
  if (high <= low) {
    return 1;
  }
  return Math.max(0.08, (note - low) / (high - low));
}

function noteLabel(semitone: number) {
  return `${noteName(semitone)}${octaveForNote(semitone)}`;
}

function noteName(semitone: number) {
  return NOTE_NAMES[((semitone % 12) + 12) % 12];
}

function octaveForNote(semitone: number) {
  return Math.floor((semitone + 24) / 12);
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatSignedPercent(value: number) {
  const rounded = Math.round(value * 100);
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

function randomInteger(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChordShape() {
  if (Math.random() < 0.58) {
    return 0;
  }
  return randomInteger(1, chordShapes.length - 1);
}
