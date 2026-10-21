#!/usr/bin/env python3
"""Extract monologue OS 2.00 main/voice/panel images for local analysis.

Input is the official Windows updater ZIP. Vendor bytes remain in a caller-
chosen analysis directory; this repository contains no executable firmware.
Requires Python 3 and 7-Zip (`7z`) for its CRC-verified LH5 decoder.
"""
import argparse
import hashlib
import json
import shutil
import struct
import subprocess
import zipfile
from pathlib import Path

EXPECTED_ZIP = "1756d1a72fa73992f49fa35c0c22c0aab41e007edc6ea002f85ec0c081ee2ea4"
EXPECTED_MAIN = "27ddc78d5076bd60145be952e91a0c3c048d016600343ee743a67fd8a32c60e6"
STREAMS = (
    ("voice", 0x2B5FC, "114755a9617d85efaf445dd14dabbbcc2c40ae9c91624ef1518681f55b77d577"),
    ("panel", 0x24F68, "ad4b07fc51066102ee7743ffc0a99907c25a18932aac08c5ffd16c8f81e9c698"),
)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("updater", type=Path)
    parser.add_argument("output", type=Path, help="new analysis directory outside the source tree")
    args = parser.parse_args()
    if sha(args.updater.read_bytes()) != EXPECTED_ZIP:
        parser.error("ZIP hash differs from the analyzed official 2.00 release")
    seven = shutil.which("7z")
    if not seven:
        parser.error("7z is required to decode and verify the LH5 streams")
    args.output.mkdir(parents=True, exist_ok=False)
    with zipfile.ZipFile(args.updater) as archive:
        members = [n for n in archive.namelist() if Path(n).name == "monologue_0200.vsb"]
        if len(members) != 1:
            parser.error("expected exactly one monologue_0200.vsb archive member")
        vsb = archive.read(members[0])
    raw = vsb[256:]
    assert len(raw) == 262144 and sha(raw) == EXPECTED_MAIN
    (args.output / "monologue_0200.vsb").write_bytes(vsb)
    (args.output / "monologue_0200.bin").write_bytes(raw)
    records = []
    for name, start, expected in STREAMS:
        magic, packed, original, crc = struct.unpack_from("<4sIIH", raw, start)
        assert magic == b"SQEZ" and start + 14 + packed <= len(raw)
        filename = (name + ".bin").encode()
        header = b"-lh5-" + struct.pack("<III", packed, original, 0)
        header += bytes([0x20, 0, len(filename)]) + filename + struct.pack("<H", crc)
        wrapped = bytes([len(header), sum(header) & 255]) + header
        wrapped += raw[start + 14:start + 14 + packed] + b"\0"
        path = args.output / (name + ".lzh")
        path.write_bytes(wrapped)
        subprocess.run([seven, "x", "-y", "-o" + str(args.output), str(path)], check=True)
        data = (args.output / (name + ".bin")).read_bytes()
        assert len(data) == original and sha(data) == expected
        records.append(dict(name=name, sqez_offset=hex(start), data_offset=hex(start+14),
                            compressed_size=packed, original_size=original,
                            crc16=hex(crc), sha256=sha(data)))
    (args.output / "embedded-images.json").write_text(json.dumps(records, indent=2) + "\n")
    print(json.dumps(records, indent=2))


if __name__ == "__main__":
    main()
