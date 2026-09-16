"""The arcs are what the holders actually spawn — in order, and as many times.

`state_store_lifecycle_arcs` writes each lock-holder arc as a SEQUENCE of
registered git steps and derives two liveness bounds from them: the
lifecycle lock's (`STATE_STORE_LIFECYCLE_LIVENESS_SECONDS`) and the state
transaction's (`STATE_LOCK_LIVENESS_SECONDS`, the ledger's default wait).
`tests/test_state_lifecycle_arcs_derived.py` walks the code's AST and proves
the SET of steps each holder can reach is the set its arc declares — but a
set walk cannot see multiplicity: a second `fetch` added to the rebase path,
or a step run twice in a loop, leaves the set unchanged and the bound short,
which is the class both bounds were re-derived for (a typed count that
undercounted the holder). The runtime guard cannot see it either; it refuses
an unregistered step, not a registered one run again.

This module closes that residual by RUNNING the holders over real repositories
(the contention suite's own fixtures) and reading, from the production
markers the store's git runner is called under, every tree-or-remote-scaled
spawn with the lifecycle lock and the transaction ordinal it ran under:

* a lost-race publish spawns, under the lifecycle lock, exactly one
  `PUBLISH_ATTEMPT_ARC` (its tree move the reset branch) followed by the
  winning attempt's push, and exactly one transaction holds heavy steps —
  the rebase's `REBASE_TRANSACTION_ARC`;
* a rebase whose loser the server accepted after all realises the same
  transaction arc through its fast-forward branch;
* a resumed accepted-loser recovery holds ONE transaction across exactly
  `PENDING_RECOVERY_ARC` — fetch, fast-forward, probe — and that arc's
  seconds at the cap ARE `STATE_LOCK_LIVENESS_SECONDS`: the bound sums the
  arc the trace finds, not a count typed beside it;
* a checkout over an existing store carrying that package spawns the whole
  `CHECKOUT_RESTORE_ARC` under the lock, its two transactions holding the
  recovery arc and the cleanup arc.

A registered step called once more on any of these paths makes the spawned
sequence longer than the registered arc, and the test is red.
"""
from __future__ import annotations

import unittest
from dataclasses import dataclass
from unittest import mock

from aria_kernel import state_store
from aria_kernel import state_store_lifecycle_arcs as arcs
from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS
from aria_kernel.state_store import checkout_state_store, tools_root
# The contention suite's fixtures, reached through the module: importing the
# TestCase class by name would put it in this module's globals and pytest
# would collect its whole suite here a second time.
from tests import test_publish_contention as contention

REPO_HASH = contention.REPO_HASH
_git = contention._git


@dataclass(frozen=True)
class _Spawn:
    step: arcs.LifecycleGitStep | None
    operation: str
    lifecycle_lock_held: bool
    transaction: int | None


class _SpawnTrace:
    """Every tree-or-remote-scaled spawn of the store's git runner, with the
    lock and transaction it ran under — read from the production markers,
    never inferred from the test's own knowledge of the code."""

    def __init__(self) -> None:
        self.spawns: list[_Spawn] = []
        self._patch: mock._patch | None = None

    def __enter__(self) -> "_SpawnTrace":
        real = state_store._run_git_bytes_bounded

        def traced(cwd, args, **kwargs):
            operation = arcs.git_operation(tuple(args))
            if operation in arcs.TREE_OR_REMOTE_SCALED_GIT_OPERATIONS:
                self.spawns.append(_Spawn(
                    step=arcs.active_lifecycle_step(),
                    operation=operation,
                    lifecycle_lock_held=state_store._lifecycle_lock_held_by_this_thread(),
                    transaction=arcs.active_state_transaction(),
                ))
            return real(cwd, args, **kwargs)

        self._patch = mock.patch.object(state_store, "_run_git_bytes_bounded", new=traced)
        self._patch.start()
        return self

    def __exit__(self, *_exc: object) -> None:
        assert self._patch is not None
        self._patch.stop()

    def under_the_lifecycle_lock(self) -> list[arcs.LifecycleGitStep | None]:
        return [spawn.step for spawn in self.spawns if spawn.lifecycle_lock_held]

    def outside_the_lifecycle_lock(self) -> list[_Spawn]:
        return [spawn for spawn in self.spawns if not spawn.lifecycle_lock_held]

    def per_transaction(self) -> list[list[arcs.LifecycleGitStep | None]]:
        """The heavy steps each transaction held, in the order the transactions ran."""
        held: dict[int, list[arcs.LifecycleGitStep | None]] = {}
        for spawn in self.spawns:
            if spawn.transaction is not None:
                held.setdefault(spawn.transaction, []).append(spawn.step)
        return [held[ordinal] for ordinal in sorted(held)]


def _names(steps: list[arcs.LifecycleGitStep | None]) -> list[str | None]:
    return [step.name if step else None for step in steps]


def _arc_names(arc: arcs.LifecycleArc) -> list[str | tuple[str, ...]]:
    return [
        tuple(step.name for step in entry) if isinstance(entry, tuple) else entry.name
        for entry in arc
    ]


