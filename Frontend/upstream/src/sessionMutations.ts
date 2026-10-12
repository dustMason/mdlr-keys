import type {
  ModuleSampleState,
  ModuleTextState,
  PatchCable,
  RackModuleState,
} from "./modules/types";
import {
  compactSparseParamsForKind,
  sparseDefaultParamValue,
} from "./modules/sparseParams";
import {
  applySessionPatch,
  type SessionDocumentV2,
  type SessionPatch,
} from "./sessionDocument";

export type SessionMutation =
  | { type: "setTempo"; tempoBpm: number }
  | {
      type: "setModuleParam";
      moduleId: number;
      paramId: number;
      value: number;
    }
  | {
      type: "setModuleParams";
      moduleId: number;
      values: Record<number, number>;
    }
  | {
      type: "setModuleLabel";
      moduleId: number;
      label: string | undefined;
    }
  | {
      type: "setModuleSample";
      moduleId: number;
      sample: ModuleSampleState | undefined;
    }
  | {
      type: "setModuleText";
      moduleId: number;
      text: ModuleTextState | undefined;
    }
  | { type: "addModule"; module: RackModuleState; index?: number }
  | { type: "deleteModule"; moduleId: number }
  | { type: "setRackOrder"; moduleIds: number[] }
  | { type: "upsertCable"; cable: PatchCable }
  | { type: "removeCable"; cableId: string };

export function appendSessionMutation(
  mutations: readonly SessionMutation[],
  mutation: SessionMutation,
) {
  const next = mutations.filter(
    (candidate) => !canCoalesceSessionMutation(candidate, mutation),
  );
  next.push(cloneSessionMutation(mutation));
  return next;
}

export function removeAppliedSessionMutations(
  mutations: readonly SessionMutation[],
  appliedMutations: readonly SessionMutation[],
) {
  if (appliedMutations.length === 0 || mutations.length === 0) {
    return [...mutations];
  }

  const applied = new Set<SessionMutation>(appliedMutations);
  return mutations.filter((mutation) => !applied.has(mutation));
}

export function sessionMutationsToPatch(
  document: SessionDocumentV2,
  mutations: readonly SessionMutation[],
): SessionPatch {
  let currentDocument = document;
  const patch: SessionPatch = [];

  for (const mutation of mutations) {
    const mutationPatch = sessionMutationToPatch(currentDocument, mutation);
    if (mutationPatch.length === 0) {
      continue;
    }
    patch.push(...mutationPatch);
    currentDocument = applySessionPatch(currentDocument, mutationPatch);
  }

  return patch;
}

export function applySessionMutations(
  document: SessionDocumentV2,
  mutations: readonly SessionMutation[],
) {
  const patch = sessionMutationsToPatch(document, mutations);
  return patch.length === 0 ? document : applySessionPatch(document, patch);
}

export function rebaseableSessionMutationsToPatch(
  document: SessionDocumentV2,
  mutations: readonly SessionMutation[],
) {
  if (!mutations.every(isRebaseableSessionMutation)) {
    return null;
  }
  return sessionMutationsToPatch(document, mutations);
}

export function sessionMutationToPatch(
  document: SessionDocumentV2,
  mutation: SessionMutation,
): SessionPatch {
  switch (mutation.type) {
    case "setTempo":
      return setTempoPatch(document, mutation.tempoBpm);
    case "setModuleParam":
      return setModuleParamPatch(
        document,
        mutation.moduleId,
        mutation.paramId,
        mutation.value,
      );
    case "setModuleParams":
      return setModuleParamsPatch(document, mutation.moduleId, mutation.values);
    case "setModuleLabel":
      return setOptionalModuleFieldPatch(
        document,
        mutation.moduleId,
        "label",
        mutation.label,
      );
    case "setModuleSample":
      return setOptionalModuleFieldPatch(
        document,
        mutation.moduleId,
        "sample",
        mutation.sample,
      );
    case "setModuleText":
      return setOptionalModuleFieldPatch(
        document,
        mutation.moduleId,
        "text",
        mutation.text,
      );
    case "addModule":
      return addModulePatch(document, mutation.module, mutation.index);
    case "deleteModule":
      return deleteModulePatch(document, mutation.moduleId);
    case "setRackOrder":
      return setRackOrderPatch(document, mutation.moduleIds);
    case "upsertCable":
      return upsertCablePatch(document, mutation.cable);
    case "removeCable":
      return removeCablePatch(document, mutation.cableId);
    default:
      return assertNever(mutation);
  }
}

