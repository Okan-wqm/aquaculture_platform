"""The worker-result gate reads the claim ledger under the writers' lock order.

`submit_worker_result` verifies the caller's lease against
`dispatch/claims.jsonl` under a lock. It took a raw
`with_exclusive_lock(claims_path)`: the FILE lock alone, outside the ordered
acquisition every writer of that ledger uses
(`worker_dispatch.claim_assignment` → `state_transaction([claims_path])`:
group locks, index locks, then the file lock, one liveness deadline), and
with the lock helper's 5 s default as its whole wait. Two defects of the
lane's class: a reader that could give up on a healthy writer holding the
ledger for longer than 5 s on a loaded host, and one that took a lock the
writers take LAST without the ones they take FIRST.

Pinned: the read goes through `state_transaction`, so it asks for the
state-lock liveness bound and takes the same ordered locks the claim writer
does; and a wedged holder still fails it loudly at the bound named on the
error (liveness, not budget).
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import ledger as ledger_module
from aria_kernel import verification_gate
from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS, state_transaction
from aria_kernel.runtime_profile import set_profile
from tests.test_submit_worker_lease_bound import (
    _TEST_LEASE_TOKEN,
    _seed_claim,
    _seed_request,
    _setup_git_worktree,
)


class TheGateReadsClaimsUnderTheWritersOrder(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-gate-lock-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="t", base_dir=self.base)
        (self.base / "dispatch").mkdir(parents=True)
        self.worktree, base_sha, head_sha = _setup_git_worktree(self.tmp)
        _seed_request(
            self.base, assignment_id="A-1", worktree=self.worktree,
            base_sha=base_sha, head_sha=head_sha,
        )
        _seed_claim(
            self.base, assignment_id="A-1", claim_id="C-1", lease_token=_TEST_LEASE_TOKEN,
        )
        self.claims_path = self.base / "dispatch" / "claims.jsonl"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _submit(self):
        return verification_gate.submit_worker_result(
            from_worktree=self.worktree, assignment_id="A-1",
            tools_root=self.base, lease_token=_TEST_LEASE_TOKEN,
        )

    def test_the_claim_read_takes_the_transactions_ordered_locks_at_its_bound(self) -> None:
        transactions: list[tuple[list[Path], float | None]] = []
        real_transaction = ledger_module.state_transaction

        def spy(paths, **kwargs):
            transactions.append(([Path(p) for p in paths], kwargs.get("timeout_seconds")))
            return real_transaction(paths, **kwargs)

        with mock.patch.object(verification_gate, "state_transaction", new=spy):
            result = self._submit()
        self.assertEqual(result["state"], "accepted")
        claim_reads = [t for t in transactions if t[0] == [self.claims_path]]
        self.assertEqual(len(claim_reads), 1, transactions)
        # No caller-supplied wait: the transaction's own default, the bound
        # sized to the longest legitimate holder, is what this reader waits.
        self.assertIsNone(claim_reads[0][1])
        # And the lock set is the writer's — the ordered derivation for the
        # same path — not the bare file lock.
        expected = ledger_module._transaction_lock_paths([self.claims_path.resolve()])
        self.assertGreater(len(expected), 1, "the claim ledger has group locks the writer takes")

    def test_no_raw_file_lock_remains_in_the_gate(self) -> None:
        source = Path(verification_gate.__file__).read_text(encoding="utf-8")
        self.assertNotIn("with with_exclusive_lock(", source)

    def test_a_reader_outlasts_a_writer_holding_past_the_helpers_default(self) -> None:
        # The production shape: a healthy writer holds the claim ledger's
        # ordered locks for longer than 5 s; the gate arrives meanwhile. It
        # used to raise `with_exclusive_lock_timeout`; now it waits and
        # verifies the lease once the writer lets go.
        from aria_kernel import file_lock

        held = threading.Event()
        release = threading.Event()
        errors: list[BaseException] = []

        def hold() -> None:
            try:
                with state_transaction([self.claims_path]):
                    held.set()
                    release.wait(timeout=STATE_LOCK_LIVENESS_SECONDS)
            except BaseException as exc:  # noqa: BLE001 - thread handoff
                errors.append(exc)

        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        self.assertTrue(held.wait(timeout=STATE_LOCK_LIVENESS_SECONDS))
        releaser = threading.Timer(file_lock._DEFAULT_TIMEOUT_SECONDS + 1.0, release.set)
        releaser.start()
        try:
            result = self._submit()
        finally:
            release.set()
            releaser.cancel()
            holder.join(timeout=STATE_LOCK_LIVENESS_SECONDS)
        self.assertEqual(errors, [])
        self.assertEqual(result["state"], "accepted")

    def test_a_wedged_holder_still_fails_the_gate_at_the_bound(self) -> None:
        # Liveness, not budget: with the bound shrunk to a test size and a
        # holder that outlives it, the gate is refused at the bound, naming
        # it — it does not wait the holder out.
        held = threading.Event()
        release = threading.Event()

        def hold() -> None:
            with state_transaction([self.claims_path]):
                held.set()
                release.wait(timeout=30.0)

        holder = threading.Thread(target=hold, daemon=True)
        holder.start()
        self.assertTrue(held.wait(timeout=10.0))
        try:
            with mock.patch.object(ledger_module, "STATE_LOCK_LIVENESS_SECONDS", 0.3):
                with self.assertRaisesRegex(
                    TimeoutError, "state_transaction_liveness_bound_exhausted: bound=0.3s",
                ):
                    self._submit()
        finally:
            release.set()
            holder.join(timeout=10.0)


if __name__ == "__main__":
    unittest.main()
