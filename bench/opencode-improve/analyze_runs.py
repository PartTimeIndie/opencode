from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any

from score import score

ROOT = Path(__file__).resolve().parent


def load_metrics(run_dir: Path) -> list[dict[str, Any]]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(run_dir.glob("**/metrics.json"))]


def resolve_run(value: str | None, exclude: Path | None = None) -> Path | None:
    if not value:
        return None
    runs = sorted([path for path in (ROOT / "runs").iterdir() if path.is_dir()]) if (ROOT / "runs").exists() else []
    if value == "latest":
        return runs[-1] if runs else None
    if value == "previous":
        candidates = [path for path in runs if path != exclude]
        return candidates[-1] if candidates else None
    path = Path(value)
    return path if path.is_absolute() else ROOT / value


def task_table(metrics: list[dict[str, Any]]) -> str:
    rows = [
        "| Case | Task | Agent | Pass | Time | Changed | Tokens | Cost | Failure |",
        "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for item in sorted(
        metrics,
        key=lambda next_item: (
            next_item.get("matrix_case", ""),
            next_item.get("task_id", ""),
            next_item.get("agent", ""),
            next_item.get("repetition", 0),
        ),
    ):
        tokens = sum(
            value
            for value in [item.get("approx_input_tokens"), item.get("approx_output_tokens"), item.get("approx_cache_tokens")]
            if isinstance(value, (int, float))
        )
        rows.append(
            "| {case} | {task} | {agent} | {passed} | {time} | {changed} | {tokens} | {cost} | {failure} |".format(
                case=item.get("matrix_case", "single"),
                task=item.get("task_id", ""),
                agent=item.get("agent", ""),
                passed="yes" if item.get("verify_passed") else "no",
                time=format_number(item.get("wall_time_sec")),
                changed=item.get("changed_files", ""),
                tokens=tokens or "",
                cost=format_number(item.get("approx_cost")),
                failure=(item.get("failure_reason") or "").replace("|", "/"),
            )
        )
    return "\n".join(rows)