export function sessionParamPatchOperation(
  document: SessionDocumentV2,
  moduleId: number,
  paramId: number,
  value: number,
): SessionPatch[number] | null {
  const patch = setModuleParamPatch(document, moduleId, paramId, value);
  return patch[0] ?? null;
}

function setTempoPatch(document: SessionDocumentV2, tempoBpm: number): SessionPatch {
  if (!Number.isFinite(tempoBpm) || Object.is(document.tempoBpm, tempoBpm)) {
    return [];
  }
  return [{ op: "replace", path: "/tempoBpm", value: tempoBpm }];
}

function setModuleParamPatch(
  document: SessionDocumentV2,
  moduleId: number,
  paramId: number,
  value: number,
): SessionPatch {
  if (
    !Number.isInteger(moduleId) ||
    !Number.isInteger(paramId) ||
    !Number.isFinite(value)
  ) {
    return [];
  }

  const target = moduleTarget(document, moduleId);
  if (!target) {
    return [];
  }

  const paramKey = String(paramId);
  const hasParam = Object.prototype.hasOwnProperty.call(
    target.module.params,
    paramKey,
  );
  const defaultValue = sparseDefaultParamValue(target.module.kind, paramId);
  const path = `/${target.scope}/${pointerSegment(String(moduleId))}/params/${pointerSegment(paramKey)}`;
  if (defaultValue !== undefined && Object.is(value, defaultValue)) {
    return hasParam ? [{ op: "remove", path }] : [];
  }
  if (!hasParam && target.scope === "systemModulesById") {
    return [];
  }
  if (hasParam && Object.is(target.module.params[paramId], value)) {
    return [];
  }

  return [
    {
      op: hasParam ? "replace" : "add",
      path,
      value,
    },
  ];
}

function setModuleParamsPatch(
  document: SessionDocumentV2,
  moduleId: number,
  values: Record<number, number>,
): SessionPatch {
  let currentDocument = document;
  const patch: SessionPatch = [];
  for (const [paramId, value] of Object.entries(values)
    .map(([key, rawValue]) => [Number(key), rawValue] as const)
    .filter(([paramId, value]) => Number.isInteger(paramId) && Number.isFinite(value))
    .sort(([left], [right]) => left - right)) {
    const paramPatch = setModuleParamPatch(
      currentDocument,
      moduleId,
      paramId,
      value,
    );
    if (paramPatch.length === 0) {
      continue;
    }
    patch.push(...paramPatch);
    currentDocument = applySessionPatch(currentDocument, paramPatch);
  }
  return patch;
}

function setOptionalModuleFieldPatch(
  document: SessionDocumentV2,
  moduleId: number,
  field: "label" | "sample" | "text",
  value: unknown,
): SessionPatch {
  const target = moduleTarget(document, moduleId);
  if (!target) {
    return [];
  }

  const currentValue = target.module[field];
  if (jsonSignature(currentValue) === jsonSignature(value)) {
    return [];
  }

  const path = `/${target.scope}/${pointerSegment(String(moduleId))}/${field}`;
  if (value === undefined) {
    return currentValue === undefined ? [] : [{ op: "remove", path }];
  }

  return [
    {
      op: currentValue === undefined ? "add" : "replace",
      path,
      value,
    },
  ];
}

function addModulePatch(
  document: SessionDocumentV2,
  module: RackModuleState,
  index = document.rackOrder.length,
): SessionPatch {
  if (!Number.isInteger(module.id) || module.id <= 0) {
    return [];
  }

  const moduleId = String(module.id);
  const existing = document.modulesById[moduleId];
  const moduleValue = moduleForSessionDocument(module);
  const rackOrderWithoutModule = document.rackOrder.filter(
    (candidate) => candidate !== moduleId,
  );
  const nextRackOrder = insertAt(
    rackOrderWithoutModule,
    moduleId,
    Math.max(0, Math.min(index, rackOrderWithoutModule.length)),
  );
  const patch: SessionPatch = [
    {
      op: existing ? "replace" : "add",
      path: `/modulesById/${pointerSegment(moduleId)}`,
      value: moduleValue,
    },
  ];
  if (!stringArraysEqual(document.rackOrder, nextRackOrder)) {
    patch.push({ op: "replace", path: "/rackOrder", value: nextRackOrder });
  }
  return patch;
}

