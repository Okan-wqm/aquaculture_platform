"""ARIA worker executor (Plan 025 §E).

Per-assignment counterpart to tools/aria-poc/ci_executor.py
(planner). Receives ``assignment_id`` + ``target_agent`` on argv;
lease token via ``ARIA_LEASE_TOKEN`` env var (NEVER argv). Mock
mode (CLAUDE_CLI_MOCK=1) makes a deterministic no-op modification
+ commit in the worktree + submits the worker result via the kernel
``worker-result submit`` CLI. Live mode shells out to the Claude
Code CLI with the worker prompt.

Pre-fix the kernel had verification_gate primitives but no
executor that knew how to read a dispatch assignment, run the work
in the worktree, and submit the result. This script closes that
gap so the autonomous worker scheduler daemon
(aria_kernel.autonomous_worker_scheduler) can dispatch assignments
without a human-shaped invocation step.

Lease-token redaction discipline (mirrors ci_executor.py):
* Lease token transit ONLY via ``ARIA_LEASE_TOKEN`` env var.
* argv NEVER carries the raw token.
* Stderr redacted at every subprocess return surface.

Live-mode contract: the live ``claude`` CLI invocation shape is
locked under the proven-contract doc that the planner CLI also
references (``tools/aria-poc/ci_executor_contract_proven.md``).
Plan ARIA-V3 §B1 promoted the spike to load-bearing status; the
argv tuple below is verified against the doc's ``proven_argv``
YAML block by invariant I-V3-21.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

from claude_runtime import (
    CREDIT_FALLBACK_EFFORT,
    MODEL_FALLBACK_TIER,
    CLAUDE_MOCK_ENV_VAR,
    ClaudeAuthUnavailable,
    ClaudeCliUnavailable,
    ClaudePolicyViolation,
    ClaudeRunResult,
    ClaudeUsageUnavailable,
    run_claude_exec,
    run_with_model_fallback,
)


LEASE_TOKEN_ENV_VAR = "ARIA_LEASE_TOKEN"
MOCK_MODE_ENV_VAR = CLAUDE_MOCK_ENV_VAR


def _redact_lease_in_message(message: str, lease_token: str | None) -> str:
    if not lease_token:
        return message
    return message.replace(lease_token, "<lease-token-redacted>")


def _is_mock_mode() -> bool:
    return os.environ.get(MOCK_MODE_ENV_VAR, "0").strip().lower() in {"1", "true", "yes", "on"}


def _resolve_assignment(
    assignment_id: str, tools_dir: Path, repo: Path,
) -> dict[str, Any] | None:
    """Look up a dispatch assignment row by id via the kernel CLI."""
    list_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "worker", "list",
            "--state", "picked_up", "--json",
            "--tools-dir", str(tools_dir),
        ],
        capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(repo / "aria-kernel")},
    )
    if list_proc.returncode != 0:
        sys.stderr.write(
            _redact_lease_in_message(
                list_proc.stderr or "worker_list_failed",
                os.environ.get(LEASE_TOKEN_ENV_VAR),
            ) + "\n"
        )
        return None
    try:
        rows = json.loads(list_proc.stdout or "[]")
    except json.JSONDecodeError as exc:
        sys.stderr.write(f"worker_list_unparseable: {exc}\n")
        return None
    if not isinstance(rows, list):
        sys.stderr.write("worker_list_unexpected_shape\n")
        return None
    for row in rows:
        if isinstance(row, dict) and row.get("assignment_id") == assignment_id:
            return row
    return None


def _make_mock_worker_change(
    *, worktree_path: Path, assignment_id: str, expected_trailer: str,
) -> bool:
    """Apply a deterministic no-op modification + commit in the worktree.

    Mock mode marker — operators reading the worktree see exactly
    which assignment produced the change. The commit message
    carries the expected trailer so post-merge automation can
    dedup against the original pressure event.
    """
    sentinel = worktree_path / f".aria-mock-worker-{assignment_id}"
    sentinel.write_text(
        f"mock worker run for {assignment_id}\n", encoding="utf-8"
    )
    add = subprocess.run(
        ["git", "add", "-A"], cwd=worktree_path,
        capture_output=True, text=True, check=False,
    )
    if add.returncode != 0:
        sys.stderr.write(
            f"git_add_failed: {add.stderr.strip() or 'unknown'}\n"
        )
        return False
    commit_msg = f"chore(aria-worker-mock): {assignment_id}\n\n{expected_trailer}\n"
    commit = subprocess.run(
        [
            "git",
            "-c", "user.email=worker@aria.local",
            "-c", "user.name=ARIA Worker (mock)",
            "commit", "-m", commit_msg,
        ],
        cwd=worktree_path, capture_output=True, text=True, check=False,
    )
    if commit.returncode != 0:
        sys.stderr.write(
            f"git_commit_failed: {commit.stderr.strip() or 'unknown'}\n"
        )
        return False
    return True


def _submit_worker_result(
    *,
    assignment_id: str,
    worktree_path: Path,
    tools_dir: Path,
    repo: Path,
    required_tests: list[str],
    lease_token: str | None,
) -> int:
    """Submit the worker result via the kernel ``worker-result submit``
    subcommand. Lease token redaction applied to stderr."""
    if not lease_token:
        sys.stderr.write("missing_lease_token_env: ARIA_LEASE_TOKEN\n")
        return 1
    cmd = [
        "python3", "-m", "aria_kernel", "worker-result", "submit",
        "--from-worktree", str(worktree_path),
        "--assignment-id", assignment_id,
        "--tools-dir", str(tools_dir),
        "--lease-token-from-env", LEASE_TOKEN_ENV_VAR,
    ]
    for vc in required_tests:
        cmd.extend(["--validation-command", vc])
    submit = subprocess.run(
        cmd, capture_output=True, text=True,
        env={**os.environ, "PYTHONPATH": str(repo / "aria-kernel")},
    )
    if submit.returncode != 0:
        sys.stderr.write(
            _redact_lease_in_message(submit.stderr, lease_token) + "\n"
        )
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(
        prog="worker_executor.py",
        description="ARIA worker executor — Plan 025 §E.",
    )
    parser.add_argument("assignment_id")
    parser.add_argument("target_agent", nargs="?", default="aria-worker")
    parsed = parser.parse_args(args)

    assignment_id = parsed.assignment_id
    repo = Path.cwd().resolve()
    tools_dir = repo / "aria-tools"
    lease_token = os.environ.get(LEASE_TOKEN_ENV_VAR)

    assignment = _resolve_assignment(assignment_id, tools_dir, repo)
    if assignment is None:
        sys.stderr.write(
            f"assignment_not_found_or_not_picked_up: {assignment_id}\n"
        )
        return 1

    worktree_path = Path(str(assignment.get("worktree_path") or ""))
    if not worktree_path.is_absolute():
        worktree_path = (repo / worktree_path).resolve()
    if not worktree_path.exists():
        sys.stderr.write(f"worktree_missing: {worktree_path}\n")
        return 1
    required_tests = [
        str(c) for c in (assignment.get("required_tests") or [])
        if isinstance(c, str)
    ]
    expected_trailer = str(assignment.get("expected_trailer") or "")

    if _is_mock_mode():
        ok = _make_mock_worker_change(
            worktree_path=worktree_path,
            assignment_id=assignment_id,
            expected_trailer=expected_trailer,
        )
        if not ok:
            return 1
        return _submit_worker_result(
            assignment_id=assignment_id,
            worktree_path=worktree_path,
            tools_dir=tools_dir,
            repo=repo,
            required_tests=required_tests,
            lease_token=lease_token,
        )

    prompt_file = (
        tools_dir / "dispatch" / "prompts" / f"{assignment_id}.md"
    )
    prompt_text = prompt_file.read_text(encoding="utf-8") if prompt_file.exists() else ""
    # Resolve the per-agent model/effort tier from frontmatter (fail-safe:
    # most expensive tier).
    from aria_kernel.agent_runtime_profile import read_agent_runtime_profile

    profile = read_agent_runtime_profile(parsed.target_agent, repo_root=repo)
    try:
        # Model dispatch with the fable→opus fallback policy (credit +
        # refusal), applied by the claude_runtime SSoT helper — identical
        # policy to ci_executor, stderr as this path's audit channel.
        def _dispatch_attempt(model: str, effort: str) -> ClaudeRunResult:
            return run_claude_exec(
                prompt_text=prompt_text,
                timeout_seconds=int(assignment.get("timeout_seconds") or 1800),
                model=model,
                effort=effort,
                cwd=worktree_path,
            )

        # ORPHAN-HIGH-478 — derived from the ladder, not the literal
        # fable->opus@xhigh hop, which stopped being true when the write tier
        # moved to opus and the ladder gained its opus->sonnet rung.
        _fallback_target = MODEL_FALLBACK_TIER.get(model, "(none)")

        def _on_credit(marker: dict[str, Any]) -> None:
            sys.stderr.write(
                f"model_credit_fallback assignment={assignment_id} "
                f"marker={marker.get('matched_marker')!r} "
                f"{model}->{_fallback_target}@{CREDIT_FALLBACK_EFFORT}\n"
            )

        def _on_refusal(refusal: dict[str, Any]) -> None:
            sys.stderr.write(
                f"model_refusal_fallback assignment={assignment_id} "
                f"category={refusal.get('category')!r} {model}->{_fallback_target}\n"
            )

        completed = run_with_model_fallback(
            run=_dispatch_attempt,
            model=profile.model,
            effort=profile.effort,
            on_credit=_on_credit,
            on_refusal=_on_refusal,
        )
        if completed.refusal is not None:
            sys.stderr.write(
                "model_safety_refusal_unresolved: assignment "
                f"{assignment_id} refused (category="
                f"{completed.refusal.get('category')!r}); operator triage required\n"
            )
            return 1
    except (ClaudeAuthUnavailable, ClaudeCliUnavailable, ClaudePolicyViolation, ClaudeUsageUnavailable) as exc:
        sys.stderr.write(_redact_lease_in_message(str(exc), lease_token) + "\n")
        return 1
    if completed.returncode != 0:
        sys.stderr.write(
            _redact_lease_in_message(completed.stderr, lease_token) + "\n"
        )
        return completed.returncode
    return _submit_worker_result(
        assignment_id=assignment_id,
        worktree_path=worktree_path,
        tools_dir=tools_dir,
        repo=repo,
        required_tests=required_tests,
        lease_token=lease_token,
    )


if __name__ == "__main__":
    raise SystemExit(main())
