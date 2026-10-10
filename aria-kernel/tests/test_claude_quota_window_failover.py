"""ARIA-HIGH-425 — a spent Claude quota window moves every seat Z.ai can serve to Z.ai until the reset.

Operator decision 2026-10-10: "if the Claude quota runs out, switch to Z.ai in
every area until the window resets, then return to Claude". Measured before
this module (aria/state f5c5c86a1): 397 of 543 harness releases fell inside an
exhausted Anthropic window, the bound governance holds no
`provider_quota_cooldown` row at all, and every Claude stream carried the
CLI's `rate_limit_event` (339 events in 239 stored transcripts, the seven-day
reading 0.63 → 0.98 before the 2026-09-21 hard stop) that nothing read.

What this pins, with the production shapes (the stored events verbatim, the
real executor child, the real kernel ledgers; only the `claude` binary and the
status probes are fakes):

* the reader: the run's newest reading decides; a window at
  `QUOTA_WINDOW_EXHAUSTED_UTILIZATION` or a `rejected` status is spent, and the
  cooldown ends at the latest reset among the spent windows;
* a `rejected` reading is the run's quota exhaustion whatever the text says —
  a 429 whose reading is `rejected` is no longer a 15-minute `unreachable`
  back-off — and the request is requeued uncharged until the reset;
* a run the vendor SERVED at the threshold keeps its answer, and the next
  request's admission refuses Anthropic by name;
* every seat of the routing table: read-only seats run on Z.ai while the
  cooldown stands and on their own ladder head after the reset; the write
  seats (the implementer, the worker lane) wait by name, uncharged — Z.ai's
  transport is one chat completion with no tool loop (`Provider.admits_writes`);
* Z.ai out too: no seat is admitted on a cooled vendor (the existing outage
  behaviour), nothing is claimed;
* the drain does not skip a seat the next vendor serves on the circuit of the
  vendor that is out, and a quota exhaustion is not a breaker failure;
* the spawn lane (no adaptive policy) orders a cooled vendor's rungs last.
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
for _path in (str(_POC_DIR), str(_REPO_ROOT / "aria-kernel")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import claude_runtime  # noqa: E402
from aria_kernel.agent_runtime_profile import read_agent_runtime_profile  # noqa: E402
from aria_kernel.agent_surface import DISPATCHABLE_ROLES, ROLE_TARGET_PAIRING  # noqa: E402
from aria_kernel.ledger import load_declared_jsonl  # noqa: E402
from aria_kernel.native_admission import COOLDOWN_STATUS_REASON, AdmissionOutcome  # noqa: E402
from aria_kernel.provider_cooldown import (  # noqa: E402
    PROVIDER_COOLDOWN_GOVERNANCE_KIND,
    PROVIDER_EXHAUSTION_SIGNATURES,
    QUOTA_WINDOW_EXHAUSTED_UTILIZATION,
    active_provider_cooldowns,
    record_provider_cooldown,
)
from aria_kernel.runtime_profiles import WRITE_SCOPE_ROLES, load_provider_routing, routed_models  # noqa: E402

from tests.test_native_admission_undecided import _FleetFixture  # noqa: E402

# The stored readings, verbatim (uuid/session_id dropped). The last event of
# AIR-aria-evidence-judge-36a7df700ca6's stream (2026-09-21 02:44:56Z, 5.6 h
# before the hard stop) and the five-hour event of
# AIR-aria-primary-planner-d8f302410eb4 (2026-10-10 10:08:07Z).
_SEVEN_DAY_0_98 = {"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed_warning", "resetsAt": 1790316000, "rateLimitType": "seven_day", "utilization": 0.98,
    "isUsingOverage": False, "surpassedThreshold": 0.75, "unifiedWindows": {
        "five_hour": {"utilization": 0.11, "resetsAt": 1789971600},
        "seven_day": {"utilization": 0.98, "resetsAt": 1790316000}}}}
_SEVEN_DAY_0_97 = json.loads(json.dumps(_SEVEN_DAY_0_98).replace("0.98", "0.97"))
_FIVE_HOUR_ALLOWED = {"type": "rate_limit_event", "rate_limit_info": {
    "status": "allowed", "resetsAt": 1791634200, "rateLimitType": "five_hour", "overageStatus": "rejected",
    "overageDisabledReason": "org_level_disabled", "isUsingOverage": False, "unifiedWindows": {
        "five_hour": {"utilization": 0.12, "resetsAt": 1791634200},
        "seven_day": {"utilization": 0.44, "resetsAt": 1792130400}}}}
_SEPT_RESET = "2026-09-25T06:00:00Z"
_T0 = datetime(2026, 9, 21, 2, 44, 56, tzinfo=timezone.utc)
# The 2026-10-01 runner's whole recorded stderr (ARIA-HIGH-290).
_TRUST_NOTICE = ("Ignoring 481 permissions.allow entries from .claude/settings.local.json: this workspace has not "
                 "been trusted. Run Claude Code interactively here once and accept the trust dialog.\n")
_API_429 = ('API Error: 429 {"type":"error","error":{"type":"rate_limit_error",'
            '"message":"This request would exceed your account\'s rate limit."}}')


def _rejected(reset: int, *, five_hour_reset: int | None = None) -> dict:
    """The CLI's rate_limit_event schema (2.1.278) with the binding window refused."""
    return {"type": "rate_limit_event", "rate_limit_info": {
        "status": "rejected", "resetsAt": reset, "rateLimitType": "seven_day", "utilization": 1.0,
        "isUsingOverage": False, "unifiedWindows": {
            "five_hour": {"utilization": 0.31, "resetsAt": five_hour_reset or reset - 86400},
            "seven_day": {"utilization": 1.0, "resetsAt": reset}}}}