def agent_summary(metrics: list[dict[str, Any]]) -> str:
    grouped = defaultdict(list)
    for item in metrics:
        grouped[(item.get("matrix_case", "single"), item.get("agent", ""))].append(item)
    rows = [
        "| Case | Profile | Agent | Runs | Valid | Raw Pass | Valid Pass | Median Time | Median Tokens | Request Assembly | Tool Schema | Compactions | Median Tools | Median Changed |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for (case, agent), items in sorted(grouped.items()):
        result = score(items)
        rows.append(
            "| {case} | {profile} | {agent} | {runs} | {valid} | {raw_pass_rate} | {valid_pass_rate} | {time} | {tokens} | {request} | {schema} | {compactions} | {tools} | {changed} |".format(
                case=case,
                profile=first_value(items, "optimization_profile") or "off",
                agent=agent,
                runs=result["runs"],
                valid=result["valid_runs"],
                raw_pass_rate=format_number(result["raw_pass_rate"]),
                valid_pass_rate=format_number(result["valid_pass_rate"]),
                time=format_number(result["median_wall_time"]),
                tokens=format_number(result["median_tokens_total"]),
                request=format_number(result["median_request_assembly_ms"]),
                schema=format_number(result["median_tool_schema_bytes"]),
                compactions=format_number(result["median_compaction_count"]),
                tools=format_number(result["median_tool_calls"]),
                changed=format_number(result["median_changed_files"]),
            )
        )
    return "\n".join(rows)


def comparison_table(baseline: list[dict[str, Any]], candidate: list[dict[str, Any]]) -> str:
    baseline_grouped = defaultdict(list)
    candidate_grouped = defaultdict(list)
    for item in baseline_reference(baseline):
        baseline_grouped[item.get("agent", "")].append(item)
    for item in candidate:
        candidate_grouped[(item.get("matrix_case", "single"), item.get("agent", ""))].append(item)
    rows = [
        "| Case | Agent | Baseline Valid Pass | Candidate Valid Pass | Baseline Time | Candidate Time | Baseline Tokens | Candidate Tokens | Decision |",
        "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for key in sorted(candidate_grouped):
        candidate_items = candidate_grouped.get(key, [])
        base_items = comparable_baseline_items(baseline_grouped.get(key[1], []), candidate_items)
        base = score(base_items)
        cand = score(candidate_grouped.get(key, []))
        rows.append(
            "| {case} | {agent} | {base_pass} | {cand_pass} | {base_time} | {cand_time} | {base_tokens} | {cand_tokens} | {decision} |".format(
                case=key[0],
                agent=key[1],
                base_pass=format_number(base["valid_pass_rate"]),
                cand_pass=format_number(cand["valid_pass_rate"]),
                base_time=format_number(base["median_wall_time"]),
                cand_time=format_number(cand["median_wall_time"]),
                base_tokens=format_number(base["median_tokens_total"]),
                cand_tokens=format_number(cand["median_tokens_total"]),
                decision=decision(base, cand, base_items, candidate_items),
            )
        )
    return "\n".join(rows)


def baseline_reference(metrics: list[dict[str, Any]]) -> list[dict[str, Any]]:
    baseline = [item for item in metrics if item.get("matrix_case") == "baseline"]
    return baseline or metrics


def comparable_baseline_items(
    baseline: list[dict[str, Any]],
    candidate: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    tasks = {item.get("task_id") for item in candidate if item.get("task_id")}
    suites = {item.get("matrix_suite") for item in candidate if item.get("matrix_suite")}
    task_matched = [item for item in baseline if not tasks or item.get("task_id") in tasks]
    suite_matched = [item for item in task_matched if item.get("matrix_suite") in suites]
    return suite_matched or task_matched


def decision(
    base: dict[str, Any],
    cand: dict[str, Any],
    baseline: list[dict[str, Any]] | None = None,
    candidate: list[dict[str, Any]] | None = None,
) -> str:
    if cand["valid_runs"] == 0:
        return "needs-rerun"
    if base["valid_runs"] == 0:
        return "experimental"
    if numeric(cand["raw_pass_rate"]) < 0.95:
        return "reject"
    if numeric(cand["valid_pass_rate"]) < 0.95:
        return "reject"
    if numeric(cand["raw_pass_rate"]) < numeric(base["raw_pass_rate"]):
        return "reject"
    if numeric(cand["valid_pass_rate"]) < numeric(base["valid_pass_rate"]):
        return "reject"
    if numeric(cand["provider_timeout_runs"]) > numeric(base["provider_timeout_runs"]):
        return "reject"
    if numeric(cand["failed_model_runs"]) > numeric(base["failed_model_runs"]):
        return "reject"
    if baseline is not None and candidate is not None and has_task_regression(candidate, baseline):
        return "reject"
    if numeric(cand["median_session_errors"]) > numeric(base["median_session_errors"]):
        return "reject"
    if numeric(cand["median_tool_errors"]) > numeric(base["median_tool_errors"]):
        return "reject"
    token_gain = relative_gain(base["median_tokens_total"], cand["median_tokens_total"])
    time_gain = relative_gain(base["median_wall_time"], cand["median_wall_time"])
    if token_gain >= 0.3 or time_gain >= 0.25:
        return "default-candidate"
    if token_gain > 0 or time_gain > 0:
        return "experimental"
    return "needs-rerun"


def has_task_regression(candidate: list[dict[str, Any]], baseline: list[dict[str, Any]]) -> bool:
    baseline_groups = group_by_regression_key(baseline)
    candidate_groups = group_by_regression_key(candidate)
    for key, base_items in baseline_groups.items():
        candidate_items = candidate_groups.get(key)
        if not candidate_items:
            result = score(base_items)
            return result["valid_runs"] > 0 and numeric(result["valid_pass_rate"]) >= 0.95
        base = score(base_items)
        cand = score(candidate_items)
        if cand["valid_runs"] == 0 and base["valid_runs"] > 0:
            return True
        if numeric(cand["raw_pass_rate"]) < numeric(base["raw_pass_rate"]):
            return True
        if numeric(base["valid_pass_rate"]) >= 0.95 and numeric(cand["valid_pass_rate"]) < numeric(base["valid_pass_rate"]):
            return True
    return False


def group_by_regression_key(metrics: list[dict[str, Any]]) -> dict[tuple[Any, Any], list[dict[str, Any]]]:
    grouped: dict[tuple[Any, Any], list[dict[str, Any]]] = {}
    for item in metrics:
        key = (item.get("task_id"), item.get("agent"))
        grouped.setdefault(key, []).append(item)
    return grouped


def first_value(metrics: list[dict[str, Any]], key: str) -> Any:
    for item in metrics:
        if item.get(key) not in (None, ""):
            return item[key]
    return None


def relative_gain(base: Any, candidate: Any) -> float:
    if not isinstance(base, (int, float)) or not isinstance(candidate, (int, float)) or base <= 0:
        return 0
    return round((base - candidate) / base, 4)


def numeric(value: Any, fallback: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) else fallback


def format_number(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, float):
        return f"{value:.4g}"
    return str(value)


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze OpenCode benchmark run artifacts.")
    parser.add_argument("--run", default="latest")
    parser.add_argument("--baseline")
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()

    run_dir = resolve_run(args.run)
    if not run_dir or not run_dir.exists():
        raise SystemExit(f"run not found: {args.run}")
    metrics = load_metrics(run_dir)
    baseline_dir = resolve_run(args.baseline, exclude=run_dir)
    baseline = load_metrics(baseline_dir) if baseline_dir and baseline_dir.exists() else []

    sections = [
        f"# Benchmark Report: {run_dir.name}",
        "",
        "## Summary",
        "",
        agent_summary(metrics),
        "",
        "## Task Results",
        "",
        task_table(metrics),
    ]
    if baseline:
        sections.extend(["", "## Baseline Comparison", "", comparison_table(baseline, metrics)])

    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text("\n".join(sections) + "\n", encoding="utf-8")
    print(args.report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
