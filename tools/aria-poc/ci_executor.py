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

Invocation contract: see tools/aria-poc/ci_executor_contract_proven.md
for the load-bearing contract — argv shape locked by Plan ARIA-V3
invariant I-V3-21. `CLAUDE_CODE_MOCK=1` wires the test fixture path;
`CLAUDE_CODE_MOCK=0` (default after Plan ARIA-V3 §B1) requires a live
`claude` binary on $PATH and a valid OAuth token; the workflow installs
both via the executor preflight steps.
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

# Plan 026R §B.5 — single-claim env-var contract (mirror of
# planner_dispatch_hook.CLAIM_METADATA_ENV_VAR). When set by the
# planner, ci_executor SKIPS its own ``agent claim`` step and uses
# the fused envelope + ledger-hash anchors from this var. The raw
# lease_token continues to transit ONLY via ARIA_LEASE_TOKEN — the
# metadata payload schema rejects it on both serialise + deserialise.
CLAIM_METADATA_ENV_VAR = "ARIA_CLAIM_METADATA"

# Forbidden keys in ARIA_CLAIM_METADATA — mirrors
# planner_dispatch_hook.CLAIM_METADATA_FORBIDDEN_KEYS. Source of truth
# for "what MUST NOT be serialised into the metadata env-var" lives at
# both boundaries so a tamper at one boundary is caught at the other.
CLAIM_METADATA_FORBIDDEN_KEYS = frozenset({"lease_token", "lease_token_hash"})

# Plan 025 §B → 026R §B.3 — the envelope-list subprocess fetch is GONE.
# §B.3 made ``agent claim`` return the full request envelope inside the
# same exclusive-lock window that performed the claim CAS, so the
# executor no longer needs a second subprocess hop to load the envelope.
# The legacy ``REQUEST_ENVELOPE_LIST_ARGV`` constant was the pre-§B.3
# Tier-3 invariant pin; it is preserved here ONLY as the migration
# audit trail and is referenced by the §B.3 AST regression test that
# asserts no callsite in this module still spawns the legacy argv. New
# code MUST read envelope fields from ``claim`` directly.
REQUEST_ENVELOPE_LIST_ARGV: tuple[str, ...] = (
    "agent-invocations",
    "list",
    "--request-id",
)


class CostCapExceeded(Exception):
    """The request would exceed the configured cost cap; skip + log."""


class ClaudeCodeUnavailable(Exception):
    """The `claude` binary is not on $PATH (CI env not provisioned)."""


# Plan ARIA-V7 §2g v2 Phase 7.3 — closed enum of dispatchable roles.
# Mirrors aria_kernel/dispatcher_factory.SUPPORTED_ROLES. Adding a
# role requires updating BOTH the consumer (this file) AND the
# kernel factory module. Closed enum prevents typo'd roles from
# silently flowing into the queue.
SUPPORTED_ROLES: frozenset[str] = frozenset({
    "specialist_domain_review",
    "primary_authoring",
    "challenger_authoring",
    "evidence_judgment",
    "adversarial_judgment",
    "primary_plan",
    "challenger_plan",
    "cross_review",
})


