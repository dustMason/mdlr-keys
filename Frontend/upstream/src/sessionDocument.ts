import {
  applyPatch as applyJsonPatch,
  compare as compareJsonPatch,
  validator as jsonPatchValidator,
  type Operation,
  type Validator,
} from "fast-json-patch";
import type { PatchCable, RackModuleState } from "./modules/types";
import { compactSparseParamsForKind } from "./modules/sparseParams";
import {
  stripSessionLocalSystemModulesById,
  stripSessionLocalSystemState,
} from "./sessionLocalState";

type SessionRackModuleState = Omit<RackModuleState, "x" | "y"> &
  Partial<Pick<RackModuleState, "x" | "y">>;

export interface SessionDocumentV2 {
  version: 2;
  tempoBpm: number;
  systemModulesById: Record<string, SessionRackModuleState>;
  systemRackOrder: string[];
  modulesById: Record<string, SessionRackModuleState>;
  rackOrder: string[];
  cablesById: Record<string, PatchCable>;
  cableOrder: string[];
}

export interface SessionDocumentParts {
  tempoBpm: number;
  systemModules?: RackModuleState[];
  modules: RackModuleState[];
  cables: PatchCable[];
}

export type JsonPatchOperation = Exclude<Operation, { op: "_get" }>;
export type SessionPatch = JsonPatchOperation[];

const WRITE_OPS = new Set(["add", "remove", "replace", "test"]);
const SIGNAL_KINDS = new Set(["audio", "cv", "gate"]);
const JACK_DIRECTIONS = new Set(["input", "output"]);
const UNSAFE_POINTER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ORDER_ARRAY_FIELDS = ["rackOrder", "systemRackOrder", "cableOrder"] as const;
const LOOP_TRACK_COUNT = 8;
const LOOP_CLIPS_PER_TRACK = 4;
type OrderArrayField = (typeof ORDER_ARRAY_FIELDS)[number];

export function sessionPartsToDocument(parts: SessionDocumentParts): SessionDocumentV2 {
  const systemModules = stripSessionLocalSystemState(parts.systemModules ?? []);
  return assertValidSessionDocument({
    version: 2,
    tempoBpm: parts.tempoBpm,
    systemModulesById: modulesById(systemModules),
    systemRackOrder: systemModules.map((module) => String(module.id)),
    modulesById: modulesById(parts.modules),
    rackOrder: parts.modules.map((module) => String(module.id)),
    cablesById: cablesById(parts.cables),
    cableOrder: parts.cables.map((cable) => cable.id),
  });
}

export function documentToSessionParts(document: SessionDocumentV2): SessionDocumentParts {
  const validDocument = assertValidSessionDocument(document);
  return {
    tempoBpm: validDocument.tempoBpm,
    systemModules: validDocument.systemRackOrder.map(
      (id) => hydrateRackModule(validDocument.systemModulesById[id]),
    ),
    modules: validDocument.rackOrder.map((id) =>
      hydrateRackModule(validDocument.modulesById[id]),
    ),
    cables: validDocument.cableOrder.map((id) => validDocument.cablesById[id]),
  };
}

export function applySessionPatch(
  document: SessionDocumentV2,
  patch: SessionPatch,
): SessionDocumentV2 {
  const validDocument = assertValidSessionDocument(document);
  validateSessionPatch(patch);
  const result = applyJsonPatch<SessionDocumentV2>(
    validDocument,
    patch,
    sessionPatchOperationValidator,
    false,
    true,
  ).newDocument;
  return assertValidSessionDocument(result);
}

export function createSessionPatch(
  from: SessionDocumentV2,
  to: SessionDocumentV2,
): SessionPatch {
  const validFrom = assertValidSessionDocument(from);
  const validTo = assertValidSessionDocument(to);
  const patch = normalizeOrderArrayPatch(
    normalizeLargeModuleParamPatch(
      normalizeModuleSamplePatch(
        normalizeModuleTextPatch(
          compareJsonPatch(validFrom, validTo, true) as SessionPatch,
          validFrom,
          validTo,
        ),
        validFrom,
        validTo,
      ),
      validFrom,
      validTo,
    ),
    validTo,
  );
  validateSessionPatch(patch);
  return patch;
}

