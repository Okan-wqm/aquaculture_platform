"""Wall #7 — the backlog cap bounds what ARIA can close, and never freezes discovery.

E25-a (ORPHAN-710) paused ``watchdog_sweep`` and ``experiment_author`` while
25 findings were OPEN or IN_PROGRESS, counting every finding alike. A finding
whose only surfaces are READONLY_PATHS can be closed by an operator alone, so
past the cap "ARIA cannot fix it" became "ARIA stops looking". These pins
cover the replacement:

- the cap counts the CLOSABLE backlog: ``finding_grounding.closure_blocker``,
  the plan admission's own grounding with the status gate widened to the
  backlog, decides who can close a finding; runner faults stay undecided and
  count toward the cap;
- operator-only findings are counted apart, surfaced with their age, and
  escalated once on governance past the declared age;
- a closure-throughput SLO from the finding event ledger (closable openings
  vs closures in a declared window) throttles the opener whose findings grew
  the backlog;
- pressure throttles an opener to one admission per declared interval — a
  rate with a named ``finding_opener_throttled`` event, never a freeze;
- every rhythm value is bounded policy.

New names are read off the modules inside each test, so on a base without
them every test fails on its own line rather than the module failing to load.
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import cycle as cycle_mod
from aria_kernel import cycle_guard
from aria_kernel import finding_grounding as fg
from aria_kernel import genesis_policy
from aria_kernel.finding import ORIGINATING_SKILL_ALLOWLIST, findings_dir
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.declared_fixtures import append_declared_fixture
from tests._helpers.operator_requests import GROUNDED_FILE, OperatorRequestFixture, git

NOW = datetime(2026, 10, 3, 12, 0, tzinfo=timezone.utc)
READONLY_REF = ".github/workflows/ci.yml:1"
WATCHDOG = "aria-watchdog:stall"
CONSENSUS = "ai_consensus:judgment_pipeline"


def _stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def _phase(name: str) -> cycle_mod.CyclePhase:
    return next(phase for phase in cycle_mod.CYCLE_PHASES if phase.name == name)


class _Store(unittest.TestCase):
    """A checkout on main, its tools store, and findings minted through the event fold."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-wall7-")
        self.addCleanup(tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(tmp.name))
        self.findings = 0

    def seed(self, count: int, *, refs: list[str], age_days: float = 30.0,
             origin: str = WATCHDOG, status: str = "OPEN") -> list[str]:
        ids = []
        for _ in range(count):
            self.findings += 1
            finding_id = f"F-{self.findings:03d}"
            self.fx.seed_finding(finding_id, refs=refs, status=status, body={
                "created_at": _stamp(NOW - timedelta(days=age_days)), "originating_skill": origin,
            })
            ids.append(finding_id)
        self._write_index()
        return ids

    def close(self, finding_id: str, *, days_ago: float) -> None:
        append_declared_fixture(findings_dir(self.fx.repo) / "finding-events.jsonl", {
            "schema_version": 1, "event": "finding_status_changed",
            "event_id": f"finding:{finding_id}:status:WITHDRAWN", "finding_id": finding_id,
            "from_status": "OPEN", "to_status": "WITHDRAWN", "reason": "fixture", "actor": "test",
            "recorded_at": _stamp(NOW - timedelta(days=days_ago)),
        }, expected_surface="repo_finding_events")
        self._write_index()

    def _write_index(self) -> None:
        # The index production keeps beside the ledger (finding._refresh_index):
        # the E25-a counter read it, so a fixture without it would pass on the base.
        from aria_kernel.finding import fold_findings

        rows = [{"finding_id": fid, "status": rec.get("status")}
                for fid, rec in sorted((fold_findings(self.fx.repo) or {}).items())]
        (findings_dir(self.fx.repo) / "_index.json").write_text(json.dumps({"findings": rows}), encoding="utf-8")

    def policy(self, **rhythm: object) -> None:
        path = self.fx.repo / "aria-config" / "genesis_policy.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"$schema": "aria/genesis-policy/v1", "schema_version": 1,
                                    "rhythm": rhythm}), encoding="utf-8")

    def context(self, at: datetime = NOW) -> cycle_mod.PhaseContext:
        """A cycle context after this cycle's backlog census phase ran."""
        context = cycle_mod.build_phase_context(
            cycle_id=f"cyc-{at:%H%M%d}", workspace_root=self.fx.repo, base_dir=self.fx.tools,
            cycle_started_at=at,
        )
        census = next((p for p in cycle_mod.CYCLE_PHASES if p.name == "finding_backlog"), None)
        if census is not None:
            context.results["finding_backlog"] = census.runner(context)
        return context

    def governance(self, kind: str) -> list[dict]:
        return [row["details"] for row in load_declared_jsonl(
            self.fx.tools / "governance.jsonl", expected_surface="tools_governance",
        ) if row["kind"] == kind]


