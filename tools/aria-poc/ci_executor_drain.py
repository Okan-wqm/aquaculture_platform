"""Batch (drain) mode for the scheduled ARIA executor lane — ORPHAN-HIGH-637.

Separate module by design: `ci_executor.py` is the single-request engine
(~2500 lines, argv contract locked by I-V3-21); the loop that decides WHAT
to run next is an independent concern and lives here so neither file grows
past readability. Each request is still dispatched through the locked
single-request argv as a subprocess — claim/lease/submit semantics are
byte-identical to a targeted dispatch.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any, Mapping
import sys
import time
from pathlib import Path

# The single-request engine owns the stage logger and the optional
# governance-append binding; reuse them so drain rows land in the same
# audit stream with the same formatting.
_POC_DIR = Path(__file__).resolve().parent
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))
import ci_executor as _engine
import dispatch_failure as _dispatch_failure

# ARIA-HIGH-003 — the persistent breaker owners, bound at import when the
# kernel is reachable and None otherwise (the harness pattern the engine's
# own optional bindings use, so tests can patch the drain-level wrappers).
try:
    sys.path.insert(0, str(_POC_DIR.parents[1] / "aria-kernel"))
    from aria_kernel.circuit_breaker import evaluate_breaker, record_failure
    from aria_kernel.agent_surface import JUDGE_ROLES as _JUDGE_ROLES
except ImportError:  # pragma: no cover — kernel-less standalone import
    evaluate_breaker = None  # type: ignore[assignment]
    record_failure = None  # type: ignore[assignment]
    _JUDGE_ROLES = ()  # type: ignore[assignment]


# ARIA-HIGH-003 — failure classes that name an environment condition no
# fallback tier heals inside one drain: the first one opens the keyed
# same-run circuit for that (provider, model) so the remaining candidates
# on the same route are skipped WITHOUT claiming, and each occurrence is
# appended to the persistent breaker ledger.
ENVIRONMENT_FAILURE_CLASSES: frozenset[str] = frozenset(
    {
        "cli_unavailable",
        "auth_unavailable",
        "auth_failed",
        "usage_unavailable",
        "credit_exhausted",
        "provider_redirect_unavailable",
    }
)

# The closed dispatch-class → persistent breaker-kind mapping. Refusals and
# response-schema rejections are request-scoped outcomes, not outages, and
# deliberately have NO row here; process_exit/unknown stay visible in the
# aggregate but cannot trip a provider-wide circuit.
PERSISTENT_BREAKER_KIND_BY_CLASS: dict[str, str] = {
    "timeout": "subprocess_timeout",
    **{cls: "executor_environment_failure" for cls in ENVIRONMENT_FAILURE_CLASSES},
}

SELECTION_FAILURE_KIND = "executor_selection_failure"

# B8 (2026-09-12) — a child that exited without writing its dispatch summary.
# The summary is the ONLY evidence of success the drain accepts: a bare
# exit 0 used to count as drained, and under managed_subscription the
# native admission's target_revision_mismatch refusal (exit 0, no summary
# — a routine outcome whenever main moved past a request's target_sha) read
# as a green drain of requests nothing had dispatched. Classified here, in
# the drain's own vocabulary, because the child said nothing: the
# detail_code carries the exit code, the only fact the drain has.
CHILD_WITHOUT_SUMMARY_FAILURE_CLASS = "child_without_summary"


def _record_breaker_failure(
    tools_dir: Path,
    *,
    kind: str,
    materialize_event_id: str,
    extra: dict,
) -> None:
    if record_failure is None:
        return
    try:
        record_failure(
            base_dir=tools_dir,
            kind=kind,
            materialize_event_id=materialize_event_id,
            extra=extra,
        )
    except Exception as exc:  # noqa: BLE001 — a breaker-append failure must
        # not mask the drain result it is trying to record.
        sys.stderr.write(f"breaker_record_failed: {exc}\n")


def _breaker_state(tools_dir: Path) -> str:
    if evaluate_breaker is None:
        return "unknown"
    try:
        return evaluate_breaker(tools_dir).state
    except Exception as exc:  # noqa: BLE001 — unreadable evidence is the
        # breaker's own tripped verdict; a raise here would only lose the
        # drain's aggregate.
        sys.stderr.write(f"breaker_evaluate_failed: {exc}\n")
        return "unknown"


# ARIA-HIGH-158 — how many consecutive open-circuit skips end the drain.
# Five is above any plausible interleaving of routes in a healthy queue and
# below a minute of selection cost on the live store.
CIRCUIT_SKIP_STREAK_STOP = 5


def _circuit_label(key: tuple[str, str, str]) -> str:
    return "/".join(key)


def _joined_target_sha(dispatched_target_shas: set[str]) -> str:
    """One non-empty SHA when every dispatched request shared it, else "".

    A mixed-SHA drain (requests grounded at different trees) joins as the
    empty string: the aggregate refuses to name one evidence target for
    many trees, and the empty join reads as historical-only downstream.
    """
    non_empty = {sha for sha in dispatched_target_shas if sha}
    if len(non_empty) == 1:
        return next(iter(non_empty))
    return ""


def build_drain_governance_payload(
    *,
    attempted: int,
    succeeded: int,
    failed: int,
    stop_reason: str,
    failure_counts: dict[str, int],
    by_provider_model_role: dict[str, dict],
    failure_details: list[dict],
    open_circuits: set[tuple[str, str, str]],
    breaker_state: str,
    target_sha: str = "",
) -> dict:
    """ARIA-HIGH-003 — the schema-v2 ``executor_drain_completed`` aggregate.

    The legacy flat fields (attempted/succeeded/failed/stop_reason) stay
    top-level for the consumers that already read them; everything the
    three-drain checkpoint reconciles joins underneath. ``target_sha`` is
    the joined evidence target: non-empty only when every dispatched
    request carried the SAME trusted target SHA — a mixed-SHA drain joins
    as "" and stays honest instead of inventing one SHA for many trees.
    """
    return {
        "schema_version": 2,
        "attempted": attempted,
        "succeeded": succeeded,
        "failed": failed,
        "stop_reason": stop_reason,
        "failure_counts": dict(sorted(failure_counts.items())),
        "by_provider_model_role": {
            key: {
                "attempted": bucket["attempted"],
                "succeeded": bucket["succeeded"],
                "failed": bucket["failed"],
                "failure_classes": dict(sorted(bucket["failure_classes"].items())),
            }
            for key, bucket in sorted(by_provider_model_role.items())
        },
        "failure_details": failure_details,
        "circuit_breakers": sorted(_circuit_label(key) for key in open_circuits),
        "breaker_state": breaker_state,
        "target_sha": target_sha,
    }


# Drain-mode wall-clock budget: the time window the WHOLE loop must fit in,
# including the last child's worst case. The first live night (run
# 31542485896) proved elapsed-only accounting wrong: the loop started its
# third request at t=1987s — inside the 2100s budget — but that child could
# legally run MAX_TIMEOUT_SECONDS=1800s more, sailed past the job's
# 45-minute reaper, and the whole run was CANCELLED before the state
# publish: two submitted results died with the runner (the
# ORPHAN-CRITICAL-484 class). A child is now started only if its WORST
# CASE still fits inside the budget, and the workflow sizes the budget so
# publish always has its reserve.
#
# The default (no ARIA_DRAIN_BUDGET_SECONDS in the environment: a local
# operator drain, the tests) is DERIVED from one child's whole worst case
# (`ci_executor.child_worst_case_seconds`: claim, pre-claim probe, CLI run,
# submit, release — the engine's one derivation) at the engine's default
# CLI cap, plus the five-minute margin the old literal (2100 = 1800 + 300)
# carried over the old worst case. A literal here went stale the moment the
# submit wall clock grew: a budget below one child's worst case dispatches
# nothing, and a default that gates everything is worse than no default.
DRAIN_WINDOW_MARGIN_SECONDS = 300
DEFAULT_DRAIN_BUDGET_SECONDS = (
    _engine.child_worst_case_seconds(
        _engine.DEFAULT_TIMEOUT_SECONDS,
        # The env-less window must hold the child in EVERY policy shape:
        # the per-request worktree bracket is priced in whether or not the
        # repo's policy turns it on, and (ARIA-HIGH-124 round 3) the
        # implementation child's delivery in its canonical shape — the
        # publication, the contained gate at the canonical ceiling, the
        # push, the PR — is priced in whether or not tonight's queue holds
        # one: a default window that cannot start an implementation is a
        # lane that never delivers one.
        worktree_per_request=True,
        implementation_delivery_seconds=_engine.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
    )
    + DRAIN_WINDOW_MARGIN_SECONDS
)

# What the executor JOB needs OUTSIDE the drain window, priced from the
# bounds of the steps that run there, so the workflow's job timeout can be
# checked against the window it declares (`tests/test_state_lock_liveness_bound.py`
# reads both from the YAML):
#
# * the state restore before the loop — `checkout_state_store`'s whole
#   arc at the git cap (`state_store.STATE_STORE_CHECKOUT_ARC_SECONDS`:
#   the remote probes, the fetch, the pending-recovery replay, the old
#   store's removal, the new worktree's materialisation — the registered
#   steps of `state_store_lifecycle_arcs.CHECKOUT_RESTORE_ARC`, not a
#   count typed here);
# * the publish after it — the lifecycle holder's longest arc
#   (`state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS`: the pending
#   recovery, then every attempt's push, probe, fetches and tree move);
# * the steps around them that carry no kernel bound — checkout of main,
#   node dependencies (a cold `npm ci` measured 2m50s), the attestation
#   probe, integrity verification, the handoff snapshot, artifact uploads —
#   under one allowance.
#
# Until the child's claim and release waits were priced into the child, the
# reserve arithmetic spent two state-lock bounds of this on them; now the
# window charges the child, and the reserve is the job's own.
STATE_RESTORE_WORST_CASE_SECONDS = _engine._STATE_STORE_CHECKOUT_ARC_SECONDS
JOB_STEPS_ALLOWANCE_SECONDS = 900
JOB_RESERVE_SECONDS = int(
    STATE_RESTORE_WORST_CASE_SECONDS
    + _engine._STATE_STORE_LIFECYCLE_LIVENESS_SECONDS
    + JOB_STEPS_ALLOWANCE_SECONDS
)
# ARIA-HIGH-124 (round 3) — the part of that reserve the job still needs
# AFTER the drain (the publish arc and the steps allowance): what the
# workflow subtracts from its own ceiling, anchored at launch, to export the
# absolute deadline (`ARIA_JOB_DEADLINE_EPOCH`) every spawn and every
# delivery in the job runs under. The restore arc is spent BEFORE the drain,
# so it is inside the window's elapsed time, not after the deadline.
JOB_RESERVE_AFTER_DRAIN_SECONDS = int(
    _engine._STATE_STORE_LIFECYCLE_LIVENESS_SECONDS + JOB_STEPS_ALLOWANCE_SECONDS
)


# E3/D10b + Y4 (ORPHAN-705) — the full arc order, planning lane first.
# The four-role priority prefix fixed oldest-first starvation for the
# planning roles and created it for everyone it omitted: the second sealed
# night showed maintenance_utility and the adjudication roles queued behind
# 64 judge envelopes at ~9 drains/night — structurally never reached. Every
# dispatchable-or-minted role now has a place in the arc; the quota round
# below guarantees each WAITING role one slot per run before any role gets
# a second, and the fallback spends the remaining budget in this same order.
#
# ORPHAN-HIGH-786 — judges sit directly after the planning core, not last.
# The anti-starvation property is the QUOTA ROUND (one guaranteed slot per
# waiting role), never the arc order — the fallback only distributes
# SURPLUS. Judges were last "by design" and that design starved exactly the
# readiness-critical lane: anchor promotion needs `ANCHOR_PROMOTION_MIN_JUDGMENTS`
# verdict pairs, and the 2100s fallback budget was routinely spent before
# reaching positions 13-14, leaving judges their single quota slot against
# a 60-envelope nightly mint. Judges also precede arbitration deliberately:
# arbiter demand is DERIVED from judge verdicts (split groups exist only
# after judges return), so draining judges first matches the same-night
# data dependency.
_ROLE_QUOTA_ORDER: tuple[str, ...] = (
    "implementation",
    "cross_review",
    "challenger_plan",
    "primary_plan",
    "evidence_judgment",
    "adversarial_judgment",
    "consensus_arbitration",
    "human_required_adjudication",
    "completeness_critique",
    "verification",
    "change_intelligence",
    "goldset_curation",
    "specialist_domain_review",
    "maintenance_utility",
)


def absolute_pythonpath(value: str | None, *, repo_root: Path) -> str:
    """``PYTHONPATH`` for an executor child, with every entry ABSOLUTE.

    ARIA-HIGH-124 (round 4). The workflow exports ``PYTHONPATH=aria-kernel``
    — relative to the DRAIN's cwd, the checkout — and the drain launches the
    child with the request WORKTREE as its cwd, where Python resolves that
    same entry to ``<worktree>/aria-kernel``. Only ``aria-kernel/aria_kernel/``
    and ``aria-kernel/tests/invariants/`` are READONLY_PATHS, so the
    worktree's ``aria-kernel/`` ROOT is a directory the agent may write and
    commit into — and it sits on the executor's own ``sys.path``, ahead of
    the stdlib, for every lazily imported module (the round-1 leak, by a
    second door: there the agent planted an ``aria_kernel`` package at the
    worktree root and a ``-P`` closed it).

    Each entry is resolved against ``repo_root`` (never the child's cwd),
    and an EMPTY entry — which means "the current directory" — is dropped
    for the same reason. An absolute entry is kept as it is: an operator who
    names a path means that path.
    """
    entries: list[str] = []
    for entry in (value or "").split(os.pathsep):
        if not entry:
            continue
        path = Path(entry)
        resolved = path if path.is_absolute() else (Path(repo_root) / path)
        absolute = str(resolved.resolve())
        if absolute not in entries:
            entries.append(absolute)
    return os.pathsep.join(entries)


def _drain_budget_seconds() -> int:
    return int(
        os.environ.get("ARIA_DRAIN_BUDGET_SECONDS", DEFAULT_DRAIN_BUDGET_SECONDS)
    )


def _next_pending_for_role(
    *,
    tools_dir: Path,
    repo_root: Path,
    role_filter: str | None,
    attempted: set[str],
    target_agent: str | None = None,
) -> tuple[dict | None, str | None]:
    """One kernel next-pending query. Returns (candidate, error_reason).

    ``target_agent`` (typed-judgment plan Phase 4b) narrows the selection to
    one agent — the batch fill asks for siblings of the request it holds.
    """
    # The one spelling of a kernel CLI subprocess (`-P`: the cwd off
    # sys.path — the drain runs in the checkout, the child in a request
    # worktree; neither may resolve the kernel from where it stands).
    argv = _engine._kernel_cli_argv(
        "agent", "next-pending",
        "--tools-dir", str(tools_dir),
    )
    if role_filter is not None:
        argv += ["--role", role_filter]
    if target_agent:
        argv += ["--target-agent", target_agent]
    for excluded in sorted(attempted):
        argv += ["--exclude", excluded]
    pending_proc = subprocess.run(
        argv,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONPATH": str(repo_root / "aria-kernel")},
    )
    if pending_proc.returncode != 0:
        # The kernel names its own stop when it can (`anchor_verification_
        # unavailable`: candidates exist and git did not answer for them);
        # anything else is the generic selection failure.
        try:
            named = json.loads(pending_proc.stdout or "")
        except json.JSONDecodeError:
            named = None
        stop_reason = named.get("stop_reason") if isinstance(named, dict) else None
        if isinstance(stop_reason, str) and stop_reason:
            _engine._stage(
                f"drain_next_pending_stopped reason={stop_reason} "
                f"undecided={len(named.get('undecided_request_ids') or [])}"
            )
            return None, stop_reason
        _engine._stage(f"drain_next_pending_failed rc={pending_proc.returncode}")
        sys.stderr.write(pending_proc.stderr[-1000:] + "\n")
        return None, "next_pending_failed"
    try:
        candidate = json.loads(pending_proc.stdout or "null")
    except json.JSONDecodeError:
        _engine._stage("drain_next_pending_not_json")
        return None, "next_pending_not_json"
    if candidate and candidate.get("request_id"):
        return candidate, None
    return None, None


def _judge_batch_policy(repo_root: Path) -> tuple[int, tuple[str, ...]]:
    """`judge_batch_size` and `judge_batch_runtimes` from the judgment
    pipeline policy; (1, ()) when the kernel is unreachable — no batching."""
    try:
        from aria_kernel.genesis_policy import judgment_pipeline_policy
    except ImportError:  # pragma: no cover — kernel-less standalone import
        return 1, ()
    block = judgment_pipeline_policy(repo_root)
    return max(1, int(block["judge_batch_size"])), tuple(str(r) for r in block["judge_batch_runtimes"])


def _provider_runtime(provider_key: str) -> str | None:
    """The fleet's runtime hint for a provider key ('zai' for the kernel's
    own HTTP transport); None when the fleet does not know the key."""
    try:
        from aria_kernel.model_fleet import _FLEET
    except ImportError:  # pragma: no cover — kernel-less standalone import
        return None
    return next((entry.runtime_hint for entry in _FLEET if entry.key == provider_key), None)


def _batch_key(batch: list[dict]) -> str:
    """The batch child's summary-channel key: the same digest the child
    derives for its `batch_id` (`ci_executor_judge_batch._batch_id`)."""
    import hashlib
    digest = hashlib.sha256("\n".join(sorted(str(r["request_id"]) for r in batch)).encode("utf-8")).hexdigest()[:16]
    return f"jb-{digest}"


class _FinishedChild:
    """A completed serial child wearing the Popen `wait()` shape `_settle` expects."""

    def __init__(self, completed: "subprocess.CompletedProcess[Any]") -> None:
        self.returncode = completed.returncode

    def wait(self) -> int:
        return self.returncode


def _executor_policy(repo_root: Path) -> dict:
    """Plan 032 Faz 032h — the kernel's executor block (max_concurrent, worktree_per_request)."""
    try:
        from aria_kernel.genesis_policy import executor_policy

        return executor_policy(repo_root)
    except Exception as exc:  # noqa: BLE001 — an unreadable policy means the serial default
        _engine._stage(f"drain_executor_policy_unreadable {type(exc).__name__}")
        return {"max_concurrent": 1, "worktree_per_request": False}