def claim_and_dispatch_one(
    *,
    role: str,
    tools_dir: Path,
    repo_root: Path,
) -> dict[str, Any]:
    """Plan ARIA-V7 §2g v2 Phase 7.3 — single-role claim + dispatch.

    Workflow:
      1. Validate role is in SUPPORTED_ROLES.
      2. Check ANTHROPIC_API_KEY env var presence (per
         DispatcherConfig). Absent → return
         ``{"status": "dispatchers_unavailable"}``.
      3. Find next pending request of the given role via
         ``aria-kernel agent-invocations list --role <role>
         --pending-only``.
      4. If no pending → return ``{"status": "no_pending"}``.
      5. Spawn this script as subprocess with ``request_id`` to
         exercise the existing claim → invoke → release flow.
      6. Capture subprocess result + return.

    Returns a dict with keys: ``status``, ``request_id``,
    ``role``, ``stdout_tail``, ``stderr_tail``, ``exit_code``.

    Used by the operator-runnable consumer loop:
      python tools/aria-poc/ci_executor.py --consume specialist_domain_review
    """
    if role not in SUPPORTED_ROLES:
        raise ValueError(
            f"claim_and_dispatch_one_unknown_role: {role!r} "
            f"(must be one of {sorted(SUPPORTED_ROLES)})"
        )

    if not os.environ.get("ANTHROPIC_API_KEY"):
        return {
            "status": "dispatchers_unavailable",
            "role": role,
            "reason": "ANTHROPIC_API_KEY env var not set",
        }

    # Find next pending request for this role.
    list_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent-invocations", "list",
            "--role", role,
            "--pending-only",
            "--limit", "1",
            "--tools-dir", str(tools_dir),
        ],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo_root / "aria-kernel")},
    )
    if list_proc.returncode != 0:
        return {
            "status": "list_failed",
            "role": role,
            "stderr_tail": list_proc.stderr[-1000:],
            "exit_code": list_proc.returncode,
        }

    try:
        pending = json.loads(list_proc.stdout)
    except json.JSONDecodeError:
        return {
            "status": "list_output_not_json",
            "role": role,
            "stdout_tail": list_proc.stdout[-500:],
        }

    if not pending:
        return {"status": "no_pending", "role": role}

    request = pending[0] if isinstance(pending, list) else pending
    request_id = request.get("request_id") or request.get("id")
    if not request_id:
        return {
            "status": "request_missing_id",
            "role": role,
            "raw": request,
        }

    target_agent = request.get("target_agent", "")
    dispatch_proc = subprocess.run(
        ["python3", str(Path(__file__).resolve()), request_id, target_agent],
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo_root / "aria-kernel")},
        cwd=str(repo_root),
    )
    return {
        "status": "dispatched" if dispatch_proc.returncode == 0 else "dispatch_failed",
        "request_id": request_id,
        "role": role,
        "target_agent": target_agent,
        "exit_code": dispatch_proc.returncode,
        "stdout_tail": dispatch_proc.stdout[-2000:],
        "stderr_tail": dispatch_proc.stderr[-2000:],
    }


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


def _max_budget_usd() -> float:
    """Plan ARIA-V7 §2g v2 — operator-tunable per-run USD cap for the
    modern Claude Code CLI invocation. The CLI's --max-budget-usd
    flag enforces this in-CLI; the kernel's budget guard (Plan
    ARIA-V3 §B0) is the third defense layer."""
    return float(os.environ.get("MAX_BUDGET_USD_PER_RUN", "2.0"))


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
    `claude` binary is not on $PATH and mock mode is OFF — the proven
    contract doc at tools/aria-poc/ci_executor_contract_proven.md is
    the argv SSoT (Plan ARIA-V3 §B1 promotion, invariant I-V3-21).
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
            "`claude` binary not on $PATH; the proven-contract doc at "
            "tools/aria-poc/ci_executor_contract_proven.md is the SSoT "
            "for argv shape. Set CLAUDE_CODE_MOCK=1 to run the "
            "executor's outer pipeline against a deterministic mock."
        )

    # Plan ARIA-V7 §2g v2 — PROVEN argv contract MIGRATED to modern
    # Claude Code CLI 2.1.140. The legacy ``claude code agent
    # --subagent-type X --prompt-file Y --output-path Z`` shape was
    # never live-verified (`claude code` subcommand REMOVED from
    # modern CLI). V7's parallel-consumer mode requires a working
    # contract. The migration is locked byte-for-byte by invariant
    # I-V3-21 against the updated
    # tools/aria-poc/ci_executor_contract_proven.md proven_argv
    # block.
    #
    # Modern shape:
    #   claude --print --agent <subagent_type> \\
    #          --max-budget-usd $MAX_BUDGET_USD_PER_RUN \\
    #          --output-format json
    #     < prompt_file  (stdin)
    #     > output_path  (stdout)
    #
    # Lease-token redaction discipline (Plan ARIA-V3 §B1) PRESERVED:
    # token flows only through env (CLAUDE_CODE_OAUTH_TOKEN +
    # ARIA_LEASE_TOKEN), never argv. The new argv shape carries NO
    # secrets.
    argv = [
        "claude",
        "--print",
        "--agent", subagent_type,
        "--max-budget-usd", str(_max_budget_usd()),
        "--output-format", "json",
    ]
    prompt_text = prompt_file.read_text(encoding="utf-8") if prompt_file.exists() else ""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    completed = subprocess.run(
        argv,
        input=prompt_text,
        capture_output=True,
        text=True,
        timeout=timeout_seconds + 30,
    )
    # Capture stdout to output_path (the modern CLI writes to stdout;
    # legacy --output-path flag was removed).
    if completed.stdout:
        output_path.write_text(completed.stdout, encoding="utf-8")
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


