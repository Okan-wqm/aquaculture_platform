"""ARIA-MEDIUM-556 — a public GitHub issue carries a fixed summary and a record pointer, never the detail.

The github_issue channel posts to the repository's issues, a public page. A
tripped cost breaker posted its dollar amounts there (``cost_budget``), and a
CRITICAL HUMAN_REQUIRED record posted its free-text reason (``human_required``),
which can describe a weakness nobody has fixed yet. For the kinds whose producers
carry such detail, the notifier now renders the public body itself: the kind's
fixed sentence and a pointer to the governed record. The producer's body still
reaches the operator's private channels (stdout, email, telegram).
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import cost_budget, notify
from aria_kernel.human_required import record_human_required
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import ensure_tools_dir

_WEAKNESS = "the tenant guard accepts an unsigned x-tenant-id header on /internal/export"


class _Channels(unittest.TestCase):
    """A public and a private channel, each recording what it was handed.

    A test selects the channel whose body it reads (``SELECTOR``), so the
    other channel's recorder stays empty and a body that reached the wrong
    channel is visible as a send there.
    """

    SELECTOR = "github_issue"

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-medium-556-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.base = self.tmp / "aria-tools"
        set_profile("standard", operator_approval_ref="medium-556", base_dir=self.base)
        self.tools = ensure_tools_dir(self.base)
        self.sent: dict[str, list[tuple[str, str]]] = {"github_issue": [], "stdout": []}

        def recorder(channel: str) -> Any:
            def send(title: str, body: str, environ: Any) -> dict[str, Any]:
                self.sent[channel].append((title, body))
                return {"transport": "test"}
            return send

        for patcher in (
            mock.patch.dict("os.environ", {notify.CHANNEL_SELECTOR_ENV: self.SELECTOR,
                                           "ARIA_NOTIFY_GITHUB_REPO": "o/r"}),
            mock.patch.dict(notify.SENDERS, {"github_issue": recorder("github_issue"), "stdout": recorder("stdout")}),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def public(self) -> str:
        self.assertEqual(len(self.sent["github_issue"]), 1)
        return self.sent["github_issue"][0][1]


class TheCostBreakerPostsNoAmount(_Channels):
    def test_the_issue_carries_the_summary_and_the_record_not_the_amounts(self) -> None:
        cost_budget._trip_breaker(self.tools, cap_name="daily", amount=1234.56, cap=1000.0)
        body = self.public()
        self.assertNotIn("1234", body)
        self.assertNotIn("1000", body)
        self.assertIn(notify.POINTER_ONLY_SUMMARIES["breaker_tripped"], body)
        self.assertIn("record: " + cost_budget._state_path(self.tools).relative_to(self.tools).as_posix(), body)


class ThePrivateChannelStillReadsTheDetail(_Channels):
    SELECTOR = "stdout"

    def test_the_amounts_and_the_reason_reach_a_private_channel(self) -> None:
        cost_budget._trip_breaker(self.tools, cap_name="daily", amount=1234.56, cap=1000.0)
        record_human_required(request_id="AIR-crit-556", severity="CRITICAL", reason=_WEAKNESS, base_dir=self.tools)
        bodies = [body for _title, body in self.sent["stdout"]]
        self.assertEqual(len(bodies), 2)
        self.assertIn("1234.56", bodies[0])
        self.assertIn("unsigned x-tenant-id header", bodies[1])
        self.assertEqual(self.sent["github_issue"], [])


class ACriticalReasonStaysOffThePublicIssue(_Channels):
    def test_the_issue_carries_the_summary_and_the_record_not_the_reason(self) -> None:
        record_human_required(request_id="AIR-crit-556", severity="CRITICAL", reason=_WEAKNESS, base_dir=self.tools)
        body = self.public()
        self.assertNotIn("x-tenant-id", body)
        self.assertNotIn("tenant guard", body)
        self.assertIn(notify.POINTER_ONLY_SUMMARIES["human_required_opened"], body)
        self.assertIn("record: human-required/AIR-crit-556.json", body)


class ThePublicBodyIsTheNotifiersOwn(_Channels):
    def test_a_pointer_kind_never_publishes_the_producers_body(self) -> None:
        for kind in notify.POINTER_ONLY_SUMMARIES:
            with self.subTest(kind=kind):
                self.sent = {"github_issue": [], "stdout": []}
                record = "human-required/AIR-impl:req-1.json"
                rows = notify.notify(kind=kind, title=f"ARIA fixed title {kind}", body=_WEAKNESS,
                                     key=f"k-{kind}", record=record, base_dir=self.tools)
                self.assertEqual([(row["channel"], row["status"]) for row in rows], [("github_issue", "sent")])
                self.assertEqual(self.public(), f"{notify.POINTER_ONLY_SUMMARIES[kind]}\nrecord: {record}")

    def test_a_pointer_kind_without_a_valid_record_is_a_failed_public_row_not_a_leak(self) -> None:
        for record in (None, "", "/home/gharunner/aria-tools/x.json", "free text with spaces", "a/../../etc"):
            with self.subTest(record=record):
                self.sent = {"github_issue": [], "stdout": []}
                rows = notify.notify(kind="human_required_opened", title="ARIA HUMAN_REQUIRED [CRITICAL] AIR-2",
                                     body=_WEAKNESS, key=f"k-{record}", record=record, base_dir=self.tools,
                                     channels=["github_issue", "stdout"])
                by_channel = {row["channel"]: row for row in rows}
                self.assertEqual(by_channel["github_issue"]["status"], "failed")
                self.assertEqual(by_channel["github_issue"]["detail"], {"error": "notify_public_record_invalid"})
                self.assertEqual(self.sent["github_issue"], [])
                self.assertEqual(by_channel["stdout"]["status"], "sent")

    def test_other_kinds_keep_their_body(self) -> None:
        notify.notify(kind="test", title="ARIA channel check", body="counts: 3", base_dir=self.tools)
        self.assertEqual(self.public(), "counts: 3")


if __name__ == "__main__":
    unittest.main()
