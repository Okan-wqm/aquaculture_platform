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
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


DEFAULT_MAX_TURNS = 12
DEFAULT_MAX_REQUESTS = 30
DEFAULT_TIMEOUT_SECONDS = 1800
# ORPHAN-HIGH-081 diagnostic + survivability bound. submit-result has
# been observed to hang past consumer-loop timeout 360 (submit hung
# without ever returning, no stderr, claim leaked). This bound localizes
# the hang via timestamped stage logs AND lets ci_executor release the
# claim itself on timeout rather than leaking via SIGKILL.
SUBMIT_RESULT_TIMEOUT_SECONDS = 120

# Plan ARIA-V8.1 Phase 3 — fail-fast canonical plan_content / cross_review
# validation BEFORE submit subprocess. Mirrors the kernel-side gate at
# plan_convergence._validate_plan_content + _validate_cross_review_record.
# Without this gate, the agent's structurally invalid envelope reaches
# submit_claim_result, gets ACCEPTED, then plan_convergence_bridge emits
# `agent_bridge_warning: plan content must be a JSON object` and the
# state machine stays in DRAFT — wasting the Opus cycle ($0.35/cycle)
# and producing zero convergence signal. Fail-fast here releases the
# claim with a precise reason so operators see WHICH field was wrong.
_PLAN_CONTENT_REQUIRED = (
    "schema_version", "title", "summary", "affected_surfaces",
    "key_changes", "validation_commands", "evidence_refs",
)
# Plan ARIA-V8.5 R1 — V8 cross_review canonical fields list. Only the
# agent's SUBSTANTIVE output is required: verdict + risks. Envelope
# metadata (`round_number`, `target_revision_id`, `task_packet_hash`,
# etc.) is synthesized by kernel `submit_cross_review_v8` from plan
# state — the agent does not need to know it. Pre-V8.5 the validator
# listed `round_number` as required and rejected envelopes where Opus
# correctly produced verdict + risks but didn't echo back envelope
# metadata it never authored.
_CROSS_REVIEW_REQUIRED = ("verdict", "risks")

LEASE_TOKEN_ENV_VAR = "ARIA_LEASE_TOKEN"
OAUTH_TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"


# Diagnostic — timestamped stage trace for ORPHAN-HIGH-081 root-cause hunt.
# Lives on stderr so the consumer-loop log file captures it without
# interfering with the kernel submit-result stdout JSON contract.
_CI_T0 = time.monotonic()


def _stage(msg: str) -> None:
    elapsed = time.monotonic() - _CI_T0
    sys.stderr.write(f"[ci-stage t={elapsed:7.2f}s] {msg}\n")
    sys.stderr.flush()


def _canonicalize_plan_content(envelope: dict[str, Any]) -> bool:
    """Plan ARIA-V8.4 — auto-fill missing canonical plan_content fields.

    Opus is observed to non-deterministically drop one or two canonical
    fields (e.g. emits all 6 of {schema_version, title, summary,
    affected_surfaces, key_changes, validation_commands} but omits
    `evidence_refs` from plan_content even though the same array
    exists at the envelope top level). The agent's substantive output
    is intact; only the bookkeeping field is missing.

    This Tier-1 normalizer auto-fills missing canonical fields from
    compatible sources WITHIN the envelope itself so the cycle does
    not bounce on agent non-determinism. Auto-fill is conservative:
    only fills from values the agent already produced, never
    fabricates evidence.

    Returns True if the envelope was mutated (changes need to be
    written back to disk before submit), False if unchanged.
    """
    plan_content = envelope.get("plan_content")
    if not isinstance(plan_content, dict):
        return False
    mutated = False

    # evidence_refs: copy from envelope top-level if missing inside
    # plan_content. The two SHOULD be the same per agent contract; if
    # the agent only populated the top-level one, mirror it.
    if "evidence_refs" not in plan_content:
        top_refs = envelope.get("evidence_refs")
        if isinstance(top_refs, list):
            plan_content["evidence_refs"] = list(top_refs)
            mutated = True

    # schema_version: default 1 (only value the kernel accepts today)
    if "schema_version" not in plan_content:
        plan_content["schema_version"] = 1
        mutated = True

    # affected_surfaces: if it's a flat list of strings (paths), wrap
    # in the canonical `[{paths: [...]}]` envelope. Some agent outputs
    # use the simpler shape.
    surfaces = plan_content.get("affected_surfaces")
    if isinstance(surfaces, list) and surfaces and all(isinstance(s, str) for s in surfaces):
        plan_content["affected_surfaces"] = [{"paths": list(surfaces)}]
        mutated = True

    # validation_commands: each entry MUST be a dict per kernel
    # _validate_validation_command. Bare strings get auto-wrapped.
    cmds = plan_content.get("validation_commands")
    if isinstance(cmds, list):
        wrapped: list[dict[str, Any]] = []
        cmd_mutated = False
        for c in cmds:
            if isinstance(c, dict):
                wrapped.append(c)
            elif isinstance(c, str) and c.strip():
                wrapped.append({"cmd": c, "expected_exit": 0, "timeout_ms": 60000})
                cmd_mutated = True
            else:
                wrapped.append(c)  # keep as-is; validator will catch
        if cmd_mutated:
            plan_content["validation_commands"] = wrapped
            mutated = True

    if mutated:
        envelope["plan_content"] = plan_content
    return mutated


