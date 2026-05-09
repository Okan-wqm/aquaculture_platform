"""ARIA CI executor (Plan 019 Phase 8.B).

Orchestrates one cycle of {next-pending → claim → invoke Claude Code →
submit-result} per GHA run. Designed to be called from
`.github/workflows/aria-agent-executor.yml`; the kernel CLI does the
queue/lease/submit work, and this script handles the Claude Code CLI
invocation in the middle.

Lease-token redaction discipline (operator critique #9):
  - Lease token flows ONLY through ARIA_LEASE_TOKEN env var.
  - argv NEVER carries the raw token — the executor uses
    `--lease-token-from-env ARIA_LEASE_TOKEN` so the kernel reads from
    os.environ at submit time.
  - Artifact upload limited to expected_output_path only; claims.jsonl
    + runs.jsonl explicitly excluded.

Cost-cap discipline:
  - MAX_TURNS_PER_RUN, MAX_REQUESTS_PER_RUN, MAX_TIMEOUT_SECONDS env
    vars enforce a budget cap before invoking the CLI; cap exceedance
    is logged and skipped rather than failing the run (budget signal,
    not build failure).
  - The Claude Code CLI's own --max-turns / --max-requests are layer 2.
  - kernel submit_claim_result budget guard is layer 3.

Invocation contract: see tools/aria-poc/ci_executor_contract_spike.md
for the full spike doc. The actual `claude code agent ...` CLI form
remains UNVERIFIED at Phase 8 commit time; CLAUDE_CODE_MOCK=1 wires the
test fixture path; CLAUDE_CODE_MOCK=0 (default) requires the operator to
have a live `claude` binary on $PATH and a valid OAuth token.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


DEFAULT_MAX_TURNS = 12
DEFAULT_MAX_REQUESTS = 30
DEFAULT_TIMEOUT_SECONDS = 1800

LEASE_TOKEN_ENV_VAR = "ARIA_LEASE_TOKEN"
OAUTH_TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"
MOCK_MODE_ENV_VAR = "CLAUDE_CODE_MOCK"


class CostCapExceeded(Exception):
    """The request would exceed the configured cost cap; skip + log."""


class ClaudeCodeUnavailable(Exception):
    """The `claude` binary is not on $PATH (CI env not provisioned)."""


def _redact_lease_in_message(message: str, lease_token: str | None) -> str:
    """Defensive: never let the raw token slip into a log message."""
    if not lease_token:
        return message
    return message.replace(lease_token, "<lease-token-redacted>")


def _max_turns() -> int:
    return int(os.environ.get("MAX_TURNS_PER_RUN", DEFAULT_MAX_TURNS))


def _max_requests() -> int:
    return int(os.environ.get("MAX_REQUESTS_PER_RUN", DEFAULT_MAX_REQUESTS))


def _max_timeout_seconds() -> int:
    return int(os.environ.get("MAX_TIMEOUT_SECONDS", DEFAULT_TIMEOUT_SECONDS))


def _is_mock_mode() -> bool:
    return os.environ.get(MOCK_MODE_ENV_VAR, "0") == "1"


def _validate_cost_cap(*, request: dict[str, Any]) -> None:
    """Reject requests whose budget shape exceeds the configured cap.

    The kernel's request envelope MAY carry a hint of the expected
    verdict cardinality (e.g. judges that scan many evidence_refs). When
    a hint is absent the executor permits the run and lets the
    Claude Code CLI's own --max-turns enforce the second layer.
    """
    expected_evidence_count = len(request.get("evidence_refs") or [])
    if expected_evidence_count > _max_turns() * 4:  # rough heuristic: 4 refs per turn
        raise CostCapExceeded(
            f"request.evidence_refs count {expected_evidence_count} exceeds "
            f"MAX_TURNS_PER_RUN={_max_turns()} * 4 cap"
        )


def invoke_claude_code(
    *,
    request_id: str,
    subagent_type: str,
    prompt_file: Path,
    output_path: Path,
    timeout_seconds: int,
    claim_id: str | None = None,
    agent_id: str | None = None,
    role: str | None = None,
    must_satisfy: list[dict[str, Any]] | None = None,
) -> int:
    """Call the Claude Code CLI; mock path for tests + CI dry-runs.

    Plan 024 v3 §B-8 — mock envelope reads REAL lease tokens (claim_id
    + agent_id from claim_request) and REAL role (from the request
    row). Pre-fix the mock hardcoded ``claim_id="claim_mock"`` +
    ``agent_id="ci-executor:mock"`` which Plan 023 §A-5 lease binding
    rejects on submit; the "end-to-end mock" was therefore broken at
    the submission boundary.

    Returns the CLI exit code. Raises ClaudeCodeUnavailable when the
    `claude` binary is not on $PATH and mock mode is OFF — this is the
    contract-gap case the spike doc tracks.
    """
    if _is_mock_mode():
        # Test path: write a deterministic mock envelope to the output
        # path the kernel will then read on submit. The mock envelope
        # passes the agent_contract.validate_response shape check
        # (Plan 023 §A-5 lease binding + Plan 024 §H-4 role match)
        # because claim_id + agent_id come from the real claim_request
        # output and role is read from the request row.
        if not claim_id or not agent_id:
            raise ValueError(
                "ci_executor_mock_missing_lease_identity: claim_id and "
                "agent_id are required (Plan 024 §B-8); the legacy "
                "claim_mock / ci-executor:mock literals were removed."
            )
        # Synthesize a satisfaction_matrix that satisfies must_satisfy
        # so Plan 024 §B-2 evidence_validator (non-empty matrix
        # enforcement) does not reject the mock envelope.
        matrix: list[dict[str, Any]] = []
        if must_satisfy:
            for criterion in must_satisfy:
                cid = criterion.get("id") if isinstance(criterion, dict) else None
                if cid:
                    matrix.append({
                        "id": cid,
                        "verdict": "satisfied",
                        "evidence_refs": [],
                    })
        envelope_role = role or subagent_type.replace("aria-", "").replace("-judge", "_judgment")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps({
                "$schema": "aria/agent-response/v1",
                "request_id": request_id,
                "claim_id": claim_id,
                "agent_id": agent_id,
                "role": envelope_role,
                "status": "submitted",
                "satisfaction_matrix": matrix,
                "evidence_refs": [],
                "details": {
                    "verdict": {
                        "verdict": "uncertain",
                        "confidence": 0.5,
                        "judge_id": subagent_type,
                        "model": "mock",
                        "rationale": "MOCK MODE — CI executor placeholder; real Claude Code invocation not configured",
                        "evidence_refs": [],
                        "judgment_group_id": "ci-mock",
                        "severity": "low",
                    },
                },
            }, indent=2),
            encoding="utf-8",
        )
        return 0

    if shutil.which("claude") is None:
        raise ClaudeCodeUnavailable(
            "`claude` binary not on $PATH; the spike doc at "
            "tools/aria-poc/ci_executor_contract_spike.md tracks the "
            "remaining contract gap. Set CLAUDE_CODE_MOCK=1 to run the "
            "executor's outer pipeline against a deterministic mock."
        )

    # Production path — UNVERIFIED contract per spike doc.
    # The operator must run this once against a live Claude Code CLI to
    # confirm the flag set is correct; the spike doc remains the SSoT.
    argv = [
        "claude",
        "code",
        "agent",
        "--subagent-type", subagent_type,
        "--prompt-file", str(prompt_file),
        "--output-path", str(output_path),
        "--max-turns", str(_max_turns()),
        "--max-requests", str(_max_requests()),
        "--timeout-seconds", str(timeout_seconds),
    ]
    completed = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 30,
    )
    return completed.returncode


def main(argv: list[str] | None = None) -> int:
    """Entry point — runs one cycle. Designed to be called by GHA step."""
    args = argv if argv is not None else sys.argv[1:]
    if len(args) < 1:
        print("usage: ci_executor.py <request_id> [subagent_type]", file=sys.stderr)
        return 2

    request_id = args[0]
    subagent_type = args[1] if len(args) > 1 else "aria-evidence-judge"

    repo = Path.cwd().resolve()
    tools_dir = repo / "aria-tools"

    # Step 1 — claim the request through the kernel CLI.
    claim_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent", "claim",
            "--request-id", request_id,
            "--agent-id", f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}",
            "--tools-dir", str(tools_dir),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo / "aria-kernel")},
    )
    if claim_proc.returncode != 0:
        sys.stderr.write(_redact_lease_in_message(claim_proc.stderr, None) + "\n")
        return 1
    try:
        claim = json.loads(claim_proc.stdout)
    except json.JSONDecodeError:
        sys.stderr.write(f"claim output not JSON: {claim_proc.stdout[:200]}\n")
        return 1

    lease_token = claim.get("lease_token")
    claim_id = claim.get("claim_id")
    expected_output_path = Path(claim.get("expected_output_path") or "")

    if not lease_token or not claim_id:
        sys.stderr.write("claim missing lease_token or claim_id\n")
        return 1

    # Step 2 — load the request envelope (for cost-cap evaluation).
    request_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent", "list-requests",
            "--request-id", request_id,
            "--tools-dir", str(tools_dir),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo / "aria-kernel")},
    )
    request_envelope: dict[str, Any] = {}
    if request_proc.returncode == 0:
        try:
            rows = json.loads(request_proc.stdout)
            request_envelope = rows[0] if isinstance(rows, list) and rows else {}
        except (json.JSONDecodeError, IndexError):
            request_envelope = {}

    try:
        _validate_cost_cap(request=request_envelope)
    except CostCapExceeded as exc:
        sys.stderr.write(f"cost_cap_exceeded: {exc}\n")
        # Release the claim so it can be re-tried after operator review.
        subprocess.run(
            [
                "python3", "-m", "aria_kernel", "agent", "release",
                "--claim-id", claim_id,
                "--lease-token-from-env", LEASE_TOKEN_ENV_VAR,
                "--reason", "cost_cap_exceeded",
                "--tools-dir", str(tools_dir),
            ],
            env={
                **os.environ,
                "PYTHONPATH": str(repo / "aria-kernel"),
                LEASE_TOKEN_ENV_VAR: lease_token,
            },
        )
        return 0  # cost-cap exceedance is a budget signal, NOT a build failure

    # Step 3 — invoke Claude Code (mocked in tests, real CLI in prod).
    prompt_file = tools_dir / "agent-invocations" / "prompts" / f"{request_id}.md"
    timeout = _max_timeout_seconds()
    try:
        # Plan 024 v3 §B-8 — pass real lease identity + role from
        # request row into the mock envelope writer. claim_id +
        # agent_id come from the kernel CLI's claim output (line 209-
        # 211); role + must_satisfy come from the request_envelope
        # we already loaded for cost-cap evaluation.
        agent_identity = f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}"
        cli_exit = invoke_claude_code(
            request_id=request_id,
            subagent_type=subagent_type,
            prompt_file=prompt_file,
            output_path=expected_output_path,
            timeout_seconds=timeout,
            claim_id=claim_id,
            agent_id=agent_identity,
            role=request_envelope.get("role"),
            must_satisfy=request_envelope.get("must_satisfy") or [],
        )
    except ClaudeCodeUnavailable as exc:
        sys.stderr.write(_redact_lease_in_message(str(exc), lease_token) + "\n")
        return 1

    if cli_exit != 0:
        sys.stderr.write(f"claude code agent exited {cli_exit}\n")
        return 1

    # Step 4 — submit through the kernel CLI; lease-token via env var.
    submit_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent", "submit-result",
            "--claim-id", claim_id,
            "--agent-id", f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}",
            "--lease-token-from-env", LEASE_TOKEN_ENV_VAR,
            "--output-path", str(expected_output_path),
            "--workspace-root", str(repo),
            "--tools-dir", str(tools_dir),
        ],
        capture_output=True,
        text=True,
        env={
            **os.environ,
            "PYTHONPATH": str(repo / "aria-kernel"),
            LEASE_TOKEN_ENV_VAR: lease_token,
        },
    )
    if submit_proc.returncode != 0:
        sys.stderr.write(
            _redact_lease_in_message(submit_proc.stderr, lease_token) + "\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
