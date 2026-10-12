import { describe, expect, it } from "vitest";
import {
  layoutRackModulesForDisplay,
  normalizeRackLayout,
  RACK_ROW_PITCH,
  reorderModulesForRackPoint,
} from "./rackLayout";
import type { ModuleDefinition, RackModuleState } from "../modules/types";

describe("rack layout", () => {
  it("does not let collapsed state change module y positions", () => {
    const definitions = new Map<number, ModuleDefinition>([
      [1, testDefinition(1, "FULL", "full", 2)],
      [2, testDefinition(2, "HALF", "half", 1)],
    ]);
    const modules: RackModuleState[] = [
      { id: 1, kind: 1, x: 0, y: 0, params: {} },
      { id: 2, kind: 2, x: 0, y: 0, params: {} },
      { id: 3, kind: 2, x: 0, y: 0, params: {} },
      { id: 4, kind: 1, x: 0, y: 0, params: {} },
    ];

    const expanded = normalizeRackLayout(modules, definitions, 0);
    const collapsed = normalizeRackLayout(
      modules.map((module) =>
        module.id === 1 || module.id === 3
          ? { ...module, collapsed: true }
          : module,
      ),
      definitions,
      0,
    );

    expect(collapsed.map(({ id, x, y }) => ({ id, x, y }))).toEqual(
      expanded.map(({ id, x, y }) => ({ id, x, y })),
    );
  });

  it("compacts collapsed modules in the display layout only", () => {
    const definitions = new Map<number, ModuleDefinition>([
      [1, testDefinition(1, "FULL", "full", 2)],
    ]);
    const modules: RackModuleState[] = [
      { id: 1, kind: 1, x: 0, y: 0, collapsed: true, params: {} },
      { id: 2, kind: 1, x: 0, y: 0, params: {} },
    ];

    const canonical = normalizeRackLayout(modules, definitions, 0);
    const display = layoutRackModulesForDisplay(canonical, definitions, 0);

    expect(canonical[1].y).toBe(2);
    expect(display[1].y).toBeLessThan(canonical[1].y);
    expect(canonical[0].y).toBe(0);
  });

  it("uses compacted display positions when reordering modules", () => {
    const definitions = new Map<number, ModuleDefinition>([
      [1, testDefinition(1, "TALL", "full", 4)],
      [2, testDefinition(2, "SHORT", "full", 1)],
    ]);
    const modules = normalizeRackLayout(
      [
        { id: 1, kind: 1, x: 0, y: 0, collapsed: true, params: {} },
        { id: 3, kind: 2, x: 0, y: 0, params: {} },
        { id: 2, kind: 2, x: 0, y: 0, params: {} },
      ],
      definitions,
      0,
    );

    const reordered = reorderModulesForRackPoint(
      modules,
      3,
      { x: 0, y: RACK_ROW_PITCH * 1.1 },
      definitions,
      0,
    );

    expect(reordered.map((module) => module.id)).toEqual([1, 2, 3]);
  });
});

const TestModule: ModuleDefinition["Component"] = () => null;

function testDefinition(
  kind: number,
  name: string,
  rackWidth: ModuleDefinition["rackWidth"],
  rackUnits: ModuleDefinition["rackUnits"],
): ModuleDefinition {
  return {
    kind,
    slug: name.toLowerCase(),
    name,
    accent: "#ffffff",
    rackWidth,
    rackUnits,
    inputs: [],
    outputs: [],
    params: [],
    Component: TestModule,
  };
}
