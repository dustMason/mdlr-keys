import type {
  LoopExport,
  LoopRuntimeSampleAsset,
  LoopRuntimeSlot,
  LoopSampleState,
  LoopSlotState,
} from "../modules/types";
import { pb } from "../backend/pocketbase";

const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_FLOAT = 3;
const LOOP_ASSET_PREFIX = "loop";
const LOOP_TRACKS = 8;
const LOOP_CLIPS_PER_TRACK = 4;
const LOCAL_LOOP_OBJECT_PREFIX = "local/loops/";
const LOCAL_LOOP_DB_NAME = "modular-local-loops";
const LOCAL_LOOP_DB_VERSION = 1;
const LOCAL_LOOP_OBJECT_STORE = "objects";

interface LoopUploadResponse {
  objectKey: string;
  name: string;
  slot: number;
  clip: number;
  sampleRate: number;
  channels: 2;
  frames: number;
  mode: "free" | "bars";
  bars: number;
  reverse: boolean;
  stretch: 0.5 | 1 | 2;
  createdAt: string;
}

export interface LoopUploadOptions {
  name: string;
  track: number;
  clip: number;
  reverse: boolean;
  stretch: 0.5 | 1 | 2;
}

export async function uploadLoopSlot(
  exported: LoopExport,
  options: LoopUploadOptions,
): Promise<LoopSlotState> {
  const exportedBars = normalizeLoopBars(exported.bars);
  const wav = encodeStereoWav(exported.left, exported.right, exported.sampleRate);
  const form = new FormData();
  form.set("file", wav, `loop-${options.track + 1}-${options.clip + 1}.wav`);
  form.set(
    "metadata",
    JSON.stringify({
      name: options.name,
      slot: options.track,
      clip: options.clip,
      sampleRate: exported.sampleRate,
      frames: exported.frames,
      mode: exportedBars > 0 ? "bars" : "free",
      bars: exportedBars,
      reverse: options.reverse,
      stretch: options.stretch,
    }),
  );

  const response = await fetch(`${pb.baseUrl}/api/app/loops`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!response.ok) {
    throw new Error(await responseError(response, "Could not save loop."));
  }

  const uploaded = (await response.json()) as LoopUploadResponse;
  const uploadedSlot = finiteNumberOr(uploaded.slot, options.track);
  const uploadedClip = finiteNumberOr(uploaded.clip, options.clip);
  const uploadedMode = uploaded.mode === "bars" ? "bars" : "free";
  const uploadedBars =
    uploadedMode === "bars"
      ? normalizeLoopBars(uploaded.bars || exportedBars)
      : 0;
  if (!uploaded.objectKey) {
    throw new Error("Loop upload response was missing an object key.");
  }
  return {
    slot: clampSlot(uploadedSlot),
    clip: clampClip(uploadedClip),
    objectKey: uploaded.objectKey,
    name: uploaded.name || options.name || `loop ${options.track + 1}.${options.clip + 1}`,
    sampleRate: finiteNumberOr(uploaded.sampleRate, exported.sampleRate),
    channels: 2,
    frames: Math.max(1, Math.round(finiteNumberOr(uploaded.frames, exported.frames))),
    mode: uploadedMode,
    bars: uploadedBars,
    reverse: typeof uploaded.reverse === "boolean" ? uploaded.reverse : options.reverse,
    stretch: normalizeStoredStretch(uploaded.stretch, options.stretch),
    createdAt: uploaded.createdAt || new Date().toISOString(),
  };
}

export async function saveLocalLoopSlot(
  exported: LoopExport,
  options: LoopUploadOptions,
): Promise<LoopSlotState> {
  const exportedBars = normalizeLoopBars(exported.bars);
  const wav = encodeStereoWav(exported.left, exported.right, exported.sampleRate);
  const objectKey = `${LOCAL_LOOP_OBJECT_PREFIX}${localLoopId()}.wav`;
  await putLocalLoopObject(objectKey, await wav.arrayBuffer());
  return {
    slot: clampSlot(options.track),
    clip: clampClip(options.clip),
    objectKey,
    name: options.name || `loop ${options.track + 1}.${options.clip + 1}`,
    sampleRate: exported.sampleRate,
    channels: 2,
    frames: exported.frames,
    mode: exportedBars > 0 ? "bars" : "free",
    bars: exportedBars,
    reverse: options.reverse,
    stretch: options.stretch,
    createdAt: new Date().toISOString(),
  };
}

