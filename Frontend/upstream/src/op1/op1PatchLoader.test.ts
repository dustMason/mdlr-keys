import { describe, expect, it } from "vitest";
import { parseAIFF } from "./aiff";

const EXTENDED_44100 = [0x40, 0x0e, 0xac, 0x44, 0, 0, 0, 0, 0, 0];

describe("parseAIFF", () => {
  it("decodes standard AIFF big-endian PCM", () => {
    const parsed = parseAIFF(
      buildAiff({
        formType: "AIFF",
        samples: [0, 0x4000, -0x4000, 0x7fff, -0x8000],
      }),
    );

    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.channels).toBe(1);
    expect(parsed.frames).toBe(5);
    expect(Array.from(parsed.samples)).toEqual([
      0,
      expect.closeTo(0x4000 / 0x7fff, 6),
      -0.5,
      1,
      -1,
    ]);
  });

  it("decodes AIFC sowt little-endian PCM", () => {
    const parsed = parseAIFF(
      buildAiff({
        formType: "AIFC",
        compressionType: "sowt",
        samples: [0, 0x4000, -0x4000, 0x7fff, -0x8000],
      }),
    );

    expect(parsed.sampleRate).toBe(44100);
    expect(parsed.channels).toBe(1);
    expect(parsed.frames).toBe(5);
    expect(Array.from(parsed.samples)).toEqual([
      0,
      expect.closeTo(0x4000 / 0x7fff, 6),
      -0.5,
      1,
      -1,
    ]);
  });

  it("rejects unsupported AIFC compression instead of decoding garbage", () => {
    expect(() =>
      parseAIFF(
        buildAiff({
          formType: "AIFC",
          compressionType: "ima4",
          samples: [0],
        }),
      ),
    ).toThrow(/Unsupported AIFC compression type/);
  });
});

function buildAiff({
  formType,
  compressionType,
  samples,
}: {
  formType: "AIFF" | "AIFC";
  compressionType?: string;
  samples: number[];
}) {
  const commData: number[] = [];
  pushU16BE(commData, 1);
  pushU32BE(commData, samples.length);
  pushU16BE(commData, 16);
  commData.push(...EXTENDED_44100);
  if (formType === "AIFC") {
    pushString(commData, compressionType ?? "NONE");
  }

  const ssndData: number[] = [];
  pushU32BE(ssndData, 0);
  pushU32BE(ssndData, 0);
  for (const sample of samples) {
    if (formType === "AIFC" && compressionType === "sowt") {
      pushI16LE(ssndData, sample);
    } else {
      pushI16BE(ssndData, sample);
    }
  }

  const chunks = [...chunk("COMM", commData), ...chunk("SSND", ssndData)];
  const bytes: number[] = [];
  pushString(bytes, "FORM");
  pushU32BE(bytes, chunks.length + 4);
  pushString(bytes, formType);
  bytes.push(...chunks);
  return Uint8Array.from(bytes).buffer;
}

function chunk(id: string, data: number[]) {
  const bytes: number[] = [];
  pushString(bytes, id);
  pushU32BE(bytes, data.length);
  bytes.push(...data);
  if (data.length % 2) {
    bytes.push(0);
  }
  return bytes;
}

function pushString(bytes: number[], value: string) {
  for (const char of value) {
    bytes.push(char.charCodeAt(0));
  }
}

function pushU16BE(bytes: number[], value: number) {
  bytes.push((value >>> 8) & 0xff, value & 0xff);
}

function pushU32BE(bytes: number[], value: number) {
  bytes.push(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function pushI16BE(bytes: number[], value: number) {
  const unsigned = value & 0xffff;
  bytes.push((unsigned >>> 8) & 0xff, unsigned & 0xff);
}

function pushI16LE(bytes: number[], value: number) {
  const unsigned = value & 0xffff;
  bytes.push(unsigned & 0xff, (unsigned >>> 8) & 0xff);
}
