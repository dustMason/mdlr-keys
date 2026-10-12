import type { ParamDefinition } from "./types";

export const BYPASS_PARAM_ID = 999;

export const bypassParam = {
  id: BYPASS_PARAM_ID,
  key: "bypass",
  label: "bypass",
  min: 0,
  max: 1,
  step: 1,
  defaultValue: 0,
} satisfies ParamDefinition;

export function withBypass(params: ParamDefinition[]) {
  return [...params, bypassParam] satisfies ParamDefinition[];
}
