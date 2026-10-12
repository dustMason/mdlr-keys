export interface ParsedWav {
  sampleRate: number;
  channels: number;
  frames: number;
  samples: Float32Array;
}

const WAV_FORMAT_PCM = 1;
const WAV_FORMAT_FLOAT = 3;

export function parseWavMono(buffer: ArrayBuffer, label = "sample"): ParsedWav {
  const view = new DataView(buffer);
  if (
    view.byteLength < 44 ||
    readString(view, 0, 4) !== "RIFF" ||
    readString(view, 8, 4) !== "WAVE"
  ) {
    throw new Error(`${label} is not a WAV file.`);
  }

  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataBytes = 0;

  for (let offset = 12; offset + 8 <= view.byteLength; ) {
    const chunkId = readString(view, offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(view.byteLength, chunkStart + chunkSize);

    if (chunkId === "fmt " && chunkSize >= 16) {
      format = view.getUint16(chunkStart, true);
      channels = view.getUint16(chunkStart + 2, true);
      sampleRate = view.getUint32(chunkStart + 4, true);
      bitsPerSample = view.getUint16(chunkStart + 14, true);
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataBytes = chunkEnd - chunkStart;
    }

    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (channels < 1 || channels > 8 || sampleRate <= 0 || dataOffset < 0 || dataBytes <= 0) {
    throw new Error(`${label} is missing valid WAV audio.`);
  }
  if (
    !(
      (format === WAV_FORMAT_PCM && [8, 16, 24, 32].includes(bitsPerSample)) ||
      (format === WAV_FORMAT_FLOAT && bitsPerSample === 32)
    )
  ) {
    throw new Error(`${label} uses an unsupported WAV format.`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const bytesPerFrame = channels * bytesPerSample;
  const frames = Math.floor(dataBytes / bytesPerFrame);
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const sampleOffset = dataOffset + frame * bytesPerFrame + channel * bytesPerSample;
      sum += readSample(view, sampleOffset, format, bitsPerSample);
    }
    samples[frame] = sanitizeSample(sum / channels);
  }

  return { sampleRate, channels, frames, samples };
}

function readSample(
  view: DataView,
  offset: number,
  format: number,
  bitsPerSample: number,
) {
  if (format === WAV_FORMAT_FLOAT) {
    return view.getFloat32(offset, true);
  }
  if (bitsPerSample === 8) {
    return (view.getUint8(offset) - 128) / 128;
  }
  if (bitsPerSample === 16) {
    const value = view.getInt16(offset, true);
    return value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  if (bitsPerSample === 24) {
    let value =
      view.getUint8(offset) |
      (view.getUint8(offset + 1) << 8) |
      (view.getUint8(offset + 2) << 16);
    if (value & 0x800000) {
      value |= 0xff000000;
    }
    return value < 0 ? value / 0x800000 : value / 0x7fffff;
  }
  const value = view.getInt32(offset, true);
  return value < 0 ? value / 0x80000000 : value / 0x7fffffff;
}

function sanitizeSample(value: number) {
  return Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
}

function readString(view: DataView, offset: number, length: number) {
  let value = "";
  for (let index = 0; index < length; index += 1) {
    value += String.fromCharCode(view.getUint8(offset + index));
  }
  return value;
}
