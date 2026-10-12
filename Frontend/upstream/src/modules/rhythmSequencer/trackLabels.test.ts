import { describe, expect, it } from "vitest";
import { hitsDefinition } from "../hits/HitsModule";
import { rhythmSequencerDefinition } from "./RhythmSequencerModule";
import { rhythmTrackLabelsForConnections } from "./trackLabels";
import type { PatchCable, RackModuleState } from "../types";

describe("RHY16 track labels", () => {
  it("uses connected drum gate input names for track labels", () => {
    const rhythm = moduleState(1, rhythmSequencerDefinition.kind);
    const hits = moduleState(2, hitsDefinition.kind);
    const labels = rhythmTrackLabelsForConnections({
      module: rhythm,
      definition: rhythmSequencerDefinition,
      rackModules: [rhythm, hits],
      patchCables: [
        cable(1, 0, 2, 0),
        cable(1, 1, 2, 1),
        cable(1, 2, 2, 2),
      ],
      definitionsByKind: new Map([
        [rhythmSequencerDefinition.kind, rhythmSequencerDefinition],
        [hitsDefinition.kind, hitsDefinition],
      ]),
      fallbackLabels: ["1", "2", "3", "4"],
    });

    expect(labels).toEqual(["BD", "SD", "CLP", "4"]);
  });

  it("keeps numeric labels for generic gate destinations", () => {
    const rhythm = moduleState(1, rhythmSequencerDefinition.kind);
    const genericDefinition = {
      ...hitsDefinition,
      kind: 10_001,
      inputs: [{ id: 0, label: "gate", kind: "gate" as const }],
    };
    const generic = moduleState(2, genericDefinition.kind);

    const labels = rhythmTrackLabelsForConnections({
      module: rhythm,
      definition: rhythmSequencerDefinition,
      rackModules: [rhythm, generic],
      patchCables: [cable(1, 0, 2, 0)],
      definitionsByKind: new Map([
        [rhythmSequencerDefinition.kind, rhythmSequencerDefinition],
        [genericDefinition.kind, genericDefinition],
      ]),
      fallbackLabels: ["1"],
    });

    expect(labels).toEqual(["1"]);
  });
});

function moduleState(id: number, kind: number): RackModuleState {
  return {
    id,
    kind,
    x: 0,
    y: 0,
    params: {},
  };
}

function cable(
  fromModuleId: number,
  fromJackId: number,
  toModuleId: number,
  toJackId: number,
): PatchCable {
  return {
    id: `${fromModuleId}-${fromJackId}-${toModuleId}-${toJackId}`,
    from: {
      moduleId: fromModuleId,
      jackId: fromJackId,
      direction: "output",
      kind: "gate",
    },
    to: {
      moduleId: toModuleId,
      jackId: toJackId,
      direction: "input",
      kind: "gate",
    },
  };
}