# The per-request worktrees live INSIDE the checkout, under this directory,
# and nowhere else. Inside, because the child's validation commands resolve
# node modules by walking UP from their cwd: `<checkout>/aria-worktrees/req-x`
# reaches `<checkout>/node_modules` (measured: require.resolve and
# `npx --no-install` from a nested worktree both resolve the parent's
# modules); a sibling directory would never reach them. The directory is
# git-ignored, so the persistent workspace's `git status` never sees a
# worktree, and nx writes its cache to `<worktree>/.nx/cache` (nx.json's
# cacheDirectory is workspace-relative and the worktree carries nx.json),
# which goes with the worktree when it is removed.
from aria_kernel.request_worktree import REQUEST_WORKTREES_DIR  # noqa: E402 — the kernel's one spelling



# Plan 032 Faz 032h — the per-request worktree bracket. Each of its two git
# calls materialises or deletes a whole tree, so each gets the store's own
# git cap (`state_store.GIT_TIMEOUT_SECONDS`, via the engine's kernel
# mirror) and both are priced into the child
# (`ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS`). They ran with no
# bound at all until 2026-09-12: a git that stopped answering held the
# drain loop outside every window the loop checks.
REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS = _engine._GIT_TIMEOUT_SECONDS
# The breaker kind a worktree call that does not answer is recorded under —
# the taxonomy's own name for a bounded subprocess that hit its bound.
WORKTREE_UNANSWERED_BREAKER_KIND = "subprocess_timeout"
WORKTREE_UNAVAILABLE_STOP_REASON = "worktree_unavailable"


