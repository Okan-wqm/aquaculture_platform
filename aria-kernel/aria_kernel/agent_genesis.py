from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .capability_gap import latest_capability_gaps
from .capability_resolver import resolve_capability
from .draft_intent import (
    BANNED_PHRASES_DEFAULT,
    AcceptanceTest,
    AgentDraftIntent,
)
from .draft_pii_filter import mask_pii_in_intent
from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    load_declared_jsonl,
    load_jsonl as _load_jsonl,
    rewrite_declared_json,
)
from .runtime_profile import enforce_profile_for_write
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


# Plan ARIA-V3 §A3 — banned-phrase list relocated to ``draft_intent``
# as the single SSoT. The local concatenation form below is preserved
# (kernel-self-scan: ``_validate_draft`` rejects an intent whose
# purpose/evidence_contract free-text contains the banned phrases).
# CLAUDE.md banned-phrase audit re-imports the SSoT.
BANNED_PHRASES = BANNED_PHRASES_DEFAULT

REQUIRED_DRAFT_FIELDS = ("name", "purpose", "scope_globs", "forbidden_globs", "evidence_contract", "output_schema", "validation_fixtures")


_DECLARED_SURFACE_BY_JSONL_SUFFIX: dict[str, str] = {
    "agent-genesis/requests.jsonl": "agent_genesis_requests",
    "agent-genesis/drafts.jsonl": "agent_genesis_drafts",
    "agent-genesis/pr-lanes.jsonl": "agent_genesis_pr_lanes",
    "agent-genesis/materializations.jsonl": "agent_genesis_materializations",
    "agent-genesis/extension-decisions.jsonl": "agent_genesis_extension_decisions",
    "genesis-sandbox/runs.jsonl": "genesis_sandbox_runs",
    "skill-genesis/requests.jsonl": "skill_genesis_requests",
    "dispatch/requests.jsonl": "dispatch_requests",
}


def _declared_surface_name(path: str | Path) -> str | None:
    concrete = Path(path)
    if len(concrete.parts) >= 2:
        suffix = "/".join(concrete.parts[-2:])
        if suffix in _DECLARED_SURFACE_BY_JSONL_SUFFIX:
            return _DECLARED_SURFACE_BY_JSONL_SUFFIX[suffix]
    return _DECLARED_SURFACE_BY_JSONL_SUFFIX.get(concrete.name)


def append_jsonl(path: Path, record: dict[str, Any]) -> dict[str, Any]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return append_declared_jsonl(path, record, expected_surface=surface)
    return _append_jsonl(path, record)


def load_jsonl(path: Path) -> list[dict[str, Any]]:
    surface = _declared_surface_name(path)
    if surface is not None:
        return load_declared_jsonl(path, expected_surface=surface)
    return _load_jsonl(path)


