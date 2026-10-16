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
from datetime import datetime, timedelta, timezone
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
        # The wall clock is the GitHub sender's longest sequence: issue list,
        # label list, label create, issue create — four calls at the per-call
        # bound (ARIA-HIGH-415; a found issue is list + comment).
        self.assertEqual(notify.SENDER_WALL_CLOCK_SECONDS, 4 * notify._GH_CALL_TIMEOUT_SECONDS)
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
        # ARIA-MEDIUM-110 — the dedup is per channel: the first channel's
        # `sent` row of this same call does not dedup the second channel.
        # Two rows, two sends — and still ONE transaction for both rows.
        self.assertEqual([row["status"] for row in rows], ["sent", "sent"])
        self.assertEqual(len(sends), 2)
        self.assertEqual(len(transactions), 1, "one transaction per call, not per channel")
        self.assertGreater(transactions[0], max(sends), "the lock is taken after every send")
        self.assertEqual(len(notify.read_outbox(self.tools)), 2)


class TheDedupIsPerChannel(unittest.TestCase):
    """ARIA-MEDIUM-110 — one delivery per signature PER CHANNEL inside the window.

    The dedup used to match the signature alone, so whichever channel sent
    first silenced every other configured channel for six hours: an operator
    with telegram and an issue got the notice on one of them only, and a
    channel whose send failed was never retried while another had sent.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-notify-dedup-"))
        self.tools = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="notify-dedup", base_dir=self.tools)
        self.sent: list[str] = []
        self.failing: set[str] = set()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _sender(self, channel: str):
        def send(title: str, body: str, environ) -> dict:
            if channel in self.failing:
                raise RuntimeError(f"{channel} down")
            self.sent.append(channel)
            return {"transport": channel}
        return send

    def _notify(self, at: datetime) -> dict[str, str]:
        rows = notify.notify(
            kind="cycle_failed", title="ARIA cycle failed", body="b", key="cyc-1",
            base_dir=self.tools, environ=_ENV, channels=["telegram", "github_issue"],
            senders={"telegram": self._sender("telegram"), "github_issue": self._sender("github_issue")},
            now=at,
        )
        return {row["channel"]: row["status"] for row in rows}

    def test_a_channel_that_failed_is_retried_while_the_one_that_sent_is_deduped(self) -> None:
        start = datetime(2026, 10, 16, 12, tzinfo=timezone.utc)
        self.failing = {"github_issue"}
        self.assertEqual(self._notify(start), {"telegram": "sent", "github_issue": "failed"})
        self.failing = set()
        self.assertEqual(self._notify(start + timedelta(hours=1)), {"telegram": "deduped", "github_issue": "sent"})
        self.assertEqual(self._notify(start + timedelta(hours=2)), {"telegram": "deduped", "github_issue": "deduped"})
        # Each channel's window runs from its OWN last send: telegram sent at
        # +0 h and is due again, the issue sent at +1 h and is still inside.
        self.assertEqual(self._notify(start + timedelta(hours=7)), {"telegram": "sent", "github_issue": "deduped"})
        self.assertEqual(self.sent, ["telegram", "github_issue", "telegram"])


if __name__ == "__main__":
    unittest.main()