from aria_kernel.request_worktree import (  # noqa: E402 — after the kernel path insert above
    RequestWorktree as _RequestWorktree,
    add_request_worktree as _kernel_add_request_worktree,
    remove_request_worktree as _kernel_remove_request_worktree,
    request_worktree_path as _kernel_request_worktree_path,
    run_worktree_git as _kernel_run_worktree_git,
)


def _drain_git_runner(*args: Any, **kwargs: Any) -> "subprocess.CompletedProcess[str]":
    """The drain's own bounded runner — `ci_executor_drain.subprocess.run`
    resolved at call time, so the bracket tests that patch it see every
    worktree call."""
    return subprocess.run(*args, **kwargs)


def _request_worktree_path(repo_root: Path, request_id: str) -> Path:
    return _kernel_request_worktree_path(repo_root, request_id)


def request_worktree_target(request: Mapping[str, Any]) -> str | None:
    """The commit a request's worktree is added at: the request's anchor —
    its ``target_sha``, or (ARIA-HIGH-124) for an implementation request,
    which carried none, the staged ``implementation_ids.base_sha``: the
    commit the baseline was measured at and the branch the kernel stands
    the sandbox on is cut from. ARIA-HIGH-144 made that derivation the
    kernel's (``agent_invocations.request_anchor_sha``), read here and by
    the executor's native task binding alike, so the tree the drain adds is
    the tree the child admits. None means the checkout's HEAD (the read-only
    roles)."""
    from aria_kernel.agent_invocations import request_anchor_sha
    return request_anchor_sha(request)


