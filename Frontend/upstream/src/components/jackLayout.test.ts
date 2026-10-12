import { describe, expect, it } from "vitest";
import {
  connectionJackLayout,
  connectionJackBoxes,
  connectionJackRows,
} from "./jackLayout";
import type { JackDefinition } from "../modules/types";

describe("connection jack layout", () => {
  it("groups conventional left/right audio jacks into one stereo box", () => {
    const jacks: JackDefinition[] = [
      { id: 0, label: "left", kind: "audio" },
      { id: 1, label: "right", kind: "audio" },
      { id: 2, label: "env", kind: "cv" },
    ];

    const rows = connectionJackRows(jacks, "output", 360, 180);
    const boxes = connectionJackBoxes(jacks, "output", 360, 180);

    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.grouped).map((row) => row.displayLabel)).toEqual([
      "L",
      "R",
    ]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].label).toBe("main OUT");
  });

  it("uses the shared label for named stereo pairs", () => {
    const jacks: JackDefinition[] = [
      { id: 2, label: "wet l", kind: "audio", connectionOrder: 2 },
      { id: 3, label: "wet r", kind: "audio", connectionOrder: 3 },
    ];

    const rows = connectionJackRows(jacks, "output", 360, 180);
    const boxes = connectionJackBoxes(jacks, "output", 360, 180);

    expect(rows.map((row) => row.displayLabel)).toEqual(["L", "R"]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].label).toBe("wet OUT");
  });

  it("splits compact input and output sections side by side", () => {
    const inputs: JackDefinition[] = [
      { id: 0, label: "a", kind: "audio" },
      { id: 1, label: "b", kind: "audio" },
    ];
    const outputs: JackDefinition[] = [
      { id: 0, label: "a thru", kind: "audio" },
      { id: 1, label: "b thru", kind: "audio" },
    ];

    const layout = connectionJackLayout(inputs, outputs, 464, 102);

    expect(layout.sections).toHaveLength(2);
    expect(intersects(layout.sections[0], layout.sections[1])).toBe(false);
  });

  it("places normal-width input and output sections side by side when they fit", () => {
    const inputs: JackDefinition[] = [
      { id: 0, label: "pitch", kind: "cv" },
      { id: 1, label: "index", kind: "cv" },
      { id: 2, label: "level", kind: "cv" },
      { id: 3, label: "width", kind: "cv" },
      { id: 4, label: "gate", kind: "gate" },
    ];
    const outputs: JackDefinition[] = [
      { id: 0, label: "left", kind: "audio" },
      { id: 1, label: "right", kind: "audio" },
      { id: 2, label: "env", kind: "cv" },
      { id: 3, label: "gate", kind: "gate" },
    ];

    const layout = connectionJackLayout(inputs, outputs, 996, 370);
    const input = layout.sections.find((section) => section.direction === "input");
    const output = layout.sections.find((section) => section.direction === "output");

    expect(input).toBeDefined();
    expect(output).toBeDefined();
    expect(input && output ? output.left : 0).toBeGreaterThan(
      input ? input.left + input.width : 0,
    );
    expect(input?.top).toBe(output?.top);
    expect(
      new Set(
        layout.rows
          .filter((row) => row.direction === "input")
          .map((row) => row.top),
      ).size,
    ).toBe(1);
    expect(output?.height).toBeLessThan(120);
  });

  it("packs mixer-style stereo audio tracks into shared rows when they fit", () => {
    const inputs: JackDefinition[] = [
      ...Array.from({ length: 14 }, (_, index) => ({
        id: index,
        label: `${index + 1} left`,
        kind: "audio" as const,
        connectionOrder: 0,
        connectionGroup: `track-${index + 1}-in`,
        connectionGroupLabel: `${index + 1}`,
        connectionGroupOrder: index,
        connectionLabel: "L",
      })),
      ...Array.from({ length: 14 }, (_, index) => ({
        id: 24 + index,
        label: `${index + 1} right`,
        kind: "audio" as const,
        connectionOrder: 1,
        connectionGroup: `track-${index + 1}-in`,
        connectionGroupLabel: `${index + 1}`,
        connectionGroupOrder: index,
        connectionLabel: "R",
      })),
    ];

    const outputs = stereoGroup("output", 100, "main", "main", 0);

    const layout = connectionJackLayout(inputs, outputs, 990, 162, {
      directionChrome: false,
    });
    const input = layout.sections.find((section) => section.direction === "input");
    const output = layout.sections.find((section) => section.direction === "output");
    const audioRows = layout.rows.filter((row) => row.jack.kind === "audio");
    const inputBoxes = layout.boxes.filter((box) => box.direction === "input");

    expect(layout.sections).toHaveLength(2);
    expect(input?.label).toBe("IN");
    expect(output?.label).toBe("OUT");
    expect(audioRows).toHaveLength(30);
    expect(inputBoxes).toHaveLength(14);
    expect(inputBoxes[0].label).toBe("1 IN");
    expect(new Set(inputBoxes.map((box) => box.top)).size).toBe(1);
    expect(
      Math.max(...inputBoxes.map((box) => box.left + box.width)),
    ).toBeLessThanOrEqual(990);
    expect(output?.top).toBe(input?.top);
  });

  it("keeps dense input and output sections stacked when side by side would crowd", () => {
    const inputs = stereoTrackJacks("input");
    const outputs = [
      ...stereoGroup("output", 0, "main", "main", 0),
      ...Array.from({ length: 8 }, (_, index) =>
        stereoGroup("output", 2 + index * 2, `${index + 1}`, `${index + 1}`, index + 1),
      ).flat(),
    ];

    const layout = connectionJackLayout(inputs, outputs, 996, 370);
    const input = layout.sections.find((section) => section.direction === "input");
    const output = layout.sections.find((section) => section.direction === "output");

    expect(input).toBeDefined();
    expect(output).toBeDefined();
    expect(input && output ? output.top : 0).toBeGreaterThan(
      input ? input.top + input.height : 0,
    );
  });

  it("keeps short half-width fx bays from overlapping input and output groups", () => {
    const inputs: JackDefinition[] = [
      { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
      { id: 3, label: "right", kind: "audio", connectionOrder: 1 },
      { id: 1, label: "size", kind: "cv" },
      { id: 2, label: "freeze", kind: "gate" },
    ];
    const outputs: JackDefinition[] = [
      { id: 0, label: "left", kind: "audio", connectionOrder: 0 },
      { id: 2, label: "right", kind: "audio", connectionOrder: 1 },
      { id: 1, label: "wet l", kind: "audio", connectionOrder: 2 },
      { id: 3, label: "wet r", kind: "audio", connectionOrder: 3 },
    ];

    const layout = connectionJackLayout(inputs, outputs, 464, 162);
    const input = layout.sections.find((section) => section.direction === "input");
    const output = layout.sections.find((section) => section.direction === "output");

    expect(input).toBeDefined();
    expect(output).toBeDefined();
    expect(input && output ? intersects(input, output) : true).toBe(false);
    expect(Math.max(...layout.sections.map((section) => section.left + section.width))).toBeLessThanOrEqual(
      464,
    );
  });
});

