#!/usr/bin/env python3
"""Experimental calibration with unknown velocity/gate profiling.
Validation is excluded unless explicitly requested after the model is frozen.
"""

import argparse, itertools, json, shutil, subprocess, sys, hashlib, time
import importlib
from pathlib import Path

B = Path(__file__).resolve().parent
sys.path.insert(
    0,
    str(
        B.parent
        if (B.parent / "audio_compare.py").exists()
        else B.parent / "references/toolkit"
    ),
)
from audio_compare import compare_files as legacy_compare_files

sys.path.insert(
    0, str(B if (B / "metric_audit.py").exists() else B / "metric-audit-v2")
)
from cached_metric import compare_files


def candidate_events(events, velocity, gate_off):
    if gate_off is not None and sum(e["type"] == "on" for e in events) != 1:
        raise ValueError("Gate profiling requires exactly one note-on per excerpt")
    result = []
    for event in events:
        if event["type"] == "off" and gate_off is not None:
            continue
        e = dict(event)
        if e["type"] == "on":
            e["velocity"] = velocity
        result.append(e)
    if gate_off is not None:
        on = next(e for e in result if e["type"] == "on")
        if gate_off <= on["time"]:
            raise ValueError("gate off must follow note on")
        result.append(
            {"time": gate_off, "note": on["note"], "velocity": 0, "type": "off"}
        )
    return sorted(result, key=lambda e: e["time"])


def neighborhood(values, center, cyclic=False):
    if len(values) < 3:
        return values
    index = values.index(center)
    positions = (
        [(index - 1) % len(values), index, (index + 1) % len(values)]
        if cyclic
        else range(max(0, index - 1), min(len(values), index + 2))
    )
    return [values[i] for i in positions]


