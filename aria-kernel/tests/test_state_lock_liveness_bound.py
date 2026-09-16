"""A state writer waits for the lock's live holder, not for a 5 s budget.

`state_transaction` is the one ordered acquisition every governed writer
goes through — an executor appending its claim, a cycle appending
governance, the publish/replay orchestrator adopting a remote winner. Until
this change it passed no timeout to the lock helper, so every state writer
inherited `file_lock._DEFAULT_TIMEOUT_SECONDS` (5 s) as its wait. That
number is a fine liveness guard for a millisecond critical section; it is a
performance budget for the replay orchestrator, which legitimately holds the
same state-group locks across a remote fetch and a working-tree reset, each
bounded by `state_store.GIT_TIMEOUT_SECONDS` (300 s). The third pre-push run
of this branch (3,137 tests, 33,754 s, load 6-20 on 4 CPUs) failed exactly
the two replay-contention fixtures with
`TimeoutError('with_exclusive_lock_timeout: .../state-groups/<group>.lock')`
from the WRITERS: the replay was healthy, the host was slow, and a real
claim append arriving during a production replay would have died the same
way — the class `test_agent_submit_result_e2e.RACE_LIVENESS_SECONDS` names
(a liveness guard used as a budget), in production code rather than a
fixture.

The bound now has a name, `ledger.STATE_LOCK_LIVENESS_SECONDS`, is the
default of every state transaction, and is DERIVED from the holders it waits
for: the longest arc any `state_store` holder keeps one transaction open
across (`state_store_lifecycle_arcs.STATE_TRANSACTION_ARCS` — the resumed
accepted-loser recovery's fetch, fast-forward and probe), not a count typed
beside it. The first repair typed "two git steps at cap" (600 s) and a
claim gave up behind that healthy 900 s recovery — the class this module
exists for, re-created by the number that was meant to close it. A wedge
still fails loudly; a loaded host no longer does.

It is ONE deadline for the whole ordered acquisition, not a wait per lock:
`state_transaction` takes group, index and file locks in sequence, and a
per-lock bound would let a writer behind several distinct wedged holders
wait N times the bound. Each lock is asked for the time that remains.

The executor's submit child is the writer that pays most for this bound and
it must not be killed before the bound can act: `ci_executor` derives its
submit wall clock from this number, and the drain loop prices the WHOLE
child — claim, pre-claim probe, CLI run, submit, release — into the worst
case it checks before starting one, so no lock wait of any child spills
out of the drain window into the reserve the job keeps for restore and
publish.

The lifecycle lock one layer up (`state_store._state_store_lifecycle_lock`)
is the same class: its holder is the publish orchestrator's whole arc, and
a waiter that gave up after one git call's cap raised
`state_store_lifecycle_lock_timeout` while the holder was healthy. Its
bound is derived from the git steps the code runs under the lock
(`state_store_lifecycle_arcs`; the derivation itself is proven against the
AST in `test_state_lifecycle_arcs_derived`) and every number that cascades
from it — the executor's terminal-writer and worktree pricing, the job
reserve, the workflow's window and timeout — is pinned here.
"""
from __future__ import annotations

import ast
import inspect
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

import yaml

from aria_kernel import ledger as ledger_module
from aria_kernel import file_lock
from aria_kernel import state_store
from aria_kernel import state_store_lifecycle_arcs as arcs
from aria_kernel.evidence_probe import (
    EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
    GIT_PROBE_WORST_CASE_SECONDS,
)
from aria_kernel.file_lock import with_exclusive_lock
from aria_kernel.human_required import HUMAN_REQUIRED_RECORD_WAIT_SECONDS
from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS, state_transaction
from aria_kernel.notify import NOTIFY_CHANNELS, NOTIFY_WORST_CASE_SECONDS, SENDER_WALL_CLOCK_SECONDS
from aria_kernel.runtime_profile import set_profile
from tests._helpers.declared_fixtures import append_declared_fixture

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
import ci_executor_drain  # noqa: E402


# Long enough that the lock helper's own default would have fired; short
# enough to be a test. The writer under test waits STATE_LOCK_LIVENESS_SECONDS,
# so the hold length only has to exceed the OLD bound to prove the defect.
_HOLD_PAST_HELPER_DEFAULT_SECONDS = file_lock._DEFAULT_TIMEOUT_SECONDS + 1.0


class StateLockLivenessBoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-state-lock-liveness-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="lock-t", base_dir=self.base)
        self.queue_path = self.base / "queues" / "next_cycle_queue.jsonl"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_bound_is_the_longest_arc_held_under_one_transaction(self) -> None:
        # The holders a state writer can wait on are the three `state_store`
        # regions that keep ONE transaction open across git steps at the
        # cap; the bound is the longest of their arcs, read from the same
        # registry the AST walker and the spawn trace check against the
        # code — never a count typed here.
        cap = state_store.GIT_TIMEOUT_SECONDS
        self.assertIs(ledger_module.STATE_LOCK_LIVENESS_SECONDS, arcs.STATE_LOCK_LIVENESS_SECONDS)
        self.assertEqual(
            STATE_LOCK_LIVENESS_SECONDS,
            max(arcs.arc_seconds(arc) for arc in arcs.STATE_TRANSACTION_ARCS.values()),
        )
        # The longest is the resumed accepted-loser recovery: fetch,
        # fast-forward, probe. The rebase (fetch, tree move) and the checkout
        # cleanup (probe, worktree removal) are two steps each.
        self.assertEqual(STATE_LOCK_LIVENESS_SECONDS, arcs.arc_seconds(arcs.PENDING_RECOVERY_ARC))
        self.assertEqual(STATE_LOCK_LIVENESS_SECONDS, 3 * cap)
        self.assertEqual(STATE_LOCK_LIVENESS_SECONDS, 900.0)
        self.assertEqual(arcs.arc_seconds(arcs.REBASE_TRANSACTION_ARC), 2 * cap)
        self.assertEqual(arcs.arc_seconds(arcs.CHECKOUT_CLEANUP_TRANSACTION_ARC), 2 * cap)
        # Strictly more than the typed "two steps at cap" that undercounted
        # the recovery, and than the lock helper's default writers inherited.
        self.assertGreater(STATE_LOCK_LIVENESS_SECONDS, 2 * cap)
        self.assertGreater(STATE_LOCK_LIVENESS_SECONDS, file_lock._DEFAULT_TIMEOUT_SECONDS)

    def _lock_waits(self, **transaction_kwargs) -> list[float]:
        """The `timeout_seconds` each ordered lock was asked to wait."""
        seen: list[float] = []
        real_lock = ledger_module.with_exclusive_lock

        def spy(path, **kwargs):
            seen.append(kwargs["timeout_seconds"])
            return real_lock(path, **kwargs)

        with mock.patch.object(ledger_module, "with_exclusive_lock", new=spy):
            with state_transaction([self.queue_path], **transaction_kwargs):
                pass
        self.assertTrue(seen, "the transaction acquired no lock at all")
        return seen

    def test_every_state_transaction_waits_the_liveness_bound_by_default(self) -> None:
        waits = self._lock_waits()
        # The first lock is offered the whole bound; every later lock only
        # what the earlier ones left — never more, never a per-lock reset.
        self.assertGreater(len(waits), 1, "the transaction takes more than one lock")
        self.assertAlmostEqual(waits[0], STATE_LOCK_LIVENESS_SECONDS, delta=1.0)
        for earlier, later in zip(waits, waits[1:]):
            self.assertLessEqual(later, earlier)
        self.assertGreater(waits[-1], STATE_LOCK_LIVENESS_SECONDS - 1.0)

    def test_an_explicit_timeout_still_overrides_the_default(self) -> None:
        # Callers that KNOW their holder (a test proving lock order, a probe
        # that must not wait) keep the real parameter; the default is for
        # writers that cannot know who holds the group lock.
        waits = self._lock_waits(timeout_seconds=0.5)
        self.assertAlmostEqual(waits[0], 0.5, delta=0.1)
        self.assertTrue(all(w <= 0.5 for w in waits))

    def test_the_bound_is_one_deadline_across_the_ordered_locks(self) -> None:
        # Deterministic pin of the arithmetic: a clock that advances 100 s
        # per acquisition (a live holder on each lock) must leave each later
        # lock exactly that much less, so the whole transaction is bounded
        # by ONE STATE_LOCK_LIVENESS_SECONDS — not by N of them.
        clock = [1000.0]
        waits: list[float] = []
        real_lock = ledger_module.with_exclusive_lock

        def spy(path, **kwargs):
            waits.append(kwargs["timeout_seconds"])
            clock[0] += 100.0
            return real_lock(path, **kwargs)

        with mock.patch.object(ledger_module.time, "monotonic", side_effect=lambda: clock[0]), \
                mock.patch.object(ledger_module, "with_exclusive_lock", new=spy):
            with state_transaction([self.queue_path]):
                pass

        expected = [
            STATE_LOCK_LIVENESS_SECONDS - 100.0 * ordinal for ordinal in range(len(waits))
        ]
        self.assertEqual(waits, expected)

    def test_a_writer_behind_two_wedged_holders_fails_at_the_bound_not_twice_it(self) -> None:
        # Behavioural pin. One holder sits on the FIRST ordered lock (the
        # state group) and lets go after `first_hold`; another sits on the
        # LAST (the concrete file) for longer than the writer's bound. A
        # per-lock bound would give the writer a fresh `bound` after the
        # group lock and let it succeed at `last_hold`; one deadline fails
        # it at `bound`, before the second holder has let go.
        bound = 4.0
        first_hold = 3.0
        last_hold = 5.5
        ordered = ledger_module._transaction_lock_paths([self.queue_path])
        self.assertGreater(len(ordered), 1)
        first_lock, last_lock = ordered[0], ordered[-1]
        holders_ready = threading.Barrier(3)
        errors: list[BaseException] = []

        def hold(lock_path: Path, seconds: float) -> None:
            try:
                with with_exclusive_lock(lock_path, timeout_seconds=bound):
                    holders_ready.wait(timeout=bound)
                    time.sleep(seconds)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        threads = [
            threading.Thread(target=hold, args=(first_lock, first_hold), daemon=True),
            threading.Thread(target=hold, args=(last_lock, last_hold), daemon=True),
        ]
        for thread in threads:
            thread.start()
        holders_ready.wait(timeout=bound)
        started = time.monotonic()
        with self.assertRaisesRegex(TimeoutError, "state_transaction_liveness_bound_exhausted"):
            with state_transaction([self.queue_path], timeout_seconds=bound):
                pass
        waited = time.monotonic() - started
        for thread in threads:
            thread.join(timeout=last_hold + bound)
        self.assertEqual(errors, [])
        self.assertGreaterEqual(waited, first_hold - 0.5, "the writer must have waited past the first holder")
        self.assertLess(waited, last_hold - 0.5, "the writer must have failed before the last holder let go")

    def test_a_writer_outlasts_a_holder_that_exceeds_the_lock_helpers_default(self) -> None:
        # The production shape: a healthy orchestrator holds the group lock
        # for longer than 5 s; a writer arrives meanwhile. Before the fix the
        # writer raised TimeoutError at 5 s while the holder was still doing
        # legitimate work. Now it waits, and its row lands after the hold.
        held = threading.Event()
        release = threading.Event()
        holder_errors: list[BaseException] = []

        def hold_group_lock() -> None:
            try:
                with state_transaction([self.queue_path]):
                    held.set()
                    release.wait(timeout=STATE_LOCK_LIVENESS_SECONDS)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                holder_errors.append(exc)

        holder = threading.Thread(target=hold_group_lock, daemon=True)
        holder.start()
        self.assertTrue(held.wait(timeout=STATE_LOCK_LIVENESS_SECONDS))
        releaser = threading.Timer(_HOLD_PAST_HELPER_DEFAULT_SECONDS, release.set)
        releaser.start()
        try:
            started = time.monotonic()
            stored = append_declared_fixture(
                self.queue_path,
                {"schema_version": 1, "event": "after-long-hold"},
                expected_surface="next_cycle_queue",
            )
            waited = time.monotonic() - started
        finally:
            release.set()
            releaser.cancel()
            holder.join(timeout=STATE_LOCK_LIVENESS_SECONDS)

        self.assertEqual(holder_errors, [])
        self.assertEqual(stored["event"], "after-long-hold")
        self.assertGreaterEqual(
            waited,
            file_lock._DEFAULT_TIMEOUT_SECONDS,
            "the writer must have been blocked past the lock helper's default",
        )