def _with_utilization(event: dict, window: str, utilization: float, reset: int) -> dict:
    copy = json.loads(json.dumps(event))
    copy["rate_limit_info"]["unifiedWindows"][window] = {"utilization": utilization, "resetsAt": reset}
    return copy


def _failed_result(text: str) -> dict:
    return {"type": "result", "subtype": "success", "is_error": True, "result": text}


class TheReaderReadsTheCliShape(unittest.TestCase):
    def test_the_stored_0_98_reading_is_a_spent_seven_day_window_ending_at_its_reset(self) -> None:
        reading = claude_runtime.extract_rate_limit_exhaustion((_SEVEN_DAY_0_97, _SEVEN_DAY_0_98))
        self.assertIsNotNone(reading)
        self.assertEqual((reading["signature"], reading["trigger"], reading["resets_at"]),
                         ("claude_rate_limit_event", "utilization_threshold", _SEPT_RESET))
        self.assertEqual(reading["windows"], {"seven_day": {"utilization": 0.98, "resets_at": _SEPT_RESET}})
        self.assertEqual(PROVIDER_EXHAUSTION_SIGNATURES[reading["signature"]], ("anthropic", "quota"))

    def test_below_the_threshold_nothing_is_spent_and_the_newest_reading_decides(self) -> None:
        self.assertEqual(QUOTA_WINDOW_EXHAUSTED_UTILIZATION, 0.98)
        self.assertIsNone(claude_runtime.extract_rate_limit_exhaustion((_SEVEN_DAY_0_98, _SEVEN_DAY_0_97)))
        self.assertIsNone(claude_runtime.extract_rate_limit_exhaustion((_FIVE_HOUR_ALLOWED,)))
        self.assertIsNone(claude_runtime.extract_rate_limit_exhaustion(()))

    def test_a_spent_five_hour_window_ends_at_its_own_reset(self) -> None:
        event = _with_utilization(_FIVE_HOUR_ALLOWED, "five_hour", 0.99, 1791634200)
        reading = claude_runtime.extract_rate_limit_exhaustion((event,))
        self.assertEqual(set(reading["windows"]), {"five_hour"})
        self.assertEqual(reading["resets_at"], "2026-10-10T12:10:00Z")

    def test_two_spent_windows_cool_until_the_later_reset(self) -> None:
        event = _with_utilization(_SEVEN_DAY_0_98, "five_hour", 0.99, 1789971600)
        reading = claude_runtime.extract_rate_limit_exhaustion((event,))
        self.assertEqual(set(reading["windows"]), {"five_hour", "seven_day"})
        self.assertEqual(reading["resets_at"], _SEPT_RESET)

    def test_a_rejected_reading_is_the_runs_quota_exhaustion_whatever_the_text(self) -> None:
        events = (_rejected(1790316000), _failed_result(_API_429))
        detection = claude_runtime.extract_credit_exhaustion(returncode=1, stderr=_TRUST_NOTICE, events=events)
        self.assertIsNotNone(detection, "the vendor's own `rejected` is a decided quota exhaustion")
        self.assertEqual((detection["signature"], detection["trigger"], detection["resets_at"],
                          detection["matched_marker"]),
                         ("claude_rate_limit_event", "rejected", _SEPT_RESET, "rate_limit_rejected"))
        result = claude_runtime.ClaudeRunResult(
            returncode=1, stdout="", stderr=_TRUST_NOTICE, final_message="", usage=None, events=events,
            credit_exhaustion=detection,
            unreachable=claude_runtime.extract_unreachable(returncode=1, stderr=_TRUST_NOTICE, events=events),
        )
        with self.assertRaises(claude_runtime.ClaudeCreditExhausted) as raised:
            claude_runtime.run_with_model_fallback(run=lambda model, effort: result, model="opus", failover=None,
                                                   effort="max", write_capable=False)
        self.assertEqual((raised.exception.provider, raised.exception.detail["resets_at"]), ("anthropic", _SEPT_RESET))


    def test_a_rejected_window_that_overage_served_keeps_its_answer_and_still_cools(self) -> None:
        """Review of 79b82c8d3 (queue): with overage enabled the CLI may report the
        subscription window rejected while extra usage serves the run."""
        event = _rejected(1790316000)
        event["rate_limit_info"].update(isUsingOverage=True, overageStatus="allowed")
        events = (event, {"type": "result", "subtype": "success", "is_error": False, "result": "{}"})
        self.assertIsNone(claude_runtime.extract_credit_exhaustion(returncode=0, stderr="", events=events),
                          "a served answer is no refusal")
        reading = claude_runtime.extract_rate_limit_exhaustion(events)
        self.assertEqual((reading["trigger"], reading["resets_at"]), ("overage_serving", _SEPT_RESET))