export function validateSessionPatch(patch: SessionPatch) {
  if (!Array.isArray(patch)) {
    throw new Error("Session patch must be an array.");
  }
  if (patch.length > 64) {
    throw new Error("Session patch contains too many operations.");
  }

  for (let index = 0; index < patch.length; index += 1) {
    validateAllowedSessionPatchOperation(patch[index], index);
  }
}

export function assertValidSessionDocument(
  document: SessionDocumentV2,
): SessionDocumentV2 {
  if (!isObject(document)) {
    throw new Error("Session document must be an object.");
  }
  if (document.version !== 2) {
    throw new Error("Unsupported session document version.");
  }
  if (!isFiniteNumber(document.tempoBpm) || document.tempoBpm < 20 || document.tempoBpm > 300) {
    throw new Error("Session tempo is outside the supported range.");
  }
  assertPlainRecord(document.systemModulesById, "systemModulesById");
  assertPlainRecord(document.modulesById, "modulesById");
  assertPlainRecord(document.cablesById, "cablesById");
  assertStringArray(document.systemRackOrder, "systemRackOrder");
  assertStringArray(document.rackOrder, "rackOrder");
  assertStringArray(document.cableOrder, "cableOrder");
  const normalizedDocument = {
    ...document,
    systemModulesById: normalizeSessionModulesById(
      stripSessionLocalSystemModulesById(
        document.systemModulesById as Record<string, RackModuleState>,
      ),
    ),
    modulesById: normalizeSessionModulesById(document.modulesById),
  };
  assertOrderMatchesRecord(
    normalizedDocument.systemRackOrder,
    normalizedDocument.systemModulesById,
    "systemRackOrder",
  );
  assertOrderMatchesRecord(normalizedDocument.rackOrder, normalizedDocument.modulesById, "rackOrder");
  assertOrderMatchesRecord(normalizedDocument.cableOrder, normalizedDocument.cablesById, "cableOrder");

  for (const [id, module] of Object.entries(normalizedDocument.systemModulesById)) {
    assertValidModule(id, module, "system module");
  }
  for (const [id, module] of Object.entries(normalizedDocument.modulesById)) {
    assertValidModule(id, module, "module");
  }
  for (const [id, cable] of Object.entries(normalizedDocument.cablesById)) {
    assertValidCable(id, cable, normalizedDocument);
  }
  assertSingleCablePerJack(normalizedDocument);

  return normalizedDocument;
}

export function canonicalSessionDocumentJson(document: SessionDocumentV2) {
  return canonicalJson(assertValidSessionDocument(document));
}

