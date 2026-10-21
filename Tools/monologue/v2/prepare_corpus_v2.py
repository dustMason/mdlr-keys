#!/usr/bin/env python3
"""Reproduce the frozen seven-case corpus from bounded public paired assets.

Downloads about30MB of artist-published audio/patches, never synth firmware.
All downloaded assets, decoded patches, excerpts and events are SHA-256 checked.
"""

import argparse
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import soundfile as sf

HERE = Path(__file__).resolve().parent
sys.path.insert(
    0,
    str(
        HERE.parent
        if (HERE.parent / "decode_patch.py").exists()
        else HERE.parent.parent / "references/toolkit"
    ),
)
from decode_patch import read_patch


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-root", type=Path, default=HERE.parent / "data")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    root = args.data_root.resolve()
    output = root / "accuracy-v2"
    output.mkdir(parents=True, exist_ok=True)

    def target(relative):
        path = (output / relative).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Unsafe corpus path: " + relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        return path

    sources = json.loads((HERE / "sources-v2.json").read_text())
    for row in sources["files"]:
        path = target(row["target"])
        if path.exists() and digest(path) == row["sha256"]:
            continue
        if args.offline:
            raise ValueError("Missing or changed source asset: " + str(path))
        request = urllib.request.Request(
            row["url"], headers={"User-Agent": "mdlr-keys-monologue-calibration/2"}
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(row["bytes"] + 1)
        if (
            len(data) != row["bytes"]
            or hashlib.sha256(data).hexdigest() != row["sha256"]
        ):
            raise ValueError("Source size or checksum changed: " + row["url"])
        path.write_bytes(data)
        print(row["target"], flush=True)

    source_manifest = HERE / "corpus-v2.json"
    expected_manifest_hash = (HERE / "corpus-v2.sha256").read_text().split()[0]
    if digest(source_manifest) != expected_manifest_hash:
        raise ValueError("The frozen corpus manifest was changed")
    manifest = json.loads(source_manifest.read_text())
    events = json.loads((HERE / "events-v2.json").read_text())
    for case in manifest["cases"]:
        program = target(case["program"])
        program.write_bytes(read_patch(program.with_suffix(".molgprog")))
        audio, rate = sf.read(target(case["source_audio"]), always_2d=True)
        start, end = case["source_crop_seconds"]
        sf.write(
            target(case["reference"]),
            audio[round(start * rate) : round(end * rate)],
            rate,
            subtype="PCM_24",
        )
        target(case["events"]).write_text(
            json.dumps(events[case["id"]], indent=2) + "\n"
        )
        for field in ["program", "source_audio", "reference", "events"]:
            if digest(target(case[field])) != case[field + "_sha256"]:
                raise ValueError("Reproduction mismatch: " + case["id"] + "/" + field)
    (output / "corpus-v2.json").write_bytes(source_manifest.read_bytes())
    (output / "source-provenance.json").write_text(json.dumps(sources, indent=2) + "\n")
    print(
        json.dumps(
            {
                "manifest": str(output / "corpus-v2.json"),
                "sha256": expected_manifest_hash,
                "training_cases": 5,
                "validation_cases": 2,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
