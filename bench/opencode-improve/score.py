from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path
from typing import Any


def load_metrics(run_dir: Path) -> list[dict[str, Any]]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(run_dir.glob("**/metrics.json"))]


def score(metrics: list[dict[str, Any]]) -> dict[str, Any]:
    valid = [item for item in metrics if not item.get("failed_model")]
    passed = [item for item in valid if item.get("verify_passed")]
    raw_passed = [item for item in metrics if item.get("verify_passed")]
    valid_pass_rate = round(len(passed) / len(valid), 4) if valid else None
    return {
        "runs": len(metrics),
        "valid_runs": len(valid),
        "failed_model_runs": len(metrics) - len(valid),
        "provider_timeout_runs": len([item for item in metrics if item.get("provider_timeout")]),
        "raw_pass_rate": round(len(raw_passed) / len(metrics), 4) if metrics else None,
        "valid_pass_rate": valid_pass_rate,
        "pass_rate": valid_pass_rate,
        "median_wall_time": median(valid, "wall_time_sec"),
        "median_tokens_total": median_total_tokens(valid),
        "median_cost": median(valid, "approx_cost"),
        "median_tool_calls": median(valid, "tool_calls_total"),
        "median_request_assembly_ms": median(valid, "request_assembly_ms"),
        "median_tool_schema_bytes": median(valid, "tool_schema_bytes"),
        "median_context_estimate_tokens": median(valid, "context_estimate_tokens"),
        "median_compaction_count": median(valid, "compaction_count"),
        "median_session_errors": median(valid, "session_error_calls"),
        "median_tool_errors": median(valid, "tool_error_calls"),
        "median_changed_files": median(valid, "changed_files"),
        "minimal_patch_score": minimal_patch_score(valid),
        "log_noise_handling_score": log_noise_handling_score(valid),
    }


def median(items: list[dict[str, Any]], key: str) -> float | int | None:
    values = [item[key] for item in items if isinstance(item.get(key), (int, float))]
    if not values:
        return None
    return round(statistics.median(values), 4)


def median_total_tokens(items: list[dict[str, Any]]) -> float | int | None:
    values = []
    for item in items:
        total = sum(
            value
            for value in [
                item.get("approx_input_tokens"),
                item.get("approx_output_tokens"),
                item.get("approx_cache_tokens"),
            ]
            if isinstance(value, (int, float))
        )
        if total:
            values.append(total)
    if not values:
        return None
    return round(statistics.median(values), 4)


def minimal_patch_score(items: list[dict[str, Any]]) -> float | None:
    if not items:
        return None
    scores = [1.0 if item.get("changed_files", 0) <= 2 else 2 / max(1, item.get("changed_files", 0)) for item in items]
    return round(statistics.mean(scores), 4)


def log_noise_handling_score(items: list[dict[str, Any]]) -> float | None:
    noisy = [item for item in items if item.get("task_id") == "T006-large-log-noise" and not item.get("failed_model")]
    if not noisy:
        return None
    passed = [item for item in noisy if item.get("verify_passed")]
    return round(len(passed) / len(noisy), 4)


def main() -> int:
    parser = argparse.ArgumentParser(description="Score OpenCode benchmark runs.")
    parser.add_argument("run_dir", type=Path)
    args = parser.parse_args()
    print(json.dumps(score(load_metrics(args.run_dir)), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
