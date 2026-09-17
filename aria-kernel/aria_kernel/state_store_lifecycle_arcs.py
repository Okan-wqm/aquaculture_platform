"""The state store's lock-holder arcs, derived from the git steps run under its locks.

WHAT lives here: the git bound every state-store call runs under, the
classification of git operations into the ones that can legitimately run
to that bound and the ones that cannot, a registry of the bounded steps the
lock holders run (one entry per call site), the ARCS each lock is held
across written as sequences of those steps — the lifecycle lock's arcs and,
nested inside them, the arcs held under ONE `ledger.state_transaction` —
and the liveness bound each lock's waiter derives from its arcs.

WHY the count is derived and not typed: `state_store._state_store_lifecycle_lock`
waits for its LIVE holder "the longest a holder can legitimately take", and
the only honest source of that number is the sequence of git calls the
holder runs while it holds the lock. A count typed beside the constant
(three steps per publish attempt, 2026-09-12) undercounted a lost-race
attempt by two — the ls-remote probe and the reconciliation fetch of
`_reconcile_nonzero_push` — and omitted the pending-recovery replay every
arc runs first: a healthy holder could need 4500 s while a peer gave up at
2700 s, the same class of defect the constant was introduced to close. Now
every git call under the lock whose duration scales with the remote or the
working tree is a registered STEP (`lifecycle_git_step`), each arc is
written as the steps it runs, and the bound is a sum over the arcs.
`tests/test_state_lifecycle_arcs_derived.py` walks `state_store`'s AST from
every lifecycle-locked and every state-transaction region and fails when a
tree-or-remote-scaled git call there is not a registered step, when a
registered step is not run at the site it names, or when a step is in no
arc; `tests/test_state_lock_arcs_traced.py` runs the holders and checks the
steps they spawn equal their arcs in order and multiplicity; the runtime
refuses an unregistered tree-or-remote-scaled call under the lifecycle
lock, and under a state transaction any step no transaction arc prices
(`state_store._run_git_bytes_bounded`), so the registry cannot fall behind
the code without a test AND a production call failing loudly.

WHY the state-transaction bound lives here too: `ledger` sits below
`state_store` and cannot read the arcs from it, but this module is a leaf
(threading, contextlib, dataclasses, typing) that both can import. The
bound a state writer waits for its live holder used to be typed in the
ledger as "two git steps at cap" (600 s) while the resumed accepted-loser
recovery holds ONE transaction across fetch, fast-forward and probe — 900 s
at cap — so a claim or submit gave up behind a healthy recovery: the same
class the lifecycle bound was re-derived for.
"""
from __future__ import annotations

import threading
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Iterator

# Every git call is bounded. An unbounded fetch against an unreachable
# remote hangs the publishing step, and a cycle that cannot finish also
# cannot be recovered by a watchdog waiting for that cycle to report.
# 300 (was 120): the store pushes the aria/state branch — hundreds of MB of
# JSONL ledgers — and 120s measured too tight twice on the shared runner:
# a sandboxed test push in the suite timed out at exactly this budget while
# the box ran a second test workload (suite run 2026-08-28,
# test_publish_with_replay_keeps_nested_lifecycle_entries_reentrant; green
# in 0.8s in isolation on the same code). A production push that needs more
# than 5 minutes is genuinely stuck; one that needs 3 is normal.
GIT_TIMEOUT_SECONDS = 300

# How many times the publish orchestrator may lose the race to the remote
# tip and rebuild onto the winner before it gives up
# (`state_store.publish_with_contention_replay`). Named so the lifecycle
# bound below can be derived from the arc it protects.
PUBLISH_MAX_ATTEMPTS = 3

# Git operations whose duration scales with the remote's latency or with
# the size of the working tree: the transports, and the commands that
# materialise, move or delete the whole checked-out tree. These are the
# only calls that can legitimately run to GIT_TIMEOUT_SECONDS, so they are
# the only ones an arc prices — and under the lifecycle lock every one of
# them must be a registered step.
TREE_OR_REMOTE_SCALED_GIT_OPERATIONS: frozenset[str] = frozenset({
    "push",
    "fetch",
    "ls-remote",
    "clone",
    "pull",
    "reset",
    "merge",
    "checkout",
    "rm",
    "worktree add",
    "worktree remove",
})

