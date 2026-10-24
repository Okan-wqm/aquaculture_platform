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
  ``autonomous`` (real merge authority still requires readiness claims
  and ``merge_authority.merge_pr_if_ready``).

The factory :func:`select_auto_merge_runner` does the profile →
runner mapping. Adding a new profile requires explicit code change
here + a matching update to ``runtime_profile.PROFILES`` (Plan
ARIA-V3 Phase B2 adds ``autonomous``).

Plan-026R discipline: invariant tests I-V3-01..03 lock the contract.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Protocol

from .git_object_id import ANY_OBJECT_FORMAT, is_object_id
from .implementation_rejections import V9_MERGE_PATH_DISABLED_REJECTION_CLASS
from .ledger import load_declared_jsonl
from .preflight import OperatorStopSource
from .risk_policy import first_present_string
from .tool_registry import GovernanceError, ensure_tools_dir


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
    profile, at which point this runner flips ``dry_run=False`` and still
    routes through enterprise readiness plus merge authority.

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
        executes_merges: bool,
        adapter_factory: Callable[[], Any] | None = None,
        pr_enumerator: Callable[[Any], list[int]] | None = None,
        readiness_claim_resolver: Callable[[Any, int, str | Path | None], str] | None = None,
        intent_publisher: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
        operator_stop: OperatorStopSource | None = None,
    ) -> None:
        self.profile = profile
        self.executes_merges = executes_merges
        self.adapter_factory = adapter_factory
        self.pr_enumerator = pr_enumerator
        self.readiness_claim_resolver = readiness_claim_resolver
        # ARIA-HIGH-222 — publishes the merge_intent row before each merge
        # call; the merge authority refuses to merge without it.
        self.intent_publisher = intent_publisher
        # ARIA-HIGH-765 — reads the operator's live vars.ARIA_STOP right
        # before each merge call; the merge authority makes no merge call
        # without it.
        self.operator_stop = operator_stop

    def __call__(
        self,
        *,
        base_dir: str | Path,
        workspace_root: str | Path | None,
    ) -> dict[str, Any]:
        missing: list[str] = []
        if self.adapter_factory is None:
            missing.append("github_adapter_factory")
        if self.pr_enumerator is None:
            missing.append("pr_enumerator")
        if self.readiness_claim_resolver is None:
            missing.append("readiness_claim_resolver")
        if missing:
            return {
                "schema_version": 1,
                "status": "blocked",
                "reason": "real_auto_merge_runner_missing_dependencies",
                "missing_dependencies": missing,
                "merges_completed": 0,
                "candidates_evaluated": 0,
                "profile": self.profile,
            }
        from .auto_merge import merge_if_green
        from .batch_containment import guard_item, with_item_failures
        from .watchdog_freeze import open_watchdog_incidents

        adapter = self.adapter_factory()
        # ARIA-HIGH-205 — live exactly when THIS runner is the merge lane
        # (`aria-kernel merge-lane run`, aria-merge-runner.yml) AND merge
        # authority exists: the `autonomous` profile, or an operator's
        # merge-lane grant in force under a profile that holds action
        # authority. The nightly cycle constructs the runner with
        # executes_merges=False and only ever evaluates: merge execution
        # moved to the attestable GitHub-hosted lane (ARIA-HIGH-198), and a
        # grant must not turn the self-hosted cycle into a second, refused
        # merge path that writes risk and unlock rows every night. The
        # grant's lane is enforced per PR inside merge_pr_if_ready against
        # the measured risk lane.
        from .runtime_profile import merge_authority_available
        from .runner_attestation import measure_merge_lane_identity

        # ARIA-HIGH-220 — the CLI says this runner is the merge lane
        # (`executes_merges`); the measured identity must agree: the job's
        # OIDC token, verified, names this run and the merge-runner workflow
        # on main, on a GitHub-hosted runner. Anywhere else the runner only
        # evaluates, and says why.
        lane_identity = measure_merge_lane_identity() if self.executes_merges else None
        executes = self.executes_merges and lane_identity is not None and lane_identity["merge_lane"] is True
        dry_run = not (executes and merge_authority_available(base_dir=base_dir))
        identity_summary = (
            None if lane_identity is None else {
                "verified": lane_identity["merge_lane"] is True,
                "run_id": lane_identity["run_id"],
                "run_attempt": lane_identity["run_attempt"],
                "runner_name": lane_identity["runner_name"],
                "job_workflow_ref": (lane_identity.get("oidc") or {}).get("job_workflow_ref"),
                "reasons": list(lane_identity["reasons"]),
            }
        )
        merges_completed = 0
        decisions: list[dict[str, Any]] = []
        # Containment must not buy silence (ORPHAN-HIGH-578): a candidate
        # lost to a refusal is reported, never absorbed.
        item_failures: list[dict[str, Any]] = []
        # ARIA-HIGH-221 — main merges through a merge queue, so an earlier
        # run's `enqueued` PRs are settled first: merged by the queue (the
        # merge's rows are recorded now), still queued (left alone, and not
        # a candidate), or removed (a candidate again). Recording a merge
        # the queue made is not a merge, so it runs under a watchdog freeze
        # too; a failure to settle costs the settlement, not the run.
        queue_settled: list[dict[str, Any]] = []
        if not dry_run:
            from .merge_authority import reconcile_enqueued_merges

            settled_ok, settled = guard_item(
                item_failures,
                item_kind="merge_queue_settlement",
                item_id="enqueued",
                work=lambda: reconcile_enqueued_merges(adapter=adapter, base_dir=base_dir),
            )
            if settled_ok and settled is not None:
                queue_settled = settled
                merges_completed += sum(1 for row in settled if row.get("decision") == "merged")
        candidate_prs = self.pr_enumerator(adapter)

        # ORPHAN-MEDIUM-562 — THE WATCHDOG FREEZE IS A PROPERTY OF THE RUN, NOT
        # OF A PULL REQUEST, and asking it once here rather than N times inside
        # the loop is the difference between a refusal and an outage.
        #
        # `merge_pr_if_ready` raises `GovernanceError` when the freeze is on,
        # and this loop does not guard that call — the only `try` below covers
        # `readiness_claim_resolver`. So a per-PR freeze check would abort
        # `run_autonomy_orchestrator` on the FIRST candidate: PRs k+1..n never
        # evaluated, no result dict returned, `auto_merge_completed`,
        # calibration, reflection and the `autonomy_orchestrator_exit` row all
        # skipped, and the remaining `--max-cycles` iterations lost. That is
        # precisely the cycle-level stop `watchdog_freeze` promises never to
        # cause, and it is worse than the disease: an unreadable issue list
        # is deliberately fail-closed, so one transient `gh issue list` error
        # would have taken the whole run down.
        #
        # Asked ONCE, the same fail-closed verdict becomes a `blocked` decision
        # per candidate — the shape the loop already uses for a failed
        # readiness claim, which `blocked_count` below already rolls up.
        # `merge_pr_if_ready` keeps its own assertion as defence in depth: it is
        # the single real-merge authority and must refuse when called directly.
        if not dry_run:
            frozen = open_watchdog_incidents(adapter=adapter)
            if frozen["readable"] is not True or frozen["incidents"]:
                reason = (
                    f"merge_frozen_watchdog_unreadable: {frozen['reason']}"
                    if frozen["readable"] is not True
                    else "merge_frozen_watchdog_incident_open: "
                    + ", ".join(f"#{item['number']}" for item in frozen["incidents"])
                )
                return {
                    "schema_version": 1,
                    "status": "blocked",
                    "reason": "watchdog_merge_frozen",
                    "watchdog": frozen,
                    "merges_completed": merges_completed,
                    "candidates_evaluated": len(candidate_prs),
                    "queue_settled": queue_settled,
                    # Same key set as the normal return below. A refusal that
                    # answers with a different shape is a refusal every consumer
                    # has to special-case.
                    "dry_run": dry_run,
                    "executes_merges": self.executes_merges,
                    "merge_lane_identity": identity_summary,
                    "profile": self.profile,
                    "decisions": [
                        {
                            "decision": "blocked",
                            "eligible": False,
                            "pr_number": pr_number,
                            "reasons": [reason],
                        }
                        for pr_number in candidate_prs
                    ],
                }

        from .auto_merge import human_merge_decision

        for pr_number in candidate_prs:
            # ARIA-HIGH-211 — a PR ARIA opened for a person's merge is named
            # (`human_merge_lane`) from ARIA's own opened row and never
            # evaluated: no readiness resolution, no risk row, every run.
            skipped = human_merge_decision(int(pr_number), base_dir=base_dir)
            if skipped is not None:
                decisions.append(skipped)
                continue
            try:
                readiness_claim_id = self.readiness_claim_resolver(
                    adapter,
                    int(pr_number),
                    base_dir,
                )
            except Exception as exc:
                decision = {
                    "decision": "blocked",
                    "eligible": False,
                    "pr_number": pr_number,
                    "reasons": [f"readiness_claim_resolution_failed: {exc}"],
                }
                decisions.append(decision)
                continue
            # ONE CANDIDATE'S REFUSAL COSTS THAT CANDIDATE, NOT THE RUN.
            #
            # Every gate `merge_pr_if_ready` consults raises `GovernanceError`
            # rather than returning a verdict — the profile gate, the readiness
            # claim, risk policy, autonomy unlock, enterprise readiness, the
            # runner attestation, the rollback bundle, and now the watchdog
            # freeze. This call was bare, so ANY of them ended
            # `run_autonomy_orchestrator` on the first candidate: PRs k+1..n
            # never evaluated, no result dict returned, and the cycle's seal,
            # calibration and reflection all skipped.
            #
            # That is ORPHAN-HIGH-578's shape exactly — a partial state
            # indistinguishable from a total failure — so it uses 578's own
            # primitive rather than a private try/except. `guard_item` re-raises
            # `LedgerIntegrityError`, which is right: a corrupt ledger is not one
            # candidate's problem and must still abort.
            ok, decision = guard_item(
                item_failures,
                item_kind="auto_merge_candidate",
                item_id=str(pr_number),
                work=lambda: (
                    merge_if_green(
                        adapter=adapter,
                        pr_number=pr_number,
                        base_dir=base_dir,
                        dry_run=True,
                        # ARIA-CRITICAL-215 — the evaluation reads the PR's
                        # change from this checkout, as the merge does.
                        workspace_root=workspace_root,
                    )
                    if dry_run
                    else _merge_candidate(
                        adapter=adapter,
                        pr_number=pr_number,
                        base_dir=base_dir,
                        readiness_claim_id=readiness_claim_id,
                        workspace_root=workspace_root,
                        lane_identity=lane_identity,
                        intent_publisher=self.intent_publisher,
                        operator_stop=self.operator_stop,
                    )
                ),
            )
            if not ok:
                failure = item_failures[-1]
                decision = {
                    "decision": "blocked",
                    "eligible": False,
                    "pr_number": pr_number,
                    "reasons": [f"{failure['error_class']}: {failure['error_message']}"],
                }
            decisions.append(decision)
            if decision.get("decision") == "merged":
                merges_completed += 1
        blocked_count = sum(1 for decision in decisions if decision.get("decision") == "blocked")
        status = "ok"
        if candidate_prs and blocked_count == len(candidate_prs):
            status = "blocked"
        elif blocked_count:
            status = "degraded"
        return with_item_failures(
            {
                "schema_version": 1,
                "status": status,
                "merges_completed": merges_completed,
                "candidates_evaluated": len(candidate_prs),
                "queue_settled": queue_settled,
                "decisions": decisions,
                "dry_run": dry_run,
                "executes_merges": self.executes_merges,
                "merge_lane_identity": identity_summary,
                "profile": self.profile,
            },
            item_failures,
        )