class _Tools(unittest.TestCase):
    def setUp(self) -> None:
        import shutil
        import tempfile

        from aria_kernel.tool_registry import ensure_tools_dir

        self.root = Path(tempfile.mkdtemp(prefix="aria-quota-window-"))
        self.addCleanup(lambda: shutil.rmtree(self.root, ignore_errors=True))
        self.tools = ensure_tools_dir(self.root / "aria-tools")


class TheCooldownEndsAtTheWindowsReset(_Tools):
    def _cool(self, detection: dict, *, now: datetime = _T0) -> dict:
        return record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                        request_id="AIR-aria-evidence-judge-36a7df700ca6", claim_id="CL-1",
                                        detection=detection, now=now)["details"]

    def test_the_reading_cools_anthropic_until_the_reset_and_not_after(self) -> None:
        details = self._cool(claude_runtime.extract_rate_limit_exhaustion((_SEVEN_DAY_0_98,)))
        self.assertEqual((details["reason"], details["until"], details["until_source"]),
                         ("quota_unavailable", _SEPT_RESET, "stated_reset"))
        self.assertEqual(set(active_provider_cooldowns(self.tools, now=_T0 + timedelta(days=4))), {"anthropic"})
        reset = datetime(2026, 9, 25, 6, 0, tzinfo=timezone.utc)
        self.assertEqual(active_provider_cooldowns(self.tools, now=reset + timedelta(seconds=1)), {})

    def test_a_reset_already_past_or_beyond_a_week_falls_back_to_the_declared_default(self) -> None:
        for stamp in ("2026-09-20T00:00:00Z", "2026-10-05T00:00:00Z"):
            with self.subTest(resets_at=stamp):
                details = self._cool({"signature": "claude_rate_limit_event", "resets_at": stamp},
                                     now=_T0 + timedelta(days=30 if stamp.startswith("2026-10") else 0))
                self.assertEqual(details["until_source"], "policy_default")


_READ_TARGETS = {"primary_plan": "aria-primary-planner", "challenger_plan": "aria-challenger-planner",
                 "cross_review": "aria-cross-reviewer", "specialist_domain_review": "farm-expert"}


def _seats() -> list[tuple[str, str]]:
    """Every (role, target agent) the routing table dispatches."""
    seats: list[tuple[str, str]] = []
    for role, entry in load_provider_routing().roles.items():
        if isinstance(entry, dict):
            seats.extend((role, target) for target in sorted(entry))
        else:
            seats.append((role, _READ_TARGETS.get(role) or ROLE_TARGET_PAIRING[role][0]))
    return seats


