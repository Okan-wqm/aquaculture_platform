"""ARIA-HIGH-579 — a night with every provider out holds in place; the next night continues.

Operator decision (2026-10-17): capacity is paced by pausing and resuming. When the quota runs
out, ARIA holds where it is and starts no cycle over; when it returns, ARIA continues from where
it stopped, and no work is lost. Review: docs/reviews/claude/2026-10-16-aria-known-issues-triage.md
(ARIA-HIGH-579).

ONE store, five nights through the nightly entry point the auto-cycle runs (``aria-kernel
autonomy run --profile standard``, in process, the production runners the CLI selects). The
store is production-shaped: a git workspace, a plan started through ``plan_convergence``, the
production routing table and the production cooldown writer. What stands in, and why:

* ``claude`` and ``gh`` on PATH are stubs that log every invocation and fail: a night must spawn
  no model and reach no network from a test. The claude log must stay empty.
* The planner daemon is the real ``run_planner_dispatch_daemon`` with its per-tick hook replaced
  (``_PlannerChild``). The real hook spawns ``ci_executor`` in a git worktree of the repository
  that holds the executor; in a test that is this checkout. The stand-in does what the hook and
  its child do on this host at the moments the scenario needs: select the next planner request
  the kernel's own selection returns, and, on night 3, claim it and take the child's quota
  exhaustion arm (record the cooldown, release ``provider_quota_unavailable:zai``).

Nights:

0. Every provider serves. The cycle advances the adopted plan and mints its round request.
1. At production timing (review of ARIA-HIGH-579, major): Anthropic's window is spent
   (``rate_limit_event``, reset in 3 days), and Z.ai answered 429 at the 02:29 drain, hours before
   the 17:13 cycle cron. Z.ai's refusal states no reset, so its back-off (the policy-default 900 s)
   has lapsed by the cron while its outage is still open. Every provider is out: the night holds
   at its start and mints nothing.
2. A drain's served Z.ai spawn has restored Z.ai (``record_provider_restored``, the spawn seam);
   Anthropic is still cooled. The night runs as every night did before ARIA-HIGH-579, and
   continues the same request night 0 minted.
3. Anthropic still cooled. The planner's child spends Z.ai's window mid-night: every model phase
   after it holds, and the cycle that started still reflects.
4. Z.ai is restored again. The night continues the request night 3's spend handed back.
"""
from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import autonomous_planner_dispatcher
from aria_kernel.agent_invocations import (
    _request_fault_requeue_count, claim_request, derive_request_state, list_agent_invocation_requests,
    next_pending_request, release_claim,
)
from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import load_jsonl
from aria_kernel.notify import read_outbox
from aria_kernel.orchestrator_exit_history import (
    EXIT_PROVIDER_OUTAGE_HOLD, FAILED_EXIT_REASONS, read_orchestrator_exit_streak,
)
from aria_kernel.plan_convergence import start_plan
from aria_kernel.next_cycle_queue import append_pending
from aria_kernel.provider_cooldown import active_provider_cooldowns, record_provider_cooldown
from aria_kernel.provider_outage_ledger import open_outages, record_provider_restored
from aria_kernel.provider_hold import (
    CHECKPOINT_AFTER_PLANNER_DISPATCH, CHECKPOINT_CYCLE_START, HOLD_NOTICE_KIND, HOLD_PHASE, HOLD_STATUS,
)

from tests._helpers.operator_acts import operator_set_profile
from tests._helpers.production_shaped import cycle_workspace

_PLAN = "plan-hold"
_IMPL_PATH = "apps/farm-service/src/farm/services/water-quality.service.ts"
# The policy-default back-off (`genesis_policy` provider_cooldown_seconds): what Z.ai's quota
# refusal is cooled for, since it states no reset.
_POLICY_BACKOFF_SECONDS = 900
# Night 3's mid-night spend: the back-off the child writes is short so night 4 can follow it
# without waiting a production window. Whether it has lapsed by the checkpoint or not, the
# outage it opens is what the night reads.
_MIDNIGHT_BACKOFF_SECONDS = 5
# The store's ledgers a held night must leave byte-identical: every request, claim, admission,
# plan event and queued item, and what a cycle books and learns. Measured on the code before
# ARIA-HIGH-579, the all-cooled night of this scenario ran a whole cycle: it re-booked the
# adopted plan as minted and rejected in the funnel (knowledge-graph), wrote learning rows
# (memory) and a reflection, and recorded a completed cycle (cycles.jsonl). Each path must exist
# before the digest is taken (`_Night.work_digest`): a path the fixture never writes would pin
# nothing. The worker lane's assignments (``dispatch``) need the triage pipeline to exist and
# are not pinned here; the worker checkpoint is `TheWorkerLanesSpendHoldsTheReview`.
_UNTOUCHED_BY_A_HELD_NIGHT = (
    "agent-invocations", "plans/events.jsonl", "queues", "knowledge-graph", "memory", "cycles.jsonl",
    "reflections.jsonl",
)
_SEEDED_PRESSURE = "PE-held-night-queued"