def _merge_candidate(
    *,
    adapter: Any,
    pr_number: int,
    base_dir: str | Path,
    readiness_claim_id: str,
    workspace_root: str | Path | None,
    lane_identity: dict[str, Any] | None,
    intent_publisher: Callable[[dict[str, Any]], dict[str, Any]] | None,
    operator_stop: OperatorStopSource | None,
) -> dict[str, Any]:
    """Attest this run for the candidate, then hand it to the authority.

    ARIA-HIGH-220 — the attestation row is recorded by the run that is about
    to merge, for the one claim it merges under, and bound to the run (id,
    attempt, runner); ``merge_pr_if_ready`` re-measures the identity at the
    point of merge and accepts only this run's row. It used to be recorded
    by a lane-start step for every claim ever made, keyed by (PR, head,
    claim) alone.

    A module-level function that imports and calls the authority by name:
    the static safety-control reachability graph
    (tests/invariants/v3/test_safety_control_reachability.py) resolves
    neither a call through a parameter nor a ``self.`` method call, and
    would then report every gate behind ``merge_pr_if_ready`` as dead.
    """
    from .merge_authority import merge_pr_if_ready

    _attest_candidate(
        pr_number=pr_number,
        base_dir=base_dir,
        readiness_claim_id=readiness_claim_id,
        lane_identity=lane_identity,
    )
    return merge_pr_if_ready(
        adapter=adapter,
        pr_number=pr_number,
        base_dir=base_dir,
        readiness_claim_id=readiness_claim_id,
        workspace_root=workspace_root,
        intent_publisher=intent_publisher,
        operator_stop=operator_stop,
    )