class EverySeatFollowsTheCooldown(_FleetFixture):
    """The native admission over the real routing table and every seat's real profile."""

    def _seat(self, role: str, target: str) -> None:
        self.role = role
        self.read_only = read_agent_runtime_profile(target, repo_root=_REPO_ROOT)

    def _cool_from_the_stream(self) -> None:
        # The production road: the executor's credit arm writes what the
        # reader detected on the refused run.
        detection = claude_runtime.extract_credit_exhaustion(
            returncode=1, stderr=_TRUST_NOTICE, events=(_rejected(1790316000), _failed_result(_API_429)))
        self.assertIsNotNone(detection, "a rejected reading must decide the exhaustion")
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-x", claim_id="CL-x", detection=detection, now=_T0)

    def test_the_seats_cover_every_dispatchable_role(self) -> None:
        self.assertEqual({role for role, _target in _seats()}, set(DISPATCHABLE_ROLES))

    def test_while_cooled_every_read_seat_runs_on_zai_and_every_writer_waits_by_name(self) -> None:
        self._cool_from_the_stream()
        cooled = active_provider_cooldowns(self.tools, now=_T0 + timedelta(hours=1))
        for role, target in _seats():
            with self.subTest(role=role, target=target):
                self._seat(role, target)
                self.probed.clear()
                admission = self._admit({}, cooled=cooled)
                anthropic = next(row for row in admission.candidate_observations if row["provider"] == "anthropic")
                self.assertEqual((anthropic["status_reason"], anthropic["quota_cooldown"]["until"]),
                                 (COOLDOWN_STATUS_REASON, _SEPT_RESET))
                self.assertNotIn("anthropic", self.probed, "a cooled provider is never probed")
                if role in WRITE_SCOPE_ROLES:
                    self.assertTrue(self.read_only.write_capable)
                    self.assertIs(admission.outcome, AdmissionOutcome.NO_ELIGIBLE_PROVIDER)
                else:
                    self.assertFalse(self.read_only.write_capable)
                    self.assertEqual((admission.eligible_routes[0]["provider"], admission.eligible_routes[0]["model"]),
                                     ("zai", "glm-5.3"))

    def test_after_the_reset_every_seat_is_back_on_its_own_ladder_head(self) -> None:
        self._cool_from_the_stream()
        cooled = active_provider_cooldowns(self.tools, now=datetime(2026, 9, 25, 6, 0, 1, tzinfo=timezone.utc))
        self.assertEqual(cooled, {})
        routing = load_provider_routing()
        for role, target in _seats():
            with self.subTest(role=role, target=target):
                self._seat(role, target)
                self.assertEqual(self._admit({}, cooled=cooled).eligible_routes[0]["provider"],
                                 routing.ladder_for(role, target)[0])

    def test_with_zai_out_too_no_seat_runs_on_a_cooled_vendor(self) -> None:
        self._cool_from_the_stream()
        record_provider_cooldown(self.tools, provider="zai", model="glm-5.3", cooldown_seconds=900, request_id="AIR-z",
                                 claim_id="CL-z", detection={"signature": "zai_quota_refusal"}, now=_T0)
        cooled = active_provider_cooldowns(self.tools, now=_T0 + timedelta(minutes=5))
        self.environ["PATH"] = str(self.root / "no-binaries")  # codex absent too: the whole fleet is out
        for role, target in _seats():
            with self.subTest(role=role, target=target):
                self._seat(role, target)
                admission = self._admit({}, cooled=cooled)
                self.assertIs(admission.outcome, AdmissionOutcome.NO_ELIGIBLE_PROVIDER)
                self.assertEqual(admission.eligible_routes, ())


class TheSpawnLaneOrdersACooledVendorLast(unittest.TestCase):
    def test_a_cooled_claude_puts_the_primary_planner_on_glm_first_and_the_writer_keeps_its_rung(self) -> None:
        spawn = {"environ": {"PATH": ""}, "runtimes": ("claude", "zai"), "profile_model": "opus"}
        self.assertEqual(routed_models("primary_plan", "aria-primary-planner", write_capable=False,
                                       cooled={"anthropic"}, **spawn), ("glm-5.3", "opus"))
        self.assertEqual(routed_models("challenger_plan", "aria-challenger-planner", write_capable=False,
                                       cooled={"anthropic"}, **spawn), ("glm-5.3", "opus"))
        self.assertEqual(routed_models("implementation", "aria-implementer", write_capable=True,
                                       cooled={"anthropic"}, **spawn), ("opus",))


