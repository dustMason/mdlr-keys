import type { ModuleDefinition, RackModuleState } from "../modules/types";

export const RACK_COLUMNS = 2;
export const RACK_PADDING = 0;
export const RACK_COLUMN_WIDTH = 520;
export const RACK_COLUMN_GAP = 6;
export const RACK_UNIT_HEIGHT = 206;
export const RACK_UNIT_GAP = 2;
export const RACK_FLANGE_WIDTH = 28;
export const RACK_MODULE_HEADER_HEIGHT = 44;
export const RACK_FULL_WIDTH = RACK_COLUMN_WIDTH * 2 + RACK_COLUMN_GAP;
export const RACK_ROW_PITCH = RACK_UNIT_HEIGHT + RACK_UNIT_GAP;
export const RACK_SYSTEM_ROWS = 0.5;
export const RACK_COLLAPSED_MODULE_HEIGHT = RACK_MODULE_HEADER_HEIGHT;
export const RACK_COLLAPSED_ROWS =
  (RACK_COLLAPSED_MODULE_HEIGHT + RACK_UNIT_GAP) / RACK_ROW_PITCH;
export const RACK_SYSTEM_MODULE_HEIGHT =
  Math.floor(RACK_ROW_PITCH * RACK_SYSTEM_ROWS) - RACK_UNIT_GAP;

export type RackModuleWidth = "full" | "half";
export type RackModuleUnits = 1 | 2 | 3 | 4;

export function rackModuleWidthMode(definition: ModuleDefinition): RackModuleWidth {
  return definition.rackWidth;
}

export function rackModuleUnits(definition: ModuleDefinition): RackModuleUnits {
  return definition.rackUnits;
}

export function rackModulePixelWidth(definition: ModuleDefinition) {
  return rackModuleWidthMode(definition) === "half" ? RACK_COLUMN_WIDTH : RACK_FULL_WIDTH;
}

export function rackModulePixelHeight(definition: ModuleDefinition) {
  const units = rackModuleUnits(definition);
  return units * RACK_UNIT_HEIGHT + (units - 1) * RACK_UNIT_GAP;
}

export function rackModuleGridSpan(
  module: RackModuleState,
  definition: ModuleDefinition,
) {
  if (module.fixed) {
    return RACK_SYSTEM_ROWS;
  }
  return rackModuleUnits(definition);
}

export function rackModuleDisplayGridSpan(
  module: RackModuleState,
  definition: ModuleDefinition,
) {
  if (module.fixed) {
    return RACK_SYSTEM_ROWS;
  }
  return module.collapsed ? RACK_COLLAPSED_ROWS : rackModuleUnits(definition);
}

export function rackModulePixelHeightForState(
  module: RackModuleState,
  definition: ModuleDefinition,
) {
  if (module.fixed) {
    return RACK_SYSTEM_MODULE_HEIGHT;
  }
  return module.collapsed
    ? RACK_COLLAPSED_MODULE_HEIGHT
    : rackModulePixelHeight(definition);
}

export function rackModulePixelPosition(module: RackModuleState) {
  return {
    x: RACK_PADDING + Math.max(0, Math.min(1, module.x)) * (RACK_COLUMN_WIDTH + RACK_COLUMN_GAP),
    y: RACK_PADDING + Math.max(0, module.y) * RACK_ROW_PITCH,
  };
}

export function rackCanvasSize(
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
) {
  const bottom = modules.reduce((max, module) => {
    const definition = definitions.get(module.kind);
    if (!definition) {
      return max;
    }
    return Math.max(
      max,
      module.y + rackModuleDisplayGridSpan(module, definition),
    );
  }, 0);

  return {
    width: RACK_FULL_WIDTH + RACK_PADDING * 2,
    height: Math.max(660, RACK_PADDING * 2 + bottom * RACK_ROW_PITCH),
  };
}

export function normalizeRackLayout(
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
  startRow = 0,
) {
  return normalizeRackLayoutWithSpan(
    modules,
    definitions,
    startRow,
    rackModuleGridSpan,
  );
}

export function layoutRackModulesForDisplay(
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
  startRow = 0,
) {
  return normalizeRackLayoutWithSpan(
    modules,
    definitions,
    startRow,
    rackModuleDisplayGridSpan,
  );
}

function normalizeRackLayoutWithSpan(
  modules: RackModuleState[],
  definitions: Map<number, ModuleDefinition>,
  startRow: number,
  gridSpan: (module: RackModuleState, definition: ModuleDefinition) => number,
) {
  let cursorRow = startRow;
  let openHalfRow: number | null = null;
  let openHalfColumn = 0;
  let openHalfSpan = 0;

  return modules.map((module) => {
    const definition = definitions.get(module.kind);
    if (!definition) {
      return module;
    }

    if (rackModuleWidthMode(definition) === "half") {
      const moduleSpan = gridSpan(module, definition);
      if (openHalfRow === null) {
        openHalfRow = cursorRow;
        openHalfColumn = 0;
        openHalfSpan = moduleSpan;
        return { ...module, x: 0, y: openHalfRow };
      }

      const placed = { ...module, x: openHalfColumn + 1, y: openHalfRow };
      openHalfRow = null;
      openHalfColumn = 0;
      cursorRow += Math.max(openHalfSpan, moduleSpan);
      openHalfSpan = 0;
      return placed;
    }

    if (openHalfRow !== null) {
      cursorRow = openHalfRow + openHalfSpan;
      openHalfRow = null;
      openHalfColumn = 0;
      openHalfSpan = 0;
    }

    const placed = { ...module, x: 0, y: cursorRow };
    cursorRow += gridSpan(module, definition);
    return placed;
  });
}

export function reorderModulesForRackPoint(
  modules: RackModuleState[],
  moduleId: number,
  point: { x: number; y: number },
  definitions: Map<number, ModuleDefinition>,
  startRow = 0,
) {
  const moving = modules.find((module) => module.id === moduleId);
  if (!moving) {
    return modules;
  }
  const movingDefinition = definitions.get(moving.kind);
  if (!movingDefinition) {
    return modules;
  }

  const withoutMoving = modules.filter((module) => module.id !== moduleId);
  const displayWithoutMoving = layoutRackModulesForDisplay(
    withoutMoving,
    definitions,
    startRow,
  );
  const targetRow = Math.max(startRow, (point.y - RACK_PADDING) / RACK_ROW_PITCH);
  const targetColumn =
    rackModuleWidthMode(movingDefinition) === "half" &&
    point.x > RACK_PADDING + RACK_COLUMN_WIDTH
      ? 1
      : 0;
  const targetOrder = targetRow * RACK_COLUMNS + targetColumn;
  const index = displayWithoutMoving.findIndex(
    (module) =>
      module.y * RACK_COLUMNS + Math.max(0, Math.min(1, module.x)) >= targetOrder,
  );
  const next = [...withoutMoving];
  next.splice(index === -1 ? next.length : index, 0, moving);
  return normalizeRackLayout(next, definitions, startRow);
}
