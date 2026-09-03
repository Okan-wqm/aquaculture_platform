from __future__ import annotations

import fnmatch
import json
from pathlib import Path
from typing import Any

from .feedback_store import findings_path
from .ledger import (
    append_declared_jsonl,
    append_jsonl as _append_jsonl,
    load_declared_jsonl,
    load_jsonl as _load_jsonl,
    rewrite_jsonl,
)
from .memory import latest_beliefs
from .tool_registry import GovernanceError, ensure_tools_dir, list_tools, utc_now


PR_EVENTS = {"opened", "synchronize", "reopened", "closed", "merged"}

# E14 — the change-intelligence agent the `change_intelligence` role always
# named and nothing ever minted. The mechanical impact map below matches
# evidence refs against changed paths by glob; it cannot see a coupling that is
# not spelled as a path (a renamed symbol, a moved contract, a belief whose
# evidence moved file). That reading is what the agent is for, and the merge
# commit is when it is worth paying for.
CHANGE_INTELLIGENCE_ROLE = "change_intelligence"
CHANGE_INTELLIGENCE_AGENT = "aria-change-intelligence"

# Evidence-ref budget for one change-intelligence envelope. A merge of 400
# files must not be pasted whole into a prompt; the agent is told the full
# count and reads the rest from the merge commit itself.
_MAX_CHANGED_FILE_REFS = 40

# Mint budget per run — see dispatch_change_intelligence for WHY a backlog
# must not become one night's bill.
DEFAULT_MAX_CHANGE_INTELLIGENCE_REQUESTS = 3


