import { MODULE_KINDS } from "./modules/kinds";
import type { RackModuleState } from "./modules/types";

export const MASTER_OUTPUT_VOLUME_PARAM_ID = 0;

export function stripSessionLocalSystemState(
  modules: RackModuleState[],
): RackModuleState[] {
  return modules.map(stripSessionLocalModuleState);
}

export function stripSessionLocalSystemModulesById(
  modulesById: Record<string, RackModuleState>,
) {
  return Object.fromEntries(
    Object.entries(modulesById).map(([id, module]) => [
      id,
      stripSessionLocalModuleState(module),
    ]),
  );
}

export function preserveSessionLocalModuleState(
  module: RackModuleState,
  localModule: RackModuleState | undefined,
): RackModuleState {
  if (!localModule) {
    return module;
  }

  const preserved: RackModuleState = { ...module };
  if (localModule.collapsed !== undefined) {
    preserved.collapsed = localModule.collapsed;
  }

  if (module.kind !== MODULE_KINDS.output) {
    return preserved;
  }

  const localVolume = localModule.params[MASTER_OUTPUT_VOLUME_PARAM_ID];
  if (localVolume === undefined) {
    return preserved;
  }

  return {
    ...preserved,
    params: {
      ...preserved.params,
      [MASTER_OUTPUT_VOLUME_PARAM_ID]: localVolume,
    },
  };
}

function stripSessionLocalModuleState(module: RackModuleState): RackModuleState {
  const stripped: RackModuleState = { ...module };
  delete stripped.collapsed;

  if (module.kind !== MODULE_KINDS.output) {
    return stripped;
  }

  const params = { ...module.params };
  delete params[MASTER_OUTPUT_VOLUME_PARAM_ID];
  return {
    ...stripped,
    params,
  };
}
