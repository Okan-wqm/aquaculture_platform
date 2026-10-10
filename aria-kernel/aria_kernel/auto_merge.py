from __future__ import annotations

import json
import subprocess
from copy import deepcopy
from pathlib import Path
from typing import Any, Protocol

from .canonical_path import matches_repo_glob, normalize_repo_relpath
from .github_writes import run_gh_write
from .implementation_safety import (
    CANONICAL_VALIDATION_COMMANDS,
    canonical_command_satisfied_by,
    is_gh_api_path_forbidden,
)
from .ledger import append_declared_jsonl, load_declared_jsonl
from .risk_policy import (
    HUMAN_MERGE_DECISION,
    HUMAN_MERGE_LABEL,
    STATUS_UNKNOWN_LANE,
    ChangeInput,
    RiskPolicyVerdict,
    change_entries,
    classify_path,
    classify_pr_change,
)
from .tool_registry import GovernanceError, ensure_tools_dir, utc_now


DEFAULT_POLICY: dict[str, Any] = {
    "schema_version": 1,
    "enabled": False,
    "base_branch": "main",
    "merge_method": "squash",
    "hard_forbidden_globs": [
        ".github/workflows/**",
        ".github/actions/**",
        "aria-kernel/aria_kernel/**",
        "infra/**",
        "docker/**",
        "docker-compose.yml",
        "docker/docker-compose.yml",
        "**/migrations/**",
        "**/*Migration*",
        "**/*Migration*/**",
        "**/.env*",
        "**/*secret*",
        "**/*secret*/**",
        "**/*credential*",
        "**/*credential*/**",
        "**/*private-key*",
        "**/*private-key*/**",
        "**/*pricing*",
        "**/*pricing*/**",
        "**/*billing*",
        "**/*billing*/**",
        "apps/billing-service/**",
    ],
    "runtime_forbidden_globs": [
        "apps/**/src/**",
        "web/**/src/**",
        "libs/**/src/**",
        "platform/libs/**/src/**",
        "sens-api-gateway/src/**",
    ],
    "config_forbidden_globs": [
        "package.json",
        "package-lock.json",
        "nx.json",
        "tsconfig*.json",
        "**/*.config.*",
        "**/project.json",
        "**/Dockerfile",
    ],
    "require_unresolved_conversations": True,
}

class GitHubAdapter(Protocol):
    def get_pr(self, number: int) -> dict[str, Any]:
        ...

    def get_latest_head_sha(self, number: int) -> str | None:
        ...

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        ...

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        ...

    def get_reviews(self, number: int) -> dict[str, Any]:
        ...

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        ...

    def get_pr_diff(self, number: int) -> str | None:
        """Plan 023 v3 §P-6 — required Protocol method.

        Live mode (GhCliGitHubAdapter) implements via `gh pr diff
        <number>`. Snapshot/test mode returns the diff fixture from
        the seeded payload. evaluate_auto_merge fails-closed on
        empty / whitespace / malformed diff content (P-6 fix), so an
        adapter implementation that returns None / empty surfaces as
        an explicit auto_merge_blocked reason rather than a silent
        path-class-only acceptance.
        """
        ...

    def get_open_issues(self, *, labels: list[str]) -> dict[str, Any]:
        """Open issues carrying every one of ``labels``.

        Returns ``{"readable": bool, "issues": [...]}``. `readable` is explicit
        rather than inferred from an empty list, because "no incidents" and "I
        could not ask" must not look alike to `watchdog_freeze`, which fails
        closed on the second.
        """
        ...

    def merge_pr(self, number: int, *, method: str, expected_head_sha: str) -> dict[str, Any]:
        """Merge, or enqueue, the PR at ``expected_head_sha``.

        ARIA-HIGH-221 — main requires a merge queue, so a successful call
        usually ENQUEUES the PR rather than merging it. The result says
        which, measured after the call: ``merged`` (the PR is merged at that
        head) or ``enqueued`` (it is in the merge queue, or armed to enter
        it, at that head). Neither true is an unconfirmed result, which the
        merge authority records as a failure, never as a merge.
        """
        ...

    def get_merge_state(self, number: int) -> dict[str, Any] | None:
        """ARIA-HIGH-221 — where the PR stands with respect to merging:
        ``{"state", "head_sha", "in_merge_queue", "auto_merge_enabled",
        "merge_commit_sha", "merge_state_status", "base_sha"}``, or ``None``
        when nothing was observed."""
        ...


def normalize_policy(policy: dict[str, Any] | None = None) -> dict[str, Any]:
    candidate = deepcopy(DEFAULT_POLICY)
    if policy:
        for key, value in policy.items():
            candidate[key] = value
    if candidate.get("merge_method") != "squash":
        raise GovernanceError("auto-merge policy supports only squash merge")
    if candidate.get("base_branch") != "main":
        raise GovernanceError("auto-merge policy supports only the main base branch")
    return candidate