def _run_worktree_git(argv: list[str], *, cwd: Path) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    """One bounded worktree call: (answer, None) or (None, why it did not answer)."""
    return _kernel_run_worktree_git(argv, cwd=cwd, timeout_seconds=REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS,
                                    run=_drain_git_runner)


def _add_request_worktree(repo_root: Path, request_id: str, target_sha: object) -> _RequestWorktree:
    """`git worktree add --detach aria-worktrees/req-<id> <target_sha|HEAD>`, bounded;
    `path=None` = fall back to the shared checkout. The one spelling lives in
    `aria_kernel.request_worktree` (ARIA-HIGH-176: the planner dispatch hook
    serves its requests from the same tree)."""
    return _kernel_add_request_worktree(repo_root, request_id, target_sha,
                                        timeout_seconds=REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS,
                                        log=_engine._stage, run=_drain_git_runner)


def _remove_request_worktree(repo_root: Path, path: Path) -> str | None:
    """`git worktree remove --force <path>`, bounded; returns why git did not answer, if it did not."""
    return _kernel_remove_request_worktree(repo_root, path, timeout_seconds=REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS,
                                           log=_engine._stage, run=_drain_git_runner)


def _operator_paused(tools_dir: Path) -> bool:
    """Plan 032 Faz 032e — `control pause` stops the drain from claiming."""
    try:
        from aria_kernel.control import effective_control, record_pause_skip

        state = effective_control(tools_dir)
    except Exception as exc:  # noqa: BLE001 — an unreadable control ledger is a stop, not a crash
        _engine._stage(f"drain_control_unreadable {type(exc).__name__}")
        return True
    if state.paused_all:
        try:
            record_pause_skip(base_dir=tools_dir, request_id=None, where="drain")
        except Exception:  # noqa: BLE001
            pass
        return True
    return False