class TheDrainFollowsTheCooldown(unittest.TestCase):
    def _harness(self, queue: list[dict], summaries: dict[str, dict], *, cool_on: str | None = None):
        from tests import test_executor_drain_breaker as drain_tests

        harness = drain_tests._DrainHarness(queue=queue, summaries=summaries)
        if cool_on is not None:
            fake_run = harness._fake_run

            def child_that_cools(argv, **kwargs):  # noqa: ANN001, ANN003 — mock signature
                if "next-pending" not in argv and argv[2] == cool_on:
                    # What the real child's credit arm writes before it exits
                    # (any quota signature: the drain reads the cooldown, not
                    # the detection).
                    record_provider_cooldown(harness.tmp / "aria-tools", provider="anthropic", model="opus",
                                             cooldown_seconds=900, request_id=cool_on, claim_id="CL-1",
                                             detection={"signature": "claude_credit_error",
                                                        "matched_marker": "credit balance"})
                return fake_run(argv, **kwargs)

            harness._fake_run = child_that_cools
        self.addCleanup(harness.close)
        return harness, drain_tests

    def test_an_open_quota_circuit_does_not_skip_a_seat_the_next_vendor_serves(self) -> None:
        harness, drain_tests = self._harness(
            queue=[drain_tests_row("AIR-1"), drain_tests_row("AIR-2"), drain_tests_row("AIR-3")],
            summaries={
                "AIR-1": _drain_summary("AIR-1", outcome="failed", failure_class="credit_exhausted",
                                        provider="anthropic", model="opus"),
                "AIR-2": _drain_summary("AIR-2", outcome="succeeded", provider="zai", model="glm-5.3"),
                "AIR-3": _drain_summary("AIR-3", outcome="succeeded", provider="zai", model="glm-5.3"),
            },
            cool_on="AIR-1",
        )
        harness.run_drain()
        self.assertEqual([request for request, _target in harness.dispatched], ["AIR-1", "AIR-2", "AIR-3"],
                         "the evidence judges after the exhaustion run on zai, not skipped on anthropic's circuit")
        self.assertEqual(harness.payload()["circuit_breakers"], ["anthropic/opus/credit_exhausted"])

    def test_a_quota_exhaustion_is_not_a_persistent_breaker_failure(self) -> None:
        harness, _drain_tests = self._harness(
            queue=[drain_tests_row("AIR-1")],
            summaries={"AIR-1": _drain_summary("AIR-1", outcome="failed", failure_class="credit_exhausted",
                                               provider="anthropic", model="opus")},
        )
        harness.run_drain()
        self.assertEqual(harness.breaker_records, [], "the cooldown answers a quota; the breaker stops ARIA")


def drain_tests_row(request_id: str) -> dict:
    return {"request_id": request_id, "target_agent": "aria-evidence-judge", "role": "evidence_judgment",
            "target_sha": ""}


def _drain_summary(request_id: str, *, outcome: str, provider: str, model: str,
                   failure_class: str | None = None) -> dict:
    from tests.test_executor_drain_breaker import _summary

    return _summary(request_id=request_id, outcome=outcome, failure_class=failure_class, provider=provider,
                    model=model, role="evidence_judgment", target_agent="aria-evidence-judge")