def _deserialise_inherited_claim_metadata(
    raw_payload: str,
    *,
    agent_id: str | None,
    request_id: str,
    tools_dir: Path,
) -> tuple[dict[str, Any], str | None]:
    """Plan 026R §B.5 — deserialise ARIA_CLAIM_METADATA + verify integrity.

    Returns ``(claim_dict, error_message)`` where ``error_message`` is
    None on success. The error_message is printed verbatim by main() so
    the operator audit trail captures the exact tamper / mismatch
    reason.

    Three invariants enforced:

    1. **Schema reject of forbidden keys** — the metadata payload MUST
       NOT contain ``lease_token`` or ``lease_token_hash``. Mirrors the
       sender-side reject in planner_dispatch_hook so a tamper at
       either boundary surfaces immediately.
    2. **agent_id binding** — if an expected agent_id is supplied,
       metadata's agent_id MUST equal it. Single-claim mode supplies
       None and adopts the planner hook's claim owner from metadata
       because that hook already performed the kernel claim.
    3. **Ledger-hash integrity** — ``claim_ledger_hash`` and
       ``request_ledger_hash`` are re-derived from on-disk
       claims.jsonl + requests.jsonl rows by claim_id / request_id and
       compared against the metadata anchors. A mismatch means the
       envelope was tampered between planner-claim time and executor-
       consume time (or the disk state diverged from what the planner
       observed under its lock window — the §B.3 lock-bound fusion
       prevents this in correct operation, so a mismatch is a real
       integrity signal).
    """
    try:
        metadata = json.loads(raw_payload)
    except json.JSONDecodeError as exc:
        return {}, f"single_claim_metadata_invalid_json: {exc}"
    if not isinstance(metadata, dict):
        return {}, "single_claim_metadata_not_object"

    leaked = CLAIM_METADATA_FORBIDDEN_KEYS & set(metadata.keys())
    if leaked:
        return (
            {},
            f"single_claim_metadata_forbidden_key: {sorted(leaked)} "
            f"— lease_token MUST transit only via {LEASE_TOKEN_ENV_VAR}",
        )

    if agent_id is not None and metadata.get("agent_id") != agent_id:
        return (
            {},
            f"single_claim_metadata_agent_id_mismatch: "
            f"metadata={metadata.get('agent_id')!r} executor={agent_id!r}",
        )
    if metadata.get("request_id") != request_id:
        return (
            {},
            f"single_claim_metadata_request_id_mismatch: "
            f"metadata={metadata.get('request_id')!r} "
            f"argv={request_id!r}",
        )

    claim_id = metadata.get("claim_id")
    expected_claim_hash = metadata.get("claim_ledger_hash")
    expected_request_hash = metadata.get("request_ledger_hash")
    if not (claim_id and expected_claim_hash and expected_request_hash):
        return (
            {},
            f"single_claim_metadata_missing_anchors: claim_id={claim_id!r} "
            f"claim_ledger_hash={expected_claim_hash!r} "
            f"request_ledger_hash={expected_request_hash!r}",
        )

    actual_claim_hash, actual_request_hash = _on_disk_anchors(
        tools_dir=tools_dir, claim_id=str(claim_id), request_id=request_id,
    )
    if actual_claim_hash != expected_claim_hash:
        return (
            {},
            f"single_claim_metadata_tampered_claim_ledger_hash: "
            f"expected={expected_claim_hash!r} actual={actual_claim_hash!r}",
        )
    if actual_request_hash != expected_request_hash:
        return (
            {},
            f"single_claim_metadata_tampered_request_ledger_hash: "
            f"expected={expected_request_hash!r} "
            f"actual={actual_request_hash!r}",
        )
    return metadata, None