# Git operations bounded by repository METADATA — one ref, one object, the
# index, the bytes this process itself just wrote: seconds at most on any
# host, never the cap. Every operation the lifecycle holder runs must be in
# exactly one of the two sets; an operation in neither fails the AST test
# until it is classified, so a new command cannot be priced by omission.
METADATA_SCALED_GIT_OPERATIONS: frozenset[str] = frozenset({
    "rev-parse",
    "rev-list",
    "update-ref",
    "merge-base",
    "cat-file",
    "ls-tree",
    "ls-files",
    "write-tree",
    "read-tree",
    "diff",
    "status",
    "add",
    "commit",
    "branch",
    "config",
    "worktree list",
    "worktree prune",
    # An index edit: `git rm --cached` unstages entries and touches nothing
    # on disk or on the remote, however many the publish preamble drops
    # (`state_tree_contract.drop_inherited_unclaimed_entries`, in pathspec
    # slices). `rm` without `--cached` removes a tree and stays priced.
    "rm --cached",
})

# Git verbs whose cost depends on the subcommand: `worktree add` writes a
# whole tree, `worktree list` reads one file.
_SUBCOMMAND_SCOPED_GIT_VERBS: frozenset[str] = frozenset({"worktree"})
# Git verbs whose cost depends on a mode flag rather than a subcommand.
_MODE_SCOPED_GIT_VERBS: dict[str, tuple[str, ...]] = {"rm": ("--cached",)}


def git_operation(args: tuple[str, ...]) -> str:
    """The operation ``git <args>`` performs, as the classification names it.

    Leading ``-c key=value`` pairs are configuration, not the operation;
    for subcommand-scoped verbs the subcommand is part of the name. The
    AST walker in `tests/test_state_lifecycle_arcs_derived.py` applies
    this same function to the literal tokens of every call site, with every
    non-literal token as ``?``, so static and runtime classification agree.
    """
    index = 0
    while index < len(args) and args[index] == "-c":
        index += 2
    verb = args[index] if index < len(args) else ""
    if verb in _SUBCOMMAND_SCOPED_GIT_VERBS and index + 1 < len(args):
        return f"{verb} {args[index + 1]}"
    if verb in _MODE_SCOPED_GIT_VERBS:
        # The mode flag decides the cost class (`rm --cached` edits the index;
        # `rm` removes a tree): the flag is part of the name wherever it
        # sits among the options, so a static call site and a runtime argv
        # classify alike.
        for mode in _MODE_SCOPED_GIT_VERBS[verb]:
            if mode in args[index + 1:]:
                return f"{verb} {mode}"
    return verb


@dataclass(frozen=True)
class LifecycleGitStep:
    """One tree-or-remote-scaled git call the lifecycle holder can run to the cap.

    ``site`` is the function whose body makes the call; the AST test
    resolves each step to exactly that site, so a step cannot be
    registered for a call that moved or was removed.
    """

    name: str
    operation: str
    site: str


_LIFECYCLE_GIT_STEPS: dict[str, LifecycleGitStep] = {}


def lifecycle_git_step(name: str, operation: str, *, site: str) -> LifecycleGitStep:
    """Register one step. The registry is the set the arcs below draw from."""
    if operation not in TREE_OR_REMOTE_SCALED_GIT_OPERATIONS:
        raise ValueError(
            f"lifecycle_git_step_not_tree_or_remote_scaled: {name} names git "
            f"{operation!r}, which no arc prices"
        )
    if name in _LIFECYCLE_GIT_STEPS:
        raise ValueError(f"lifecycle_git_step_duplicate: {name}")
    step = LifecycleGitStep(name=name, operation=operation, site=site)
    _LIFECYCLE_GIT_STEPS[name] = step
    return step


def registered_lifecycle_git_steps() -> tuple[LifecycleGitStep, ...]:
    return tuple(_LIFECYCLE_GIT_STEPS.values())


