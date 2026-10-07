"""ARIA-HIGH-366 — every outage is detected, said ONCE, and resolved by the next success.

Measured before the fix: a bare 429 or a dropped connection released as the
generic ``native_runtime_execution_unavailable``; a logged-out session
(2026-09-18/19) released 73 times as ``native_runtime_admission_unavailable``
with no cooldown and no signal; the worker lane's auth arm cooled nothing;
an auth outage re-wrote a cooldown row and an ``::error::`` every 900 s;
nothing read cooldowns for the operator; and the watchdog turned every plan
an outage stalled into a MEDIUM finding. The dead ``external_outage_reaper``
(nothing wrote ``api_backoff_exhausted``) is deleted.

Each class pins one seam; each fails on origin/main 958eed5b7.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.ledger import load_jsonl
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.tool_registry import ensure_tools_dir

_T0 = datetime(2026, 10, 7, 3, 0, 0, tzinfo=timezone.utc)
_AUTH = {"signature": "claude_auth_failure", "marker": "oauth session expired"}


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-outage-signal-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def kinds(self, kind: str) -> list[dict]:
        return [row["details"] for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == kind]

    def cool(self, at: datetime, detection: dict | None = None, claim: str = "CL-1") -> dict:
        return record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                        request_id="AIR-1", claim_id=claim, detection=dict(detection or _AUTH),
                                        now=at)

    def items(self, *, resolved: bool = False) -> list[dict]:
        from aria_kernel.human_required import list_human_required

        return list_human_required(base_dir=self.tools, include_resolved=resolved)


class OneSignalPerTransitionResolvedByTheNextSuccess(_Store):
    def test_three_reprobes_of_a_dead_login_open_one_outage_and_one_item(self) -> None:
        for minutes, claim in ((0, "CL-1"), (16, "CL-2"), (50, "CL-3")):
            self.cool(_T0 + timedelta(minutes=minutes), claim=claim)
        self.assertEqual(len(self.kinds("provider_outage_opened")), 1)
        items = self.items()
        self.assertEqual(len(items), 1)
        self.assertTrue(items[0]["reason"].startswith("provider_unavailable:anthropic:auth"))
        self.assertIn("login", items[0]["reason"], "the remedy travels with the item")

    def test_the_reprobe_backs_off_while_the_outage_stands(self) -> None:
        windows = [self.cool(_T0 + timedelta(minutes=m), claim=f"CL-{m}")["details"]["cooldown_seconds"]
                   for m in (0, 16, 50, 120, 200)]
        self.assertEqual(windows, [900, 1800, 3600, 3600, 3600])

    def test_the_next_served_spawn_restores_and_resolves_the_item(self) -> None:
        from aria_kernel.human_required import RESOLVED_BY_KERNEL
        from aria_kernel.provider_outage_ledger import open_outages, record_provider_restored

        self.cool(_T0)
        restored = record_provider_restored(self.tools, provider="anthropic", seam="spawn", request_id="AIR-9",
                                            now=_T0 + timedelta(hours=5))
        self.assertEqual(restored["details"]["closed_kinds"], ["auth"])
        self.assertEqual(open_outages(self.tools), ())
        self.assertEqual(self.items(), [])
        resolved = self.items(resolved=True)
        self.assertEqual([row["resolved_by"] for row in resolved], [RESOLVED_BY_KERNEL])
        self.assertIsNone(record_provider_restored(self.tools, provider="anthropic", seam="spawn",
                                                   request_id="AIR-10", now=_T0 + timedelta(hours=6)))

    def test_a_second_outage_after_a_restore_is_a_second_transition(self) -> None:
        from aria_kernel.provider_outage_ledger import record_provider_restored

        self.cool(_T0)
        record_provider_restored(self.tools, provider="anthropic", seam="spawn", request_id="AIR-9",
                                 now=_T0 + timedelta(hours=1))
        self.cool(_T0 + timedelta(hours=2), claim="CL-9")
        self.assertEqual(len(self.kinds("provider_outage_opened")), 2)
        self.assertEqual(len(self.items()), 1)

    def test_the_executor_says_error_only_for_the_claim_that_opened_it(self) -> None:
        from aria_kernel.provider_outage_ledger import outage_opened_by_claim

        self.cool(_T0, claim="CL-1")
        self.cool(_T0 + timedelta(minutes=20), claim="CL-2")
        self.assertTrue(outage_opened_by_claim(self.tools, provider="anthropic", claim_id="CL-1"))
        self.assertFalse(outage_opened_by_claim(self.tools, provider="anthropic", claim_id="CL-2"))


class TheAdmissionDetectsALoggedOutSessionAndItsReturn(_Store):
    def _observe(self, reason: str, auth: str) -> None:
        from aria_kernel.provider_outage_seams import observe_native_admission

        observe_native_admission(self.tools, request_id="AIR-1", cooldown_seconds=900, observations=[
            {"provider": "anthropic", "model": "opus", "status_reason": reason, "auth_observation": auth,
             "decision": "unavailable" if auth == "unavailable" else "available"},
        ])

    def test_logged_out_opens_the_outage_with_a_cooldown(self) -> None:
        from aria_kernel.provider_cooldown import active_provider_cooldowns
        from aria_kernel.provider_outage_ledger import open_outages

        self._observe("managed_session_logged_out", "unavailable")
        self.assertEqual([(i.provider, i.kind) for i in open_outages(self.tools)], [("anthropic", "logged_out")])
        self.assertEqual(active_provider_cooldowns(self.tools)["anthropic"]["reason"], "logged_out")
        self.assertEqual(len(self.items()), 1)

    def test_logged_in_closes_the_login_outage_but_not_a_dead_token(self) -> None:
        from aria_kernel.provider_outage_ledger import open_outages

        self._observe("managed_session_logged_out", "unavailable")
        self.cool(_T0 + timedelta(days=400))  # an `auth` (expired token) outage too
        self._observe("managed_session_logged_in", "available")
        self.assertEqual([(i.provider, i.kind) for i in open_outages(self.tools)], [("anthropic", "auth")])

    def test_a_logged_out_cooldown_is_refused_as_a_credential_fact(self) -> None:
        from aria_kernel.provider_cooldown import EXHAUSTION_KIND_REASONS, PROVIDER_EXHAUSTION_SIGNATURES

        self.assertEqual(PROVIDER_EXHAUSTION_SIGNATURES["claude_logged_out"], ("anthropic", "logged_out"))
        self.assertEqual(PROVIDER_EXHAUSTION_SIGNATURES["claude_unreachable"], ("anthropic", "unreachable"))
        self.assertIn("unreachable", EXHAUSTION_KIND_REASONS)


class AVendorThatDoesNotServeIsAnUnreachableOutage(unittest.TestCase):
    def _run(self, **result: object):
        import sys

        poc = str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc")
        if poc not in sys.path:
            sys.path.insert(0, poc)
        from claude_runtime import ClaudeRunResult, extract_unreachable, run_with_model_fallback

        stderr = str(result.get("stderr", ""))
        events = tuple(result.get("events", ()))
        completed = ClaudeRunResult(
            returncode=int(result.get("returncode", 1)), stdout="", stderr=stderr,
            final_message=str(result.get("final_message", "")), usage=None,
            events=events, credit_exhaustion=result.get("credit_exhaustion"),
            unreachable=extract_unreachable(returncode=int(result.get("returncode", 1)), stderr=stderr,
                                            events=events),
        )
        return run_with_model_fallback(run=lambda model, effort: completed, model="opus", failover=None,
                                       effort="high", write_capable=False)

    def test_a_429_raises_the_unreachable_fact_naming_the_provider(self) -> None:
        with self.assertRaises(Exception) as caught:
            self._run(stderr='API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}')
        self.assertEqual(type(caught.exception).__name__, "ClaudeProviderUnreachable")
        self.assertEqual((caught.exception.provider, caught.exception.detail["signature"]),
                         ("anthropic", "claude_unreachable"))

    def test_a_credit_exhaustion_takes_precedence(self) -> None:
        with self.assertRaises(Exception) as caught:
            self._run(stderr="API Error: 429 quota exceeded",
                      credit_exhaustion={"signature": "claude_credit_error", "matched_marker": "quota exceeded"})
        self.assertEqual(type(caught.exception).__name__, "ClaudeCreditExhausted")

    def test_the_agents_own_words_are_never_read_as_an_outage(self) -> None:
        """Review MEDIUM-1: an implementer reporting a refused DB port is not the vendor refusing."""
        said = "the test DB is down: connect ECONNREFUSED 127.0.0.1:5432"
        events = ({"type": "assistant", "message": {"content": [{"type": "text", "text": said}]}},
                  {"type": "result", "is_error": False, "result": said})
        self.assertEqual(self._run(returncode=1, final_message=said, events=events).returncode, 1)

    def test_the_clis_error_result_is_read(self) -> None:
        events = ({"type": "result", "is_error": True, "result": "API Error (Connection error.)"},)
        with self.assertRaises(Exception) as caught:
            self._run(returncode=1, events=events)
        self.assertEqual(type(caught.exception).__name__, "ClaudeProviderUnreachable")

    def test_a_clean_run_mentioning_rate_limits_is_not_an_outage(self) -> None:
        self.assertEqual(self._run(returncode=0, stderr="rate_limit_error").returncode, 0)

    def test_the_release_is_harness_class(self) -> None:
        from aria_kernel.agent_invocations import classify_release_reason
        from aria_kernel.release_reason import parse_release_reason

        self.assertEqual(classify_release_reason("provider_unreachable:anthropic"), "harness")
        self.assertEqual(parse_release_reason("provider_unreachable:anthropic").reason_code, "PROVIDER_UNREACHABLE")


class TheWorkerLaneCoolsADeadLogin(unittest.TestCase):
    """The worker executor's auth arm wrote nothing: the hook re-spawned into the same dead login."""

    def test_an_auth_failure_cools_the_provider_under_the_claim(self) -> None:
        import io
        import sys
        from unittest.mock import patch

        from tests.test_worker_lane_provider_cooldown import _LaneFixture

        fixture = _LaneFixture("setUp")
        fixture.setUp()
        self.addCleanup(fixture.tearDown)
        import worker_executor
        from claude_runtime import ClaudeRunResult

        from aria_kernel.provider_cooldown import provider_cooldown_for_claim
        from aria_kernel.provider_outage_ledger import open_outages

        worktree = fixture.tmp / "worktrees" / "A-W-1"
        worktree.mkdir(parents=True)
        assignment = {"assignment_id": "A-W-1", "target_agent": "aria-worker", "worktree_path": str(worktree),
                      "required_tests": [], "expected_trailer": "Closes-Pressure: P-A-W-1", "timeout_seconds": 60}

        def dead_login(**kwargs: object) -> ClaudeRunResult:
            return ClaudeRunResult(returncode=1, stdout="", stderr="OAuth session expired and could not be refreshed",
                                   final_message="", usage=None, events=(),
                                   auth_failure={"kind": "auth_failure", "signature": "claude_auth_failure",
                                                 "marker": "oauth session expired", "returncode": 1})

        with patch.object(worker_executor, "_resolve_assignment", return_value=assignment), \
                patch.object(worker_executor, "run_claude_exec", dead_login), \
                patch.object(sys, "stderr", io.StringIO()):
            self.assertEqual(worker_executor.main(["A-W-1", "aria-worker", "--claim-id", "DC-7"]), 1)
        self.assertEqual(provider_cooldown_for_claim(fixture.tools_root, claim_id="DC-7")["reason"],
                         "auth_unavailable")
        self.assertEqual([(i.provider, i.kind) for i in open_outages(fixture.tools_root)], [("anthropic", "auth")])


