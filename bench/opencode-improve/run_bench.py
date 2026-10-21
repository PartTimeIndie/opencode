from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import shlex
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from log_compress import compress_log
from score import score

ROOT = Path(__file__).resolve().parent
REPO_ROOT = ROOT.parent.parent
TASKS = ROOT / "tasks"
RUNS = ROOT / "runs"
SMOKE_TASKS = ["T001-duration-parser", "T002-range-merge", "T006-large-log-noise", "T008-generated-guard"]
HARD_TASKS = [
    "T011-url-canonicalizer",
    "T012-csv-roundtrip",
    "T013-safe-path-join",
    "T014-email-mime-summary",
    "T015-json-money-loader",
]
BENCH_AGENTS = [
    "bench-gpt-low-base",
    "bench-gpt-low-compact",
    "bench-gpt-none-fast",
    "bench-gpt-none-surgical",
    "bench-openrouter-free",
    "bench-opencode-deepseek-free",
    "bench-opencode-mimo-free",
    "bench-opencode-nemotron-free",
    "bench-opencode-north-free",
]
MODEL_FAILURE = re.compile(r"(model|provider|agent|auth|credential|api key|not found|invalid|unauthorized|forbidden)", re.IGNORECASE)
PROVIDER_TIMEOUT = re.compile(r"(MessageAbortedError|response headers timed out|provider.*timed out|timed out after \d+ms)", re.IGNORECASE)
SAFE_FEATURES = [
    "core_search_limits",
    "stable_tool_output_preview",
    "runner_request_metrics",
    "read_deduplication",
    "compact_tool_schemas",
    "patch_verify_tool",
]
SCHEMA_CACHE_FEATURES = SAFE_FEATURES + ["tool_materialization_cache"]
SUBAGENT_FEATURES = SAFE_FEATURES
FULL_SPEED_FEATURES = SCHEMA_CACHE_FEATURES + ["batch_core_tools", "deferred_tool_discovery"]
DEFERRED_TOOL_FEATURES = FULL_SPEED_FEATURES + ["deferred_tool_discovery"]
COMPACT_TOOL_FEATURES = FULL_SPEED_FEATURES + ["compact_tool_schemas"]
COMBINED_TOOL_FEATURES = FULL_SPEED_FEATURES + ["deferred_tool_discovery", "compact_tool_schemas"]
PATCH_VERIFY_FEATURES = COMPACT_TOOL_FEATURES + ["patch_verify_tool"]
BATCH_TOOL_FEATURES = COMPACT_TOOL_FEATURES + ["batch_core_tools"]
ALL_TOOL_FEATURES = FULL_SPEED_FEATURES + ["deferred_tool_discovery", "compact_tool_schemas", "patch_verify_tool", "batch_core_tools"]
DEEP_MATRIX = [
    {
        "matrix_case": "baseline",
        "optimization_profile": "off",
        "feature_flags": "",
        "include_verify_context": False,
        "defer_verification_to_harness": False,
        "include_source_context": False,
    },
    {
        "matrix_case": "prompt-current",
        "optimization_profile": "off",
        "feature_flags": "",
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "core-safe",
        "optimization_profile": "safe",
        "feature_flags": ",".join(SAFE_FEATURES),
    },
    {
        "matrix_case": "schema-cache",
        "optimization_profile": "safe",
        "feature_flags": ",".join(SCHEMA_CACHE_FEATURES),
    },
    {
        "matrix_case": "subagent-artifact",
        "optimization_profile": "safe",
        "feature_flags": ",".join(SUBAGENT_FEATURES),
    },
    {
        "matrix_case": "full-speed",
        "optimization_profile": "speed",
        "feature_flags": ",".join(FULL_SPEED_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "deferred-tools",
        "optimization_profile": "speed",
        "feature_flags": ",".join(DEFERRED_TOOL_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "compact-tools",
        "optimization_profile": "speed",
        "feature_flags": ",".join(COMPACT_TOOL_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "combined-tools",
        "optimization_profile": "speed",
        "feature_flags": ",".join(COMBINED_TOOL_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "patch-verify",
        "optimization_profile": "speed",
        "feature_flags": ",".join(PATCH_VERIFY_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "batch-tools",
        "optimization_profile": "speed",
        "feature_flags": ",".join(BATCH_TOOL_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
    {
        "matrix_case": "all-tools",
        "optimization_profile": "speed",
        "feature_flags": ",".join(ALL_TOOL_FEATURES),
        "include_verify_context": True,
        "defer_verification_to_harness": False,
        "include_source_context": True,
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run benchmark tasks through configured OpenCode agents.")
    parser.add_argument("--suite", choices=["smoke", "all", "hard"], default="smoke")
    parser.add_argument("--tasks", help="Comma-separated task IDs")
    parser.add_argument("--agents", help="Comma-separated agent names")
    parser.add_argument("--repetitions", type=int, default=1)
    parser.add_argument("--timeout", type=int, help="Seconds per OpenCode run")
    parser.add_argument("--label", default="run")
    parser.add_argument("--disable-external-skills", action="store_true", help="Disable external skill scans during benchmark runs")
    parser.add_argument("--pure", action="store_true", help="Run opencode without external plugins during benchmark runs")
    parser.add_argument("--include-verify-context", action="store_true", help="Append compressed initial verify failure output to the agent prompt")
    parser.add_argument("--defer-verification-to-harness", action="store_true", help="Tell the agent the harness will verify after it finishes")
    parser.add_argument("--include-source-context", action="store_true", help="Append compact non-test Python source context to the agent prompt")
    parser.add_argument("--optimization-profile", choices=["off", "safe", "speed"], default="off")
    parser.add_argument("--feature-flags", default=None, help="Comma-separated optimization feature flags for the benchmark run")
    parser.add_argument("--matrix", choices=["single", "deep"], default="single")
    parser.add_argument("--nightly-report", nargs="?", const="", default=None, help="Write a deep-matrix markdown and JSON summary")
    args = parser.parse_args()

    opencode = resolve_opencode()
    bash = resolve_bash()
    run_dir = RUNS / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}_{safe_slug(args.label)}"
    run_dir.mkdir(parents=True, exist_ok=True)
    run_plan = build_run_plan(args)

    (run_dir / "run_config.json").write_text(
        json.dumps(
            {
                "suite": args.suite,
                "matrix": args.matrix,
                "nightly_report": args.nightly_report is not None,
                "run_plan": [run_plan_item(item) for item in run_plan],
                "opencode": opencode,
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    for plan_args in run_plan:
        selected_tasks = select_tasks(plan_args)
        selected_agents = plan_args.agents.split(",") if plan_args.agents else default_agents(plan_args.suite)
        timeout = plan_args.timeout or (600 if plan_args.suite == "smoke" else 1200)
        for task_id in selected_tasks:
            for agent in selected_agents:
                for repetition in range(1, plan_args.repetitions + 1):
                    run_one(run_dir, task_id, agent, repetition, timeout, opencode, bash, plan_args)

    if args.nightly_report is not None:
        write_nightly_report(run_dir, args.nightly_report)

    print(run_dir)
    return 0


def build_run_plan(args: argparse.Namespace) -> list[argparse.Namespace]:
    if args.matrix == "single":
        return [copy_args(args, {"matrix_case": "single", "matrix_suite": args.suite})]
    suites = ["all", "hard"] if args.nightly_report is not None and not args.tasks else [args.suite]
    repetitions = max(args.repetitions, 3) if args.nightly_report is not None else args.repetitions
    return [
        copy_args(
            args,
            {
                **matrix_case,
                "suite": suite,
                "matrix_suite": suite,
                "repetitions": repetitions,
                "include_verify_context": matrix_case.get("include_verify_context", args.include_verify_context),
                "defer_verification_to_harness": matrix_case.get(
                    "defer_verification_to_harness", args.defer_verification_to_harness
                ),
                "include_source_context": matrix_case.get("include_source_context", args.include_source_context),
            },
        )
        for suite in suites
        for matrix_case in DEEP_MATRIX
    ]


def copy_args(args: argparse.Namespace, overrides: dict[str, Any]) -> argparse.Namespace:
    values = vars(args).copy()
    values.update(overrides)
    return argparse.Namespace(**values)


def run_plan_item(args: argparse.Namespace) -> dict[str, Any]:
    selected_tasks = select_tasks(args)
    selected_agents = args.agents.split(",") if args.agents else default_agents(args.suite)
    return {
        "matrix_case": args.matrix_case,
        "suite": args.suite,
        "tasks": selected_tasks,
        "agents": selected_agents,
        "repetitions": args.repetitions,
        "timeout": args.timeout or (600 if args.suite == "smoke" else 1200),
        "optimization_profile": args.optimization_profile,
        "optimization_features": active_features(args),
        "disable_external_skills": args.disable_external_skills,
        "pure": args.pure,
        "include_verify_context": args.include_verify_context,
        "defer_verification_to_harness": args.defer_verification_to_harness,
        "include_source_context": args.include_source_context,
    }


def select_tasks(args: argparse.Namespace) -> list[str]:
    if args.tasks:
        return [item.strip() for item in args.tasks.split(",") if item.strip()]
    if args.suite == "smoke":
        return SMOKE_TASKS
    if args.suite == "hard":
        return HARD_TASKS
    return sorted(path.name for path in TASKS.iterdir() if path.is_dir())


def default_agents(suite: str) -> list[str]:
    if suite == "smoke":
        return ["bench-gpt-low-base", "bench-gpt-low-compact"]
    return BENCH_AGENTS


def resolve_opencode() -> list[str]:
    if os.environ.get("OPENCODE_BENCH_CMD"):
        return shlex.split(os.environ["OPENCODE_BENCH_CMD"])
    for command in [["opencode"], ["bun", "--conditions=browser", str(REPO_ROOT / "packages" / "opencode" / "src" / "index.ts")]]:
        try:
            subprocess.run(command + ["--version"], cwd=REPO_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
            return command
        except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
    raise SystemExit("Could not find opencode CLI. Set OPENCODE_BENCH_CMD.")


def resolve_bash() -> list[str] | None:
    if os.environ.get("OPENCODE_BENCH_BASH"):
        return shlex.split(os.environ["OPENCODE_BENCH_BASH"])
    candidates = [["bash"], [r"C:\Program Files\Git\bin\bash.exe"], [r"C:\Program Files\Git\usr\bin\bash.exe"]]
    for command in candidates:
        if len(command) == 1 or Path(command[0]).exists():
            try:
                result = subprocess.run(command + ["-lc", "pwd"], cwd=REPO_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
            if result.returncode == 0 and str(REPO_ROOT).replace("\\", "/").lower() in result.stdout.replace("\\", "/").lower():
                return command
    return None


def run_one(
    run_dir: Path,
    task_id: str,
    agent: str,
    repetition: int,
    timeout: int,
    opencode: list[str],
    bash: list[str] | None,
    args: argparse.Namespace,
) -> None:
    task_dir = TASKS / task_id
    out_dir = output_dir(run_dir, task_id, agent, repetition, args)
    out_dir.mkdir(parents=True, exist_ok=True)
    started_at = datetime.now(UTC).isoformat()
    run_id = "-".join(
        [
            run_dir.name,
            safe_slug(str(getattr(args, "matrix_case", "single"))),
            safe_slug(str(getattr(args, "matrix_suite", args.suite))),
            safe_slug(task_id),
            safe_slug(agent),
            str(repetition),
        ]
    )
    metrics: dict[str, Any] = {
        "matrix_case": getattr(args, "matrix_case", "single"),
        "matrix_suite": getattr(args, "matrix_suite", args.suite),
        "task_id": task_id,
        "agent": agent,
        "repetition": repetition,
        "optimization_profile": args.optimization_profile,
        "optimization_features": active_features(args),
        "started_at": started_at,
        "wall_time_sec": 0,
        "exit_code": None,
        "verify_passed": False,
        "failed_model": False,
        "provider_timeout": False,
        "timeout": False,
        "changed_files": 0,
        "lines_added": 0,
        "lines_deleted": 0,
        "approx_input_tokens": None,
        "approx_output_tokens": None,
        "approx_cache_tokens": None,
        "approx_cost": None,
        "tool_calls_total": None,
        "bash_calls": None,
        "read_calls": None,
        "write_or_edit_calls": None,
        "tool_error_calls": None,
        "request_assembly_ms": None,
        "runner_tool_count": None,
        "tool_schema_bytes": None,
        "context_estimate_tokens": None,
        "compaction_count": 0,
        "feature_faults": [],
        "failure_reason": None,
    }

    setup = run_setup(task_dir, task_id, run_id, bash)
    (out_dir / "setup.stdout.log").write_text(setup.stdout, encoding="utf-8", errors="replace")
    (out_dir / "setup.stderr.log").write_text(setup.stderr, encoding="utf-8", errors="replace")
    if setup.returncode != 0:
        metrics["failure_reason"] = "setup_failed"
        metrics["exit_code"] = setup.returncode
        write_metrics(out_dir, metrics)
        return

    workspace = Path(setup.stdout.strip().splitlines()[-1])
    prompt = build_prompt(task_id, task_dir, workspace, bash, args, out_dir)
    start = time.monotonic()
    stdout = ""
    stderr = ""
    try:
        result = subprocess.run(
            opencode + ["run", "--agent", agent, "--format", "json", "--dangerously-skip-permissions", prompt],
            cwd=workspace,
            env=opencode_env(args),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        stdout = result.stdout
        stderr = result.stderr
        metrics["exit_code"] = result.returncode
    except subprocess.TimeoutExpired as error:
        stdout = error.stdout or ""
        stderr = error.stderr or ""
        metrics["exit_code"] = None
        metrics["timeout"] = True
        metrics["failure_reason"] = "timeout"
    metrics["wall_time_sec"] = round(time.monotonic() - start, 4)

    (out_dir / "stdout.log").write_text(stdout, encoding="utf-8", errors="replace")
    (out_dir / "stderr.log").write_text(stderr, encoding="utf-8", errors="replace")
    events = parse_events(stdout)
    (out_dir / "events.jsonl").write_text("\n".join(json.dumps(event) for event in events) + ("\n" if events else ""), encoding="utf-8")
    metrics.update(extract_event_metrics(events))
    metrics.update(extract_runtime_metrics(events, stderr))

    failure_output = stdout + "\n" + stderr
    if (metrics["exit_code"] not in (0, None) or metrics["timeout"]) and PROVIDER_TIMEOUT.search(failure_output):
        metrics["failed_model"] = True
        metrics["provider_timeout"] = True
        metrics["failure_reason"] = "provider_timeout"
    elif (metrics["exit_code"] not in (0, None) or metrics["timeout"]) and MODEL_FAILURE.search(failure_output):
        metrics["failed_model"] = True
        metrics["failure_reason"] = "failed_model"

    verify = run_verify(task_id, task_dir, workspace, bash)
    (out_dir / "verify.log").write_text(verify.stdout, encoding="utf-8", errors="replace")
    metrics["verify_passed"] = verify.returncode == 0
    if not metrics["failure_reason"] and not metrics["verify_passed"]:
        metrics["failure_reason"] = "verify_failed"
    if not metrics["failure_reason"] and metrics["verify_passed"]:
        metrics["failure_reason"] = "pass"

    diff = subprocess.run(["git", "diff"], cwd=workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    (out_dir / "diff.patch").write_text(diff.stdout, encoding="utf-8", errors="replace")
    metrics.update(diff_metrics(workspace))
    write_metrics(out_dir, metrics)


def output_dir(run_dir: Path, task_id: str, agent: str, repetition: int, args: argparse.Namespace) -> Path:
    if getattr(args, "matrix_case", "single") == "single":
        return run_dir / task_id / agent / str(repetition)
    return run_dir / args.matrix_case / args.matrix_suite / task_id / agent / str(repetition)


def run_setup(task_dir: Path, task_id: str, run_id: str, bash: list[str] | None) -> subprocess.CompletedProcess[str]:
    if bash:
        return subprocess.run(bash + [str(task_dir / "setup.sh"), run_id], cwd=REPO_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    workspace = ROOT / "tmp" / task_id / run_id
    if not workspace.resolve().is_relative_to((ROOT / "tmp").resolve()):
        return subprocess.CompletedProcess(args=[], returncode=2, stdout="", stderr=f"refusing unsafe workspace: {workspace}")
    shutil.rmtree(workspace, ignore_errors=True)
    shutil.copytree(task_dir / "repo_template", workspace / "repo")
    (workspace / "repo" / ".gitignore").write_text("__pycache__/\n*.pyc\n", encoding="utf-8")
    git = subprocess.run(["git", "init", "-q"], cwd=workspace / "repo", text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if git.returncode != 0:
        return subprocess.CompletedProcess(args=[], returncode=git.returncode, stdout="", stderr=git.stderr)
    git = subprocess.run(["git", "add", "."], cwd=workspace / "repo", text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if git.returncode != 0:
        return subprocess.CompletedProcess(args=[], returncode=git.returncode, stdout="", stderr=git.stderr)
    git = subprocess.run(
        ["git", "-c", "user.email=benchmark@example.invalid", "-c", "user.name=benchmark", "commit", "-q", "-m", "baseline"],
        cwd=workspace / "repo",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return subprocess.CompletedProcess(args=[], returncode=git.returncode, stdout=str(workspace / "repo") + "\n", stderr=git.stderr)


def run_verify(task_id: str, task_dir: Path, workspace: Path, bash: list[str] | None) -> subprocess.CompletedProcess[str]:
    if bash:
        return subprocess.run(bash + [str(task_dir / "verify.sh"), str(workspace)], cwd=REPO_ROOT, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    test = subprocess.run([sys.executable, "-B", "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    output = test.stdout
    if test.returncode != 0:
        return test
    if task_id == "T008-generated-guard":
        import hashlib

        current = hashlib.sha256((workspace / "generated" / "generated_table.py").read_bytes()).hexdigest()
        expected = hashlib.sha256((workspace / "tests" / "fixtures" / "generated_table.py.expected").read_bytes()).hexdigest()
        if current != expected:
            return subprocess.CompletedProcess(args=[], returncode=1, stdout=output + f"generated/generated_table.py changed: {current} != {expected}\n")
    if task_id == "T010-minimal-patch":
        changed_count = len(set(git_lines(workspace, ["diff", "--name-only"]) + git_lines(workspace, ["ls-files", "--others", "--exclude-standard"])))
        if changed_count > 2:
            return subprocess.CompletedProcess(args=[], returncode=1, stdout=output + f"too many changed files: {changed_count}\n")
    if (task_dir / "hidden_verify.py").exists():
        hidden = subprocess.run([sys.executable, str(task_dir / "hidden_verify.py"), str(workspace)], cwd=workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        output += hidden.stdout
        if hidden.returncode != 0:
            return subprocess.CompletedProcess(args=[], returncode=hidden.returncode, stdout=output)
    return test


def build_prompt(task_id: str, task_dir: Path, workspace: Path, bash: list[str] | None, args: argparse.Namespace, out_dir: Path) -> str:
    prompt = (task_dir / "prompt.md").read_text(encoding="utf-8")
    if args.include_source_context:
        prompt += source_context(workspace)
    if not args.include_verify_context:
        return prompt

    verify = run_verify(task_id, task_dir, workspace, bash)
    (out_dir / "initial_verify.log").write_text(verify.stdout, encoding="utf-8", errors="replace")
    compressed = compress_log(verify.stdout)
    (out_dir / "initial_verify_compressed.log").write_text(str(compressed["text"]), encoding="utf-8", errors="replace")
    verification_instruction = (
        "The external benchmark harness will run the verifier after your final answer. Do not run test or verify commands yourself unless the code path is ambiguous."
        if args.defer_verification_to_harness
        else "Avoid broad exploration, make the smallest safe edit, then run the verifier exactly once after editing."
    )
    source_instruction = (
        " The supplied source/test context is intended to be sufficient for the first patch; do not read files already shown there unless a patch attempt fails or line context is missing."
        if args.include_source_context
        else ""
    )
    patch_verify_instruction = (
        " If apply_patch_and_verify is available, prefer it over separate apply_patch and verifier bash calls when you are ready to patch and run the verifier."
        if "patch_verify_tool" in active_features(args)
        else ""
    )
    batch_tool_instruction = (
        " If batch_read, batch_glob, or batch_grep are available, prefer them for known multi-file reads or multiple related searches instead of sequential single-tool calls."
        if "batch_core_tools" in active_features(args)
        else ""
    )
    return (
        prompt
        + "\n\nInitial verifier context:\n"
        + f"- Exit code: {verify.returncode}\n"
        + f"- Original lines: {compressed['original_lines']}\n"
        + f"- Compressed lines: {compressed['compressed_lines']}\n"
        + "\nCompressed verifier output:\n```\n"
        + str(compressed["text"])
        + "\n```\n\n"
        + "Use this verifier output to target the fix. "
        + verification_instruction
        + source_instruction
        + patch_verify_instruction
        + batch_tool_instruction
        + " Visible verifier command from the workspace: `python -B -m unittest discover -s tests -v`."
    )


def source_context(workspace: Path) -> str:
    sections = []
    total = 0
    for name in git_lines(workspace, ["ls-files"]):
        normalized = name.replace("\\", "/")
        if not normalized.endswith(".py"):
            continue
        if normalized.startswith("generated/"):
            continue
        path = workspace / normalized
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        if total + len(text) > 20000:
            break
        total += len(text)
        sections.append(f"### {normalized}\n```python\n{text.rstrip()}\n```")
    if not sections:
        return ""
    return (
        "\n\nCompact source/test context supplied by the benchmark harness. These are the likely editable Python files for this task. "
        "Prefer patching directly from this context before reading files, and keep any follow-up exploration narrowly focused:\n"
        + "\n\n".join(sections)
    )


def parse_events(stdout: str) -> list[dict[str, Any]]:
    events = []
    for line in stdout.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            events.append(value)
    return events


def opencode_env(args: argparse.Namespace) -> dict[str, str]:
    env = os.environ.copy()
    env["OPENCODE_CONFIG"] = str(REPO_ROOT / ".opencode" / "opencode.jsonc")
    env["OPENCODE_OPTIMIZATION_PROFILE"] = args.optimization_profile
    env["OPENCODE_OPTIMIZATION_FEATURES"] = ",".join(active_features(args))
    if args.disable_external_skills:
        env["OPENCODE_DISABLE_EXTERNAL_SKILLS"] = "1"
        env["OPENCODE_DISABLE_CLAUDE_CODE_SKILLS"] = "1"
    if args.pure:
        env["OPENCODE_PURE"] = "1"
    return env


def active_features(args: argparse.Namespace) -> list[str]:
    if args.feature_flags is None:
        return profile_default_features(args.optimization_profile)
    return normalized_features(args.feature_flags.split(","))


def profile_default_features(profile: str) -> list[str]:
    if profile == "safe":
        return normalized_features(SAFE_FEATURES)
    if profile == "speed":
        return normalized_features(FULL_SPEED_FEATURES + ["deferred_tool_discovery"])
    return []


def normalized_features(items: list[str]) -> list[str]:
    features = []
    seen = set()
    for item in items:
        normalized = item.strip().replace("-", "_")
        if not normalized or normalized.lower() in {"off", "none", "false"} or normalized in seen:
            continue
        seen.add(normalized)
        features.append(normalized)
    return features


def extract_event_metrics(events: list[dict[str, Any]]) -> dict[str, Any]:
    turns: dict[str, dict[str, float]] = {}
    tools: dict[str, set[str]] = {"all": set(), "bash": set(), "read": set(), "write": set(), "error": set()}
    session_errors: set[str] = set()
    for event in events:
        event_type = typed_event_name(event.get("type"))
        part = event.get("part")
        if event_type == "step_finish" and isinstance(part, dict):
            collect_step_finish(part, turns)
            continue
        if event_type == "tool_use" and isinstance(part, dict):
            collect_tool_use(part, tools)
            continue
        if event_type == "session_error":
            collect_session_error(event, session_errors)
    return {
        "approx_input_tokens": int(sum(item["input"] for item in turns.values())) or None,
        "approx_output_tokens": int(sum(item["output"] for item in turns.values())) or None,
        "approx_cache_tokens": int(sum(item["cache"] for item in turns.values())) or None,
        "approx_cost": round(sum(item["cost"] for item in turns.values()), 8) or None,
        "tool_calls_total": len(tools["all"]) or None,
        "bash_calls": len(tools["bash"]) or None,
        "read_calls": len(tools["read"]) or None,
        "write_or_edit_calls": len(tools["write"]) or None,
        "tool_error_calls": len(tools["error"]) or None,
        "session_error_calls": len(session_errors) or None,
    }


def extract_runtime_metrics(events: list[dict[str, Any]], text: str) -> dict[str, Any]:
    values: dict[str, list[float]] = {
        "request_assembly_ms": [],
        "runner_tool_count": [],
        "tool_schema_bytes": [],
        "context_estimate_tokens": [],
    }
    compaction_reasons: list[str] = []
    feature_faults: list[str] = []
    for event in events:
        collect_runtime_value(event, values, compaction_reasons, feature_faults)
    for line in text.splitlines():
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            continue
        collect_runtime_line(line, values, compaction_reasons, feature_faults)
    return {
        "request_assembly_ms": round(sum(values["request_assembly_ms"]), 4) if values["request_assembly_ms"] else None,
        "runner_tool_count": int(max(values["runner_tool_count"])) if values["runner_tool_count"] else None,
        "tool_schema_bytes": int(max(values["tool_schema_bytes"])) if values["tool_schema_bytes"] else None,
        "context_estimate_tokens": int(max(values["context_estimate_tokens"])) if values["context_estimate_tokens"] else None,
        "compaction_count": len(compaction_reasons),
        "compaction_reasons": compaction_reasons,
        "feature_faults": sorted(set(feature_faults)),
    }


def collect_runtime_value(
    value: Any,
    values: dict[str, list[float]],
    compaction_reasons: list[str],
    feature_faults: list[str],
) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).replace("-", "_")
            metric_key = "runner_tool_count" if normalized == "tool_count" else normalized
            if metric_key in values:
                token = numeric_token(child)
                if token:
                    values[metric_key].append(token)
            if normalized == "compaction_trigger_reason" and child:
                compaction_reasons.append(str(child))
            if normalized == "feature_fault" and child:
                feature_faults.append(str(child))
            collect_runtime_value(child, values, compaction_reasons, feature_faults)
        return
    if isinstance(value, list):
        for item in value:
            collect_runtime_value(item, values, compaction_reasons, feature_faults)


def collect_runtime_line(
    line: str,
    values: dict[str, list[float]],
    compaction_reasons: list[str],
    feature_faults: list[str],
) -> None:
    for key in ["request_assembly_ms", "tool_schema_bytes", "context_estimate_tokens"]:
        match = re.search(rf"{key}[^0-9]+([0-9]+(?:\.[0-9]+)?)", line)
        if match:
            values[key].append(float(match.group(1)))
    match = re.search(r"tool_count[^0-9]+([0-9]+(?:\.[0-9]+)?)", line)
    if match:
        values["runner_tool_count"].append(float(match.group(1)))
    match = re.search(r"compaction_trigger_reason[^A-Za-z0-9_-]+([A-Za-z0-9_-]+)", line)
    if match:
        compaction_reasons.append(match.group(1))
    lowered = line.lower()
    if "optimization" in lowered and ("fault" in lowered or "error" in lowered):
        feature_faults.append(line[:240])


def typed_event_name(value: Any) -> str:
    return str(value or "").replace(".", "_").replace("-", "_")


def collect_step_finish(part: dict[str, Any], turns: dict[str, dict[str, float]]) -> None:
    tokens = part.get("tokens") if isinstance(part.get("tokens"), dict) else {}
    cache = tokens.get("cache") if isinstance(tokens.get("cache"), dict) else {}
    turns[str(part.get("id") or len(turns))] = {
        "input": numeric_token(tokens.get("input")),
        "output": numeric_token(tokens.get("output")) + numeric_token(tokens.get("reasoning")),
        "cache": numeric_token(cache.get("read")) + numeric_token(cache.get("write")),
        "cost": numeric_token(part.get("cost")),
    }


def collect_tool_use(part: dict[str, Any], tools: dict[str, set[str]]) -> None:
    tool_name = str(part.get("tool") or "")
    identifier = str(part.get("callID") or part.get("callId") or part.get("id") or f"{tool_name}:{len(tools['all'])}")
    lowered = tool_name.lower()
    tools["all"].add(identifier)
    if "bash" in lowered:
        tools["bash"].add(identifier)
    if lowered in {"read", "view"} or "read" in lowered:
        tools["read"].add(identifier)
    if lowered in {"write", "edit", "apply_patch", "patch"} or "write" in lowered or "edit" in lowered:
        tools["write"].add(identifier)
    state = part.get("state") if isinstance(part.get("state"), dict) else {}
    if state.get("status") == "error":
        tools["error"].add(identifier)


def collect_session_error(event: dict[str, Any], session_errors: set[str]) -> None:
    session_errors.add(
        str(event.get("id") or event.get("sessionID") or event.get("sessionId") or event.get("timestamp") or len(session_errors))
    )


def numeric_token(value: Any) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else 0


def numeric(value: Any, fallback: float = 0.0) -> float:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else fallback


def format_number(value: Any) -> str:
    if value is None or value == "":
        return ""
    if isinstance(value, float):
        return f"{value:.4g}"
    return str(value)


def diff_metrics(workspace: Path) -> dict[str, Any]:
    changed = [path for path in git_lines(workspace, ["diff", "--name-only"]) if metric_path(path)]
    untracked = [path for path in git_lines(workspace, ["ls-files", "--others", "--exclude-standard"]) if metric_path(path)]
    numstat = [line for line in git_lines(workspace, ["diff", "--numstat"]) if len(line.split("\t")) < 3 or metric_path(line.split("\t", 2)[2])]
    added = 0
    deleted = 0
    for line in numstat:
        parts = line.split("\t")
        if len(parts) >= 2:
            added += int(parts[0]) if parts[0].isdigit() else 0
            deleted += int(parts[1]) if parts[1].isdigit() else 0
    for name in untracked:
        path = workspace / name
        if path.is_file():
            try:
                added += len(path.read_text(encoding="utf-8", errors="ignore").splitlines())
            except OSError:
                pass
    return {
        "changed_files": len(set(changed + untracked)),
        "changed_file_paths": sorted(set(changed + untracked)),
        "lines_added": added,
        "lines_deleted": deleted,
    }


def metric_path(value: str) -> bool:
    normalized = value.replace("\\", "/")
    return not (
        normalized == ".opencode"
        or normalized.startswith(".opencode/")
        or "/__pycache__/" in f"/{normalized}/"
        or normalized.endswith(".pyc")
    )


def git_lines(workspace: Path, args: list[str]) -> list[str]:
    result = subprocess.run(["git"] + args, cwd=workspace, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode != 0:
        return []
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def write_metrics(out_dir: Path, metrics: dict[str, Any]) -> None:
    (out_dir / "metrics.json").write_text(json.dumps(metrics, indent=2), encoding="utf-8")


def write_nightly_report(run_dir: Path, report: str) -> None:
    metrics = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(run_dir.glob("**/metrics.json"))]
    baseline = [item for item in metrics if item.get("matrix_case") == "baseline"]
    cases = sorted({str(item.get("matrix_case") or "single") for item in metrics})
    summaries = [nightly_case_summary(case, [item for item in metrics if item.get("matrix_case") == case], baseline) for case in cases]
    report_path, json_path = nightly_report_paths(run_dir, report)
    sections = [
        f"# Deep Matrix Nightly Report: {run_dir.name}",
        "",
        "## Adoption Summary",
        "",
        "| Case | Profile | Features | Runs | Valid Pass | Median Time | Median Tokens | Request Assembly | Tool Schema | Compactions | Decision |",
        "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ]
    for item in summaries:
        sections.append(
            "| {case} | {profile} | {features} | {runs} | {pass_rate} | {time} | {tokens} | {request} | {schema} | {compactions} | {decision} |".format(
                case=item["case"],
                profile=item["optimization_profile"],
                features=", ".join(item["optimization_features"]) or "none",
                runs=item["runs"],
                pass_rate=format_number(item["valid_pass_rate"]),
                time=format_number(item["median_wall_time"]),
                tokens=format_number(item["median_tokens_total"]),
                request=format_number(item["request_assembly_ms"]),
                schema=format_number(item["tool_schema_bytes"]),
                compactions=format_number(item["compaction_count"]),
                decision=item["decision"],
            )
        )
    sections.extend(["", "## Suite Breakdown", "", suite_breakdown(metrics)])
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text("\n".join(sections) + "\n", encoding="utf-8")
    json_path.write_text(json.dumps({"run_dir": str(run_dir), "cases": summaries}, indent=2), encoding="utf-8")


def nightly_report_paths(run_dir: Path, report: str) -> tuple[Path, Path]:
    if not report:
        return run_dir / "nightly_report.md", run_dir / "nightly_report.json"
    configured = Path(report)
    path = configured if configured.is_absolute() else run_dir / configured
    if path.suffix.lower() == ".json":
        return path.with_suffix(".md"), path
    return path, path.with_suffix(".json")


def nightly_case_summary(case: str, metrics: list[dict[str, Any]], baseline: list[dict[str, Any]]) -> dict[str, Any]:
    result = score(metrics)
    base = score(baseline)
    return {
        "case": case,
        "optimization_profile": first_value(metrics, "optimization_profile") or "off",
        "optimization_features": first_value(metrics, "optimization_features") or [],
        "runs": result["runs"],
        "valid_runs": result["valid_runs"],
        "valid_pass_rate": result["valid_pass_rate"],
        "median_wall_time": result["median_wall_time"],
        "median_tokens_total": result["median_tokens_total"],
        "request_assembly_ms": median(metrics, "request_assembly_ms"),
        "tool_schema_bytes": median(metrics, "tool_schema_bytes"),
        "context_estimate_tokens": median(metrics, "context_estimate_tokens"),
        "compaction_count": median(metrics, "compaction_count"),
        "feature_faults": sorted({fault for item in metrics for fault in item.get("feature_faults", []) if isinstance(fault, str)}),
        "decision": adoption_decision(result, base, metrics, baseline) if case != "baseline" else "baseline",
    }


def suite_breakdown(metrics: list[dict[str, Any]]) -> str:
    rows = ["| Case | Suite | Runs | Valid Pass | Median Time | Median Tokens | Decision |", "| --- | --- | ---: | ---: | ---: | ---: | --- |"]
    baseline_by_suite = {
        suite: [item for item in metrics if item.get("matrix_case") == "baseline" and item.get("matrix_suite") == suite]
        for suite in sorted({item.get("matrix_suite") for item in metrics})
    }
    for case in sorted({item.get("matrix_case") for item in metrics}):
        for suite in sorted({item.get("matrix_suite") for item in metrics if item.get("matrix_case") == case}):
            items = [item for item in metrics if item.get("matrix_case") == case and item.get("matrix_suite") == suite]
            result = score(items)
            base = score(baseline_by_suite.get(suite, []))
            rows.append(
                "| {case} | {suite} | {runs} | {pass_rate} | {time} | {tokens} | {decision} |".format(
                    case=case,
                    suite=suite,
                    runs=result["runs"],
                    pass_rate=format_number(result["valid_pass_rate"]),
                    time=format_number(result["median_wall_time"]),
                    tokens=format_number(result["median_tokens_total"]),
                    decision="baseline" if case == "baseline" else adoption_decision(result, base, items, baseline_by_suite.get(suite, [])),
                )
            )
    return "\n".join(rows)


def adoption_decision(
    result: dict[str, Any],
    base: dict[str, Any],
    metrics: list[dict[str, Any]],
    baseline: list[dict[str, Any]],
) -> str:
    if result["valid_runs"] == 0 or base["valid_runs"] == 0:
        return "needs-rerun"
    if bool([fault for item in metrics for fault in item.get("feature_faults", [])]):
        return "reject"
    if numeric(result["raw_pass_rate"]) < 0.95:
        return "reject"
    if numeric(result["valid_pass_rate"]) < 0.95:
        return "reject"
    if numeric(result["raw_pass_rate"]) < numeric(base["raw_pass_rate"]):
        return "reject"
    if numeric(result["valid_pass_rate"]) < numeric(base["valid_pass_rate"]):
        return "reject"
    if numeric(result["provider_timeout_runs"]) > numeric(base["provider_timeout_runs"]):
        return "reject"
    if numeric(result["failed_model_runs"]) > numeric(base["failed_model_runs"]):
        return "reject"
    if has_task_regression(metrics, baseline):
        return "reject"
    if median(metrics, "session_error_calls", fallback=0) > median(baseline, "session_error_calls", fallback=0):
        return "reject"
    if median(metrics, "tool_error_calls", fallback=0) > median(baseline, "tool_error_calls", fallback=0):
        return "reject"
    token_gain = relative_gain(base["median_tokens_total"], result["median_tokens_total"])
    time_gain = relative_gain(base["median_wall_time"], result["median_wall_time"])
    if token_gain >= 0.3 or time_gain >= 0.25:
        return "default-candidate"
    if token_gain > 0 or time_gain > 0:
        return "experimental"
    return "needs-rerun"


def has_task_regression(metrics: list[dict[str, Any]], baseline: list[dict[str, Any]]) -> bool:
    baseline_groups = group_by_regression_key(baseline)
    candidate_groups = group_by_regression_key(metrics)
    for key, base_items in baseline_groups.items():
        candidate_items = candidate_groups.get(key)
        if not candidate_items:
            return true_for_regression_baseline(base_items)
        base = score(base_items)
        candidate = score(candidate_items)
        if candidate["valid_runs"] == 0 and base["valid_runs"] > 0:
            return True
        if numeric(candidate["raw_pass_rate"]) < numeric(base["raw_pass_rate"]):
            return True
        if numeric(base["valid_pass_rate"]) >= 0.95 and numeric(candidate["valid_pass_rate"]) < numeric(base["valid_pass_rate"]):
            return True
    return False


def group_by_regression_key(metrics: list[dict[str, Any]]) -> dict[tuple[Any, Any, Any], list[dict[str, Any]]]:
    grouped: dict[tuple[Any, Any, Any], list[dict[str, Any]]] = {}
    for item in metrics:
        key = (item.get("matrix_suite"), item.get("task_id"), item.get("agent"))
        grouped.setdefault(key, []).append(item)
    return grouped


def true_for_regression_baseline(items: list[dict[str, Any]]) -> bool:
    result = score(items)
    return result["valid_runs"] > 0 and numeric(result["valid_pass_rate"]) >= 0.95


def first_value(metrics: list[dict[str, Any]], key: str) -> Any:
    for item in metrics:
        if item.get(key) not in (None, ""):
            return item[key]
    return None


def median(items: list[dict[str, Any]], key: str, fallback: float | None = None) -> float | int | None:
    values = [item[key] for item in items if isinstance(item.get(key), (int, float))]
    if not values:
        return fallback
    values = sorted(values)
    middle = len(values) // 2
    if len(values) % 2:
        return values[middle]
    return round((values[middle - 1] + values[middle]) / 2, 4)


def relative_gain(base: Any, candidate: Any) -> float:
    if not isinstance(base, (int, float)) or not isinstance(candidate, (int, float)) or base <= 0:
        return 0
    return round((base - candidate) / base, 4)


def safe_slug(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-") or "run"


if __name__ == "__main__":
    raise SystemExit(main())