export async function loadLoopRuntimeAsset(
  sample: LoopSampleState,
): Promise<LoopRuntimeSampleAsset> {
  const loops = await Promise.all(sample.loops.map(loadRuntimeSlot));
  return {
    kind: "loop",
    assetId: sample.assetId,
    loops,
  };
}

export function loopSampleWithSlot(
  current: LoopSampleState | undefined,
  slot: LoopSlotState,
): LoopSampleState {
  const loops = [
    ...(current?.kind === "loop" ? current.loops : []).filter(
      (candidate) =>
        loopCellIndex(candidate.slot, candidate.clip) !==
        loopCellIndex(slot.slot, slot.clip),
    ),
    slot,
  ].sort(compareLoopSlots);
  return {
    version: 1,
    kind: "loop",
    assetId: loopAssetId(loops),
    loops,
  };
}

export function loopSampleWithoutSlot(
  current: LoopSampleState | undefined,
  slot: number,
  clip: number,
): LoopSampleState | undefined {
  const loops = (current?.kind === "loop" ? current.loops : [])
    .filter(
      (candidate) =>
        loopCellIndex(candidate.slot, candidate.clip) !== loopCellIndex(slot, clip),
    )
    .sort(compareLoopSlots);
  if (loops.length === 0) {
    return undefined;
  }
  return {
    version: 1,
    kind: "loop",
    assetId: loopAssetId(loops),
    loops,
  };
}

async function loadRuntimeSlot(loop: LoopSlotState): Promise<LoopRuntimeSlot> {
  const buffer = isLocalLoopObjectKey(loop.objectKey)
    ? await getLocalLoopObject(loop.objectKey)
    : await fetchLoopObject(loop);

  const decoded = decodeStereoWav(buffer);
  return {
    slot: loopCellIndex(loop.slot, loop.clip),
    clip: clampClip(loop.clip),
    objectKey: loop.objectKey,
    bars: normalizeLoopBars(loop.bars),
    sampleRate: decoded.sampleRate,
    frames: decoded.frames,
    left: decoded.left,
    right: decoded.right,
  };
}

