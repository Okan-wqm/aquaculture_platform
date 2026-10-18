"""ARIA-HIGH-579 — a night with every provider out holds in place; the next night continues.

Operator decision (2026-10-17): capacity is paced by pausing and resuming. When the quota runs
out, ARIA holds where it is and starts no cycle over; when it returns, ARIA continues from where
it stopped, and no work is lost. Review: docs/reviews/claude/2026-10-16-aria-known-issues-triage.md
(ARIA-HIGH-579).

ONE store, four nights through the nightly entry point the auto-cycle runs (``aria-kernel
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
1. Anthropic's window is spent (``rate_limit_event``, reset in 3 days) and Z.ai answers 429
   (cooled for ``_ZAI_WINDOW_SECONDS``). Every provider is out: the night holds.
2. Z.ai's window has passed; Anthropic is still cooled. The night runs as every night did before
   ARIA-HIGH-579, and continues the same request night 0 minted.
3. Anthropic still cooled. The planner's child spends Z.ai's window mid-night: every model phase
   after it holds.
"""
from __future__ import annotations

import io
import json
import os
import shutil
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
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.provider_hold import (
    CHECKPOINT_AFTER_PLANNER_DISPATCH, CHECKPOINT_CYCLE_START, HOLD_NOTICE_KIND, HOLD_PHASE, HOLD_STATUS,
)

from tests._helpers.operator_acts import operator_set_profile
from tests._helpers.production_shaped import cycle_workspace

_PLAN = "plan-hold"
_IMPL_PATH = "apps/farm-service/src/farm/services/water-quality.service.ts"
# Long enough for night 1 to reach its first checkpoint on a loaded host (it starts within a
# second and asks before anything else runs), short enough that night 2 does not wait long.
_ZAI_WINDOW_SECONDS = 45
# The store's ledgers a held night must leave byte-identical: every request, claim, admission,
# plan event, queued item and worker assignment, and what a cycle books and learns. Measured on
# the code before ARIA-HIGH-579, the all-cooled night of this scenario ran a whole cycle: it
# re-booked the adopted plan as minted and rejected in the funnel (knowledge-graph), wrote
# learning rows (memory) and a reflection, and recorded a completed cycle (cycles.jsonl).
_UNTOUCHED_BY_A_HELD_NIGHT = (
    "agent-invocations", "plans/events.jsonl", "queues", "dispatch", "skill-genesis", "knowledge-graph",
    "memory", "cycles.jsonl", "reflections.jsonl",
)


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
        record_provider_cooldown(base_dir, provider="zai", model="glm", cooldown_seconds=900, request_id=rid,
                                 claim_id=claim["claim_id"], detection={"signature": "zai_quota_refusal"})
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

        # Night 1 — every provider is out.
        now = datetime.now(timezone.utc)
        record_provider_cooldown(night.tools, provider="anthropic", model="claude-opus", cooldown_seconds=900,
                                 request_id="AIR-hold-anthropic", claim_id="CLM-hold-anthropic", detection={
                                     "source": "rate_limit_event", "signature": "claude_rate_limit_event",
                                     "trigger": "rejected", "status": "rejected",
                                     "resets_at": (now + timedelta(days=3)).replace(microsecond=0).isoformat()})
        cls.zai_until = record_provider_cooldown(
            night.tools, provider="zai", model="glm", cooldown_seconds=_ZAI_WINDOW_SECONDS,
            request_id="AIR-hold-zai", claim_id="CLM-hold-zai", detection={"signature": "zai_quota_refusal"},
        )["details"]["until"]
        cls.outbox_before_n1 = len(read_outbox(night.tools))
        cls.work_before_n1 = night.work_digest()
        cls.n1 = night.run()
        cls.work_after_n1 = night.work_digest()
        cls.outbox_n1 = read_outbox(night.tools)[cls.outbox_before_n1:]

        # Night 2 — Z.ai's window has passed; Anthropic's has not.
        until = datetime.fromisoformat(str(cls.zai_until).replace("Z", "+00:00"))
        while datetime.now(timezone.utc) <= until + timedelta(seconds=1):
            time.sleep(0.5)
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

    def test_the_all_cooled_night_records_one_hold_and_starts_no_cycle(self) -> None:
        _code, _summary, rows = self.n1
        self.assertEqual(_phases(rows), [HOLD_PHASE], rows)
        hold = rows[0]
        self.assertEqual((hold["status"], hold["cycle_id"]), (HOLD_STATUS, None))
        self.assertEqual(hold["details"]["checkpoint"], CHECKPOINT_CYCLE_START)
        self.assertEqual(hold["details"]["providers"], ["anthropic", "zai"])
        # The first provider back is Z.ai, at the end of its window.
        self.assertEqual(hold["details"]["until"].replace("+00:00", "Z"), str(self.zai_until).replace("+00:00", "Z"))

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

    def test_the_request_the_spend_interrupted_waits_uncharged(self) -> None:
        (minted_n0,) = self.plan_requests_n0
        rid = minted_n0["request_id"]
        self.assertEqual(self.night.planner.selected, [rid])
        self.assertEqual(_request_fault_requeue_count(self.claims, rid), 0)
        # Handed back, not failed: REQUEUED is claimable (`next_pending_request`), and the
        # requeue says nothing about the request (the count above).
        self.assertEqual(derive_request_state(request_id=rid, base_dir=self.night.tools), "REQUEUED")

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


if __name__ == "__main__":
    sys.exit(unittest.main())
