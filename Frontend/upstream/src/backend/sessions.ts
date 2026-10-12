import type { RecordModel } from "pocketbase";
import { pb } from "./pocketbase";
import type { SavedSession } from "../sessionTypes";
import {
  assertValidSessionDocument,
  documentToSessionParts,
  sessionDocumentHash,
  sessionPartsToDocument,
  type SessionDocumentV2,
  type SessionPatch,
} from "../sessionDocument";
import type { SessionMutation } from "../sessionMutations";
import type { PatchCable, RackModuleState } from "../modules/types";

const SESSION_COLLECTION = "sessions";

export interface SessionDocumentV1 {
  version: 1;
  systemModules?: RackModuleState[];
  modules: RackModuleState[];
  cables: PatchCable[];
}

export type SessionDraft = Omit<SavedSession, "id" | "slug"> & {
  slug?: string;
};

interface SessionRecord extends RecordModel {
  user: string;
  slug: string;
  name: string;
  description?: string;
  tempoBpm: number;
  document: SessionDocumentV2 | SessionDocumentV1 | string;
  hash?: string;
}

export async function fetchCurrentUserSessions() {
  const records = await pb.collection<SessionRecord>(SESSION_COLLECTION).getFullList({
    sort: "created",
  });

  return Promise.all(records.map((record) => recordToSavedSession(record)));
}

export async function fetchSessionBySlug(slug: string) {
  const record = await pb.send<SessionRecord>(
    `/api/app/sessions/${encodeURIComponent(slug)}`,
    { method: "GET" },
  );
  return recordToSavedSession(record, {
    readOnly: false,
  });
}

export async function createCurrentUserSession(session: SessionDraft) {
  const userId = pb.authStore.record?.id;
  if (!userId) {
    throw new Error("No authenticated user is available for session creation.");
  }

  const record = await pb.collection<SessionRecord>(SESSION_COLLECTION).create({
    user: userId,
    name: session.name,
    description: session.description,
    tempoBpm: session.tempoBpm,
    document: serializeSession(session),
  });

  return recordToSavedSession(record);
}

export async function deleteCurrentUserSession(sessionId: string) {
  await pb.collection<SessionRecord>(SESSION_COLLECTION).delete(sessionId);
}

export interface SessionUpdateResult {
  id: string;
  slug: string;
  document: SessionDocumentV2;
  hash: string;
  baseHash?: string;
  patch?: SessionPatch;
  tempoBpm: number;
  updated?: string;
}

export async function submitSessionUpdate(
  slug: string,
  baseHash: string,
  mutations: readonly SessionMutation[],
  clientId: string,
) {
  return pb.send<SessionUpdateResult>(
    `/api/app/sessions/${encodeURIComponent(slug)}/updates`,
    {
      method: "POST",
      body: {
        baseHash,
        mutations,
        clientId,
      },
      requestKey: null,
    },
  );
}

async function recordToSavedSession(
  record: SessionRecord,
  options: { readOnly?: boolean } = {},
): Promise<SavedSession> {
  const document = parseSessionDocument(record.document, Number(record.tempoBpm));
  const parts = documentToSessionParts(document);
  return {
    id: record.id,
    ownerId: record.user,
    readOnly: options.readOnly ?? false,
    documentHash: record.hash ?? (await sessionDocumentHash(document)),
    slug: record.slug,
    name: record.name,
    description: record.description ?? "",
    tempoBpm: parts.tempoBpm,
    systemModules: parts.systemModules,
    modules: parts.modules,
    cables: parts.cables,
  };
}

function serializeSession(session: SessionDraft | SavedSession): SessionDocumentV2 {
  return sessionPartsToDocument({
    tempoBpm: session.tempoBpm,
    systemModules: session.systemModules,
    modules: session.modules,
    cables: session.cables,
  });
}

function parseSessionDocument(
  raw: SessionRecord["document"],
  fallbackTempoBpm: number,
): SessionDocumentV2 {
  const document =
    typeof raw === "string"
      ? (JSON.parse(raw) as Partial<SessionDocumentV2 | SessionDocumentV1>)
      : raw;

  if (document?.version === 2) {
    return assertValidSessionDocument(document as SessionDocumentV2);
  }

  if (
    document?.version !== 1 ||
    (document.systemModules !== undefined &&
      !Array.isArray(document.systemModules)) ||
    !Array.isArray(document.modules) ||
    !Array.isArray(document.cables)
  ) {
    throw new Error("Unsupported session document format.");
  }

  return sessionPartsToDocument({
    tempoBpm: fallbackTempoBpm,
    systemModules: document.systemModules,
    modules: document.modules,
    cables: document.cables,
  });
}