export async function sessionDocumentHash(document: SessionDocumentV2) {
  const bytes = new TextEncoder().encode(canonicalSessionDocumentJson(document));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

const sessionPatchOperationValidator: Validator<SessionDocumentV2> = (
  operation,
  index,
  document,
  existingPathFragment,
) => {
  jsonPatchValidator(operation, index, document, existingPathFragment);
  validateAllowedSessionPatchOperation(operation as JsonPatchOperation, index);
};

function validateAllowedSessionPatchOperation(
  operation: JsonPatchOperation,
  index: number,
) {
  if (!isObject(operation)) {
    throw new Error(`Patch operation ${index} must be an object.`);
  }
  if (!WRITE_OPS.has(operation.op)) {
    throw new Error(`Patch operation ${index} uses unsupported op "${operation.op}".`);
  }
  const segments = parsePointer(operation.path);
  if (!isAllowedSessionPath(segments, operation.op)) {
    throw new Error(`Patch operation ${index} targets disallowed path "${operation.path}".`);
  }
}

function isAllowedSessionPath(segments: string[], op: string) {
  if (segments.length === 1 && segments[0] === "tempoBpm") {
    return op === "replace" || op === "test";
  }

  if (
    segments.length === 1 &&
    (segments[0] === "rackOrder" ||
      segments[0] === "systemRackOrder" ||
      segments[0] === "cableOrder")
  ) {
    return op === "replace" || op === "test";
  }

  if (segments[0] === "modulesById" || segments[0] === "systemModulesById") {
    return isAllowedModulePath(segments, op);
  }

  if (segments[0] === "cablesById") {
    return isAllowedCablePath(segments, op);
  }

  return false;
}

function normalizeOrderArrayPatch(
  patch: SessionPatch,
  targetDocument: SessionDocumentV2,
): SessionPatch {
  const touchedOrderFields = new Set<OrderArrayField>();
  const filteredPatch = patch.filter((operation) => {
    for (const field of ORDER_ARRAY_FIELDS) {
      const path = `/${field}`;
      if (operation.path === path || operation.path.startsWith(`${path}/`)) {
        touchedOrderFields.add(field);
        return false;
      }
    }
    return true;
  });

  for (const field of ORDER_ARRAY_FIELDS) {
    if (touchedOrderFields.has(field)) {
      filteredPatch.push({
        op: "replace",
        path: `/${field}`,
        value: [...targetDocument[field]],
      });
    }
  }

  return filteredPatch;
}

function normalizeModuleSamplePatch(
  patch: SessionPatch,
  sourceDocument: SessionDocumentV2,
  targetDocument: SessionDocumentV2,
): SessionPatch {
  const touched = new Set<string>();
  const filtered = patch.filter((operation) => {
    const match = operation.path.match(
      /^\/(modulesById|systemModulesById)\/([^/]+)\/sample(?:\/|$)/,
    );
    if (!match) {
      return true;
    }
    touched.add(`${match[1]}/${match[2]}`);
    return false;
  });

  for (const key of touched) {
    const [scope, id] = key.split("/") as ["modulesById" | "systemModulesById", string];
    const sourceModule = sourceDocument[scope][id];
    const targetModule = targetDocument[scope][id];
    const path = `/${scope}/${id}/sample`;
    if (!targetModule?.sample) {
      filtered.push({ op: "remove", path });
    } else if (!sourceModule?.sample) {
      filtered.push({ op: "add", path, value: targetModule.sample });
    } else {
      filtered.push({ op: "replace", path, value: targetModule.sample });
    }
  }

  return filtered;
}

function normalizeModuleTextPatch(
  patch: SessionPatch,
  sourceDocument: SessionDocumentV2,
  targetDocument: SessionDocumentV2,
): SessionPatch {
  const touched = new Set<string>();
  const filtered = patch.filter((operation) => {
    const match = operation.path.match(
      /^\/(modulesById|systemModulesById)\/([^/]+)\/text(?:\/|$)/,
    );
    if (!match) {
      return true;
    }
    touched.add(`${match[1]}/${match[2]}`);
    return false;
  });

  for (const key of touched) {
    const [scope, id] = key.split("/") as ["modulesById" | "systemModulesById", string];
    const sourceModule = sourceDocument[scope][id];
    const targetModule = targetDocument[scope][id];
    const path = `/${scope}/${id}/text`;
    if (!targetModule?.text) {
      filtered.push({ op: "remove", path });
    } else if (!sourceModule?.text) {
      filtered.push({ op: "add", path, value: targetModule.text });
    } else {
      filtered.push({ op: "replace", path, value: targetModule.text });
    }
  }

  return filtered;
}

function normalizeLargeModuleParamPatch(
  patch: SessionPatch,
  sourceDocument: SessionDocumentV2,
  targetDocument: SessionDocumentV2,
): SessionPatch {
  const touched = new Map<string, number>();
  for (const operation of patch) {
    const match = operation.path.match(
      /^\/(modulesById|systemModulesById)\/([^/]+)\/params(?:\/|$)/,
    );
    if (!match) {
      continue;
    }
    const key = `${match[1]}/${match[2]}`;
    touched.set(key, (touched.get(key) ?? 0) + 1);
  }

  const broadReplacements = new Set(
    [...touched]
      .filter(([, count]) => count > 24)
      .map(([key]) => key),
  );
  if (broadReplacements.size === 0) {
    return patch;
  }

  const filtered = patch.filter((operation) => {
    const match = operation.path.match(
      /^\/(modulesById|systemModulesById)\/([^/]+)\/params(?:\/|$)/,
    );
    return !match || !broadReplacements.has(`${match[1]}/${match[2]}`);
  });

  for (const key of broadReplacements) {
    const [scope, id] = key.split("/") as ["modulesById" | "systemModulesById", string];
    const sourceModule = sourceDocument[scope][id];
    const targetModule = targetDocument[scope][id];
    if (!sourceModule || !targetModule) {
      continue;
    }
    filtered.push({
      op: "replace",
      path: `/${scope}/${id}/params`,
      value: { ...targetModule.params },
    });
  }

  return filtered;
}

function isAllowedModulePath(segments: string[], op: string) {
  if (segments.length === 2) {
    return op === "add" || op === "remove" || op === "replace" || op === "test";
  }
  if (segments.length === 3) {
    const field = segments[2];
    if (field === "label") {
      return op === "add" || op === "remove" || op === "replace" || op === "test";
    }
    if (field === "sample") {
      return op === "add" || op === "remove" || op === "replace" || op === "test";
    }
    if (field === "text") {
      return op === "add" || op === "remove" || op === "replace" || op === "test";
    }
    if (field === "ownerUserId" || field === "ownerUsername") {
      return op === "add" || op === "remove" || op === "replace" || op === "test";
    }
    if (field === "params") {
      return op === "replace" || op === "test";
    }
    return false;
  }
  if (segments.length === 4 && segments[2] === "params") {
    return isSafeIntegerString(segments[3]) &&
      (op === "add" || op === "remove" || op === "replace" || op === "test");
  }
  return false;
}

function isAllowedCablePath(segments: string[], op: string) {
  if (segments.length === 2) {
    return op === "add" || op === "remove" || op === "replace" || op === "test";
  }
  if (segments.length === 3 && (segments[2] === "from" || segments[2] === "to")) {
    return op === "replace" || op === "test";
  }
  if (segments.length === 4 && (segments[2] === "from" || segments[2] === "to")) {
    const field = segments[3];
    return (
      (field === "moduleId" ||
        field === "jackId" ||
        field === "direction" ||
        field === "kind") &&
      (op === "replace" || op === "test")
    );
  }
  return false;
}

function parsePointer(path: string) {
  if (typeof path !== "string" || path === "" || !path.startsWith("/")) {
    throw new Error("Patch path must be a non-root JSON Pointer.");
  }
  return path
    .slice(1)
    .split("/")
    .map((segment) => {
      const decoded = decodePointerSegment(segment);
      if (decoded === "" || UNSAFE_POINTER_KEYS.has(decoded)) {
        throw new Error("Patch path contains an unsafe segment.");
      }
      return decoded;
    });
}

function decodePointerSegment(segment: string) {
  if (/~(?![01])/.test(segment)) {
    throw new Error("Patch path contains an invalid JSON Pointer escape.");
  }
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function modulesById(modules: RackModuleState[]) {
  const byId: Record<string, SessionRackModuleState> = {};
  for (const module of modules) {
    byId[String(module.id)] = moduleForSessionDocument(module);
  }
  return byId;
}

function moduleForSessionDocument(module: RackModuleState) {
  const persisted: SessionRackModuleState = {
    id: module.id,
    kind: module.kind,
    params: compactSparseParamsForKind(module.kind, module.params),
  };
  if (module.fixed !== undefined) {
    persisted.fixed = module.fixed;
  }
  if (module.label !== undefined) {
    persisted.label = module.label;
  }
  if (module.ownerUserId !== undefined) {
    persisted.ownerUserId = module.ownerUserId;
  }
  if (module.ownerUsername !== undefined) {
    persisted.ownerUsername = module.ownerUsername;
  }
  if (module.sample !== undefined) {
    persisted.sample = normalizeModuleSample(module.sample);
  }
  if (module.text !== undefined) {
    persisted.text = module.text;
  }
  return persisted;
}

function normalizeSessionModulesById(
  modulesById: Record<string, SessionRackModuleState>,
) {
  return Object.fromEntries(
    Object.entries(modulesById).map(([id, module]) => [
      id,
      normalizeSessionModule(module),
    ]),
  );
}

function normalizeSessionModule(module: SessionRackModuleState): SessionRackModuleState {
  const {
    x: _x,
    y: _y,
    collapsed: _collapsed,
    sample: rawSample,
    ...shared
  } = module;
  const sample = normalizeModuleSample(rawSample);
  const normalized: SessionRackModuleState = {
    ...shared,
    params: compactSparseParamsForKind(shared.kind, shared.params ?? {}),
  };
  if (sample !== undefined) {
    normalized.sample = sample;
  }
  return normalized;
}

function hydrateRackModule(module: SessionRackModuleState): RackModuleState {
  const {
    x: _x,
    y: _y,
    collapsed: _collapsed,
    ...shared
  } = module;
  return {
    ...shared,
    x: 0,
    y: 0,
  } as RackModuleState;
}

function normalizeModuleSample(sample: RackModuleState["sample"]) {
  if (!isObject(sample) || sample.version !== 1 || sample.kind !== "loop") {
    return sample;
  }
  if (!Array.isArray(sample.loops)) {
    return sample;
  }

  let changed = false;
  const loopsByCell = new Map<string, Record<string, unknown>>();
  for (const loop of sample.loops) {
    if (!isObject(loop)) {
      changed = true;
      continue;
    }
    const coordinate = normalizedLoopCoordinate(loop);
    if (!coordinate) {
      loopsByCell.set(`invalid:${loopsByCell.size}`, loop);
      continue;
    }
    const normalizedLoop = {
      ...loop,
      slot: coordinate.slot,
      clip: coordinate.clip,
    };
    changed ||= loop.slot !== coordinate.slot || loop.clip !== coordinate.clip;
    const key = `${coordinate.slot}:${coordinate.clip}`;
    changed ||= loopsByCell.has(key);
    loopsByCell.set(key, normalizedLoop);
  }

  if (!changed) {
    return sample;
  }

  return {
    ...sample,
    loops: [...loopsByCell.values()],
  } as unknown as RackModuleState["sample"];
}

function normalizedLoopCoordinate(loop: Record<string, unknown>) {
  if (!Number.isInteger(loop.slot)) {
    return null;
  }
  const rawSlot = loop.slot as number;
  if (Number.isInteger(loop.clip)) {
    return {
      slot: rawSlot,
      clip: loop.clip as number,
    };
  }
  if (rawSlot >= 0 && rawSlot < LOOP_TRACK_COUNT) {
    return {
      slot: rawSlot,
      clip: 0,
    };
  }
  const cellCount = LOOP_TRACK_COUNT * LOOP_CLIPS_PER_TRACK;
  if (rawSlot >= 0 && rawSlot < cellCount) {
    return {
      slot: Math.floor(rawSlot / LOOP_CLIPS_PER_TRACK),
      clip: rawSlot % LOOP_CLIPS_PER_TRACK,
    };
  }
  return null;
}

function cablesById(cables: PatchCable[]) {
  const byId: Record<string, PatchCable> = {};
  for (const cable of cables) {
    byId[cable.id] = {
      id: cable.id,
      from: { ...cable.from },
      to: { ...cable.to },
    };
  }
  return byId;
}

function assertValidModule(
  id: string,
  module: SessionRackModuleState,
  label: string,
) {
  if (!isObject(module)) {
    throw new Error(`Invalid ${label} "${id}".`);
  }
  if (String(module.id) !== id) {
    throw new Error(`Invalid ${label} id mapping.`);
  }
  if (!Number.isInteger(module.id) || module.id <= 0) {
    throw new Error(`Invalid ${label} id.`);
  }
  if (!Number.isInteger(module.kind) || module.kind <= 0) {
    throw new Error(`Invalid ${label} kind.`);
  }
  if (module.label !== undefined && typeof module.label !== "string") {
    throw new Error(`Invalid ${label} label.`);
  }
  if (
    module.ownerUserId !== undefined &&
    (typeof module.ownerUserId !== "string" ||
      module.ownerUserId.length < 1 ||
      module.ownerUserId.length > 128)
  ) {
    throw new Error(`Invalid ${label} owner user id.`);
  }
  if (
    module.ownerUsername !== undefined &&
    (typeof module.ownerUsername !== "string" ||
      module.ownerUsername.length > 96)
  ) {
    throw new Error(`Invalid ${label} owner username.`);
  }
  if (module.collapsed !== undefined && typeof module.collapsed !== "boolean") {
    throw new Error(`Invalid ${label} collapsed state.`);
  }
  if (module.sample !== undefined) {
    assertValidModuleSample(module.sample, `${label}.sample`);
  }
  if (module.text !== undefined) {
    assertValidModuleText(module.text, `${label}.text`);
  }
  assertPlainRecord(module.params, `${label}.params`);
  for (const [paramId, value] of Object.entries(module.params)) {
    if (!isSafeIntegerString(paramId) || !isFiniteNumber(value)) {
      throw new Error(`Invalid ${label} parameter.`);
    }
  }
}

function assertValidModuleSample(value: unknown, label: string) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (value.version !== 1) {
    throw new Error(`${label} has an unsupported format.`);
  }
  if (value.kind === "loop") {
    assertValidLoopSample(value, label);
    return;
  }
  if (value.kind !== "sampler" && value.kind !== "op1-drum") {
    throw new Error(`${label} has an unsupported format.`);
  }
  for (const field of ["assetId", "sourceUrl", "apiUrl", "fileUrl", "name"]) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string") {
      throw new Error(`${label}.${field} must be a string.`);
    }
  }
  if (
    (value.assetId as string).length < 8 ||
    (value.assetId as string).length > 96 ||
    (value.sourceUrl as string).length > 600 ||
    (value.apiUrl as string).length > 600 ||
    (value.fileUrl as string).length > 900 ||
    (value.name as string).length > 160
  ) {
    throw new Error(`${label} string fields are outside the supported range.`);
  }
  if (value.kind === "sampler") {
    if (
      value.sourceType !== "factory" &&
      value.sourceType !== "op1.fun" &&
      value.sourceType !== "upload"
    ) {
      throw new Error(`${label}.sourceType is invalid.`);
    }
    if (value.sourceType === "upload") {
      const objectKey = value.objectKey;
      if (
        typeof objectKey !== "string" ||
        objectKey.length < 12 ||
        objectKey.length > 260 ||
        !isValidLoopObjectKey(objectKey)
      ) {
        throw new Error(`${label}.objectKey is invalid.`);
      }
    }
    if (
      value.bankId !== undefined &&
      (typeof value.bankId !== "string" || value.bankId.length > 96)
    ) {
      throw new Error(`${label}.bankId is invalid.`);
    }
    if (
      value.license !== undefined &&
      (typeof value.license !== "string" || value.license.length > 160)
    ) {
      throw new Error(`${label}.license is invalid.`);
    }
    if (
      value.chopMode !== undefined &&
      (typeof value.chopMode !== "string" || value.chopMode.length > 32)
    ) {
      throw new Error(`${label}.chopMode is invalid.`);
    }
    if (value.padLabels !== undefined) {
      if (!Array.isArray(value.padLabels) || value.padLabels.length > 256) {
        throw new Error(`${label}.padLabels is invalid.`);
      }
      for (const padLabel of value.padLabels) {
        if (typeof padLabel !== "string" || padLabel.length > 24) {
          throw new Error(`${label}.padLabels is invalid.`);
        }
      }
    }
  }
  const sampleRate = value.sampleRate;
  const channels = value.channels;
  const frames = value.frames;
  if (
    !isFiniteNumber(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 192_000 ||
    !Number.isInteger(channels) ||
    (channels as number) < 1 ||
    (channels as number) > 2 ||
    !Number.isInteger(frames) ||
    (frames as number) < 1 ||
    (frames as number) > 192_000 * 90
  ) {
    throw new Error(`${label} audio metadata is invalid.`);
  }
  if (!Array.isArray(value.slices) || value.slices.length < 1 || value.slices.length > 256) {
    throw new Error(`${label}.slices must contain one to two hundred fifty-six slices.`);
  }
  for (const slice of value.slices) {
    if (!isObject(slice)) {
      throw new Error(`${label}.slices contains an invalid slice.`);
    }
    const index = slice.index;
    const startFrame = slice.startFrame;
    const endFrame = slice.endFrame;
    const output = slice.output;
    if (
      !Number.isInteger(index) ||
      (index as number) < 0 ||
      (index as number) > 255 ||
      !Number.isInteger(startFrame) ||
      !Number.isInteger(endFrame) ||
      (startFrame as number) < 0 ||
      (endFrame as number) <= (startFrame as number) ||
      (endFrame as number) > (frames as number) ||
      (output !== undefined &&
        (!Number.isInteger(output) ||
          (output as number) < 0 ||
          (output as number) > 11))
    ) {
      throw new Error(`${label}.slices contains invalid frame bounds.`);
    }
  }
}