class OperatorOnlyBacklogTests(_Store):
    def test_operator_only_findings_never_pause_the_openers(self) -> None:
        self.seed(30, refs=[READONLY_REF])
        context = self.context()
        self.assertTrue(_phase("watchdog_sweep").precondition.satisfied_by(context))
        self.assertTrue(_phase("experiment_author").precondition.satisfied_by(context))
        census = context.result("finding_backlog")
        self.assertEqual((census["capped"], len(census["operator_only"])), (0, 30))
        self.assertEqual(census["operator_only"][0]["reason"], fg.FINDING_SURFACES_READONLY)
        self.assertEqual(census["operator_only"][0]["age_days"], 30.0)
        self.assertEqual(self.governance("finding_opener_throttled"), [])

    def test_operator_only_findings_escalate_once_past_the_declared_age(self) -> None:
        old = self.seed(1, refs=[READONLY_REF], age_days=20)
        self.seed(1, refs=[READONLY_REF], age_days=3)
        self.assertEqual(self.context().result("finding_backlog")["escalated"], old)
        self.assertEqual(self.context(NOW + timedelta(hours=3)).result("finding_backlog")["escalated"], [])
        rows = self.governance("finding_operator_escalated")
        self.assertEqual([(row["finding_id"], row["age_limit_days"]) for row in rows], [(old[0], 14)])
        self.assertEqual(rows[0]["reason"], fg.FINDING_SURFACES_READONLY)

    def test_the_doctor_surfaces_operator_only_findings_with_their_age(self) -> None:
        from aria_kernel import doctor

        self.seed(1, refs=[READONLY_REF], age_days=20)
        check = doctor._check_finding_backlog(self.fx.repo, now=NOW)
        self.assertEqual(check.status, "warn")
        self.assertIn("operator_only_overdue:F-001@20.0d", check.reason)


class ClosabilityTests(_Store):
    def test_closability_is_the_plan_admission_widened_to_the_backlog(self) -> None:
        open_id, = self.seed(1, refs=[f"{GROUNDED_FILE}:1"])
        started, = self.seed(1, refs=[f"{GROUNDED_FILE}:1"], status="IN_PROGRESS")
        readonly, = self.seed(1, refs=[READONLY_REF])
        context = fg.load_grounding_context(self.fx.repo)
        self.assertIsNone(fg.closure_blocker(context, open_id))
        self.assertIsNone(fg.closure_blocker(context, started))
        self.assertEqual(fg.closure_blocker(context, readonly), fg.FINDING_SURFACES_READONLY)
        # The plan admission itself is unchanged: an IN_PROGRESS finding is not a new plan ground.
        self.assertEqual(fg.admit_finding(context, started).reason, fg.FINDING_NOT_OPEN)
        census = cycle_guard.backlog_census(self.fx.repo, now=NOW)
        self.assertEqual(census["closable"], [open_id, started])

    def test_a_runner_fault_is_undecided_and_still_counts_toward_the_cap(self) -> None:
        self.seed(2, refs=[f"{GROUNDED_FILE}:1"])
        git(self.fx.repo, "update-ref", "-d", "refs/remotes/origin/main")
        census = cycle_guard.backlog_census(self.fx.repo, now=NOW)
        self.assertEqual(census["closable"], [])
        self.assertEqual([row["reason"] for row in census["undecided"]], [fg.CHECKOUT_UNAVAILABLE] * 2)
        self.assertEqual(census["capped"], 2)


