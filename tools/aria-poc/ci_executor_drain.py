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
except ImportError:  # pragma: no cover — kernel-less standalone import
    evaluate_breaker = None  # type: ignore[assignment]
    record_failure = None  # type: ignore[assignment]


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

# ARIA-HIGH-159 — admission refusals that are facts about the FLEET, not the
# request: every provider decided and none is eligible. A child refused this
# way costs a full selection + spawn admission (~35 s on the live store) and
# the next request meets the same fleet, so a streak of them ends the drain
# by name; the queue stays pending. Per-request refusals (a target revision
# mismatch, a budget signal, an operator cancel) never count.
FLEET_REFUSAL_DETAILS: tuple[str, ...] = ("no_eligible_provider",)


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
) -> tuple[dict | None, str | None]:
    """One kernel next-pending query. Returns (candidate, error_reason)."""
    # The one spelling of a kernel CLI subprocess (`-P`: the cwd off
    # sys.path — the drain runs in the checkout, the child in a request
    # worktree; neither may resolve the kernel from where it stands).
    argv = _engine._kernel_cli_argv(
        "agent", "next-pending",
        "--tools-dir", str(tools_dir),
    )
    if role_filter is not None:
        argv += ["--role", role_filter]
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
REQUEST_WORKTREES_DIR = "aria-worktrees"



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


@dataclass(frozen=True)
class _RequestWorktree:
    """What `git worktree add` came back with: a tree, a refusal, or no answer.

    ``path`` is the worktree when git created it; ``None`` with no
    ``unanswered_reason`` means git ANSWERED that it could not (the shared
    checkout is used instead, as before); ``unanswered_reason`` names why
    git did not answer inside its bound — the harness's condition, on which
    the child is not started and the request stays PENDING.
    """

    path: Path | None
    unanswered_reason: str | None = None


