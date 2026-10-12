import { describe, expect, it } from "vitest";
import { MODULE_KINDS } from "./modules/kinds";
import { rhythmSequencerDefinition } from "./modules/rhythmSequencer/RhythmSequencerModule";
import { compactSparseParamsForKind } from "./modules/sparseParams";
import type {
  ModuleSampleState,
  PatchCable,
  RackModuleState,
} from "./modules/types";
import { applySessionPatch, sessionPartsToDocument } from "./sessionDocument";
import {
  appendSessionMutation,
  applySessionMutations,
  rebaseableSessionMutationsToPatch,
  removeAppliedSessionMutations,
  sessionMutationsToPatch,
  type SessionMutation,
} from "./sessionMutations";

const OUT: RackModuleState = {
  id: 10000,
  kind: MODULE_KINDS.output,
  x: 0,
  y: 0,
  fixed: true,
  params: {},
};

const MODULE_A: RackModuleState = {
  id: 1,
  kind: 10,
  x: 0,
  y: 0,
  label: "Bass",
  params: { 0: 0.25, 1: 0.5 },
};

const MODULE_B: RackModuleState = {
  id: 2,
  kind: 20,
  x: 0,
  y: 0,
  params: { 0: 0.75 },
};

const MODULE_C: RackModuleState = {
  id: 3,
  kind: 30,
  x: 0,
  y: 0,
  label: "Lead",
  collapsed: true,
  params: { 0: 0.1 },
};

const CABLE_A: PatchCable = {
  id: "cable-1",
  from: { moduleId: 1, jackId: 0, direction: "output", kind: "audio" },
  to: { moduleId: 10000, jackId: 0, direction: "input", kind: "audio" },
};

const CABLE_B: PatchCable = {
  id: "cable-2",
  from: { moduleId: 2, jackId: 0, direction: "output", kind: "audio" },
  to: { moduleId: 10000, jackId: 0, direction: "input", kind: "audio" },
};

const SAMPLE: ModuleSampleState = {
  version: 1,
  kind: "loop",
  assetId: "loop-asset-1",
  loops: [
    {
      slot: 0,
      clip: 0,
      objectKey: "local/loops/example-a.wav",
      name: "example",
      sampleRate: 48_000,
      channels: 2,
      frames: 192_000,
      mode: "bars",
      bars: 2,
      reverse: false,
      stretch: 1,
      createdAt: "2026-04-26T00:00:00Z",
    },
  ],
};

function baseDocument() {
  return sessionPartsToDocument({
    tempoBpm: 120,
    systemModules: [OUT],
    modules: [MODULE_A, MODULE_B],
    cables: [CABLE_A],
  });
}

