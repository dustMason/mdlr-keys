import { describe, expect, it } from "vitest";
import {
  applySessionPatch,
  canonicalSessionDocumentJson,
  createSessionPatch,
  documentToSessionParts,
  sessionDocumentHash,
  sessionPartsToDocument,
  type SessionDocumentV2,
  type SessionPatch,
} from "./sessionDocument";
import { MODULE_KINDS } from "./modules/kinds";
import type {
  ModuleSampleState,
  PatchCable,
  RackModuleState,
} from "./modules/types";

const MODULE_A: RackModuleState = {
  id: 1,
  kind: 10,
  x: 0,
  y: 0,
  label: "Bass",
  ownerUserId: "user-1",
  ownerUsername: "dustmason",
  params: { 0: 0.25, 1: 0.5 },
};

const MODULE_B: RackModuleState = {
  id: 2,
  kind: 20,
  x: 1,
  y: 0,
  params: { 0: 0.75 },
};

const MODULE_B_HYDRATED: RackModuleState = {
  ...MODULE_B,
  x: 0,
};

const OUT: RackModuleState = {
  id: 10000,
  kind: MODULE_KINDS.output,
  x: 0,
  y: 0,
  fixed: true,
  params: { 0: 0.8 },
};

const OUT_PERSISTED: RackModuleState = {
  ...OUT,
  params: {},
};

const CABLE_A: PatchCable = {
  id: "cable-1",
  from: { moduleId: 1, jackId: 0, direction: "output", kind: "audio" },
  to: { moduleId: 10000, jackId: 0, direction: "input", kind: "audio" },
};

const CABLE_B: PatchCable = {
  id: "cable-2",
  from: { moduleId: 2, jackId: 0, direction: "output", kind: "audio" },
  to: { moduleId: 10000, jackId: 1, direction: "input", kind: "audio" },
};

const CABLE_C: PatchCable = {
  id: "cable-3",
  from: { moduleId: 1, jackId: 1, direction: "output", kind: "cv" },
  to: { moduleId: 2, jackId: 1, direction: "input", kind: "cv" },
};

const CABLE_DUPLICATE_SOURCE: PatchCable = {
  id: "cable-duplicate-source",
  from: { ...CABLE_A.from },
  to: { moduleId: 10000, jackId: 1, direction: "input", kind: "audio" },
};

const CABLE_DUPLICATE_DESTINATION: PatchCable = {
  id: "cable-duplicate-destination",
  from: { moduleId: 2, jackId: 0, direction: "output", kind: "audio" },
  to: { ...CABLE_A.to },
};

const SAMPLE: ModuleSampleState = {
  version: 1,
  kind: "sampler",
  assetId: "sample-1",
  sourceType: "op1.fun",
  sourceUrl: "https://op1.fun/users/test/patches/sample",
  apiUrl: "https://fiftyfootfoghorn.com/api.op1.fun/patches/sample",
  fileUrl: "https://op1-fun.s3.amazonaws.com/uploads/patch/1/patch.aif",
  name: "sample",
  sampleRate: 44_100,
  channels: 2,
  frames: 512,
  slices: [{ index: 0, startFrame: 0, endFrame: 512 }],
};

const LOCAL_LOOP_SAMPLE: ModuleSampleState = {
  version: 1,
  kind: "loop",
  assetId: "loop-local-1",
  loops: [
    {
      slot: 0,
      clip: 0,
      objectKey: "local/loops/test-loop.wav",
      name: "test loop",
      sampleRate: 48_000,
      channels: 2,
      frames: 1024,
      mode: "bars",
      bars: 1,
      reverse: false,
      stretch: 1,
      createdAt: "2026-04-25T00:00:00Z",
    },
  ],
};

const LOOP_PLAY_PARAM_SLOT_1_CLIP_1 = 240;

function baseDocument() {
  return sessionPartsToDocument({
    tempoBpm: 120,
    systemModules: [OUT],
    modules: [MODULE_A, MODULE_B],
    cables: [CABLE_A],
  });
}

