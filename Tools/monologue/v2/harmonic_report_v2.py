#!/usr/bin/env python3
"""Summarize existing v2 harmonic diagnostics without changing or rescoring audio."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "run", type=Path, help="A metrics.json file or its run directory"
    )
    args = parser.parse_args()
    source = args.run
    if source.is_dir():
        choices = [
            source / "best/metrics.json",
            source / "metrics.json",
            source / "baseline/metrics.json",
        ]
        source = next((p for p in choices if p.exists()), None)
        if source is None:
            parser.error("No v2 metrics.json found in the supplied run")
    report = json.loads(source.read_text())
    print(
        json.dumps(
            {
                "scores": report["scores"],
                "cases": [
                    {
                        "id": case["id"],
                        "split": case["split"],
                        **{
                            key: case["metrics"][key]
                            for key in [
                                "objective",
                                "harmonic_shape_weighted_db",
                                "pooled_harmonic_shape_weighted_db",
                                "harmonic_energy_distance",
                                "envelope_mae_db",
                                "fitted_gain_db",
                                "alignment_ms",
                                "pitch_cents_median",
                                "reference_harmonic_coverage",
                                "candidate_harmonic_coverage",
                            ]
                        },
                        "velocity": case["selected_velocity"],
                        "gate_off": case["selected_gate_off"],
                        "oscillator_phases": case["selected_oscillator_phases"],
                    }
                    for case in report["cases"]
                ],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