def draft_agent_from_gap(
    *,
    gap_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    enforce_profile_for_write("agent_genesis", base_dir=base_dir)
    gap = _find_gap(gap_id, base_dir)
    name = _agent_name(gap)
    capability_gap_key = str(gap.get("capability_gap_key") or gap_id)
    capability_resolution = resolve_capability(
        capability_key=capability_gap_key,
        requested_kind="agent",
        title=str(gap.get("title") or name),
        existing_capabilities=_existing_capabilities(gap.get("related_existing_agents", [])),
        base_dir=base_dir,
    )
    if capability_resolution.get("decision") == "reuse":
        raise GovernanceError("capability_resolution_reuse_blocks_agent_genesis")
    draft = {
        "name": name,
        "purpose": gap["title"],
        "scope_globs": _scope_from_evidence(gap.get("evidence_refs", [])),
        "forbidden_globs": ["secrets/**", ".env*", "node_modules/**", "dist/**", "aria-tools/**"],
        "evidence_contract": "Every finding must cite repo paths from scope_globs and include severity.",
        "output_schema": {"required": ["findings", "observations", "evidence_refs"]},
        "validation_fixtures": [
            {"name": "true-positive", "expected": "finding"},
            {"name": "false-positive-guard", "expected": "no_finding"},
            {"name": "scope-violation-guard", "expected": "blocked"},
        ],
        "related_existing_agents": gap.get("related_existing_agents", []),
    }
    _validate_draft(draft)
    # Plan ARIA-V3 §A3 — kernel emits the INTENT (grammar), not the
    # body. The body is synthesised by worker_executor.py drafter
    # mode and written into ``draft.body`` by the dispatch hook
    # (Phase A3 invariant I-V3-12c locks the no-markdown discipline).
    intent = _render_agent_intent(draft)
    root = ensure_tools_dir(base_dir)
    draft_path = root / "agent-genesis" / "drafts" / f"{name}.intent.json"
    rewrite_declared_json(
        draft_path,
        intent.to_dict(),
        expected_surface="agent_genesis_draft_intents",
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "gap_id": gap_id,
        "capability_gap_key": capability_gap_key,
        "capability_resolution_ref": capability_resolution.get("ledger_hash"),
        "draft_id": f"draft-{name}",
        "status": "draft_shadow",
        "draft": draft,
        # Plan ARIA-V3 §A3 — ``intent`` is the kernel-authored grammar
        # (replaces the pre-V3 ``content`` string). ``body`` is
        # populated AFTER the drafter run + grammar validation
        # passes; materialize gates on body presence.
        "intent": intent.to_dict(),
        "body": None,
        "draft_path": draft_path.as_posix(),
        "target_path": intent.target_path,
        "blocked_by": ["awaiting_drafter_body_synthesis"],
    }
    return append_jsonl(root / "agent-genesis" / "drafts.jsonl", row)


def _fixture_result_has_real_execution_provenance(result: dict[str, Any]) -> bool:
    """Plan 022 §H-4 — shape check (preserved as a fast pre-filter).

    Returns True when the result carries provenance.executed_at +
    provenance.execution_run_id non-empty strings. Plan 023 v3 §A-1
    adds a separate ledger-binding check at the call site (which runs
    AFTER this shape filter). Both must pass for genesis to accept
    the result.
    """
    prov = result.get("provenance")
    if not isinstance(prov, dict):
        return False
    executed_at = prov.get("executed_at")
    run_id = prov.get("execution_run_id")
    return (
        isinstance(executed_at, str) and bool(executed_at.strip())
        and isinstance(run_id, str) and bool(run_id.strip())
    )


def _fixture_result_provenance_matches_ledger(
    result: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
) -> tuple[bool, str | None]:
    """Plan 023 v3 §A-1 — verify a fixture_result's claimed provenance
    against the actual fixture-runs.jsonl ledger.

    Pre-Plan-023 _fixture_result_has_real_execution_provenance only
    checked SHAPE; a caller could fabricate provenance values without
    the fixture runner ever firing. Post-fix this function joins the
    result's execution_run_id against the ledger and validates SUITE-
    LEVEL identity:
      * Row exists.
      * Row's tool_id matches.
      * Row's fixture_set_hash matches.
      * Row's cycle_id matches.
      * Row's case_count > 0 (defense-in-depth with §A-7).
      * Row's actual_status matches the claimed actual_status.
      * Row's evidence_hash matches the claimed evidence_hash.

    Returns (True, None) on success, (False, reason) on mismatch.
    """
    from .fixture_runner import fixture_runs_path
    from .ledger import load_jsonl as load_chained_jsonl

    prov = result.get("provenance") or {}
    run_id = prov.get("execution_run_id")
    if not run_id:
        return False, "missing execution_run_id"
    rows = load_chained_jsonl(fixture_runs_path(base_dir))
    matching = [
        r for r in rows
        if r.get("execution_run_id") == run_id
        and r.get("row_type") in ("fixture_run_suite", None)
    ]
    if not matching:
        return False, f"no ledger row with execution_run_id={run_id!r}"
    row = matching[0]
    # Cross-check identity fields. Each mismatch is operator-readable
    # so triage knows which axis drifted.
    for field in ("tool_id", "fixture_set_hash", "cycle_id"):
        if result.get(field) is not None and row.get(field) != result.get(field):
            return False, (
                f"ledger {field}={row.get(field)!r} does not match "
                f"claimed {field}={result.get(field)!r}"
            )
    case_count = row.get("case_count", 0)
    if not isinstance(case_count, int) or case_count <= 0:
        return False, "ledger case_count_zero (suite produced no cases)"
    if result.get("actual_status") is not None:
        if row.get("actual_status") != result.get("actual_status"):
            return False, (
                f"ledger actual_status={row.get('actual_status')!r} does not "
                f"match claimed {result.get('actual_status')!r}"
            )
    if result.get("evidence_hash") is not None:
        if row.get("evidence_hash") != result.get("evidence_hash"):
            return False, "ledger evidence_hash does not match claimed"
    return True, None


def assemble_fixture_results_from_suite(
    *,
    execution_run_id: str,
    base_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """C4-b (ORPHAN-675) — derive sandbox fixture_results from the ledger.

    ``evaluate_genesis_sandbox`` demands ≥3 provenance-carrying results
    whose claims the ledger join re-verifies — but no code path ever
    ASSEMBLED that list; it was an operator-authored JSON file, which is
    both toil and a place for hand-typed drift. The suite row the
    fixture runner already writes carries everything the join checks;
    this assembler is the mechanical bridge, so the sandbox's evidence
    is derived from the ledger it will be verified against (İ1: one
    source, no parallel authoring path).
    """
    from .fixture_runner import fixture_runs_path
    from .ledger import load_jsonl as load_chained_jsonl

    run_id = str(execution_run_id or "").strip()
    if not run_id:
        raise GovernanceError("assemble_requires_execution_run_id")
    row = None
    for candidate in load_chained_jsonl(fixture_runs_path(base_dir)):
        if candidate.get("row_type") not in ("fixture_run_suite", None):
            continue
        if str(candidate.get("execution_run_id") or "") == run_id:
            row = candidate
    if row is None:
        raise GovernanceError(
            f"assemble_unknown_execution_run_id: {run_id!r} has no suite "
            "row in fixture-runs.jsonl"
        )
    executed_at = str(row.get("at") or row.get("recorded_at") or "")
    results: list[dict[str, Any]] = []
    for case in row.get("cases") or []:
        if not isinstance(case, dict):
            continue
        results.append(
            {
                "name": str(case.get("name") or ""),
                "status": "pass" if case.get("passed") else "fail",
                "provenance": {
                    "executed_at": executed_at,
                    "execution_run_id": run_id,
                },
                "tool_id": row.get("tool_id"),
                "fixture_set_hash": row.get("fixture_set_hash"),
                "cycle_id": row.get("cycle_id"),
                "actual_status": row.get("actual_status"),
                "evidence_hash": row.get("evidence_hash"),
            }
        )
    return results


def evaluate_genesis_sandbox(
    *,
    draft_id: str,
    fixture_results: list[dict[str, Any]],
    base_dir: str | Path | None = None,
    synthetic_test_mode: bool = False,
) -> dict[str, Any]:
    """Evaluate a genesis sandbox run.

    Plan 022 §H-4 — pre-fix this function only counted fixture_results
    and checked status filter. A caller could pass synthetic
    [{status:'pass'}, {status:'pass'}, {status:'pass'}] and the sandbox
    would record 'pass' even though no fixture had ever executed.
    Result: fake-promoted agents could land via genesis without a real
    adversarial run.

    Post-fix: each fixture_result MUST carry execution provenance
    (provenance.executed_at + provenance.execution_run_id) proving the
    fixture actually ran. Missing provenance -> GovernanceError.

    synthetic_test_mode (or env var ARIA_GENESIS_TEST_SYNTHETIC=1)
    explicitly opts into synthetic input — operator test path only,
    NOT for prod use. The field is captured in the sandbox row so
    audit reviewers can distinguish real-execution sandboxes from
    test-mode synthetic ones.
    """
    enforce_profile_for_write("agent_genesis", base_dir=base_dir)
    draft = _find_draft(draft_id, base_dir)
    if len(fixture_results) < 3:
        raise GovernanceError("genesis sandbox requires at least 3 fixture results")

    # Plan 022 §H-4 — gate synthetic input.
    test_mode_env = os.environ.get("ARIA_GENESIS_TEST_SYNTHETIC", "").lower() in ("1", "true", "yes")
    in_test_mode = bool(synthetic_test_mode or test_mode_env)
    if not in_test_mode:
        # Plan 022 §H-4 — shape pre-filter (cheap fail-fast on bare
        # {status:'pass'} dicts).
        missing_provenance = [
            i for i, r in enumerate(fixture_results)
            if not _fixture_result_has_real_execution_provenance(r)
        ]
        if missing_provenance:
            raise GovernanceError(
                f"genesis_synthetic_input_forbidden_outside_test_mode: "
                f"fixture_results indices {missing_provenance} lack "
                f"provenance.executed_at + provenance.execution_run_id. "
                f"Either run the fixtures via fixture_runner so each result "
                f"carries real provenance, or pass synthetic_test_mode=True "
                f"(operator-test-only path)."
            )
        # Plan 023 v3 §A-1 — ledger-binding check. Pre-Plan-023 the
        # shape filter above was the ONLY gate; a caller could fabricate
        # provenance.execution_run_id="fake-anything" and pass. The
        # ledger join validates suite-level identity (tool_id /
        # fixture_set_hash / cycle_id / case_count > 0 / actual_status
        # / evidence_hash) against the actual fixture-runs.jsonl row.
        unverifiable: list[tuple[int, str]] = []
        for i, r in enumerate(fixture_results):
            ok, reason = _fixture_result_provenance_matches_ledger(
                r, base_dir=base_dir,
            )
            if not ok:
                unverifiable.append((i, reason or "unknown reason"))
        if unverifiable:
            details = "; ".join(f"[{i}] {reason}" for i, reason in unverifiable)
            raise GovernanceError(
                f"genesis_fixture_provenance_unverifiable: {details}"
            )

    failed = [result for result in fixture_results if result.get("status") != "pass"]
    duplicate = bool(draft.get("draft", {}).get("related_existing_agents"))
    decision = "duplicate_existing_agent" if duplicate else ("fail" if failed else "pass")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "decision": decision,
        "fixture_results": fixture_results,
        "synthetic_test_mode": in_test_mode,
        "blocked_by": _sandbox_blockers(decision),
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "genesis-sandbox" / "runs.jsonl", row)


def approve_agent_pr(
    *,
    draft_id: str,
    operator_approval_ref: str,
    base_dir: str | Path | None = None,
    operator_synthetic_override: bool = False,
) -> dict[str, Any]:
    """Approve a genesis draft for PR creation.

    Plan 026R §E.2 — synthetic-sandbox reject. Pre-§E.2 the gate only
    asserted ``sandbox.decision == 'pass'``; a sandbox run flagged
    ``synthetic_test_mode: true`` would still satisfy the predicate
    and the draft could ship through to the agent-PR lane. Synthetic
    flows are fixture-bound; an agent built on a synthetic sandbox
    decision has no real-evidence chain backing the approval. Post-
    §E.2: synthetic_test_mode=true rejects unless the operator
    explicitly passes ``operator_synthetic_override=True``.
    """
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("agent_genesis", base_dir=base_dir)
    if not operator_approval_ref.strip():
        raise GovernanceError("operator approval ref is required")
    draft = _find_draft(draft_id, base_dir)
    sandbox = _latest_sandbox(draft_id, base_dir)
    if not sandbox or sandbox.get("decision") != "pass":
        raise GovernanceError("agent draft must pass genesis sandbox before PR approval")
    if sandbox.get("synthetic_test_mode") is True and not operator_synthetic_override:
        raise GovernanceError(
            "synthetic_sandbox_cannot_approve_agent_pr: sandbox "
            f"run for draft {draft_id!r} ran with synthetic_test_mode=True; "
            "synthetic fixtures cannot back a real agent PR. Pass "
            "operator_synthetic_override=True ONLY if you have an audit "
            "trail proving the synthetic equivalence."
        )
    row = dict(draft)
    row["recorded_at"] = utc_now()
    row["status"] = "approved_for_agent_pr"
    row["operator_approval_ref"] = operator_approval_ref
    row["blocked_by"] = []
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "drafts.jsonl", row)