function deleteModulePatch(document: SessionDocumentV2, moduleId: number): SessionPatch {
  const id = String(moduleId);
  if (!document.modulesById[id]) {
    return [];
  }

  const removedCableIds = document.cableOrder.filter((cableId) => {
    const cable = document.cablesById[cableId];
    return (
      cable?.from.moduleId === moduleId ||
      cable?.to.moduleId === moduleId
    );
  });
  const nextCableOrder = document.cableOrder.filter(
    (cableId) => !removedCableIds.includes(cableId),
  );
  const nextRackOrder = document.rackOrder.filter((candidate) => candidate !== id);
  const patch: SessionPatch = [];

  if (!stringArraysEqual(document.rackOrder, nextRackOrder)) {
    patch.push({ op: "replace", path: "/rackOrder", value: nextRackOrder });
  }
  if (!stringArraysEqual(document.cableOrder, nextCableOrder)) {
    patch.push({ op: "replace", path: "/cableOrder", value: nextCableOrder });
  }
  for (const cableId of removedCableIds) {
    patch.push({
      op: "remove",
      path: `/cablesById/${pointerSegment(cableId)}`,
    });
  }
  patch.push({ op: "remove", path: `/modulesById/${pointerSegment(id)}` });
  return patch;
}

function setRackOrderPatch(
  document: SessionDocumentV2,
  moduleIds: readonly number[],
): SessionPatch {
  const requestedIds = moduleIds.map(String);
  if (
    requestedIds.length !== document.rackOrder.length ||
    requestedIds.some((id) => !document.modulesById[id])
  ) {
    return [];
  }
  if (stringArraysEqual(document.rackOrder, requestedIds)) {
    return [];
  }
  return [{ op: "replace", path: "/rackOrder", value: requestedIds }];
}

function upsertCablePatch(document: SessionDocumentV2, cable: PatchCable): SessionPatch {
  if (!cable.id) {
    return [];
  }

  const existingCableIndex = document.cableOrder.indexOf(cable.id);
  const duplicateCableIds = document.cableOrder.filter((cableId) => {
    const candidate = document.cablesById[cableId];
    return candidate && cableId !== cable.id && cablesShareJack(candidate, cable);
  });
  const nextCableOrder = document.cableOrder.filter(
    (cableId) => cableId !== cable.id && !duplicateCableIds.includes(cableId),
  );
  const insertIndex =
    existingCableIndex === -1
      ? nextCableOrder.length
      : Math.min(existingCableIndex, nextCableOrder.length);
  nextCableOrder.splice(insertIndex, 0, cable.id);

  const patch: SessionPatch = [];
  for (const cableId of duplicateCableIds) {
    patch.push({
      op: "remove",
      path: `/cablesById/${pointerSegment(cableId)}`,
    });
  }
  patch.push({
    op: document.cablesById[cable.id] ? "replace" : "add",
    path: `/cablesById/${pointerSegment(cable.id)}`,
    value: cloneCable(cable),
  });
  if (!stringArraysEqual(document.cableOrder, nextCableOrder)) {
    patch.push({ op: "replace", path: "/cableOrder", value: nextCableOrder });
  }
  return patch;
}

function removeCablePatch(document: SessionDocumentV2, cableId: string): SessionPatch {
  if (!document.cablesById[cableId]) {
    return [];
  }
  const nextCableOrder = document.cableOrder.filter((candidate) => candidate !== cableId);
  const patch: SessionPatch = [];
  if (!stringArraysEqual(document.cableOrder, nextCableOrder)) {
    patch.push({ op: "replace", path: "/cableOrder", value: nextCableOrder });
  }
  patch.push({ op: "remove", path: `/cablesById/${pointerSegment(cableId)}` });
  return patch;
}

function isRebaseableSessionMutation(mutation: SessionMutation) {
  return (
    mutation.type === "setModuleParam" ||
    mutation.type === "setModuleParams" ||
    mutation.type === "setModuleSample"
  );
}

function canCoalesceSessionMutation(
  existing: SessionMutation,
  next: SessionMutation,
) {
  if (existing.type !== next.type) {
    return false;
  }
  switch (existing.type) {
    case "setTempo":
    case "setRackOrder":
      return true;
    case "setModuleParam":
      return (
        next.type === "setModuleParam" &&
        existing.moduleId === next.moduleId &&
        existing.paramId === next.paramId
      );
    case "setModuleParams":
      return next.type === "setModuleParams" && existing.moduleId === next.moduleId;
    case "setModuleLabel":
    case "setModuleSample":
    case "setModuleText":
      return (
        (next.type === "setModuleLabel" ||
          next.type === "setModuleSample" ||
          next.type === "setModuleText") &&
        existing.moduleId === next.moduleId
      );
    case "addModule":
      return next.type === "addModule" && existing.module.id === next.module.id;
    case "deleteModule":
      return next.type === "deleteModule" && existing.moduleId === next.moduleId;
    case "upsertCable":
      return next.type === "upsertCable" && existing.cable.id === next.cable.id;
    case "removeCable":
      return next.type === "removeCable" && existing.cableId === next.cableId;
    default:
      return assertNever(existing);
  }
}