describe("session mutations", () => {
  it("stores RHY16 params sparsely", () => {
    const rhythmDefaults = Object.fromEntries(
      rhythmSequencerDefinition.params.map((param) => [param.id, param.defaultValue]),
    );
    expect(
      rhythmSequencerDefinition.params.find((param) => param.id === 0)?.defaultValue,
    ).toBe(0);
    expect(
      compactSparseParamsForKind(MODULE_KINDS.rhythmSequencer, rhythmDefaults),
    ).toEqual({});

    const rhythm: RackModuleState = {
      id: 13,
      kind: MODULE_KINDS.rhythmSequencer,
      x: 0,
      y: 0,
      params: { 0: 1, 1: 0 },
    };
    const document = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [rhythm],
      cables: [],
    });
    expect(document.modulesById["13"].params).toEqual({ 0: 1 });

    const emptyDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...rhythm, params: {} }],
      cables: [],
    });
    const addKick = sessionMutationsToPatch(emptyDocument, [
      { type: "setModuleParam", moduleId: 13, paramId: 0, value: 1 },
    ]);
    expect(addKick).toEqual([
      { op: "add", path: "/modulesById/13/params/0", value: 1 },
    ]);

    const kickOn = applySessionPatch(emptyDocument, addKick);
    const clearKick = sessionMutationsToPatch(kickOn, [
      { type: "setModuleParam", moduleId: 13, paramId: 0, value: 0 },
    ]);
    expect(clearKick).toEqual([
      { op: "remove", path: "/modulesById/13/params/0" },
    ]);
    expect(
      applySessionPatch(kickOn, clearKick).modulesById["13"].params,
    ).toEqual({});
  });

  it("turns param edits into leaf patch operations only", () => {
    const document = baseDocument();
    const patch = sessionMutationsToPatch(document, [
      { type: "setModuleParams", moduleId: 1, values: { 0: 0.6, 2: 0.2 } },
    ]);

    expect(patch).toEqual([
      { op: "replace", path: "/modulesById/1/params/0", value: 0.6 },
      { op: "add", path: "/modulesById/1/params/2", value: 0.2 },
    ]);
    expect(patch.some((operation) => operation.path.endsWith("/params"))).toBe(
      false,
    );
    expect(applySessionPatch(document, patch).modulesById["1"].params).toMatchObject({
      0: 0.6,
      1: 0.5,
      2: 0.2,
    });
  });

  it("rebases independent param mutation batches onto a newer document", () => {
    const document = baseDocument();
    const remoteDocument = applySessionMutations(document, [
      { type: "setModuleParam", moduleId: 2, paramId: 0, value: 0.4 },
    ]);
    const localMutations: SessionMutation[] = [
      { type: "setModuleParam", moduleId: 1, paramId: 0, value: 0.9 },
    ];

    const rebasedPatch = rebaseableSessionMutationsToPatch(
      remoteDocument,
      localMutations,
    );

    expect(rebasedPatch).toEqual([
      { op: "replace", path: "/modulesById/1/params/0", value: 0.9 },
    ]);
    const rebasedDocument = applySessionPatch(remoteDocument, rebasedPatch ?? []);
    expect(rebasedDocument.modulesById["1"].params[0]).toBe(0.9);
    expect(rebasedDocument.modulesById["2"].params[0]).toBe(0.4);
  });

  it("rebases uploaded sample metadata onto a newer document", () => {
    const document = baseDocument();
    const remoteDocument = applySessionMutations(document, [
      { type: "setModuleParam", moduleId: 2, paramId: 0, value: 0.4 },
    ]);
    const localMutations: SessionMutation[] = [
      { type: "setModuleSample", moduleId: 1, sample: SAMPLE },
    ];

    const rebasedPatch = rebaseableSessionMutationsToPatch(
      remoteDocument,
      localMutations,
    );

    expect(rebasedPatch).toEqual([
      { op: "add", path: "/modulesById/1/sample", value: SAMPLE },
    ]);
    const rebasedDocument = applySessionPatch(remoteDocument, rebasedPatch ?? []);
    expect(rebasedDocument.modulesById["1"].sample).toEqual(SAMPLE);
    expect(rebasedDocument.modulesById["2"].params[0]).toBe(0.4);
  });

  it("treats structural mutations as non-rebaseable intent", () => {
    expect(
      rebaseableSessionMutationsToPatch(baseDocument(), [
        { type: "setTempo", tempoBpm: 128 },
      ]),
    ).toBeNull();
    expect(
      rebaseableSessionMutationsToPatch(baseDocument(), [
        { type: "addModule", module: MODULE_C },
      ]),
    ).toBeNull();
  });

  it("adds and deletes modules without persisting rack-local layout state", () => {
    const document = baseDocument();
    const added = applySessionMutations(document, [
      { type: "addModule", module: MODULE_C },
    ]);

    expect(added.rackOrder).toEqual(["1", "2", "3"]);
    expect(added.modulesById["3"]).toMatchObject({
      id: 3,
      kind: 30,
      label: "Lead",
      params: { 0: 0.1 },
    });
    expect(added.modulesById["3"]).not.toHaveProperty("x");
    expect(added.modulesById["3"]).not.toHaveProperty("collapsed");

    const deleted = applySessionMutations(added, [
      { type: "deleteModule", moduleId: 1 },
    ]);
    expect(deleted.rackOrder).toEqual(["2", "3"]);
    expect(deleted.modulesById["1"]).toBeUndefined();
    expect(deleted.cableOrder).toEqual([]);
    expect(deleted.cablesById["cable-1"]).toBeUndefined();
  });

  it("upserts cables using the one-cable-per-jack rule", () => {
    const document = baseDocument();
    const next = applySessionMutations(document, [
      { type: "upsertCable", cable: CABLE_B },
    ]);

    expect(next.cableOrder).toEqual(["cable-2"]);
    expect(next.cablesById["cable-1"]).toBeUndefined();
    expect(next.cablesById["cable-2"]).toEqual(CABLE_B);
  });

  it("persists optional module fields as field-level mutations", () => {
    const document = baseDocument();
    const next = applySessionMutations(document, [
      { type: "setModuleLabel", moduleId: 1, label: "Acid" },
      { type: "setModuleSample", moduleId: 1, sample: SAMPLE },
      {
        type: "setModuleText",
        moduleId: 1,
        text: { version: 1, kind: "choir", phrases: ["one", "two"] },
      },
    ]);

    expect(next.modulesById["1"].label).toBe("Acid");
    expect(next.modulesById["1"].sample).toEqual(SAMPLE);
    expect(next.modulesById["1"].text).toEqual({
      version: 1,
      kind: "choir",
      phrases: ["one", "two"],
    });

    const removed = applySessionMutations(next, [
      { type: "setModuleSample", moduleId: 1, sample: undefined },
      { type: "setModuleText", moduleId: 1, text: undefined },
    ]);
    expect(removed.modulesById["1"].sample).toBeUndefined();
    expect(removed.modulesById["1"].text).toBeUndefined();
  });

  it("coalesces high-frequency edits before save", () => {
    const mutationInputs: SessionMutation[] = [
      { type: "setModuleParam", moduleId: 1, paramId: 0, value: 0.3 },
      { type: "setModuleParam", moduleId: 1, paramId: 0, value: 0.4 },
      { type: "setRackOrder", moduleIds: [2, 1] },
      { type: "setRackOrder", moduleIds: [1, 2] },
    ];
    const mutations = mutationInputs.reduce<SessionMutation[]>(
      (current, mutation) => appendSessionMutation(current, mutation),
      [],
    );

    expect(mutations).toEqual([
      { type: "setModuleParam", moduleId: 1, paramId: 0, value: 0.4 },
      { type: "setRackOrder", moduleIds: [1, 2] },
    ]);
  });

  it("removes exactly the mutation objects accepted by an in-flight save", () => {
    const first: SessionMutation = {
      type: "setModuleParam",
      moduleId: 1,
      paramId: 0,
      value: 0.4,
    };
    const second: SessionMutation = {
      type: "setModuleParam",
      moduleId: 2,
      paramId: 0,
      value: 0.2,
    };
    const replacementForFirst: SessionMutation = {
      type: "setModuleParam",
      moduleId: 1,
      paramId: 0,
      value: 0.8,
    };

    expect(removeAppliedSessionMutations([first, second], [first])).toEqual([
      second,
    ]);
    expect(
      removeAppliedSessionMutations([replacementForFirst, second], [first]),
    ).toEqual([replacementForFirst, second]);
  });
});