def _plan_content() -> dict[str, Any]:
    return {
        "schema_version": 1, "title": "hold plan", "summary": "A plan the outage holds mid-convergence.",
        "affected_surfaces": [{"paths": [_IMPL_PATH]}], "key_changes": ["apply the declared change"],
        "validation_commands": [{"cmd": "nx affected --target=lint", "timeout_ms": 600_000}],
        "evidence_refs": ["docs/aria/SPEC.md"], "architectural_tier": 1,
    }


class _PlannerChild:
    """The planner hook and its executor child, as they act on this host (module docstring)."""

    def __init__(self, scenario: "_Night") -> None:
        self.scenario = scenario
        self.exhaust = False
        self.selected: list[str] = []
        self.requests_at_exhaustion: int | None = None

    def __call__(self, *, base_dir: Path, agent_id: str, planner_roles: tuple[str, ...],
                 lease_seconds: int) -> dict[str, Any]:
        request = next((row for role in planner_roles
                        if (row := next_pending_request(role=role, base_dir=base_dir)) is not None), None)
        if request is None:
            return {"status": "no_pending", "request_id": None, "claim_id": None, "exit_code": None}
        rid = str(request["request_id"])
        self.selected.append(rid)
        if not self.exhaust:
            # Night 2: the selection is the evidence; serving it would need a model.
            return {"status": "no_pending", "request_id": None, "claim_id": None, "exit_code": None}
        claim = claim_request(request_id=rid, agent_id=agent_id, base_dir=base_dir, lease_seconds=lease_seconds)
        # ci_executor's exhaustion arm: the vendor refused, the provider is cooled, the claim is
        # handed back under the reason that charges the request nothing.
        self.exhaust = False
        record_provider_cooldown(base_dir, provider="zai", model="glm", cooldown_seconds=_MIDNIGHT_BACKOFF_SECONDS,
                                 request_id=rid, claim_id=claim["claim_id"],
                                 detection={"signature": "zai_quota_refusal"})
        release_claim(claim_id=claim["claim_id"], agent_id=agent_id, lease_token=claim["lease_token"],
                      reason="provider_quota_unavailable:zai", base_dir=base_dir)
        self.requests_at_exhaustion = len(self.scenario.requests())
        return {"status": "executor_failed", "request_id": rid, "claim_id": claim["claim_id"], "exit_code": 1}


class _Night:
    """The store and the nightly entry point."""

    def __init__(self, tmp: Path) -> None:
        self.tmp = tmp
        fixture = cycle_workspace(tmp)
        self.workspace, self.tools = fixture.workspace_root, fixture.tools_dir
        self.claude_log = tmp / "claude-invocations.log"
        self.gh_log = tmp / "gh-invocations.log"
        self.planner = _PlannerChild(self)

    def requests(self) -> list[dict[str, Any]]:
        return list_agent_invocation_requests(base_dir=self.tools)

    def autonomy_rows(self) -> list[dict[str, Any]]:
        path = self.tools / "autonomy_state.jsonl"
        return load_jsonl(path) if path.exists() else []

    def work_digest(self) -> dict[str, bytes]:
        out: dict[str, bytes] = {}
        for name in _UNTOUCHED_BY_A_HELD_NIGHT:
            root = self.tools / name
            if not root.exists():
                raise AssertionError(f"pinned path absent, so it pins nothing: {name}")
            paths = [root] if root.is_file() else sorted(root.rglob("*")) if root.is_dir() else []
            for path in paths:
                if path.is_file() and not path.name.endswith(".lock"):
                    out[str(path.relative_to(self.tools))] = path.read_bytes()
        return out

    def run(self) -> tuple[int, dict[str, Any], list[dict[str, Any]]]:
        """One night: ``autonomy run`` as the cycle step invokes it; (exit code, summary, new rows)."""
        before = len(self.autonomy_rows())
        daemon = partial(autonomous_planner_dispatcher.run_planner_dispatch_daemon,
                         invoke_planner=self.planner, sleep=lambda _seconds: None)
        out, err = io.StringIO(), io.StringIO()
        with patch.object(autonomous_planner_dispatcher, "run_planner_dispatch_daemon", daemon), \
                redirect_stdout(out), redirect_stderr(err):
            code = cli_main([
                "--tools-dir", str(self.tools), "autonomy", "run", "--workspace-root", str(self.workspace),
                "--profile", "standard", "--max-cycles", "1", "--max-iterations-per-phase", "1",
                "--cycle-deadline-seconds", "1800",
            ])
        return code, json.loads(out.getvalue()), self.autonomy_rows()[before:]


def _stub(path: Path, log: Path) -> None:
    path.write_text(f'#!/bin/sh\necho "$0 $*" >> "{log}"\nexit 1\n', encoding="utf-8")
    path.chmod(0o755)