# ---- The steps, one per call site ------------------------------------------
PUBLISH_PUSH_STEP = lifecycle_git_step(
    "publish_push", "push", site="_publish_state_locked",
)
REMOTE_TIP_PROBE_STEP = lifecycle_git_step(
    "remote_tip_probe", "ls-remote", site="_probe_remote_tip_at",
)
REMOTE_BRANCH_FETCH_STEP = lifecycle_git_step(
    "remote_branch_fetch", "fetch", site="_fetch_remote_branch_tip_at",
)
REPLAY_RESET_STEP = lifecycle_git_step(
    "replay_reset", "reset", site="_rebase_store_onto_remote_locked",
)
OWNED_STORE_FAST_FORWARD_STEP = lifecycle_git_step(
    "owned_store_fast_forward", "merge", site="_refresh_clean_owned_store",
)
STORE_WORKTREE_REMOVE_STEP = lifecycle_git_step(
    "store_worktree_remove", "worktree remove", site="_clear_existing_store",
)
STORE_WORKTREE_ADD_STEP = lifecycle_git_step(
    "store_worktree_add", "worktree add", site="_checkout_state_store_locked",
)
BOOTSTRAP_WORKTREE_ADD_STEP = lifecycle_git_step(
    "bootstrap_worktree_add", "worktree add", site="_checkout_state_store_locked",
)
BOOTSTRAP_ORPHAN_CHECKOUT_STEP = lifecycle_git_step(
    "bootstrap_orphan_checkout", "checkout", site="_checkout_state_store_locked",
)
BOOTSTRAP_TREE_CLEAR_STEP = lifecycle_git_step(
    "bootstrap_tree_clear", "rm", site="_checkout_state_store_locked",
)
BOOTSTRAP_DETACH_CHECKOUT_STEP = lifecycle_git_step(
    "bootstrap_detach_checkout", "checkout", site="_checkout_state_store_locked",
)

# An arc entry is one step, or a tuple of steps of which exactly one runs
# (mutually exclusive branches at the same position).
ArcEntry = LifecycleGitStep | tuple[LifecycleGitStep, ...]
LifecycleArc = tuple[ArcEntry, ...]

# ---- The state-transaction arcs -----------------------------------------------
#
# `ledger.state_transaction` is the ordered lock acquisition every governed
# writer goes through (a claim, a release, a submit, a governance row).
# Three holders in `state_store` keep ONE transaction open across
# tree-or-remote-scaled git steps; each is written here as the steps it
# runs, and a writer waiting on those locks must outlast the longest.

# `_recover_pending_state_replay_locked`: a package left by a process that
# died mid-replay is resumed under the group locks before anything else
# touches the store. Its longest path (`_resume_accepted_loser_recovery`)
# fetches the remote tip, fast-forwards the store onto it and probes the
# remote once more; the restore paths move only the index.
PENDING_RECOVERY_ARC: LifecycleArc = (
    REMOTE_BRANCH_FETCH_STEP,
    OWNED_STORE_FAST_FORWARD_STEP,
    REMOTE_TIP_PROBE_STEP,
)

# `_rebase_store_onto_remote_with_lifecycle`: under the transaction the
# rebase fetches AGAIN (the server may have accepted the loser since the
# contention was classified) and moves the working tree — `reset --hard`
# onto the winner, or a fast-forward when the loser was accepted after all.
REBASE_TRANSACTION_ARC: LifecycleArc = (
    REMOTE_BRANCH_FETCH_STEP,
    (REPLAY_RESET_STEP, OWNED_STORE_FAST_FORWARD_STEP),
)

# `_clear_existing_store`: with the cleanup's locks held it probes the
# remote a last time (the published tip must not have moved under the
# cleanliness scan) and removes the old worktree.
CHECKOUT_CLEANUP_TRANSACTION_ARC: LifecycleArc = (
    REMOTE_TIP_PROBE_STEP,
    STORE_WORKTREE_REMOVE_STEP,
)

STATE_TRANSACTION_ARCS: dict[str, LifecycleArc] = {
    "pending_recovery": PENDING_RECOVERY_ARC,
    "rebase": REBASE_TRANSACTION_ARC,
    "checkout_cleanup": CHECKOUT_CLEANUP_TRANSACTION_ARC,
}

# ---- The lifecycle-lock arcs, in the order the holder runs them --------------
#
# Every lifecycle arc starts with the pending recovery; the transaction arcs
# above are spliced in where the holder opens the transaction, so the two
# registries cannot describe the same code differently.

# ONE attempt of `_publish_with_contention_replay_locked` at its longest:
# the push is rejected; `_reconcile_nonzero_push` probes the remote and
# fetches the winner (when the winner already carries the commit it
# fast-forwards instead and the attempt ends there — the shorter branch);
# the contention is classified and the rebase runs its transaction arc.
PUBLISH_ATTEMPT_ARC: LifecycleArc = (
    PUBLISH_PUSH_STEP,
    REMOTE_TIP_PROBE_STEP,
    REMOTE_BRANCH_FETCH_STEP,
    *REBASE_TRANSACTION_ARC,
)