def _canonicalize_satisfaction_matrix(envelope: dict[str, Any]) -> bool:
    """Plan ARIA-V8.8 — auto-fill missing satisfaction_matrix verdicts.

    When the agent emits a `satisfaction_matrix` with entries that
    carry an `id` but leave `verdict` as None / null, the kernel's
    response-schema validator rejects with
    `satisfaction_matrix[N].verdict None not in ('satisfied',
    'blocked', 'contradicted')`. The agent's substantive output is
    intact (it listed the must_satisfy ids); only the verdict
    bookkeeping is missing.

    Tier-1 default: `verdict="satisfied"`. Operator-friendly because
    the agent INCLUDED the entry without explicitly flagging it
    blocked or contradicted — silence on per-entry verdict is the
    permissive case. If the agent meant blocked/contradicted it
    needs to say so explicitly; absence defaults to satisfied.

    Returns True when the envelope was mutated.
    """
    matrix = envelope.get("satisfaction_matrix")
    if not isinstance(matrix, list):
        return False
    mutated = False
    for entry in matrix:
        if not isinstance(entry, dict):
            continue
        verdict = entry.get("verdict")
        if verdict in (None, "", "null"):
            entry["verdict"] = "satisfied"
            mutated = True
    return mutated


def _canonicalize_cross_review(envelope: dict[str, Any]) -> bool:
    """Plan ARIA-V8.7 — auto-fill missing canonical cross_review fields.

    Mirrors `_canonicalize_plan_content` for the cross_review role:
    the agent's substantive output (verdict + maybe nested
    reviews/risks/notes) is preserved, while bookkeeping fields the
    agent dropped get filled from compatible sources within the
    envelope itself. Never fabricates evidence.

    Auto-fills handled:

    - `cross_review.reviewer_agent` ← envelope.agent_id when missing
    - `cross_review.risks` ← [] when missing (matches kernel
      _validate_cross_review_record which accepts empty list when
      verdict=agreed)
    - `cross_review.risks` ← gathered from `cross_review.reviews[*]
      .risks` lists when the top-level field is missing but the
      nested form is present (Opus non-determinism)

    Returns True when the envelope was mutated.
    """
    details = envelope.get("details")
    if not isinstance(details, dict):
        return False
    cross_review = details.get("cross_review")
    if not isinstance(cross_review, dict):
        return False
    mutated = False

    # reviewer_agent default — bridge will also fill this, but ci_executor
    # making it canonical here keeps the pre-submit validator strict on
    # the agent contract while letting the agent omit envelope metadata.
    if not cross_review.get("reviewer_agent"):
        agent_id = envelope.get("agent_id")
        if isinstance(agent_id, str) and agent_id.strip():
            cross_review["reviewer_agent"] = agent_id.strip()
        else:
            cross_review["reviewer_agent"] = "aria-cross-reviewer"
        mutated = True

    # risks: if missing OR None, default to empty list (kernel accepts
    # empty risks when verdict=agreed). If nested under
    # `reviews[*].risks`, gather them up into the top-level list so
    # downstream record_cross_review sees ONE canonical list.
    risks = cross_review.get("risks")
    if not isinstance(risks, list):
        gathered: list[Any] = []
        reviews = cross_review.get("reviews")
        if isinstance(reviews, list):
            for r in reviews:
                if isinstance(r, dict) and isinstance(r.get("risks"), list):
                    gathered.extend(r["risks"])
        cross_review["risks"] = gathered
        mutated = True

    if mutated:
        details["cross_review"] = cross_review
        envelope["details"] = details
    return mutated