def _phases(rows: list[dict[str, Any]]) -> list[str]:
    return [str(row["phase"]) for row in rows]


class ANightWithEveryProviderOutHoldsAndTheNextContinues(unittest.TestCase):
    """The nights run once; each test reads one claim off them."""

    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = Path(tempfile.mkdtemp(prefix="aria-provider-hold-"))
        cls.addClassCleanup(shutil.rmtree, cls._tmp, ignore_errors=True)
        night = cls.night = _Night(cls._tmp)
        bin_dir = cls._tmp / "bin"
        bin_dir.mkdir()
        _stub(bin_dir / "claude", night.claude_log)
        _stub(bin_dir / "gh", night.gh_log)
        (cls._tmp / "zai.key").write_text("fixture-not-a-key\n", encoding="utf-8")
        # FIXTURE GIT (2026-10-18) — no GIT_* of a calling hook reaches the fixture repository; no
        # GitHub credential, notice channel or codex session of this host reaches the night.
        dropped = [name for name in os.environ if name.startswith("GIT_") or name in (
            "GH_TOKEN", "GITHUB_TOKEN", "ARIA_GH_TOKEN", "ARIA_NOTIFY_GITHUB_REPO", "ARIA_ZAI_API_KEY",
            "CODEX_HOME", "OPENAI_API_KEY", "ARIA_JOB_DEADLINE_EPOCH", "CLAUDE_CLI_MOCK")]
        env = patch.dict(os.environ, {
            "PATH": f"{bin_dir}{os.pathsep}/usr/bin{os.pathsep}/bin",
            "ARIA_ZAI_API_KEY_FILE": str(cls._tmp / "zai.key"),
            "ARIA_NOTIFY_CHANNELS": "none",
            "ARIA_DISPATCHER_POLL_TIMEOUT_SECONDS": "0",
            "PYTHONDONTWRITEBYTECODE": "1",
        })
        env.start()
        cls.addClassCleanup(env.stop)
        for name in dropped:
            os.environ.pop(name, None)

        operator_set_profile("standard", base_dir=night.tools)
        start_plan(plan_id=_PLAN, initial_revision_id="rev-0", plan_content=_plan_content(),
                   base_dir=night.tools)

        # Night 0 — every provider serves.
        cls.n0 = night.run()
        cls.plan_requests_n0 = [row for row in night.requests() if row.get("convergence_id") == _PLAN]

        # Night 1 — every provider is out, at production timing: Z.ai refused at the 02:29 drain,
        # its policy back-off lapsed long before the 17:13 cron, its outage is still open.
        now = datetime.now(timezone.utc)
        record_provider_cooldown(night.tools, provider="anthropic", model="claude-opus",
                                 cooldown_seconds=_POLICY_BACKOFF_SECONDS,
                                 request_id="AIR-hold-anthropic", claim_id="CLM-hold-anthropic", detection={
                                     "source": "rate_limit_event", "signature": "claude_rate_limit_event",
                                     "trigger": "rejected", "status": "rejected",
                                     "resets_at": (now + timedelta(days=3)).replace(microsecond=0).isoformat()})
        record_provider_cooldown(
            night.tools, provider="zai", model="glm", cooldown_seconds=_POLICY_BACKOFF_SECONDS,
            request_id="AIR-hold-zai", claim_id="CLM-hold-zai", detection={"signature": "zai_quota_refusal"},
            now=now - timedelta(hours=14, minutes=44),
        )
        cls.zai_cooled_at_n1 = "zai" in active_provider_cooldowns(night.tools)
        cls.zai_outage_open_at_n1 = any(i.provider == "zai" for i in open_outages(night.tools))
        # A queued item the held night must leave where it stands.
        append_pending(night.tools, source_cycle_id="cyc-before-the-outage", pressure_id=_SEEDED_PRESSURE)
        cls.outbox_before_n1 = len(read_outbox(night.tools))
        cls.work_before_n1 = night.work_digest()
        cls.n1 = night.run()
        cls.work_after_n1 = night.work_digest()
        cls.outbox_n1 = read_outbox(night.tools)[cls.outbox_before_n1:]

        # Night 2 — a drain's served Z.ai spawn restored Z.ai; Anthropic is still cooled.
        record_provider_restored(night.tools, provider="zai", seam="spawn", request_id="AIR-drain-served")
        cls.requests_before_n2 = night.requests()
        cls.n2 = night.run()
        cls.requests_after_n2 = night.requests()
        cls.selected_n2 = list(night.planner.selected)
        cls.state_after_n2 = derive_request_state(request_id=cls.plan_requests_n0[0]["request_id"],
                                                  base_dir=night.tools)

        # Night 3 — the planner's child spends Z.ai's window mid-night.
        night.planner.exhaust = True
        night.planner.selected.clear()
        cls.n3 = night.run()
        cls.requests_after_n3 = night.requests()
        cls.claims = load_jsonl(night.tools / "agent-invocations" / "claims.jsonl")
        cls.reflections_after_n3 = load_jsonl(night.tools / "reflections.jsonl")

        # Night 4 — Z.ai's back-off has run out and a drain's served spawn restored it again.
        cooled_until = active_provider_cooldowns(night.tools).get("zai", {}).get("until")
        if cooled_until:
            end = datetime.fromisoformat(str(cooled_until).replace("Z", "+00:00"))
            while datetime.now(timezone.utc) <= end + timedelta(seconds=1):
                time.sleep(0.5)
        record_provider_restored(night.tools, provider="zai", seam="spawn", request_id="AIR-drain-served-2")
        night.planner.selected.clear()
        cls.n4 = night.run()
        cls.selected_n4 = list(night.planner.selected)
        cls.requests_after_n4 = night.requests()

    # --- night 0: the baseline the hold is measured against -----------------------------------

    def test_night_zero_ran_a_full_cycle_and_minted_the_plans_round_request(self) -> None:
        code, summary, rows = self.n0
        self.assertEqual((code, summary["exit_reason"]), (0, "max_cycles"), summary)
        self.assertIn("convergence_resolved", _phases(rows))
        self.assertEqual(len(self.plan_requests_n0), 1, self.plan_requests_n0)

    # --- night 1: every provider out ----------------------------------------------------------

    def test_the_all_cooled_night_exits_clean_on_the_named_hold(self) -> None:
        code, summary, _rows = self.n1
        self.assertEqual(code, 0, summary)
        self.assertEqual(summary["exit_reason"], EXIT_PROVIDER_OUTAGE_HOLD)
        self.assertEqual(summary["overall_status"], "ok")
        self.assertEqual(summary["cycles_completed"], 0)
        self.assertNotIn(EXIT_PROVIDER_OUTAGE_HOLD, FAILED_EXIT_REASONS)

    def test_night_one_is_at_production_timing(self) -> None:
        # The premise the review measured: Z.ai's back-off has lapsed, its outage has not.
        self.assertEqual((self.zai_cooled_at_n1, self.zai_outage_open_at_n1), (False, True))

    def test_the_all_cooled_night_records_one_hold_and_starts_no_cycle(self) -> None:
        _code, _summary, rows = self.n1
        self.assertEqual(_phases(rows), [HOLD_PHASE], rows)
        hold = rows[0]
        self.assertEqual((hold["status"], hold["cycle_id"]), (HOLD_STATUS, None))
        self.assertEqual(hold["details"]["checkpoint"], CHECKPOINT_CYCLE_START)
        self.assertEqual(hold["details"]["providers"], ["anthropic", "zai"])
        # Z.ai is out on its open outage, waiting for a drain's re-probe: no clock says when a
        # provider is back.
        self.assertEqual(hold["details"]["awaiting_reprobe"], ["zai"])
        self.assertIsNone(hold["details"]["until"])

    def test_the_all_cooled_night_mints_no_round_request(self) -> None:
        self.assertEqual([row for row in self.requests_before_n2 if row.get("convergence_id") == _PLAN],
                         self.plan_requests_n0)

    def test_the_all_cooled_night_mints_claims_and_charges_nothing(self) -> None:
        self.assertEqual(self.work_after_n1, self.work_before_n1)

    def test_the_all_cooled_night_sends_one_notice_and_no_failure(self) -> None:
        new = self.outbox_n1
        held = [row for row in new if row["kind"] == HOLD_NOTICE_KIND]
        self.assertEqual(len(held), 1, new)
        self.assertEqual([row for row in new if row["kind"] == "cycle_failed"], [])

    def test_the_doctor_reads_the_held_night_as_a_clean_exit(self) -> None:
        streak = read_orchestrator_exit_streak(self.night.tools)
        reasons = [row["exit_reason"] for row in streak.exits]
        self.assertIn(EXIT_PROVIDER_OUTAGE_HOLD, reasons)
        self.assertFalse(streak.all_failed)

    # --- night 2: a provider is back -------------------------------------------------------------

    def test_anthropic_alone_cooled_runs_the_full_night_as_before(self) -> None:
        code, summary, rows = self.n2
        self.assertEqual((code, summary["exit_reason"]), (0, "max_cycles"), summary)
        self.assertNotIn(HOLD_PHASE, _phases(rows))
        self.assertEqual(_phases(rows), _phases(self.n0[2]))

    def test_the_next_night_continues_the_same_request_and_re_mints_nothing(self) -> None:
        (minted_n0,) = self.plan_requests_n0
        rid = minted_n0["request_id"]
        self.assertIn(rid, self.selected_n2)
        self.assertEqual(self.state_after_n2, "PENDING")
        plan_requests = [row["request_id"] for row in self.requests_after_n2 if row.get("convergence_id") == _PLAN]
        self.assertEqual(plan_requests, [rid])
        self.assertEqual([row["request_id"] for row in self.requests_after_n2 if row.get("remint_of")], [])

    # --- night 3: the quota runs out mid-night ---------------------------------------------------

    def test_mid_night_exhaustion_holds_every_model_phase_after_the_planner(self) -> None:
        code, summary, rows = self.n3
        self.assertEqual((code, summary["exit_reason"], summary["overall_status"]),
                         (0, EXIT_PROVIDER_OUTAGE_HOLD, "ok"), summary)
        phases = _phases(rows)
        self.assertEqual(phases[-2:], ["planner_dispatch_drained", HOLD_PHASE], phases)
        hold = rows[-1]
        self.assertEqual(hold["details"]["checkpoint"], CHECKPOINT_AFTER_PLANNER_DISPATCH)
        self.assertEqual(hold["cycle_id"], rows[0]["cycle_id"])
        self.assertEqual(hold["details"]["providers"], ["anthropic", "zai"])

    def test_mid_night_exhaustion_mints_nothing_after_the_spend(self) -> None:
        self.assertIsNotNone(self.night.planner.requests_at_exhaustion)
        self.assertEqual(len(self.requests_after_n3), self.night.planner.requests_at_exhaustion)

    def test_the_cycle_the_spend_cut_short_still_reflects(self) -> None:
        # ARIA-HIGH-420's rule for a night cut short: its reflection writes the daily report and
        # queues the next cycle's work, so a held cycle hands its pressures on.
        cycle_id = self.n3[2][0]["cycle_id"]
        self.assertEqual([row["cycle_id"] for row in self.reflections_after_n3 if row.get("cycle_id") == cycle_id],
                         [cycle_id])

    def test_the_request_the_spend_interrupted_waits_uncharged(self) -> None:
        (minted_n0,) = self.plan_requests_n0
        rid = minted_n0["request_id"]
        self.assertEqual(self.night.planner.selected, [rid])
        self.assertEqual(_request_fault_requeue_count(self.claims, rid), 0)
        # Handed back, not failed: REQUEUED is claimable (`next_pending_request`), and the
        # requeue says nothing about the request (the count above).
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.night.tools), "REQUEUED")

    # --- night 4: Z.ai back after the mid-night hold ---------------------------------------------

    def test_the_night_after_a_mid_night_hold_runs(self) -> None:
        code, summary, rows = self.n4
        self.assertEqual((code, summary["exit_reason"]), (0, "max_cycles"), summary)
        self.assertNotIn(HOLD_PHASE, _phases(rows))

    def test_the_night_after_a_mid_night_hold_continues_the_handed_back_request(self) -> None:
        (minted_n0,) = self.plan_requests_n0
        rid = minted_n0["request_id"]
        self.assertEqual(set(self.selected_n4), {rid})
        plan_requests = [row["request_id"] for row in self.requests_after_n4 if row.get("convergence_id") == _PLAN]
        self.assertEqual(plan_requests, [rid])
        self.assertEqual([row["request_id"] for row in self.requests_after_n4 if row.get("remint_of")], [])
        self.assertEqual(_request_fault_requeue_count(load_jsonl(self.night.tools / "agent-invocations"
                                                                 / "claims.jsonl"), rid), 0)

    # --- every night ---------------------------------------------------------------------------

    def test_no_night_spawned_a_model(self) -> None:
        self.assertFalse(self.night.claude_log.exists(),
                         self.night.claude_log.read_text() if self.night.claude_log.exists() else "")



