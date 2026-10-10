"""ARIA-MEDIUM-417 — the notifications organ judges whether anyone can hear.

CONFIRMED on the bound store (aria/state f5c5c86a1, 2026-10-10):
`notifications/outbox.jsonl` held 268 rows from 2026-09-04 to 2026-10-10,
every one `unconfigured` (266 `human_required_opened`, one `breaker_tripped`,
one `cycle_failed`), and this organ read `ok — no_channel_configured`: it had
no FAIL branch. On a GitHub Actions lane the channel env names are the
workflow's to set, so an empty channel set there is a fault; the selector is
optional and configures nothing by itself (`github_issue` needs
`ARIA_NOTIFY_GITHUB_REPO`). `ARIA_NOTIFY_CHANNELS=none` is an operator's
explicit choice; `none` beside a channel is a selector nobody can honour.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import doctor
from aria_kernel.doctor import DOCTOR_EXIT_UNHEALTHY, run_doctor
from aria_kernel.notify import CHANNEL_ENV_NAMES, CHANNEL_SELECTOR_ENV, notify
from aria_kernel.tool_registry import ensure_tools_dir

_LANE = {"GITHUB_ACTIONS": "true"}


class NotificationsOrgan(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def organ(self, **env: str) -> doctor.DoctorCheck:
        return doctor._check_notifications(self.tools, environ=env)

    def test_a_lane_with_no_channel_is_a_fail(self) -> None:
        check = self.organ(**_LANE)

        self.assertEqual((check.status, check.reason), ("fail", "no_notification_channel_in_ci"))
        self.assertEqual(check.detail["configured_channels"], [])

    def test_the_selector_alone_configures_nothing(self) -> None:
        check = self.organ(**_LANE, ARIA_NOTIFY_CHANNELS="github_issue")

        self.assertEqual((check.status, check.reason), ("fail", "no_notification_channel_in_ci"))

    def test_a_lane_with_a_channel_is_ok(self) -> None:
        check = self.organ(**_LANE, ARIA_NOTIFY_GITHUB_REPO="owner/repo")

        self.assertEqual((check.status, check.reason), ("ok", ""))
        self.assertEqual(check.detail["configured_channels"], ["github_issue"])

    def test_none_is_an_operator_choice_not_ill_health(self) -> None:
        check = self.organ(**_LANE, ARIA_NOTIFY_CHANNELS="none")

        self.assertEqual((check.status, check.reason), ("ok", "notifications_disabled_by_operator"))

    def test_none_beside_a_channel_is_a_fail_on_any_host(self) -> None:
        check = self.organ(ARIA_NOTIFY_CHANNELS="none,github_issue", ARIA_NOTIFY_GITHUB_REPO="owner/repo")

        self.assertEqual(check.status, "fail")
        self.assertTrue(check.reason.startswith("notify_channel_selector_invalid:none_combined"), check.reason)

    def test_off_a_lane_no_channel_stays_information(self) -> None:
        check = self.organ()

        self.assertEqual((check.status, check.reason), ("ok", "no_channel_configured"))

    def test_a_failing_channel_is_still_a_warn(self) -> None:
        def refuse(_title: str, _body: str, _environ: object) -> dict:
            raise RuntimeError("gh issue create failed rc=1")

        notify(kind="test", title="t", body="b", base_dir=self.tools, environ={"ARIA_NOTIFY_GITHUB_REPO": "owner/repo"},
               senders={"github_issue": refuse})

        check = self.organ(**_LANE, ARIA_NOTIFY_GITHUB_REPO="owner/repo")

        self.assertEqual((check.status, check.reason), ("warn", "recent_failures:1"))

    def test_the_live_shape_reads_unhealthy_on_the_lane(self) -> None:
        # The bound store's outbox in miniature: events that reached nobody.
        for kind in ("human_required_opened", "breaker_tripped", "cycle_failed"):
            notify(kind=kind, title=kind, body="b", base_dir=self.tools, environ={})

        with mock.patch.dict(os.environ, _LANE):
            for name in (CHANNEL_SELECTOR_ENV, *(n for names in CHANNEL_ENV_NAMES.values() for n in names)):
                os.environ.pop(name, None)
            report = run_doctor(base_dir=self.tools, workspace_root=self.root)

        organ = next(check for check in report.checks if check.name == "notifications")
        self.assertEqual((organ.status, organ.reason), ("fail", "no_notification_channel_in_ci"))
        self.assertEqual(organ.detail["recent_rows"], 3)
        self.assertEqual(report.exit_code, DOCTOR_EXIT_UNHEALTHY)


if __name__ == "__main__":
    unittest.main()
