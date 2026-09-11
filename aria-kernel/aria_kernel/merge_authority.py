from __future__ import annotations

from pathlib import Path
from typing import Any

from .auto_merge import (
    GitHubAdapter,
    _append_decision,
    _evaluate_triple_gate,
    _merge_if_green_with_executor,
    collect_github_snapshot,
    evaluate_auto_merge,
    record_pr_lifecycle,
)
from .autonomy_unlock import assert_autonomy_unlocked
from .enterprise_readiness import verify_enterprise_readiness
from .implementation_safety import GATE_PRE_MERGE, HardFailContext, run_hard_fail_checks
from .incident_ledger import (
    ensure_pre_merge_incident_row,
    finalize_merge_incident,
    record_merge_failed_incident,
)
from .policy_approval import verify_policy_approval
from .risk_policy import record_risk_decision_for_pr
from .rollback_bundle import verify_rollback_bundle
from .runtime_profile import enforce_profile_for_action
from .runner_attestation import verify_runner_attestation
from .tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now
from .watchdog_freeze import assert_merge_not_watchdog_frozen


def merge_pr_if_ready(
    *,
    adapter: GitHubAdapter,
    pr_number: int,
    base_dir: str | Path | None = None,
    policy: dict[str, Any] | None = None,
    cycle_id: str | None = None,
    diff_text: str | None = None,
    readiness_claim_id: str | None = None,
    workspace_root: str | Path | None = None,
) -> dict[str, Any]:
    """Single real-merge authority for ARIA-governed PRs.

    ``auto_merge.merge_if_green`` remains evaluation-only. This wrapper owns
    the real merge boundary: attempts must pass the runtime-profile gate,
    enterprise risk policy, autonomy unlock thresholds, ledger-bound enterprise
    readiness, runner and rollback evidence, incident pre-row, auto-merge
    eligibility, the change-ledger triple gate, and a final live re-evaluation
    immediately before invoking ``adapter.merge_pr``.
    """
    profile = enforce_profile_for_action("pr_merge", base_dir=base_dir)
    # ORPHAN-MEDIUM-562 — the external watchdog reports a stalled ARIA memory
    # and cannot freeze anything itself, because freezing needs the kernel it
    # is watching. The alarm is read HERE, at the single real-merge authority:
    # it stops ARIA merging on state nobody can attest to, while leaving the
    # cycle free to publish the state that closes the incident and leaving
    # human pull requests alone.
    assert_merge_not_watchdog_frozen(adapter=adapter)
    if not readiness_claim_id or not readiness_claim_id.strip():
        raise GovernanceError("merge_authority_requires_readiness_claim_id")
    live_pr = adapter.get_pr(pr_number)
    if not isinstance(live_pr, dict) or not live_pr:
        raise GovernanceError("merge_authority_live_pr_required")
    head_sha = _head_sha(live_pr)
    if not head_sha:
        raise GovernanceError("merge_authority_head_sha_required")

    risk = record_risk_decision_for_pr(
        live_pr,
        base_dir=base_dir,
        cycle_id=cycle_id,
    )
    if risk.get("valid") is not True:
        raise GovernanceError(
            "risk_policy_required_for_merge: "
            + "; ".join(str(item) for item in risk.get("reason_codes") or [])
        )
    lane = str(risk.get("lane") or "")
    unlock = assert_autonomy_unlocked(lane=lane, base_dir=base_dir)
    policy_approval: dict[str, Any] | None = None
    if lane == "L3":
        policy_approval = verify_policy_approval(
            pr_number=pr_number,
            head_sha=head_sha,
            policy_hash=str(risk.get("policy_hash") or ""),
            base_dir=base_dir,
        )

    readiness = verify_enterprise_readiness(
        pr_number=pr_number,
        adapter=adapter,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )
    if not readiness.valid:
        raise GovernanceError(
            "enterprise_readiness_required_for_merge: " + "; ".join(readiness.reasons)
        )
    runner = verify_runner_attestation(
        pr_number=pr_number,
        head_sha=head_sha,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )
    rollback = verify_rollback_bundle(
        pr_number=pr_number,
        head_sha=head_sha,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )
    incident_pre = ensure_pre_merge_incident_row(
        pr=live_pr,
        readiness_claim_id=readiness_claim_id,
        base_dir=base_dir,
    )

    decision = _merge_if_green_with_executor(
        adapter=adapter,
        pr_number=pr_number,
        policy=policy,
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=True,
        diff_text=diff_text,
    )
    result = decision
    if decision.get("eligible"):
        head_sha = str(decision["head_sha"])
        triple = _evaluate_triple_gate(
            pr_number=pr_number,
            head_sha=head_sha,
            base_dir=base_dir,
        )
        if not triple["passed"]:
            result = dict(decision)
            result.update(
                {
                    "recorded_at": utc_now(),
                    "decision": "blocked",
                    "eligible": False,
                    "reasons": [
                        "auto_merge_triple_gate_blocked",
                        *triple["reasons"],
                    ],
                    "stage": "triple_gate_pre_merge",
                    "change_id": triple.get("change_id"),
                },
            )
            _append_decision(base_dir, result)
        else:
            fresh_pr = adapter.get_pr(pr_number)
            fresh_github = collect_github_snapshot(adapter, fresh_pr)
            fresh_diff: str | None = None
            if hasattr(adapter, "get_pr_diff"):
                try:
                    fresh_diff = adapter.get_pr_diff(pr_number)  # type: ignore[attr-defined]
                except Exception:
                    fresh_diff = None
            if fresh_diff is None:
                fresh_diff = fresh_pr.get("diff_text")
            fresh_decision = evaluate_auto_merge(
                pr=fresh_pr,
                github=fresh_github,
                policy=policy,
                base_dir=None,
                cycle_id=cycle_id,
                dry_run=True,
                diff_text=fresh_diff,
            )
            latest_head_sha = fresh_decision.get("head_sha")
            if not fresh_decision.get("eligible"):
                result = dict(decision)
                result.update(
                    {
                        "recorded_at": utc_now(),
                        "decision": "blocked",
                        "eligible": False,
                        "latest_head_sha": latest_head_sha,
                        "reasons": [
                            "pre_merge_re_evaluation_blocked",
                            *list(fresh_decision.get("reasons") or []),
                        ],
                        "stage": "pre_merge_re_evaluation",
                    },
                )
                _append_decision(base_dir, result)
            elif latest_head_sha != head_sha:
                result = dict(decision)
                result.update(
                    {
                        "recorded_at": utc_now(),
                        "decision": "blocked",
                        "eligible": False,
                        "latest_head_sha": latest_head_sha,
                        "reasons": ["PR head SHA changed after green evaluation"],
                        "stage": "pre_merge_re_evaluation",
                    },
                )
                _append_decision(base_dir, result)
            else:
                # Bind the final live PR observation to native implementation
                # evidence after head re-evaluation. Missing roots or joins
                # remain explicit gaps; the existing registry owns refusal.
                perimeter_context = _capture_pre_merge_context(
                    workspace_root=workspace_root,
                    base_dir=base_dir,
                    pr=fresh_pr,
                    diff_text=fresh_diff,
                )
                hard_fail_report = run_hard_fail_checks(
                    perimeter_context, gate=GATE_PRE_MERGE,
                )
                from .expert_review_gate import _ensure_implementation_expert_requests

                _ensure_implementation_expert_requests(
                    perimeter_context, hard_fail_report,
                    base_dir=base_dir, cycle_id=cycle_id,
                )
                if not hard_fail_report.passed:
                    result = dict(decision)
                    result.update(
                        {
                            "recorded_at": utc_now(),
                            "decision": "blocked",
                            "eligible": False,
                            "reasons": [
                                "pre_merge_perimeter_blocked",
                                *[
                                    f"{failure.name}:{failure.reason}"
                                    for failure in hard_fail_report.failures
                                ],
                            ],
                            "stage": "pre_merge_perimeter",
                        },
                    )
                    _append_decision(base_dir, result)
                else:
                    merge_kwargs: dict[str, Any] = {
                        "method": "squash",
                        "expected_head_sha": head_sha,
                    }
                    authority_token = f"merge-authority:{pr_number}:{head_sha}"
                    armed = False
                    if hasattr(adapter, "arm_merge_authority"):
                        adapter.arm_merge_authority(authority_token)  # type: ignore[attr-defined]
                        merge_kwargs["authority_token"] = authority_token
                        armed = True
                    try:
                        merge_result = adapter.merge_pr(pr_number, **merge_kwargs)
                    except Exception as exc:  # pragma: no cover - exercised by adapter fakes
                        record_merge_failed_incident(
                            pr=fresh_pr,
                            readiness_claim_id=readiness_claim_id,
                            reason=str(exc),
                            base_dir=base_dir,
                        )
                        result = dict(decision)
                        result.update(
                            {
                                "recorded_at": utc_now(),
                                "decision": "failed",
                                "eligible": False,
                                "reasons": [str(exc)],
                            },
                        )
                        _append_decision(base_dir, result)
                    else:
                        result = dict(decision)
                        result.update(
                            {
                                "recorded_at": utc_now(),
                                "decision": "merged",
                                "eligible": True,
                                "merge_result": merge_result,
                            },
                        )
                        _append_decision(base_dir, result)
                        finalize_merge_incident(
                            pr=fresh_pr,
                            readiness_claim_id=readiness_claim_id,
                            merge_result=merge_result,
                            base_dir=base_dir,
                        )
                        record_pr_lifecycle(
                            fresh_pr,
                            event="merged",
                            base_dir=base_dir,
                            cycle_id=cycle_id,
                        )
                    finally:
                        if armed and hasattr(adapter, "clear_merge_authority"):
                            adapter.clear_merge_authority(authority_token)  # type: ignore[attr-defined]
    append_tools_governance(
        ensure_tools_dir(base_dir),
        "merge_authority_decision",
        {
            "profile": profile,
            "pr_number": pr_number,
            "risk_lane": lane,
            "risk_policy_hash": risk.get("policy_hash"),
            "unlock_counts": unlock.counts,
            "policy_approval": policy_approval,
            "runner_attestation": runner,
            "rollback_bundle": rollback,
            "incident_pre_row_hash": incident_pre.get("ledger_hash"),
            "decision": result.get("decision"),
            "eligible": result.get("eligible"),
            "cycle_id": cycle_id,
            "readiness_claim_id": readiness_claim_id,
            "readiness_failure_classes": list(readiness.failure_classes),
        },
    )
    return result


