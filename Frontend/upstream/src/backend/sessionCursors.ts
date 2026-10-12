import { pb } from "./pocketbase";
import type { SessionPatch } from "../sessionDocument";

export type SessionCursorMode = "control" | "patch";
export type SessionCursorState = "move" | "down" | "drag" | "up" | "leave";

export interface LocalSessionCursor {
  targetPath: string;
  mode: SessionCursorMode;
  state: SessionCursorState;
  x?: number;
  y?: number;
}

export interface RemoteSessionCursor extends LocalSessionCursor {
  type: "cursor";
  clientId: string;
  userId: string;
  username: string;
  at: number;
}

export interface RemoteSessionCursorLeave {
  type: "cursor_leave";
  clientId: string;
  userId?: string;
  username?: string;
  at: number;
}

export interface RemoteSessionUpdate {
  type: "session_update";
  slug: string;
  baseHash: string;
  hash: string;
  patch: SessionPatch;
  authorId?: string;
  clientId?: string;
  at?: number;
}

export interface RemoteSessionPreview {
  type: "session_preview";
  slug: string;
  patch: SessionPatch;
  clientId: string;
  userId?: string;
  username?: string;
  at: number;
}

export interface RemoteSessionPresence {
  type: "session_presence";
  slug: string;
  connections: number;
  at: number;
}

export type RemoteSessionCursorEvent =
  | RemoteSessionCursor
  | RemoteSessionCursorLeave;

export type SessionSocketEvent =
  | RemoteSessionCursorEvent
  | RemoteSessionUpdate
  | RemoteSessionPreview
  | RemoteSessionPresence;

export function openSessionCursorSocket(slug: string, clientId: string) {
  const token = pb.authStore.token;
  if (!slug || !token) {
    return null;
  }

  const httpUrl = new URL(
    pb.buildURL(`/api/app/sessions/${encodeURIComponent(slug)}/cursors`),
  );
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  httpUrl.searchParams.set("clientId", clientId);
  return new WebSocket(httpUrl, ["modular-cursor", `pb-auth.${token}`]);
}