def prepare_agent_pr_lane(
    *,
    draft_id: str,
    workspace_root: str | Path,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("agent_genesis", base_dir=base_dir)
    draft = _find_draft(draft_id, base_dir)
    if draft.get("status") != "approved_for_agent_pr":
        raise GovernanceError("agent draft must be approved_for_agent_pr before PR lane preparation")
    target_path = str(draft.get("target_path") or "")
    name = str(draft.get("draft", {}).get("name") or "")
    blockers = []
    if not target_path.startswith(".claude/agents/aria-") or not target_path.endswith(".md"):
        blockers.append("target_path_not_agent_scoped")
    if not name.startswith("aria-"):
        blockers.append("agent_name_not_aria_scoped")
    root = Path(workspace_root).resolve()
    if (root / target_path).exists():
        blockers.append("target_agent_already_exists")
    if draft.get("draft", {}).get("related_existing_agents"):
        blockers.append("related_existing_agent_requires_owner_review")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "draft_id": draft_id,
        "gap_id": draft.get("gap_id"),
        "target_path": target_path,
        "branch": f"aria/agent-genesis/{name}",
        "changed_files": [target_path],
        "sandbox_ref": _latest_sandbox(draft_id, base_dir).get("ledger_hash") if _latest_sandbox(draft_id, base_dir) else None,
        "operator_approval_ref": draft.get("operator_approval_ref"),
        "status": "ready_for_pr" if not blockers else "blocked",
        "blocked_by": blockers,
        "body_sections": ["Problem", "Evidence", "Solution", "Validation", "Rollback", "Provenance"],
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "pr-lanes.jsonl", row)