def _head_sha(pr: dict[str, Any]) -> str:
    for key in ("head_sha", "headRefOid", "head"):
        value = pr.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _base_branch(pr: dict[str, Any]) -> str | None:
    for key in ("base_branch", "baseRefName", "base"):
        value = pr.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _capture_pre_merge_context(
    *,
    workspace_root: str | Path | None,
    base_dir: str | Path | None,
    pr: dict[str, Any],
    diff_text: str | None,
) -> HardFailContext:
    """Capture native pre-merge identities without manufacturing missing joins.

    Host binding and Git work run outside state transactions. Exact native
    prefixes are captured together and rechecked after the existing plan and
    snapshot owners finish; a changed source makes the context unavailable.
    This reader neither repairs historical rows nor qualifies an absent
    implementation request. The registry still owns all check verdicts.
    """
    import re as _re
    from dataclasses import replace as _replace

    from . import agent_invocations as _invocations
    from . import plan_convergence as _plans
    from .implementation_safety import _PreMergeEvidence
    from .ledger import LedgerIntegrityError as _LedgerIntegrityError
    from .ledger import load_jsonl_verified_text as _load_verified_text
    from .ledger import state_transaction as _state_transaction
    from .snapshot import build_repo_snapshot as _build_snapshot
    from .state_store import StateStoreError as _StateStoreError
    from .state_store import _git, _read_bounded_regular_file, _valid_host_identity
    from .tool_registry import ensure_tools_dir_readonly as _existing_tools
    from .workspace import canonical_identity as _canonical_identity

    context = HardFailContext(
        diff_text=diff_text,
        base_branch=_base_branch(pr),
        pr_body=pr.get("body") if isinstance(pr.get("body"), str) else None,
        pre_merge_evidence=_PreMergeEvidence(("workspace_root_unavailable",)),
    )
    if workspace_root is None:
        return context
    reason = "workspace_root_unavailable"
    try:
        workspace = Path(workspace_root).resolve()
        context = _replace(context, workspace_root=workspace)
        reason = "tools_root_unavailable"
        tools = _existing_tools(base_dir)
        if tools is None:
            raise GovernanceError("tools_root_unavailable")
        reason = "repository_binding_unavailable"
        identity_path = tools / "repo_identity.json"
        contract_path = tools / "tools_contract.json"
        identity_bytes = _read_bounded_regular_file(identity_path)[0]
        contract_bytes = _read_bounded_regular_file(contract_path)[0]
        repo_identity = _canonical_identity(workspace)
        if not _valid_host_identity(
            tools, repo_identity, workspace,
            identity_payload=identity_bytes, contract_payload=contract_bytes,
        ):
            raise GovernanceError(reason)

        reason = "pr_commit_identity_unavailable"
        number = pr.get("number")
        head_sha = _head_sha(pr)
        base_sha = pr.get("base_sha") or pr.get("baseRefOid")
        if (
            type(number) is not int or number <= 0
            or not isinstance(base_sha, str)
            or _re.fullmatch(r"[0-9a-f]{40}", base_sha) is None
            or _re.fullmatch(r"[0-9a-f]{40}", head_sha) is None
            or _git(workspace, "rev-parse", "--verify", base_sha + "^{commit}").strip() != base_sha
            or _git(workspace, "rev-parse", "--verify", head_sha + "^{commit}").strip() != head_sha
        ):
            raise GovernanceError(reason)

        sources = {
            "pr_lifecycle": tools / "pr-lifecycle.jsonl",
            "change_planned": tools / "change-ledger" / "planned.jsonl",
            "change_committed": tools / "change-ledger" / "committed.jsonl",
            "plan_convergence_events": tools / "plans" / "events.jsonl",
        }
        optional_sources = {
            "agent_invocation_requests": tools / "agent-invocations" / "requests.jsonl",
            "agent_invocation_claims": tools / "agent-invocations" / "claims.jsonl",
            "agent_invocation_results": tools / "agent-invocations" / "results.jsonl",
            "agent_invocation_contexts": tools / "agent-invocations" / "contexts.jsonl",
            "agent_invocation_prompts": tools / "agent-invocations" / "prompts.jsonl",
            "agent_result_bridge_status": tools / "agent-invocations" / "agent-result-bridge-status.jsonl",
        }
        sources.update(optional_sources)

        def read_prefix(surface: str, path: Path) -> bytes | None:
            if surface in optional_sources and not path.exists():
                return None
            return _read_bounded_regular_file(path)[0]

        paths = [identity_path, contract_path, *sources.values()]
        reason = "native_context_prefix_unavailable"
        with _state_transaction(paths):
            if (
                _read_bounded_regular_file(identity_path)[0] != identity_bytes
                or _read_bounded_regular_file(contract_path)[0] != contract_bytes
            ):
                raise GovernanceError("repository_binding_changed")
            prefixes = {
                surface: read_prefix(surface, path)
                for surface, path in sources.items()
            }
        rows = {
            surface: _load_verified_text(
                prefixes[surface].decode("utf-8"), source=path,
                expected_surface=surface,
            ) if prefixes[surface] is not None else []
            for surface, path in sources.items()
        }
        reason = "pr_change_join_unavailable"
        observations = [row for row in rows["pr_lifecycle"] if row.get("pr_number") == number]
        change_ids = {row.get("change_id") for row in observations if row.get("change_id")}
        if len(change_ids) != 1 or not observations:
            raise GovernanceError(reason)
        observed = observations[-1]
        change_id = next(iter(change_ids))
        if (
            observed.get("change_id") != change_id
            or observed.get("head_sha") != head_sha
            or observed.get("base_branch") != context.base_branch
            or (pr.get("change_id") is not None and pr["change_id"] != change_id)
        ):
            raise GovernanceError(reason)
        planned_rows = [row for row in rows["change_planned"] if row.get("change_id") == change_id]
        committed_rows = [row for row in rows["change_committed"] if row.get("change_id") == change_id]
        if len(planned_rows) != 1 or len(committed_rows) != 1:
            raise GovernanceError(reason)
        planned, committed = planned_rows[0], committed_rows[0]
        if committed.get("commit_sha") != head_sha:
            raise GovernanceError(reason)

        reason = "plan_revision_unavailable"
        plan_id = planned["plan_id"]
        # Reuse the native reducer on the verified immutable prefix. Calling
        # the cached file reader here could select a different source view.
        state = _plans._initial_state(plan_id)
        for event in rows["plan_convergence_events"]:
            if event.get("plan_id") == plan_id:
                _plans._validate_event(event)
                _plans._apply_event(state, event)
        _plans._derive_state(state)
        body = _plans.plan_body_from_state(state)
        _plans.resolve_converged_plan_observation(
            plan_id=plan_id, revision_id=body["revision_id"],
            expected_content_hash=body["content_hash"], base_dir=tools,
        )

        reason = "committed_snapshot_unavailable"
        snapshot = _build_snapshot(workspace_root=workspace, mode="committed")
        if snapshot.get("base_commit_sha") != head_sha or snapshot.get("unknown_count") != 0:
            raise GovernanceError(reason)
        reason = "committed_paths_unavailable"
        changed_paths = sorted(filter(None, _git(
            workspace, "diff", "--name-only", "-z", base_sha, head_sha,
        ).split("\0")))
        if changed_paths != sorted(committed.get("actual_affected_files") or []):
            raise GovernanceError(reason)

        implementation, gaps = _join_pre_merge_implementation(
            tools=tools, workspace=workspace, rows=rows, state=state,
            body=body, planned=planned, committed=committed, observed=observed,
            pr=pr, base_sha=base_sha, head_sha=head_sha, diff_text=diff_text,
        )
        coverage_observation: dict[str, Any] = {}
        coverage_files: dict[Path, bytes | None] = {}
        if implementation.get("request_id"):
            coverage_observation, coverage_files = _capture_pre_merge_coverage(
                tools=tools, workspace=workspace, state=state, body=body,
                events=rows["plan_convergence_events"], base_sha=base_sha,
            )

        scope_observation: dict[str, Any] = {}
        reason = "native_context_changed_during_capture"
        with _state_transaction(paths):
            if (
                _read_bounded_regular_file(identity_path)[0] != identity_bytes
                or _read_bounded_regular_file(contract_path)[0] != contract_bytes
                or any(read_prefix(surface, path) != prefixes[surface]
                       for surface, path in sources.items())
                or any(_read_pre_merge_coverage_file(path) != data
                       for path, data in coverage_files.items())
            ):
                raise GovernanceError(reason)
            if implementation.get("request_id"):
                reason = "implementation_scope_observation_unavailable"
                request = next(row for row in rows["agent_invocation_requests"]
                               if row["request_id"] == implementation["request_id"])
                observed_at = _invocations._utc_now_dt()
                conflict = _invocations._implementation_scope_conflict(
                    request, requests=rows["agent_invocation_requests"],
                    claims=rows["agent_invocation_claims"],
                    results=rows["agent_invocation_results"], now=observed_at,
                )
                scope_observation = {
                    "scope_observed_at": observed_at.isoformat(),
                    "scope_ledger_tips": tuple(rows[surface][-1]["ledger_hash"] for surface in (
                        "agent_invocation_requests", "agent_invocation_claims", "agent_invocation_results",
                    )),
                    "scope_conflicting_claim_id": conflict["claim_id"] if conflict else None,
                    "scope_conflicting_claim_hash": conflict["claim_row_hash"] if conflict else None,
                }

        return _replace(
            context,
            affected_paths=tuple(changed_paths),
            envelope={"affected_surfaces": list(changed_paths)},
            pre_merge_evidence=_PreMergeEvidence(
                unavailable_reasons=gaps, pr_number=number, change_id=change_id,
                pr_row_hash=observed["ledger_hash"], planned_row_hash=planned["ledger_hash"],
                committed_row_hash=committed["ledger_hash"], plan_id=plan_id,
                plan_revision_id=body["revision_id"], plan_content_hash=body["content_hash"],
                repo_identity=repo_identity, base_sha=base_sha, head_sha=head_sha,
                snapshot_hash=snapshot["snapshot_hash"],
                **implementation, **scope_observation, **coverage_observation,
            ),
        )
    except (OSError, ValueError, KeyError, TypeError, _LedgerIntegrityError, _StateStoreError):
        return _replace(context, pre_merge_evidence=_PreMergeEvidence((reason,)))