class TheFleetOutageIsEveryRoleInAnOutage(unittest.TestCase):
    """``provider_outage.fleet_outage``: the night's question, asked per routed role."""

    _NOW = datetime(2026, 10, 18, 12, 0, tzinfo=timezone.utc)
    _PRESENT = frozenset({"anthropic", "zai"})

    def _cooled(self, *providers: str, hours: int = 3) -> dict[str, dict[str, str]]:
        until = (self._NOW + timedelta(hours=hours)).isoformat()
        return {provider: {"until": until, "reason": "quota_unavailable"} for provider in providers}

    def test_both_cooled_is_a_fleet_outage_until_the_first_returns(self) -> None:
        from aria_kernel.provider_outage import fleet_outage

        cooled = {**self._cooled("anthropic", hours=72), **self._cooled("zai", hours=2)}
        outage = fleet_outage(cooled, now=self._NOW, present=self._PRESENT)
        self.assertIsNotNone(outage)
        self.assertEqual(outage.providers, ("anthropic", "zai"))
        self.assertEqual(outage.until, (self._NOW + timedelta(hours=2)).isoformat())

    def test_anthropic_alone_cooled_is_no_fleet_outage(self) -> None:
        from aria_kernel.provider_outage import fleet_outage, provider_outage

        cooled = self._cooled("anthropic")
        self.assertIsNone(fleet_outage(cooled, now=self._NOW, present=self._PRESENT))
        # The read seats run on Z.ai; the per-request waits are unchanged.
        self.assertIsNone(provider_outage("challenger_plan", cooled, now=self._NOW, present=self._PRESENT))

    def test_anthropic_cooled_on_a_host_without_zai_is_a_fleet_outage(self) -> None:
        from aria_kernel.provider_outage import fleet_outage

        outage = fleet_outage(self._cooled("anthropic"), now=self._NOW, present=frozenset({"anthropic"}))
        self.assertIsNotNone(outage)
        self.assertEqual(outage.providers, ("anthropic",))

    def test_a_window_that_has_ended_cools_nothing(self) -> None:
        from aria_kernel.provider_outage import fleet_outage

        cooled = {**self._cooled("anthropic"), **self._cooled("zai", hours=-1)}
        self.assertIsNone(fleet_outage(cooled, now=self._NOW, present=self._PRESENT))

    def test_nothing_cooled_is_no_fleet_outage_whatever_is_absent(self) -> None:
        from aria_kernel.provider_outage import fleet_outage

        self.assertIsNone(fleet_outage({}, now=self._NOW, present=frozenset()))

    def test_the_hold_phase_is_a_declared_autonomy_phase(self) -> None:
        from aria_kernel.autonomy_state import AUTONOMY_PHASES

        self.assertIn(HOLD_PHASE, AUTONOMY_PHASES)