def materialize_agent_draft(
    *,
    draft_id: str,
    assignment_id: str,
    workspace_root: str | Path,
    gate: "AutoActionGate",  # type: ignore[name-defined]  # noqa: F821
    base_dir: str | Path | None = None,
    run_invariants: bool = False,
    operator_synthetic_override: bool = False,
    ack_id: str | None = None,
) -> dict[str, Any]:
    """Materialise an approved genesis draft onto the worktree.

    Plan ARIA-V3 §A4 + §2a + §2k — the pre-V3 ``acknowledge: bool``
    parameter is REMOVED. Materialise now requires an
    ``AutoActionGate`` (Plan ARIA-V3 §A4) which encapsulates:
      * The runtime profile + lane + classifier decision.
      * The ack-token consumption (operator-minted via
        ``aria-kernel ack mint``. Autonomous auto-mint has no live lane
        in current mainline authority).
      * The ``materialize_event_id`` UUID that links the
        three-event audit chain (draft_validated → ack_consumed
        → materialize_committed).

    Plan 026R §E.6 — sandbox + synthetic gate at the materialise
    boundary. Pre-§E.6 the function only required ``acknowledge``;
    it did NOT check whether a passing sandbox decision backed the
    draft. §E.6 + V3 §A4 stack: sandbox-pass + autonomous-or-ack
    + grammar validator.
    """
    from .auto_action_gate import AutoActionGate
    if not isinstance(gate, AutoActionGate):
        raise GovernanceError(
            f"materialize_agent_draft requires gate: AutoActionGate "
            f"(Plan ARIA-V3 §A4 GAP-1 closure); got {type(gate).__name__!r}"
        )
    draft = _find_draft(draft_id, base_dir)
    sandbox = _latest_sandbox(draft_id, base_dir)
    if not sandbox or sandbox.get("decision") != "pass":
        raise GovernanceError(
            "materialize_requires_passing_sandbox: draft "
            f"{draft_id!r} has no passing genesis sandbox row"
        )
    if sandbox.get("synthetic_test_mode") is True and not operator_synthetic_override:
        raise GovernanceError(
            "synthetic_sandbox_cannot_materialize: draft "
            f"{draft_id!r} sandbox ran with synthetic_test_mode=True; "
            "synthetic fixtures cannot back a real agent materialisation. "
            "Pass operator_synthetic_override=True ONLY with audit trail."
        )
    dispatch = _find_dispatch(assignment_id, base_dir)
    worktree = Path(str(dispatch.get("worktree_path") or ""))
    if not worktree.is_absolute():
        worktree = Path(workspace_root).resolve() / worktree
    if not worktree.exists():
        raise GovernanceError("dispatch_worktree_missing")
    target_path = str(draft.get("target_path") or "")
    if not target_path.startswith(".claude/agents/aria-") or not target_path.endswith(".md"):
        raise GovernanceError("target_path_not_agent_scoped")
    # Plan ARIA-V3 §A4 + §2g — three-event audit chain linked by
    # ``materialize_event_id`` (AUDITTRAIL-CRITICAL-003 closure):
    #   1. draft_validated (post grammar gate, below)
    #   2. ack_consumed (gate.acquire_or_consume)
    #   3. materialize_committed (file write + final ledger row)
    materialize_event_id = gate.materialize_event_id
    # Plan ARIA-V3 §A3 — body comes from the drafter (worker_executor
    # spawned ``claude code agent --subagent-type aria-drafter``); it is
    # NOT the kernel's responsibility to synthesise markdown. The
    # ``body`` field replaces the pre-V3 ``content`` field. A missing
    # body means the drafter has not (yet) run successfully for this
    # draft; materialize refuses fail-closed.
    body = draft.get("body")
    if not isinstance(body, str) or not body.strip():
        raise GovernanceError(
            f"materialize_requires_drafter_body: draft {draft_id!r} has "
            f"no validated body yet (drafter run pending or failed; "
            f"check agent-genesis/drafter-invocations.jsonl)"
        )
    # Defense-in-depth: re-run the grammar validator on the body
    # at materialize-time. Sandbox already validated, but persisted
    # body could be mutated between sandbox + materialize; locking
    # the gate at the materialise boundary closes that window.
    intent_dict = draft.get("intent")
    if isinstance(intent_dict, dict):
        from .draft_intent import (
            AcceptanceTest as _AT,
            AgentDraftIntent as _ADI,
        )
        from .draft_validator import validate_body_against_intent

        intent_obj = _ADI(
            intent_kind=intent_dict.get("intent_kind", "agent"),
            intent_id=intent_dict.get("intent_id", ""),
            name=intent_dict.get("name", ""),
            target_path=intent_dict.get("target_path", target_path),
            purpose=intent_dict.get("purpose", ""),
            required_sections=tuple(intent_dict.get("required_sections") or ()),
            scope_globs=tuple(intent_dict.get("scope_globs") or ()),
            forbidden_globs=tuple(intent_dict.get("forbidden_globs") or ()),
            evidence_contract=intent_dict.get("evidence_contract", ""),
            output_schema=dict(intent_dict.get("output_schema") or {}),
            acceptance_tests=tuple(
                _AT(
                    name=t.get("name", ""),
                    expected=t.get("expected", ""),
                    description=t.get("description", ""),
                )
                for t in intent_dict.get("acceptance_tests") or ()
            ),
            evidence_allowlist=tuple(intent_dict.get("evidence_allowlist") or ()),
            diff_classifier_lane=intent_dict.get(
                "diff_classifier_lane", "L0-main",
            ),
            banned_phrases=tuple(intent_dict.get("banned_phrases") or ()),
            related_existing_agents=tuple(
                intent_dict.get("related_existing_agents") or ()
            ),
        )
        policy_path = (
            Path(__file__).resolve().parent / "data" / "auto_action_policy.json"
        )
        result = validate_body_against_intent(
            body, intent_obj, auto_action_policy_path=policy_path,
        )
        if not result.valid:
            # K6 (ORPHAN-MEDIUM-287) — surface a drafter refusal as a
            # structured aria/agent-refusal/v1 ledger row instead of a
            # generic grammar failure, so refusals are queryable on the
            # same surface as every other agent refusal and the retry
            # budget is never burned on a deterministic outcome.
            first = result.complaints[0] if result.complaints else ""
            if first.startswith("drafter_refusal"):
                reason_code = first.split(":", 1)[1] if ":" in first else "unrecognized"
                from .agent_contract import render_refusal
                from .draft_validator import DRAFTER_REFUSAL_CLASS_BY_CODE
                refusal_row = render_refusal(
                    request_id=str(draft_id),
                    cycle_id=str(materialize_event_id),
                    refused_by="aria-drafter",
                    reason_class=DRAFTER_REFUSAL_CLASS_BY_CODE.get(reason_code, "law"),
                    reason_text=f"drafter refusal sentinel: {reason_code}",
                    evidence_refs=[str(target_path)],
                )
                from .tool_registry import append_tools_governance as _dr_gov
                _dr_gov(
                    ensure_tools_dir(base_dir),
                    "drafter_refusal_recorded",
                    {
                        "materialize_event_id": materialize_event_id,
                        "draft_id": draft_id,
                        "reason_code": reason_code,
                        "refusal": refusal_row,
                    },
                )
                raise GovernanceError(f"drafter_refused:{reason_code}")
            raise GovernanceError(
                "materialize_body_grammar_invalid: "
                + ";".join(result.complaints)
            )
        # Plan ARIA-V3 §2g event 1 — draft_validated.
        from .tool_registry import append_tools_governance
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "draft_validated",
            {
                "materialize_event_id": materialize_event_id,
                "draft_id": draft_id,
                "intent_id": intent_obj.intent_id,
                "validator_result": "valid",
                "body_sha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            },
        )
    # Plan ARIA-V3 §2g event 2 — ack_consumed (via the gate's
    # unified path: operator-token consumed OR autonomous auto-mint).
    gate_outcome = gate.acquire_or_consume(
        ack_id=ack_id,
        base_dir=ensure_tools_dir(base_dir),
        draft_id=draft_id,
        intent_id=str(intent_dict.get("intent_id", "")) if isinstance(intent_dict, dict) else "",
        target_path=target_path,
        kind="agent",
        commit_sha_at_mint=_git_head(worktree),
        profile_state_at_mint=f"{gate.profile}:v1",
    )
    target = worktree / target_path
    try:
        target.resolve().relative_to(worktree.resolve())
    except ValueError as exc:
        raise GovernanceError("target_path_escapes_worktree") from exc
    # E16 (ORPHAN-673) — model-tier write protection at the ONE kernel
    # path that writes agent files. The authoring model is the drafter's
    # resolved runtime model (ARIA-V3 I-V3-00a locks aria-drafter as the
    # sole body author); the stamp is kernel-injected, never
    # drafter-supplied. Below the floor → refuse to author; weaker than
    # the existing file's author → refuse to overwrite (duel included —
    # that path escalates to HUMAN_REQUIRED, never through here).
    body = _enforce_model_tier_and_stamp(body, target=target, worktree=worktree)
    file_sha256_pre = _file_sha256(target)
    touched = [target_path]
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(body, encoding="utf-8")
    tmp.replace(target)
    status = "accepted"
    validation = None
    if run_invariants:
        completed = subprocess.run(["npm", "run", "invariants:full"], cwd=worktree, text=True, capture_output=True, check=False)
        validation = {"returncode": completed.returncode, "stdout": completed.stdout[-4000:], "stderr": completed.stderr[-4000:]}
        if completed.returncode != 0:
            subprocess.run(["git", "restore", "--", *touched], cwd=worktree, text=True, capture_output=True, check=False)
            status = "rejected"
    # Plan ARIA-V3 §2g event 3 — materialize_committed (post file
    # write; carries the body sha256 pre/post + commit linkage).
    from .tool_registry import append_tools_governance
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "materialize_committed",
        {
            "materialize_event_id": materialize_event_id,
            "target_path": target_path,
            "file_sha256_pre": file_sha256_pre,
            "file_sha256_post": hashlib.sha256(body.encode("utf-8")).hexdigest(),
            "commit_sha": _git_head(worktree),
            "draft_id": draft_id,
            "assignment_id": assignment_id,
            "kind": "agent",
            "status": status,
            "ack_consumed_at": gate_outcome.get("consumed_at"),
            "ack_id": gate_outcome.get("ack_id"),
        },
    )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "draft_id": draft_id,
        "assignment_id": assignment_id,
        "worktree_path": worktree.as_posix(),
        "target_path": target_path,
        "status": status,
        "validation": validation,
        "materialize_event_id": materialize_event_id,
        "ack_id": gate_outcome.get("ack_id"),
        "gate_profile": gate.profile,
        "gate_lane": gate.lane,
        "gate_human_ack_required": gate.human_ack_required,
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "materializations.jsonl", row)