function assertValidModuleText(value: unknown, label: string) {
  if (!isObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (value.version !== 1) {
    throw new Error(`${label} has an unsupported format.`);
  }
  if (value.kind === "loop") {
    assertValidLoopText(value, label);
    return;
  }
  if (value.kind !== "choir") {
    throw new Error(`${label} has an unsupported format.`);
  }
  if (!Array.isArray(value.phrases)) {
    throw new Error(`${label}.phrases must be an array.`);
  }
  if (value.phrases.length > 128) {
    throw new Error(`${label}.phrases has too many entries.`);
  }
  for (const phrase of value.phrases) {
    if (typeof phrase !== "string" || phrase.length > 280) {
      throw new Error(`${label}.phrases contains an invalid phrase.`);
    }
  }
}

function assertValidLoopText(value: Record<string, unknown>, label: string) {
  if (!Array.isArray(value.slotLabels)) {
    throw new Error(`${label}.slotLabels must be an array.`);
  }
  if (value.slotLabels.length > 8) {
    throw new Error(`${label}.slotLabels has too many entries.`);
  }
  for (const slotLabel of value.slotLabels) {
    if (typeof slotLabel !== "string" || slotLabel.length > 32) {
      throw new Error(`${label}.slotLabels contains an invalid label.`);
    }
  }
}

function assertValidLoopSample(value: Record<string, unknown>, label: string) {
  if (
    typeof value.assetId !== "string" ||
    value.assetId.length < 8 ||
    value.assetId.length > 120
  ) {
    throw new Error(`${label}.assetId is invalid.`);
  }
  if (!Array.isArray(value.loops) || value.loops.length > 32) {
    throw new Error(`${label}.loops must contain up to thirty-two loops.`);
  }
  const seenSlots = new Set<string>();
  for (const loop of value.loops) {
    if (!isObject(loop)) {
      throw new Error(`${label}.loops contains an invalid loop.`);
    }
    const slot = loop.slot;
    const clip = loop.clip;
    const objectKey = loop.objectKey;
    const name = loop.name;
    const sampleRate = loop.sampleRate;
    const frames = loop.frames;
    const mode = loop.mode;
    const bars = loop.bars;
    const stretch = loop.stretch;
    const createdAt = loop.createdAt;
    if (
      !Number.isInteger(slot) ||
      (slot as number) < 0 ||
      (slot as number) > 7 ||
      !Number.isInteger(clip) ||
      (clip as number) < 0 ||
      (clip as number) > 3 ||
      seenSlots.has(`${slot}:${clip}`)
    ) {
      throw new Error(`${label}.loops contains an invalid slot.`);
    }
    seenSlots.add(`${slot}:${clip}`);
    if (
      typeof objectKey !== "string" ||
      objectKey.length < 12 ||
      objectKey.length > 260 ||
      !isValidLoopObjectKey(objectKey)
    ) {
      throw new Error(`${label}.loops contains an invalid object key.`);
    }
    if (typeof name !== "string" || name.length > 96) {
      throw new Error(`${label}.loops contains an invalid name.`);
    }
    if (
      !isFiniteNumber(sampleRate) ||
      sampleRate < 8_000 ||
      sampleRate > 192_000 ||
      !Number.isInteger(frames) ||
      (frames as number) < 1 ||
      (frames as number) > 192_000 * 90 ||
      (mode !== "free" && mode !== "bars") ||
      !Number.isInteger(bars) ||
      (bars as number) < 0 ||
      (bars as number) > 128 ||
      (mode === "free" && bars !== 0) ||
      (mode === "bars" && bars === 0) ||
      typeof loop.reverse !== "boolean" ||
      (stretch !== 0.5 && stretch !== 1 && stretch !== 2) ||
      typeof createdAt !== "string" ||
      createdAt.length > 64
    ) {
      throw new Error(`${label}.loops contains invalid loop metadata.`);
    }
  }
}

function isValidLoopObjectKey(objectKey: string) {
  return (
    objectKey.endsWith(".wav") &&
    (objectKey.startsWith("users/") || objectKey.startsWith("local/loops/")) &&
    !objectKey.includes("..")
  );
}

function assertValidCable(
  id: string,
  cable: PatchCable,
  document: SessionDocumentV2,
) {
  if (!isObject(cable) || cable.id !== id) {
    throw new Error(`Invalid cable "${id}".`);
  }
  assertValidEndpoint(cable.from, "output", document);
  assertValidEndpoint(cable.to, "input", document);
}

function assertSingleCablePerJack(document: SessionDocumentV2) {
  const occupied = new Map<string, string>();
  for (const cableId of document.cableOrder) {
    const cable = document.cablesById[cableId];
    for (const endpoint of [cable.from, cable.to]) {
      const key = cableEndpointKey(endpoint);
      const existingCableId = occupied.get(key);
      if (existingCableId) {
        throw new Error(
          `Cable jack is already connected by "${existingCableId}" and "${cableId}".`,
        );
      }
      occupied.set(key, cableId);
    }
  }
}

function cableEndpointKey(endpoint: PatchCable["from"]) {
  return `${endpoint.direction}:${endpoint.moduleId}:${endpoint.jackId}`;
}

function assertValidEndpoint(
  endpoint: PatchCable["from"],
  direction: "input" | "output",
  document: SessionDocumentV2,
) {
  if (!isObject(endpoint)) {
    throw new Error("Invalid cable endpoint.");
  }
  if (endpoint.direction !== direction || !JACK_DIRECTIONS.has(endpoint.direction)) {
    throw new Error("Invalid cable endpoint direction.");
  }
  if (!SIGNAL_KINDS.has(endpoint.kind)) {
    throw new Error("Invalid cable endpoint kind.");
  }
  if (!Number.isInteger(endpoint.moduleId) || !Number.isInteger(endpoint.jackId)) {
    throw new Error("Invalid cable endpoint ids.");
  }
  const moduleId = String(endpoint.moduleId);
  if (!document.modulesById[moduleId] && !document.systemModulesById[moduleId]) {
    throw new Error("Cable endpoint references a missing module.");
  }
}

function assertOrderMatchesRecord<T>(
  order: string[],
  record: Record<string, T>,
  name: string,
) {
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) {
      throw new Error(`${name} contains duplicate ids.`);
    }
    seen.add(id);
    if (!(id in record)) {
      throw new Error(`${name} references missing id "${id}".`);
    }
  }
  if (Object.keys(record).length !== order.length) {
    throw new Error(`${name} does not include every record id.`);
  }
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isSafeIntegerString(value: string) {
  return /^(0|[1-9]\d*)$/.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}