class _ArcTraceCase(unittest.TestCase):
    """A contention-suite harness per test, and the arc-equality assertion."""

    def setUp(self) -> None:
        self.harness = contention.PublishContentionTests("run")
        self.harness.setUp()
        self.addCleanup(self.harness.doCleanups)

    def assertRealizes(
        self,
        trace: list[arcs.LifecycleGitStep | None],
        arc: arcs.LifecycleArc,
        *,
        chosen: dict[int, arcs.LifecycleGitStep] | None = None,
    ) -> None:
        """The trace IS the arc: same length, each position the registered
        step (one of the alternatives at a fork, the one `chosen` names)."""
        message = f"spawned {_names(trace)}, registered {_arc_names(arc)}"
        self.assertEqual(len(trace), len(arc), message)
        for position, (step, entry) in enumerate(zip(trace, arc)):
            options = entry if isinstance(entry, tuple) else (entry,)
            self.assertIn(step, options, f"position {position}: {message}")
            if chosen and position in chosen:
                self.assertIs(step, chosen[position], f"position {position}: {message}")

    def _lost_race_stores(self):
        harness = self.harness
        store_a = harness._store(harness.repo_a, "store-a")
        harness._append(store_a, "shared-1")
        harness._publish(store_a, "snap-base", "cycle-base")
        store_b = harness._store(harness.repo_b, "store-b")
        harness._append(store_a, "lane-a-only")
        harness._append(store_b, "lane-b-only")
        harness._publish(store_a, "snap-a", "cycle-a")
        return store_b

    def _adopted_loser_recovery_store(self):
        """A store whose accepted-loser recovery died with HEAD on the loser
        and the tracking ref behind — the shape whose resume runs every step
        of the pending-recovery arc."""
        harness = self.harness
        (
            store, _base, _local, _base_head, loser_head, _winner,
            tracking, tracking_before, transaction, manifest,
        ) = harness._accepted_loser_recovery_inputs()
        _git(store.root, "reset", "--hard", loser_head)
        loser_index = tools_root(store) / "integrity_index.json"
        if not state_store._git_succeeds(
            store.root, "cat-file", "-e", f"{loser_head}:tools/integrity_index.json",
        ):
            loser_index.unlink(missing_ok=True)
        _git(store.root, "update-ref", tracking, tracking_before)
        harness._rewrite_recovery_phase(transaction, manifest, "adopt_loser_complete")
        return harness._fresh_store(store), transaction


class TheLifecycleHolderSpawnsItsArc(_ArcTraceCase):
    def test_a_lost_race_publish_spawns_one_attempt_arc_then_the_winning_push(self) -> None:
        store_b = self._lost_race_stores()

        with _SpawnTrace() as trace:
            result = self.harness._publish(store_b, "snap-b", "cycle-b")

        self.assertTrue(result["published"])
        self.assertEqual(result["attempts"], 2)
        self.assertEqual(trace.outside_the_lifecycle_lock(), [])
        under_lock = trace.under_the_lifecycle_lock()
        attempt = len(arcs.PUBLISH_ATTEMPT_ARC)
        # Attempt 1, rejected: push, probe, the reconciliation fetch, the
        # rebase's fresh fetch, the reset onto the winner. Attempt 2: the
        # push that the server accepts — the arc's first step, nothing more.
        self.assertRealizes(
            under_lock[:attempt], arcs.PUBLISH_ATTEMPT_ARC,
            chosen={attempt - 1: arcs.REPLAY_RESET_STEP},
        )
        self.assertEqual(_names(under_lock[attempt:]), [arcs.PUBLISH_PUSH_STEP.name])
        # The bound prices PUBLISH_MAX_ATTEMPTS of that arc; two attempts is
        # inside it, and no spawn ran outside a registered step.
        self.assertLessEqual(
            len(under_lock) * arcs.GIT_TIMEOUT_SECONDS, arcs.STATE_STORE_PUBLISH_ARC_SECONDS,
        )
        self.assertNotIn(None, under_lock)
        # Exactly one transaction held heavy steps: the rebase's arc.
        transactions = trace.per_transaction()
        self.assertEqual(len(transactions), 1, [_names(t) for t in transactions])
        self.assertRealizes(
            transactions[0], arcs.REBASE_TRANSACTION_ARC, chosen={1: arcs.REPLAY_RESET_STEP},
        )

    def test_a_rebase_whose_loser_was_accepted_fast_forwards_under_its_transaction(self) -> None:
        store, base, local, base_head, loser_head, winner = (
            self.harness._accepted_loser_descendant_inputs()
        )

        with _SpawnTrace() as trace:
            state_store.rebase_store_onto_remote(
                store, base=base, local=local, repo_hash=REPO_HASH,
                expected_winner=loser_head, expected_loser=loser_head, expected_base=base_head,
            )

        self.assertEqual(_git(store.root, "rev-parse", "HEAD").strip(), winner)
        self.assertEqual(trace.outside_the_lifecycle_lock(), [])
        # No pending package, so the lifecycle hold is the rebase alone: the
        # fresh fetch, then the fast-forward branch of the tree move.
        self.assertRealizes(
            trace.under_the_lifecycle_lock(), arcs.REBASE_TRANSACTION_ARC,
            chosen={1: arcs.OWNED_STORE_FAST_FORWARD_STEP},
        )
        transactions = trace.per_transaction()
        self.assertEqual(len(transactions), 1, [_names(t) for t in transactions])
        self.assertRealizes(
            transactions[0], arcs.REBASE_TRANSACTION_ARC,
            chosen={1: arcs.OWNED_STORE_FAST_FORWARD_STEP},
        )