function cloneSessionMutation(mutation: SessionMutation): SessionMutation {
  switch (mutation.type) {
    case "setTempo":
    case "setModuleParam":
    case "deleteModule":
    case "removeCable":
      return { ...mutation };
    case "setRackOrder":
      return { ...mutation, moduleIds: [...mutation.moduleIds] };
    case "setModuleParams":
      return { ...mutation, values: { ...mutation.values } };
    case "setModuleLabel":
      return { ...mutation };
    case "setModuleSample":
      return {
        ...mutation,
        sample: cloneModuleSample(mutation.sample),
      };
    case "setModuleText":
      return {
        ...mutation,
        text: cloneModuleText(mutation.text),
      };
    case "addModule":
      return { ...mutation, module: cloneModule(mutation.module) };
    case "upsertCable":
      return { ...mutation, cable: cloneCable(mutation.cable) };
    default:
      return assertNever(mutation);
  }
}

function moduleTarget(document: SessionDocumentV2, moduleId: number) {
  const id = String(moduleId);
  const module = document.modulesById[id];
  if (module) {
    return { scope: "modulesById" as const, module };
  }
  const systemModule = document.systemModulesById[id];
  if (systemModule) {
    return { scope: "systemModulesById" as const, module: systemModule };
  }
  return null;
}

function moduleForSessionDocument(module: RackModuleState) {
  const {
    x: _x,
    y: _y,
    collapsed: _collapsed,
    sample,
    text,
    params,
    ...shared
  } = module;
  return {
    ...shared,
    params: compactSparseParamsForKind(module.kind, params),
    ...(sample !== undefined ? { sample: cloneModuleSample(sample) } : {}),
    ...(text !== undefined ? { text: cloneModuleText(text) } : {}),
  };
}

function cloneModule(module: RackModuleState): RackModuleState {
  return {
    ...module,
    params: { ...module.params },
    sample: cloneModuleSample(module.sample),
    text: cloneModuleText(module.text),
  };
}

function cloneModuleSample(sample: ModuleSampleState | undefined) {
  if (!sample) {
    return undefined;
  }
  if (sample.kind === "loop") {
    return {
      ...sample,
      loops: sample.loops.map((loop) => ({ ...loop })),
    };
  }
  return {
    ...sample,
    slices: sample.slices.map((slice) => ({ ...slice })),
    ...(sample.kind === "sampler" && sample.padLabels
      ? { padLabels: [...sample.padLabels] }
      : {}),
  };
}

function cloneModuleText(text: ModuleTextState | undefined) {
  if (!text) {
    return undefined;
  }
  if (text.kind === "loop") {
    return {
      ...text,
      slotLabels: [...text.slotLabels],
    };
  }
  return {
    ...text,
    phrases: [...text.phrases],
  };
}

function cloneCable(cable: PatchCable): PatchCable {
  return {
    id: cable.id,
    from: { ...cable.from },
    to: { ...cable.to },
  };
}

function cablesShareJack(left: PatchCable, right: PatchCable) {
  return (
    cableEndpointKey(left.from) === cableEndpointKey(right.from) ||
    cableEndpointKey(left.from) === cableEndpointKey(right.to) ||
    cableEndpointKey(left.to) === cableEndpointKey(right.from) ||
    cableEndpointKey(left.to) === cableEndpointKey(right.to)
  );
}

function cableEndpointKey(endpoint: PatchCable["from"]) {
  return `${endpoint.direction}:${endpoint.moduleId}:${endpoint.jackId}`;
}

function insertAt<T>(items: readonly T[], item: T, index: number) {
  const next = [...items];
  next.splice(index, 0, item);
  return next;
}

function pointerSegment(segment: string) {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

function stringArraysEqual(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function jsonSignature(value: unknown) {
  return value === undefined ? "" : JSON.stringify(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session mutation ${(value as { type?: string }).type}`);
}
