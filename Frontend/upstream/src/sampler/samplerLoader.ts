import { pb } from "../backend/pocketbase";
import { parseAIFF, type OP1DrumMetadata } from "../op1/aiff";
import type {
  ModuleSampleSlice,
  Op1DrumSampleState,
  SamplerRuntimeSampleAsset,
  SamplerSampleState,
} from "../modules/types";
import {
  DEFAULT_FACTORY_SAMPLE_BANK_ID,
  factorySampleBankById,
  padUrl,
  type FactorySampleBank,
} from "./factorySampleBanks";
import { parseWavMono } from "./wav";

const OP1_DRUM_UNITS_PER_SECOND = (2 ** 31 - 1) / 12;
const DEFAULT_OP1_PATCH_URL =
  "https://op1.fun/users/technoprick/patches/patch-drum-18385";
const FACTORY_GAP_SECONDS = 0.006;
const MAX_SAMPLER_SLICES = 256;
const DIRECT_OUTPUTS = 12;
const WAV_FORMAT_PCM = 1;
export const DEFAULT_TRANSIENT_SENSITIVITY = 0.55;

export type SamplerChopMode =
  | "beats-1"
  | "beats-2"
  | "beats-3"
  | "beats-4"
  | "beats-8"
  | "beats-16"
  | "transients";

export const SAMPLER_CHOP_MODES = [
  { value: "beats-1", label: "1 beat" },
  { value: "beats-2", label: "2 beats" },
  { value: "beats-3", label: "3 beats" },
  { value: "beats-4", label: "4 beats" },
  { value: "beats-8", label: "8 beats" },
  { value: "beats-16", label: "16 beats" },
  { value: "transients", label: "transients" },
] as const satisfies readonly { value: SamplerChopMode; label: string }[];

interface OP1PatchProxyResponse {
  id: string;
  name: string;
  patchType: string;
  sourceUrl: string;
  apiUrl: string;
  fileUrl: string;
  aiffBase64: string;
  marks?: [number, number][];
  frameCount?: number;
}

interface SamplerUploadResponse {
  objectKey: string;
  name: string;
  sampleRate: number;
  frames: number;
  createdAt: string;
}

export interface LoadedSamplerSample {
  sample: SamplerSampleState;
  asset: SamplerRuntimeSampleAsset;
}

export async function loadOP1SamplerPatch(
  patchUrl = DEFAULT_OP1_PATCH_URL,
): Promise<LoadedSamplerSample> {
  const proxy = await pb.send<OP1PatchProxyResponse>("/api/app/sampler/op1-patch", {
    method: "GET",
    query: { url: patchUrl },
    requestKey: null,
  });
  if (proxy.patchType !== "drum") {
    throw new Error(`op1.fun patch "${proxy.name}" is not a drum patch.`);
  }
  if (!proxy.aiffBase64) {
    throw new Error("op1.fun proxy response did not include AIFF audio.");
  }

  const bytes = base64ToBytes(proxy.aiffBase64);
  const parsed = parseAIFF(bytes.buffer);
  const slices = slicesFromOP1Metadata(
    parsed.metadata,
    proxy.marks,
    parsed.frames,
    parsed.sampleRate,
  );
  const padLabels = slices.map((_, index) => `${index + 1}`);
  const assetId = sampleAssetId("op1", proxy.id, proxy.fileUrl, parsed.frames, slices);

  const sample: SamplerSampleState = {
    version: 1,
    kind: "sampler",
    assetId,
    sourceType: "op1.fun",
    sourceUrl: proxy.sourceUrl || patchUrl,
    apiUrl: proxy.apiUrl,
    fileUrl: proxy.fileUrl,
    name: (parsed.metadata?.name || proxy.name || "op1 drum").slice(0, 160),
    sampleRate: parsed.sampleRate,
    channels: parsed.channels,
    frames: parsed.frames,
    slices,
    padLabels,
  };

  return {
    sample,
    asset: samplerAssetFromSample(sample, parsed.samples),
  };
}

