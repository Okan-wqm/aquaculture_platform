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

# Plan 025 §B — Tier-3 invariant: the live-path request-envelope fetch
# uses the canonical ``agent-invocations list --request-id`` subcommand,
# NOT a non-existent ``agent list-requests`` call. Pre-fix the executor
# shelled out to ``python3 -m aria_kernel agent list-requests …`` which
# argparse rejects with ``invalid choice: 'list-requests'`` on every run;
# the result was a returncode!=0 that the executor silently swallowed
# into ``request_envelope = {}``, masking the live path failure for
# every CI run. The constant is exported so a regression test can pin
# the argv shape at module-load time + AST-grep can prove no other
# argv shape is constructed by the executor (one teaching surface, one
# enforcement seam).
REQUEST_ENVELOPE_LIST_ARGV: tuple[str, ...] = (
    "agent-invocations",
    "list",
    "--request-id",
)


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


_TRUTHY_BOOL_VALUES: frozenset[str] = frozenset({"1", "true", "yes", "on"})
_FALSY_BOOL_VALUES: frozenset[str] = frozenset({"0", "false", "no", "off", ""})


def _parse_bool_env(name: str, default: str = "0") -> bool:
    """Plan 026R §B.2 — case-insensitive multi-token bool env var parser.

    Pre-§B.2 ``_is_mock_mode`` did ``os.environ.get(...) == "1"`` only,
    so a workflow that exported ``CLAUDE_CODE_MOCK=true`` (the common
    shell convention) silently fell to mock=OFF → ``ClaudeCodeUnavailable``
    raise → CI exit code 1. The bug is REAL in today's CI.

    Accepts the canonical truthy/falsy set:

    * Truthy: ``1``, ``true``, ``yes``, ``on`` (any case).
    * Falsy:  ``0``, ``false``, ``no``, ``off``, empty string.

    Any other value raises ``ValueError`` (no silent fallback to either
    side — typo in a workflow should fail loud).
    """
    raw = os.environ.get(name, default).strip().lower()
    if raw in _TRUTHY_BOOL_VALUES:
        return True
    if raw in _FALSY_BOOL_VALUES:
        return False
    raise ValueError(
        f"{name}={raw!r} is not a recognised boolean "
        f"(truthy={sorted(_TRUTHY_BOOL_VALUES)}, "
        f"falsy={sorted(_FALSY_BOOL_VALUES)})"
    )