def _run_worktree_git(argv: list[str], *, cwd: Path) -> tuple[subprocess.CompletedProcess[str] | None, str | None]:
    """One bounded worktree call: (answer, None) or (None, why it did not answer)."""
    try:
        done = subprocess.run(
            argv, cwd=str(cwd), capture_output=True, text=True, check=False,
            timeout=REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError as exc:
        return None, f"spawn_failed:{type(exc).__name__}"
    return done, None



def _request_worktree_path(repo_root: Path, request_id: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in str(request_id))[:64]
    return Path(repo_root) / REQUEST_WORKTREES_DIR / f"req-{safe}"


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


def _add_request_worktree(repo_root: Path, request_id: str, target_sha: object) -> _RequestWorktree:
    """`git worktree add --detach aria-worktrees/req-<id> <target_sha|HEAD>`, bounded; `path=None` = fall back to the shared checkout.

    WHY a worktree per request: under managed_subscription the native
    admission binds request.target_sha == the checkout's HEAD, so a request
    can only be served from a tree at its own target_sha; the shared
    checkout (main, moving nightly) refuses every request minted before its
    last advance. The child inherits ARIA_TOOLS_DIR (the persistent store,
    exported by restore-aria-state as an absolute path), so its ledgers
    never land inside the worktree; ARIA_WORKSPACE_ROOT points every
    workspace-bound path at the worktree.

    A leftover registration is reconciled first: a run reaped mid-child
    leaves `.git/worktrees/req-<id>` registered — with its directory gone
    (the next checkout's clean) `git worktree add` refuses "missing but
    already registered" until pruned; with the directory still there it
    refuses "already exists" until removed. Both are git's own reconcile
    commands, run before the add, so the same request id can be drained
    again tomorrow instead of falling back to the shared checkout and its
    target mismatch.
    """
    path = _request_worktree_path(repo_root, request_id)
    ref = str(target_sha or "").strip() or "HEAD"
    path.parent.mkdir(parents=True, exist_ok=True)
    pruned, unanswered = _run_worktree_git(["git", "worktree", "prune"], cwd=Path(repo_root))
    if pruned is None:
        _engine._stage(
            f"drain_worktree_prune_unanswered request_id={request_id} reason={unanswered} "
            f"bound={REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS}s"
        )
        return _RequestWorktree(path=None, unanswered_reason=unanswered)
    if pruned.returncode != 0:
        _engine._stage(f"drain_worktree_prune_failed rc={pruned.returncode} {(pruned.stderr or '').strip()[:120]}")
    if path.exists():
        _engine._stage(f"drain_worktree_leftover_removed request_id={request_id} path={path}")
        leftover_unanswered = _remove_request_worktree(repo_root, path)
        if leftover_unanswered is not None:
            return _RequestWorktree(path=None, unanswered_reason=leftover_unanswered)
    done, unanswered = _run_worktree_git(
        ["git", "worktree", "add", "--detach", str(path), ref], cwd=Path(repo_root),
    )
    if done is None:
        _engine._stage(
            f"drain_worktree_add_unanswered request_id={request_id} reason={unanswered} "
            f"bound={REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS}s"
        )
        return _RequestWorktree(path=None, unanswered_reason=unanswered)
    if done.returncode != 0:
        _engine._stage(f"drain_worktree_add_failed request_id={request_id} rc={done.returncode} {(done.stderr or '').strip()[:120]}")
        return _RequestWorktree(path=None)
    return _RequestWorktree(path=path)


def _remove_request_worktree(repo_root: Path, path: Path) -> str | None:
    """`git worktree remove --force <path>`, bounded; returns why git did not answer, if it did not."""
    done, unanswered = _run_worktree_git(
        ["git", "worktree", "remove", "--force", str(path)], cwd=Path(repo_root),
    )
    if done is None:
        _engine._stage(
            f"drain_worktree_remove_unanswered path={path} reason={unanswered} "
            f"bound={REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS}s"
        )
        return unanswered
    if done.returncode != 0:
        _engine._stage(f"drain_worktree_remove_failed path={path} rc={done.returncode}")
    return None


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
    fleet_refusal_streak = 0
    fleet_stop_reason: str | None = None
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
    inflight: list[dict] = []

    def _launch(request: dict, request_id: str, target_agent: str, worktree: Path | None) -> None:
        """Start one child (Plan 032 Faz 032h: in its own worktree when one was added)."""
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
        child_output = runner_temp / f"aria-drain-output-{request_id}.txt"
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
        )
        if max_concurrent <= 1:
            # Serial lane (the default): the same blocking `subprocess.run` the
            # lane always used, so its contract — and every test that fakes the
            # child through `subprocess.run` — is byte-identical to pre-032h.
            proc: Any = _FinishedChild(subprocess.run(child_argv, env=child_env, cwd=str(cwd)))
        else:
            proc = subprocess.Popen(child_argv, env=child_env, cwd=str(cwd))
        inflight.append({"request": request, "request_id": request_id, "output": child_output, "proc": proc, "worktree": worktree})

    def _settle(entry: dict) -> None:
        """Wait for one child and account for it (the pre-032h loop body, verbatim)."""
        nonlocal succeeded, failed, fleet_refusal_streak, fleet_stop_reason
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
        summary: dict | None = None
        if child_output.exists():
            for line in child_output.read_text(encoding="utf-8").splitlines():
                if line.startswith("envelope_path="):
                    envelope_paths.append(line.split("=", 1)[1])
                elif line.startswith("transcript_path="):
                    transcript_paths.append(line.split("=", 1)[1])
                elif line.startswith("dispatch_summary_path="):
                    summary_path = Path(line.split("=", 1)[1])
                    try:
                        summary = json.loads(summary_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError) as exc:
                        _engine._stage(
                            f"drain_summary_unreadable request_id={request_id}: {exc}"
                        )
            child_output.unlink()

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
            if detail_code in FLEET_REFUSAL_DETAILS:
                fleet_refusal_streak += 1
                if fleet_refusal_streak >= CIRCUIT_SKIP_STREAK_STOP and fleet_stop_reason is None:
                    fleet_stop_reason = f"fleet_refusal_streak:{detail_code}"
                    _engine._stage(
                        f"drain_fleet_refusal_streak refusals={fleet_refusal_streak} detail={detail_code}"
                    )
            else:
                fleet_refusal_streak = 0
        elif outcome == "succeeded":
            fleet_refusal_streak = 0
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
            if persistent_kind is not None:
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
        # ARIA-HIGH-159 — a settled child said the fleet refuses everyone:
        # nothing new is claimed; the queue stays pending for a fleet that can.
        if fleet_stop_reason is not None:
            stop_reason = fleet_stop_reason
            break
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
        attempted.add(request_id)
        dispatched_target_shas.add(str(request.get("target_sha") or ""))

        target_agent = str(request.get("target_agent") or "").strip()
        _launch(request, request_id, target_agent, worktree)
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
