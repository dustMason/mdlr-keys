import { MODULE_KINDS } from "./modules/kinds";
import { defaultParams, definitionForKind } from "./modules/registry";
import type { RackModuleState } from "./modules/types";
import { RACK_SYSTEM_ROWS } from "./components/rackLayout";

export const SYSTEM_RACK_ROWS = RACK_SYSTEM_ROWS;
export const SYSTEM_OUTPUT_MODULE_ID = 900_001;
export const SYSTEM_SCOPE_MODULE_ID = 900_002;

const SYSTEM_MODULE_KINDS = new Set<number>([
  MODULE_KINDS.output,
  MODULE_KINDS.scope,
]);

export function createSystemRackModules(): RackModuleState[] {
  return [
    systemModule(SYSTEM_OUTPUT_MODULE_ID, MODULE_KINDS.output, 0, "master"),
    systemModule(SYSTEM_SCOPE_MODULE_ID, MODULE_KINDS.scope, 1, "monitor"),
  ];
}

export function isSystemModuleId(moduleId: number) {
  return (
    moduleId === SYSTEM_OUTPUT_MODULE_ID || moduleId === SYSTEM_SCOPE_MODULE_ID
  );
}

export function isSystemModuleKind(kind: number) {
  return SYSTEM_MODULE_KINDS.has(kind);
}

function systemModule(
  id: number,
  kind: number,
  x: number,
  label: string,
): RackModuleState {
  const definition = definitionForKind(kind);
  return {
    id,
    kind,
    x,
    y: 0,
    fixed: true,
    label,
    params: defaultParams(definition),
  };
}