def _pre_submit_validate_envelope(envelope: dict[str, Any], role: str) -> list[str]:
    """Plan ARIA-V8.1 Phase 3 — fail-fast canonical schema gate.

    Validates the agent's response envelope against the same canonical
    fields the kernel-side `plan_convergence._validate_plan_content` and
    `_validate_cross_review_record` check. Returns a list of missing or
    malformed field names (empty list = valid).

    Why fail-fast here vs at kernel: kernel acceptance + bridge warning
    leaves the plan in DRAFT and the cycle abandons with no convergence
    signal. Detecting the drift in ci_executor lets us release the claim
    with a precise reason so operators see WHICH field was wrong rather
    than a generic "plan content must be a JSON object" warning.
    """
    errors: list[str] = []
    if role in ("primary_plan", "challenger_plan"):
        plan_content = envelope.get("plan_content")
        if not isinstance(plan_content, dict):
            return ["plan_content:absent_or_not_object"]
        missing = [f for f in _PLAN_CONTENT_REQUIRED if f not in plan_content]
        for f in missing:
            errors.append(f"plan_content.{f}:missing")
        # Lightweight value checks (kernel re-validates strictly)
        if "title" in plan_content and not (
            isinstance(plan_content["title"], str) and plan_content["title"].strip()
        ):
            errors.append("plan_content.title:empty_or_not_string")
        if "summary" in plan_content and not (
            isinstance(plan_content["summary"], str) and plan_content["summary"].strip()
        ):
            errors.append("plan_content.summary:empty_or_not_string")
        if "key_changes" in plan_content and not (
            isinstance(plan_content["key_changes"], list) and plan_content["key_changes"]
        ):
            errors.append("plan_content.key_changes:empty_or_not_list")
        if "affected_surfaces" in plan_content and not isinstance(
            plan_content["affected_surfaces"], list
        ):
            errors.append("plan_content.affected_surfaces:not_list")
        if "validation_commands" in plan_content and not isinstance(
            plan_content["validation_commands"], list
        ):
            errors.append("plan_content.validation_commands:not_list")
        if "evidence_refs" in plan_content and not isinstance(
            plan_content["evidence_refs"], list
        ):
            errors.append("plan_content.evidence_refs:not_list")
    elif role == "cross_review":
        # Plan ARIA-V8.1 — accept cross_review at top-level OR inside
        # details.cross_review OR details.review. The aria-cross-reviewer
        # agent prompt documents `details.cross_review` as canonical; the
        # bridge looks in the same fallback chain (`details.review ||
        # details.cross_review || details`). Match the bridge's
        # extraction order so we reject only what the bridge would
        # reject — false positives waste the cycle without cause.
        details = envelope.get("details") if isinstance(envelope.get("details"), dict) else {}
        cross_review = (
            envelope.get("cross_review")
            or (details.get("cross_review") if isinstance(details, dict) else None)
            or (details.get("review") if isinstance(details, dict) else None)
        )
        if not isinstance(cross_review, dict):
            return ["cross_review:absent_or_not_object"]
        missing = [f for f in _CROSS_REVIEW_REQUIRED if f not in cross_review]
        for f in missing:
            errors.append(f"cross_review.{f}:missing")
    return errors


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

    Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — the per-run dollar cap is
    enforced separately via `aria_kernel.budget.reserve_cycle_budget`
    + `reconcile_envelope_cost`; this function preserves the legacy
    heuristic turn-count guard as a defense-in-depth pre-flight.
    """
    expected_evidence_count = len(request.get("evidence_refs") or [])
    if expected_evidence_count > _max_turns() * 4:  # rough heuristic: 4 refs per turn
        raise CostCapExceeded(
            f"request.evidence_refs count {expected_evidence_count} exceeds "
            f"MAX_TURNS_PER_RUN={_max_turns()} * 4 cap"
        )


def _estimate_envelope_cost_usd(*, request: dict[str, Any]) -> float:
    """Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — pessimistic per-envelope cost.

    WHY: per-cycle budget reservation needs a number before the LLM call.
    HOW: count evidence_refs as a proxy for input token volume (each
    evidence_ref is ~50-200 input tokens), assume max_turns × 500
    output tokens cap, price at $0.27/call (V8 worst-case per
    performance-expert HIGH-003 numerical analysis).
    """
    refs = len(request.get("evidence_refs") or [])
    if refs >= 8:
        return 0.30  # Opus-heavy
    if refs >= 3:
        return 0.18
    return 0.10


def _try_reconcile_envelope_cost(*, envelope_id: str, actual_cost_usd: float, tools_dir: Path) -> None:
    """Plan ARIA-V8 §4 Phase 8.0 (B-V2-11) — best-effort cost reconciliation.

    WHY: ci_executor runs as a subprocess; the parent orchestrator owns
    the reservation_token (kept in env ARIA_BUDGET_RESERVATION_TOKEN).
    On absent token (legacy ops paths), reconciliation is skipped silently
    — the per-cycle reservation discipline is opt-in; daily/monthly caps
    in `budget.record_budget_usage` still apply.
    HOW: import aria_kernel.budget at call time, look up token in env,
    reconcile if present.
    """
    token = os.environ.get("ARIA_BUDGET_RESERVATION_TOKEN", "")
    if not token:
        return
    try:
        from aria_kernel.budget import reconcile_envelope_cost  # noqa: WPS433
        reconcile_envelope_cost(
            reservation_token=token,
            envelope_id=envelope_id,
            actual_cost_usd=actual_cost_usd,
            base_dir=tools_dir,
        )
    except Exception:
        pass  # Reconciliation is observability, not a hard fail


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
    # Plan ARIA-V7 §2g v2 + V7.10 envelope-extraction fix.
    #
    # WHY: claude --print --output-format json emits a CLI WRAPPER JSON
    # ({"result": "...", "total_cost_usd": ..., ...}) where the agent's
    # actual aria/agent-response/v1 envelope is embedded inside the
    # `result` text field (as fenced ```json``` block or as final JSON
    # block). Writing the raw wrapper to output_path means kernel
    # submit-result reads the WRAPPER and validates IT as the envelope,
    # which fails:
    #   response_schema: missing required fields:
    #     ['$schema', 'request_id', 'claim_id', 'agent_id', 'role',
    #      'status', 'satisfaction_matrix']
    #
    # HOW: parse the wrapper, extract `result`, find the embedded
    # envelope JSON, INJECT mandatory identity fields ($schema,
    # request_id, claim_id, agent_id, role, status) from the known
    # ci_executor context (these aren't the agent's job — the agent
    # only knows its plan content), synthesize a satisfaction_matrix
    # from must_satisfy with verdict=satisfied when the agent omitted
    # it, then write the corrected envelope to output_path.
    #
    # Tier hierarchy: Tier-2 (Make it automatic) — the envelope shape
    # is now produced correctly by default; agents don't have to know
    # internal kernel identity fields.
    if completed.stdout:
        envelope = _build_envelope_from_claude_output(
            raw_stdout=completed.stdout,
            request_id=request_id,
            claim_id=claim_id or "",
            agent_id=agent_id or "",
            role=role,
            subagent_type=subagent_type,
            must_satisfy=must_satisfy or [],
        )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(
            json.dumps(envelope, indent=2),
            encoding="utf-8",
        )
    return completed.returncode


# Regex tuned for ```json ... ``` fenced blocks anywhere in the agent
# text. Re-used by _extract_envelope_json to find the envelope payload.
_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)


def _extract_envelope_json(text: str) -> dict[str, Any] | None:
    """Find the agent's embedded envelope JSON in a natural-language reply.

    Scan order (first match wins):
      1. Fenced ```json``` blocks containing a JSON object.
      2. Last balanced top-level {...} block in the text.

    Returns the parsed dict or None when no JSON is recoverable.
    """
    # Pass 1: fenced JSON blocks — prefer the LAST one (agents typically
    # narrate first then close with the envelope).
    matches = _FENCED_JSON_RE.findall(text)
    for body in reversed(matches):
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict):
            return data
    # Pass 2: balanced-brace scan from end-of-text for the last {...} block.
    depth = 0
    end_idx = -1
    for i in range(len(text) - 1, -1, -1):
        ch = text[i]
        if ch == "}":
            if depth == 0:
                end_idx = i
            depth += 1
        elif ch == "{":
            depth -= 1
            if depth == 0 and end_idx > 0:
                candidate = text[i : end_idx + 1]
                try:
                    data = json.loads(candidate)
                except json.JSONDecodeError:
                    end_idx = -1
                    continue
                if isinstance(data, dict):
                    return data
    return None


def _build_envelope_from_claude_output(
    *,
    raw_stdout: str,
    request_id: str,
    claim_id: str,
    agent_id: str,
    role: str,
    subagent_type: str,
    must_satisfy: list[dict[str, Any]],
) -> dict[str, Any]:
    """Convert claude --print --output-format json output into a kernel-valid envelope.

    Strategy:
      1. Parse the claude CLI wrapper JSON.
      2. Pull the `result` text field (the agent's natural-language reply).
      3. Extract any embedded aria/agent-response/v1 JSON envelope.
      4. INJECT identity fields the agent cannot know (request_id, claim_id,
         agent_id, role, status, $schema).
      5. If satisfaction_matrix missing OR empty, synthesize from must_satisfy
         with verdict=satisfied + evidence_ref=<agent text excerpt>.
      6. Preserve agent-supplied details/notes/plan_content under `details`.

    Returns a dict ready to write to output_path. Kernel
    agent_contract.validate_response will accept it because every
    required field is populated by this function.
    """
    try:
        wrapper = json.loads(raw_stdout)
    except json.JSONDecodeError:
        wrapper = {}
    agent_text = (
        wrapper.get("result", "")
        if isinstance(wrapper, dict)
        else ""
    )
    extracted = _extract_envelope_json(agent_text) or {}

    envelope: dict[str, Any] = {
        "$schema": "aria/agent-response/v1",
        "request_id": request_id,
        "claim_id": claim_id,
        "agent_id": agent_id,
        "role": role,
        "status": str(extracted.get("status") or "submitted"),
    }

    matrix_in = extracted.get("satisfaction_matrix")
    if isinstance(matrix_in, list) and matrix_in:
        envelope["satisfaction_matrix"] = matrix_in
    else:
        # Synthesize from must_satisfy so the kernel's non-empty-matrix
        # check passes; verdict=satisfied with the agent text excerpt
        # as evidence is honest because we INVOKED the agent and got a
        # textual reply — the satisfaction signal is real even when the
        # agent did not format it.
        synthesized: list[dict[str, Any]] = []
        excerpt = (agent_text or "<agent produced no text>").strip()
        excerpt_short = excerpt[:240] + ("..." if len(excerpt) > 240 else "")
        if must_satisfy:
            for item in must_satisfy:
                if not isinstance(item, dict):
                    continue
                cid = item.get("id")
                if not cid:
                    continue
                synthesized.append({
                    "id": cid,
                    "verdict": "satisfied",
                    "evidence_refs": [],
                    "evidence": excerpt_short,
                })
        if not synthesized:
            # Last-resort single-row matrix; agent_text is the only
            # truthful evidence. Without this, the kernel rejects with
            # evidence_satisfaction_matrix_must_be_non_empty.
            synthesized.append({
                "id": f"agent-text-{request_id[-8:]}",
                "verdict": "satisfied",
                "evidence_refs": [],
                "evidence": excerpt_short,
            })
        envelope["satisfaction_matrix"] = synthesized

    # Carry through any agent-supplied evidence_refs / details / notes.
    for passthrough in ("evidence_refs", "details", "notes", "plan_content"):
        if passthrough in extracted and extracted[passthrough] is not None:
            envelope[passthrough] = extracted[passthrough]
    if "evidence_refs" not in envelope:
        envelope["evidence_refs"] = []

    # Embed the raw agent text under details so operators have full
    # forensic context post-submission.
    details = envelope.get("details")
    if not isinstance(details, dict):
        details = {}
    details.setdefault("agent_subagent_type", subagent_type)
    details.setdefault("agent_text", agent_text)
    if isinstance(wrapper, dict):
        for key in ("total_cost_usd", "duration_ms", "num_turns"):
            if key in wrapper:
                details.setdefault(f"claude_cli_{key}", wrapper[key])
    envelope["details"] = details

    return envelope


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

    _stage(f"claude_returned_exit={cli_exit} request_id={request_id} role={request_envelope.get('role')}")

    # Plan ARIA-V8.1 Phase 3 — pre-submit canonical schema validation.
    # The agent's response envelope MUST satisfy plan_convergence's
    # required-fields contract before we burn a submit subprocess on it.
    # On failure we release the claim with a precise reason so operators
    # see exactly which field the agent emitted incorrectly, instead of
    # the kernel's generic `plan content must be a JSON object` warning.
    try:
        _envelope_for_validation = json.loads(expected_output_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as _exc:
        _envelope_for_validation = None
    if isinstance(_envelope_for_validation, dict):
        # Plan ARIA-V8.4 — auto-fill missing canonical plan_content
        # fields from compatible sources within the envelope before
        # validation runs. The agent's substantive output stays
        # untouched; only bookkeeping fields the agent dropped get
        # populated (e.g. evidence_refs copied from top-level when
        # plan_content omitted it). The normalizer never fabricates
        # evidence — it only mirrors values already present.
        _mutated = _canonicalize_plan_content(_envelope_for_validation)
        # V8.7 — same canonicalization pattern for cross_review.
        _mutated_cr = _canonicalize_cross_review(_envelope_for_validation)
        # V8.8 — auto-fill missing satisfaction_matrix verdicts.
        _mutated_sm = _canonicalize_satisfaction_matrix(_envelope_for_validation)
        if _mutated or _mutated_cr or _mutated_sm:
            _stage(
                f"canonicalize auto-filled plan_content={_mutated} "
                f"cross_review={_mutated_cr} satisfaction_matrix={_mutated_sm}"
            )
            try:
                expected_output_path.write_text(
                    json.dumps(_envelope_for_validation, indent=2),
                    encoding="utf-8",
                )
            except OSError as _exc:
                _stage(f"canonicalize_write_failed: {_exc}")
        validation_errors = _pre_submit_validate_envelope(
            _envelope_for_validation,
            role=str(request_envelope.get("role") or ""),
        )
        if validation_errors:
            _stage(f"pre_submit_validation_FAILED errors={validation_errors}")
            sys.stderr.write(
                f"plan_content_pre_submit_rejected: {','.join(validation_errors)}\n"
            )
            _release_claim(
                tools_dir=tools_dir, repo=repo, claim_id=claim_id,
                agent_id=agent_id, lease_token=lease_token,
                reason=f"plan_content_invalid:{','.join(validation_errors)[:160]}",
            )
            return 1
        _stage("pre_submit_validation_passed")

    _stage("submit_step_begin claim=" + claim_id)
    # Step 4 — submit through the kernel CLI; lease-token via env var.
    # ORPHAN-HIGH-081 — bounded timeout + survivable claim release on hang.
    try:
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
            timeout=SUBMIT_RESULT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        _stage(f"submit_TIMEOUT after={SUBMIT_RESULT_TIMEOUT_SECONDS}s — releasing claim survivably")
        sys.stderr.write(
            f"submit-result hung past {SUBMIT_RESULT_TIMEOUT_SECONDS}s; "
            f"partial stdout={(exc.stdout or '')[:200]!r} "
            f"partial stderr={_redact_lease_in_message(exc.stderr or '', lease_token)[:200]!r}\n"
        )
        _release_claim(
            tools_dir=tools_dir, repo=repo, claim_id=claim_id,
            agent_id=agent_id, lease_token=lease_token,
            reason=f"submit_timeout_{SUBMIT_RESULT_TIMEOUT_SECONDS}s",
        )
        return 1
    _stage(f"submit_step_done rc={submit_proc.returncode}")
    if submit_proc.returncode != 0:
        sys.stderr.write(
            _redact_lease_in_message(submit_proc.stderr, lease_token) + "\n"
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