_DECLARED_SURFACE_BY_JSONL_SUFFIX: dict[str, str] = {
    "pr-events.jsonl": "pr_events",
    "merge-events.jsonl": "merge_events",
    "evidence-impact.jsonl": "evidence_impact",
    "cycle-state/incremental-plans.jsonl": "cycle_incremental_plans",
    "memory/beliefs.jsonl": "memory_beliefs",
    "memory/learning-events.jsonl": "memory_learning_events",
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


def observe_pr_event(
    *,
    payload: dict[str, Any],
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise GovernanceError("PR event payload must be a JSON object")
    event = str(payload.get("event") or "").strip()
    if event not in PR_EVENTS:
        raise GovernanceError(f"unknown PR event: {event}")
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "pr_number": payload.get("pr_number"),
        "event": event,
        "base_sha": payload.get("base_sha"),
        "head_sha": payload.get("head_sha"),
        "merge_commit_sha": payload.get("merge_commit_sha"),
        "changed_files": _string_list(payload.get("changed_files")),
        "author": payload.get("author"),
        "labels": _string_list(payload.get("labels")),
        "merged_at": payload.get("merged_at"),
        "source": payload.get("source", "operator_pr"),
        "proposal_id": payload.get("proposal_id"),
        "apply_ref": payload.get("apply_ref"),
        "validation_refs": _string_list(payload.get("validation_refs")),
    }
    root = ensure_tools_dir(base_dir)
    append_jsonl(root / "pr-events.jsonl", row)
    if event == "merged" or row.get("merge_commit_sha"):
        append_jsonl(root / "merge-events.jsonl", row)
    return row


def ingest_merged_pr_lifecycle(
    *,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Feed the LIVE merge signal into this module's merge ledger.

    ``observe_pr_event`` is an operator/webhook entry point and no production
    caller ever reached it, so ``merge-events.jsonl`` stayed empty and every
    reader below it (impact map, incremental plan, change intelligence) had
    nothing to read. The merges ARIA performs are recorded by
    ``auto_merge.record_pr_lifecycle`` in ``pr-lifecycle.jsonl`` — this is the
    producer that carries them across, keyed on (pr_number, head_sha) so a
    re-run ingests nothing twice.
    """
    root = ensure_tools_dir(base_dir)
    seen = {
        (row.get("pr_number"), row.get("head_sha"))
        for row in load_jsonl(root / "merge-events.jsonl")
    }
    lifecycle_path = root / "pr-lifecycle.jsonl"
    if not lifecycle_path.exists():
        return {"ingested": [], "already_known": 0}
    ingested: list[dict[str, Any]] = []
    already_known = 0
    for row in load_declared_jsonl(lifecycle_path, expected_surface="pr_lifecycle"):
        if row.get("event") != "merged":
            continue
        key = (row.get("pr_number"), row.get("head_sha"))
        if key in seen:
            already_known += 1
            continue
        seen.add(key)
        ingested.append(
            observe_pr_event(
                payload={
                    "event": "merged",
                    "pr_number": row.get("pr_number"),
                    "head_sha": row.get("head_sha"),
                    # Squash merges mint a new commit the lifecycle row does not
                    # carry; the merged head SHA is the anchor we can prove.
                    "merge_commit_sha": None,
                    "changed_files": _string_list(row.get("changed_files")),
                    "merged_at": row.get("recorded_at"),
                    "source": "pr_lifecycle",
                    "proposal_id": row.get("proposal_id"),
                },
                base_dir=root,
            )
        )
    return {"ingested": ingested, "already_known": already_known}


def change_intelligence_subject_ref(*, pr_number: Any, head_sha: Any) -> str:
    """The stable name of WHAT a change-intelligence request is about: one
    merged PR at one head SHA — not the cycle that happened to notice it."""
    return f"merged-pr:{pr_number}:{head_sha}"


def dispatch_change_intelligence(
    *,
    cycle_id: str | None = None,
    base_dir: str | Path | None = None,
    target_sha: str | None = None,
    max_requests: int = DEFAULT_MAX_CHANGE_INTELLIGENCE_REQUESTS,
) -> dict[str, Any]:
    """Mint ONE change-intelligence envelope per merged PR. Idempotent.

    Anchored to the merged head SHA rather than the workspace head: the
    question is what THAT merge invalidated, and evidence grading must resolve
    against the tree the agent is asked about.

    Newest merge first, and at most ``max_requests`` per run: the first run
    after this producer lands sees every merge ever recorded in
    ``pr-lifecycle.jsonl``, and an unbounded mint would turn a backlog into one
    night's LLM bill. The remainder is not lost — it is minted by later runs,
    oldest surviving last, which is also the order in which the answers still
    matter.
    """
    from .agent_invocations import create_agent_invocation_request, minted_subject_refs

    root = ensure_tools_dir(base_dir)
    # One ledger pass for the whole merge backlog: the merge list only grows,
    # so a per-merge lookup would re-verify the request chain once per merge
    # per cycle.
    already_asked = minted_subject_refs(
        role=CHANGE_INTELLIGENCE_ROLE,
        target_agent=CHANGE_INTELLIGENCE_AGENT,
        base_dir=root,
    )
    minted: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    for event in reversed(load_jsonl(root / "merge-events.jsonl")):
        pr_number = event.get("pr_number")
        head_sha = event.get("head_sha")
        if pr_number is None or not head_sha:
            skipped.append({"pr_number": pr_number, "reason": "merge_event_not_anchored"})
            continue
        subject = change_intelligence_subject_ref(pr_number=pr_number, head_sha=head_sha)
        if subject in already_asked:
            skipped.append({"pr_number": pr_number, "reason": "already_dispatched"})
            continue
        if len(minted) >= max_requests:
            skipped.append({"pr_number": pr_number, "reason": "mint_budget_exhausted"})
            continue
        already_asked.add(subject)
        changed_files = _string_list(event.get("changed_files"))
        prompt = (
            "Plan the revalidation impact of this merge. The kernel's glob "
            "match over changed paths is already recorded in "
            "evidence-impact.jsonl; your job is the coupling it cannot see.\n"
            f"pr_number: {pr_number}\n"
            f"head_sha: {head_sha}\n"
            f"changed_file_count: {len(changed_files)}\n"
            f"changed_files (first {_MAX_CHANGED_FILE_REFS}): "
            f"{', '.join(changed_files[:_MAX_CHANGED_FILE_REFS]) or '(none recorded)'}\n"
            "Return details.impact_map with beliefs_needs_revalidation, "
            "findings_needs_revalidation, fixtures_requires_rerun and "
            "confirmed_unchanged. Ground every entry in the merge commit, not "
            "in the PR description."
        )
        request = create_agent_invocation_request(
            target_agent=CHANGE_INTELLIGENCE_AGENT,
            role=CHANGE_INTELLIGENCE_ROLE,
            suggested_prompt=prompt,
            must_satisfy=[{
                "id": "impact-map",
                "criterion": (
                    "details.impact_map classifies every impacted belief, "
                    "finding and fixture with evidence from the merge commit"
                ),
            }],
            allowed_scope=["**"],
            evidence_refs=[subject, *changed_files[:_MAX_CHANGED_FILE_REFS]],
            cycle_id=cycle_id,
            target_sha=str(head_sha) if head_sha else target_sha,
            base_dir=root,
        )
        minted.append({"pr_number": pr_number, "request_id": request.get("request_id")})
    return {"schema_version": 1, "minted": minted, "skipped": skipped}


def plan_pr_impact(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    event = _latest_pr_or_merge_event(root)
    if event is None:
        row = {
            "schema_version": 1,
            "recorded_at": utc_now(),
            "cycle_id": cycle_id,
            "status": "no_pr_event",
            "changed_files": [],
            "impacted_beliefs": [],
            "carried_forward_beliefs": [],
            "impacted_findings": [],
            "impacted_adapters": [],
            "actions": [],
        }
        return append_jsonl(root / "evidence-impact.jsonl", row)
    changed_files = _string_list(event.get("changed_files"))
    beliefs = latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl"))
    impacted_beliefs = []
    carried_forward_beliefs = []
    for belief in beliefs:
        if belief.get("status") == "withdrawn":
            continue
        evidence_refs = _string_list(belief.get("evidence_refs"))
        matched = _matched_refs(evidence_refs, changed_files)
        item = {
            "belief_id": belief.get("belief_id"),
            "status_before": belief.get("status", "supported"),
            "evidence_refs": evidence_refs,
            "matched_refs": matched,
        }
        if matched:
            impacted_beliefs.append(item)
        else:
            carried_forward_beliefs.append(item)
    impacted_findings = _impacted_findings(root, changed_files)
    impacted_adapters = _impacted_adapters(root, changed_files)
    _mark_beliefs_for_revalidation(root, cycle_id, impacted_beliefs)
    _mark_findings_for_revalidation(root, impacted_findings)
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "status": "planned",
        "pr_event": {
            "pr_number": event.get("pr_number"),
            "event": event.get("event"),
            "base_sha": event.get("base_sha"),
            "head_sha": event.get("head_sha"),
            "merge_commit_sha": event.get("merge_commit_sha"),
        },
        "changed_files": changed_files,
        "impacted_beliefs": impacted_beliefs,
        "carried_forward_beliefs": carried_forward_beliefs,
        "impacted_findings": impacted_findings,
        "impacted_adapters": impacted_adapters,
        "actions": _impact_actions(impacted_beliefs, impacted_findings, impacted_adapters),
    }
    return append_jsonl(root / "evidence-impact.jsonl", row)


def plan_incremental_cycle(
    *,
    cycle_id: str,
    base_dir: str | Path | None = None,
) -> dict[str, Any]:
    root = ensure_tools_dir(base_dir)
    impacts = [row for row in load_jsonl(root / "evidence-impact.jsonl") if row.get("cycle_id") == cycle_id]
    impact = impacts[-1] if impacts else plan_pr_impact(cycle_id=cycle_id, base_dir=root)
    actions = list(impact.get("actions", []))
    if not actions:
        actions = ["carry_forward_confirmed_memory", "skip_unchanged_confirmed_false_positives"]
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "mode": "incremental",
        "changed_files": impact.get("changed_files", []),
        "impacted_beliefs_count": len(impact.get("impacted_beliefs", [])),
        "impacted_findings_count": len(impact.get("impacted_findings", [])),
        "impacted_adapters_count": len(impact.get("impacted_adapters", [])),
        "actions": actions,
    }
    return append_jsonl(root / "cycle-state" / "incremental-plans.jsonl", row)


def _latest_pr_or_merge_event(root: Path) -> dict[str, Any] | None:
    rows = load_jsonl(root / "merge-events.jsonl") + load_jsonl(root / "pr-events.jsonl")
    return rows[-1] if rows else None


def _mark_beliefs_for_revalidation(root: Path, cycle_id: str, impacted: list[dict[str, Any]]) -> None:
    if not impacted:
        return
    impacted_ids = {str(item.get("belief_id")) for item in impacted}
    for belief in latest_beliefs(load_jsonl(root / "memory" / "beliefs.jsonl")):
        belief_id = str(belief.get("belief_id") or "")
        if belief_id not in impacted_ids:
            continue
        row = dict(belief)
        row.update(
            {
                "recorded_at": utc_now(),
                "updated_at": utc_now(),
                "last_seen_cycle": cycle_id,
                "status": "needs_revalidation",
                "verification_status": "needs_revalidation",
                "needs_revalidation_cycles": int(row.get("needs_revalidation_cycles", 0)) + 1,
                "revalidation_reason": "PR or merge changed evidence reference",
            },
        )
        append_jsonl(root / "memory" / "beliefs.jsonl", row)
        append_jsonl(
            root / "memory" / "learning-events.jsonl",
            {
                "schema_version": 1,
                "recorded_at": utc_now(),
                "cycle_id": cycle_id,
                "event_type": "evidence_invalidated",
                "target_type": "belief",
                "target_id": belief_id,
                "repo_state_id": row.get("repo_state_id"),
                "base_commit_sha": row.get("base_commit_sha"),
                "evidence_hashes": _string_list(row.get("evidence_hashes")),
                "details": {"reason": "PR or merge changed evidence reference"},
            },
        )


def _mark_findings_for_revalidation(root: Path, impacted: list[dict[str, Any]]) -> None:
    if not impacted:
        return
    keys = {(item.get("run_id"), item.get("finding_id")) for item in impacted}
    rows = []
    for row in load_jsonl(findings_path(root)):
        if (row.get("run_id"), row.get("finding_id")) in keys and row.get("status") in ("open", "suppressed_false_positive"):
            row = dict(row)
            row["status"] = "needs_revalidation"
            row["updated_at"] = utc_now()
        rows.append(row)
    rewrite_jsonl(findings_path(root), rows)


def _impacted_findings(root: Path, changed_files: list[str]) -> list[dict[str, Any]]:
    impacted = []
    for row in load_jsonl(findings_path(root)):
        finding = row.get("finding") if isinstance(row.get("finding"), dict) else {}
        refs = _finding_refs(finding)
        matched = _matched_refs(refs, changed_files)
        if matched:
            impacted.append(
                {
                    "tool_id": row.get("tool_id"),
                    "run_id": row.get("run_id"),
                    "finding_id": row.get("finding_id"),
                    "finding_fingerprint": row.get("finding_fingerprint"),
                    "matched_refs": matched,
                },
            )
    return impacted


def _impacted_adapters(root: Path, changed_files: list[str]) -> list[dict[str, Any]]:
    impacted = []
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        fixture_set = str(tool.get("fixture_set") or "")
        patterns = [
            "aria-tools/registry.json",
            "aria-tools/fixtures/**",
            f"aria-tools/{fixture_set}/**",
            f"{fixture_set}/**",
        ]
        matched = [path for path in changed_files if any(_matches(path, pattern) for pattern in patterns)]
        if matched:
            impacted.append({"tool_id": tool_id, "matched_files": sorted(set(matched)), "impact": "fixture_or_manifest_changed"})
    return impacted


def _impact_actions(
    impacted_beliefs: list[dict[str, Any]],
    impacted_findings: list[dict[str, Any]],
    impacted_adapters: list[dict[str, Any]],
) -> list[str]:
    actions = []
    if impacted_beliefs or impacted_findings:
        actions.append("revalidate_impacted_evidence")
    if impacted_adapters:
        actions.append("rerun_impacted_adapter_fixtures")
        actions.append("invalidate_ai_precision_cache")
    if not actions:
        actions.append("carry_forward_confirmed_memory")
    return actions


def _finding_refs(finding: dict[str, Any]) -> list[str]:
    refs = []
    if isinstance(finding.get("path"), str):
        refs.append(finding["path"])
    evidence = finding.get("evidence")
    if isinstance(evidence, list):
        refs.extend(str(item.get("path")) for item in evidence if isinstance(item, dict) and isinstance(item.get("path"), str))
    return sorted(set(refs))


def _matched_refs(evidence_refs: list[str], changed_files: list[str]) -> list[str]:
    matched = []
    for ref in evidence_refs:
        for changed in changed_files:
            if changed == ref or _matches(changed, ref) or _matches(ref, changed):
                matched.append(ref)
                break
    return sorted(set(matched))


def _matches(path: str, pattern: str) -> bool:
    normalized_path = path.replace("\\", "/")
    normalized_pattern = pattern.replace("\\", "/")
    if fnmatch.fnmatch(normalized_path, normalized_pattern):
        return True
    if "/**/" in normalized_pattern:
        return fnmatch.fnmatch(normalized_path, normalized_pattern.replace("/**/", "/"))
    if normalized_pattern.endswith("/**"):
        return normalized_path.startswith(normalized_pattern[:-3])
    return False


def _string_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    return [str(item) for item in value if isinstance(item, str) and item.strip()]
