"""Plan 024 v3 §H-0 + §H-1 + §H-2 — cross-platform exclusive lock +
claim atomicity + submit idempotency tests.

§H-0: aria-kernel/aria_kernel/file_lock.py exposes
with_exclusive_lock as a cross-platform context manager.
§H-1: claim_request wraps the read-state→check→append sequence in
the lock with a CAS recheck so concurrent claims race to a single
winner.
§H-2: submit_claim_result performs an existing-result lookup before
the append; duplicate submissions return idempotent: True instead
of writing a second result row.

Tests:
1. with_exclusive_lock acquire + release single use.
2. with_exclusive_lock timeout when held by another process (sub-
   process spawn for portability).
3. claim_request CAS rechecks state after lock acquisition.
4. submit_claim_result returns idempotent when called twice for the
   same claim_id with the same envelope.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from aria_kernel.file_lock import with_exclusive_lock


class WithExclusiveLockTests(unittest.TestCase):
    def test_acquire_and_release_single_use(self) -> None:
        """Plan 024 §H-0 acceptance (1)."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            target.write_text("", encoding="utf-8")
            with with_exclusive_lock(target):
                # Inside the with: lock side-car file exists.
                lock_path = target.with_suffix(target.suffix + ".lock")
                self.assertTrue(lock_path.exists())
            # POSIX: lock side-car may persist (auto-release on close);
            # Windows: side-car is unlinked on exit. Either way the
            # subsequent acquire must succeed.
            with with_exclusive_lock(target):
                pass

    def test_timeout_when_held_by_another_process(self) -> None:
        """Plan 024 §H-0 acceptance (2)."""
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            target.write_text("", encoding="utf-8")
            # Spawn a child process that holds the lock for 5s.
            child_script = f"""
import sys, time
sys.path.insert(0, {repr(str(Path(__file__).resolve().parent.parent))})
from aria_kernel.file_lock import with_exclusive_lock
from pathlib import Path
with with_exclusive_lock(Path({repr(str(target))})):
    print("LOCKED", flush=True)
    time.sleep(5)
"""
            child = subprocess.Popen(
                [sys.executable, "-c", child_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            try:
                # Wait for the child to confirm lock acquisition.
                line = child.stdout.readline()
                self.assertIn(b"LOCKED", line)
                # Now attempt to acquire from this process with a
                # short timeout — must raise TimeoutError.
                start = time.monotonic()
                with self.assertRaises(TimeoutError):
                    with with_exclusive_lock(target, timeout_seconds=0.5):
                        pass
                elapsed = time.monotonic() - start
                # Should not block much longer than the timeout.
                self.assertLess(elapsed, 1.5,
                    f"timeout took {elapsed:.2f}s; should be ~0.5s")
            finally:
                child.terminate()
                child.wait(timeout=2)

    @unittest.skipUnless(os.name == "posix", "O_NOFOLLOW is POSIX-only")
    def test_existing_symlink_sidecar_is_never_followed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            target = Path(td) / "ledger.jsonl"
            target.write_text("", encoding="utf-8")
            outside = Path(td) / "outside"
            outside.write_text("do not lock me\n", encoding="utf-8")
            sidecar = target.with_suffix(target.suffix + ".lock")
            sidecar.symlink_to(outside)

            with self.assertRaises(OSError):
                with with_exclusive_lock(
                    target,
                    timeout_seconds=0,
                    require_existing=True,
                ):
                    pass

            self.assertTrue(sidecar.is_symlink())
            self.assertEqual(outside.read_text(encoding="utf-8"), "do not lock me\n")

    def test_require_existing_never_creates_a_missing_parent(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            parent = Path(td) / "missing-parent"
            target = parent / "ledger.jsonl"

            with self.assertRaises(OSError):
                with with_exclusive_lock(
                    target,
                    timeout_seconds=0,
                    require_existing=True,
                ):
                    pass

            self.assertFalse(parent.exists())


class ClaimRequestCasTests(unittest.TestCase):
    def test_claim_request_cas_recheck_in_source(self) -> None:
        """Plan 024 §H-1 acceptance (3) source scan: the CAS recheck
        path is wired so a state change between read and lock
        acquisition surfaces as
        claim_request_state_changed_during_lock instead of a stale
        state belief.

        End-to-end concurrency tests would require subprocess
        coordination + a fully-bootstrapped tools dir; the source
        scan guards against the recheck path being deleted later."""
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "agent_invocations.py"
        ).read_text(encoding="utf-8")
        self.assertIn("with state_transaction([claims_path])", src,
            "Plan 024 §H-1 — claims CAS transaction must be wired")
        self.assertIn("claim_request_state_changed_during_lock", src,
            "Plan 024 §H-1 — CAS recheck error code must exist")
        # Recheck must call derive_request_state a second time after
        # lock acquisition (the rechecked variable name is the marker).
        self.assertIn("rechecked = derive_request_state", src,
            "Plan 024 §H-1 — CAS recheck must re-derive state under lock")


class SubmitClaimResultIdempotencyTests(unittest.TestCase):
    def test_submit_idempotency_returns_existing_row(self) -> None:
        """Plan 024 §H-2 acceptance (4)."""
        # We test via the source-level guarantee that an existing-
        # result lookup runs before append. The full E2E that
        # exercises the duplicate-submit path would require a bound
        # tools dir + envelope round-trip; the source scan asserts
        # the idempotency check is wired between the lease validation
        # and the result append.
        src = (
            Path(__file__).resolve().parent.parent
            / "aria_kernel"
            / "agent_invocations.py"
        ).read_text(encoding="utf-8")
        self.assertIn("submit_claim_result_already_persisted", src,
            "Plan 024 §H-2 — idempotency-check error code must exist")
        # Lookup must read results.jsonl filtered by claim_id.
        self.assertIn(
            'row.get("claim_id") == claim_id',
            src.split("submit_claim_result_already_persisted")[0][-500:],
            "Plan 024 §H-2 — existing-result lookup must filter by claim_id",
        )


if __name__ == "__main__":
    unittest.main()