class TheLifecycleLockWaitsForTheHoldersWholeArc(unittest.TestCase):
    """`_state_store_lifecycle_lock` used to wait GIT_TIMEOUT_SECONDS — the
    cap of ONE git call — for a holder whose legitimate work is a SEQUENCE
    of such calls. A second orchestrator on one checkout raised
    `state_store_lifecycle_lock_timeout` while the first was healthy. The
    first repair typed the sequence's length (three per attempt) beside the
    constant and undercounted it by two per lost-race attempt plus the
    pending-recovery replay; the bound is now a sum over the registered
    steps of the arcs the code runs (`state_store_lifecycle_arcs`)."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-lifecycle-lock-"))

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _repo(self) -> Path:
        repo = self.tmp / "repo"
        repo.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
        return repo

    def test_the_bound_is_the_longest_holder_arc_at_the_git_cap(self) -> None:
        cap = state_store.GIT_TIMEOUT_SECONDS
        # The publish holder: the pending recovery (3 steps) once, then
        # PUBLISH_MAX_ATTEMPTS attempts of 5 steps — the arc the typed count
        # priced at 3 per attempt and no recovery.
        self.assertEqual(
            state_store.STATE_STORE_PUBLISH_ARC_SECONDS,
            arcs.arc_seconds(arcs.PENDING_RECOVERY_ARC)
            + state_store.PUBLISH_MAX_ATTEMPTS * arcs.arc_seconds(arcs.PUBLISH_ATTEMPT_ARC),
        )
        self.assertEqual(state_store.STATE_STORE_PUBLISH_ARC_SECONDS, (3 + 3 * 5) * cap)
        # The checkout holder: probe, fetch, probe, the recovery, probe, the
        # old store's removal, the new worktree.
        self.assertEqual(state_store.STATE_STORE_CHECKOUT_ARC_SECONDS, 9 * cap)
        self.assertEqual(
            state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
            max(state_store.STATE_STORE_PUBLISH_ARC_SECONDS, state_store.STATE_STORE_CHECKOUT_ARC_SECONDS),
        )
        self.assertEqual(state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, 5400.0)
        # Strictly more than one call's cap — the defect's own measurement —
        # more than the typed bound that undercounted the holder (9 x cap),
        # and at least the group-lock bound, whose holder (the replay) runs
        # INSIDE this arc.
        self.assertGreater(state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, cap)
        self.assertGreater(state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, 9 * cap)
        self.assertGreaterEqual(
            state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS, STATE_LOCK_LIVENESS_SECONDS,
        )

    def test_the_orchestrator_defaults_to_the_attempt_count_the_bound_prices(self) -> None:
        for orchestrator in (
            state_store.publish_with_contention_replay,
            state_store._publish_with_contention_replay_locked,
        ):
            parameter = inspect.signature(orchestrator).parameters["max_attempts"]
            self.assertEqual(parameter.default, state_store.PUBLISH_MAX_ATTEMPTS)

    def test_a_waiter_asks_the_lock_for_the_lifecycle_bound(self) -> None:
        waits: list[float] = []
        real_lock = state_store.with_exclusive_lock

        def spy(path, **kwargs):
            waits.append(kwargs["timeout_seconds"])
            return real_lock(path, **kwargs)

        repo = self._repo()
        with mock.patch.object(state_store, "with_exclusive_lock", new=spy):
            with state_store._state_store_lifecycle_lock(repo):
                pass
        self.assertEqual(waits, [state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS])

    def test_a_wedged_holder_still_fails_loudly_naming_the_bound(self) -> None:
        # Liveness, not budget: with the bound shrunk to a test size, a
        # holder that outlives it is refused with the bound in the message.
        repo = self._repo()
        common_dir = state_store._git_common_directory(repo)
        held = threading.Event()
        release = threading.Event()

        def hold() -> None:
            with with_exclusive_lock(common_dir / state_store._LIFECYCLE_LOCK_TARGET, timeout_seconds=5.0):
                held.set()
                release.wait(timeout=30.0)

        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        self.assertTrue(held.wait(timeout=10.0))
        try:
            with mock.patch.object(state_store, "STATE_STORE_LIFECYCLE_LIVENESS_SECONDS", 0.2):
                with self.assertRaisesRegex(
                    state_store.StateStoreError, "state_store_lifecycle_lock_timeout: waited 0.2s",
                ):
                    with state_store._state_store_lifecycle_lock(repo):
                        pass
        finally:
            release.set()
            holder.join(timeout=10.0)


class TheExecutorSubmitWallClockCoversTheBound(unittest.TestCase):
    """`ci_executor` kills the kernel `agent submit-result` child at
    SUBMIT_RESULT_TIMEOUT_SECONDS. That number used to be 120 while the
    kernel's own lock bound was 600: the highest-value writer died under a
    healthy replay long before the bound could act, released as
    `submit_timeout_120s`, and the whole paid run was re-dispatched. The
    executor now derives its wall clock from the kernel's bounds, and the
    drain loop prices the WHOLE child — not the CLI cap, not the CLI cap
    plus the submit — into the worst case it checks, so the lane still fits
    its job and no child's wait reaches the job's reserve."""

    def test_the_submit_child_outlives_the_kernel_lock_bound(self) -> None:
        self.assertGreater(ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS, STATE_LOCK_LIVENESS_SECONDS)
        # ...and the evidence probes that precede the lock, and the kernel's
        # own work after it.
        self.assertGreaterEqual(
            ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS,
            STATE_LOCK_LIVENESS_SECONDS
            + EVIDENCE_VERIFICATION_LIVENESS_SECONDS
            + ci_executor.KERNEL_CHILD_WORK_SECONDS,
        )
        self.assertGreater(ci_executor.KERNEL_CHILD_WORK_SECONDS, 0)

    def test_the_executor_reads_the_kernel_bounds_not_a_copy(self) -> None:
        self.assertEqual(ci_executor._STATE_LOCK_LIVENESS_SECONDS, STATE_LOCK_LIVENESS_SECONDS)
        self.assertEqual(
            ci_executor._EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
            EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
        )
        self.assertEqual(ci_executor._GIT_PROBE_WORST_CASE_SECONDS, GIT_PROBE_WORST_CASE_SECONDS)
        self.assertEqual(ci_executor._GIT_TIMEOUT_SECONDS, state_store.GIT_TIMEOUT_SECONDS)
        self.assertEqual(
            ci_executor._STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
            state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
        )
        self.assertEqual(
            ci_executor._STATE_STORE_CHECKOUT_ARC_SECONDS,
            state_store.STATE_STORE_CHECKOUT_ARC_SECONDS,
        )
        self.assertEqual(
            ci_executor._HUMAN_REQUIRED_RECORD_WAIT_SECONDS,
            HUMAN_REQUIRED_RECORD_WAIT_SECONDS,
        )

    def test_the_human_required_record_child_outlives_the_kernels_record_path(self) -> None:
        # The record children (a model refusal, an agent refusal envelope)
        # ran at 30 s against a kernel path that waits one state transaction
        # for its governance row and then notifies — the submit's 120-vs-600
        # disagreement, on the refusal exits. The kernel exports what that
        # path can legitimately wait; the executor derives from it.
        self.assertEqual(
            HUMAN_REQUIRED_RECORD_WAIT_SECONDS,
            STATE_LOCK_LIVENESS_SECONDS + NOTIFY_WORST_CASE_SECONDS,
        )
        self.assertEqual(
            NOTIFY_WORST_CASE_SECONDS,
            len(NOTIFY_CHANNELS) * SENDER_WALL_CLOCK_SECONDS + STATE_LOCK_LIVENESS_SECONDS,
        )
        self.assertEqual(
            ci_executor.HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS,
            int(HUMAN_REQUIRED_RECORD_WAIT_SECONDS + ci_executor.KERNEL_CHILD_WORK_SECONDS),
        )
        self.assertGreater(ci_executor.HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS, STATE_LOCK_LIVENESS_SECONDS)
        # 900 (the governance transaction) + 4 x 120 + 900 (the channels,
        # then the outbox transaction) + 120 (the kernel's own work).
        self.assertEqual(ci_executor.HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS, 2400)
        # ARIA-HIGH-124 (round 3) — the record is written IN-PROCESS through
        # the kernel's own recorder, never as a `human-required record`
        # child: the operator CLI's free-text `--reason` validator refused
        # any kernel-minted id carrying ten consecutive digits as a phone
        # number, and the escalation was lost. Read from the executor's AST:
        # no `subprocess.run` names the `human-required` command, and the
        # one recorder calls the kernel function.
        tree = ast.parse(Path(ci_executor.__file__).read_text(encoding="utf-8"))
        record_children = 0
        recorder_calls = 0
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            callee = node.func
            if isinstance(callee, ast.Attribute) and callee.attr == "run" and node.args and isinstance(node.args[0], ast.List):
                literals = [e.value for e in node.args[0].elts if isinstance(e, ast.Constant)]
                if "human-required" in literals:
                    record_children += 1
            if isinstance(callee, ast.Call):
                continue
            if getattr(callee, "id", None) == "record_human_required" or (
                isinstance(callee, ast.Attribute) and callee.attr == "record_human_required"
            ):
                recorder_calls += 1
        self.assertEqual(record_children, 0, "the executor spawns no `human-required record` child")
        self.assertEqual(recorder_calls, 1, "one in-process recorder (`_record_human_required`)")
        self.assertNotIn('"human-required", "record"', Path(ci_executor.__file__).read_text(encoding="utf-8"))

    def test_a_childs_worst_case_prices_the_whole_child(self) -> None:
        # Claim (one lock wait + work) and its pre-claim probe, the CLI run,
        # the terminal writer at the longer of its two wall clocks (the
        # submit, or the human-required record on a refusal exit), the
        # release (one lock wait + work): every wait a child can legally
        # make, in one sum. Two lock waits and a three-attempt probe used to
        # be missing from it — the very seconds the job reserve then had to
        # absorb; the record child used to be priced under the submit's
        # bound while running at 30 s.
        with mock.patch.dict("os.environ", {"MAX_TIMEOUT_SECONDS": "1800"}):
            worst_case = ci_executor._child_worst_case_seconds()
        self.assertEqual(worst_case, ci_executor.child_worst_case_seconds(1800))
        self.assertEqual(
            ci_executor.TERMINAL_WRITER_TIMEOUT_SECONDS,
            max(ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS, ci_executor.HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS),
        )
        self.assertEqual(
            worst_case,
            (STATE_LOCK_LIVENESS_SECONDS + ci_executor.KERNEL_CHILD_WORK_SECONDS)
            + GIT_PROBE_WORST_CASE_SECONDS
            + 1800
            + ci_executor.TERMINAL_WRITER_TIMEOUT_SECONDS
            + (STATE_LOCK_LIVENESS_SECONDS + ci_executor.KERNEL_CHILD_WORK_SECONDS),
        )
        # 1020 (claim) + 93 (probe) + 1800 (CLI) + 2400 (record slot) + 1020
        # (release): every state-lock wait in it is the 900 s recovery arc.
        self.assertEqual(worst_case, 6333)
        self.assertEqual(ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS, 1320)
        self.assertEqual(ci_executor.STATE_WRITE_CHILD_WORST_CASE_SECONDS, 1020)
        self.assertEqual(
            ci_executor.STATE_WRITE_CHILD_WORST_CASE_SECONDS,
            STATE_LOCK_LIVENESS_SECONDS + ci_executor.KERNEL_CHILD_WORK_SECONDS,
        )
        # With per-request worktrees the child is bracketed by `git worktree
        # add` and `git worktree remove`, each at the store's git cap.
        self.assertEqual(
            ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS, 2 * state_store.GIT_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            ci_executor_drain.REQUEST_WORKTREE_GIT_TIMEOUT_SECONDS, state_store.GIT_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            ci_executor.child_worst_case_seconds(1800, worktree_per_request=True),
            worst_case + ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS,
        )
        with mock.patch.dict("os.environ", {"MAX_TIMEOUT_SECONDS": "1800"}):
            self.assertEqual(
                ci_executor._child_worst_case_seconds(worktree_per_request=True),
                worst_case + ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS,
            )

    def test_an_implementation_childs_worst_case_prices_its_delivery(self) -> None:
        # ARIA-HIGH-124 (round 3) — the executor runs a whole phase AFTER an
        # implementation spawn: the quarantine's publication, the contained
        # apply gate at the staged ceiling per command, the push, the PR.
        # The derivation used to sum claim + probe + CLI + terminal writer +
        # release and price none of it, so its own invariant ("neither
        # branch can run past what the drain loop checked") was untrue for
        # every implementation request: a child admitted at the window's
        # edge could legally run ~3 h past it. The term is the kernel's ONE
        # derivation off the suite and its ceiling.
        from aria_kernel.delivery_credentials import DELIVERY_CREDENTIAL_WORST_CASE_SECONDS
        from aria_kernel.git_containment import QUARANTINE_PUBLICATION_WORST_CASE_SECONDS
        from aria_kernel.evidence_probe import EVIDENCE_VERIFICATION_LIVENESS_SECONDS
        from aria_kernel.implementation_delivery import (
            DELIVERY_COMMIT_IDENTITY_SECONDS,
            DELIVERY_GIT_CALLS,
            DELIVERY_RESULT_ADMISSIBLE_SECONDS,
            DELIVERY_WORK_ALLOWANCE_SECONDS,
            IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
            IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS,
            delivery_worst_case_seconds,
        )
        from aria_kernel.implementation_safety import (
            CANONICAL_VALIDATION_TIMEOUT_MS,
            COMMIT_SIGNATURE_VERIFY_TIMEOUT_SECONDS,
        )
        from aria_kernel.pr_manager import GH_PR_CREATE_TIMEOUT_SECONDS
        from aria_kernel.validation_suite import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE

        canonical = delivery_worst_case_seconds(
            validation_commands=CANONICAL_VALIDATION_COMMANDS_EXECUTABLE,
            validation_timeout_ms=CANONICAL_VALIDATION_TIMEOUT_MS,
        )
        self.assertEqual(
            canonical,
            len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE) * (CANONICAL_VALIDATION_TIMEOUT_MS // 1000)
            + DELIVERY_GIT_CALLS * state_store.GIT_TIMEOUT_SECONDS
            + DELIVERY_COMMIT_IDENTITY_SECONDS
            + DELIVERY_RESULT_ADMISSIBLE_SECONDS
            + DELIVERY_CREDENTIAL_WORST_CASE_SECONDS
            + GH_PR_CREATE_TIMEOUT_SECONDS
            + DELIVERY_WORK_ALLOWANCE_SECONDS,
        )
        # (round 4) the `commit_identity` stage's own `git verify-commit`
        # is priced too: the delivery verifies the tip against the held key
        # before it pushes anything.
        self.assertEqual(DELIVERY_COMMIT_IDENTITY_SECONDS, COMMIT_SIGNATURE_VERIFY_TIMEOUT_SECONDS)
        # (round 5) and the `result_admissible` stage's decision — the
        # submit's own chain, run before the push — at ONE decision's probe
        # clock, the same term the submit wall clock is derived from.
        self.assertEqual(DELIVERY_RESULT_ADMISSIBLE_SECONDS, int(EVIDENCE_VERIFICATION_LIVENESS_SECONDS))
        # (round 6) and the credential's mint and revoke at their bounds:
        # the lease is minted INSIDE the delivery, after the gate, so the
        # delivery pays for the mint — and the implementation child pays
        # once more for the pre-spawn admission (a lease minted and revoked
        # to prove the lane can mint before a turn is spent).
        self.assertEqual(DELIVERY_CREDENTIAL_WORST_CASE_SECONDS, 40)
        # 4 x 2700 + 4 x 300 + 10 + 300 + 40 + 300 + 120, then the publication's
        # 5 x 120 and the admission's 40.
        self.assertEqual(canonical, 12770)
        self.assertEqual(IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS,
                         QUARANTINE_PUBLICATION_WORST_CASE_SECONDS + DELIVERY_CREDENTIAL_WORST_CASE_SECONDS)
        self.assertEqual(IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS, canonical + IMPLEMENTATION_TERM_BESIDE_DELIVERY_SECONDS)
        self.assertEqual(IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS, 13410)
        self.assertEqual(ci_executor.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS, IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS)
        # A plan's recipes make the request's own term larger; the executor
        # and the drain price a request off its staged action, never off
        # the canonical constant.
        self.assertGreater(
            delivery_worst_case_seconds(
                validation_commands=[*CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, "python3 -m unittest tests.x"],
                validation_timeout_ms=CANONICAL_VALIDATION_TIMEOUT_MS,
            ),
            canonical,
        )
        # The implementation child: the same sum with the delivery term
        # between the CLI and the terminal writer.
        implementation_child = ci_executor.child_worst_case_seconds(
            1800, worktree_per_request=True,
            implementation_delivery_seconds=IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
        )
        self.assertEqual(
            implementation_child,
            ci_executor.child_worst_case_seconds(1800, worktree_per_request=True) + IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
        )
        self.assertEqual(implementation_child, 6933 + 13410)
        with mock.patch.dict("os.environ", {"MAX_TIMEOUT_SECONDS": "1800"}):
            self.assertEqual(
                ci_executor._child_worst_case_seconds(
                    worktree_per_request=True, implementation_delivery_seconds=IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
                ),
                implementation_child,
            )
        # The bound the delivery itself refuses under is the same derivation.
        from aria_kernel.implementation_delivery import deadline_refusal

        self.assertIsNone(deadline_refusal(job_deadline_epoch=None, worst_case_seconds=canonical, now=0.0))
        self.assertIsNone(deadline_refusal(job_deadline_epoch=1000.0 + canonical, worst_case_seconds=canonical, now=1000.0))
        self.assertEqual(
            deadline_refusal(job_deadline_epoch=1000.0 + canonical - 1, worst_case_seconds=canonical, now=1000.0),
            f"deadline_insufficient:remaining={canonical - 1}s:worst_case={canonical}s",
        )

    def test_the_claim_argv_leases_the_priced_worst_case_not_the_kernel_default(self) -> None:
        # ARIA-HIGH-124 (round 4) — the structural half of the lease pins
        # (the rows themselves: `test_executor_implementation_identity`,
        # `test_ci_executor_live_path_smoke`). Read from the executor's
        # AST: the `agent claim` argv carries `--lease-seconds`, and the
        # value is `_child_worst_case_seconds(...)` over this request's
        # delivery term — never a literal and never the kernel's
        # `DEFAULT_LEASE_SECONDS` (1800, which equals MAX_TIMEOUT_SECONDS,
        # so a full-length CLI run's submit was refused `lease_expired`).
        from aria_kernel.agent_invocations import DEFAULT_LEASE_SECONDS

        tree = ast.parse(Path(ci_executor.__file__).read_text(encoding="utf-8"))
        claim_argvs = [
            node for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", None) == "_kernel_cli_argv"
            and [arg.value for arg in node.args[:2] if isinstance(arg, ast.Constant)] == ["agent", "claim"]
        ]
        self.assertEqual(len(claim_argvs), 1, "one claim argv")
        literals = [arg.value for arg in claim_argvs[0].args if isinstance(arg, ast.Constant)]
        self.assertIn("--lease-seconds", literals)
        # The value beside the flag is `str(_lease_seconds)`.
        flag_index = next(i for i, arg in enumerate(claim_argvs[0].args)
                          if isinstance(arg, ast.Constant) and arg.value == "--lease-seconds")
        value = claim_argvs[0].args[flag_index + 1]
        self.assertIsInstance(value, ast.Call)
        self.assertEqual(getattr(value.func, "id", None), "str")
        self.assertEqual(getattr(value.args[0], "id", None), "_lease_seconds")
        # And `_lease_seconds` is the priced bound with the request's own
        # delivery term.
        assignment = next(
            node for node in ast.walk(tree)
            if isinstance(node, ast.Assign)
            and any(getattr(target, "id", None) == "_lease_seconds" for target in node.targets)
        )
        self.assertIsInstance(assignment.value, ast.Call)
        self.assertEqual(getattr(assignment.value.func, "id", None), "_child_worst_case_seconds")
        self.assertEqual(
            [keyword.arg for keyword in assignment.value.keywords], ["implementation_delivery_seconds"],
        )
        self.assertEqual(
            getattr(assignment.value.keywords[0].value.func, "id", None), "_request_delivery_seconds",
        )
        with mock.patch.dict("os.environ", {"MAX_TIMEOUT_SECONDS": str(DEFAULT_LEASE_SECONDS)}):
            self.assertGreater(ci_executor._child_worst_case_seconds(), DEFAULT_LEASE_SECONDS)

    def test_the_drain_loop_starts_a_child_only_when_that_worst_case_fits(self) -> None:
        # Source pin: the budget check names the worst-case accessor — with
        # the run's own worktree policy — not the CLI timeout alone (the
        # pre-fix shape, which let the submit's wait run past the drain
        # window into the publish reserve).
        source = inspect.getsource(ci_executor_drain.drain_pending)
        self.assertIn(
            "_engine._child_worst_case_seconds(worktree_per_request=worktree_per_request)", source,
        )
        self.assertNotIn("elapsed + _engine._max_timeout_seconds()", source)
        # ARIA-HIGH-124 (round 3) — once the request is known, ITS worst
        # case (an implementation's delivery off the staged action) is
        # checked against what remains, and a request that does not fit is
        # skipped without a claim rather than started.
        self.assertIn("implementation_delivery_seconds=_engine._request_delivery_seconds(", source)
        self.assertIn("elapsed + request_worst_case > _drain_budget_seconds()", source)
        self.assertIn("window_excluded.add(request_id)", source)

    def test_the_scheduled_lane_fits_a_whole_child_and_keeps_the_jobs_reserve(self) -> None:
        # The workflow's arithmetic, read from the workflow, and the
        # statement its comments make: a child may start while its WHOLE
        # worst case (claim, probe, CLI run, submit, release — the one
        # derivation) fits the drain window, and the window plus the job's
        # own reserve (restore before the loop, publish after it, the
        # unbounded steps around them) fits the job. No child wait is
        # charged to the reserve any more, so the reserve is priced from
        # the store's bounds alone.
        workflow_text = (
            _REPO_ROOT / ".github" / "workflows" / "aria-agent-executor.yml"
        ).read_text(encoding="utf-8")
        workflow = yaml.safe_load(workflow_text)
        job = next(
            job for job in workflow["jobs"].values()
            if any(step.get("id") == "executor" for step in job.get("steps", []))
        )
        step = next(step for step in job["steps"] if step.get("id") == "executor")
        job_seconds = int(job["timeout-minutes"]) * 60
        max_timeout = int(step["env"]["MAX_TIMEOUT_SECONDS"])
        drain_budget = int(step["env"]["ARIA_DRAIN_BUDGET_SECONDS"])
        # Priced with the per-request worktree bracket ON: the policy that
        # turns it on lives in the repo, and the window must hold either way.
        child_worst_case = ci_executor.child_worst_case_seconds(max_timeout, worktree_per_request=True)
        self.assertLessEqual(child_worst_case, drain_budget)
        self.assertLessEqual(ci_executor.child_worst_case_seconds(max_timeout), drain_budget)
        # ARIA-HIGH-124 (round 3) — and with the implementation child's
        # delivery ON (the canonical shape): a window that cannot hold an
        # implementation child never delivers one.
        implementation_child = ci_executor.child_worst_case_seconds(
            max_timeout, worktree_per_request=True,
            implementation_delivery_seconds=ci_executor.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
        )
        self.assertLessEqual(implementation_child, drain_budget)
        # The figures the comment beside the window states, so a re-derived
        # bound that moves them is a visible change in the YAML too.
        self.assertEqual(child_worst_case, 6933)
        self.assertEqual(implementation_child, 20343)
        self.assertIn("1020 + 93 + 1800 + 2400 + 1020 =\n          # 6333 s", workflow_text)
        self.assertIn("= 13410 s in the canonical shape, so 20343 s", workflow_text)
        self.assertIn(f"with {drain_budget - 20343} s of start", workflow_text)
        self.assertIn(f"(a judge child: {drain_budget - 6333} s, {drain_budget - 6933} s with", workflow_text)
        self.assertLessEqual(drain_budget + ci_executor_drain.JOB_RESERVE_SECONDS, job_seconds)
        self.assertEqual(int(job["timeout-minutes"]), 510)
        # Round 6: the start window before an implementation child is a
        # measured figure, not a remainder — 657 s clears the >40 s first
        # `next-pending` seen under load with the same margin the judge
        # child always had.
        self.assertGreaterEqual(drain_budget - 20343, 600)
        self.assertEqual(ci_executor_drain.JOB_RESERVE_SECONDS, 9000)
        # The job exports the absolute deadline every spawn and delivery
        # runs under: its own ceiling anchored at launch, minus what it must
        # still run after the drain (the publish arc and the steps
        # allowance) — the pre-spawn reservation, the pre-publication
        # admission and the delivery's `deadline_insufficient` all read it.
        self.assertEqual(ci_executor_drain.JOB_RESERVE_AFTER_DRAIN_SECONDS,
                         state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS + ci_executor_drain.JOB_STEPS_ALLOWANCE_SECONDS)
        self.assertIn(f"JOB_TIMEOUT_MINUTES={int(job['timeout-minutes'])}\n", step["run"])
        self.assertIn(f"POST_DRAIN_RESERVE_SECONDS={ci_executor_drain.JOB_RESERVE_AFTER_DRAIN_SECONDS}\n", step["run"])
        self.assertIn("export ARIA_JOB_DEADLINE_EPOCH=$(( ANCHOR_EPOCH + JOB_TIMEOUT_MINUTES * 60 - POST_DRAIN_RESERVE_SECONDS ))", step["run"])
        self.assertTrue(any(step.get("name") == "Anchor the job launch epoch" for step in job["steps"]))
        # The window's end at the worst-case restore stays inside the deadline.
        self.assertLessEqual(
            ci_executor_drain.STATE_RESTORE_WORST_CASE_SECONDS + drain_budget,
            job_seconds - ci_executor_drain.JOB_RESERVE_AFTER_DRAIN_SECONDS,
        )
        # The comment beside the window must state the check the loop makes.
        # It said `elapsed + MAX_TIMEOUT_SECONDS <= budget` for two rounds
        # after the loop had stopped pricing the CLI cap alone.
        self.assertNotIn("elapsed + MAX_TIMEOUT_SECONDS <= budget", workflow_text)
        self.assertIn("child_worst_case_seconds(MAX_TIMEOUT_SECONDS) <= budget", workflow_text)
        self.assertIn("JOB_RESERVE_SECONDS", workflow_text)
        # The reserve is the job's own steps, priced from their bounds: the
        # restore's whole checkout arc, the publish holder's longest arc —
        # both sums over the registered lifecycle steps, neither a count
        # typed here — and the allowance for the steps that carry no
        # kernel bound.
        self.assertEqual(
            ci_executor_drain.STATE_RESTORE_WORST_CASE_SECONDS,
            state_store.STATE_STORE_CHECKOUT_ARC_SECONDS,
        )
        self.assertEqual(
            ci_executor_drain.JOB_RESERVE_SECONDS,
            state_store.STATE_STORE_CHECKOUT_ARC_SECONDS
            + state_store.STATE_STORE_LIFECYCLE_LIVENESS_SECONDS
            + ci_executor_drain.JOB_STEPS_ALLOWANCE_SECONDS,
        )
        self.assertGreater(ci_executor_drain.JOB_STEPS_ALLOWANCE_SECONDS, 0)
        # The env-less default window is the same derivation, in its
        # maximal shape, plus its margin.
        self.assertEqual(
            ci_executor_drain.DEFAULT_DRAIN_BUDGET_SECONDS,
            ci_executor.child_worst_case_seconds(
                ci_executor.DEFAULT_TIMEOUT_SECONDS, worktree_per_request=True,
                implementation_delivery_seconds=ci_executor.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
            )
            + ci_executor_drain.DRAIN_WINDOW_MARGIN_SECONDS,
        )


if __name__ == "__main__":
    unittest.main()