class TheWorkerLaneCoolsAndWaits(unittest.TestCase):
    def setUp(self) -> None:
        from tests.test_worker_lane_provider_cooldown import _LaneFixture

        _LaneFixture.setUp(self)
        self.addCleanup(_LaneFixture.tearDown, self)

    def test_a_served_worker_run_at_the_threshold_cools_under_its_claim_and_its_answer_stands(self) -> None:
        import worker_executor
        from claude_runtime import ClaudeRunResult

        worktree = self.tmp / "worktrees" / "A-W-1"
        worktree.mkdir(parents=True)
        assignment = {"assignment_id": "A-W-1", "target_agent": "aria-worker", "worktree_path": str(worktree),
                      "required_tests": [], "expected_trailer": "Closes-Pressure: P-A-W-1", "timeout_seconds": 60}
        reset = int(time.time()) // 3600 * 3600 + 3 * 86400
        reading = claude_runtime.extract_rate_limit_exhaustion(
            (_with_utilization(_SEVEN_DAY_0_98, "seven_day", 0.98, reset),))

        def served(**kwargs: Any) -> ClaudeRunResult:
            return ClaudeRunResult(returncode=0, stdout="", stderr="", final_message="done", usage={},
                                   events=(), quota_window=reading)

        with patch.object(worker_executor, "_resolve_assignment", return_value=assignment), \
                patch.object(worker_executor, "run_claude_exec", served), \
                patch.object(worker_executor, "_submit_worker_result", return_value=0) as submitted, \
                patch.object(sys, "stderr", io.StringIO()):
            code = worker_executor.main(["A-W-1", "aria-worker", "--claim-id", "DC-7"])
        self.assertEqual(code, 0)
        submitted.assert_called_once()
        rows = [row["details"] for row in load_declared_jsonl(self.tools_root / "governance.jsonl",
                                                               expected_surface="tools_governance")
                if row["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]
        self.assertEqual([(row["provider"], row["claim_id"], row["until_source"]) for row in rows],
                         [("anthropic", "DC-7", "stated_reset")])
        self.assertEqual(rows[0]["until"], datetime.fromtimestamp(reset, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))

    def test_the_hook_holds_the_worker_by_name_without_a_claim(self) -> None:
        from aria_kernel.ledger import append_jsonl
        from aria_kernel.worker_dispatch_hook import dispatch_one_pending_worker_assignment

        record_provider_cooldown(self.tools_root, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-x", claim_id="CL-x",
                                 detection=claude_runtime.extract_rate_limit_exhaustion(
                                     (_rejected(int(time.time()) + 86400),)))
        path = self.tools_root / "dispatch" / "requests.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_jsonl(path, {
            "$schema": "aria/dispatch-request/v1", "schema_version": 1,
            "assignment_id": "A-W-1", "pressure_event_id": "P-A-W-1",
            "target_agent": "aria-worker", "triage_tier": "auto_fix_safe",
            "worktree_path": str(self.tmp / "worktrees" / "A-W-1"), "base_sha": "deadbeef",
            "required_tests": [], "expected_trailer": "Closes-Pressure: P-A-W-1",
            "state": "pending", "created_at": "2026-05-10T00:00:00Z",
        }, test_fixture=True)
        spawned: list[list[str]] = []
        with patch("aria_kernel.worker_dispatch_hook.subprocess.run",
                   lambda argv, *a, **k: spawned.append(list(argv))):
            result = dispatch_one_pending_worker_assignment(
                base_dir=self.tools_root, agent_id="daemon:test:1", github_adapter=MagicMock())
        self.assertEqual((result["status"], result["claim_id"]), ("provider_cooldown", None))
        self.assertEqual(result["provider_cooldown"]["provider"], "anthropic")
        self.assertEqual(spawned, [], "the worker waits for the reset; no claim, no spawn, no retry spent")