class TheWatchdogDoesNotCallAnOutageAStall(_Store):
    def test_a_plan_stalled_only_by_an_outage_raises_no_finding(self) -> None:
        from aria_kernel.aria_watchdog import detect_stall
        from aria_kernel.provider_clock import ProviderClock, provider_clock

        self.cool(_T0)
        rows = [{"plan_id": "plan-X", "kind": "challenger_drafted", "ts": _T0.isoformat()}]
        now = _T0 + timedelta(hours=6)
        self.assertEqual(detect_stall(rows, [], now=now, clock=provider_clock(self.tools)), [])
        self.assertEqual(len(detect_stall(rows, [], now=now, clock=ProviderClock(()))), 1)


class ANeverSpawnedProviderFreezesNothing(_Store):
    """Review HIGH-2: an outage nothing spawns against again must not pause every reader."""

    def _codex_logged_out(self) -> None:
        from aria_kernel.provider_outage_seams import observe_native_admission

        observe_native_admission(self.tools, request_id="AIR-1", cooldown_seconds=900, observations=[
            {"provider": "openai", "model": "gpt", "status_reason": "cli_reported_not_logged_in",
             "auth_observation": "unavailable", "decision": "unavailable"}])

    def test_the_watchdog_still_reports_a_stall(self) -> None:
        from datetime import datetime as _dt

        from aria_kernel.aria_watchdog import detect_stall
        from aria_kernel.provider_clock import provider_clock

        self._codex_logged_out()  # opened now, never restored: OpenAI heads no planning role
        now = _dt.now(timezone.utc)
        rows = [{"plan_id": "plan-X", "kind": "challenger_drafted", "ts": (now - timedelta(hours=6)).isoformat()}]
        self.assertEqual(len(detect_stall(rows, [], now=now, clock=provider_clock(self.tools))), 1)

    def test_the_finding_cool_off_still_applies(self) -> None:
        from datetime import datetime as _dt

        from aria_kernel.outage_attribution import failure_is_lane_fault
        from aria_kernel.provider_clock import provider_clock

        self._codex_logged_out()
        now = _dt.now(timezone.utc)
        event = {"event_type": "plan_evaluated",
                 "payload": {"terminal_state": "HUMAN_REQUIRED", "reason_codes": ["pending_tasks_present"]}}
        self.assertFalse(failure_is_lane_fault(event, waited_since=now - timedelta(days=3), at=now,
                                               clock=provider_clock(self.tools)))

    def test_an_off_ladder_providers_outage_pauses_no_clock(self) -> None:
        from unittest.mock import patch

        from aria_kernel import provider_clock as clock_module

        self.cool(_T0)
        clock = clock_module.provider_clock(self.tools)
        later = _T0 + timedelta(hours=5)
        with patch.object(clock_module, "routed_providers", return_value=frozenset({"zai"})):
            self.assertEqual(clock.available_age(_T0, later, frozenset({"anthropic"})), timedelta(hours=5))
        self.assertEqual(clock.available_age(_T0, later, frozenset({"anthropic"})), timedelta(0))

    def test_the_operator_resolving_the_item_closes_the_outage(self) -> None:
        from aria_kernel.human_required import resolve_human_required
        from aria_kernel.provider_outage_ledger import open_outages

        self.cool(_T0)
        signal = self.items()[0]["request_id"]
        resolve_human_required(request_id=signal, resolution_note="re-logged in on the runner",
                               base_dir=self.tools, now=_T0 + timedelta(hours=2))
        self.assertEqual(open_outages(self.tools), ())
        restored = self.kinds("provider_restored")
        self.assertEqual((restored[-1]["seam"], restored[-1]["closed_kinds"]), ("operator_attested", ["auth"]))