def classify_changed_files(
    changed_files: ChangeInput,
    *,
    policy: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Path-class risk of a change, from each file's git status.

    ARIA-CRITICAL-215 — ``changed_files`` carries statuses when it is the git
    read (``ChangePaths``, ``(status, path)`` pairs); a platform file list
    carries none, and a path only a status could make low-risk is then
    ``status_unknown``, never low.
    """
    active_policy = normalize_policy(policy)
    entries = [
        (status, _changed_file_path(raw)) for status, raw in change_entries(changed_files) if raw
    ]
    entries = [(status, path) for status, path in entries if path]
    paths = [path for _status, path in entries]
    low_risk: list[str] = []
    forbidden: list[str] = []
    unknown: list[str] = []
    status_unknown: list[str] = []
    for status, path in entries:
        lane = classify_path(path, status=status)
        if _matches_any(path, active_policy["hard_forbidden_globs"]):
            forbidden.append(path)
        elif lane == "L1":
            # ARIA-HIGH-187: the ONE low-risk answer is the enterprise
            # policy's L1 lane (CODEOWNERS-aware); no private copy here.
            low_risk.append(path)
        elif lane == STATUS_UNKNOWN_LANE:
            status_unknown.append(path)
            unknown.append(path)
        elif _matches_any(path, active_policy["runtime_forbidden_globs"]):
            forbidden.append(path)
        elif _matches_any(path, active_policy["config_forbidden_globs"]):
            forbidden.append(path)
        else:
            unknown.append(path)

    buckets = sum(1 for bucket in (low_risk, forbidden, unknown) if bucket)
    if not paths:
        risk_class = "unknown"
    elif forbidden and buckets > 1:
        risk_class = "mixed"
    elif forbidden:
        risk_class = "forbidden"
    elif unknown and low_risk:
        risk_class = "mixed"
    elif unknown:
        risk_class = "unknown"
    else:
        risk_class = "low"
    enterprise_risk: dict[str, Any]
    try:
        from .risk_policy import classify_change

        verdict = classify_change([(status, path) if status else path for status, path in entries])
        enterprise_risk = _enterprise_risk(verdict)
    except Exception as exc:
        enterprise_risk = {
            "valid": False,
            "lane": "blocked",
            "policy_hash": None,
            "reason_codes": [f"risk_policy_projection_failed:{exc}"],
            "matched_lanes": [],
        }
    return {
        "schema_version": 1,
        "risk_class": risk_class,
        "eligible": risk_class == "low",
        "enterprise_risk": enterprise_risk,
        "changed_files": paths,
        "low_risk_files": low_risk,
        "forbidden_files": forbidden,
        "unknown_files": unknown,
        "status_unknown_files": status_unknown,
    }


def _enterprise_risk(verdict: RiskPolicyVerdict) -> dict[str, Any]:
    return {
        "valid": verdict.valid,
        "lane": verdict.lane,
        "policy_hash": verdict.policy_hash,
        "reason_codes": list(verdict.reason_codes),
        "matched_lanes": list(verdict.matched_lanes),
    }


def evaluate_auto_merge(
    *,
    pr: dict[str, Any],
    github: dict[str, Any],
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    dry_run: bool = True,
    diff_text: str | None = None,
    workspace_root: str | Path | None,
) -> dict[str, Any]:
    """Whether ``pr`` may auto-merge; records the decision.

    ARIA-CRITICAL-215 — path risk is the PR's change as the checkout at
    ``workspace_root`` holds it, read and classified by the one reader of a
    PR's lane (``risk_policy.classify_pr_change``) with every file's git
    status. There is no status-blind reading: a checkout without the PR's
    commits is refused by name (``risk_change_paths_unavailable``).
    """
    active_policy = normalize_policy(policy)
    reasons: list[str] = []
    pr_number = pr.get("number")
    base_branch = _first_string(pr, "base_branch", "baseRefName", "base")
    head_sha = _first_string(pr, "head_sha", "headRefOid", "head")
    # Plan 023 v3 §P-4 — strict latest_head_sha lookup. Pre-fix the
    # `or head_sha` fallback meant a failed lookup (network 5xx, gh
    # adapter bug, missing snapshot field) silently substituted the
    # PR's own head_sha. The follow-up equality check then always
    # passed because both values were the same — defeating the
    # force-push detection that latest_head_sha exists to provide.
    # Post-fix: empty / missing falls through to the
    # "latest PR head SHA unavailable" reason below; gate blocks.
    latest_head_sha = _first_string(github, "latest_head_sha")
    read = classify_pr_change(pr, workspace_root=workspace_root)
    risk = {
        **classify_changed_files(read.change if read.change is not None else [], policy=active_policy),
        # The PR's lane is the reader's verdict, which also carries the
        # platform-list cross-check and names an unreadable change.
        "enterprise_risk": _enterprise_risk(read.verdict),
    }

    # Plan 022 §H-2 — diff content scan. classify_changed_files only
    # looks at path globs; pre-fix a low-risk path (apps/**/*.ts) could
    # carry suppression patterns (`as any`, `// @ts-ignore`, `.skip`)
    # that auto-merge would silently approve. Now the diff is scanned
    # via suppression_scanner.scan_unified_diff_text and any hit
    # demotes the risk to 'unknown'.
    suppression_hits: list[dict[str, Any]] = []
    if diff_text is None and pr.get("diff_text"):
        diff_text = pr.get("diff_text")
    if diff_text is None:
        # Diff content REQUIRED for auto-merge. Fail-closed: caller
        # must supply diff (typically via gh pr diff <pr_number>) so
        # path-class + content-class AND-merge can run.
        reasons.append("diff_text missing — auto_merge_requires_diff_content")
    elif not diff_text.strip():
        # Plan 023 v3 §P-6 — empty / whitespace-only diff treated as a
        # missing diff. Pre-fix scan_unified_diff_text("") returned []
        # and the gate concluded "clean". Empty diff is a signal that
        # diff fetching broke; the gate fails closed.
        reasons.append(
            "auto_merge_requires_nonempty_unified_diff: diff_text was "
            "empty or whitespace-only; auto-merge cannot evaluate "
            "content-class without diff content"
        )
    elif "+++ b/" not in diff_text and "rename to " not in diff_text and "new file mode" not in diff_text:
        # Plan 023 v3 §P-6 — minimal unified-diff structural check.
        # A blob without any +++ b/<path> header / rename to / new file
        # mode line is not a unified diff; the suppression scanner's
        # parse_unified_diff() would silently produce zero file_changes
        # and return zero matches.
        reasons.append(
            "auto_merge_diff_unparseable_or_empty: diff_text does not "
            "contain a unified-diff file header (+++ b/<path>, "
            "rename to, or new file mode); auto-merge cannot trust "
            "the content-class result"
        )
    else:
        from .suppression_scanner import scan_unified_diff_text
        for match in scan_unified_diff_text(diff_text):
            suppression_hits.append({
                "category": match.category,
                "detector": match.detector,
                "file": match.file,
                "line": match.line,
                "text": match.text,
            })
        if suppression_hits:
            # Path-class + content-class AND merge: any suppression hit
            # demotes the eligibility regardless of path classification.
            risk = {**risk, "eligible": False,
                    "risk_class": "unknown",
                    "suppression_hits": suppression_hits}
            reasons.append(f"diff carries {len(suppression_hits)} suppression "
                           f"pattern(s); auto-merge blocked")

    if active_policy.get("enabled") is not True:
        reasons.append("policy disabled")
    if base_branch != active_policy["base_branch"]:
        reasons.append(f"base branch must be {active_policy['base_branch']}")
    if active_policy.get("merge_method") != "squash":
        reasons.append("merge method must be squash")
    if not head_sha:
        reasons.append("PR head SHA unavailable")
    if not latest_head_sha:
        reasons.append("latest PR head SHA unavailable")
    if head_sha and latest_head_sha and head_sha != latest_head_sha:
        reasons.append("PR head SHA changed since evaluation target was recorded")
    if not risk["eligible"]:
        reasons.append(f"diff risk is {risk['risk_class']}")
    enterprise_risk = risk.get("enterprise_risk")
    if not isinstance(enterprise_risk, dict) or enterprise_risk.get("valid") is not True:
        codes = enterprise_risk.get("reason_codes") if isinstance(enterprise_risk, dict) else None
        reasons.append("enterprise risk policy rejected diff: " + ", ".join(str(code) for code in codes or []))
    elif enterprise_risk.get("lane") != "L1":
        reasons.append(f"enterprise risk lane {enterprise_risk.get('lane')} is not auto-merge eligible")

    required = _required_checks(github)
    if not required["readable"]:
        # Plan 023 v3.1 §P-2-followup — surface the specific
        # lookup_error code (branch_protection_disabled_on_base /
        # branch_protection_lookup_permission_denied /
        # branch_protection_lookup_failed / etc.) so operator audit
        # sees WHY the gate blocked, not just "unreadable".
        lookup_error = required.get("lookup_error")
        if lookup_error:
            reasons.append(f"branch protection lookup failed: {lookup_error}")
        else:
            reasons.append("branch protection required checks unreadable")
    elif not required["checks"]:
        reasons.append("branch protection has no required checks")
    check_result = _required_checks_result(github, required["checks"], head_sha)
    if not check_result["readable"]:
        reasons.append("check runs unreadable")
    elif check_result["missing"]:
        reasons.append("required checks missing: " + ", ".join(check_result["missing"]))
    elif check_result["not_success"]:
        reasons.append("required checks not successful: " + ", ".join(check_result["not_success"]))

    # 2026-08-18 operator directive (ORPHAN-717) — the FULL battery, not
    # just branch protection's short required list. Main requires only two
    # checks; lint/format/typecheck run as non-required check runs, and the
    # required-only gate above merged a PR whose optional lint was RED
    # (operator-measured on the Y-union train). Every check run on the head
    # SHA must be completed and non-red before auto-merge — this is what
    # makes CI's whole battery (prettier, lint, build, invariants)
    # load-bearing for an ARIA merge instead of decorative.
    all_runs = _all_check_runs_result(github, head_sha)
    if not all_runs["readable"]:
        reasons.append("full check-run battery unreadable")
    elif not all_runs["total"]:
        reasons.append("no check runs found for head SHA — full battery cannot be proven green")
    else:
        if all_runs["pending"]:
            reasons.append(
                "check runs still pending: " + ", ".join(all_runs["pending"])
            )
        if all_runs["red"]:
            reasons.append(
                "check runs red (including non-required): "
                + ", ".join(all_runs["red"])
            )

    review_result = _review_result(pr, github)
    if not review_result["readable"]:
        reasons.append("review state unreadable")
    elif review_result["requested_changes_count"] > 0:
        reasons.append("requested changes present")

    conversation_result = _conversation_result(github)
    if active_policy.get("require_unresolved_conversations", True):
        if not conversation_result["readable"]:
            reasons.append("unresolved conversation state unreadable")
        elif conversation_result["unresolved_count"] > 0:
            reasons.append("unresolved conversations present")

    eligible = not reasons
    decision = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "pr_number": pr_number,
        "base_branch": base_branch,
        "head_sha": head_sha,
        "latest_head_sha": latest_head_sha,
        "dry_run": dry_run,
        "decision": "eligible" if eligible else "blocked",
        "eligible": eligible,
        "reasons": reasons,
        "risk": risk,
        "required_checks": required,
        "check_result": check_result,
        "all_check_runs": all_runs,
        "review_result": review_result,
        "conversation_result": conversation_result,
        "policy": {
            "enabled": active_policy["enabled"],
            "base_branch": active_policy["base_branch"],
            "merge_method": active_policy["merge_method"],
        },
    }
    _append_decision(base_dir, decision)
    return decision


def change_for_pr(
    pr_number: int,
    *,
    base_dir: str | Path | None = None,
) -> str | None:
    """Plan 026R §D.3 — reverse lookup: find the change_id bound to a PR.

    Scans ``pr-lifecycle.jsonl`` for the latest row matching
    ``pr_number`` that carries a non-null ``change_id``. Returns
    the change_id or ``None`` when no binding exists (legacy
    pre-§D.3 PRs without the anchor).

    Consumed by ``merge_if_green`` to assemble the §D.4 triple-gate
    inputs (change_committed + change_validated + validation_runs)
    via change_id lookup.
    """
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl",
        expected_surface="pr_lifecycle",
    )
    latest_change_id: str | None = None
    for row in rows:
        if row.get("pr_number") == pr_number and row.get("change_id"):
            latest_change_id = str(row["change_id"])
    return latest_change_id


def human_merge_decision(
    pr_number: int,
    *,
    base_dir: str | Path | None = None,
    live_pr: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """The merge lane's named decision for a PR marked for a person's merge, or None.

    ARIA-HIGH-211 (operator decision 2026-09-26) — a PR whose change is not
    the merge lane's is opened with ``HUMAN_MERGE_LABEL`` and its
    ``opened`` row records ``merge_route.human_merge``. Either marks it: the
    row is ARIA's own record (readable without GitHub), the label is what a
    person sees and may add to take a PR over. Such a PR is not a merge-lane
    candidate; the lane names it and moves on instead of evaluating it every
    run. Removing the label does not make it mergeable: the merge
    authority's risk decision still classifies the change from git.
    """
    marked = False
    if live_pr is not None:
        marked = HUMAN_MERGE_LABEL in _label_names(live_pr)
    if not marked:
        opened = [
            row
            for row in load_declared_jsonl(
                ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl", expected_surface="pr_lifecycle",
            )
            if row.get("pr_number") == pr_number and row.get("event") == "opened"
        ]
        route = opened[-1].get("merge_route") if opened else None
        marked = isinstance(route, dict) and route.get("human_merge") is True
    if not marked:
        return None
    return {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "pr_number": pr_number,
        "decision": "skipped",
        "eligible": False,
        "stage": HUMAN_MERGE_DECISION,
        "reasons": [HUMAN_MERGE_DECISION],
    }


def _label_names(pr: dict[str, Any]) -> set[str]:
    labels = pr.get("labels")
    if not isinstance(labels, list):
        return set()
    return {
        str(label.get("name")) if isinstance(label, dict) else str(label)
        for label in labels
        if isinstance(label, (dict, str))
    }


# ARIA-HIGH-390 — the terminal events of an ARIA PR have ONE writer
# (`merge_record`); this token is what it alone passes, and
# tests/invariants/test_merged_single_writer.py fails the build on any other
# module naming it.
_MERGED_ROW_OWNER = object()
_OWNED_LIFECYCLE_EVENTS = frozenset({"merged", "closed_unmerged", "merge_unproven", "merge_lineage_unverified",
                                     "merge_lineage_attested"})


def record_pr_lifecycle(
    pr: dict[str, Any],
    *,
    event: str = "observed",
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    assignment_id: str | None = None,
    _owner: object = None,
) -> dict[str, Any]:
    """Append a row to pr-lifecycle.jsonl describing a PR event.

    Plan 025 §E — ``assignment_id`` is the optional bridge between a
    worker dispatch (dispatch/requests.jsonl) and the resulting PR.
    When the autonomous worker scheduler verifies a worker run and
    routes to merge_if_green, it needs to find the PR number for the
    verified assignment; the bridge lives on this row's
    ``assignment_id`` field. Falls back to ``pr["assignment_id"]``
    when the kwarg is omitted but the source payload carries it.
    Legacy rows without assignment_id return None from the helper
    worker_dispatch.pr_for_assignment, which fail-closes the merge
    path (verified_pending_merge).
    """
    if event in _OWNED_LIFECYCLE_EVENTS and _owner is not _MERGED_ROW_OWNER:
        raise GovernanceError(
            f"pr_lifecycle_{event}_has_one_writer: merge_record.record_merge writes it (ARIA-HIGH-390)"
        )
    row = {
        "schema_version": 1,
        "recorded_at": utc_now(),
        "cycle_id": cycle_id,
        "event": event,
        "pr_number": pr.get("number"),
        "base_branch": _first_string(pr, "base_branch", "baseRefName", "base"),
        "head_sha": _first_string(pr, "head_sha", "headRefOid", "head"),
        "task_id": pr.get("task_id"),
        "proposal_id": pr.get("proposal_id"),
        "assignment_id": assignment_id or pr.get("assignment_id"),
        # Plan 026R §D.3 — change_id anchor for the §D.4 triple-gate.
        # ``change_for_pr`` (below) reverse-looks-up the change_id by
        # pr_number; the auto-merge path then fetches change_committed
        # + change_validated + validation_runs and asserts the triple.
        "change_id": pr.get("change_id"),
        "changed_files": [_changed_file_path(item) for item in pr.get("changed_files", pr.get("files", []))],
    }
    # ARIA-HIGH-211 — the opener's merge route (merge lane or a person's
    # merge) is recorded on the row that names the PR; other events carry none.
    if isinstance(pr.get("merge_route"), dict):
        row["merge_route"] = dict(pr["merge_route"])
    if base_dir is None:
        return row
    return append_declared_jsonl(
        ensure_tools_dir(base_dir) / "pr-lifecycle.jsonl",
        row,
        expected_surface="pr_lifecycle",
    )


# ARIA-HIGH-104 (2) — the hygiene battery IS the canonical validation suite.
#
# This table used to name three hand-picked dimensions (format / typecheck /
# test) with substring needles, one of which (`format:check`) no other
# contract named: the plan contract admitted the canonical suite, staging
# ran it as baseline, the implementer was told to run it, the pre-PR-open
# perimeter required it — and then the merge gate demanded a fourth command
# that none of them had mentioned, so a change that did exactly what every
# contract said could never merge. The suite is one tuple now
# (`implementation_safety.CANONICAL_VALIDATION_COMMANDS`, which grew
# `npm run format:check`), and this gate reads it: one dimension per
# canonical command, keyed by the command itself, matched by the same
# whole-entry rule the perimeter uses (`canonical_command_satisfied_by`).
# Derived, not retyped, so the two cannot disagree again — pinned by
# tests/test_validation_suite_ssot.py.
_HYGIENE_DIMENSIONS: tuple[str, ...] = CANONICAL_VALIDATION_COMMANDS


def _hygiene_battery_result(runs: list[dict[str, Any]]) -> dict[str, Any]:
    """Which canonical commands have a verified exit-0 run, and which do not."""
    satisfied: dict[str, str] = {}
    for run in runs:
        if not isinstance(run, dict) or run.get("status") != "ok":
            continue
        cmd = str(run.get("cmd") or "")
        for dimension in _HYGIENE_DIMENSIONS:
            if dimension not in satisfied and canonical_command_satisfied_by(cmd, dimension):
                satisfied[dimension] = str(run.get("validation_run_id") or "")
    return {
        "satisfied": satisfied,
        "missing": [d for d in _HYGIENE_DIMENSIONS if d not in satisfied],
    }


def _evaluate_triple_gate(
    *,
    pr_number: int,
    head_sha: str,
    base_dir: str | Path | None,
    workspace_root: str | Path | None = None,
    live_base_sha: str | None = None,
) -> dict[str, Any]:
    """Plan 026R §D.4 — auto-merge triple-gate evaluator.

    Three independent assertions:

    1. ``head_sha == change_committed.commit_sha`` — the PR's HEAD
       SHA matches the commit_sha recorded in the change_ledger
       committed row for the change_id bound to the PR.
    2. ``change_validated`` row exists for the change_id — the
       validation matrix recorded a passing validated event.
    3. Every ``validation_runs`` row for the change_id verifies —
       log_hash content-addressed binding holds (no tamper).

    Returns ``{"passed": bool, "reasons": [...], "change_id": str | None}``.
    On any assertion failure the merge MUST block; the caller appends
    a structured ``decision`` row to ``auto-merge-decisions.jsonl``.
    """
    reasons: list[str] = []
    change_id = change_for_pr(pr_number, base_dir=base_dir)
    if not change_id:
        return {
            "passed": False,
            "change_id": None,
            "reasons": ["triple_gate_missing_change_id_binding"],
        }
    # Gate 1: head_sha == change.commit_sha
    from .change_ledger import _find_committed, _find_validated_for_change
    tools_root = ensure_tools_dir(base_dir)
    committed = _find_committed(tools_root, change_id)
    if committed is None:
        reasons.append(
            f"triple_gate_change_committed_missing: change_id={change_id!r}"
        )
    elif committed.get("commit_sha") != head_sha:
        # ARIA-HIGH-374 — under strict protection an ARIA PR is mergeable
        # only after main was merged into it, so its head is the delivered
        # commit plus ARIA's own recorded, pure branch updates — or it is
        # refused, as before, naming why (`branch_update_lineage`, the one
        # verifier all three self-merge gates share).
        from .branch_update_lineage import BranchUpdateLineageRefused, verify_branch_update_lineage

        try:
            if workspace_root is None or not live_base_sha:
                raise BranchUpdateLineageRefused("workspace_or_live_base_unavailable")
            verify_branch_update_lineage(
                workspace=workspace_root, base_dir=base_dir, pr_number=pr_number, head_sha=head_sha,
                delivered_sha=str(committed.get("commit_sha") or ""), live_base_sha=live_base_sha,
            )
        except BranchUpdateLineageRefused as exc:
            reasons.append(
                f"triple_gate_head_sha_commit_sha_mismatch: "
                f"head={head_sha!r} change.commit={committed.get('commit_sha')!r} {exc.reason}"
            )
    # Gate 2: change_validated row exists
    validated = _find_validated_for_change(tools_root, change_id)
    if validated is None:
        reasons.append(
            f"triple_gate_change_validated_missing: change_id={change_id!r}"
        )
    # Gate 3: validation_runs verified
    from .validation_runs_ledger import (
        list_validation_runs_for_change,
        verify_validation_run,
    )
    runs = list_validation_runs_for_change(change_id, base_dir=base_dir)
    if not runs:
        reasons.append(
            f"triple_gate_validation_runs_missing: change_id={change_id!r}"
        )
    for run in runs:
        run_id = str(run.get("validation_run_id") or "")
        try:
            verify_validation_run(run_id, base_dir=base_dir)
        except Exception as exc:
            reasons.append(
                f"triple_gate_validation_run_unverified: "
                f"{run_id}: {exc}"
            )
    # Gate 5 (ORPHAN-721) — implementation completeness, defense in depth.
    # The writer refuses undeclared shortfalls at emit time; this re-check
    # covers rows written before the contract (or by a bypassed writer):
    # a committed row whose uncovered_intended files lack dispositions is
    # not a complete implementation and must not merge as one.
    if committed is not None:
        legacy_uncovered = committed.get("uncovered_intended")
        if legacy_uncovered is None:
            planned_files = set()
            from .change_ledger import _find_planned
            planned_row = _find_planned(tools_root, change_id)
            if planned_row is not None:
                planned_files = set(planned_row.get("intended_affected_files") or [])
            legacy_uncovered = sorted(
                planned_files - set(committed.get("actual_affected_files") or [])
            )
        declared = committed.get("uncovered_intended_dispositions") or {}
        undeclared = [
            f for f in legacy_uncovered if not str(declared.get(f, "")).strip()
        ]
        if undeclared:
            reasons.append(
                "triple_gate_implementation_incomplete: intended files "
                f"untouched with no declared disposition: {undeclared}"
            )

    # Gate 4 (2026-08-18 operator directive, ORPHAN-717) — universal
    # hygiene battery. The risk-type matrix proves the DOMAIN tests ran;
    # nothing proved the repo's own hygiene commands did. CI cannot carry
    # this alone: ~16 projects are unit-test-quarantined on CI (the SSoT is
    # scripts/ci/affected-target-policy.json), so a CI-green PR does not
    # prove local tests pass. Every autonomous merge must therefore carry
    # verified exit-0 validation_runs for format, typecheck and tests.
    hygiene = _hygiene_battery_result(runs)
    for dimension in hygiene["missing"]:
        reasons.append(f"triple_gate_hygiene_run_missing:{dimension}")
    return {
        "passed": not reasons,
        "change_id": change_id,
        "reasons": reasons,
        "hygiene": hygiene,
    }


def _merge_if_green_with_executor(
    *,
    adapter: GitHubAdapter,
    pr_number: int,
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    dry_run: bool = True,
    diff_text: str | None = None,
    workspace_root: str | Path | None,
) -> dict[str, Any]:
    if not dry_run:
        raise GovernanceError(
            "direct_real_merge_forbidden: call merge_authority.merge_pr_if_ready() "
            "for dry_run=False"
        )
    pr = adapter.get_pr(pr_number)
    record_pr_lifecycle(pr, event="observed", base_dir=base_dir, cycle_id=cycle_id)
    github = collect_github_snapshot(adapter, pr)
    # Plan 022 §H-2 — auto-merge content scan requires diff_text. If
    # caller didn't pass it, fall back to pr.diff_text (some adapters
    # surface it directly), then to the adapter if it exposes a
    # get_pr_diff() optional method. Otherwise pass None and let
    # evaluate_auto_merge fail-closed.
    if diff_text is None:
        diff_text = pr.get("diff_text")
        if diff_text is None and hasattr(adapter, "get_pr_diff"):
            try:
                diff_text = adapter.get_pr_diff(pr_number)  # type: ignore[attr-defined]
            except Exception:
                diff_text = None
    decision = evaluate_auto_merge(
        pr=pr,
        github=github,
        policy=policy,
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=dry_run,
        diff_text=diff_text,
        workspace_root=workspace_root,
    )
    return decision


def merge_if_green(
    *,
    adapter: GitHubAdapter,
    pr_number: int,
    policy: dict[str, Any] | None = None,
    base_dir: str | Path | None = None,
    cycle_id: str | None = None,
    dry_run: bool = True,
    diff_text: str | None = None,
    workspace_root: str | Path | None,
) -> dict[str, Any]:
    """Evaluation only (``dry_run``); ``workspace_root`` is the checkout the
    PR's change is read from (``evaluate_auto_merge``)."""
    return _merge_if_green_with_executor(
        adapter=adapter,
        pr_number=pr_number,
        policy=policy,
        base_dir=base_dir,
        cycle_id=cycle_id,
        dry_run=dry_run,
        diff_text=diff_text,
        workspace_root=workspace_root,
    )


def collect_github_snapshot(adapter: GitHubAdapter, pr: dict[str, Any]) -> dict[str, Any]:
    pr_number = int(pr["number"])
    base_branch = _first_string(pr, "base_branch", "baseRefName", "base")
    head_sha = _first_string(pr, "head_sha", "headRefOid", "head")
    snapshot: dict[str, Any] = {}
    snapshot["latest_head_sha"] = _safe_call(lambda: adapter.get_latest_head_sha(pr_number), default=None)
    snapshot["branch_protection"] = _safe_call(
        lambda: adapter.get_required_checks(str(base_branch)),
        default={"readable": False, "required_checks": []},
    )
    snapshot["checks"] = _safe_call(
        lambda: adapter.get_checks(str(head_sha)),
        default={"readable": False, "runs": []},
    )
    snapshot["reviews"] = _safe_call(
        lambda: adapter.get_reviews(pr_number),
        default={"readable": False, "items": []},
    )
    snapshot["conversations"] = _safe_call(
        lambda: adapter.get_unresolved_conversation_count(pr_number),
        default={"readable": False, "unresolved_count": None},
    )
    return snapshot


def merge_outcome(
    merge_state: dict[str, Any] | None,
    *,
    expected_head_sha: str,
    method: str,
) -> dict[str, Any]:
    """ARIA-HIGH-221 — classify a measured merge state after a merge call.

    ``merged``: the PR is merged and its head is the head the call named.
    ``enqueued``: it is open at that head and in the merge queue, or armed
    to enter it. Anything else — no observation, another head, a closed PR —
    is neither, and the merge authority records it as unconfirmed.
    """
    if merge_state is None:
        return {
            "merged": False, "enqueued": False, "method": method,
            "expected_head_sha": expected_head_sha, "observed": None,
        }
    at_head = merge_state.get("head_sha") == expected_head_sha
    pr_state = str(merge_state.get("state") or "")
    return {
        "merged": at_head and pr_state == "MERGED",
        "enqueued": at_head and pr_state == "OPEN" and (
            merge_state.get("in_merge_queue") is True or merge_state.get("auto_merge_enabled") is True
        ),
        "method": method,
        "expected_head_sha": expected_head_sha,
        "observed": dict(merge_state),
    }


def _rollup_state(commits: Any) -> str | None:
    """The head commit's combined check state (``SUCCESS``/``FAILURE``/``PENDING``…), or None."""
    nodes = commits.get("nodes") if isinstance(commits, dict) else None
    commit = (nodes[-1] or {}).get("commit") if isinstance(nodes, list) and nodes else None
    rollup = commit.get("statusCheckRollup") if isinstance(commit, dict) else None
    state = rollup.get("state") if isinstance(rollup, dict) else None
    return str(state).upper() if state else None


def _merge_commit_oid(merge_commit: Any) -> str | None:
    """``mergeCommit`` is ``null`` until the PR merges."""
    return merge_commit.get("oid") if isinstance(merge_commit, dict) else None


class SnapshotGitHubAdapter:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload
        self.merge_calls: list[dict[str, Any]] = []

    def get_pr(self, number: int) -> dict[str, Any]:
        pr = self.payload.get("pr", {})
        if pr.get("number") != number:
            raise GovernanceError(f"snapshot PR number does not match: {number}")
        return deepcopy(pr)

    def get_latest_head_sha(self, number: int) -> str | None:
        # Plan 024 v3 §B-6 — strict snapshot resolution. Pre-fix the
        # `or pr.head_sha` fallback masked missing fixture data: a
        # snapshot test that forgot to seed github.latest_head_sha
        # silently fell back to the PR's pre-merge head_sha and
        # auto_merge believed nothing had drifted. Plan 023 §P-4
        # closed the same fallback in evaluate_auto_merge but the
        # snapshot adapter copy persisted. Strict semantics: None
        # signals lookup failure; evaluate_auto_merge then blocks on
        # latest_head_sha_lookup_failed.
        _ = number
        return self.payload.get("github", {}).get("latest_head_sha")

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        _ = base_branch
        return deepcopy(self.payload.get("github", {}).get("branch_protection", {}))

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        _ = head_sha
        return deepcopy(self.payload.get("github", {}).get("checks", {}))

    def get_reviews(self, number: int) -> dict[str, Any]:
        _ = number
        return deepcopy(self.payload.get("github", {}).get("reviews", {"readable": True, "items": []}))

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        _ = number
        return deepcopy(
            self.payload.get("github", {}).get("conversations", {"readable": True, "unresolved_count": 0}),
        )

    def get_open_issues(self, *, labels: list[str]) -> dict[str, Any]:
        _ = labels
        return deepcopy(
            self.payload.get("github", {}).get("open_issues", {"readable": True, "issues": []}),
        )

    def list_open_pull_request_heads(self) -> dict[int, str]:
        pr = self.payload.get("pr", {})
        state = str(pr.get("state") or "").upper()
        head = pr.get("head_sha") or pr.get("headRefOid")
        if state != "OPEN" or not isinstance(pr.get("number"), int) or not isinstance(head, str):
            return {}
        return {pr["number"]: head}

    def get_pr_diff(self, number: int) -> str | None:
        """Plan 023 v3 §P-6 — read pre-seeded diff from the snapshot
        payload. Returns None when the fixture didn't supply a diff so
        evaluate_auto_merge's empty-diff fail-closed gate fires."""
        _ = number
        diff = self.payload.get("github", {}).get("pr_diff")
        if not isinstance(diff, str) or not diff.strip():
            return None
        return diff

    def merge_pr(self, number: int, *, method: str, expected_head_sha: str) -> dict[str, Any]:
        call = {"number": number, "method": method, "expected_head_sha": expected_head_sha}
        self.merge_calls.append(call)
        return {"merged": True, **call}

    def get_merge_state(self, number: int) -> dict[str, Any] | None:
        """The seeded ``github.merge_state``, or the PR's own state."""
        seeded = self.payload.get("github", {}).get("merge_state")
        if isinstance(seeded, dict):
            return deepcopy(seeded)
        pr = self.get_pr(number)
        return {
            "state": str(pr.get("state") or "").upper(),
            "head_sha": pr.get("head_sha") or pr.get("headRefOid"),
            "in_merge_queue": False,
            "auto_merge_enabled": False,
            "merge_commit_sha": pr.get("merge_commit_sha"),
            "merge_state_status": pr.get("mergeStateStatus") or pr.get("merge_state_status"),
            "base_sha": pr.get("base_sha") or pr.get("baseRefOid"),
            "head_ref": pr.get("head_ref") or pr.get("headRefName"),
            "base_ref": pr.get("base_branch") or pr.get("baseRefName"),
            "checks_state": pr.get("checks_state"),
        }


class GhCliGitHubAdapter:
    def __init__(self, *, cwd: str | Path = ".") -> None:
        self.cwd = Path(cwd)
        self._merge_authority_token: str | None = None
        repo = self._gh_json(["repo", "view", "--json", "owner,name"])
        owner = repo.get("owner", {})
        self.owner = owner.get("login") if isinstance(owner, dict) else None
        self.repo = repo.get("name")
        if not self.owner or not self.repo:
            raise GovernanceError("unable to determine GitHub repository owner/name")

    def arm_merge_authority(self, token: str) -> None:
        if not isinstance(token, str) or not token.strip():
            raise GovernanceError("merge_authority_token_required")
        self._merge_authority_token = token

    def clear_merge_authority(self, token: str) -> None:
        if self._merge_authority_token == token:
            self._merge_authority_token = None

    def get_open_issues(self, *, labels: list[str]) -> dict[str, Any]:
        """Open issues carrying every label, via `gh issue list`."""
        args = ["issue", "list", "--state", "open", "--limit", "50",
                "--json", "number,title,labels"]
        for label in labels:
            args.extend(["--label", label])
        try:
            payload = self._gh_json(args)
        except Exception as exc:  # an unreadable alarm is not an absent alarm
            return {"readable": False, "reason": f"{exc.__class__.__name__}: {exc}", "issues": []}
        if not isinstance(payload, list):
            return {"readable": False, "reason": "gh_issue_list_not_a_list", "issues": []}
        return {
            "readable": True,
            "issues": [
                {"number": row.get("number"), "title": row.get("title")}
                for row in payload
                if isinstance(row, dict)
            ],
        }

    def get_pr(self, number: int) -> dict[str, Any]:
        payload = self._gh_json(
            [
                "pr",
                "view",
                str(number),
                "--json",
                "number,state,baseRefName,baseRefOid,headRefName,headRefOid,body,url,files,changedFiles,labels,reviews,reviewDecision,mergeCommit",
            ],
        )
        return {
            "number": payload.get("number"),
            # ARIA-MEDIUM-226 — OPEN / CLOSED / MERGED: the merge authority
            # skips a PR that is no longer open before any gate writes a row.
            "state": payload.get("state"),
            "repository": f"{self.owner}/{self.repo}",
            "repo": f"{self.owner}/{self.repo}",
            "target_ref": payload.get("baseRefName"),
            "base_branch": payload.get("baseRefName"),
            "baseRefName": payload.get("baseRefName"),
            "base_sha": payload.get("baseRefOid"),
            "baseRefOid": payload.get("baseRefOid"),
            "head_ref": payload.get("headRefName"),
            "headRefName": payload.get("headRefName"),
            "head_sha": payload.get("headRefOid"),
            "headRefOid": payload.get("headRefOid"),
            "body": payload.get("body"),
            "url": payload.get("url"),
            "changed_files": payload.get("files", []),
            # ARIA-CRITICAL-214 — `files` is capped at 100 entries and names
            # a rename by its target only; `changedFiles` is the uncapped
            # count the risk decision cross-checks the git change against.
            "changed_files_count": payload.get("changedFiles"),
            "labels": payload.get("labels", []),
            "reviews": payload.get("reviews", []),
            "review_decision": payload.get("reviewDecision"),
            "merge_commit_sha": _merge_commit_oid(payload.get("mergeCommit")),
        }

    def get_latest_head_sha(self, number: int) -> str | None:
        return self.get_pr(number).get("head_sha")

    _MERGE_STATE_QUERY = """
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          state
          headRefOid
          headRefName
          baseRefOid
          baseRefName
          mergeStateStatus
          commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          isInMergeQueue
          autoMergeRequest { enabledAt }
          mergeCommit { oid }
        }
      }
    }
    """

    def get_merge_state(self, number: int) -> dict[str, Any] | None:
        """ARIA-HIGH-221 — the PR's merge state, read through GraphQL (the
        merge-queue fields have no REST or ``gh pr view`` equivalent)."""
        payload = self._gh_json([
            "api", "graphql",
            "-f", f"query={self._MERGE_STATE_QUERY}",
            "-F", f"owner={self.owner}",
            "-F", f"repo={self.repo}",
            "-F", f"number={number}",
        ])
        data = payload.get("data")
        repository = data.get("repository") if isinstance(data, dict) else None
        pull = repository.get("pullRequest") if isinstance(repository, dict) else None
        if not isinstance(pull, dict):
            raise GovernanceError(f"merge_state_unreadable:{number}")
        return {
            "state": str(pull.get("state") or "").upper(),
            "head_sha": pull.get("headRefOid"),
            "in_merge_queue": pull.get("isInMergeQueue") is True,
            "auto_merge_enabled": isinstance(pull.get("autoMergeRequest"), dict),
            "merge_commit_sha": _merge_commit_oid(pull.get("mergeCommit")),
            # ARIA-HIGH-374 — GitHub's own mergeability verdict and the base
            # it is judged against (`merge_lane_merge_state`).
            "merge_state_status": str(pull.get("mergeStateStatus") or "").upper() or None,
            "base_sha": pull.get("baseRefOid"),
            "head_ref": pull.get("headRefName"),
            "base_ref": pull.get("baseRefName"),
            "checks_state": _rollup_state(pull.get("commits")),
        }

    def get_required_checks(self, base_branch: str) -> dict[str, Any]:
        payload = self._gh_api_json(
            [
                f"repos/{self.owner}/{self.repo}/branches/{base_branch}/protection/required_status_checks",
            ],
        )
        checks = payload.get("contexts", [])
        checks.extend(item.get("context") for item in payload.get("checks", []) if isinstance(item, dict))
        return {"readable": True, "required_checks": sorted({str(check) for check in checks if check})}

    def get_checks(self, head_sha: str) -> dict[str, Any]:
        """Every check run and commit status on ``head_sha``, or unreadable.

        ARIA-MEDIUM-226 — both endpoints page (30 per page by default), so
        the first page alone let a head with more runs than one page look
        green on the ones it happened to return. Each listing is read at
        ``per_page=100`` to the end and must add up to the ``total_count``
        GitHub reports; a short or uncounted listing is unreadable, which
        the gate refuses, never a partial list it would judge.
        """
        base = f"repos/{self.owner}/{self.repo}/commits/{head_sha}"
        runs, runs_gap = self._listed_to_total(f"{base}/check-runs", "check_runs")
        statuses, statuses_gap = self._listed_to_total(f"{base}/status", "statuses")
        gaps = [gap for gap in (runs_gap, statuses_gap) if gap]
        if gaps:
            return {"readable": False, "runs": [], "reason": ";".join(gaps)}
        return {"readable": True, "runs": [*runs, *statuses]}

    def _listed_to_total(self, path: str, key: str) -> tuple[list[dict[str, Any]], str | None]:
        items: list[dict[str, Any]] = []
        page = 1
        while True:
            payload = self._gh_api_json([f"{path}?per_page=100&page={page}"])
            total = payload.get("total_count")
            batch = payload.get(key)
            if not isinstance(total, int) or isinstance(total, bool) or not isinstance(batch, list):
                return [], f"{key}_total_count_absent"
            items.extend(item for item in batch if isinstance(item, dict))
            if len(items) >= total or not batch:
                break
            page += 1
        if len(items) != total:
            return [], f"{key}_incomplete:{len(items)}/{total}"
        return items, None

    def get_reviews(self, number: int) -> dict[str, Any]:
        return {"readable": True, "items": self.get_pr(number).get("reviews", [])}

    def get_unresolved_conversation_count(self, number: int) -> dict[str, Any]:
        query = """
        query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
          repository(owner: $owner, name: $repo) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $cursor) {
                pageInfo { hasNextPage endCursor }
                nodes { isResolved }
              }
            }
          }
        }
        """
        unresolved = 0
        cursor: str | None = None
        while True:
            args = [
                "api",
                "graphql",
                "-f",
                f"query={query}",
                "-F",
                f"owner={self.owner}",
                "-F",
                f"repo={self.repo}",
                "-F",
                f"number={number}",
            ]
            if cursor:
                args.extend(["-F", f"cursor={cursor}"])
            payload = self._gh_json(args)
            threads = (
                payload.get("data", {})
                .get("repository", {})
                .get("pullRequest", {})
                .get("reviewThreads", {})
            )
            for node in threads.get("nodes", []):
                if not node.get("isResolved"):
                    unresolved += 1
            page_info = threads.get("pageInfo", {})
            if not page_info.get("hasNextPage"):
                return {"readable": True, "unresolved_count": unresolved}
            cursor = page_info.get("endCursor")

    def get_pr_diff(self, number: int) -> str | None:
        """Plan 023 v3 §P-6 — fetch the unified diff from gh CLI.

        Returns the diff text on success, or None on any subprocess
        failure / empty output. evaluate_auto_merge's empty-diff gate
        then converts the None / empty case into an explicit
        auto_merge_requires_nonempty_unified_diff blocking reason.
        """
        try:
            completed = subprocess.run(
                ["gh", "pr", "diff", str(number)],
                cwd=self.cwd, capture_output=True, text=True, check=False,
            )
        except (FileNotFoundError, OSError):
            return None
        if completed.returncode != 0:
            return None
        diff = completed.stdout or ""
        return diff if diff.strip() else None

    def merge_pr(
        self,
        number: int,
        *,
        method: str,
        expected_head_sha: str,
        authority_token: str | None = None,
    ) -> dict[str, Any]:
        if not authority_token or authority_token != self._merge_authority_token:
            raise GovernanceError("merge_pr_requires_merge_authority")
        self._merge_authority_token = None
        if method != "squash":
            raise GovernanceError("only squash merge is allowed")
        # ARIA-CRITICAL-246 — the merge is a write and runs on an
        # installation token; GitHubWriteRefused is a GovernanceError, so a
        # refusal reaches the caller the way a refused merge always has.
        completed = run_gh_write(
            ["pr", "merge", str(number), "--squash", "--match-head-commit", expected_head_sha],
            cwd=self.cwd,
        )
        if completed.returncode != 0:
            raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh pr merge failed")
        # ARIA-HIGH-221 — a zero exit is not a merge. On a branch that
        # requires a merge queue, `gh pr merge` enqueues the PR (or arms
        # auto-merge, which enqueues it once checks pass); the queue merges
        # it later, or removes it. The result is what GitHub reports now.
        return merge_outcome(
            self.get_merge_state(number),
            expected_head_sha=expected_head_sha,
            method="squash",
        )

    # ----- MissionObserver Protocol (Wave 2 PR 1.3) ----------------------
    #
    # `get_pr` above cannot answer reconciliation's question: it requests
    # `number,baseRefName,headRefName,headRefOid,files,reviews,reviewDecision`
    # and never asks for `state` or `merged`, so `get_pr(n)["state"]` is
    # absent here and a *stub string* on the recording adapter. A reconciler
    # built on it would read every real PR as unobserved and never transition
    # anything — machinery written and never able to fire, which is the defect
    # class this programme exists to close. Hence a purpose-built call.

    def get_pr_lifecycle(self, number: int) -> dict[str, Any] | None:
        payload = self._gh_json(
            [
                "pr",
                "view",
                str(number),
                "--json",
                "number,state,merged,mergeCommit,headRefName,body",
            ],
        )
        merge_commit = payload.get("mergeCommit")
        return {
            "number": payload.get("number"),
            "state": payload.get("state"),
            "merged": payload.get("merged"),
            "merge_commit_sha": (
                merge_commit.get("oid") if isinstance(merge_commit, dict) else None
            ),
            "head_ref": payload.get("headRefName"),
            "body": payload.get("body"),
        }

    def observe_branch(self, name: str) -> bool | None:
        """``True``/``False`` when the remote answered, ``None`` when it did not.

        `git ls-remote` and not `gh api` because the two outcomes that must
        not be confused — "the branch is gone" and "I could not ask" — are an
        exit code apart here, where over HTTP they are both a non-zero `gh`
        exit whose difference lives in stderr text. A branch-absence rule that
        depends on parsing an error message is a rule that sends missions back
        to PLANNING the day GitHub rewords a 404.
        """
        completed = subprocess.run(
            ["git", "ls-remote", "--heads", "origin", f"refs/heads/{name}"],
            cwd=self.cwd,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            return None
        return bool(completed.stdout.strip())

    def list_open_pull_requests(self) -> list[dict[str, Any]] | None:
        return self._gh_json_list(
            ["pr", "list", "--state", "open", "--limit", "100", "--json", "number,headRefName,body"],
        )

    # ----- operator_approval.OperatorActReader (ARIA-CRITICAL-216) -------
    #
    # An authority grant is proven by an operator's comment or PR review;
    # these are the reads that prove it. Each is a GET whose path is built
    # here from integers, never taken from a caller, so it does not go
    # through ALLOWED_GH_API_PATHS: that allowlist is also the agents' `gh
    # api` boundary, and no agent needs to read an operator's approval.

    def get_issue_comment(self, comment_id: int) -> dict[str, Any]:
        return self._gh_json(["api", f"repos/{self.owner}/{self.repo}/issues/comments/{int(comment_id)}"])

    def get_pull_request_review(self, number: int, review_id: int) -> dict[str, Any]:
        return self._gh_json(
            ["api", f"repos/{self.owner}/{self.repo}/pulls/{int(number)}/reviews/{int(review_id)}"]
        )

    def get_review_last_edited_at(self, node_id: str) -> str | None:
        """REST reviews carry no edit time; GraphQL's ``lastEditedAt`` does."""
        payload = self._gh_json([
            "api",
            "graphql",
            "-f",
            "query=query($id: ID!) { node(id: $id) { ... on PullRequestReview { lastEditedAt } } }",
            "-f",
            f"id={node_id}",
        ])
        node = (payload.get("data") or {}).get("node")
        if not isinstance(node, dict):
            raise GovernanceError(f"pull request review node {node_id!r} unreadable")
        edited = node.get("lastEditedAt")
        return edited if isinstance(edited, str) else None

    def list_open_pull_request_heads(self) -> dict[int, str]:
        """``{number: head sha}`` of EVERY open PR (ARIA-HIGH-222), paged to
        the end through the REST listing — the merge lane's candidate set
        must not stop at a page boundary."""
        path = f"repos/{self.owner}/{self.repo}/pulls?state=open&per_page=100"
        if is_gh_api_path_forbidden(path):
            raise GovernanceError(f"forbidden gh api path: {path}")
        stdout = self._gh_stdout(
            ["api", "--paginate", path, "--jq", ".[] | [.number, .head.sha] | @tsv"],
        )
        heads: dict[int, str] = {}
        for line in stdout.splitlines():
            number, _, head_sha = line.partition("\t")
            if number.strip().isdigit() and head_sha.strip():
                heads[int(number)] = head_sha.strip()
        return heads

    def _gh_api_json(self, args: list[str]) -> dict[str, Any]:
        if args and is_gh_api_path_forbidden(str(args[0])):
            raise GovernanceError(f"forbidden gh api path: {args[0]}")
        return self._gh_json(["api", *args])

    def _gh_stdout(self, args: list[str]) -> str:
        completed = subprocess.run(
            ["gh", *args],
            cwd=self.cwd,
            check=False,
            capture_output=True,
            text=True,
        )
        if completed.returncode != 0:
            raise GovernanceError(completed.stderr.strip() or completed.stdout.strip() or "gh command failed")
        return completed.stdout

    def _gh_json(self, args: list[str]) -> dict[str, Any]:
        stdout = self._gh_stdout(args)
        if not stdout.strip():
            return {}
        return json.loads(stdout)

    def _gh_json_list(self, args: list[str]) -> list[dict[str, Any]]:
        """`gh ... --json` on a list subcommand returns a JSON ARRAY, which
        `_gh_json`'s `dict` annotation would be lying about."""
        stdout = self._gh_stdout(args)
        if not stdout.strip():
            return []
        payload = json.loads(stdout)
        return payload if isinstance(payload, list) else []


def _required_checks(github: dict[str, Any]) -> dict[str, Any]:
    protection = github.get("branch_protection", github.get("required_checks", {}))
    if isinstance(protection, list):
        return {"readable": True, "checks": sorted({str(item) for item in protection if item})}
    if not isinstance(protection, dict):
        return {"readable": False, "checks": [], "lookup_error": "branch_protection_payload_unreadable"}
    # Plan 023 v3.1 §P-2-followup — propagate lookup_error from the
    # _fetch_branch_protection_contexts helper. Pre-Plan-023.1 the
    # helper populated github.branch_protection.lookup_error on
    # network/HTTP failure but evaluate_auto_merge never read it; the
    # gate fell through to checks validation as if branch protection
    # had been fetched cleanly. Auto-merge then proceeded against a
    # stale / fabricated required-checks list. Post-fix: lookup_error
    # makes _required_checks return readable=False AND surfaces the
    # specific error code so evaluate_auto_merge's downstream blocking
    # reason carries the operator-readable cause (404 / 403 / network).
    lookup_error = protection.get("lookup_error")
    if lookup_error:
        return {
            "readable": False,
            "checks": [],
            "lookup_error": str(lookup_error),
        }
    readable = protection.get("readable", True) is True
    checks = protection.get("required_checks", protection.get("contexts", protection.get("checks", [])))
    names: list[str] = []
    if isinstance(checks, list):
        for item in checks:
            if isinstance(item, dict):
                name = item.get("name") or item.get("context")
            else:
                name = item
            if name:
                names.append(str(name))
    return {"readable": readable, "checks": sorted(set(names))}


def _required_checks_result(github: dict[str, Any], required: list[str], head_sha: str | None) -> dict[str, Any]:
    checks_payload = github.get("checks", github.get("check_runs", {}))
    if isinstance(checks_payload, list):
        readable = True
        runs = checks_payload
    elif isinstance(checks_payload, dict):
        readable = checks_payload.get("readable", True) is True
        runs = checks_payload.get("runs", checks_payload.get("check_runs", checks_payload.get("statuses", [])))
    else:
        readable = False
        runs = []
    if not readable:
        return {"readable": False, "missing": required, "not_success": []}

    by_name: dict[str, dict[str, Any]] = {}
    for run in runs if isinstance(runs, list) else []:
        if not isinstance(run, dict):
            continue
        run_head = run.get("head_sha") or run.get("sha")
        if run_head and head_sha and run_head != head_sha:
            continue
        name = run.get("name") or run.get("context")
        if name:
            by_name[str(name)] = run

    missing = [name for name in required if name not in by_name]
    not_success = [name for name in required if name in by_name and not _check_success(by_name[name])]
    return {"readable": True, "missing": missing, "not_success": not_success}


# Conclusions that do not block the full battery: neutral is informational
# and skipped is a conditional job that chose not to run. Everything else
# non-success (failure, cancelled, timed_out, action_required, stale) is red.
_NONBLOCKING_CONCLUSIONS = frozenset({"success", "neutral", "skipped"})


def _all_check_runs_result(github: dict[str, Any], head_sha: str | None) -> dict[str, Any]:
    """ORPHAN-717 — every check run on the head SHA, required or not.

    Same payload parse as ``_required_checks_result`` but iterating ALL
    runs: any run still pending or concluded red blocks. Legacy commit
    statuses (``state`` field) map: success→green, pending→pending,
    anything else→red.
    """
    checks_payload = github.get("checks", github.get("check_runs", {}))
    if isinstance(checks_payload, list):
        readable = True
        runs = checks_payload
    elif isinstance(checks_payload, dict):
        readable = checks_payload.get("readable", True) is True
        runs = checks_payload.get("runs", checks_payload.get("check_runs", checks_payload.get("statuses", [])))
    else:
        readable = False
        runs = []
    if not readable:
        return {"readable": False, "total": 0, "pending": [], "red": []}
    pending: list[str] = []
    red: list[str] = []
    total = 0
    for run in runs if isinstance(runs, list) else []:
        if not isinstance(run, dict):
            continue
        run_head = run.get("head_sha") or run.get("sha")
        if run_head and head_sha and run_head != head_sha:
            continue
        total += 1
        name = str(run.get("name") or run.get("context") or "unnamed-check")
        state = str(run.get("state", "")).lower()
        status = str(run.get("status", "")).lower()
        conclusion = str(run.get("conclusion", "")).lower()
        if state:
            if state == "success":
                continue
            (pending if state == "pending" else red).append(name)
            continue
        if status and status != "completed":
            pending.append(name)
            continue
        if conclusion not in _NONBLOCKING_CONCLUSIONS:
            red.append(name)
    return {
        "readable": True,
        "total": total,
        "pending": sorted(pending),
        "red": sorted(red),
    }


def _review_result(pr: dict[str, Any], github: dict[str, Any]) -> dict[str, Any]:
    reviews = github.get("reviews", pr.get("reviews", {"readable": True, "items": []}))
    if isinstance(reviews, list):
        items = reviews
        readable = True
        explicit_count = None
    elif isinstance(reviews, dict):
        readable = reviews.get("readable", True) is True
        items = reviews.get("items", reviews.get("reviews", []))
        explicit_count = reviews.get("requested_changes_count")
    else:
        return {"readable": False, "requested_changes_count": 0}
    if not readable:
        return {"readable": False, "requested_changes_count": 0}
    if not isinstance(items, list):
        items = []
    if isinstance(explicit_count, int):
        requested_changes_count = explicit_count
    else:
        requested_changes_count = sum(
            1
            for review in items if isinstance(review, dict)
            and str(review.get("state", review.get("reviewDecision", ""))).upper() == "CHANGES_REQUESTED"
        )
    return {"readable": True, "requested_changes_count": requested_changes_count}


def _conversation_result(github: dict[str, Any]) -> dict[str, Any]:
    conversations = github.get("conversations", github.get("review_threads", None))
    if isinstance(conversations, dict):
        readable = conversations.get("readable", True) is True
        count = conversations.get("unresolved_count", conversations.get("unresolved_conversation_count"))
        return {"readable": readable, "unresolved_count": count if isinstance(count, int) else 0}
    if isinstance(conversations, int):
        return {"readable": True, "unresolved_count": conversations}
    return {"readable": False, "unresolved_count": 0}


def _check_success(run: dict[str, Any]) -> bool:
    state = str(run.get("state", "")).lower()
    status = str(run.get("status", "")).lower()
    conclusion = str(run.get("conclusion", "")).lower()
    if state:
        return state == "success"
    if conclusion:
        return conclusion == "success" and status in ("", "completed")
    return False


def _append_decision(base_dir: str | Path | None, decision: dict[str, Any]) -> None:
    if base_dir is None:
        return
    append_declared_jsonl(
        ensure_tools_dir(base_dir) / "auto-merge-decisions.jsonl",
        decision,
        expected_surface="auto_merge_decisions",
    )


def _changed_file_path(item: str | dict[str, Any]) -> str:
    # ARIA-HIGH-186: the classifier's input must be the path GitHub changed,
    # dot and all; a traversal or empty entry is a malformed PR, refused.
    if isinstance(item, dict):
        item = str(item.get("path") or item.get("filename") or item.get("fileName") or "")
    return normalize_repo_relpath(item)


def _matches_any(path: str, patterns: list[str]) -> bool:
    return any(matches_repo_glob(path, pattern) for pattern in patterns)


def _first_string(payload: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def _safe_call(func: Any, *, default: Any) -> Any:
    try:
        return func()
    except Exception:
        return default