def _on_disk_anchors(
    *, tools_dir: Path, claim_id: str, request_id: str,
) -> tuple[str | None, str | None]:
    """Read the on-disk ledger_hash for the named claim + request rows."""
    claims_path = tools_dir / "agent-invocations" / "claims.jsonl"
    requests_path = tools_dir / "agent-invocations" / "requests.jsonl"
    claim_hash: str | None = None
    request_hash: str | None = None
    if claims_path.exists():
        for raw in claims_path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if (
                row.get("claim_id") == claim_id
                and row.get("event") == "claimed"
            ):
                claim_hash = row.get("ledger_hash")
    if requests_path.exists():
        for raw in requests_path.read_text(encoding="utf-8").splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                row = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if row.get("request_id") == request_id:
                request_hash = row.get("ledger_hash")
    return claim_hash, request_hash


def _record_mock_mode_audit(tools_dir: Path) -> None:
    """Plan ARIA-V3 §B1 AUDITTRAIL-HIGH-009 — record which layer
    decided the CLAUDE_CODE_MOCK value at executor entry.

    The workflow's pre-flight step computes ``effective_mock`` +
    ``mock_source`` (kill_switch / workflow_dispatch_input /
    workflow_default_post_b1) and exports both via the env. This
    function appends one ``mock_mode_default_flipped`` governance
    row per executor invocation so an audit reviewer can replay the
    decision chain. Invariant I-V3-23a locks this contract.
    """
    try:
        # Late import — keeps the executor module importable when the
        # kernel package isn't on sys.path (mock-mode unit tests).
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "aria-kernel"))
        from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir
    except ImportError:
        return
    root = ensure_tools_dir(tools_dir)
    append_tools_governance(
        root,
        "mock_mode_default_flipped",
        {
            "effective_mock": os.environ.get(MOCK_MODE_ENV_VAR, "unset"),
            "mock_source": os.environ.get("CLAUDE_CODE_MOCK_SOURCE", "unset"),
            "workflow_run_id": os.environ.get("GITHUB_RUN_ID", "local"),
            "workflow_run_attempt": os.environ.get("GITHUB_RUN_ATTEMPT", "local"),
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
    # Plan ARIA-V7 §2g v2 — honor ARIA_TOOLS_DIR env var so the
    # consumer can run against a non-default tools directory (e.g.
    # the operator-side ./aria-tools-v7-30cycle verification dir).
    # Pre-V7 hardcoded `repo / "aria-tools"`; that broke the V7
    # parallel-consumer workflow where autonomy run + consumer
    # share a non-default tools_dir.
    _env_tools = os.environ.get("ARIA_TOOLS_DIR")
    if _env_tools:
        tools_dir = Path(_env_tools).resolve()
    else:
        tools_dir = repo / "aria-tools"

    # Plan ARIA-V3 §B1 AUDITTRAIL-HIGH-009 — single governance row
    # per executor invocation recording the effective mock state +
    # source. Runs BEFORE any kernel-side work so even an early
    # crash leaves the mock-mode decision in the audit log.
    _record_mock_mode_audit(tools_dir)

    # Plan 026R §B.1 — agent_id is computed once + reused for every
    # subsequent kernel CLI call (claim + release fail-fast branches +
    # submit-result). Pre-§B.1 release_claim did not need agent_id;
    # post-§B.1 it does, and lease-bound release requires the SAME
    # agent_id that claimed the request (kernel enforces).
    agent_id = f"ci-executor:gha-{os.environ.get('GITHUB_RUN_ID', 'local')}"

    # Plan 026R §B.5 — single-claim mode. When the planner has already
    # claimed the request and exported ARIA_CLAIM_METADATA + ARIA_LEASE_
    # TOKEN, this executor SKIPS its own ``agent claim`` step and uses
    # the inherited envelope + ledger-hash anchors directly. Pre-§B.5
    # the subprocess re-claimed (double-claim) and the defensive reject
    # was noisy + tagged every planner-driven cycle as a failure.
    metadata_env = os.environ.get(CLAIM_METADATA_ENV_VAR)
    if metadata_env:
        claim, single_claim_error = _deserialise_inherited_claim_metadata(
            metadata_env,
            agent_id=None,
            request_id=request_id,
            tools_dir=tools_dir,
        )
        if single_claim_error is not None:
            sys.stderr.write(single_claim_error + "\n")
            return 1
        lease_token = os.environ.get(LEASE_TOKEN_ENV_VAR)
        if not lease_token:
            sys.stderr.write(
                f"single_claim_mode missing {LEASE_TOKEN_ENV_VAR} env var\n"
            )
            return 1
        claim_id = claim["claim_id"]
        agent_id = str(claim["agent_id"])
    else:
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

    # Step 2 — read the fused request envelope from the claim response.
    # Plan 026R §B.3 — ``agent claim`` now returns the request envelope
    # (expected_output_path / role / must_satisfy / allowed_scope /
    # evidence_refs) PLUS the §B.5 ledger-hash anchors
    # (claim_ledger_hash / request_ledger_hash) inside the same
    # exclusive-lock window that performed the claim CAS. The pre-§B.3
    # second-fetch via ``agent-invocations list --request-id`` opened a
    # race window: between claim-success and the list-fetch, a release
    # or reaper sweep could mutate the request row and the executor
    # would operate on a stale envelope. Reading from the fused
    # response closes the race AND eliminates one subprocess hop per
    # cycle (lower latency).
    request_envelope = {
        "request_id": request_id,
        "expected_output_path": claim.get("expected_output_path"),
        "role": claim.get("role"),
        "must_satisfy": claim.get("must_satisfy") or [],
        "allowed_scope": claim.get("allowed_scope") or [],
        "evidence_refs": claim.get("evidence_refs") or [],
        # Plan ARIA-V7 §2g v2 — additional fields surfaced into the
        # envelope dict so the prompt template can render them for
        # the agent. Pre-V7 the dict held only the 4 fields above;
        # the agent contract requires target_agent / convergence_id
        # / suggested_prompt to bind the request to the convergence
        # loop and to read the operator's intent.
        "target_agent": claim.get("target_agent") or subagent_type,
        "convergence_id": claim.get("convergence_id"),
        "suggested_prompt": claim.get("suggested_prompt"),
        "forbidden_scope": claim.get("forbidden_scope") or [],
        "impact_graph_refs": claim.get("impact_graph_refs") or [],
        "validation_commands": claim.get("validation_commands") or [],
        # Plan 026R §B.5 anchors — verified by ci_executor at envelope
        # deserialise time when the planner-hook single-claim env-var
        # contract delivers the metadata.
        "claim_ledger_hash": claim.get("claim_ledger_hash"),
        "request_ledger_hash": claim.get("request_ledger_hash"),
    }
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

    # Plan ARIA-V7 §2g v2 — write the request's suggested_prompt to
    # the canonical prompts/ path BEFORE invoking the CLI. Pre-V7
    # this was assumed pre-staged by the workflow; V7's parallel-
    # consumer mode mints requests directly via
    # create_agent_invocation_request which writes ONLY to
    # requests.jsonl (no prompt file). Without this write, the
    # modernized invoke_claude_code reads an empty prompt and the
    # claude CLI subprocess errors with "missing prompt".
    prompt_file = tools_dir / "agent-invocations" / "prompts" / f"{request_id}.md"
    prompt_file.parent.mkdir(parents=True, exist_ok=True)
    _suggested_prompt = str(request_envelope.get("suggested_prompt") or "")
    _must_satisfy_block = ""
    _ms_list = request_envelope.get("must_satisfy") or []
    if isinstance(_ms_list, list) and _ms_list:
        _must_satisfy_lines = ["", "## Must satisfy", ""]
        for _item in _ms_list:
            if isinstance(_item, dict):
                _mid = _item.get("id", "?")
                _mdesc = _item.get("description", "")
                _must_satisfy_lines.append(f"- **{_mid}**: {_mdesc}")
        _must_satisfy_block = "\n".join(_must_satisfy_lines) + "\n"
    # Plan ARIA-V7 §2g v2 V7.9 — render ALL V5/V6/V7 envelope fields
    # so the agent reads the complete contract surface, NOT just a
    # role-prompt skeleton. Previously the prompt only carried role +
    # target_agent + suggested_prompt; agents (e.g. aria-primary-
    # planner) correctly rejected with `envelope_underspecified`
    # because evidence_refs / allowed_scope / impact_graph_refs /
    # expected_output_path / validation_commands were absent. The
    # template now mirrors the request_envelope dict's full schema so
    # agents have everything their contract requires to produce a
    # real response (not refusal).
    def _bullet_list(items, key_func=None):
        if not items:
            return "  _(none)_"
        if key_func is None:
            return "\n".join(f"  - `{item}`" for item in items)
        return "\n".join(f"  - {key_func(item)}" for item in items)

    _evidence_refs = request_envelope.get("evidence_refs") or []
    _allowed_scope = request_envelope.get("allowed_scope") or []
    _forbidden_scope = request_envelope.get("forbidden_scope") or []
    _impact_refs = request_envelope.get("impact_graph_refs") or []
    _validation_cmds = request_envelope.get("validation_commands") or []
    _expected_path = request_envelope.get("expected_output_path", "")

    _prompt_payload = (
        f"# ARIA agent request {request_id}\n\n"
        f"**Role**: {request_envelope.get('role', 'unknown')}\n"
        f"**Target agent**: {request_envelope.get('target_agent', 'unknown')}\n"
        f"**Convergence ID**: {request_envelope.get('convergence_id', 'n/a')}\n"
        f"**Expected output path**: `{_expected_path}`\n\n"
        f"## Suggested prompt\n\n{_suggested_prompt}\n\n"
        f"## Evidence refs (file:line entries; the ONLY admissible evidence)\n\n"
        f"{_bullet_list(_evidence_refs)}\n\n"
        f"## Allowed scope\n\n{_bullet_list(_allowed_scope)}\n\n"
        f"## Forbidden scope\n\n{_bullet_list(_forbidden_scope)}\n\n"
        f"## Impact graph refs\n\n{_bullet_list(_impact_refs)}\n\n"
        f"## Validation commands\n\n"
        f"{_bullet_list(_validation_cmds, lambda c: '`' + c.get('cmd', str(c)) + '`' if isinstance(c, dict) else '`' + str(c) + '`')}\n"
        f"{_must_satisfy_block}\n"
        f"## Response\n\n"
        f"Write your `aria/agent-response/v1` JSON envelope per your "
        f"agent contract. The envelope MUST cite ONLY evidence_refs "
        f"present in this prompt + must stay within allowed_scope. "
        f"Output the JSON envelope as the body of your response.\n"
    )
    prompt_file.write_text(_prompt_payload, encoding="utf-8")

    timeout = _max_timeout_seconds()
    try:
        # Plan 024 v3 §B-8 — pass real lease identity + role from
        # request row into the mock envelope writer. claim_id +
        # agent_id come from the kernel CLI's claim output (line 209-
        # 211); role + must_satisfy come from the request_envelope
        # we already loaded for cost-cap evaluation.
        cli_exit = invoke_claude_code(
            request_id=request_id,
            subagent_type=subagent_type,
            prompt_file=prompt_file,
            output_path=expected_output_path,
            timeout_seconds=timeout,
            claim_id=claim_id,
            agent_id=agent_id,
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
        # Plan ARIA-V7 §2g v2 — release the lease on CLI failure so
        # the claim doesn't sit in CLAIMED state until expiry; the
        # convergence_drainer's poll sees the requeue and either
        # routes to primary_silent verdict OR a later consumer
        # attempts a fresh claim. Pre-V7 leak: CLI exit != 0 kept
        # the claim active, blocking re-claims for the lease window.
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=f"claude_cli_exit_{cli_exit}",
        )
        return 1

    # Step 4 — submit through the kernel CLI; lease-token via env var.
    submit_proc = subprocess.run(
        [
            "python3", "-m", "aria_kernel", "agent", "submit-result",
            "--claim-id", claim_id,
            "--agent-id", agent_id,
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