def _is_mock_mode() -> bool:
    # Plan 026R §B.2 — case-insensitive multi-token bool. Today's CI
    # workflow exports CLAUDE_CODE_MOCK=true; pre-§B.2 that string
    # silently coerced to mock=OFF.
    return _parse_bool_env(MOCK_MODE_ENV_VAR, default="0")


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
    role: str,
    must_satisfy: list[dict[str, Any]] | None = None,
) -> int:
    """Call the Claude Code CLI; mock path for tests + CI dry-runs.

    Plan 024 v3 §B-8 — mock envelope reads REAL lease tokens (claim_id
    + agent_id from claim_request) and REAL role (from the request
    row). Pre-fix the mock hardcoded ``claim_id="claim_mock"`` +
    ``agent_id="ci-executor:mock"`` which Plan 023 §A-5 lease binding
    rejects on submit; the "end-to-end mock" was therefore broken at
    the submission boundary.

    Plan 025 §B — ``role`` is a REQUIRED keyword (no default). Pre-fix
    a ``role: str | None = None`` default fed a string-mangle fallback
    in the mock branch (``role or subagent_type.replace(…)``) which
    silently re-introduced the kind of synthesized identity that §B-8
    closed for hard-coded literals. Promoting role to a required
    parameter makes the missing-role surface a TypeError at the call
    site (tier-1 structural enforcement) — every caller must source
    role from the request row's SSoT field.

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
        # Plan 025 §B latent-bug-2 closure — no string-mangle fallback.
        # Pre-fix ``role or subagent_type.replace("aria-", "").replace
        # ("-judge", "_judgment")`` re-introduced the synthesized role
        # pattern that §B-8 explicitly removed for claim_id + agent_id.
        # role is now required at the function signature; if a caller
        # passes "" (truthy-falsy edge), surface the gap as
        # ValueError instead of fabricating a role string.
        if not role.strip():
            raise ValueError(
                "ci_executor_mock_missing_role: role is required and "
                "must be non-empty (Plan 025 §B latent-bug-2 closure). "
                "Source role from the request envelope's SSoT field."
            )
        envelope_role = role
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


def _release_claim(
    *,
    tools_dir: Path,
    repo: Path,
    claim_id: str,
    agent_id: str,
    lease_token: str,
    reason: str,
) -> None:
    """Release a leased claim with a structured reason code.

    Plan 025 §B — extracted from the cost-cap path so every fail-fast
    branch in ``main()`` releases the lease deterministically. Without
    this helper a fail-fast branch could leak a claim row in the
    CLAIMED state until lease expiry, blocking re-attempts by the
    kernel reaper for the configured lease window. The reason code is
    surfaced verbatim to ``aria-kernel agent release --reason`` so
    operators reading governance.jsonl see the precise fail-mode.

    Plan 026R §B.1 — REAL CI BUG fix. Pre-§B.1 the argv was missing
    ``--agent-id`` (the kernel CLI requires it) AND the CLI did not
    accept ``--lease-token-from-env`` (the parser had no such flag).
    Today's CI fail-fast branches that call this helper FAILED at
    argparse and silently leaked the claim until reaper sweep. The
    fix adds ``--agent-id`` to the argv + the matching CLI flag
    registration in §B.1's cli.py change.
    """
    subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent", "release",
            "--claim-id", claim_id,
            "--agent-id", agent_id,
            "--lease-token-from-env", LEASE_TOKEN_ENV_VAR,
            "--reason", reason,
            "--tools-dir", str(tools_dir),
        ],
        env={
            **os.environ,
            "PYTHONPATH": str(repo / "aria-kernel"),
            LEASE_TOKEN_ENV_VAR: lease_token,
        },
    )


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

    # Plan 026R §B.1 — agent_id is computed once + reused for every
    # subsequent kernel CLI call (claim + release fail-fast branches +
    # submit-result). Pre-§B.1 release_claim did not need agent_id;
    # post-§B.1 it does, and lease-bound release requires the SAME
    # agent_id that claimed the request (kernel enforces).
    agent_id = f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}"

    # Step 1 — claim the request through the kernel CLI.
    claim_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent", "claim",
            "--request-id", request_id,
            "--agent-id", agent_id,
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

    if not lease_token or not claim_id:
        sys.stderr.write("claim missing lease_token or claim_id\n")
        return 1

    # Step 2 — load the request envelope from the SSoT (request row).
    # Plan 025 §B — uses the canonical ``agent-invocations list
    # --request-id`` subcommand. Pre-fix the executor called a non-
    # existent ``agent list-requests`` (cli.py:725-776 registers only
    # next-pending / claim / heartbeat / release / reap-stale /
    # submit-result; ``list-requests`` was never registered) and on
    # any non-zero returncode silently fell through to ``{}``,
    # masking every CI failure as a successful no-op (zero envelope
    # populated → zero cost-cap evaluation → zero meaningful run).
    # ``expected_output_path`` lives ONLY on the request row
    # (claim_request:633-655 returns a minimal lease-event dict that
    # does NOT carry it); reading it from the claim row was the
    # surface bug. All four failure modes — subprocess error, JSON
    # parse error, empty result list (request_id not found), missing
    # required field on the row — release the claim with a
    # structured reason and return 1 rather than fall through. This
    # closes Planner-B's silent-swallow + Path("") + missing-role
    # latent bugs in the same atomic batch.
    request_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", *REQUEST_ENVELOPE_LIST_ARGV,
            request_id,
            "--tools-dir", str(tools_dir),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo / "aria-kernel")},
    )
    if request_proc.returncode != 0:
        sys.stderr.write(
            f"request_envelope_load_failed: returncode="
            f"{request_proc.returncode} stderr="
            f"{request_proc.stderr[:200]}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_load_failed",
        )
        return 1
    try:
        rows = json.loads(request_proc.stdout)
    except json.JSONDecodeError as exc:
        sys.stderr.write(
            f"request_envelope_load_failed: json parse {exc}; "
            f"stdout={request_proc.stdout[:200]}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_load_failed",
        )
        return 1
    if not isinstance(rows, list) or not rows:
        sys.stderr.write(
            f"request_envelope_not_found: request_id={request_id}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_not_found",
        )
        return 1
    request_envelope = rows[0]
    if not request_envelope.get("expected_output_path"):
        sys.stderr.write(
            f"request_envelope_missing_expected_output_path: "
            f"request_id={request_id}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_missing_expected_output_path",
        )
        return 1
    if not request_envelope.get("role"):
        sys.stderr.write(
            f"request_envelope_missing_role: request_id={request_id}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason="request_envelope_missing_role",
        )
        return 1
    expected_output_path = Path(request_envelope["expected_output_path"])

    try:
        _validate_cost_cap(request=request_envelope)
    except CostCapExceeded as exc:
        sys.stderr.write(f"cost_cap_exceeded: {exc}\n")
        # Plan 025 §B — release via the shared helper so every fail-
        # fast branch in ``main()`` releases the lease deterministically
        # (no claim row leaked in CLAIMED state until lease expiry).
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token, reason="cost_cap_exceeded",
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
            # Plan 025 §B — request_envelope["role"] is now guaranteed
            # populated (validated above); direct subscript surfaces a
            # KeyError if a future regression skips the validation.
            role=request_envelope["role"],
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
