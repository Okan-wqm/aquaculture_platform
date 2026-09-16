"""A claim row's event time is its append time, captured under the lock.

`claim_request` and `heartbeat_claim` read the clock INSIDE
`state_transaction`; `release_claim` and `reap_stale_claims` read it before.
With the transaction wait raised from 5 s to `STATE_LOCK_LIVENESS_SECONDS`
(600 s) that asymmetry became a real skew: a writer that legitimately waits
behind a healthy replay stamps `released_at` / `requeued.at` / `stale_at`
with a time minutes BEFORE the row lands, and `_latest_claim_row` folds the
claim's rows by exactly that timestamp (ties to append order). A release
that waited could then sort before a heartbeat that landed while it waited.

Pinned here: both writers take the clock after the lock is held — proved by
holding the state-group lock for longer than the clock's resolution and
checking the stamped time is not before the hold ended — and the reaper's
injected `now` (a test's clock) is still honoured.
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel import agent_invocations
from aria_kernel.agent_invocations import (
    _claims_path,
    _iso,
    claim_request,
    create_agent_invocation_request,
    reap_stale_claims,
    release_claim,
)
from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS, read_jsonl, state_transaction
from aria_kernel.runtime_profile import set_profile


# `_iso` stamps whole seconds, so the hold must exceed a second by a margin
# for "stamped after the hold ended" to be distinguishable from "stamped
# before the wait" on any host.
_HOLD_SECONDS = 2.5


class _GroupLockHolder:
    """Holds the claims/results state locks in a thread for `seconds`."""

    def __init__(self, base: Path, seconds: float) -> None:
        self._paths = [
            _claims_path(base), base / "agent-invocations" / "results.jsonl",
        ]
        self._seconds = seconds
        self.held = threading.Event()
        self.released_at: datetime | None = None
        self.errors: list[BaseException] = []
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        try:
            with state_transaction(self._paths):
                self.held.set()
                time.sleep(self._seconds)
                self.released_at = datetime.now(timezone.utc)
        except BaseException as exc:  # noqa: BLE001 - thread handoff
            self.errors.append(exc)

    def __enter__(self) -> "_GroupLockHolder":
        self._thread.start()
        assert self.held.wait(timeout=STATE_LOCK_LIVENESS_SECONDS)
        return self

    def __exit__(self, *exc: object) -> None:
        self._thread.join(timeout=STATE_LOCK_LIVENESS_SECONDS)


class ClaimRowTimeIsAppendTime(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-row-time-"))
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="row-time", base_dir=self.base)
        request = create_agent_invocation_request(
            target_agent="aria-evidence-judge",
            role="evidence_judgment",
            suggested_prompt="prove docs/a.md",
            expected_output_path="docs/x.md",
            must_satisfy=[{"id": "proof", "description": "proof"}],
            allowed_scope=["docs/"],
            evidence_refs=["docs/a.md"],
            base_dir=self.base,
        )
        self.request_id = request["request_id"]

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _claim(self, *, lease_seconds: int = 900) -> dict:
        return claim_request(
            request_id=self.request_id,
            agent_id="test-agent",
            base_dir=self.base,
            lease_seconds=lease_seconds,
        )

    def _rows(self, claim_id: str, event: str) -> list[dict]:
        return [
            row for row in read_jsonl(_claims_path(self.base))
            if row.get("claim_id") == claim_id and row.get("event") == event
        ]

    def test_release_claim_stamps_the_time_it_appended_not_the_time_it_arrived(self) -> None:
        claim = self._claim()
        with _GroupLockHolder(self.base, _HOLD_SECONDS) as holder:
            row = release_claim(
                claim_id=claim["claim_id"],
                agent_id="test-agent",
                lease_token=claim["lease_token"],
                reason="operator_cancel",
                base_dir=self.base,
            )
        self.assertEqual(holder.errors, [])
        self.assertIsNotNone(holder.released_at)
        # The release could only append after the holder let go; its stamp
        # must not predate that moment (whole-second resolution).
        self.assertGreaterEqual(row["released_at"], _iso(holder.released_at))
        requeued = self._rows(claim["claim_id"], "requeued")
        self.assertEqual(len(requeued), 1)
        self.assertGreaterEqual(requeued[0]["at"], _iso(holder.released_at))

    def test_release_claim_reads_the_clock_under_the_lock(self) -> None:
        # Structural pin, independent of timing: the clock is read while
        # the transaction is open, the way claim_request/heartbeat do.
        claim = self._claim()
        inside = {"open": False}
        clock_reads: list[bool] = []
        real_transaction = agent_invocations.state_transaction
        real_now = agent_invocations._utc_now_dt

        class _Spy:
            def __init__(self, cm):
                self._cm = cm

            def __enter__(self):
                inside["open"] = True
                return self._cm.__enter__()

            def __exit__(self, *exc):
                inside["open"] = False
                return self._cm.__exit__(*exc)

        def spied_transaction(*args, **kwargs):
            return _Spy(real_transaction(*args, **kwargs))

        def spied_now():
            clock_reads.append(inside["open"])
            return real_now()

        with mock.patch.object(agent_invocations, "state_transaction", new=spied_transaction), \
                mock.patch.object(agent_invocations, "_utc_now_dt", new=spied_now):
            release_claim(
                claim_id=claim["claim_id"],
                agent_id="test-agent",
                lease_token=claim["lease_token"],
                reason="operator_cancel",
                base_dir=self.base,
            )
        self.assertTrue(clock_reads, "release_claim read no clock")
        self.assertTrue(all(clock_reads), f"clock read outside the lock: {clock_reads}")

    def test_the_reaper_stamps_the_time_it_appended(self) -> None:
        claim = self._claim(lease_seconds=1)
        time.sleep(1.2)  # let the lease expire on the real clock
        with _GroupLockHolder(self.base, _HOLD_SECONDS) as holder:
            reaped = reap_stale_claims(base_dir=self.base)
        self.assertEqual(holder.errors, [])
        self.assertEqual([row["claim_id"] for row in reaped["stale"]], [claim["claim_id"]])
        stale = reaped["stale"][0]
        self.assertGreaterEqual(stale["stale_at"], _iso(holder.released_at))
        followup = (reaped["requeued"] + reaped["human_required"])[0]
        self.assertGreaterEqual(followup["at"], _iso(holder.released_at))

    def test_the_reapers_injected_clock_is_still_the_callers(self) -> None:
        claim = self._claim(lease_seconds=900)
        future = datetime.now(timezone.utc) + timedelta(hours=2)
        reaped = reap_stale_claims(base_dir=self.base, now=future)
        self.assertEqual([row["claim_id"] for row in reaped["stale"]], [claim["claim_id"]])
        self.assertEqual(reaped["stale"][0]["stale_at"], _iso(future))


if __name__ == "__main__":
    unittest.main()
