export interface ParsedAIFF {
  sampleRate: number;
  channels: number;
  frames: number;
  samples: Float32Array;
  metadata: OP1DrumMetadata | null;
}

export interface OP1DrumMetadata {
  type?: string;
  name?: string;
  start?: number[];
  end?: number[];
}

type SampleByteOrder = "big" | "little";

export function parseAIFF(buffer: ArrayBuffer): ParsedAIFF {
  const view = new DataView(buffer);
  if (view.byteLength < 12 || readString(view, 0, 4) !== "FORM") {
    throw new Error("Patch file is not an AIFF FORM.");
  }
  const formType = readString(view, 8, 4);
  if (formType !== "AIFF" && formType !== "AIFC") {
    throw new Error("Patch file is not an AIFF/AIFC file.");
  }

  let channels = 0;
  let frames = 0;
  let sampleSize = 0;
  let sampleRate = 0;
  let ssndOffset = -1;
  let ssndSize = 0;
  let sampleByteOrder: SampleByteOrder = "big";
  let metadata: OP1DrumMetadata | null = null;

  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, false);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(view.byteLength, chunkStart + chunkSize);

    if (chunkId === "COMM" && chunkSize >= 18) {
      channels = view.getUint16(chunkStart, false);
      frames = view.getUint32(chunkStart + 2, false);
      sampleSize = view.getUint16(chunkStart + 6, false);
      sampleRate = readExtended80(view, chunkStart + 8);
      if (formType === "AIFC") {
        const compressionType =
          chunkSize >= 22 ? readString(view, chunkStart + 18, 4) : "";
        sampleByteOrder = sampleByteOrderForAIFC(compressionType);
      }
    } else if (chunkId === "APPL") {
      metadata = parseOP1Metadata(
        bytesToText(new Uint8Array(buffer, chunkStart, chunkEnd - chunkStart)),
      );
    } else if (chunkId === "SSND" && chunkSize >= 8) {
      const audioOffset = view.getUint32(chunkStart, false);
      ssndOffset = chunkStart + 8 + audioOffset;
      ssndSize = Math.max(0, chunkEnd - ssndOffset);
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (channels < 1 || channels > 2 || frames < 1 || ssndOffset < 0 || sampleRate <= 0) {
    throw new Error("Patch AIFF is missing valid audio data.");
  }
  if (sampleSize !== 16 && sampleSize !== 24 && sampleSize !== 32) {
    throw new Error(`Unsupported AIFF sample size ${sampleSize}.`);
  }

  return {
    sampleRate,
    channels,
    frames,
    samples: decodeMonoSamples(
      view,
      ssndOffset,
      ssndSize,
      frames,
      channels,
      sampleSize,
      sampleByteOrder,
    ),
    metadata,
  };
}

function sampleByteOrderForAIFC(compressionType: string): SampleByteOrder {
  if (compressionType === "sowt") {
    return "little";
  }
  if (compressionType === "NONE" || compressionType === "twos") {
    return "big";
  }
  throw new Error(`Unsupported AIFC compression type "${compressionType || "unknown"}".`);
}

function decodeMonoSamples(
  view: DataView,
  offset: number,
  size: number,
  frames: number,
  channels: number,
  sampleSize: number,
  byteOrder: SampleByteOrder,
) {
  const bytesPerSample = sampleSize / 8;
  const bytesPerFrame = bytesPerSample * channels;
  const littleEndian = byteOrder === "little";
  const availableFrames = Math.min(frames, Math.floor(size / bytesPerFrame));
  const samples = new Float32Array(availableFrames);
  for (let frame = 0; frame < availableFrames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = offset + frame * bytesPerFrame + channel * bytesPerSample;
      sum += readSignedSample(view, sampleOffset, sampleSize, littleEndian);
    }
    samples[frame] = sum / channels;
  }
  return samples;
}

function readSignedSample(
  view: DataView,
  offset: number,
  sampleSize: number,
  littleEndian: boolean,
) {
  if (sampleSize === 16) {
    const value = view.getInt16(offset, littleEndian);
    return value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  if (sampleSize === 24) {
    let value = littleEndian
      ? view.getUint8(offset) |
        (view.getUint8(offset + 1) << 8) |
        (view.getUint8(offset + 2) << 16)
      : (view.getUint8(offset) << 16) |
        (view.getUint8(offset + 1) << 8) |
        view.getUint8(offset + 2);
    if (value & 0x800000) {
      value |= 0xff000000;
    }
    return value < 0 ? value / 0x800000 : value / 0x7fffff;
  }
  const value = view.getInt32(offset, littleEndian);
  return value < 0 ? value / 0x80000000 : value / 0x7fffffff;
}

function parseOP1Metadata(text: string): OP1DrumMetadata | null {
  const match = text.replace(/\0+$/g, "").match(/op-1({.*})/s);
  if (!match) {
    return null;
  }
  try {
    return JSON.parse(match[1]) as OP1DrumMetadata;
  } catch {
    return null;
  }
}

function readExtended80(view: DataView, offset: number) {
  const exponentWord = view.getUint16(offset, false);
  const sign = exponentWord & 0x8000 ? -1 : 1;
  const exponent = exponentWord & 0x7fff;
  const hi = view.getUint32(offset + 2, false);
  const lo = view.getUint32(offset + 6, false);
  if (exponent === 0 && hi === 0 && lo === 0) {
    return 0;
  }
  const mantissa = hi / 2 ** 31 + lo / 2 ** 63;
  return sign * mantissa * 2 ** (exponent - 16383);
}

function readString(view: DataView, offset: number, length: number) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}

function bytesToText(bytes: Uint8Array) {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}
