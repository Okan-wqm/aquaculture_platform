"""`notify()` has a bound of its own, so a child that notifies can be priced.

The executor runs `aria_kernel human-required record` as a child on its
refusal exits and, until 2026-09-12, killed it at 30 s. The kernel path
waits one state transaction for its governance row and then notifies —
and `notify()` had no bound to derive from: each sender used per-operation
transport timeouts (an SMTP session is many operations at 30 s each), and
each channel appended its outbox row under its own state-transaction wait.

Pinned here:

* every sender runs under ONE wall clock (`SENDER_WALL_CLOCK_SECONDS`); a
  transport that never returns is recorded `failed` and the next channel
  runs — the process is not held;
* the call's outbox rows are appended under ONE state transaction after
  every send, never one transaction per channel and never with a sender
  inside the lock;
* `NOTIFY_WORST_CASE_SECONDS` is the sum of those two facts, and
  `human_required.HUMAN_REQUIRED_RECORD_WAIT_SECONDS` adds the governance
  transaction in front of it.
"""
from __future__ import annotations

import shutil
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import ledger as ledger_module
from aria_kernel import notify
from aria_kernel.human_required import HUMAN_REQUIRED_RECORD_WAIT_SECONDS
from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS
from aria_kernel.runtime_profile import set_profile

_ENV = {
    "ARIA_TELEGRAM_BOT_TOKEN": "t",
    "ARIA_TELEGRAM_CHAT_ID": "c",
    "ARIA_NOTIFY_GITHUB_REPO": "o/r",
}


class NotifyIsBounded(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-notify-bound-"))
        self.tools = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="notify-t", base_dir=self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_the_bound_is_every_channel_at_its_wall_clock_plus_one_transaction(self) -> None:
        self.assertEqual(
            notify.NOTIFY_WORST_CASE_SECONDS,
            len(notify.NOTIFY_CHANNELS) * notify.SENDER_WALL_CLOCK_SECONDS + STATE_LOCK_LIVENESS_SECONDS,
        )
        # The wall clock is the GitHub sender's longest sequence: list, then
        # comment or create, two calls at the per-call bound.
        self.assertEqual(notify.SENDER_WALL_CLOCK_SECONDS, 2 * notify._GH_CALL_TIMEOUT_SECONDS)
        self.assertEqual(
            HUMAN_REQUIRED_RECORD_WAIT_SECONDS,
            STATE_LOCK_LIVENESS_SECONDS + notify.NOTIFY_WORST_CASE_SECONDS,
        )

    def test_a_sender_that_never_returns_is_cut_at_the_wall_clock(self) -> None:
        release = threading.Event()

        def hangs(title: str, body: str, environ) -> dict:
            release.wait(timeout=30.0)
            return {"transport": "never"}

        def answers(title: str, body: str, environ) -> dict:
            return {"transport": "quick"}

        started = time.monotonic()
        try:
            with mock.patch.object(notify, "SENDER_WALL_CLOCK_SECONDS", 0.3):
                rows = notify.notify(
                    kind="test", title="t", body="b", base_dir=self.tools, environ=_ENV,
                    channels=["telegram", "github_issue"],
                    senders={"telegram": hangs, "github_issue": answers},
                )
        finally:
            release.set()
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0, "the hung sender held the call")
        by_channel = {row["channel"]: row for row in rows}
        self.assertEqual(by_channel["telegram"]["status"], "failed")
        self.assertEqual(by_channel["telegram"]["detail"]["error_class"], "SenderWallClockExceeded")
        # The next channel still ran: a hung transport costs its wall clock,
        # not the notification.
        self.assertEqual(by_channel["github_issue"]["status"], "sent")
        self.assertEqual([r["channel"] for r in notify.read_outbox(self.tools)], ["telegram", "github_issue"])

    def test_a_senders_exception_is_still_its_row(self) -> None:
        def explodes(title: str, body: str, environ) -> dict:
            raise RuntimeError("transport said no")

        rows = notify.notify(
            kind="test", title="t", body="b", base_dir=self.tools, environ=_ENV,
            channels=["telegram"], senders={"telegram": explodes},
        )
        self.assertEqual(rows[0]["status"], "failed")
        self.assertEqual(rows[0]["detail"]["error"], "transport said no")

    def test_the_outbox_rows_of_one_call_land_under_one_transaction_after_the_sends(self) -> None:
        transactions: list[float] = []
        sends: list[float] = []
        real_transaction = ledger_module.state_transaction

        def counting_transaction(paths, **kwargs):
            transactions.append(time.monotonic())
            return real_transaction(paths, **kwargs)

        def sender(title: str, body: str, environ) -> dict:
            sends.append(time.monotonic())
            return {"transport": "fake"}

        with mock.patch.object(notify, "state_transaction", new=counting_transaction):
            rows = notify.notify(
                kind="test", title="t", body="b", base_dir=self.tools, environ=_ENV,
                channels=["telegram", "github_issue"],
                senders={"telegram": sender, "github_issue": sender},
            )
        self.assertEqual(len(rows), 2)
        # The per-signature dedup is across channels too: the second channel
        # sees the first's `sent` row of this same call and dedups. Two
        # rows, one send — and still ONE transaction for both rows.
        self.assertEqual([row["status"] for row in rows], ["sent", "deduped"])
        self.assertEqual(len(sends), 1)
        self.assertEqual(len(transactions), 1, "one transaction per call, not per channel")
        self.assertGreater(transactions[0], max(sends), "the lock is taken after every send")
        self.assertEqual(len(notify.read_outbox(self.tools)), 2)


if __name__ == "__main__":
    unittest.main()
