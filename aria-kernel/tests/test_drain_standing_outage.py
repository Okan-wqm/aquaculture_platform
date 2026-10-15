"""ARIA-MEDIUM-438 — a re-probe that meets a standing provider outage is not a new harness failure.

Before: every drain whose child re-probed a provider already in an open
outage (the back-off lapsed, the vendor still refused) counted the child as
``harness_failed``. The run exited red every re-probe night, and an
``auth_failed`` re-probe recorded a persistent breaker failure each drain: with
two drains a day and a threshold of 3 the failure breaker tripped on day two,
``autonomy_orchestrator`` preflight then blocked every strict/autonomous cycle
(every kernel-only phase stopped), and the block outlived the provider's return
by up to the 96 h window. ARIA-HIGH-366 had already made the ``::error::``
once per outage; the drain's count is the same fact.

The outage is one failure, at its transition: a child whose failure opened
the outage (it opened after the child was launched) is counted as before.
"""
from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.provider_outage_ledger import OUTAGE_KINDS, record_provider_restored
from aria_kernel.tool_registry import ensure_tools_dir

from tests.test_executor_drain_breaker import _DrainHarness, _row, _summary, ci_executor_drain

_AUTH = {"signature": "claude_auth_failure", "marker": "oauth session expired"}
_QUOTA = {"signature": "claude_credit_error", "marker": "credit balance too low"}


class _Harness(_DrainHarness):
    """The breaker harness, with a store that holds the outage ledger the drain reads."""

    def __init__(self, *args, during_child=None, **kwargs) -> None:  # noqa: ANN001, ANN002, ANN003
        super().__init__(*args, **kwargs)
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")
        self.during_child = during_child

    def _fake_run(self, argv, **kwargs):  # noqa: ANN001, ANN003 — mock signature
        if "next-pending" not in argv and self.during_child is not None:
            self.during_child(self.tools)
        return super()._fake_run(argv, **kwargs)

    def outage(self, detection: dict, *, opened: datetime, restored: datetime | None = None) -> None:
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-0", claim_id="CL-0", detection=dict(detection), now=opened)
        if restored is not None:
            record_provider_restored(self.tools, provider="anthropic", seam="spawn", request_id="AIR-ok",
                                     now=restored)


def _failed(rid: str, failure_class: str) -> dict:
    return _summary(request_id=rid, outcome="failed", failure_class=failure_class, retryable=False)


class AReprobeOfAStandingOutage(unittest.TestCase):
    def setUp(self) -> None:
        self.now = datetime.now(timezone.utc).replace(microsecond=0)

    def test_an_auth_reprobe_is_neither_red_nor_a_breaker_failure(self) -> None:
        h = _Harness(queue=[_row("AIR-1")], summaries={"AIR-1": _failed("AIR-1", "auth_failed")})
        self.addCleanup(h.close)
        h.outage(_AUTH, opened=self.now - timedelta(days=2))
        self.assertEqual(h.run_drain(), 0)
        self.assertEqual(h.breaker_records, [])
        payload = h.payload()
        self.assertEqual((payload["harness_failed"], payload["failed"]), (0, 0))
        self.assertEqual([(row["request_id"], row["provider"], row["outage_kind"])
                          for row in payload["standing_outage"]], [("AIR-1", "anthropic", "auth")])
        # The same-run circuit still skips the route: one re-probe per drain.
        self.assertEqual(len(payload["circuit_breakers"]), 1)

    def test_a_quota_reprobe_keeps_the_run_green(self) -> None:
        h = _Harness(queue=[_row("AIR-1")], summaries={"AIR-1": _failed("AIR-1", "credit_exhausted")})
        self.addCleanup(h.close)
        h.outage(_QUOTA, opened=self.now - timedelta(days=5))
        self.assertEqual(h.run_drain(), 0)
        self.assertEqual(h.payload()["standing_outage"][0]["outage_kind"], "quota")

    def test_the_failure_that_opens_the_outage_is_counted_once(self) -> None:
        h = _Harness(queue=[_row("AIR-1")], summaries={"AIR-1": _failed("AIR-1", "auth_failed")},
                     during_child=lambda tools: record_provider_cooldown(
                         tools, provider="anthropic", model="opus", cooldown_seconds=900, request_id="AIR-1",
                         claim_id="CL-1", detection=dict(_AUTH)))
        self.addCleanup(h.close)
        self.assertEqual(h.run_drain(), 1)
        self.assertEqual(len(h.breaker_records), 1)
        self.assertEqual(h.payload()["standing_outage"], [])

    def test_without_an_outage_on_the_ledger_the_failure_is_the_harness(self) -> None:
        h = _Harness(queue=[_row("AIR-1")], summaries={"AIR-1": _failed("AIR-1", "auth_failed")})
        self.addCleanup(h.close)
        self.assertEqual(h.run_drain(), 1)
        self.assertEqual(len(h.breaker_records), 1)

    def test_a_restored_outage_does_not_excuse_a_new_failure(self) -> None:
        h = _Harness(queue=[_row("AIR-1")], summaries={"AIR-1": _failed("AIR-1", "auth_failed")})
        self.addCleanup(h.close)
        h.outage(_AUTH, opened=self.now - timedelta(days=2), restored=self.now - timedelta(hours=1))
        self.assertEqual(h.run_drain(), 1)

    def test_a_standing_outage_of_another_kind_does_not_excuse_it(self) -> None:
        # A quota outage stands; the credential just died: a new fact.
        h = _Harness(queue=[_row("AIR-1")], summaries={"AIR-1": _failed("AIR-1", "auth_failed")})
        self.addCleanup(h.close)
        h.outage(_QUOTA, opened=self.now - timedelta(days=2))
        self.assertEqual(h.run_drain(), 1)

    def test_the_kinds_are_the_ledgers(self) -> None:
        for kinds in ci_executor_drain.OUTAGE_KINDS_BY_FAILURE_CLASS.values():
            self.assertTrue(kinds <= frozenset(OUTAGE_KINDS), kinds)


if __name__ == "__main__":
    unittest.main()