def _authoring_model(worktree: Path) -> str:
    """The model that authored the draft body — the drafter's resolved
    runtime model from the agent-frontmatter SSoT (readable, not
    claimable: the drafter cannot assert a tier its frontmatter does
    not carry)."""
    from .agent_runtime_profile import read_agent_runtime_profile

    return read_agent_runtime_profile("aria-drafter", repo_root=worktree).model


def _enforce_model_tier_and_stamp(body: str, *, target: Path, worktree: Path) -> str:
    from .agent_runtime_profile import (
        assert_model_may_author_agents,
        assert_model_may_modify_agent,
        parse_authored_by_model,
        stamp_authored_by_model,
    )

    authoring = _authoring_model(worktree)
    assert_model_may_author_agents(authoring)
    if target.exists():
        existing_author = parse_authored_by_model(
            target.read_text(encoding="utf-8")
        )
        assert_model_may_modify_agent(
            active_model=authoring, target_authored_by=existing_author
        )
    return stamp_authored_by_model(body, authoring)


def _git_head(path: Path) -> str:
    completed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=path, text=True, capture_output=True, check=False)
    return completed.stdout.strip() if completed.returncode == 0 else "unknown"


def _file_sha256(path: Path) -> str:
    if not path.exists() or not path.is_file():
        return ""
    return hashlib.sha256(path.read_bytes()).hexdigest()