class TheNativeClaudeLaneReadsTheReading(unittest.TestCase):
    """The real executor child against a fake `claude` whose stream carries the reading."""

    def setUp(self) -> None:
        from tests.test_ci_executor_native_claude import NativeClaudeLane

        NativeClaudeLane.setUp(self)
        self.reset = int(time.time()) // 3600 * 3600 + 3 * 86400
        self.reset_iso = datetime.fromtimestamp(self.reset, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.status = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty",
                       "subscriptionType": "max"}

    def _install(self, script: str) -> None:
        executable = self.fixture_bin / "claude"
        executable.write_text(script, encoding="utf-8")
        executable.chmod(0o755)

    def _run(self, request_id: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, "-B", str(_POC_DIR / "ci_executor.py"), request_id, "aria-evidence-judge"],
            cwd=self.repo, env=self.environment, capture_output=True, text=True, timeout=180,
        )

    def _governance(self) -> list[dict]:
        return load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")

    def _refused_claude(self) -> str:
        return (
            f"#!{sys.executable}\n"
            "import json, sys\n"
            "argv = sys.argv[1:]\n"
            "if argv == ['--version']:\n"
            "    print('2.1.278 (Claude Code)'); raise SystemExit(0)\n"
            "if argv[:3] == ['auth', 'status', '--json']:\n"
            f"    status = {self.status!r}\n"
            "    print(json.dumps(status)); raise SystemExit(0)\n"
            "sys.stdin.read()\n"
            f"sys.stderr.write({_TRUST_NOTICE!r})\n"
            f"print(json.dumps({_rejected(self.reset)!r}))\n"
            f"print(json.dumps({_failed_result(_API_429)!r}))\n"
            "raise SystemExit(1)\n"
        )

    def test_a_429_whose_reading_is_rejected_requeues_uncharged_until_the_windows_reset(self) -> None:
        self._install(self._refused_claude())
        completed = self._run(self.request["request_id"])
        self.assertEqual(completed.returncode, 1, completed.stderr[-3000:])
        request_id = self.request["request_id"]
        self.assertEqual(self.ai.derive_request_state(request_id=request_id, base_dir=self.tools), "REQUEUED")
        claims = load_declared_jsonl(self.tools / "agent-invocations/claims.jsonl",
                                     expected_surface="agent_invocation_claims")
        released = [row for row in claims if row.get("event") == "released"]
        self.assertEqual([(row["reason"], row["fault_domain"]) for row in released],
                         [("provider_quota_unavailable:anthropic", "harness")])
        self.assertEqual(self.ai._request_fault_requeue_count(claims, request_id), 0)
        cooldowns = [row["details"] for row in self._governance() if row["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]
        self.assertEqual([(row["provider"], row["reason"], row["until"], row["until_source"]) for row in cooldowns],
                         [("anthropic", "quota_unavailable", self.reset_iso, "stated_reset")],
                         "the window's own reset, not a 900 s `unreachable` back-off")
        self.assertEqual(cooldowns[0]["detection"]["trigger"], "rejected")

    def test_a_served_run_at_the_threshold_is_accepted_and_the_next_request_is_held_off_claude(self) -> None:
        from tests.test_ci_executor_native_claude import _fake_claude

        reading = _with_utilization(_SEVEN_DAY_0_98, "seven_day", 0.98, self.reset)
        reading["rate_limit_info"]["resetsAt"] = self.reset
        script = _fake_claude(self.status, self.response, self.host_login_dir).replace(
            "prompt = sys.stdin.read()\n", f"prompt = sys.stdin.read()\nprint(json.dumps({reading!r}))\n", 1)
        self._install(script)
        completed = self._run(self.request["request_id"])
        self.assertEqual(completed.returncode, 0, completed.stderr[-3000:])
        self.assertEqual(self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools),
                         "ACCEPTED", "a served answer stands")
        cooldowns = [row["details"] for row in self._governance() if row["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]
        self.assertEqual([(row["provider"], row["until"], row["detection"]["trigger"]) for row in cooldowns],
                         [("anthropic", self.reset_iso, "utilization_threshold")])

        second = self.ai.create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="Inspect the provider declaration again, at the supplied source line.",
            must_satisfy=[{"id": "provider-source", "description": "cite the provider declaration"}],
            allowed_scope=["src/**"], evidence_refs=["src/model_fleet.py:1"],
            convergence_id="s4-native-admission", cycle_id="s4-native-admission",
            target_sha=self.request["target_sha"], context_repo_root=self.repo, base_dir=self.tools,
            admission=_admit(self.tools),
        )
        follow_up = self._run(second["request_id"])
        self.assertEqual(follow_up.returncode, 0, follow_up.stderr[-3000:])
        self.assertEqual(self.ai.derive_request_state(request_id=second["request_id"], base_dir=self.tools), "PENDING")
        governance = self._governance()
        self.assertEqual(len([row for row in governance if row["kind"] == "runtime_attempt_started"]), 1,
                         "no Claude spawn while the window is spent")
        decision = next(row["details"] for row in governance if row["kind"] == "runtime_admission_unavailable")
        anthropic = next(row for row in decision["candidate_observations"] if row["provider"] == "anthropic")
        self.assertEqual((anthropic["status_reason"], anthropic["quota_cooldown"]["until"]),
                         (COOLDOWN_STATUS_REASON, self.reset_iso))


def _admit(tools: Path) -> Any:
    from tests.test_ci_executor_live_path_smoke import admit_request

    return admit_request("operator_cli.request", "evidence_judgment", base_dir=tools)


if __name__ == "__main__":
    unittest.main()