class OpenerThrottleTests(_Store):
    def test_closable_backlog_over_the_cap_throttles_the_opener_to_a_rate(self) -> None:
        self.seed(26, refs=[f"{GROUNDED_FILE}:1"])
        gate = _phase("watchdog_sweep").precondition
        self.assertTrue(gate.satisfied_by(self.context(NOW)))
        self.assertFalse(gate.satisfied_by(self.context(NOW + timedelta(hours=2))))
        self.assertFalse(gate.satisfied_by(self.context(NOW + timedelta(hours=4))))
        self.assertTrue(gate.satisfied_by(self.context(NOW + timedelta(hours=25))))
        rows = [row for row in self.governance("finding_opener_throttled") if row["opener"] == "watchdog_sweep"]
        # The held decision is recorded once while its claim stands, not once per cycle.
        self.assertEqual([row["admitted"] for row in rows], [True, False, True])
        self.assertEqual(rows[1]["reasons"], ["closable_backlog_at_cap"])
        self.assertEqual((rows[1]["capped"], rows[1]["backlog_cap"]), (26, 25))
        self.assertEqual(rows[1]["next_admission_at"], _stamp(NOW + timedelta(hours=24)))

    def test_the_slo_throttles_only_the_opener_whose_findings_grew_the_backlog(self) -> None:
        self.seed(2, refs=[f"{GROUNDED_FILE}:1"], age_days=2, origin=CONSENSUS)
        closed, = self.seed(1, refs=[f"{GROUNDED_FILE}:1"], age_days=20)
        self.close(closed, days_ago=1)
        context = self.context()
        self.assertTrue(_phase("watchdog_sweep").precondition.satisfied_by(context))
        admit = cycle_guard.admit_finding_opener
        census = context.result("finding_backlog")
        self.assertTrue(admit(self.fx.tools, "judgment_fanout", census, now=NOW).admitted)
        held = admit(self.fx.tools, "judgment_fanout", census, now=NOW + timedelta(hours=1))
        self.assertEqual((held.admitted, held.reasons), (False, ("closure_slo_breached",)))
        self.assertEqual({row["opener"] for row in self.governance("finding_opener_throttled")}, {"judgment_fanout"})

    def test_an_unknown_opener_is_refused_by_name(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "finding_opener_unknown:discovery"):
            cycle_guard.admit_finding_opener(self.fx.tools, "discovery", None, now=NOW)

    def test_a_cycle_without_a_census_runs_its_openers_at_the_rate(self) -> None:
        admit = cycle_guard.admit_finding_opener
        self.assertTrue(admit(self.fx.tools, "watchdog_sweep", None, now=NOW).admitted)
        held = admit(self.fx.tools, "watchdog_sweep", None, now=NOW + timedelta(hours=1))
        self.assertEqual(held.reasons, ("backlog_census_unavailable",))
        self.assertFalse(held.admitted)

    def test_every_finding_origin_has_exactly_one_opener_or_is_an_operator_act(self) -> None:
        for origin in sorted(ORIGINATING_SKILL_ALLOWLIST):
            with self.subTest(origin=origin):
                owners = [name for name, prefixes in cycle_guard.FINDING_OPENERS.items()
                          if origin.startswith(prefixes)]
                operator = origin.startswith(cycle_guard.FINDING_OPERATOR_ORIGINS)
                self.assertEqual(len(owners) + int(operator), 1, owners)


