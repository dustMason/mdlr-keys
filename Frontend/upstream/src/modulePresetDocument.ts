import type {
  ModuleDefinition,
  ModulePresetPayload,
  RackModuleState,
} from "./modules/types";

export function modulePresetPayloadFor(
  module: RackModuleState,
  definition: ModuleDefinition,
): ModulePresetPayload {
  return {
    version: 1,
    moduleKind: definition.kind,
    moduleSlug: definition.slug,
    params: paramsForPreset(module.params, definition),
  };
}

export function paramsFromModulePresetPayload(
  payload: ModulePresetPayload,
  definition: ModuleDefinition,
  currentParams: RackModuleState["params"],
) {
  const validPayload = assertValidModulePresetPayload(payload, definition);
  return {
    ...currentParams,
    ...paramsForPreset(validPayload.params, definition),
  };
}

export function assertValidModulePresetPayload(
  payload: ModulePresetPayload,
  definition: ModuleDefinition,
): ModulePresetPayload {
  if (!isObject(payload)) {
    throw new Error("Module preset payload must be an object.");
  }
  if (payload.version !== 1) {
    throw new Error("Unsupported module preset version.");
  }
  if (payload.moduleKind !== definition.kind || payload.moduleSlug !== definition.slug) {
    throw new Error(`Preset is for ${payload.moduleSlug}, not ${definition.slug}.`);
  }
  if (!isObject(payload.params)) {
    throw new Error("Module preset params must be an object.");
  }
  return payload;
}

function paramsForPreset(
  params: Record<number, number> | Record<string, number>,
  definition: ModuleDefinition,
) {
  const next: Record<string, number> = {};
  const source = params as Record<string, number | undefined>;
  for (const parameter of definition.params) {
    const rawValue = source[String(parameter.id)];
    next[String(parameter.id)] = coerceParamValue(rawValue, parameter);
  }
  return next;
}

function coerceParamValue(
  value: number | undefined,
  parameter: ModuleDefinition["params"][number],
) {
  const fallback = parameter.defaultValue;
  const finiteValue = Number.isFinite(value) ? Number(value) : fallback;
  const stepped =
    parameter.step > 0
      ? Math.round((finiteValue - parameter.min) / parameter.step) * parameter.step +
        parameter.min
      : finiteValue;
  const clamped = Math.min(parameter.max, Math.max(parameter.min, stepped));
  return Number(clamped.toFixed(6));
}

function isObject(value: unknown): value is Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
