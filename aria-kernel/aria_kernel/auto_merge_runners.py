"""Plan ARIA-V3 §A1 — required-injection auto-merge runners.

GAP-2 closure: pre-V3 ``run_autonomy_orchestrator`` accepted
``auto_merge_runner: Callable | None = None`` with a default ``None``
that silently skipped auto-merge. The docstring promised auto-merge
was part of the loop; the default contradicted the promise. V3 makes
the parameter REQUIRED (no ``Optional``, no default) and supplies two
typed runners selected by runtime profile:

* :class:`NoOpAutoMergeRunner` — accepts the call, emits a
  ``skipped`` result row, never invokes ``auto_merge.merge_if_green``.
  Used for ``observe`` / ``standard`` / ``frozen`` profiles where
  auto-merge is structurally not permitted.
* :class:`RealAutoMergeRunner` — wraps ``auto_merge.merge_if_green``.
  Used for ``strict`` (shadow / dry_run=True observation) and
  ``autonomous`` (Phase B2; real merge with dry_run=False on the L3
  snowball lane only).

The factory :func:`select_auto_merge_runner` does the profile →
runner mapping. Adding a new profile requires explicit code change
here + a matching update to ``runtime_profile.PROFILES`` (Plan
ARIA-V3 Phase B2 adds ``autonomous``).

Plan-026R discipline: invariant tests I-V3-01..03 lock the contract.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Protocol

# Plan ARIA-V3 §A1 — supported profiles for auto-merge runner
# selection. ``autonomous`` is Phase B2; the factory currently maps
# it to ``RealAutoMergeRunner`` so B2 only needs to add the profile
# to ``runtime_profile.PROFILES`` and flip dry_run.
_REAL_RUNNER_PROFILES: frozenset[str] = frozenset({"strict", "autonomous"})
_NOOP_RUNNER_PROFILES: frozenset[str] = frozenset({"observe", "standard", "frozen"})


class AutoMergeRunner(Protocol):
    """Plan ARIA-V3 §A1 — call shape consumed by autonomy_orchestrator.

    The orchestrator invokes ``runner(base_dir=..., workspace_root=...)``
    and expects a dict result carrying at minimum ``status`` +
    ``merges_completed``.
    """

    profile: str

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]: ...


class NoOpAutoMergeRunner:
    """Plan ARIA-V3 §A1 — null-object runner for non-permitted profiles.

    Returns a structured ``skipped`` result so the orchestrator's
    counter accumulation stays well-defined (no special-casing of a
    ``None`` runner anywhere in the loop). Audit-visible: the
    governance row carries ``reason`` = ``profile_<name>_does_not_permit_auto_merge``
    so an auditor can reconstruct the profile state from the audit
    chain alone.
    """

    def __init__(self, *, profile: str) -> None:
        self.profile = profile

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]:
        return {
            "schema_version": 1,
            "status": "skipped",
            "reason": f"profile_{self.profile}_does_not_permit_auto_merge",
            "merges_completed": 0,
            "candidates_evaluated": 0,
            "profile": self.profile,
        }


class RealAutoMergeRunner:
    """Plan ARIA-V3 §A1 + §B2 — wraps ``auto_merge.merge_if_green``.

    Under ``strict`` profile this runner dispatches to merge_if_green
    with ``dry_run=True`` so the evaluation chain runs (decision
    logged, eligibility checked, audit emitted) but no actual ``gh pr
    merge --squash`` fires. Phase B2 introduces the ``autonomous``
    profile, at which point this runner flips ``dry_run=False`` for
    the L3-snowball lane (and ONLY that lane, via the lane classifier).

    The runner depends on a :class:`GitHubAdapter` factory plumbed
    through from Phase A2. Until A2 lands its factory, this runner
    returns ``no_adapter_configured`` so the orchestrator's loop
    progresses without crashing (Tier-2: missing infrastructure
    surfaces as a structured no-op, not a runtime exception).
    """

    def __init__(
        self,
        *,
        profile: str,
        adapter_factory: Callable[[], Any] | None = None,
        pr_enumerator: Callable[[Any], list[int]] | None = None,
    ) -> None:
        self.profile = profile
        self.adapter_factory = adapter_factory
        self.pr_enumerator = pr_enumerator

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]:
        if self.adapter_factory is None:
            return {
                "schema_version": 1,
                "status": "no_adapter_configured",
                "reason": (
                    "real_auto_merge_runner_requires_github_adapter_factory"
                    " (Plan ARIA-V3 Phase A2 plumbs this through)"
                ),
                "merges_completed": 0,
                "candidates_evaluated": 0,
                "profile": self.profile,
            }
        from .auto_merge import merge_if_green

        adapter = self.adapter_factory()
        candidate_prs = (
            self.pr_enumerator(adapter)
            if self.pr_enumerator is not None
            else []
        )
        # Plan ARIA-V3 §B2 — under ``autonomous`` profile + lane=L3-snowball
        # this MUST be False. Until B2 lands, strict observes (dry_run=True).
        dry_run = self.profile != "autonomous"
        merges_completed = 0
        decisions: list[dict[str, Any]] = []
        for pr_number in candidate_prs:
            if dry_run:
                decision = merge_if_green(
                    adapter=adapter,
                    pr_number=pr_number,
                    base_dir=base_dir,
                    dry_run=True,
                )
            else:
                decision = {
                    "decision": "blocked",
                    "eligible": False,
                    "pr_number": pr_number,
                    "reasons": ["enterprise_readiness_claim_id_required"],
                }
            decisions.append(decision)
            if decision.get("decision") == "merged":
                merges_completed += 1
        return {
            "schema_version": 1,
            "status": "ok",
            "merges_completed": merges_completed,
            "candidates_evaluated": len(candidate_prs),
            "decisions": decisions,
            "dry_run": dry_run,
            "profile": self.profile,
        }


def select_auto_merge_runner(
    *,
    profile: str,
    adapter_factory: Callable[[], Any] | None = None,
    pr_enumerator: Callable[[Any], list[int]] | None = None,
) -> AutoMergeRunner:
    """Plan ARIA-V3 §A1 — profile-derived runner factory.

    Adding a new profile to either set requires updating the
    constants at the top of this module AND ``runtime_profile.PROFILES``
    AND the V3 invariant tests I-V3-02 + I-V3-03 (or a new I-V3-XX
    for the new profile). Untyped insertion raises ``ValueError``.
    """
    if profile in _REAL_RUNNER_PROFILES:
        return RealAutoMergeRunner(
            profile=profile,
            adapter_factory=adapter_factory,
            pr_enumerator=pr_enumerator,
        )
    if profile in _NOOP_RUNNER_PROFILES:
        return NoOpAutoMergeRunner(profile=profile)
    raise ValueError(
        f"unknown profile for auto_merge_runner selection: {profile!r}; "
        f"known: {sorted(_REAL_RUNNER_PROFILES | _NOOP_RUNNER_PROFILES)}"
    )


__all__ = [
    "AutoMergeRunner",
    "NoOpAutoMergeRunner",
    "RealAutoMergeRunner",
    "select_auto_merge_runner",
    # Plan ARIA-V9.6 — V9 implementation-phase auto-merge surface
    "compute_v9_idempotency_key",
    "verify_branch_tip",
    "poll_pr_checks",
    "evaluate_v9_implementation_merge",
    "V9MergeDecision",
    "PR_CHECK_POLL_MAX_ATTEMPTS",
    "PR_CHECK_POLL_INTERVAL_SECONDS",
]


# =============================================================================
# Plan ARIA-V9.6 — implementation-phase auto-merge runner
# =============================================================================
#
# Closes:
#   * arb CRIT-004 — `gh pr merge --auto` server-decides-when-to-merge
#     semantics replaced by SYNCHRONOUS `gh pr merge --squash` after
#     pre-merge re-check + evaluate_auto_merge eligibility
#   * arb HIGH-006 — idempotency_key extended from 2-tuple
#     (plan_id, diff_hash) to 5-tuple (+ pr_number, base_branch,
#     branch_tip_sha) — prevents the rebase-and-force-push collision
#     class flagged in the audit
#   * sec CRIT-003 — `.github/workflows/**` blocked via
#     `auto_merge.evaluate_auto_merge` which carries DEFAULT_POLICY
#     hard_forbidden_globs (this module INVOKES evaluate, not
#     re-states a weaker policy)
#   * sec HIGH-002 — CI race window — headRefOid recheck via
#     `gh pr view --json headRefOid` matching
#     state.implementation.branch_tip_sha immediately before merge
#   * ai HIGH-007 — TOCTOU on diff_hash — branch_tip_sha captured at
#     IMPLEMENTATION_RECORDED time + rechecked here
#   * sec MED-004 — SKIPPED / NEUTRAL check states rejected
#     (only SUCCESS advances)
#   * perf MED-012 — subprocess.run with bounded polls (NOT
#     subprocess.Popen — no resource leak between cycles)
#   * ai MED-016 — autonomous-profile precondition gate
#     (autonomous-only merge; strict profile no-ops with dry-run flag)


import hashlib
import json
import shutil
import subprocess
import time
from dataclasses import dataclass


# Plan ARIA-V9.6 — bounded PR check polling. 60 polls × 15s = 15min
# max wait. Beyond this, ci_check_timeout rejection fires; the merge
# does NOT block on a stuck CI for hours.
PR_CHECK_POLL_MAX_ATTEMPTS: int = 60
PR_CHECK_POLL_INTERVAL_SECONDS: int = 15


@dataclass(frozen=True)
class V9MergeDecision:
    """Plan ARIA-V9.6 — frozen merge-decision record.

    eligible=True means the 4 gates passed:
      1. CI checks all SUCCESS (no SKIPPED, no NEUTRAL)
      2. branch_tip_sha matches expected
      3. auto_merge.evaluate_auto_merge returns approved
      4. gh pr merge --squash returns exit 0

    eligible=False → rejection_class is set to one of the v9.0-B
    validated rejection classes (ci_check_red, ci_check_timeout,
    branch_tip_drift, merge_policy_violation,
    autonomous_profile_preconditions_not_met).

    idempotency_key_hash is sha256 of the 5-tuple
    (plan_id, diff_hash, pr_number, base_branch, branch_tip_sha).
    Re-running the auto-merge daemon against the same merged PR
    is a no-op (the record_implementation_merged event itself is
    idempotency-keyed in plan_convergence._mutate).
    """

    eligible: bool
    plan_id: str
    pr_number: int
    rejection_class: str | None
    idempotency_key_hash: str
    decision_at_utc: str
    pre_merge_branch_tip_sha: str | None
    merge_sha: str | None
    check_summary: tuple[str, ...]


def compute_v9_idempotency_key(
    *,
    plan_id: str,
    diff_hash: str,
    pr_number: int,
    base_branch: str,
    branch_tip_sha: str,
) -> str:
    """Plan ARIA-V9.6 — 5-tuple idempotency key.

    sha256 of canonical-JSON-encoded tuple. The 5 fields prevent
    the rebase-and-force-push collision class flagged by arb
    HIGH-006: a PR rebased + force-pushed → branch_tip_sha
    differs → idempotency key differs → previously-recorded
    implementation_merged event does NOT silently no-op the
    second mint attempt.
    """
    canonical = {
        "plan_id": plan_id,
        "diff_hash": diff_hash,
        "pr_number": pr_number,
        "base_branch": base_branch,
        "branch_tip_sha": branch_tip_sha,
    }
    raw = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def verify_branch_tip(
    *,
    pr_number: int,
    expected_branch_tip_sha: str,
    gh_cli: str = "gh",
) -> bool:
    """Plan ARIA-V9.6 — pre-merge headRefOid recheck.

    Closes sec HIGH-002 + ai HIGH-007 — the CI green check happened
    against a specific branch tip. If the branch was force-pushed
    or rebased between IMPLEMENTATION_RECORDED + merge, the green
    check no longer applies to the current code. Tier-1 — abort the
    merge if drift detected.

    Returns True iff `gh pr view --json headRefOid` matches
    expected_branch_tip_sha. False on any mismatch, gh-CLI absence,
    or API failure (fail-closed).
    """
    if not isinstance(expected_branch_tip_sha, str) or not expected_branch_tip_sha:
        return False
    if not shutil.which(gh_cli):
        return False
    try:
        proc = subprocess.run(
            [gh_cli, "pr", "view", str(pr_number),
             "--json", "headRefOid"],
            capture_output=True, text=True, timeout=15,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    if proc.returncode != 0:
        return False
    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        return False
    head_oid = payload.get("headRefOid") if isinstance(payload, dict) else None
    if not isinstance(head_oid, str):
        return False
    return head_oid == expected_branch_tip_sha


def poll_pr_checks(
    *,
    pr_number: int,
    max_attempts: int = PR_CHECK_POLL_MAX_ATTEMPTS,
    interval_seconds: int = PR_CHECK_POLL_INTERVAL_SECONDS,
    gh_cli: str = "gh",
    sleep_fn: Any = None,
) -> tuple[str, tuple[str, ...]]:
    """Plan ARIA-V9.6 — PR check polling via `gh pr checks`.

    Returns ``(status, summary)`` where status is one of:
      * "all_success" — every required check completed with SUCCESS
      * "ci_check_red" — at least one FAILURE / CANCELLED
      * "ci_check_skipped_or_neutral" — at least one SKIPPED or
        NEUTRAL among required checks (sec MED-004)
      * "ci_check_timeout" — max_attempts exceeded
      * "gh_cli_unavailable" — gh CLI not on PATH

    `summary` is a tuple of ``"<check>:<state>"`` strings for
    audit.

    Uses subprocess.run (NOT Popen — perf MED-012 resource cleanup
    guarantee). sleep_fn injectable for tests.
    """
    sleep = sleep_fn or time.sleep
    if not shutil.which(gh_cli):
        return ("gh_cli_unavailable", ())
    for attempt in range(max_attempts):
        try:
            proc = subprocess.run(
                [gh_cli, "pr", "checks", str(pr_number),
                 "--json", "name,state,bucket"],
                capture_output=True, text=True, timeout=20,
            )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            sleep(interval_seconds)
            continue
        if proc.returncode != 0:
            sleep(interval_seconds)
            continue
        try:
            rows = json.loads(proc.stdout)
        except json.JSONDecodeError:
            sleep(interval_seconds)
            continue
        if not isinstance(rows, list):
            sleep(interval_seconds)
            continue
        summary = tuple(
            f"{r.get('name')}:{r.get('state')}"
            for r in rows if isinstance(r, dict)
        )
        states = {r.get("state") for r in rows if isinstance(r, dict)}
        buckets = {r.get("bucket") for r in rows if isinstance(r, dict)}
        # Any pending/queued/in_progress → continue polling
        if any(b == "pending" for b in buckets) or "PENDING" in states or "QUEUED" in states or "IN_PROGRESS" in states:
            sleep(interval_seconds)
            continue
        # Any failure / cancelled / timed_out → red
        if any(b == "fail" for b in buckets) or "FAILURE" in states or "CANCELLED" in states or "TIMED_OUT" in states:
            return ("ci_check_red", summary)
        # SKIPPED / NEUTRAL present among required → reject
        # (sec MED-004 — only SUCCESS advances merge)
        if "SKIPPED" in states or "NEUTRAL" in states:
            return ("ci_check_skipped_or_neutral", summary)
        # All terminal AND all SUCCESS
        if all(b == "pass" for b in buckets) or states == {"SUCCESS"}:
            return ("all_success", summary)
        # Mixed terminal states we don't recognise → conservative fail
        sleep(interval_seconds)
    return ("ci_check_timeout", ())


def evaluate_v9_implementation_merge(
    *,
    plan_id: str,
    pr_number: int,
    diff_hash: str,
    branch_tip_sha: str,
    base_branch: str,
    profile: str,
    adapter: Any | None = None,
    policy: dict[str, Any] | None = None,
    gh_cli: str = "gh",
    sleep_fn: Any = None,
) -> V9MergeDecision:
    """Demoted V9 implementation merge surface.

    Plan 2026-05-25 makes ``auto_merge.merge_if_green`` the only real
    merge executor. This legacy V9 surface remains importable so old
    orchestration code can fail closed with an auditable decision, but
    it must never call ``gh pr merge`` or otherwise merge a PR.
    """
    from datetime import datetime, timezone

    _ = (profile, adapter, policy, gh_cli, sleep_fn)
    decision_at = datetime.now(timezone.utc).isoformat()
    idempotency_key = compute_v9_idempotency_key(
        plan_id=plan_id,
        diff_hash=diff_hash,
        pr_number=pr_number,
        base_branch=base_branch,
        branch_tip_sha=branch_tip_sha,
    )
    return V9MergeDecision(
        eligible=False,
        plan_id=plan_id,
        pr_number=pr_number,
        rejection_class="v9_merge_path_disabled_use_merge_if_green",
        idempotency_key_hash=idempotency_key,
        decision_at_utc=decision_at,
        pre_merge_branch_tip_sha=None,
        merge_sha=None,
        check_summary=("v9_merge_path_disabled",),
    )