class TheNightReadsTheOutageNotTheBackoff(unittest.TestCase):
    """Review of ARIA-HIGH-579 (major): the night's question at production timing.

    A cooldown is the probe BACK-OFF of an outage (ARIA-HIGH-366): it says when to ASK again, and
    the asking is done by a lane that carries a request (the drains' native admission, the
    planner hook's child). Z.ai's quota refusal states no reset, so its back-off is the policy
    900 s, doubling to 3600 s; the cycle cron fires 15 hours after the executor drain. Reading the
    back-off, the night saw Z.ai as serving whenever its outage was still open.
    """

    _T0 = datetime(2026, 10, 18, 2, 40, tzinfo=timezone.utc)   # the 02:29 drain meets the 429
    _CRON = datetime(2026, 10, 18, 17, 13, tzinfo=timezone.utc)

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-provider-hold-timing-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.base = self.tmp / "aria-tools"
        operator_set_profile("standard", base_dir=self.base)
        host = patch("aria_kernel.provider_hold.host_providers", return_value=frozenset({"anthropic", "zai"}))
        host.start()
        self.addCleanup(host.stop)
        quiet = patch.dict(os.environ, {"ARIA_NOTIFY_CHANNELS": "none"})
        quiet.start()
        self.addCleanup(quiet.stop)

    def _waiting_request(self) -> str:
        from tests._helpers.production_shaped import production_request_without_anchor

        return str(production_request_without_anchor(base_dir=self.base)["request_id"])

    def _anthropic_spent(self, *, resets_in: timedelta = timedelta(days=3)) -> None:
        record_provider_cooldown(self.base, provider="anthropic", model="claude-opus",
                                 cooldown_seconds=_POLICY_BACKOFF_SECONDS, request_id="AIR-a", claim_id="CLM-a",
                                 detection={"source": "rate_limit_event", "signature": "claude_rate_limit_event",
                                            "trigger": "rejected", "status": "rejected",
                                            "resets_at": (self._T0 + resets_in).isoformat()},
                                 now=self._T0)

    def _zai_refused(self, *, times: int = 4) -> None:
        moment = self._T0
        for index in range(times):
            row = record_provider_cooldown(self.base, provider="zai", model="glm",
                                           cooldown_seconds=_POLICY_BACKOFF_SECONDS, request_id=f"AIR-z{index}",
                                           claim_id=f"CLM-z{index}", detection={"signature": "zai_quota_refusal"},
                                           now=moment)
            moment = datetime.fromisoformat(row["details"]["until"].replace("Z", "+00:00")) + timedelta(seconds=1)

    def test_the_cron_after_a_lapsed_backoff_holds_while_the_outage_is_open(self) -> None:
        from aria_kernel.provider_hold import night_outage

        self._waiting_request()
        self._anthropic_spent()
        self._zai_refused()
        for moment in (self._CRON, self._CRON + timedelta(days=1)):
            self.assertNotIn("zai", active_provider_cooldowns(self.base, now=moment))
            outage = night_outage(self.base, now=moment)
            self.assertIsNotNone(outage, moment)
            self.assertEqual(outage.providers, ("anthropic", "zai"))
            self.assertEqual(outage.awaiting_reprobe, ("zai",))
            self.assertIsNone(outage.until)

    def test_a_provider_restored_by_a_served_spawn_ends_the_hold(self) -> None:
        from aria_kernel.provider_hold import night_outage

        self._waiting_request()
        self._anthropic_spent()
        self._zai_refused()
        record_provider_restored(self.base, provider="zai", seam="spawn", request_id="AIR-served",
                                 now=self._CRON - timedelta(hours=1))
        self.assertIsNone(night_outage(self.base, now=self._CRON))

    def test_a_reset_the_vendor_stated_and_that_has_passed_is_the_vendors_word_that_it_is_back(self) -> None:
        from aria_kernel.provider_hold import night_outage

        self._waiting_request()
        self._anthropic_spent(resets_in=timedelta(hours=6))
        record_provider_cooldown(self.base, provider="zai", model="glm", cooldown_seconds=_POLICY_BACKOFF_SECONDS,
                                 request_id="AIR-z", claim_id="CLM-z", detection={"signature": "zai_quota_refusal"},
                                 now=self._CRON - timedelta(minutes=5))
        # Anthropic's outage stays open until a spawn serves; the night is that spawn's source.
        self.assertTrue(any(i.provider == "anthropic" for i in open_outages(self.base)))
        self.assertIsNone(night_outage(self.base, now=self._CRON))

    def test_with_nothing_waiting_to_carry_the_reprobe_the_night_runs(self) -> None:
        # No drain would ask Z.ai again: a held night would hold for ever though the quota came
        # back. The night runs, and what it mints is the request the next drain re-probes with.
        from aria_kernel.provider_hold import night_outage

        self._anthropic_spent()
        self._zai_refused()
        self.assertIsNone(night_outage(self.base, now=self._CRON))

    def test_a_waiter_no_drain_would_select_carries_no_reprobe(self) -> None:
        # The owner's eligibility (`agent_invocations.selection_skip`) never hands out an
        # implementation envelope the delivery has no authority for (ARIA-HIGH-388): no drain
        # selects it, so its ladder names no re-probe. The state half alone counted it and stood
        # a hold nothing could end — no drain asks, nothing restores, the outage stays open.
        from aria_kernel.implementation_dispatch import implementation_dispatch_refusal
        from aria_kernel.provider_hold import night_outage
        from tests._helpers.production_shaped import production_implementation_request

        # FIXTURE GIT — no GIT_* of a calling hook reaches the fixture repository.
        saved_git = {name: os.environ.pop(name) for name in list(os.environ) if name.startswith("GIT_")}
        try:
            workspace = self.tmp / "implementation-ws"
            (workspace / "apps").mkdir(parents=True)
            (workspace / "apps" / "farm.txt").write_text("fixture\n", encoding="utf-8")
            for argv in (("git", "init", "-q", str(workspace)),
                         ("git", "-C", str(workspace), "add", "."),
                         ("git", "-C", str(workspace), "-c", "user.email=fixture@aria.test",
                          "-c", "user.name=fixture", "commit", "-qm", "fixture base")):
                subprocess.run(argv, check=True)
            envelope = production_implementation_request(
                tools_dir=self.base, workspace_root=workspace, plan_id="plan-undispatchable-waiter",
                allowed_path="apps/farm.txt")
        finally:
            os.environ.update(saved_git)
        # The premise, read from the owner: this envelope is never handed out.
        self.assertIsNotNone(implementation_dispatch_refusal(request=envelope, base_dir=self.base))
        self._anthropic_spent()
        self._zai_refused()
        self.assertIsNone(night_outage(self.base, now=self._CRON))

    def test_a_standing_backoff_still_holds_on_its_clock(self) -> None:
        from aria_kernel.provider_hold import night_outage

        self._anthropic_spent()
        self._zai_refused(times=1)
        outage = night_outage(self.base, now=self._T0 + timedelta(minutes=5))
        self.assertIsNotNone(outage)
        self.assertEqual(outage.awaiting_reprobe, ())
        self.assertEqual(outage.until, (self._T0 + timedelta(seconds=_POLICY_BACKOFF_SECONDS)).isoformat())

    def test_the_per_request_question_still_reads_the_backoff(self) -> None:
        # The planner hook and the discretionary mint admission ask per request, and a lapsed
        # back-off is exactly when their request carries the re-probe (ARIA-HIGH-435): unchanged.
        from aria_kernel.provider_outage import cooled_providers, provider_outage

        self._anthropic_spent()
        self._zai_refused()
        cooled = cooled_providers(self.base, now=self._CRON)
        self.assertIsNone(provider_outage("challenger_plan", cooled, now=self._CRON,
                                          present=frozenset({"anthropic", "zai"})))

    def test_an_unreadable_outage_ledger_fails_open_and_names_itself(self) -> None:
        # The fail-open is the design (an unreadable ledger is not an outage: the night runs and
        # each request's admission refuses the malformed row by name); silence is not — the
        # operator learns the hold was never even asked, one notice naming the unreadable source.
        # The row is chained through the store's own writer: the chain verifies, and the outage
        # fold refuses its details by name.
        from aria_kernel.notify import read_outbox
        from aria_kernel.provider_hold import night_outage
        from aria_kernel.tool_registry import append_tools_governance

        self._waiting_request()
        self._anthropic_spent()
        self._zai_refused()
        append_tools_governance(self.base, "provider_outage_opened", {"schema_version": 999})
        self.assertIsNone(night_outage(self.base, now=self._CRON))
        rows = [row for row in read_outbox(self.base) if row["kind"] == "hold_indeterminate"]
        self.assertEqual([row["title"] for row in rows],
                         ["ARIA hold indeterminate: outage_ledger could not be read"], rows)

    def test_an_unreadable_cooldown_ledger_fails_open_and_names_itself(self) -> None:
        # A row with no ledger hash breaks the chain the cooldown read verifies strictly: the
        # read's own RuntimeError taxonomy used to raise past the hold's catch and take the
        # checkpoint (and with it the night) down, the opposite of failing open.
        from aria_kernel.notify import read_outbox
        from aria_kernel.provider_hold import night_outage

        self._waiting_request()
        self._anthropic_spent()
        self._zai_refused()
        with (self.base / "governance.jsonl").open("a", encoding="utf-8") as governance:
            governance.write(json.dumps({
                "kind": "provider_quota_cooldown", "details": {"schema_version": 1},
            }) + "\n")
        self.assertIsNone(night_outage(self.base, now=self._CRON))
        rows = [row for row in read_outbox(self.base) if row["kind"] == "hold_indeterminate"]
        self.assertEqual([row["title"] for row in rows],
                         ["ARIA hold indeterminate: cooldown_ledger could not be read"], rows)