# `_checkout_state_store_locked` when the branch exists remotely: probe,
# fetch, probe again; the existing store's pending recovery; its clearing
# under the cleanup transaction; the fresh worktree materialised at the
# fetched tip.
CHECKOUT_RESTORE_ARC: LifecycleArc = (
    REMOTE_TIP_PROBE_STEP,
    REMOTE_BRANCH_FETCH_STEP,
    REMOTE_TIP_PROBE_STEP,
    *PENDING_RECOVERY_ARC,
    *CHECKOUT_CLEANUP_TRANSACTION_ARC,
    STORE_WORKTREE_ADD_STEP,
)

# The same function when no remote branch exists (an acknowledged
# bootstrap): the probe, a worktree of the checkout's own HEAD, the orphan
# switch, the whole-tree removal, the detach. Shorter than the restore
# arc; both are priced so neither can grow past the other unnoticed.
CHECKOUT_BOOTSTRAP_ARC: LifecycleArc = (
    REMOTE_TIP_PROBE_STEP,
    BOOTSTRAP_WORKTREE_ADD_STEP,
    BOOTSTRAP_ORPHAN_CHECKOUT_STEP,
    BOOTSTRAP_TREE_CLEAR_STEP,
    BOOTSTRAP_DETACH_CHECKOUT_STEP,
)

LIFECYCLE_ARCS: dict[str, LifecycleArc] = {
    "pending_recovery": PENDING_RECOVERY_ARC,
    "publish_attempt": PUBLISH_ATTEMPT_ARC,
    "checkout_restore": CHECKOUT_RESTORE_ARC,
    "checkout_bootstrap": CHECKOUT_BOOTSTRAP_ARC,
}


def arc_steps(arc: LifecycleArc) -> frozenset[LifecycleGitStep]:
    """Every step an arc can run, alternatives flattened."""
    steps: set[LifecycleGitStep] = set()
    for entry in arc:
        steps.update(entry if isinstance(entry, tuple) else (entry,))
    return frozenset(steps)


def arc_seconds(arc: LifecycleArc) -> float:
    """The arc at the cap: every position one GIT_TIMEOUT_SECONDS."""
    return float(GIT_TIMEOUT_SECONDS * len(arc))


# ---- The bounds ---------------------------------------------------------------
# The publish holder: the pending recovery once, then every attempt at its
# longest.
STATE_STORE_PUBLISH_ARC_SECONDS: float = (
    arc_seconds(PENDING_RECOVERY_ARC)
    + PUBLISH_MAX_ATTEMPTS * arc_seconds(PUBLISH_ATTEMPT_ARC)
)
# The checkout holder: the longer of its two shapes.
STATE_STORE_CHECKOUT_ARC_SECONDS: float = max(
    arc_seconds(CHECKOUT_RESTORE_ARC),
    arc_seconds(CHECKOUT_BOOTSTRAP_ARC),
)
# How long a lifecycle-lock waiter waits for the LIVE holder before it
# concludes the holder is wedged: the longest arc any holder runs. The lock
# is `flock`, so a holder that dies releases through the kernel; the only
# holder a waiter can be stuck behind is a live one, and this is the
# longest a live one can legitimately be. A wedge still fails loudly, at
# the bound.
STATE_STORE_LIFECYCLE_LIVENESS_SECONDS: float = max(
    STATE_STORE_PUBLISH_ARC_SECONDS,
    STATE_STORE_CHECKOUT_ARC_SECONDS,
)
# How long a state writer waits for the LIVE holder of a state-group, index
# or file lock (`ledger.state_transaction`'s default): the longest arc any
# holder keeps one transaction open across — the resumed accepted-loser
# recovery's fetch, fast-forward and probe. The same flock argument holds:
# a dead holder releases through the kernel, so the only holder a writer
# can wait on is a live one, and this is the longest a live one can be.
STATE_LOCK_LIVENESS_SECONDS: float = max(
    arc_seconds(arc) for arc in STATE_TRANSACTION_ARCS.values()
)
# The steps a state transaction can legitimately hold: what the runtime
# lets run under one (`state_store._run_git_bytes_bounded`).
STATE_TRANSACTION_STEPS: frozenset[LifecycleGitStep] = frozenset().union(
    *(arc_steps(arc) for arc in STATE_TRANSACTION_ARCS.values())
)