def _attest_candidate(
    *,
    pr_number: int,
    base_dir: str | Path,
    readiness_claim_id: str,
    lane_identity: dict[str, Any] | None,
) -> dict[str, Any]:
    """Record this run's merge-lane attestation for the claim it merges under."""
    from .runner_attestation import MERGE_LANE, probe_runner_attestation

    claim = _claim_row(base_dir, readiness_claim_id)
    return probe_runner_attestation(
        pr_number=int(pr_number),
        head_sha=str(claim.get("head_sha") or ""),
        readiness_claim_id=readiness_claim_id,
        repo=str(claim.get("repo") or ""),
        target_ref=str(claim.get("target_ref") or ""),
        head_ref=str(claim.get("head_ref") or ""),
        lane=MERGE_LANE,
        base_dir=base_dir,
        identity=lane_identity,
    )


def _claim_row(base_dir: str | Path, readiness_claim_id: str) -> dict[str, Any]:
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "readiness-claims.jsonl",
        expected_surface="enterprise_readiness_claims",
    )
    matches = [row for row in rows if row.get("readiness_claim_id") == readiness_claim_id]
    if len(matches) != 1:
        raise GovernanceError(
            f"readiness_claim_exact_match_required: claim={readiness_claim_id} matches={len(matches)}"
        )
    return matches[0]