class TheWorkerLanesSpendHoldsTheReview(unittest.TestCase):
    """The second spawning lane: a worker spawn that spends the last window holds the review."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-provider-hold-worker-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.base = self.tmp / "aria-tools"
        operator_set_profile("standard", base_dir=self.base)
        host = patch("aria_kernel.provider_hold.host_providers", return_value=frozenset({"anthropic", "zai"}))
        host.start()
        self.addCleanup(host.stop)
        quiet = patch.dict(os.environ, {"ARIA_NOTIFY_CHANNELS": "none"})
        quiet.start()
        self.addCleanup(quiet.stop)

    def test_review_is_not_minted_after_the_worker_spent_the_last_window(self) -> None:
        from aria_kernel.autonomy_orchestrator import run_autonomy_orchestrator
        from aria_kernel.provider_hold import CHECKPOINT_AFTER_WORKER_DISPATCH
        from tests import test_autonomy_orchestrator as fakes

        reviews: list[dict[str, Any]] = []

        def worker_drainer(**kwargs: Any) -> dict[str, Any]:
            # The worker child's exhaustion arm, for both providers the fleet has.
            for provider, signature in (("anthropic", "claude_credit_error"), ("zai", "zai_quota_refusal")):
                record_provider_cooldown(self.base, provider=provider, model="m", cooldown_seconds=900,
                                         request_id=f"AIR-w-{provider}", claim_id=f"CLM-w-{provider}",
                                         detection={"signature": signature})
            return fakes._fake_worker_drainer(**kwargs)

        def review_runner(**kwargs: Any) -> dict[str, Any]:
            reviews.append(kwargs)
            return fakes._fake_review_runner(**kwargs)

        result = run_autonomy_orchestrator(
            base_dir=self.base, workspace_root=str(self.tmp), max_cycles=1, max_iterations_per_phase=1,
            cycle_runner=fakes._fake_cycle_runner, planner_drainer=fakes._fake_planner_drainer,
            worker_drainer=worker_drainer, bridge_drainer=fakes._fake_bridge_drainer,
            auto_merge_runner=fakes._fake_auto_merge_runner, github_adapter=fakes._fake_github_adapter,
            convergence_runner=fakes._fake_convergence_runner, review_runner=review_runner,
            specialist_review_runner=fakes._fake_specialist_review_runner,
            plan_synthesizer=fakes._fake_plan_synthesizer, skill_genesis_drainer=fakes._fake_skill_genesis_drainer,
            profile="standard",
        )
        self.assertEqual((result["exit_reason"], result["exits_clean"]), (EXIT_PROVIDER_OUTAGE_HOLD, True))
        self.assertEqual(reviews, [])
        rows = load_jsonl(self.base / "autonomy_state.jsonl")
        self.assertEqual(_phases(rows)[-2:], ["worker_dispatch_drained", HOLD_PHASE])
        self.assertEqual(rows[-1]["details"]["checkpoint"], CHECKPOINT_AFTER_WORKER_DISPATCH)
        # The cycle step ran before the hold: its reflection still writes (ARIA-HIGH-420's rule).
        cycle_id = rows[-1]["cycle_id"]
        reflections = load_jsonl(self.base / "reflections.jsonl") if (self.base / "reflections.jsonl").exists() else []
        self.assertEqual([row["cycle_id"] for row in reflections if row.get("cycle_id") == cycle_id], [cycle_id])
        self.assertEqual(result["per_cycle"][-1]["reflection"]["cycle_id"], cycle_id)


if __name__ == "__main__":
    sys.exit(unittest.main())