# ---- The runtime markers --------------------------------------------------------
# The step a thread is currently running, so the raw git runner can refuse
# a tree-or-remote-scaled call made under the lifecycle lock outside any
# registered step: the registry is then not a convention but a precondition.
_ACTIVE_STEP = threading.local()


def active_lifecycle_step() -> LifecycleGitStep | None:
    return getattr(_ACTIVE_STEP, "step", None)


@contextmanager
def lifecycle_step_active(step: LifecycleGitStep) -> Iterator[None]:
    previous = active_lifecycle_step()
    _ACTIVE_STEP.step = step
    try:
        yield
    finally:
        _ACTIVE_STEP.step = previous


# The state transaction a thread currently holds, as a process-unique
# ordinal. `ledger.state_transaction` sets it for the span of its yield, so
# the raw git runner can refuse a step no transaction arc prices while one
# is held, and a trace can tell WHICH transaction each spawn ran under —
# the multiplicity along an arc is only visible per transaction.
_ACTIVE_TRANSACTION = threading.local()
_TRANSACTION_ORDINALS = threading.Lock()
_next_transaction_ordinal = 0


def active_state_transaction() -> int | None:
    return getattr(_ACTIVE_TRANSACTION, "ordinal", None)


@contextmanager
def state_transaction_held() -> Iterator[int]:
    global _next_transaction_ordinal
    with _TRANSACTION_ORDINALS:
        _next_transaction_ordinal += 1
        ordinal = _next_transaction_ordinal
    previous = active_state_transaction()
    _ACTIVE_TRANSACTION.ordinal = ordinal
    try:
        yield ordinal
    finally:
        _ACTIVE_TRANSACTION.ordinal = previous


def require_step_operation(step: LifecycleGitStep, args: tuple[str, ...]) -> None:
    """A step prices one operation; running another under its name is a lie."""
    operation = git_operation(args)
    if operation != step.operation:
        raise ValueError(
            f"lifecycle_git_step_operation_mismatch: {step.name} prices git "
            f"{step.operation!r}, ran git {operation!r}"
        )


__all__ = [
    "BOOTSTRAP_DETACH_CHECKOUT_STEP",
    "BOOTSTRAP_ORPHAN_CHECKOUT_STEP",
    "BOOTSTRAP_TREE_CLEAR_STEP",
    "BOOTSTRAP_WORKTREE_ADD_STEP",
    "CHECKOUT_BOOTSTRAP_ARC",
    "CHECKOUT_CLEANUP_TRANSACTION_ARC",
    "CHECKOUT_RESTORE_ARC",
    "GIT_TIMEOUT_SECONDS",
    "LIFECYCLE_ARCS",
    "LifecycleArc",
    "LifecycleGitStep",
    "METADATA_SCALED_GIT_OPERATIONS",
    "OWNED_STORE_FAST_FORWARD_STEP",
    "PENDING_RECOVERY_ARC",
    "PUBLISH_ATTEMPT_ARC",
    "PUBLISH_MAX_ATTEMPTS",
    "PUBLISH_PUSH_STEP",
    "REMOTE_BRANCH_FETCH_STEP",
    "REBASE_TRANSACTION_ARC",
    "REMOTE_TIP_PROBE_STEP",
    "REPLAY_RESET_STEP",
    "STATE_LOCK_LIVENESS_SECONDS",
    "STATE_STORE_CHECKOUT_ARC_SECONDS",
    "STATE_STORE_LIFECYCLE_LIVENESS_SECONDS",
    "STATE_STORE_PUBLISH_ARC_SECONDS",
    "STATE_TRANSACTION_ARCS",
    "STATE_TRANSACTION_STEPS",
    "STORE_WORKTREE_ADD_STEP",
    "STORE_WORKTREE_REMOVE_STEP",
    "TREE_OR_REMOTE_SCALED_GIT_OPERATIONS",
    "active_lifecycle_step",
    "active_state_transaction",
    "arc_seconds",
    "arc_steps",
    "git_operation",
    "lifecycle_git_step",
    "lifecycle_step_active",
    "registered_lifecycle_git_steps",
    "require_step_operation",
    "state_transaction_held",
]