def select_auto_merge_runner(
    *,
    profile: str,
    executes_merges: bool,
    adapter_factory: Callable[[], Any] | None = None,
    pr_enumerator: Callable[[Any], list[int]] | None = None,
    readiness_claim_resolver: Callable[[Any, int, str | Path | None], str] | None = None,
    base_dir: str | Path | None = None,
    intent_publisher: Callable[[dict[str, Any]], dict[str, Any]] | None = None,
    operator_stop: OperatorStopSource | None = None,
) -> AutoMergeRunner:
    """Plan ARIA-V3 §A1 — profile-derived runner factory.

    The real/no-op split is ``runtime_profile.GITHUB_LIVE_PROFILES`` /
    ``GITHUB_RECORDING_PROFILES``, derived from ``ACTION_PERMISSIONS``
    where the profile is declared (ARIA-MEDIUM-467). A string outside
    ``runtime_profile.PROFILES`` raises ``ValueError``.

    ARIA-MEDIUM-226 — the merge lane (``executes_merges``) gets the real
    runner whenever ``runtime_profile.merge_authority_available`` says merge
    authority exists: the predicate the runner itself and the merge
    authority read. Keyed on the profile alone, a ``standard`` profile
    holding an operator's merge-lane grant got the no-op runner here while
    the authority below would have merged — the grant could never be used.
    The nightly cycle (``executes_merges=False``) is unchanged.
    """
    from .runtime_profile import GITHUB_LIVE_PROFILES, GITHUB_RECORDING_PROFILES, merge_authority_available

    if profile in GITHUB_LIVE_PROFILES or (
        executes_merges and merge_authority_available(base_dir=base_dir)
    ):
        return RealAutoMergeRunner(
            profile=profile,
            executes_merges=executes_merges,
            adapter_factory=adapter_factory,
            pr_enumerator=pr_enumerator,
            readiness_claim_resolver=readiness_claim_resolver,
            intent_publisher=intent_publisher,
            operator_stop=operator_stop,
        )
    if profile in GITHUB_RECORDING_PROFILES:
        return NoOpAutoMergeRunner(profile=profile)
    raise ValueError(
        f"unknown profile for auto_merge_runner selection: {profile!r}; "
        f"known: {sorted(GITHUB_LIVE_PROFILES | GITHUB_RECORDING_PROFILES)}"
    )