function stereoTrackJacks(direction: "input" | "output") {
  return [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: index,
      label: `${index + 1} left`,
      kind: "audio" as const,
      connectionOrder: 0,
      connectionGroup: `track-${index + 1}-${direction}`,
      connectionGroupLabel: `${index + 1}`,
      connectionGroupOrder: index,
      connectionLabel: "L",
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      id: 8 + index,
      label: `${index + 1} right`,
      kind: "audio" as const,
      connectionOrder: 1,
      connectionGroup: `track-${index + 1}-${direction}`,
      connectionGroupLabel: `${index + 1}`,
      connectionGroupOrder: index,
      connectionLabel: "R",
    })),
  ];
}

function stereoGroup(
  direction: "input" | "output",
  id: number,
  group: string,
  label: string,
  order: number,
) {
  return [
    {
      id,
      label: `${label} left`,
      kind: "audio" as const,
      connectionOrder: 0,
      connectionGroup: `${group}-${direction}`,
      connectionGroupLabel: label,
      connectionGroupOrder: order,
      connectionLabel: "L",
    },
    {
      id: id + 1,
      label: `${label} right`,
      kind: "audio" as const,
      connectionOrder: 1,
      connectionGroup: `${group}-${direction}`,
      connectionGroupLabel: label,
      connectionGroupOrder: order,
      connectionLabel: "R",
    },
  ];
}

function intersects(
  a: { left: number; top: number; width: number; height: number },
  b: { left: number; top: number; width: number; height: number },
) {
  return !(
    a.left + a.width <= b.left ||
    b.left + b.width <= a.left ||
    a.top + a.height <= b.top ||
    b.top + b.height <= a.top
  );
}