def request_agent_genesis(
    gap: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Append a genesis request row for an actionable capability gap.

    Why: hook-driven autonomy needs a write surface that records *intent*
    without invoking the Agent tool from the kernel. Operators or the
    Claude Code session pick up `requested` rows and run agent-genesis draft.

    Plan 026R §A.4 — frozen-profile gate at function entry. Agent-
    genesis request creation is one of the 8 §A.4 legacy mutators
    under the Plan 020 SCOPED no-write invariant.
    """
    from .runtime_profile import enforce_profile_for_write
    enforce_profile_for_write("agent_genesis", base_dir=base_dir)
    gap_id = str(gap.get("gap_id") or "").strip()
    capability_gap_key = str(gap.get("capability_gap_key") or gap_id).strip()
    if not gap_id or not capability_gap_key:
        raise GovernanceError("gap_id and capability_gap_key are required")
    capability_resolution = resolve_capability(
        capability_key=capability_gap_key,
        requested_kind="agent",
        title=str(gap.get("title") or capability_gap_key),
        existing_capabilities=_existing_capabilities(gap.get("related_existing_agents", [])),
        base_dir=base_dir,
    )
    row = {
        "$schema": "aria/agent-genesis-request/v1",
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "gap_id": gap_id,
        "capability_gap_key": capability_gap_key,
        "capability_resolution_ref": capability_resolution.get("ledger_hash"),
        "title": gap.get("title"),
        "evidence_refs": gap.get("evidence_refs", []),
        "score": gap.get("score"),
        "index_hash_at_decision": gap.get("index_hash_at_decision"),
        "status": "requested",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "requests.jsonl", row)


def _existing_capabilities(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        return []
    out: list[dict[str, Any]] = []
    for value in values:
        if isinstance(value, dict):
            out.append(value)
        elif isinstance(value, str) and value.strip():
            out.append({"name": value.strip(), "capability_key": value.strip()})
    return out


def record_extension_decision(
    gap: dict[str, Any],
    *,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
) -> dict[str, Any]:
    """Append an audit row for gaps that should extend an existing agent.

    Why: extension is an operator decision (≥80% coverage rubric); the kernel
    only records the candidate so review surfaces remain auditable.
    """
    row = {
        "$schema": "aria/agent-extension-decision/v1",
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "gap_id": gap.get("gap_id"),
        "capability_gap_key": gap.get("capability_gap_key"),
        "title": gap.get("title"),
        "related_existing_agents": gap.get("related_existing_agents", []),
        "evidence_refs": gap.get("evidence_refs", []),
        "index_hash_at_decision": gap.get("index_hash_at_decision"),
        "status": "operator_review_required",
    }
    return append_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "extension-decisions.jsonl", row)


def existing_genesis_request_keys(*, base_dir: str | Path | None = None) -> set[str]:
    """Return capability_gap_keys already requested in agent-genesis or skill-genesis.

    Used by the hook to avoid re-emitting requests for the same gap.
    """
    root = ensure_tools_dir(base_dir)
    keys: set[str] = set()
    for relpath in ("agent-genesis/requests.jsonl", "skill-genesis/requests.jsonl"):
        for row in load_jsonl(root / relpath):
            value = str(row.get("capability_gap_key") or "").strip()
            if value:
                keys.add(value)
    return keys


def list_agent_drafts(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "drafts.jsonl")


def list_genesis_sandbox_runs(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "genesis-sandbox" / "runs.jsonl")


def list_agent_pr_lanes(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "pr-lanes.jsonl")


def list_agent_materializations(*, base_dir: str | Path | None = None) -> list[dict[str, Any]]:
    return load_jsonl(ensure_tools_dir(base_dir) / "agent-genesis" / "materializations.jsonl")


def _find_gap(gap_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for gap in latest_capability_gaps(base_dir=base_dir):
        if gap.get("gap_id") == gap_id:
            return gap
    raise GovernanceError(f"capability gap not found: {gap_id}")


def _find_draft(draft_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for draft in reversed(list_agent_drafts(base_dir=base_dir)):
        if draft.get("draft_id") == draft_id:
            return draft
    raise GovernanceError(f"agent draft not found: {draft_id}")


def _latest_sandbox(draft_id: str, base_dir: str | Path | None) -> dict[str, Any] | None:
    for row in reversed(list_genesis_sandbox_runs(base_dir=base_dir)):
        if row.get("draft_id") == draft_id:
            return row
    return None


def _find_dispatch(assignment_id: str, base_dir: str | Path | None) -> dict[str, Any]:
    for row in reversed(load_jsonl(ensure_tools_dir(base_dir) / "dispatch" / "requests.jsonl")):
        if row.get("assignment_id") == assignment_id:
            return row
    raise GovernanceError(f"dispatch request not found: {assignment_id}")


def _agent_name(gap: dict[str, Any]) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", str(gap.get("title", "capability-gap")).lower()).strip("-")
    return "aria-" + (base[:48].strip("-") or "capability-gap")


def _scope_from_evidence(evidence_refs: list[str]) -> list[str]:
    scopes = []
    for ref in evidence_refs:
        parts = str(ref).split("/")
        if len(parts) >= 2 and parts[0] in ("apps", "libs"):
            scopes.append(f"{parts[0]}/{parts[1]}/**")
        elif len(parts) >= 3 and parts[0] == "platform":
            scopes.append(f"platform/libs/{parts[2]}/**")
    return sorted(set(scopes)) or ["**/*"]


def _validate_draft(draft: dict[str, Any]) -> None:
    """Plan ARIA-V3 §A3 — kernel-side draft sanity gate.

    Post-V3 the kernel does NOT produce markdown; it produces a
    ``DraftIntent``. The banned-phrase scan moved to body-time via
    ``draft_validator.validate_body_against_intent``. The kernel's
    self-scan here remains a defense-in-depth check on operator-
    facing free-text (purpose + evidence_contract) so a banned
    phrase fed in via the gap dict cannot propagate to the intent
    file the drafter receives.
    """
    missing = [field for field in REQUIRED_DRAFT_FIELDS if field not in draft]
    if missing:
        raise GovernanceError("agent draft missing fields: " + ", ".join(missing))
    free_text = " ".join((
        str(draft.get("purpose") or ""),
        str(draft.get("evidence_contract") or ""),
    )).lower()
    for phrase in BANNED_PHRASES:
        if phrase.lower() in free_text:
            raise GovernanceError(f"agent draft contains banned phrase: {phrase}")
    if not str(draft["name"]).startswith("aria-"):
        raise GovernanceError("generated agent name must start with aria-")
    if len(draft["validation_fixtures"]) < 3:
        raise GovernanceError("agent draft requires at least 3 validation fixtures")


# Plan ARIA-V3 §A3 + §2b + §2.4 — kernel emits a structured
# ``AgentDraftIntent`` (grammar + acceptance tests + evidence
# allowlist + diff classifier lane + banned phrases). The body is
# synthesised by ``tools/aria-poc/worker_executor.py`` (drafter
# mode) and validated against this intent before materialisation.
# SPEC §5.4 preserved: kernel never invokes ``Agent()`` directly.
#
# I-V3-12a locks the return type. The kernel module tree contains
# ZERO markdown literals after V3 (I-V3-12c grep invariant).
_AGENT_REQUIRED_SECTIONS: tuple[str, ...] = (
    "Purpose",
    "Scope",
    "Forbidden Scope",
    "Evidence Contract",
    "Output Schema",
    "Validation Fixtures",
)


def _render_agent_intent(draft: dict[str, Any]) -> AgentDraftIntent:
    """Plan ARIA-V3 §A3 + I-V3-12a — return the grammar, not the body.

    The intent is consumed by ``draft_validator.validate_body_against_intent``
    (kernel-side body grammar gate) AND by
    ``tools/aria-poc/worker_executor.py`` (drafter spawn — passed as
    ``--intent-file``). PII is masked at this boundary so the
    intent that reaches Claude carries no operator/commit-author
    email/phone/SSN (AUDITTRAIL-HIGH-008 closure).
    """
    fixtures = tuple(
        AcceptanceTest(
            name=str(item["name"]),
            expected=str(item["expected"]),
            description=str(item.get("description") or ""),
        )
        for item in draft["validation_fixtures"]
    )
    name = str(draft["name"])
    target_path = f".claude/agents/{name}.md"
    intent = AgentDraftIntent(
        intent_kind="agent",
        intent_id=f"intent-{name}",
        name=name,
        target_path=target_path,
        purpose=str(draft["purpose"]),
        required_sections=_AGENT_REQUIRED_SECTIONS,
        scope_globs=tuple(draft["scope_globs"]),
        forbidden_globs=tuple(draft["forbidden_globs"]),
        evidence_contract=str(draft["evidence_contract"]),
        output_schema=dict(draft["output_schema"]),
        acceptance_tests=fixtures,
        evidence_allowlist=tuple(draft.get("evidence_refs") or ()),
        diff_classifier_lane="L0-main",
        related_existing_agents=tuple(
            draft.get("related_existing_agents") or ()
        ),
    )
    # AUDITTRAIL-HIGH-008 — PII mask BEFORE the intent is persisted
    # or shipped to the drafter. The masker preserves the intent
    # structure; only free-text fields get redacted with deterministic
    # ``<pii:kind:sha8>`` tokens.
    return mask_pii_in_intent(intent)  # type: ignore[return-value]


def _sandbox_blockers(decision: str) -> list[str]:
    if decision == "pass":
        return []
    if decision == "duplicate_existing_agent":
        return ["existing_agent_owner_review_required"]
    return ["sandbox_fixture_failure"]