describe("session document", () => {
  it("round-trips between app arrays and the patch-friendly document shape", () => {
    const document = baseDocument();
    const parts = documentToSessionParts(document);

    expect(parts.tempoBpm).toBe(120);
    expect(parts.systemModules).toEqual([OUT_PERSISTED]);
    expect(parts.modules).toEqual([MODULE_A, MODULE_B_HYDRATED]);
    expect(parts.cables).toEqual([CABLE_A]);
  });

  it("keeps the master output volume out of session state", async () => {
    const quietDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [{ ...OUT, params: { 0: 0.2 } }],
      modules: [MODULE_A],
      cables: [],
    });
    const loudDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [{ ...OUT, params: { 0: 0.95 } }],
      modules: [MODULE_A],
      cables: [],
    });

    expect(quietDocument.systemModulesById["10000"].params).toEqual({});
    expect(canonicalSessionDocumentJson(quietDocument)).toBe(
      canonicalSessionDocumentJson(loudDocument),
    );
    expect(await sessionDocumentHash(quietDocument)).toBe(
      await sessionDocumentHash(loudDocument),
    );
  });

  it("applies allowed session patches without mutating the input document", () => {
    const document = baseDocument();
    const patch: SessionPatch = [
      { op: "replace", path: "/tempoBpm", value: 132 },
      { op: "replace", path: "/modulesById/1/params/0", value: 0.6 },
      { op: "replace", path: "/modulesById/1/label", value: "Acid" },
      { op: "replace", path: "/modulesById/1/ownerUsername", value: "Jordan" },
      { op: "add", path: "/cablesById/cable-2", value: CABLE_B },
      { op: "replace", path: "/cableOrder", value: ["cable-1", "cable-2"] },
    ];

    const next = applySessionPatch(document, patch);

    expect(document.tempoBpm).toBe(120);
    expect(document.modulesById["1"].params[0]).toBe(0.25);
    expect(next.tempoBpm).toBe(132);
    expect(next.modulesById["1"].label).toBe("Acid");
    expect(next.modulesById["1"].ownerUserId).toBe("user-1");
    expect(next.modulesById["1"].ownerUsername).toBe("Jordan");
    expect(next.modulesById["1"].params[0]).toBe(0.6);
    expect(next.cableOrder).toEqual(["cable-1", "cable-2"]);
    expect(next.cablesById["cable-2"]).toEqual(CABLE_B);
  });

  it("keeps module collapse state out of shared session state", async () => {
    const expandedDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...MODULE_A, collapsed: false }],
      cables: [],
    });
    const collapsedDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...MODULE_A, collapsed: true }],
      cables: [],
    });

    expect(expandedDocument.modulesById["1"].collapsed).toBeUndefined();
    expect(collapsedDocument.modulesById["1"].collapsed).toBeUndefined();
    expect(canonicalSessionDocumentJson(expandedDocument)).toBe(
      canonicalSessionDocumentJson(collapsedDocument),
    );
    expect(await sessionDocumentHash(expandedDocument)).toBe(
      await sessionDocumentHash(collapsedDocument),
    );
  });

  it("keeps rack positions out of shared session state", async () => {
    const originalDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [MODULE_A, MODULE_B],
      cables: [],
    });
    const movedDocument = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [{ ...OUT, x: 1, y: 12 }],
      modules: [
        { ...MODULE_A, x: 1, y: 42 },
        { ...MODULE_B, x: 0, y: 99 },
      ],
      cables: [],
    });

    expect(originalDocument.systemModulesById["10000"]).not.toHaveProperty("x");
    expect(originalDocument.systemModulesById["10000"]).not.toHaveProperty("y");
    expect(originalDocument.modulesById["1"]).not.toHaveProperty("x");
    expect(originalDocument.modulesById["1"]).not.toHaveProperty("y");
    expect(canonicalSessionDocumentJson(originalDocument)).toBe(
      canonicalSessionDocumentJson(movedDocument),
    );
    expect(await sessionDocumentHash(originalDocument)).toBe(
      await sessionDocumentHash(movedDocument),
    );
    expect(createSessionPatch(originalDocument, movedDocument)).toEqual([]);
  });

  it("emits whole-array replacements when cable order changes by index", () => {
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [MODULE_A, MODULE_B],
      cables: [CABLE_A, CABLE_B, CABLE_C],
    });
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [MODULE_A, MODULE_B],
      cables: [CABLE_A],
    });

    const patch = createSessionPatch(from, to);

    expect(patch.some((operation) => operation.path.startsWith("/cableOrder/"))).toBe(false);
    expect(patch).toContainEqual({
      op: "replace",
      path: "/cableOrder",
      value: ["cable-1"],
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("emits whole-module param replacements for dense control edits", () => {
    const from = baseDocument();
    const denseParams = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [index, index / 31]),
    );
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...MODULE_A, params: denseParams }, MODULE_B],
      cables: [CABLE_A],
    });

    const patch = createSessionPatch(from, to);

    expect(
      patch.some((operation) =>
        operation.path.startsWith("/modulesById/1/params/"),
      ),
    ).toBe(false);
    expect(patch).toContainEqual({
      op: "replace",
      path: "/modulesById/1/params",
      value: denseParams,
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("keeps undefined optional module sample fields out of patches", () => {
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [MODULE_A],
      cables: [],
    });
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...MODULE_A, sample: undefined }],
      cables: [],
    });

    expect(Object.hasOwn(to.modulesById["1"], "sample")).toBe(false);
    expect(createSessionPatch(from, to)).toEqual([]);
  });

  it("emits sample removal only when a persisted sample exists", () => {
    const sampledModule = { ...MODULE_A, sample: SAMPLE };
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [sampledModule],
      cables: [],
    });
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [MODULE_A],
      cables: [],
    });

    const patch = createSessionPatch(from, to);

    expect(patch).toContainEqual({
      op: "remove",
      path: "/modulesById/1/sample",
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("accepts locally stored loop samples in session patches", () => {
    const from = baseDocument();
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...MODULE_A, sample: LOCAL_LOOP_SAMPLE }, MODULE_B],
      cables: [CABLE_A],
    });
    const patch = createSessionPatch(from, to);

    expect(patch).toContainEqual({
      op: "add",
      path: "/modulesById/1/sample",
      value: LOCAL_LOOP_SAMPLE,
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("accepts multiple loop clips on the same track in session patches", () => {
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [
        {
          ...MODULE_A,
          kind: MODULE_KINDS.loop,
          sample: LOCAL_LOOP_SAMPLE,
        },
      ],
      cables: [],
    });
    const secondClipSample: ModuleSampleState = {
      ...LOCAL_LOOP_SAMPLE,
      assetId: "loop-local-2",
      loops: [
        ...LOCAL_LOOP_SAMPLE.loops,
        {
          ...LOCAL_LOOP_SAMPLE.loops[0],
          clip: 1,
          objectKey: "local/loops/test-loop-2.wav",
          name: "test loop 2",
          frames: 2048,
          mode: "free",
          bars: 0,
          createdAt: "2026-04-25T00:00:01Z",
        },
      ],
    };
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [
        {
          ...MODULE_A,
          kind: MODULE_KINDS.loop,
          sample: secondClipSample,
        },
      ],
      cables: [],
    });

    const patch = createSessionPatch(from, to);

    expect(patch).toContainEqual({
      op: "replace",
      path: "/modulesById/1/sample",
      value: secondClipSample,
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("normalizes stale loop sample slots to track and clip coordinates", () => {
    const legacyLoopSample = {
      ...LOCAL_LOOP_SAMPLE,
      loops: [
        {
          ...LOCAL_LOOP_SAMPLE.loops[0],
          slot: 2,
          clip: undefined,
        },
        {
          ...LOCAL_LOOP_SAMPLE.loops[0],
          slot: 11,
          clip: undefined,
          objectKey: "local/loops/test-loop-2.wav",
          name: "test loop 2",
        },
      ],
    } as unknown as ModuleSampleState;

    const document = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [{ ...MODULE_A, sample: legacyLoopSample }, MODULE_B],
      cables: [CABLE_A],
    });

    const loops = document.modulesById["1"].sample?.kind === "loop"
      ? document.modulesById["1"].sample.loops
      : [];
    expect(loops.map((loop) => [loop.slot, loop.clip])).toEqual([
      [2, 0],
      [2, 3],
    ]);
  });

  it("persists loop play state as a module param", () => {
    const loopModule: RackModuleState = {
      ...MODULE_A,
      kind: MODULE_KINDS.loop,
      sample: LOCAL_LOOP_SAMPLE,
      params: { [LOOP_PLAY_PARAM_SLOT_1_CLIP_1]: 0 },
    };
    const playingLoopModule: RackModuleState = {
      ...loopModule,
      params: { [LOOP_PLAY_PARAM_SLOT_1_CLIP_1]: 1 },
    };
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [loopModule],
      cables: [],
    });
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [playingLoopModule],
      cables: [],
    });

    const patch = createSessionPatch(from, to);

    expect(patch).toContainEqual({
      op: "replace",
      path: "/modulesById/1/params/240",
      value: 1,
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("persists module text as a whole field", () => {
    const textModule: RackModuleState = {
      ...MODULE_A,
      text: {
        version: 1,
        kind: "choir",
        phrases: ["happy birthday to you", "we love the night"],
      },
    };
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [MODULE_A],
      cables: [],
    });
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [textModule],
      cables: [],
    });

    const patch = createSessionPatch(from, to);

    expect(patch).toContainEqual({
      op: "add",
      path: "/modulesById/1/text",
      value: textModule.text,
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("persists loop slot labels as module text", () => {
    const loopModule: RackModuleState = {
      ...MODULE_A,
      kind: MODULE_KINDS.loop,
    };
    const textModule: RackModuleState = {
      ...loopModule,
      text: {
        version: 1,
        kind: "loop",
        slotLabels: ["verse", "hook", "", "break"],
      },
    };
    const from = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [loopModule],
      cables: [],
    });
    const to = sessionPartsToDocument({
      tempoBpm: 120,
      systemModules: [OUT],
      modules: [textModule],
      cables: [],
    });

    const patch = createSessionPatch(from, to);

    expect(patch).toContainEqual({
      op: "add",
      path: "/modulesById/1/text",
      value: textModule.text,
    });
    expect(applySessionPatch(from, patch)).toEqual(to);
  });

  it("allows field-level cable endpoint reroutes", () => {
    const next = applySessionPatch(baseDocument(), [
      { op: "replace", path: "/cablesById/cable-1/to/moduleId", value: 2 },
      { op: "replace", path: "/cablesById/cable-1/to/jackId", value: 1 },
    ]);

    expect(next.cablesById["cable-1"].to).toEqual({
      moduleId: 2,
      jackId: 1,
      direction: "input",
      kind: "audio",
    });
  });

  it("rejects multiple cable connections for the same jack", () => {
    expect(() =>
      sessionPartsToDocument({
        tempoBpm: 120,
        systemModules: [OUT],
        modules: [MODULE_A, MODULE_B],
        cables: [CABLE_A, CABLE_DUPLICATE_SOURCE],
      }),
    ).toThrow(/already connected/);

    expect(() =>
      sessionPartsToDocument({
        tempoBpm: 120,
        systemModules: [OUT],
        modules: [MODULE_A, MODULE_B],
        cables: [CABLE_A, CABLE_DUPLICATE_DESTINATION],
      }),
    ).toThrow(/already connected/);
  });

  it("rejects broad or unsafe JSON Patch operations", () => {
    const document = baseDocument();

    expect(() =>
      applySessionPatch(document, [
        { op: "move", from: "/modulesById/1", path: "/modulesById/3" },
      ]),
    ).toThrow(/unsupported op/);

    expect(() =>
      applySessionPatch(document, [
        { op: "add", path: "/modulesById/__proto__", value: MODULE_A },
      ]),
    ).toThrow(/unsafe segment/);

    expect(() =>
      applySessionPatch(document, [
        { op: "replace", path: "", value: {} as SessionDocumentV2 },
      ]),
    ).toThrow(/non-root JSON Pointer/);

    expect(() =>
      applySessionPatch(document, [
        { op: "replace", path: "/cablesById/cable-1/id", value: "cable-x" },
      ]),
    ).toThrow(/disallowed path/);
  });

  it("rejects patches that leave the session graph inconsistent", () => {
    expect(() =>
      applySessionPatch(baseDocument(), [{ op: "remove", path: "/modulesById/1" }]),
    ).toThrow(/references missing id/);

    expect(() =>
      applySessionPatch(baseDocument(), [
        {
          op: "add",
          path: "/cablesById/cable-2",
          value: {
            ...CABLE_B,
            from: { ...CABLE_B.from, moduleId: 404 },
          },
        },
        { op: "replace", path: "/cableOrder", value: ["cable-1", "cable-2"] },
      ]),
    ).toThrow(/missing module/);
  });

  it("produces deterministic canonical JSON and hashes", async () => {
    const first = baseDocument();
    const second: SessionDocumentV2 = {
      version: 2,
      rackOrder: ["1", "2"],
      modulesById: {
        "2": MODULE_B,
        "1": MODULE_A,
      },
      tempoBpm: 120,
      cableOrder: ["cable-1"],
      cablesById: {
        "cable-1": CABLE_A,
      },
      systemRackOrder: ["10000"],
      systemModulesById: {
        "10000": OUT_PERSISTED,
      },
    };

    expect(canonicalSessionDocumentJson(first)).toBe(canonicalSessionDocumentJson(second));
    expect(await sessionDocumentHash(first)).toBe(await sessionDocumentHash(second));
  });
});