async function fetchLoopObject(loop: LoopSlotState) {
  const response = await fetch(loopObjectUrl(loop.objectKey), {
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(await responseError(response, `Could not load ${loop.name}.`));
  }
  return response.arrayBuffer();
}

function encodeStereoWav(
  left: Float32Array,
  right: Float32Array,
  sampleRate: number,
) {
  const frames = Math.min(left.length, right.length);
  const bytesPerSample = 2;
  const blockAlign = 2 * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeASCII(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeASCII(view, 8, "WAVE");
  writeASCII(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAV_FORMAT_PCM, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeASCII(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    view.setInt16(offset, floatToI16(left[frame]), true);
    offset += 2;
    view.setInt16(offset, floatToI16(right[frame]), true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function decodeStereoWav(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  if (readASCII(view, 0, 4) !== "RIFF" || readASCII(view, 8, 4) !== "WAVE") {
    throw new Error("Loop audio is not a WAV file.");
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const chunkId = readASCII(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkData = offset + 8;
    if (chunkId === "fmt ") {
      format = view.getUint16(chunkData, true);
      channels = view.getUint16(chunkData + 2, true);
      sampleRate = view.getUint32(chunkData + 4, true);
      bitsPerSample = view.getUint16(chunkData + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkData;
      dataBytes = chunkSize;
    }
    offset = chunkData + chunkSize + (chunkSize % 2);
  }

  if (channels !== 2 || sampleRate <= 0 || dataBytes <= 0) {
    throw new Error("Loop WAV must be stereo audio.");
  }
  const bytesPerSample = bitsPerSample / 8;
  const frames = Math.floor(dataBytes / (channels * bytesPerSample));
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  let read = dataOffset;
  for (let frame = 0; frame < frames; frame += 1) {
    left[frame] = readWavSample(view, read, format, bitsPerSample);
    read += bytesPerSample;
    right[frame] = readWavSample(view, read, format, bitsPerSample);
    read += bytesPerSample;
  }
  return { sampleRate, frames, left, right };
}

function readWavSample(
  view: DataView,
  offset: number,
  format: number,
  bitsPerSample: number,
) {
  if (format === WAV_FORMAT_FLOAT && bitsPerSample === 32) {
    return sanitizeSample(view.getFloat32(offset, true));
  }
  if (format === WAV_FORMAT_PCM && bitsPerSample === 16) {
    return view.getInt16(offset, true) / 32768;
  }
  if (format === WAV_FORMAT_PCM && bitsPerSample === 24) {
    const value =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getInt8(offset + 2) << 16);
    return sanitizeSample(value / 8388608);
  }
  if (format === WAV_FORMAT_PCM && bitsPerSample === 32) {
    return sanitizeSample(view.getInt32(offset, true) / 2147483648);
  }
  throw new Error("Unsupported loop WAV format.");
}

function loopObjectUrl(objectKey: string) {
  return `${pb.baseUrl}/api/app/loops/${objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function isLocalLoopObjectKey(objectKey: string) {
  return (
    objectKey.startsWith(LOCAL_LOOP_OBJECT_PREFIX) && objectKey.endsWith(".wav")
  );
}

async function putLocalLoopObject(objectKey: string, buffer: ArrayBuffer) {
  const db = await openLocalLoopDatabase();
  try {
    await transactionRequest(
      db
        .transaction(LOCAL_LOOP_OBJECT_STORE, "readwrite")
        .objectStore(LOCAL_LOOP_OBJECT_STORE)
        .put(buffer, objectKey),
    );
  } finally {
    db.close();
  }
}

async function getLocalLoopObject(objectKey: string) {
  const db = await openLocalLoopDatabase();
  try {
    const buffer = await transactionRequest<ArrayBuffer | undefined>(
      db
        .transaction(LOCAL_LOOP_OBJECT_STORE, "readonly")
        .objectStore(LOCAL_LOOP_OBJECT_STORE)
        .get(objectKey),
    );
    if (!buffer) {
      throw new Error("Local loop audio is missing.");
    }
    return buffer;
  } finally {
    db.close();
  }
}

function openLocalLoopDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(new Error("Local loop storage is not available."));
      return;
    }
    const request = globalThis.indexedDB.open(
      LOCAL_LOOP_DB_NAME,
      LOCAL_LOOP_DB_VERSION,
    );
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOCAL_LOOP_OBJECT_STORE)) {
        db.createObjectStore(LOCAL_LOOP_OBJECT_STORE);
      }
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open local loop storage."));
    request.onsuccess = () => resolve(request.result);
  });
}

function transactionRequest<T = unknown>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onerror = () =>
      reject(request.error ?? new Error("Local loop storage request failed."));
    request.onsuccess = () => resolve(request.result);
  });
}

function authHeaders() {
  return pb.authStore.token
    ? { Authorization: pb.authStore.token }
    : undefined;
}

async function responseError(response: Response, fallback: string) {
  try {
    const body = await response.json();
    return body?.message || body?.data?.message || fallback;
  } catch {
    return fallback;
  }
}

function loopAssetId(loops: LoopSlotState[]) {
  const signature = loops
    .map((loop) =>
      [
        loop.slot,
        clampClip(loop.clip),
        loop.objectKey,
        loop.frames,
        loop.mode,
        loop.bars,
        loop.reverse ? "r" : "f",
        loop.stretch,
      ].join(":"),
    )
    .join("|");
  return `${LOOP_ASSET_PREFIX}-${hashString(signature)}-${Date.now().toString(36)}`;
}

function localLoopId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function floatToI16(value: number) {
  const sample = sanitizeSample(value);
  return Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
}

function sanitizeSample(value: number) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function writeASCII(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function readASCII(view: DataView, offset: number, length: number) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function clampSlot(slot: number) {
  return Math.max(0, Math.min(LOOP_TRACKS - 1, Math.round(slot)));
}

function clampClip(clip: number) {
  return Math.max(0, Math.min(LOOP_CLIPS_PER_TRACK - 1, Math.round(clip)));
}

function finiteNumberOr(value: number, fallback: number) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeLoopBars(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(128, Math.round(value)));
}

function normalizeStoredStretch(
  value: number,
  fallback: 0.5 | 1 | 2,
): 0.5 | 1 | 2 {
  if (value === 0.5 || value === 1 || value === 2) {
    return value;
  }
  return fallback;
}

function loopCellIndex(slot: number, clip: number) {
  return clampSlot(slot) * LOOP_CLIPS_PER_TRACK + clampClip(clip);
}

function compareLoopSlots(first: LoopSlotState, second: LoopSlotState) {
  return (
    loopCellIndex(first.slot, first.clip) - loopCellIndex(second.slot, second.clip)
  );
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