def _read_pre_merge_coverage_file(path: Path) -> bytes | None:
    from .state_store import StateStoreError as _StateStoreError
    from .state_store import _read_bounded_regular_file

    try:
        return _read_bounded_regular_file(path)[0]
    except (OSError, _StateStoreError):
        return None


def _capture_pre_merge_coverage(
    *, tools: Path, workspace: Path, state: dict[str, Any], body: dict[str, Any],
    events: list[dict[str, Any]], base_sha: str,
) -> tuple[dict[str, Any], dict[Path, bytes | None]]:
    """Observe the native plan-time witness, retaining local availability gaps.

    This verifies the adopted plan/event/artifact join and planning commit's
    ancestry. It does not rerun the dependency graph at the implementation tip.
    All Git and artifact decoding precede the caller's final prefix recheck.
    """
    import hashlib as _hashlib
    import json as _json
    import re as _re

    from . import plan_convergence as _plans
    from . import plan_coverage as _coverage
    from .state_store import StateStoreError as _StateStoreError
    from .state_store import _git

    observation: dict[str, Any] = {"coverage_required": _plans._plan_requires_coverage(state)}
    files: dict[Path, bytes | None] = {}
    if not observation["coverage_required"]:
        return observation, files
    reason = "native_coverage_event_unavailable"
    try:
        plan_id = state["plan_id"]
        round_number = state["current_round"]
        candidates = [event for event in events if event.get("plan_id") == plan_id
                      and event.get("event_type") == "coverage_computed"
                      and event["payload"].get("round_number") == round_number]
        if not candidates:
            raise GovernanceError(reason)
        event = candidates[-1]
        payload = event["payload"]
        observation.update(
            coverage_event_hash=event["ledger_hash"],
            coverage_revision_id=payload["target_revision_id"],
            coverage_plan_hash=payload["target_plan_content_hash"],
            coverage_computed_at_sha=payload["computed_at_sha"],
            coverage_verdict=payload["verdict"],
        )
        reason = "coverage_target_revision_mismatch"
        if (
            payload != state["coverage_by_round"][round_number]
            or payload["target_revision_id"] != body["revision_id"]
            or payload["target_plan_content_hash"] != body["content_hash"]
        ):
            raise GovernanceError(reason)
        reason = "native_coverage_verdict_unavailable"
        _plans._require_coverage_for_implementation(state)
        if payload["verdict"] not in {"covered", "covered_with_waivers"}:
            raise GovernanceError(reason)
        reason = "coverage_manifest_identity_mismatch"
        manifest_name = f"{plan_id}-r{round_number}.json"
        manifest_relpath = f"{tools.name}/{_coverage.COVERAGE_DIR}/{manifest_name}"
        if payload["closure_manifest_path"] != manifest_relpath:
            raise GovernanceError(reason)
        manifest_path = tools / _coverage.COVERAGE_DIR / manifest_name
        input_path = tools / _coverage.COVERAGE_DIR / f"{plan_id}-r{round_number}-input.json"
        files[manifest_path] = _read_pre_merge_coverage_file(manifest_path)
        files[input_path] = _read_pre_merge_coverage_file(input_path)
        reason = "coverage_manifest_unavailable"
        manifest_bytes = files[manifest_path]
        if manifest_bytes is None:
            raise GovernanceError(reason)
        reason = "coverage_manifest_hash_mismatch"
        manifest_hash = "sha256:" + _hashlib.sha256(manifest_bytes).hexdigest()
        if manifest_hash != payload["closure_manifest_hash"]:
            raise GovernanceError(reason)
        observation["coverage_manifest_hash"] = manifest_hash
        reason = "coverage_input_unavailable"
        if files[input_path] is None:
            raise GovernanceError(reason)
        reason = "coverage_input_plan_mismatch"
        if _json.loads(files[input_path]) != _coverage._coverage_witness_input(body["plan_content"]):
            raise GovernanceError(reason)
        reason = "coverage_manifest_invalid"
        report = _json.loads(manifest_bytes)
        if not isinstance(report, dict) or report.get("schema_version") != 1:
            raise GovernanceError(reason)
        closure = report.get("closure")
        if (
            not isinstance(closure, dict)
            or any(not isinstance(closure.get(name), list)
                   for name in ("projects", "event_consumers", "migration_couplings"))
            or any(not isinstance(report.get(name), list)
                   for name in ("uncovered", "waived", "unmapped_paths"))
            or _re.fullmatch(r"[0-9a-f]{64}", str(report.get("inputs_hash") or "")) is None
        ):
            raise GovernanceError(reason)
        fields = _coverage._coverage_report_fields(
            report, round_number=round_number, manifest_relpath=manifest_relpath,
        )
        reason = "coverage_manifest_payload_mismatch"
        if report.get("verdict") != fields["verdict"] or any(payload.get(key) != value for key, value in fields.items()):
            raise GovernanceError(reason)
        reason = "coverage_waiver_adjudication_unavailable"
        if payload["waived"] or payload["verdict"] != "covered":
            # A flag in witness metadata cannot replace the critic's actual
            # accepted request/result/artifact chain. Keep this branch closed.
            raise GovernanceError(reason)
        reason = "coverage_witness_execution_unavailable"
        witness = payload["witness"]
        if witness.get("tool") != _coverage.WITNESS_RELPATH or type(witness.get("exit_code")) is not int or witness["exit_code"] != 0:
            raise GovernanceError(reason)
        reason = "coverage_planning_commit_unavailable"
        computed_sha = payload["computed_at_sha"]
        if (
            _re.fullmatch(r"[0-9a-f]{40}", computed_sha) is None
            or _git(workspace, "rev-parse", "--verify", computed_sha + "^{commit}").strip() != computed_sha
            or _git(workspace, "merge-base", computed_sha, base_sha).strip() != computed_sha
        ):
            raise GovernanceError(reason)
        return observation, files
    except (OSError, ValueError, TypeError, KeyError, _StateStoreError):
        observation["coverage_unavailable_reason"] = reason
        return observation, files


