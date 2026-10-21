#!/usr/bin/env python3
"""Inspect temporal harmonic residuals using the already selected render/alignment."""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from audio_compare import read_audio
from metric_audit import harmonic_frames


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--render-directory", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    metrics = json.loads((args.render_directory / "metrics.json").read_text())
    rows = []
    for selected in metrics["cases"]:
        case = next(c for c in manifest["cases"] if c["id"] == selected["id"])
        reference, rate = read_audio(args.manifest.parent / case["reference"], 48000)
        candidate, _ = read_audio(args.render_directory / (case["id"] + ".wav"), rate)
        size = min(len(reference), len(candidate))
        reference, candidate = reference[:size], candidate[:size]
        lag = round(selected["metrics"]["alignment_ms"] * rate / 1000)
        if lag > 0:
            reference, candidate = reference[lag:], candidate[:-lag]
        elif lag < 0:
            reference, candidate = reference[:lag], candidate[-lag:]
        streams = {}
        for label, samples in [("reference", reference), ("candidate", candidate)]:
            frame = harmonic_frames(
                samples,
                rate,
                440 * 2 ** ((case["observed_base_note"] - 69) / 12),
                end_s=case.get("spectral_end_seconds"),
            )
            normalized = frame["power"] / np.maximum(
                frame["power"].sum(axis=1, keepdims=True), 1e-30
            )
            streams[label] = {
                "times_seconds": frame["times"].tolist(),
                "harmonics_db": (10 * np.log10(np.maximum(normalized, 1e-8))).tolist(),
                "h2_over_h1_db": (
                    10
                    * np.log10(
                        np.maximum(frame["power"][:, 1], 1e-30)
                        / np.maximum(frame["power"][:, 0], 1e-30)
                    )
                ).tolist(),
                "coverage": frame["coverage"].tolist(),
                "f0_hz": frame["f0"].tolist(),
            }
        rows.append(
            {
                "id": case["id"],
                "split": case["split"],
                "alignment_ms": lag / rate * 1000,
                "analysis_base_note": case["observed_base_note"],
                **streams,
            }
        )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(
            {
                "cases": rows,
                "note": "Uses frozen selected candidates and existing alignment; no new performance fitting. Frame centers use the aligned crop origin. Small residuals do not establish analog hardware equivalence.",
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