def drain_pending(*, tools_dir: Path, repo_root: Path) -> int:
    """Consume pending agent requests until the queue, cap, or clock runs out.

    Why this exists: the nightly executor claimed exactly ONE request per run
    while the producer mints many per cycle, so the queue only ever grew —
    162 pending judge requests against a 1/day consumer is a lane that can
    never catch up. `MAX_REQUESTS_PER_RUN` was exported by the workflow and
    read by nothing, the exact "tunable that gates nothing" class this file
    already condemns (ORPHAN-HIGH-472). This loop makes it real.

    Each request still runs through the SINGLE-REQUEST path as a subprocess
    (`ci_executor.py <request_id> <target_agent>` — the argv shape locked by
    invariant I-V3-21), so claim/lease/submit semantics are byte-identical
    to a targeted dispatch. The loop only decides WHAT to run next:

    * queue empty → clean stop;
    * `MAX_REQUESTS_PER_RUN` reached → stop, the rest keeps until tomorrow;
    * wall-clock budget spent → stop starting new work;
    * next-pending returns a request this run already attempted → stop.
      A failed child releases its claim, so the same request surfaces again
      immediately; retrying it in the same environment would burn its whole
      requeue budget in one night pricing an environment fault as N request
      failures (the M-2.5 class the pre-claim gate exists to prevent).

    `target_agent` is passed through from the request row — the workflow's
    single-shot path passed only the request id, so every drained request
    would otherwise run under the `aria-evidence-judge` default profile even
    when the kernel minted it for a different agent.

    Exit code: 0 when every attempted dispatch succeeded or was refused by
    name (or none were pending); 1 when any child failed — the work that
    DID succeed is already submitted by the children, so a red run reports
    the failure without discarding the night's progress. Success is the
    child's ``succeeded`` summary and nothing else: a child that exited
    without a summary is a ``child_without_summary`` failure, and
    ``drained`` counts summaries, never exit codes.
    """
    started = time.monotonic()
    attempted: set[str] = set()
    # ARIA-HIGH-003 — requests skipped by the keyed same-run circuit. They
    # stay pending for a later healthy drain and are surfaced to the kernel
    # through the same --exclude API the attempted set uses, so the skip
    # never claims, releases, or marks them attempted.
    circuit_excluded: set[str] = set()
    # (round 3) requests whose own worst case does not fit tonight's
    # remaining window: skipped without a claim, excluded from selection.
    window_excluded: set[str] = set()
    open_circuits: set[tuple[str, str, str]] = set()
    # ARIA-HIGH-158 — consecutive circuit skips with nothing dispatched
    # between them. Each skip re-runs the queue selection (a kernel
    # subprocess over the whole request ledger, ~30 s on the live store), so
    # an open route walked the 800-row backlog for hours on the first
    # production drain (run 35369756222) after two failures. A streak of
    # skips says the route is the problem, not the request: the drain stops
    # by name and the queue stays pending for the next healthy drain.
    circuit_skip_streak = 0
    failure_counts: dict[str, int] = {}
    by_provider_model_role: dict[str, dict] = {}
    failure_details: list[dict] = []
    # ARIA-HIGH-003 — the joined evidence target: the set of trusted
    # target SHAs carried by the requests actually dispatched this run.
    dispatched_target_shas: set[str] = set()
    # Y4 (ORPHAN-705) — roles still owed their guaranteed slot this run.
    quota_pending: list[str] = list(_ROLE_QUOTA_ORDER)
    succeeded = 0
    failed = 0
    stop_reason = "queue_empty"
    envelope_paths: list[str] = []
    transcript_paths: list[str] = []
    parent_github_output = os.environ.get("GITHUB_OUTPUT")
    run_ref = os.environ.get("GITHUB_RUN_ID", "local")

    def _bucket(route_key: str) -> dict:
        return by_provider_model_role.setdefault(
            route_key,
            {"attempted": 0, "succeeded": 0, "failed": 0, "failure_classes": {}},
        )


    executor_cfg = _executor_policy(repo_root)
    max_concurrent = int(executor_cfg["max_concurrent"])
    worktree_per_request = bool(executor_cfg["worktree_per_request"])
    judge_batch_size, judge_batch_runtimes = _judge_batch_policy(repo_root)

    def _batch_fill_cap(elapsed_seconds: float) -> int:
        """How many requests one batch child may still legally serve inside
        the window: the largest K whose `batch_worst_case_seconds(K)` fits."""
        k = 1
        while k < judge_batch_size and elapsed_seconds + _engine._batch_worst_case_seconds(
            k + 1, worktree_per_request=worktree_per_request,
        ) <= _drain_budget_seconds():
            k += 1
        return k
    inflight: list[dict] = []

    def _launch(request: dict, request_id: str, target_agent: str, worktree: Path | None,
                batch: list[dict] | None = None) -> None:
        """Start one child (Plan 032 Faz 032h: in its own worktree when one was added).

        ``batch`` (typed-judgment plan Phase 4b) is the list of requests a
        batch child serves — ``request`` is its first member; the child is
        `ci_executor.py --judge-batch <role> <target_agent> <id>...` and its
        summary channel is keyed by the batch, not the first request.
        """
        if batch:
            child_key = _batch_key(batch)
            child_argv = ["python3", str(_POC_DIR / "ci_executor.py"), "--judge-batch",
                          str(request.get("role") or ""), target_agent, *[str(r["request_id"]) for r in batch]]
        else:
            child_key = request_id
            child_argv = ["python3", str(_POC_DIR / "ci_executor.py"), request_id]
            if target_agent:
                child_argv.append(target_agent)
        # The child writes its summary under RUNNER_TEMP and publishes the
        # path through GITHUB_OUTPUT; both are handed to it explicitly so the
        # summary channel exists wherever the drain runs (a local drain with
        # no RUNNER_TEMP would otherwise make every child summary-less). The
        # store is handed over the same way: the child derives its tools dir
        # from ARIA_TOOLS_DIR or else `<cwd>/aria-tools`, and with a worktree
        # as cwd that fallback is the tracked skeleton at target_sha, not the
        # store this drain selected the request from.
        runner_temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
        child_output = runner_temp / f"aria-drain-output-{child_key}.txt"
        child_env = {**os.environ, "GITHUB_OUTPUT": str(child_output), "RUNNER_TEMP": str(runner_temp),
                     "ARIA_TOOLS_DIR": str(tools_dir),
                     # ARIA-HIGH-124 (round 4) — the child's import path is
                     # THIS checkout's, never its cwd's.
                     "PYTHONPATH": absolute_pythonpath(os.environ.get("PYTHONPATH"), repo_root=repo_root)}
        cwd = repo_root
        if worktree is not None:
            cwd = worktree
            child_env["ARIA_WORKSPACE_ROOT"] = str(worktree)
        _engine._stage(
            f"drain_dispatch request_id={request_id} target={target_agent or '-'} "
            f"concurrency={len(inflight) + 1}/{max_concurrent} worktree={'yes' if worktree else 'no'}"
            + (f" batch={child_key} k={len(batch)}" if batch else "")
        )
        if max_concurrent <= 1:
            # Serial lane (the default): the same blocking `subprocess.run` the
            # lane always used, so its contract — and every test that fakes the
            # child through `subprocess.run` — is byte-identical to pre-032h.
            proc: Any = _FinishedChild(subprocess.run(child_argv, env=child_env, cwd=str(cwd)))
        else:
            proc = subprocess.Popen(child_argv, env=child_env, cwd=str(cwd))
        inflight.append({"request": request, "request_id": request_id, "output": child_output, "proc": proc,
                         "worktree": worktree, "requests": list(batch) if batch else [request], "child_key": child_key})

    def _settle(entry: dict) -> None:
        """Wait for one child and account for it (the pre-032h loop body, verbatim)."""
        nonlocal succeeded, failed
        request = entry["request"]
        request_id = entry["request_id"]
        child_output = entry["output"]
        child = entry["proc"]
        try:
            child.wait()
        finally:
            if entry["worktree"] is not None:
                unanswered = _remove_request_worktree(repo_root, entry["worktree"])
                if unanswered is not None:
                    # The tree lingers and git is not answering on this
                    # runner: the breaker's evidence, not the request's.
                    _record_breaker_failure(
                        tools_dir,
                        kind=WORKTREE_UNANSWERED_BREAKER_KIND,
                        materialize_event_id=f"drain:{run_ref}:{request_id}:worktree-remove",
                        extra={
                            "stage": "worktree_remove",
                            "reason": unanswered,
                            "request_id": request_id,
                            "run_id": run_ref,
                        },
                    )
        # Typed-judgment plan Phase 4b — a batch child writes one summary per
        # request it served; every `dispatch_summary_path=` line is read and
        # keyed by the summary's own request_id (a foreign id is ignored),
        # and each request the child was launched with is accounted from its
        # own summary. The single-request child is the K = 1 case: the last
        # line wins for its one id, as it always did.
        summaries: dict[str, dict] = {}
        if child_output.exists():
            for line in child_output.read_text(encoding="utf-8").splitlines():
                if line.startswith("envelope_path="):
                    envelope_paths.append(line.split("=", 1)[1])
                elif line.startswith("transcript_path="):
                    transcript_paths.append(line.split("=", 1)[1])
                elif line.startswith("dispatch_summary_path="):
                    summary_path = Path(line.split("=", 1)[1])
                    try:
                        read = json.loads(summary_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        _engine._stage(
                            f"drain_summary_unreadable request_id={request_id}: {exc}"
                        )
                        continue
                    summary_id = str((read or {}).get("request_id") or request_id)
                    summaries[summary_id] = read
            child_output.unlink()
        breaker_recorded: set[str] = set()
        for member in entry.get("requests") or [request]:
            member_id = str(member.get("request_id") or request_id)
            _account_request(member, member_id, summaries.get(member_id), child, breaker_recorded)

    def _account_request(request: dict, request_id: str, summary: dict | None, child: Any,
                         breaker_recorded: set[str]) -> None:
        """Fold ONE request's terminal outcome (the pre-4b `_settle` tail, verbatim);
        the persistent breaker is told once per child per kind."""
        nonlocal succeeded, failed

        # ARIA-HIGH-003 — classify the terminal outcome from the child's own
        # v1 summary and fold it into the circuit, the persistent breaker,
        # and the schema-v2 aggregate. B8: the summary is the only evidence
        # of success; a child that wrote none is a named failure whatever
        # its exit code, and a refusal is neither success nor failure.
        outcome = (summary or {}).get("outcome")
        failure_class = (summary or {}).get("failure_class")
        detail_code = (summary or {}).get("failure_detail_code")
        provider = str((summary or {}).get("provider") or "unknown")
        model = str((summary or {}).get("model") or "unknown")
        role = str(
            (summary or {}).get("role") or request.get("role") or "unknown",
        )
        route_key = f"{provider}/{model}/{role}"
        bucket = _bucket(route_key)
        bucket["attempted"] += 1
        if outcome == "refused":
            # A refusal — the model's, the contract's, or the executor's own
            # admission (target_revision_mismatch, no_eligible_provider, a
            # budget signal, an operator cancel) — is not a build failure and
            # never a breaker event: it stays visible as the
            # attempted/succeeded/failed delta, and its detail names why.
            _engine._stage(f"drain_child_refused request_id={request_id} detail={detail_code or '-'}")
        elif outcome == "succeeded":
            succeeded += 1
            bucket["succeeded"] += 1
        else:
            failed += 1
            bucket["failed"] += 1
            if summary is None:
                counted_class = CHILD_WITHOUT_SUMMARY_FAILURE_CLASS
                detail_code = f"exit_{child.returncode}"
                _engine._stage(f"drain_child_without_summary request_id={request_id} rc={child.returncode}")
            else:
                counted_class = str(failure_class or "unknown")
            failure_counts[counted_class] = failure_counts.get(counted_class, 0) + 1
            bucket["failure_classes"][counted_class] = (
                bucket["failure_classes"].get(counted_class, 0) + 1
            )
            failure_details.append(
                {
                    "request_id": request_id,
                    "failure_class": counted_class,
                    "retryable": bool((summary or {}).get("retryable")),
                    "detail_code": detail_code,
                    "provider": provider,
                    "model": model,
                }
            )
            persistent_kind = PERSISTENT_BREAKER_KIND_BY_CLASS.get(counted_class)
            if persistent_kind is not None and persistent_kind not in breaker_recorded:
                # One vendor event is one breaker failure however many
                # requests the child served (Phase 4b review, C3).
                breaker_recorded.add(persistent_kind)
                _record_breaker_failure(
                    tools_dir,
                    kind=persistent_kind,
                    materialize_event_id=f"drain:{run_ref}:{request_id}",
                    extra={
                        "failure_class": counted_class,
                        "provider": provider,
                        "model": model,
                        "request_id": request_id,
                        "run_id": run_ref,
                    },
                )
            if counted_class in ENVIRONMENT_FAILURE_CLASSES:
                open_circuits.add((provider, model, counted_class))

    while True:
        # Plan 032 Faz 032e — operator pause: nothing new is claimed.
        if _operator_paused(tools_dir):
            stop_reason = "operator_paused"
            break
        if len(attempted) >= _engine._max_requests():
            stop_reason = "max_requests_reached"
            break
        # A child may legally run its whole worst case — the claim (its
        # lock wait and the pre-claim git probe), the Claude CLI at
        # MAX_TIMEOUT_SECONDS, the kernel submit at its wall clock and the
        # release (`_engine._child_worst_case_seconds`, the one derivation);
        # start it only if that still fits inside the budget. Elapsed-only
        # accounting let the first live night start a request at t=1987s of
        # a 2100s budget and get the whole run reaped mid-child (run
        # 31542485896); pricing the CLI cap alone let a submit that waited
        # its full lock bound run past the window into the publish reserve;
        # pricing the CLI cap and the submit alone left two lock waits and a
        # probe to spill the same way.
        elapsed = time.monotonic() - started
        if (
            elapsed + _engine._child_worst_case_seconds(worktree_per_request=worktree_per_request)
            > _drain_budget_seconds()
        ):
            stop_reason = "budget_exhausted"
            break
        # Smoke-run 31653106474 — the JOB deadline is a drain-level stop,
        # not a per-request failure: the refused-spawn error was treated as
        # one request failing, so the loop kept iterating request after
        # request (each burning preflight seconds) into the job wall while
        # the night's state went unterminated → quarantined. Same env
        # contract as the spawn clamp (ORPHAN-661); no env → never stops.
        raw_deadline = os.environ.get("ARIA_JOB_DEADLINE_EPOCH")
        if raw_deadline:
            try:
                if time.time() >= float(raw_deadline):
                    stop_reason = "job_deadline_reached"
                    break
            except ValueError:
                pass  # the spawn clamp already refuses garbage loudly

        # E3/F10 + D10b + Y4 (ORPHAN-705) — quota round, then arc-order
        # fallback, with tonight's attempted ∪ circuit-excluded sets
        # EXCLUDED at the kernel.
        excluded = attempted | circuit_excluded | window_excluded
        request = None
        selection_error = None
        while quota_pending and request is None and selection_error is None:
            role_filter = quota_pending.pop(0)
            candidate, selection_error = _next_pending_for_role(
                tools_dir=tools_dir, repo_root=repo_root,
                role_filter=role_filter, attempted=excluded,
            )
            if candidate is not None:
                request = candidate
        if request is None and selection_error is None:
            for role_filter in _ROLE_QUOTA_ORDER + (None,):
                candidate, selection_error = _next_pending_for_role(
                    tools_dir=tools_dir, repo_root=repo_root,
                    role_filter=role_filter, attempted=excluded,
                )
                if selection_error is not None or candidate is not None:
                    request = candidate
                    break
        if selection_error is not None:
            # Infrastructure: the drain could not even choose work. This IS a
            # drain failure (ORPHAN-HIGH-737 keeps this arm red on purpose).
            _record_breaker_failure(
                tools_dir,
                kind=SELECTION_FAILURE_KIND,
                materialize_event_id=f"drain:{run_ref}:selection",
                extra={"stop_reason": selection_error, "run_id": run_ref},
            )
            stop_reason = selection_error
            failed += 1
            break
        request_id = (request or {}).get("request_id")
        if not request_id:
            # Nothing pending outside tonight's excluded sets — the queue
            # is exhausted for this run (clean stop, not a failure).
            break

        # ARIA-HIGH-003 — resolve the route pre-dispatch (the trusted row is
        # the identity); an open circuit on that (provider, model) skips the
        # request WITHOUT claiming it. Burning the quota slot on a skip is
        # accepted: the request stays pending and the next healthy drain
        # re-quotas it.
        try:
            route = _dispatch_failure.resolve_dispatch_route(
                request=request, repo_root=repo_root,
            )
        except ValueError:
            route = None
        if route is not None and any(
            route.provider == provider and route.model == model
            for (provider, model, _failure_class) in open_circuits
        ):
            circuit_excluded.add(request_id)
            _engine._stage(
                f"drain_circuit_skip request_id={request_id} "
                f"route={route.provider}/{route.model}"
            )
            circuit_skip_streak += 1
            if circuit_skip_streak >= CIRCUIT_SKIP_STREAK_STOP:
                stop_reason = "circuit_open_streak"
                _engine._stage(
                    f"drain_circuit_open_streak skips={circuit_skip_streak} "
                    f"open={','.join(sorted(_circuit_label(key) for key in open_circuits))}"
                )
                break
            continue
        circuit_skip_streak = 0
        # ARIA-HIGH-124 (round 3) — THIS request's whole worst case, now that
        # the request is known: an implementation child runs the quarantine's
        # publication, the contained apply gate at the STAGED suite's ceiling
        # per command, the push and the PR after the CLI
        # (`_engine._request_delivery_seconds`, off the staged action — a
        # plan's recipes make it larger than the canonical shape the window
        # check above priced). A request that does not fit the remaining
        # window is skipped by name without a claim — it stays PENDING for a
        # drain with the room — and excluded from tonight's selection, so the
        # roles that fit keep draining; the whole loop stops only when the
        # cheapest child no longer fits (the check above).
        # Typed-judgment plan Phase 4b — a judge request on a batchable
        # route gathers siblings: same role, same agent, same anchor, up to
        # `judge_batch_size` and what the window and the run cap leave.
        # The fill stops at the first key mismatch and excludes nothing
        # (the mismatched candidate is the next round's first pick).
        batch_members: list[dict] = [request]
        if (
            judge_batch_size > 1
            and route is not None
            and _provider_runtime(route.provider) in judge_batch_runtimes
            and str(request.get("role") or "") in _JUDGE_ROLES
        ):
            batch_cap = min(
                judge_batch_size,
                _engine._max_requests() - len(attempted) - len(quota_pending),
                _batch_fill_cap(time.monotonic() - started),
            )
            batch_excluded = set(excluded) | {request_id}
            while len(batch_members) < batch_cap:
                sibling, sibling_error = _next_pending_for_role(
                    tools_dir=tools_dir, repo_root=repo_root, role_filter=str(request.get("role") or ""),
                    attempted=batch_excluded, target_agent=str(request.get("target_agent") or ""),
                )
                if sibling_error is not None or sibling is None:
                    break
                if (
                    str(sibling.get("target_agent") or "") != str(request.get("target_agent") or "")
                    or str(sibling.get("target_sha") or "") != str(request.get("target_sha") or "")
                ):
                    break
                batch_members.append(sibling)
                batch_excluded.add(str(sibling["request_id"]))
        if len(batch_members) > 1:
            request_worst_case = _engine._batch_worst_case_seconds(
                len(batch_members), worktree_per_request=worktree_per_request,
            )
        else:
            request_worst_case = _engine._child_worst_case_seconds(
                worktree_per_request=worktree_per_request,
                implementation_delivery_seconds=_engine._request_delivery_seconds(
                    tools_dir=tools_dir, request_id=request_id,
                ),
            )
        elapsed = time.monotonic() - started
        if elapsed + request_worst_case > _drain_budget_seconds():
            window_excluded.add(request_id)
            _engine._stage(
                f"drain_window_skip request_id={request_id} "
                f"worst_case_seconds={request_worst_case} remaining_seconds={int(_drain_budget_seconds() - elapsed)}"
            )
            if _engine._append_tools_governance is not None:
                _engine._append_tools_governance(
                    tools_dir, "executor_drain_window_skip",
                    {"request_id": request_id, "run_id": run_ref, "worst_case_seconds": request_worst_case,
                     "remaining_seconds": int(_drain_budget_seconds() - elapsed)},
                )
            continue
        worktree = None
        if worktree_per_request:
            added = _add_request_worktree(repo_root, request_id, request_worktree_target(request))
            if added.unanswered_reason is not None:
                # Git did not answer inside the store's own cap. The child is
                # NOT started — it would claim a request on a runner whose
                # git is not answering — so the request stays PENDING for the
                # next drain, and the drain stops: the next request's add
                # would cost the same bound for the same answer.
                _record_breaker_failure(
                    tools_dir,
                    kind=WORKTREE_UNANSWERED_BREAKER_KIND,
                    materialize_event_id=f"drain:{run_ref}:{request_id}:worktree-add",
                    extra={
                        "stage": "worktree_add",
                        "reason": added.unanswered_reason,
                        "request_id": request_id,
                        "run_id": run_ref,
                    },
                )
                stop_reason = WORKTREE_UNAVAILABLE_STOP_REASON
                failed += 1
                break
            worktree = added.path
        for member in batch_members:
            attempted.add(str(member["request_id"]))
        dispatched_target_shas.add(str(request.get("target_sha") or ""))

        target_agent = str(request.get("target_agent") or "").strip()
        _launch(request, request_id, target_agent, worktree, batch=batch_members if len(batch_members) > 1 else None)
        if len(inflight) >= max_concurrent:
            _settle(inflight.pop(0))

    while inflight:
        _settle(inflight.pop(0))
    _engine._stage(
        f"drain_done attempted={len(attempted)} succeeded={succeeded} "
        f"failed={failed} stop={stop_reason} "
        f"circuit_skipped={len(circuit_excluded)} window_skipped={len(window_excluded)}"
    )
    if _engine._append_tools_governance is not None:
        try:
            _engine._append_tools_governance(
                tools_dir,
                "executor_drain_completed",
                build_drain_governance_payload(
                    attempted=len(attempted),
                    succeeded=succeeded,
                    failed=failed,
                    stop_reason=stop_reason,
                    failure_counts=failure_counts,
                    by_provider_model_role=by_provider_model_role,
                    failure_details=failure_details,
                    open_circuits=open_circuits,
                    breaker_state=_breaker_state(tools_dir),
                    target_sha=_joined_target_sha(dispatched_target_shas),
                ),
            )
        except Exception as exc:  # noqa: BLE001 — governance-write failure
            # must not mask the drain result it is trying to record.
            sys.stderr.write(f"governance_write_failed: {exc}\n")

    if parent_github_output:
        with open(parent_github_output, "a", encoding="utf-8") as handle:
            handle.write("envelope_path<<ARIA_DRAIN_EOF\n")
            handle.write("".join(f"{path}\n" for path in envelope_paths))
            handle.write("ARIA_DRAIN_EOF\n")
            handle.write("transcript_path<<ARIA_DRAIN_EOF\n")
            handle.write("".join(f"{path}\n" for path in transcript_paths))
            handle.write("ARIA_DRAIN_EOF\n")
            handle.write(f"drained={succeeded}\n")
            handle.write(f"drain_failed={failed}\n")
    return 0 if failed == 0 else 1
