import { describe, expect, it } from "vitest";
import { cablePath, endpointPosition } from "./CableLayer";
import { RACK_MODULE_HEADER_HEIGHT } from "./rackLayout";
import type { ModuleDefinition, RackModuleState } from "../modules/types";

describe("cable path", () => {
  it("keeps aligned jacks straight instead of bending them sideways", () => {
    expect(cablePath({ x: 100, y: 80 }, { x: 100, y: 640 })).toBe(
      "M 100 80 L 100 640",
    );
  });

  it("uses centered control points for narrow parabolic cables", () => {
    const path = cablePath({ x: 100, y: 80 }, { x: 132, y: 640 });

    expect(path).toMatch(/^M 100 80 Q 116 /);
  });

  it("tightens cables connected to collapsed patch slots", () => {
    const loosePath = cablePath({ x: 100, y: 80 }, { x: 132, y: 640 });
    const tightPath = cablePath(
      { x: 100, y: 80, collapsedSlot: true },
      { x: 132, y: 640 },
    );

    expect(controlY(tightPath)).toBeLessThan(controlY(loosePath));
    expect(controlY(tightPath)).toBeLessThan(1_040);
  });

  it("routes collapsed module endpoints to the patch slot", () => {
    const definition = testDefinition();
    const module: RackModuleState = {
      id: 10,
      kind: definition.kind,
      x: 0,
      y: 0,
      collapsed: true,
      params: {},
    };

    const position = endpointPosition(
      {
        moduleId: module.id,
        jackId: 1,
        direction: "input",
        kind: "audio",
      },
      [module],
      new Map([[definition.kind, definition]]),
    );

    expect(position).toMatchObject({
      collapsedSlot: true,
      y: RACK_MODULE_HEADER_HEIGHT - 9,
    });
    expect(position?.x).toBeGreaterThan(70);
  });
});

const TestModule: ModuleDefinition["Component"] = () => null;

function testDefinition(): ModuleDefinition {
  return {
    kind: 999,
    slug: "test",
    name: "TEST",
    accent: "#ffffff",
    rackWidth: "full",
    rackUnits: 1,
    inputs: [
      { id: 0, label: "left", kind: "audio" },
      { id: 1, label: "right", kind: "audio" },
    ],
    outputs: [{ id: 0, label: "out", kind: "audio" }],
    params: [],
    Component: TestModule,
  };
}

function controlY(path: string) {
  const match = path.match(/^M [\d.-]+ [\d.-]+ Q [\d.-]+ ([\d.-]+),/);
  if (!match) {
    throw new Error(`Path did not contain a quadratic control point: ${path}`);
  }
  return Number(match[1]);
}