class TheTransactionHolderSpawnsTheArcTheBoundSums(_ArcTraceCase):
    def test_a_resumed_accepted_loser_recovery_holds_one_transaction_across_the_arc(self) -> None:
        store, transaction = self._adopted_loser_recovery_store()

        with _SpawnTrace() as trace:
            result = state_store.recover_pending_state_replay(store, repo_hash=REPO_HASH)

        self.assertEqual(result["status"], "accepted_loser_cleaned")
        self.assertFalse(transaction.exists())
        self.assertEqual(trace.outside_the_lifecycle_lock(), [])
        transactions = trace.per_transaction()
        self.assertEqual(len(transactions), 1, [_names(t) for t in transactions])
        held = transactions[0]
        # Fetch the remote tip, fast-forward the adopted loser onto it, probe
        # the remote once more — under ONE transaction, the group locks
        # every claim, release and submit waits on.
        self.assertRealizes(held, arcs.PENDING_RECOVERY_ARC)
        self.assertRealizes(trace.under_the_lifecycle_lock(), arcs.PENDING_RECOVERY_ARC)
        # And the ledger's default wait is THIS arc at the cap: the number a
        # writer waits is the sequence the holder ran, not a typed count.
        self.assertEqual(len(held) * arcs.GIT_TIMEOUT_SECONDS, STATE_LOCK_LIVENESS_SECONDS)
        self.assertEqual(arcs.arc_seconds(arcs.PENDING_RECOVERY_ARC), STATE_LOCK_LIVENESS_SECONDS)
        self.assertEqual(
            STATE_LOCK_LIVENESS_SECONDS,
            max(arcs.arc_seconds(arc) for arc in arcs.STATE_TRANSACTION_ARCS.values()),
        )

    def test_a_recovery_that_finds_the_remote_advanced_runs_the_same_arc(self) -> None:
        harness = self.harness
        (
            store, _base, _local, _base_head, _loser_head, _winner,
            tracking, _tracking_before, transaction, manifest,
        ) = harness._accepted_loser_recovery_inputs()
        harness._rewrite_recovery_phase(transaction, manifest, "accepted_loser")
        later = harness._store(harness.repo_a, "post-adoption-crash-store")
        harness._append(later, "after-adoption-crash")
        harness._publish(later, "snap-after-adoption", "cycle-after-adoption")
        remote_tip = _git(harness.remote, "rev-parse", "refs/heads/aria/state").strip()

        with _SpawnTrace() as trace:
            result = state_store.recover_pending_state_replay(
                harness._fresh_store(store), repo_hash=REPO_HASH,
            )

        self.assertEqual(result["status"], "accepted_loser_cleaned")
        self.assertEqual(_git(store.root, "rev-parse", tracking).strip(), remote_tip)
        transactions = trace.per_transaction()
        self.assertEqual(len(transactions), 1, [_names(t) for t in transactions])
        self.assertRealizes(transactions[0], arcs.PENDING_RECOVERY_ARC)
        self.assertEqual(len(transactions[0]) * arcs.GIT_TIMEOUT_SECONDS, STATE_LOCK_LIVENESS_SECONDS)


class TheCheckoutHolderSpawnsTheRestoreArc(_ArcTraceCase):
    def test_a_checkout_over_a_store_with_a_pending_package_spawns_the_whole_restore_arc(self) -> None:
        store, transaction = self._adopted_loser_recovery_store()

        with _SpawnTrace() as trace:
            restored = checkout_state_store(store.repo_root, store_dir=store.root)

        self.assertFalse(transaction.exists())
        self.assertEqual(restored.root, store.root)
        self.assertEqual(trace.outside_the_lifecycle_lock(), [])
        # Probe, fetch, probe; the recovery's fetch, fast-forward, probe; the
        # cleanup's probe and worktree removal; the fresh worktree — nine
        # positions, the longest checkout arc, each spawned once.
        self.assertRealizes(trace.under_the_lifecycle_lock(), arcs.CHECKOUT_RESTORE_ARC)
        self.assertEqual(
            len(trace.under_the_lifecycle_lock()) * arcs.GIT_TIMEOUT_SECONDS,
            arcs.STATE_STORE_CHECKOUT_ARC_SECONDS,
        )
        transactions = trace.per_transaction()
        self.assertEqual(len(transactions), 2, [_names(t) for t in transactions])
        self.assertRealizes(transactions[0], arcs.PENDING_RECOVERY_ARC)
        self.assertRealizes(transactions[1], arcs.CHECKOUT_CLEANUP_TRANSACTION_ARC)


if __name__ == "__main__":
    unittest.main()