export async function loadFactorySampleBank(
  bankId = DEFAULT_FACTORY_SAMPLE_BANK_ID,
): Promise<LoadedSamplerSample> {
  const bank = factorySampleBankById(bankId) ?? factorySampleBankById(DEFAULT_FACTORY_SAMPLE_BANK_ID);
  if (!bank) {
    throw new Error(`Unknown sampler bank "${bankId}".`);
  }

  const pads = await Promise.all(
    bank.pads.map(async (pad) => {
      const url = padUrl(bank, pad);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load ${bank.shortName} ${pad.label}.`);
      }
      const parsed = parseWavMono(await response.arrayBuffer(), `${bank.shortName} ${pad.label}`);
      return {
        label: pad.label,
        url,
        sampleRate: parsed.sampleRate,
        samples: parsed.samples,
      };
    }),
  );
  if (pads.length === 0) {
    throw new Error(`${bank.name} has no samples.`);
  }

  const sampleRate = pads[0].sampleRate;
  const gapFrames = Math.round(sampleRate * FACTORY_GAP_SECONDS);
  const resampled = pads.map((pad) => ({
    ...pad,
    samples: resampleToRate(pad.samples, pad.sampleRate, sampleRate),
  }));
  const frames = resampled.reduce(
    (total, pad, index) => total + pad.samples.length + (index < resampled.length - 1 ? gapFrames : 0),
    0,
  );
  const samples = new Float32Array(frames);
  const slices: ModuleSampleSlice[] = [];
  let offset = 0;
  for (const [index, pad] of resampled.entries()) {
    samples.set(pad.samples, offset);
    slices.push({
      index,
      startFrame: offset,
      endFrame: offset + pad.samples.length,
      output: index % DIRECT_OUTPUTS,
    });
    offset += pad.samples.length + gapFrames;
  }

  const assetId = sampleAssetId(
    "factory",
    bank.id,
    `${bank.sourceUrl}:${bank.pads.map((pad) => pad.file).join(",")}`,
    frames,
    slices,
  );
  const sample: SamplerSampleState = {
    version: 1,
    kind: "sampler",
    assetId,
    sourceType: "factory",
    sourceUrl: bank.sourceUrl,
    apiUrl: "",
    fileUrl: bank.sourceUrl,
    name: bank.name,
    sampleRate,
    channels: 1,
    frames,
    slices,
    bankId: bank.id,
    padLabels: bank.pads.map((pad) => pad.label),
    license: `${bank.license}; source ${bank.sourceName}`,
  };

  return {
    sample,
    asset: samplerAssetFromSample(sample, samples),
  };
}

export async function loadUploadedSamplerFile(
  file: File,
  chopMode: SamplerChopMode,
  tempoBpm: number,
  transientSensitivity = DEFAULT_TRANSIENT_SENSITIVITY,
): Promise<LoadedSamplerSample> {
  const decoded = await decodeAudioFileMono(file);
  const slices = chopSamplerSamples(
    decoded.samples,
    decoded.sampleRate,
    chopMode,
    tempoBpm,
    [],
    transientSensitivity,
  );
  const wav = encodeMonoWav(decoded.samples, decoded.sampleRate);
  const uploaded = await uploadSamplerObject(
    wav,
    safeSampleName(file.name),
    decoded.sampleRate,
    decoded.frames,
  );
  const objectKey = uploaded.objectKey;
  if (!objectKey) {
    throw new Error("Sampler upload response was missing an object key.");
  }

  const fileUrl = samplerObjectUrl(objectKey);
  const sample: SamplerSampleState = {
    version: 1,
    kind: "sampler",
    assetId: sampleAssetId("upload", objectKey, fileUrl, decoded.frames, slices),
    sourceType: "upload",
    sourceUrl: file.name,
    apiUrl: fileUrl,
    fileUrl,
    objectKey,
    name: uploaded.name || safeSampleName(file.name),
    sampleRate: decoded.sampleRate,
    channels: 1,
    frames: decoded.frames,
    slices,
    chopMode,
    padLabels: slices.map((slice) => `CHOP ${slice.index + 1}`),
  };

  return {
    sample,
    asset: samplerAssetFromSample(sample, decoded.samples),
  };
}

export async function loadSamplerRuntimeAsset(
  sample: SamplerSampleState | Op1DrumSampleState,
): Promise<SamplerRuntimeSampleAsset> {
  if (sample.kind === "sampler" && sample.sourceType === "upload") {
    if (!sample.objectKey) {
      throw new Error(`${sample.name} is missing an uploaded sample object key.`);
    }
    const response = await fetch(samplerObjectUrl(sample.objectKey), {
      headers: authHeaders(),
    });
    if (!response.ok) {
      throw new Error(await responseError(response, `Could not load ${sample.name}.`));
    }
    const parsed = parseWavMono(await response.arrayBuffer(), sample.name);
    return {
      kind: "sampler",
      assetId: sample.assetId,
      sampleRate: parsed.sampleRate,
      frames: parsed.frames,
      samples: parsed.samples,
      slices: sample.slices,
    };
  }

  const loaded =
    sample.kind === "sampler" && sample.sourceType === "factory"
      ? await loadFactorySampleBank(sample.bankId)
      : await loadOP1SamplerPatch(sample.sourceUrl);
  return {
    ...loaded.asset,
    kind: "sampler",
    assetId: sample.assetId,
    slices: sample.slices,
  };
}

export function loadedSamplerLabel(sample: SamplerSampleState | Op1DrumSampleState | undefined) {
  if (!sample) {
    return "";
  }
  const count = sample.slices.length;
  return `${sample.name} / ${count} ${count === 1 ? "slice" : "slices"}`;
}

export function samplerSampleWithSlices<
  T extends SamplerSampleState | Op1DrumSampleState,
>(sample: T, slices: ModuleSampleSlice[], chopMode?: SamplerChopMode): T {
  const normalizedSlices = normalizeSamplerSlices(
    slices,
    sample.frames,
    sample.slices,
  );
  const prefix =
    sample.kind === "sampler"
      ? sample.sourceType === "upload"
        ? "upload"
        : sample.sourceType === "factory"
          ? "factory"
          : "op1"
      : "op1";
  const stableId =
    sample.kind === "sampler" && sample.sourceType === "upload"
      ? (sample.objectKey ?? sample.fileUrl)
      : sample.kind === "sampler" && sample.sourceType === "factory"
        ? (sample.bankId ?? sample.sourceUrl)
        : sample.sourceUrl;
  const next = {
    ...sample,
    assetId: sampleAssetId(prefix, stableId, sample.fileUrl, sample.frames, normalizedSlices),
    slices: normalizedSlices,
  };
  if (next.kind === "sampler" && chopMode) {
    return {
      ...next,
      chopMode,
      padLabels: normalizedSlices.map((slice) => `CHOP ${slice.index + 1}`),
    } as T;
  }
  return next as T;
}

export function samplerAssetFromLoadedSample(
  sample: SamplerSampleState | Op1DrumSampleState,
  asset: SamplerRuntimeSampleAsset,
): SamplerRuntimeSampleAsset {
  return {
    ...asset,
    assetId: sample.assetId,
    sampleRate: asset.sampleRate,
    frames: asset.frames,
    slices: sample.slices,
  };
}

export function chopSamplerSamples(
  samples: Float32Array,
  sampleRate: number,
  mode: SamplerChopMode,
  tempoBpm: number,
  previousSlices: ModuleSampleSlice[] = [],
  transientSensitivity = DEFAULT_TRANSIENT_SENSITIVITY,
): ModuleSampleSlice[] {
  const frames = samples.length;
  if (frames <= 1) {
    return [{ index: 0, startFrame: 0, endFrame: Math.max(1, frames), output: 0 }];
  }
  const markers =
    mode === "transients"
      ? transientMarkers(samples, sampleRate, transientSensitivity)
      : beatMarkers(frames, sampleRate, mode, tempoBpm);
  return slicesFromMarkers(markers, frames, previousSlices);
}

export function slicesFromMarkers(
  rawMarkers: readonly number[],
  frames: number,
  previousSlices: ModuleSampleSlice[] = [],
): ModuleSampleSlice[] {
  const markers = Array.from(
    new Set(
      rawMarkers
        .map((marker) => clampFrame(Math.round(marker), frames))
        .filter((marker) => marker >= 0 && marker <= frames),
    ),
  ).sort((first, second) => first - second);
  if (markers[0] !== 0) {
    markers.unshift(0);
  }
  if (markers[markers.length - 1] !== frames) {
    markers.push(frames);
  }

  const slices: ModuleSampleSlice[] = [];
  for (
    let markerIndex = 0;
    markerIndex < markers.length - 1 && slices.length < MAX_SAMPLER_SLICES;
    markerIndex += 1
  ) {
    const startFrame = markers[markerIndex];
    const endFrame = markers[markerIndex + 1];
    if (endFrame <= startFrame) {
      continue;
    }
    const previous = previousSlices[slices.length];
    slices.push({
      index: slices.length,
      startFrame,
      endFrame,
      output: sanitizeSliceOutput(previous?.output ?? slices.length),
    });
  }

  if (slices.length === 0) {
    return [{ index: 0, startFrame: 0, endFrame: Math.max(1, frames), output: 0 }];
  }
  return slices;
}

function samplerAssetFromSample(
  sample: SamplerSampleState,
  samples: Float32Array,
): SamplerRuntimeSampleAsset {
  return {
    kind: "sampler",
    assetId: sample.assetId,
    sampleRate: sample.sampleRate,
    frames: sample.frames,
    samples,
    slices: sample.slices,
  };
}

function normalizeSamplerSlices(
  slices: ModuleSampleSlice[],
  frames: number,
  previousSlices: ModuleSampleSlice[] = [],
) {
  return slices
    .slice(0, MAX_SAMPLER_SLICES)
    .map((slice, index) => {
      const startFrame = Math.min(
        Math.max(0, Math.round(slice.startFrame)),
        Math.max(0, frames - 1),
      );
      const endFrame = Math.min(
        frames,
        Math.max(startFrame + 1, Math.round(slice.endFrame)),
      );
      const previous = previousSlices[index];
      return {
        index,
        startFrame,
        endFrame: Math.max(startFrame + 1, endFrame),
        output: sanitizeSliceOutput(slice.output ?? previous?.output ?? index),
      };
    })
    .filter((slice) => slice.endFrame > slice.startFrame);
}

function beatMarkers(
  frames: number,
  sampleRate: number,
  mode: Exclude<SamplerChopMode, "transients">,
  tempoBpm: number,
) {
  const beatsPerSlice = Number(mode.replace("beats-", ""));
  const secondsPerBeat = 60 / clampTempo(tempoBpm);
  const framesPerSlice = Math.max(1, Math.round(secondsPerBeat * beatsPerSlice * sampleRate));
  const markers = [0];
  for (
    let frame = framesPerSlice;
    frame < frames && markers.length < MAX_SAMPLER_SLICES;
    frame += framesPerSlice
  ) {
    markers.push(frame);
  }
  markers.push(frames);
  return markers;
}

function transientMarkers(
  samples: Float32Array,
  sampleRate: number,
  transientSensitivity: number,
) {
  const frames = samples.length;
  const sensitivity = clamp01(transientSensitivity);
  const windowSize = Math.max(128, Math.round(sampleRate * 0.011));
  const hopSize = Math.max(64, Math.round(windowSize / 2));
  const envelope: number[] = [];
  for (let start = 0; start < frames; start += hopSize) {
    let sum = 0;
    const end = Math.min(frames, start + windowSize);
    for (let frame = start; frame < end; frame += 1) {
      sum += Math.abs(samples[frame]);
    }
    envelope.push(sum / Math.max(1, end - start));
  }
  if (envelope.length < 4) {
    return [0, frames];
  }

  const mean =
    envelope.reduce((total, value) => total + value, 0) / envelope.length;
  const variance =
    envelope.reduce((total, value) => total + (value - mean) ** 2, 0) /
    envelope.length;
  const stdDev = Math.sqrt(variance);
  const peak = Math.max(...envelope);
  const threshold = Math.max(
    0.006 + (1 - sensitivity) * 0.04,
    mean + stdDev * (1.8 - sensitivity * 1.35),
    peak * (0.3 - sensitivity * 0.22),
  );
  const minGap = Math.max(
    hopSize * 2,
    Math.round(sampleRate * (0.085 - sensitivity * 0.045)),
  );
  const riseRatio = 1.75 - sensitivity * 0.55;
  const markers = [0];
  let lastMarker = 0;
  for (let index = 2; index < envelope.length - 1; index += 1) {
    const previous = envelope[index - 1];
    const current = envelope[index];
    const next = envelope[index + 1];
    const frame = index * hopSize;
    const rising = current > previous * riseRatio && current >= next * 0.92;
    if (
      current >= threshold &&
      rising &&
      frame - lastMarker >= minGap &&
      markers.length < MAX_SAMPLER_SLICES
    ) {
      markers.push(frame);
      lastMarker = frame;
    }
  }
  markers.push(frames);

  if (markers.length <= 2) {
    return beatMarkers(frames, sampleRate, "beats-1", 120);
  }
  return markers;
}

async function decodeAudioFileMono(file: File) {
  const buffer = await file.arrayBuffer();
  try {
    return parseWavMono(buffer.slice(0), file.name);
  } catch {
    const AudioContextConstructor =
      window.AudioContext ??
      (window as typeof window & { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioContextConstructor) {
      throw new Error(`${file.name} is not a supported audio file.`);
    }
    const context = new AudioContextConstructor();
    try {
      const decoded = await context.decodeAudioData(buffer.slice(0));
      const frames = decoded.length;
      const samples = new Float32Array(frames);
      for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
        const channelData = decoded.getChannelData(channel);
        for (let frame = 0; frame < frames; frame += 1) {
          samples[frame] += channelData[frame] / decoded.numberOfChannels;
        }
      }
      return {
        sampleRate: decoded.sampleRate,
        channels: decoded.numberOfChannels,
        frames,
        samples,
      };
    } finally {
      void context.close();
    }
  }
}

async function uploadSamplerObject(
  wav: Blob,
  name: string,
  sampleRate: number,
  frames: number,
): Promise<SamplerUploadResponse> {
  const form = new FormData();
  form.set("file", wav, `${name || "sample"}.wav`);
  form.set(
    "metadata",
    JSON.stringify({
      name,
      slot: 0,
      clip: 0,
      sampleRate,
      frames,
      mode: "free",
      bars: 0,
      reverse: false,
      stretch: 1,
    }),
  );

  const response = await fetch(`${pb.baseUrl}/api/app/loops`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!response.ok) {
    throw new Error(await responseError(response, "Could not upload sample."));
  }
  return (await response.json()) as SamplerUploadResponse;
}

function encodeMonoWav(samples: Float32Array, sampleRate: number) {
  const bytesPerSample = 2;
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  writeASCII(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeASCII(view, 8, "WAVE");
  writeASCII(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, WAV_FORMAT_PCM, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, Math.round(sampleRate), true);
  view.setUint32(28, Math.round(sampleRate) * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeASCII(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  let offset = 44;
  for (const sample of samples) {
    view.setInt16(offset, floatToI16(sample), true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function slicesFromOP1Metadata(
  metadata: OP1DrumMetadata | null,
  marks: [number, number][] | undefined,
  frames: number,
  sampleRate: number,
): ModuleSampleSlice[] {
  const rawMarks =
    metadata?.start && metadata?.end
      ? metadata.start.map((start, index) => [start, metadata.end?.[index] ?? 0] as const)
      : marks ?? [];
  const unitsPerFrame = OP1_DRUM_UNITS_PER_SECOND / sampleRate;
  const slices = rawMarks
    .slice(0, 24)
    .map(([start, end], index) => ({
      index,
      startFrame: clampFrame(Math.round(start / unitsPerFrame), frames),
      endFrame: clampFrame(Math.round(end / unitsPerFrame), frames),
      output: index % DIRECT_OUTPUTS,
    }))
    .filter((slice) => slice.endFrame > slice.startFrame);

  if (slices.length > 0) {
    return slices;
  }
  return [{ index: 0, startFrame: 0, endFrame: frames, output: 0 }];
}

function resampleToRate(samples: Float32Array, fromRate: number, toRate: number) {
  if (!Number.isFinite(fromRate) || Math.abs(fromRate - toRate) < 1) {
    return samples;
  }
  const frames = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const resampled = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    const sourcePosition = frame * fromRate / toRate;
    const index = Math.floor(sourcePosition);
    const fraction = sourcePosition - index;
    const left = samples[index] ?? 0;
    const right = samples[Math.min(index + 1, samples.length - 1)] ?? left;
    resampled[frame] = left + (right - left) * fraction;
  }
  return resampled;
}

function clampFrame(frame: number, frames: number) {
  return Math.max(0, Math.min(frames, frame));
}

function clampTempo(tempoBpm: number) {
  return Number.isFinite(tempoBpm) ? Math.max(20, Math.min(300, tempoBpm)) : 120;
}

function clamp01(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : DEFAULT_TRANSIENT_SENSITIVITY;
}

function sanitizeSliceOutput(output: number) {
  return Math.max(0, Math.min(DIRECT_OUTPUTS - 1, Math.round(output)));
}

function sampleAssetId(
  prefix: string,
  id: string,
  fileUrl: string,
  frames: number,
  slices: ModuleSampleSlice[],
) {
  const suffix = hashString(
    `${fileUrl}:${frames}:${slices
      .map(
        (slice) =>
          `${slice.startFrame}-${slice.endFrame}-${slice.output ?? slice.index % DIRECT_OUTPUTS}`,
      )
      .join(",")}`,
  );
  return `samp-${prefix}-${id}-${suffix}`.slice(0, 96);
}

function samplerObjectUrl(objectKey: string) {
  return `${pb.baseUrl}/api/app/loops/${objectKey
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function authHeaders() {
  return pb.authStore.token
    ? { Authorization: `Bearer ${pb.authStore.token}` }
    : undefined;
}

async function responseError(response: Response, fallback: string) {
  const text = await response.text();
  if (!text) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: string };
    return parsed.message || parsed.error || fallback;
  } catch {
    return text;
  }
}

function safeSampleName(name: string) {
  const withoutExtension = name.replace(/\.[^.]+$/, "").trim();
  const safe = withoutExtension.replace(/[^\w .-]+/g, "").trim();
  return (safe || "sample").slice(0, 96);
}

function writeASCII(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function floatToI16(value: number) {
  const sample = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
  return sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