def enumerate_prs_with_readiness_claims(
    adapter: Any,
    *,
    base_dir: str | Path | None,
) -> list[int]:
    """The merge candidates: open PRs whose CURRENT head holds a readiness claim.

    ARIA-HIGH-222 — every PR that ever held a claim used to be a candidate,
    so the lane evaluated merged and closed PRs on every run and there was
    never a run with nothing to do: the hourly schedule published every
    hour. A candidate is now a PR GitHub lists as open whose live head is a
    head a claim names — the set a merge could act on. An adapter that
    observes nothing (the recording adapter) yields no candidates.
    """
    from .readiness_proofs import recorded_claim_heads

    claimed = recorded_claim_heads(base_dir)
    if not claimed:
        return []
    open_heads = adapter.list_open_pull_request_heads()
    if open_heads is None:
        return []
    # ARIA-HIGH-221 — a PR ARIA enqueued at this head is the merge queue's
    # until the queue settles it (merge_authority.reconcile_enqueued_merges):
    # evaluating it again would enqueue it again.
    from .merge_authority import pending_enqueued_heads

    queued = pending_enqueued_heads(base_dir)
    return sorted(
        number for number, head_sha in open_heads.items()
        if (number, head_sha) in claimed and (number, head_sha) not in queued
    )


def resolve_readiness_claim_id_from_claims(
    adapter: Any,
    pr_number: int,
    base_dir: str | Path | None,
) -> str:
    pr = adapter.get_pr(pr_number)
    repo = first_present_string(pr, "repository", "repo", "repo_full_name")
    target_ref = first_present_string(pr, "target_ref", "base_branch", "baseRefName", "base")
    head_ref = first_present_string(pr, "head_ref", "headRefName")
    head_sha = first_present_string(pr, "head_sha", "headRefOid", "head")
    missing = [
        name for name, value in {
            "repo": repo,
            "target_ref": target_ref,
            "head_ref": head_ref,
            "head_sha": head_sha,
        }.items()
        if not isinstance(value, str) or not value.strip()
    ]
    if missing:
        raise GovernanceError("readiness_claim_pr_binding_fields_required:" + ",".join(missing))
    if not is_object_id(head_sha, formats=ANY_OBJECT_FORMAT):
        raise GovernanceError("readiness_claim_pr_head_sha_must_be_full_sha")
    rows = load_declared_jsonl(
        ensure_tools_dir(base_dir) / "enterprise" / "readiness-claims.jsonl",
        expected_surface="enterprise_readiness_claims",
    )
    matches: list[str] = []
    for row in rows:
        if row.get("pr_number") != pr_number:
            continue
        if repo and row.get("repo") != repo:
            continue
        if target_ref and row.get("target_ref") != target_ref:
            continue
        if head_ref and row.get("head_ref") != head_ref:
            continue
        if head_sha and row.get("head_sha") != head_sha:
            continue
        claim_id = row.get("readiness_claim_id")
        if isinstance(claim_id, str) and claim_id.strip():
            matches.append(claim_id)
    if len(matches) != 1:
        raise GovernanceError(
            "readiness_claim_exact_match_required: "
            f"pr={pr_number} matches={len(matches)}"
        )
    return matches[0]


