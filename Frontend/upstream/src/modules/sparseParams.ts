import { MODULE_KINDS } from "./kinds";

const RHYTHM_LANES = 11;
const RHYTHM_MAX_STEPS = 64;
const RHYTHM_LEGACY_STEPS = 16;
const RHYTHM_PATTERNS = 8;
const RHYTHM_LEGACY_PATTERN_STRIDE = RHYTHM_LANES * RHYTHM_LEGACY_STEPS;
const RHYTHM_ACTIVE_PATTERN_PARAM =
  RHYTHM_PATTERNS * RHYTHM_LEGACY_PATTERN_STRIDE;
const RHYTHM_METER_PARAM = RHYTHM_ACTIVE_PATTERN_PARAM + 1;
const RHYTHM_MUTE_BASE_PARAM = RHYTHM_METER_PARAM + 1;
const RHYTHM_SHUFFLE_PARAM = RHYTHM_MUTE_BASE_PARAM + RHYTHM_LANES;
const RHYTHM_PATTERN_LENGTH_PARAM = RHYTHM_SHUFFLE_PARAM + 1;
const RHYTHM_EXTENDED_STEP_BASE = RHYTHM_PATTERN_LENGTH_PARAM + 1;
const RHYTHM_EXTENDED_STEP_STRIDE =
  RHYTHM_LANES * (RHYTHM_MAX_STEPS - RHYTHM_LEGACY_STEPS);

export function compactSparseParamsForKind(
  kind: number,
  params: Record<number, number>,
) {
  return Object.fromEntries(
    Object.entries(params).filter(([paramId, value]) => {
      const defaultValue = sparseDefaultParamValue(kind, Number(paramId));
      return defaultValue === undefined || !Object.is(value, defaultValue);
    }),
  ) as Record<number, number>;
}

export function sparseDefaultParamValue(kind: number, paramId: number) {
  if (kind !== MODULE_KINDS.rhythmSequencer) {
    return undefined;
  }
  return rhythmDefaultParamValue(paramId);
}

function rhythmDefaultParamValue(paramId: number) {
  if (rhythmStepSlotForParam(paramId)) {
    return 0;
  }
  if (
    paramId === RHYTHM_ACTIVE_PATTERN_PARAM ||
    paramId === RHYTHM_METER_PARAM ||
    paramId === RHYTHM_SHUFFLE_PARAM ||
    paramId === RHYTHM_PATTERN_LENGTH_PARAM ||
    (paramId >= RHYTHM_MUTE_BASE_PARAM &&
      paramId < RHYTHM_MUTE_BASE_PARAM + RHYTHM_LANES)
  ) {
    return 0;
  }
  return undefined;
}

function rhythmStepSlotForParam(paramId: number) {
  if (!Number.isInteger(paramId) || paramId < 0) {
    return null;
  }
  if (paramId < RHYTHM_ACTIVE_PATTERN_PARAM) {
    const pattern = Math.floor(paramId / RHYTHM_LEGACY_PATTERN_STRIDE);
    const slot = paramId % RHYTHM_LEGACY_PATTERN_STRIDE;
    const track = Math.floor(slot / RHYTHM_LEGACY_STEPS);
    const step = slot % RHYTHM_LEGACY_STEPS;
    return pattern < RHYTHM_PATTERNS && track < RHYTHM_LANES
      ? { pattern, track, step }
      : null;
  }
  if (paramId < RHYTHM_EXTENDED_STEP_BASE) {
    return null;
  }
  const offset = paramId - RHYTHM_EXTENDED_STEP_BASE;
  const pattern = Math.floor(offset / RHYTHM_EXTENDED_STEP_STRIDE);
  if (pattern >= RHYTHM_PATTERNS) {
    return null;
  }
  const slot = offset % RHYTHM_EXTENDED_STEP_STRIDE;
  const track = Math.floor(slot / (RHYTHM_MAX_STEPS - RHYTHM_LEGACY_STEPS));
  const step =
    RHYTHM_LEGACY_STEPS +
    (slot % (RHYTHM_MAX_STEPS - RHYTHM_LEGACY_STEPS));
  return track < RHYTHM_LANES && step < RHYTHM_MAX_STEPS
    ? { pattern, track, step }
    : null;
}