class TheDailyReportShowsTheInterval(_Store):
    def test_the_section_names_the_provider_the_kind_and_the_span(self) -> None:
        from aria_kernel.provider_outage_ledger import record_provider_restored, render_outage_section

        self.cool(_T0)
        record_provider_restored(self.tools, provider="anthropic", seam="spawn", request_id="AIR-9",
                                 now=_T0 + timedelta(hours=30))
        text = "\n".join(render_outage_section(self.tools, now=_T0 + timedelta(days=2)))
        self.assertIn("## Provider Outages", text)
        self.assertIn("anthropic auth: 2026-10-07T03:00:00Z -> restored 2026-10-08T09:00:00Z (30.0h", text)


class TheDeadReaperIsGone(unittest.TestCase):
    def test_no_module_and_no_state_derived_from_an_event_nobody_writes(self) -> None:
        from aria_kernel.agent_surface import DERIVED_REQUEST_STATES

        kernel = Path(__file__).resolve().parents[1] / "aria_kernel"
        self.assertFalse((kernel / "external_outage_reaper.py").exists())
        self.assertNotIn("EXTERNAL_OUTAGE", DERIVED_REQUEST_STATES)
        self.assertNotIn("api_backoff_exhausted", (kernel / "agent_invocations.py").read_text())


if __name__ == "__main__":
    unittest.main()