__all__ = [
    "AutoMergeRunner",
    "NoOpAutoMergeRunner",
    "RealAutoMergeRunner",
    "enumerate_prs_with_readiness_claims",
    "resolve_readiness_claim_id_from_claims",
    "select_auto_merge_runner",
    # Plan ARIA-V9.6 — V9 implementation-phase merge surface (fail-closed)
    "compute_v9_idempotency_key",
    "evaluate_v9_implementation_merge",
    "V9MergeDecision",
]


# =============================================================================
# Plan ARIA-V9.6 — implementation-phase merge surface (fail-closed stub)
# =============================================================================
#
# STATUS (ARIA-MEDIUM-467): this surface merges nothing. ``evaluate_v9_implementation_merge``
# returns ``eligible=False`` with ``V9_MERGE_PATH_DISABLED_REJECTION_CLASS``
# on every call and never runs ``gh``. The real merge authority is
# ``merge_authority.merge_pr_if_ready``; ``auto_merge.merge_if_green`` only
# evaluates. The V9.6 banner that stood here claimed a synchronous
# ``gh pr merge --squash`` with CI polling and a branch-tip recheck, and the
# poller it described (``poll_pr_checks``) had no production caller, so it
# was removed rather than kept as a second, unreachable CI reader.


import json
from dataclasses import dataclass
from .digest import sha256_digest


@dataclass(frozen=True)
class V9MergeDecision:
    """Plan ARIA-V9.6 — frozen merge-decision record.

    The only producer, ``evaluate_v9_implementation_merge``, always
    returns ``eligible=False`` with ``rejection_class`` set to
    ``V9_MERGE_PATH_DISABLED_REJECTION_CLASS`` (see the STATUS note
    above): the record keeps the V9 call sites auditable, not mergeable.

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
    return sha256_digest(raw)


def evaluate_v9_implementation_merge(
    *,
    plan_id: str,
    pr_number: int,
    diff_hash: str,
    branch_tip_sha: str,
    base_branch: str,
) -> V9MergeDecision:
    """Demoted V9 implementation merge surface; always refuses.

    ``merge_authority.merge_pr_if_ready`` is the single real-merge
    authority and ``auto_merge.merge_if_green`` only evaluates. This
    surface has no production caller; it answers with an auditable
    refusal keyed by the 5-tuple idempotency key and never calls ``gh``
    or otherwise touches a PR. Its inputs are exactly the key's fields:
    the profile, adapter, policy, ``gh`` binary and poll-sleep parameters
    of the merging implementation it replaced were dead once it refused
    unconditionally, and are gone.
    """
    from datetime import datetime, timezone

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
        rejection_class=V9_MERGE_PATH_DISABLED_REJECTION_CLASS,
        idempotency_key_hash=idempotency_key,
        decision_at_utc=decision_at,
        pre_merge_branch_tip_sha=None,
        merge_sha=None,
        check_summary=("v9_merge_path_disabled",),
    )