class SeederThrottleTests(_Store):
    def test_a_held_seeder_mints_nothing_and_says_why(self) -> None:
        import sys

        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))
        import seed_drift_findings as seeder

        self.seed(26, refs=[f"{GROUNDED_FILE}:1"])
        census = cycle_guard.backlog_census(self.fx.repo)
        self.assertTrue(cycle_guard.admit_finding_opener(self.fx.tools, "seed_drift_findings", census).admitted)
        drift = {
            "drift_class": "enum-drift", "concept": "leave_status", "cross_service": True,
            # A mintable drift (seeder: severity + classification, else
            # unclassified_drift), so the refusal under test is the throttle's.
            "severity": "HIGH", "classification": "ts_value_not_in_db",
            "missing_in_ts": ["ARCHIVED"], "missing_in_sql": [],
            "ts": {"ref": f"{GROUNDED_FILE}:1", "name": "LeaveStatus", "values": ["A"]},
            "sql": {"ref": "apps/hr-service/src/leave/leave.entity.ts:1", "name": "leave_status", "values": ["A", "B"]},
        }
        minted, already, unmintable = seeder.mint_candidates(self.fx.repo, [drift], base_dir=self.fx.tools)
        self.assertEqual((minted, already), ([], []))
        self.assertEqual(unmintable, [{"concept": "leave_status", "reason": "opener_throttled:closable_backlog_at_cap"}])


class ClosureSloTests(_Store):
    def test_the_slo_is_computed_from_the_event_history_inside_the_window(self) -> None:
        self.seed(2, refs=[f"{GROUNDED_FILE}:1"], age_days=2, origin=CONSENSUS)
        self.seed(1, refs=[f"{GROUNDED_FILE}:1"], age_days=10)          # opened before the window
        self.seed(1, refs=[READONLY_REF], age_days=1)                   # operator-only: not closable growth
        early, late = self.seed(2, refs=[f"{GROUNDED_FILE}:1"], age_days=40)
        self.close(early, days_ago=9)                                   # closed before the window
        self.close(late, days_ago=1)
        slo = cycle_guard.backlog_census(self.fx.repo, now=NOW)["slo"]
        self.assertEqual(slo, {"window_days": 7, "opened_closable": 2, "closed": 1,
                               "opened_by_origin": {CONSENSUS: 2}, "breached": True})
        self.policy(closure_slo_window_days=1)
        slo = cycle_guard.backlog_census(self.fx.repo, now=NOW)["slo"]
        self.assertEqual((slo["opened_closable"], slo["closed"], slo["breached"]), (0, 1, False))


class RhythmPolicyBoundsTests(unittest.TestCase):
    def _policy(self, **rhythm: object) -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "aria-config").mkdir()
            (Path(tmp) / "aria-config" / "genesis_policy.json").write_text(json.dumps(
                {"$schema": "aria/genesis-policy/v1", "schema_version": 1, "rhythm": rhythm}), encoding="utf-8")
            return genesis_policy.rhythm_policy(tmp)

    def test_the_shipped_defaults_are_in_bounds_and_in_the_policy_data(self) -> None:
        shipped = genesis_policy.default_policy()["rhythm"]
        for key in ("backlog_cap", "closure_slo_window_days", "opener_throttle_interval_hours",
                    "operator_escalation_age_days"):
            with self.subTest(key=key):
                self.assertEqual(shipped[key], genesis_policy.RHYTHM_DEFAULTS[key])
                self.assertIn(key, genesis_policy.RHYTHM_BOUNDS)
        self.assertEqual(genesis_policy.rhythm_policy()["opener_throttle_interval_hours"], 24.0)

    def test_an_override_inside_the_bounds_is_read(self) -> None:
        self.assertEqual(self._policy(closure_slo_window_days=14)["closure_slo_window_days"], 14)

    def test_out_of_bounds_or_mistyped_values_are_refused_by_name(self) -> None:
        for key, value in (("backlog_cap", 0), ("backlog_cap", 2.5), ("backlog_cap", True),
                           ("closure_slo_window_days", 91), ("opener_throttle_interval_hours", 0.5),
                           ("operator_escalation_age_days", "14"), ("min_interval_hours", 1.0)):
            with self.subTest(key=key, value=value):
                with self.assertRaisesRegex(GovernanceError, f"rhythm.{key}="):
                    self._policy(**{key: value})


if __name__ == "__main__":
    unittest.main()