def _join_pre_merge_implementation(
    *, tools: Path, workspace: Path, rows: dict[str, list[dict[str, Any]]],
    state: dict[str, Any], body: dict[str, Any], planned: dict[str, Any],
    committed: dict[str, Any], observed: dict[str, Any], pr: dict[str, Any],
    base_sha: str, head_sha: str, diff_text: str | None,
) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Join native implementation evidence; retain explicit historical gaps."""
    import hashlib as _hashlib
    import json as _json

    from . import agent_invocations as _invocations
    from .agent_contract import validate_response as _validate_response
    from .bridge_status_ledger import derive_bridge_state as _derive_bridge_state
    from .state_store import _git

    claim_id = committed.get("claim_id")
    if not claim_id:
        return {}, (
            "implementation_request_unverified" if planned.get("intended_request_id")
            else "implementation_request_unavailable",
            "implementation_claim_unavailable", "implementation_result_unavailable",
        )
    reason = "implementation_claim_join_unavailable"
    try:
        claims = [row for row in rows["agent_invocation_claims"]
                  if row.get("claim_id") == claim_id and row.get("event") == "claimed"]
        if len(claims) != 1:
            raise GovernanceError(reason)
        claim = claims[0]
        reason = "implementation_request_join_unavailable"
        requests = [row for row in rows["agent_invocation_requests"]
                    if row.get("request_id") == claim.get("request_id")]
        if len(requests) != 1:
            raise GovernanceError(reason)
        request = requests[0]
        request_id = request["request_id"]
        ids = request.get("implementation_ids") or {}
        implementation = state.get("implementation") or {}
        if (
            request.get("role") != "implementation"
            or request.get("convergence_id") != planned["plan_id"]
            or ids.get("change_id") != planned["change_id"]
            or not observed.get("proposal_id")
            or ids.get("proposal_id") != observed["proposal_id"]
            or (pr.get("proposal_id") is not None and pr["proposal_id"] != ids["proposal_id"])
            or ids.get("base_sha") != base_sha
            or ids.get("branch") != (pr.get("head_ref") or pr.get("headRefName"))
            or (planned.get("intended_request_id") is not None
                and planned["intended_request_id"] != request_id)
            or request.get("plan_revision_hash") != body["content_hash"]
            or implementation.get("converged_plan_revision_id") != body["revision_id"]
            or implementation.get("converged_plan_content_hash") != body["content_hash"]
            or implementation.get("claim_id") != claim_id
        ):
            raise GovernanceError(reason)
        _invocations._strict_request_view(request)
        _invocations._assert_envelope_reproduces_binding(request)
        context_row = next((row for row in reversed(rows["agent_invocation_contexts"])
                            if row.get("request_id") == request_id), None)
        binding = _invocations._verify_invocation_context_binding_rows(
            request_id=request_id, context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], context=context_row,
            prompts=rows["agent_invocation_prompts"],
        )
        for field, surface in (("context", "agent_invocation_contexts"),
                               ("prompt", "agent_invocation_prompts")):
            if not any(row.get("ledger_hash") == binding[field].get("ledger_hash")
                       for row in rows[surface]):
                raise GovernanceError("implementation_prompt_source_changed")

        reason = "implementation_result_join_unavailable"
        results = _invocations._result_rows_for(rows["agent_invocation_results"], request_id)
        if not results:
            raise GovernanceError(reason)
        result = results[-1]
        if (
            result.get("status") != "accepted" or result.get("role") != "implementation"
            or result.get("claim_id") != claim_id or result.get("agent_id") != claim.get("agent_id")
            or result.get("context_hash") != request["context_hash"]
            or result.get("prompt_hash") != request["prompt_hash"]
        ):
            raise GovernanceError(reason)
        artifact_bytes = {}
        for name, hash_field in (("output_path", "output_hash"),
                                 ("transcript_artifact_ref", "transcript_hash")):
            path = _invocations.resolve_output_artifact_path(tools, result[name])
            path.resolve().relative_to(tools.resolve())
            data = _invocations._read_stable_submission_artifact(path)
            if "sha256:" + _hashlib.sha256(data).hexdigest() != result[hash_field]:
                raise GovernanceError(reason)
            artifact_bytes[name] = data
        response = _json.loads(artifact_bytes["output_path"])
        _validate_response(response, request=_invocations._strict_request_view(request),
                           lease={"claim_id": claim_id, "agent_id": claim["agent_id"]})
        outcome = (response.get("details") or {}).get("implementation") or {}
        recorded = [event for event in state["events"]
                    if event.get("event_type") == "implementation_outcome_recorded"
                    and event.get("payload", {}).get("claim_id") == claim_id]
        if len(recorded) != 1 or state.get("state") != "IMPLEMENTATION_RECORDED":
            raise GovernanceError(reason)
        event = recorded[0]
        for field in ("claim_id", "pr_url", "diff_hash", "branch_tip_sha", "base_branch_sha",
                      "validation_results", "signer_key_fp", "completed_at"):
            if outcome.get(field) != event["payload"].get(field):
                raise GovernanceError(reason)
        if (
            outcome.get("branch_tip_sha") != head_sha or outcome.get("base_branch_sha") != base_sha
            or not pr.get("url") or outcome.get("pr_url") != pr["url"]
            or _git(workspace, "merge-base", base_sha, head_sha).strip() != base_sha
        ):
            raise GovernanceError(reason)
        bridge = _derive_bridge_state(base_dir=tools, result_row=result)
        bridge_rows = [row for row in rows["agent_result_bridge_status"]
                       if row.get("result_row_ledger_hash") == result["ledger_hash"]
                       and row.get("envelope_evidence_hash") == result.get("envelope_evidence_hash")]
        if not bridge_rows or bridge_rows[-1].get("transition") != "ok" or bridge["state"] != "ok":
            raise GovernanceError(reason)
        actual_diff = _git(workspace, "diff", base_sha, head_sha).strip()
        if diff_text is None or diff_text.strip() != actual_diff:
            raise GovernanceError("implementation_diff_unavailable")
        actual_diff_hash = "sha256:" + _hashlib.sha256(actual_diff.encode("utf-8")).hexdigest()
        if outcome.get("diff_hash") != actual_diff_hash:
            raise GovernanceError("implementation_diff_hash_mismatch")
        return {
            "request_id": request_id, "claim_id": claim_id,
            "request_row_hash": request["ledger_hash"], "claim_row_hash": claim["ledger_hash"],
            "result_row_hash": result["ledger_hash"], "implementation_event_hash": event["ledger_hash"],
            "implementation_base_sha": outcome["base_branch_sha"],
            "implementation_head_sha": outcome["branch_tip_sha"],
            "request_plan_hash": request["plan_revision_hash"],
            "implementation_plan_hash": implementation["converged_plan_content_hash"],
            "implementation_diff_hash": actual_diff_hash,
            "branch": ids["branch"],
        }, ("remaining_pre_merge_evidence_unavailable",)
    except (OSError, ValueError, KeyError, TypeError):
        return {}, (reason,)


__all__ = ["merge_pr_if_ready"]