class Runner:
    def __init__(self, renderer, manifest, output, max_lag_ms=4):
        self.renderer = renderer.resolve()
        self.manifest = json.loads(manifest.read_text())
        self.root = manifest.parent.resolve()
        self.output = output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.max_lag_ms = max_lag_ms
        self.history = []
        self.centers = {}
        self.provenance = {
            "renderer_sha256": hashlib.sha256(self.renderer.read_bytes()).hexdigest(),
            "manifest_sha256": hashlib.sha256(manifest.read_bytes()).hexdigest(),
            "scorer_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            "analysis_max_lag_ms": max_lag_ms,
            "metric_module_hashes": {
                name: hashlib.sha256(
                    Path(importlib.import_module(name).__file__).read_bytes()
                ).hexdigest()
                for name in ["metric_audit", "cached_metric", "audio_compare"]
            },
        }

    def evaluate(
        self, calibration, label, include_validation=False, profile_mode="full"
    ):
        if (
            hashlib.sha256(self.renderer.read_bytes()).hexdigest()
            != self.provenance["renderer_sha256"]
        ):
            raise RuntimeError(
                "Renderer changed during the run; freeze a binary before fitting"
            )
        started = time.monotonic()
        out = self.output / label
        out.mkdir(exist_ok=True)
        cp = out / "calibration.json"
        cp.write_text(json.dumps(calibration, indent=2) + "\n")
        metrics = []
        for case in self.manifest["cases"]:
            if case["split"] != "train" and not include_validation:
                continue
            original = json.loads((self.root / case["events"]).read_text())
            velocities = case.get("velocity_candidates", [case["velocity"]])
            gates = case.get("gate_off_candidates", [None])
            phases = case.get("oscillator_phase_candidates", [None])
            profile = []
            if profile_mode == "local":
                center = self.centers[case["id"]]
                velocities = neighborhood(velocities, center["selected_velocity"])
                gates = neighborhood(gates, center["selected_gate_off"])
                phases = neighborhood(
                    phases, center["selected_oscillator_phases"], cyclic=True
                )
            for index, (velocity, gate_off, oscillator_phases) in enumerate(
                itertools.product(velocities, gates, phases)
            ):
                ep = out / (case["id"] + f".n{index}.events.json")
                ep.write_text(
                    json.dumps(candidate_events(original, velocity, gate_off), indent=2)
                    + "\n"
                )
                wp = ep.with_suffix(".wav")
                cmd = [
                    str(self.renderer),
                    "--output",
                    str(wp),
                    "--program",
                    str(self.root / case["program"]),
                    "--events",
                    str(ep),
                    "--sample-rate",
                    "48000",
                    "--duration",
                    str(case["duration"]),
                    "--calibration",
                    str(cp),
                ]
                if oscillator_phases is not None:
                    cmd += [
                        "--oscillator-phases",
                        ",".join(str(v) for v in oscillator_phases),
                    ]
                done = subprocess.run(cmd, text=True, capture_output=True, timeout=45)
                if done.returncode:
                    raise RuntimeError(done.stderr[-3000:] + done.stdout[-1000:])
                nominal = 440 * 2 ** ((case["observed_base_note"] - 69) / 12)
                score = compare_files(
                    self.root / case["reference"],
                    wp,
                    self.max_lag_ms,
                    pitch_hz=nominal,
                    end_s=case.get("spectral_end_seconds"),
                )
                profile.append(
                    {
                        "index": index,
                        "velocity": velocity,
                        "gate_off": gate_off,
                        "oscillator_phases": oscillator_phases,
                        "metrics": score,
                    }
                )
            best = min(profile, key=lambda row: row["metrics"]["objective"])
            index = best["index"]
            ep = out / (case["id"] + f".n{index}.events.json")
            shutil.copyfile(ep, out / (case["id"] + ".events.json"))
            shutil.copyfile(ep.with_suffix(".wav"), out / (case["id"] + ".wav"))
            for row in profile:
                ep = out / (case["id"] + f".n{row['index']}.events.json")
                ep.with_suffix(".wav").unlink()
                ep.unlink()
            legacy = legacy_compare_files(
                self.root / case["reference"],
                out / (case["id"] + ".wav"),
                self.max_lag_ms,
            )
            metrics.append(
                {
                    "id": case["id"],
                    "split": case["split"],
                    "metrics": best["metrics"],
                    "legacy_metrics": legacy,
                    "selected_velocity": best["velocity"],
                    "selected_gate_off": best["gate_off"],
                    "selected_oscillator_phases": best["oscillator_phases"],
                    "velocity_at_profile_boundary": len(
                        case.get("velocity_candidates", [])
                    )
                    > 1
                    and best["velocity"]
                    in [
                        min(case["velocity_candidates"]),
                        max(case["velocity_candidates"]),
                    ],
                    "gate_at_profile_boundary": len(case.get("gate_off_candidates", []))
                    > 1
                    and best["gate_off"]
                    in [
                        min(case["gate_off_candidates"]),
                        max(case["gate_off_candidates"]),
                    ],
                    "profiled_velocity_candidates": velocities,
                    "profiled_gate_candidates": gates,
                    "profiled_phase_candidates": phases,
                    "nuisance_profile": [
                        {
                            "velocity": row["velocity"],
                            "gate_off": row["gate_off"],
                            "oscillator_phases": row["oscillator_phases"],
                            "objective": row["metrics"]["objective"],
                            "fitted_gain_db": row["metrics"]["fitted_gain_db"],
                            "spectral_mae_db": row["metrics"]["spectral_mae_db"],
                            "envelope_mae_db": row["metrics"]["envelope_mae_db"],
                        }
                        for row in profile
                    ],
                }
            )
        means = {
            split: sum(
                c["metrics"]["objective"] for c in metrics if c["split"] == split
            )
            / sum(c["split"] == split for c in metrics)
            for split in ["train", "held_out"]
            if any(c["split"] == split for c in metrics)
        }
        report = {
            "calibration": calibration,
            "scores": means,
            "cases": metrics,
            "validation_included": include_validation,
            "nuisance_profile_mode": profile_mode,
            "elapsed_seconds": time.monotonic() - started,
            "provenance": self.provenance,
            "objective_description": "Local harmonic-band power plus 0.3 * aligned RMS envelope; known f0, recording gain fitted independently; legacy score reported but not optimized",
            "limitations": self.manifest["warnings"],
        }
        (out / "metrics.json").write_text(json.dumps(report, indent=2) + "\n")
        self.history.append(
            {"label": label, "calibration": dict(calibration), "scores": means}
        )
        (self.output / "history.json").write_text(
            json.dumps(self.history, indent=2) + "\n"
        )
        return report


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("renderer", type=Path)
    p.add_argument(
        "--manifest", type=Path, default=B.parent / "data/accuracy-v2/corpus-v2.json"
    )
    p.add_argument("--output", type=Path, default=B.parent / "data/runs/experiment")
    p.add_argument("--calibration", type=Path)
    p.add_argument("--max-lag-ms", type=float, default=4)
    p.add_argument("--include-validation", action="store_true")
    p.add_argument("--fit", action="store_true")
    p.add_argument("--space", type=Path)
    p.add_argument("--passes", type=int, default=3)
    p.add_argument("--cycles-per-pass", type=int, default=2)
    a = p.parse_args()
    if a.fit and a.include_validation:
        p.error(
            "Run validation only after search/model freeze, in a separate invocation"
        )
    if a.fit and not a.space:
        p.error(
            "Experimental --fit requires an explicit --space for the current model revision"
        )
    runner = Runner(a.renderer, a.manifest, a.output, a.max_lag_ms)
    cal = json.loads(a.calibration.read_text()) if a.calibration else {}
    space = json.loads(a.space.read_text()) if a.space else {}
    if a.fit:
        for key, spec in space.items():
            cal.setdefault(key, spec["initial"])
    baseline = runner.evaluate(cal, "baseline", a.include_validation)
    print(json.dumps({"baseline": baseline["scores"]}), flush=True)
    if not a.fit:
        return
    best = baseline["scores"]["train"]
    trial = 0
    runner.centers = {c["id"]: c for c in baseline["cases"]}
    for iteration in range(a.passes):
        for cycle in range(a.cycles_per_pass):
            for key, spec in space.items():
                current = dict(cal)
                candidates = []
                for sign in [-1, 1]:
                    value = max(
                        spec["low"],
                        min(
                            spec["high"],
                            current[key] + sign * spec["step"] / (2**iteration),
                        ),
                    )
                    if value == current[key]:
                        continue
                    candidate = {**current, key: value}
                    trial += 1
                    label = f"trial-{trial:03d}"
                    report = runner.evaluate(candidate, label, profile_mode="local")
                    score = report["scores"]["train"]
                    candidates.append((score, candidate))
                    print(
                        json.dumps(
                            {
                                "trial": trial,
                                "field": key,
                                "value": value,
                                "objective": score,
                                "best": best,
                            }
                        ),
                        flush=True,
                    )
                    for wave in (runner.output / label).glob("*.wav"):
                        wave.unlink()
                if candidates:
                    score, candidate = min(candidates, key=lambda item: item[0])
                    if score < best:
                        best = score
                        cal = candidate
        refreshed = runner.evaluate(cal, f"reprofile-{iteration+1}")
        best = refreshed["scores"]["train"]
        runner.centers = {c["id"]: c for c in refreshed["cases"]}
        print(
            json.dumps(
                {"full_reprofile_pass": iteration + 1, "scores": refreshed["scores"]}
            ),
            flush=True,
        )
    final = runner.evaluate(cal, "best", a.include_validation)
    (runner.output / "best-calibration.json").write_text(
        json.dumps(cal, indent=2) + "\n"
    )
    summary = {
        "baseline": baseline["scores"],
        "best": final["scores"],
        "calibration": cal,
        "validation_used_for_optimization": False,
        "search_approximation": "During each global pass, velocity/gate/phase search is restricted to the selected nuisance candidate and its adjacent grid values. Baseline, each pass boundary and final use the full frozen nuisance grid.",
        "limitations": runner.manifest["warnings"],
    }
    (runner.output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
