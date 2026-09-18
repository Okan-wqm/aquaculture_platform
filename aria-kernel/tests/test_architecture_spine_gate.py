"""Tests for Plan 019 Phase 5.5 Architecture Spine Gate."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.architecture_spine_gate import (
    DEFAULT_MAX_REGRESSION_ROUNDS,
    INVARIANT_KINDS,
    DriftReport,
    InvariantMeasurement,
    detect_drift,
    list_spine_events,
    take_baseline,
    take_postcheck,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, utc_now


def _seed_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-spine-"))
    (repo / "aria-tools").mkdir(parents=True, exist_ok=True)
    ensure_tools_dir(repo / "aria-tools")
    return repo


def _fixture_check(invariant: str, measurements: dict) -> InvariantMeasurement:
    """Build an in-memory measurement so tests don't need a real repo walk."""
    return InvariantMeasurement(
        invariant=invariant,
        measured_at=utc_now(),
        measurements=measurements,
        source=f"fixture:{invariant}",
    )


class FrameworkShapeTests(unittest.TestCase):
    def test_invariant_kinds_is_five_strings(self) -> None:
        # Plan 020 Phase 10 — 5th invariant 'harness_security' added to
        # cover .claude/agents/** + .github/workflows/** + tools/aria-{poc,
        # adapters}/** + aria-kernel/aria_kernel/** secret/permission/
        # prompt-injection rules.
        self.assertEqual(len(INVARIANT_KINDS), 5)
        self.assertIn("harness_security", INVARIANT_KINDS)
        for inv in INVARIANT_KINDS:
            self.assertIsInstance(inv, str)
            self.assertTrue(inv)

    def test_default_max_regression_rounds_is_5(self) -> None:
        self.assertEqual(DEFAULT_MAX_REGRESSION_ROUNDS, 5)


class TakeBaselineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        self.checks = {
            "tenant_scoping": lambda root: _fixture_check("tenant_scoping", {"get_repository_callsite_count": 5}),
            "event_contracts": lambda root: _fixture_check("event_contracts", {"declared_event_count": 10, "missing_schema_count": 2}),
            "schema_entity": lambda root: _fixture_check("schema_entity", {"missing_schema_violation_count": 1, "total_entities": 50}),
            "auth_security": lambda root: _fixture_check("auth_security", {"pending": True}),
            # Plan 020 Phase 10 — 5th invariant.
            "harness_security": lambda root: _fixture_check("harness_security", {"pending": True}),
        }

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_baseline_carries_all_invariants(self) -> None:
        result = take_baseline(
            plan_id="plan-019-phase-5.5-test",
            cycle_id="cyc-1",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self.checks,
        )
        self.assertEqual(result["plan_id"], "plan-019-phase-5.5-test")
        self.assertIn("baseline_hash", result)
        self.assertEqual(set(result["invariant_measurements"].keys()), set(INVARIANT_KINDS))

    def test_baseline_emits_governance_event(self) -> None:
        take_baseline(
            plan_id="plan-X",
            cycle_id="cyc-1",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self.checks,
        )
        gov_lines = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = {json.loads(line).get("kind") for line in gov_lines if line.strip()}
        self.assertIn("architecture_spine_baseline", kinds)

    def test_empty_plan_id_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "plan_id is required"):
            take_baseline(
                plan_id="",
                cycle_id="cyc-1",
                workspace_root=self.repo,
                base_dir=self.tools,
                invariant_checks=self.checks,
            )


class DetectDriftTests(unittest.TestCase):
    def test_historical_or_one_sided_identities_keep_count_comparison(self) -> None:
        alpha = "libs/event-contracts/src/ordinary-events.ts::AlphaEvent"
        cases = (
            ("count-only increase", {"missing_schema_count": 1},
             {"missing_schema_count": 2}, "regression"),
            ("count-only decrease", {"missing_schema_count": 2},
             {"missing_schema_count": 1}, "improvement"),
            ("old baseline, observed empty postcheck", {"missing_schema_count": 1},
             {"missing_schema_count": 0, "missing_schema_identities": []}, "improvement"),
            ("observed empty baseline, old postcheck",
             {"missing_schema_count": 0, "missing_schema_identities": []},
             {"missing_schema_count": 1}, "regression"),
            ("old baseline, equal count", {"missing_schema_count": 1},
             {"missing_schema_count": 1, "missing_schema_identities": [alpha]}, None),
            ("old postcheck, equal count",
             {"missing_schema_count": 1, "missing_schema_identities": [alpha]},
             {"missing_schema_count": 1}, None),
        )
        for name, before, after, direction in cases:
            with self.subTest(case=name):
                result = detect_drift(
                    baseline_measurements={"event_contracts": {"measurements": before}},
                    postcheck_measurements={"event_contracts": {"measurements": after}},
                )
                expected = [] if direction is None else [DriftReport(
                    invariant="event_contracts", field="missing_schema_count",
                    baseline_value=before["missing_schema_count"],
                    postcheck_value=after["missing_schema_count"], direction=direction,
                )]
                self.assertEqual(result, expected)

    def test_no_drift_on_identical_measurements(self) -> None:
        baseline = {
            "tenant_scoping": {"measurements": {"count": 5}},
            "event_contracts": {"measurements": {"missing": 0}},
            "schema_entity": {"measurements": {"violations": 0}},
            "auth_security": {"measurements": {"pending": True}},
        }
        drifts = detect_drift(baseline_measurements=baseline, postcheck_measurements=baseline)
        self.assertEqual(drifts, [])

    def test_increase_classified_as_regression(self) -> None:
        baseline = {"tenant_scoping": {"measurements": {"count": 5}}}
        postcheck = {"tenant_scoping": {"measurements": {"count": 8}}}
        drifts = detect_drift(baseline_measurements=baseline, postcheck_measurements=postcheck)
        self.assertEqual(len(drifts), 1)
        self.assertEqual(drifts[0].direction, "regression")
        self.assertEqual(drifts[0].invariant, "tenant_scoping")

    def test_decrease_classified_as_improvement(self) -> None:
        baseline = {"tenant_scoping": {"measurements": {"count": 10}}}
        postcheck = {"tenant_scoping": {"measurements": {"count": 3}}}
        drifts = detect_drift(baseline_measurements=baseline, postcheck_measurements=postcheck)
        self.assertEqual(len(drifts), 1)
        self.assertEqual(drifts[0].direction, "improvement")

    def test_pending_to_pending_is_unchanged(self) -> None:
        # Phase 5.5 stub returns pending=True; Phase 6 will replace it.
        # A baseline taken under stub vs postcheck taken under stub must
        # NOT flag a regression — same value.
        baseline = {"auth_security": {"measurements": {"pending": True}}}
        postcheck = {"auth_security": {"measurements": {"pending": True}}}
        drifts = detect_drift(baseline_measurements=baseline, postcheck_measurements=postcheck)
        self.assertEqual(drifts, [])

    def test_multi_invariant_drift_collects_all(self) -> None:
        baseline = {
            "tenant_scoping": {"measurements": {"count": 5}},
            "event_contracts": {"measurements": {"missing": 0}},
        }
        postcheck = {
            "tenant_scoping": {"measurements": {"count": 8}},
            "event_contracts": {"measurements": {"missing": 2}},
        }
        drifts = detect_drift(baseline_measurements=baseline, postcheck_measurements=postcheck)
        self.assertEqual(len(drifts), 2)
        self.assertEqual({d.invariant for d in drifts}, {"tenant_scoping", "event_contracts"})


class TakePostcheckTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def _checks(self, *, count: int) -> dict:
        return {
            "tenant_scoping": lambda root: _fixture_check("tenant_scoping", {"count": count}),
            "event_contracts": lambda root: _fixture_check("event_contracts", {"missing": 0}),
            "schema_entity": lambda root: _fixture_check("schema_entity", {"violations": 0}),
            "auth_security": lambda root: _fixture_check("auth_security", {"pending": True}),
        }

    def test_postcheck_without_baseline_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "no baseline recorded"):
            take_postcheck(
                plan_id="plan-no-baseline",
                cycle_id="cyc-1",
                workspace_root=self.repo,
                base_dir=self.tools,
                invariant_checks=self._checks(count=5),
            )

    def test_clean_postcheck_emits_postcheck_event(self) -> None:
        take_baseline(
            plan_id="plan-clean",
            cycle_id="cyc-base",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self._checks(count=5),
        )
        result = take_postcheck(
            plan_id="plan-clean",
            cycle_id="cyc-post",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self._checks(count=5),  # identical → no drift
        )
        self.assertEqual(result["regression_count"], 0)
        gov_lines = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line).get("kind") for line in gov_lines if line.strip()]
        self.assertIn("architecture_spine_postcheck", kinds)
        self.assertNotIn("architecture_spine_regression", kinds)

    def test_regression_postcheck_emits_regression_event(self) -> None:
        take_baseline(
            plan_id="plan-regression",
            cycle_id="cyc-base",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self._checks(count=5),
        )
        result = take_postcheck(
            plan_id="plan-regression",
            cycle_id="cyc-post",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self._checks(count=10),  # 5 → 10 = regression
        )
        self.assertEqual(result["regression_count"], 1)
        gov_lines = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line).get("kind") for line in gov_lines if line.strip()]
        self.assertIn("architecture_spine_regression", kinds)

    def test_5_consecutive_regressions_emit_human_required(self) -> None:
        plan = "plan-5-rounds"
        take_baseline(
            plan_id=plan,
            cycle_id="cyc-base",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self._checks(count=5),
        )
        # 5 consecutive postchecks each showing regression
        for round_idx in range(5):
            take_postcheck(
                plan_id=plan,
                cycle_id=f"cyc-post-{round_idx}",
                workspace_root=self.repo,
                base_dir=self.tools,
                invariant_checks=self._checks(count=10 + round_idx),
            )
        gov_lines = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line).get("kind") for line in gov_lines if line.strip()]
        self.assertEqual(kinds.count("architecture_spine_regression"), 5)
        self.assertIn("human_required_recorded", kinds)

    def test_clean_postcheck_resets_regression_streak(self) -> None:
        plan = "plan-mixed"
        take_baseline(
            plan_id=plan,
            cycle_id="cyc-base",
            workspace_root=self.repo,
            base_dir=self.tools,
            invariant_checks=self._checks(count=5),
        )
        # 3 regressions
        for r in range(3):
            take_postcheck(
                plan_id=plan, cycle_id=f"reg-{r}",
                workspace_root=self.repo, base_dir=self.tools,
                invariant_checks=self._checks(count=10 + r),
            )
        # 1 clean postcheck — streak resets
        take_postcheck(
            plan_id=plan, cycle_id="clean-1",
            workspace_root=self.repo, base_dir=self.tools,
            invariant_checks=self._checks(count=5),
        )
        # 4 more regressions; only 4 in streak (NOT 7) so HUMAN_REQUIRED
        # should NOT fire.
        for r in range(4):
            take_postcheck(
                plan_id=plan, cycle_id=f"reg2-{r}",
                workspace_root=self.repo, base_dir=self.tools,
                invariant_checks=self._checks(count=20 + r),
            )
        gov_lines = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line).get("kind") for line in gov_lines if line.strip()]
        # 7 regression events total but the streak reset means
        # human_required_recorded did NOT fire.
        self.assertEqual(kinds.count("architecture_spine_regression"), 7)
        self.assertNotIn("human_required_recorded", kinds)


class ListSpineEventsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        # Two distinct plans produce events.
        for plan in ("plan-a", "plan-b"):
            take_baseline(
                plan_id=plan, cycle_id="cyc-1",
                workspace_root=self.repo, base_dir=self.tools,
                invariant_checks={
                    inv: (lambda root, _i=inv: _fixture_check(_i, {"count": 1}))
                    for inv in INVARIANT_KINDS
                },
            )

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_no_filter_returns_all_baseline_events(self) -> None:
        events = list_spine_events(base_dir=self.tools)
        self.assertEqual(len(events), 2)
        for ev in events:
            self.assertEqual(ev["kind"], "architecture_spine_baseline")

    def test_plan_id_filter_narrows(self) -> None:
        events = list_spine_events(plan_id="plan-a", base_dir=self.tools)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["details"]["plan_id"], "plan-a")


class DefaultChecksSmokeTests(unittest.TestCase):
    """Smoke tests for the default static checks against a synthetic repo."""

    def setUp(self) -> None:
        self.repo = _seed_repo()
        self.tools = self.repo / "aria-tools"
        # Seed a minimal repo structure for the static checks.
        (self.repo / "apps" / "foo-svc" / "src").mkdir(parents=True, exist_ok=True)
        (self.repo / "libs" / "event-contracts" / "src" / "schemas").mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_equal_count_schema_swap_reports_introduced_and_removed_event_identity(self) -> None:
        contracts = self.repo / "libs/event-contracts/src/ordinary-events.ts"
        declarations = (
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n"
            "export interface BetaEvent extends BaseEvent {}\n"
            "export interface GammaEvent extends BaseEvent {}\n"
        )
        contracts.write_text(declarations, encoding="utf-8")
        schemas = contracts.parent / "schemas"
        beta_schema = schemas / "beta_event.json"
        beta_schema.write_text('{"type":"object"}\n', encoding="utf-8")
        plan_id = "ordinary-event-schema-swap"
        baseline = take_baseline(
            plan_id=plan_id, cycle_id="schema-before",
            workspace_root=self.repo, base_dir=self.tools,
            require_fresh_adapter_runs=False,
        )
        before = baseline["invariant_measurements"]["event_contracts"]
        self.assertEqual(before["source"], "static:_check_event_contracts")
        self.assertEqual(before["measurements"]["declared_event_count"], 3)
        self.assertEqual(before["measurements"]["missing_schema_count"], 2)
        recorded_before = list_spine_events(plan_id=plan_id, base_dir=self.tools)
        self.assertEqual(len(recorded_before), 1)
        self.assertEqual(recorded_before[0]["kind"], "architecture_spine_baseline")
        self.assertEqual(recorded_before[0]["details"], baseline)

        # An ordinary edit fixes Alpha's missing schema and removes Beta's.
        # Gamma remains missing; moving its line must not make it a new issue.
        (schemas / "alpha_event.json").write_text('{"type":"object"}\n', encoding="utf-8")
        beta_schema.unlink()
        contracts.write_text("\n" + declarations, encoding="utf-8")
        result = take_postcheck(
            plan_id=plan_id, cycle_id="schema-after",
            workspace_root=self.repo, base_dir=self.tools,
            require_fresh_adapter_runs=False,
        )
        after = result["postcheck_measurements"]["event_contracts"]
        self.assertEqual(after["source"], "static:_check_event_contracts")
        self.assertEqual(after["measurements"]["declared_event_count"], 3)
        self.assertEqual(after["measurements"]["missing_schema_count"], 2)
        self.assertEqual(result["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(
            result["regression_count"], 1,
            "Beta's newly missing schema must remain a regression when Alpha is fixed.",
        )
        self.assertEqual(result["drift_count"], 2)
        identity_prefix = "libs/event-contracts/src/ordinary-events.ts::"
        self.assertEqual(before["measurements"]["missing_schema_identities"], [
            identity_prefix + "AlphaEvent", identity_prefix + "GammaEvent",
        ])
        self.assertEqual(after["measurements"]["missing_schema_identities"], [
            identity_prefix + "BetaEvent", identity_prefix + "GammaEvent",
        ])
        self.assertEqual(sorted(result["drifts"], key=lambda row: row["direction"]), [
            {
                "invariant": "event_contracts", "field": "missing_schema_identities",
                "baseline_value": [identity_prefix + "AlphaEvent"], "postcheck_value": [],
                "direction": "improvement",
            },
            {
                "invariant": "event_contracts", "field": "missing_schema_identities",
                "baseline_value": [], "postcheck_value": [identity_prefix + "BetaEvent"],
                "direction": "regression",
            },
        ])
        recorded_after = list_spine_events(plan_id=plan_id, base_dir=self.tools)
        self.assertEqual([row["kind"] for row in recorded_after], [
            "architecture_spine_baseline", "architecture_spine_regression",
        ])
        self.assertEqual(recorded_after[0]["details"], baseline)
        self.assertEqual(recorded_after[1]["details"], result)

    def test_observed_empty_then_missing_schema_reports_one_identity_regression(self) -> None:
        contracts = self.repo / "libs/event-contracts/src/ordinary-events.ts"
        contracts.write_text(
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n",
            encoding="utf-8",
        )
        schema = contracts.parent / "schemas" / "alpha_event.json"
        schema.write_text('{"type":"object"}\n', encoding="utf-8")
        plan_id = "ordinary-empty-to-missing-schema"
        baseline = take_baseline(
            plan_id=plan_id, cycle_id="schema-present",
            workspace_root=self.repo, base_dir=self.tools,
            require_fresh_adapter_runs=False,
        )
        before = baseline["invariant_measurements"]["event_contracts"]
        self.assertEqual(before["source"], "static:_check_event_contracts")
        self.assertEqual(before["measurements"], {
            "declared_event_count": 1, "missing_schema_count": 0,
            "missing_schema_identities": [],
        })
        schema.unlink()
        result = take_postcheck(
            plan_id=plan_id, cycle_id="schema-removed",
            workspace_root=self.repo, base_dir=self.tools,
            require_fresh_adapter_runs=False,
        )
        identity = "libs/event-contracts/src/ordinary-events.ts::AlphaEvent"
        self.assertEqual(result["postcheck_measurements"]["event_contracts"]["measurements"], {
            "declared_event_count": 1, "missing_schema_count": 1,
            "missing_schema_identities": [identity],
        })
        self.assertEqual(result["regression_count"], 1)
        self.assertEqual(result["drift_count"], 1)
        self.assertEqual(result["drifts"], [{
            "invariant": "event_contracts", "field": "missing_schema_identities",
            "baseline_value": [], "postcheck_value": [identity], "direction": "regression",
        }])
        rows = list_spine_events(plan_id=plan_id, base_dir=self.tools)
        self.assertEqual([row["kind"] for row in rows], [
            "architecture_spine_baseline", "architecture_spine_regression",
        ])
        self.assertEqual(rows[0]["details"], baseline)
        self.assertEqual(rows[1]["details"], result)
        self.assertEqual(result["baseline_hash"], baseline["baseline_hash"])

    def test_restored_schema_reports_only_identity_improvement(self) -> None:
        contracts = self.repo / "libs/event-contracts/src/ordinary-events.ts"
        contracts.write_text(
            "interface BaseEvent { eventId: string; }\n"
            "export interface AlphaEvent extends BaseEvent {}\n",
            encoding="utf-8",
        )
        plan_id = "ordinary-missing-to-restored-schema"
        baseline = take_baseline(
            plan_id=plan_id, cycle_id="schema-absent",
            workspace_root=self.repo, base_dir=self.tools,
            require_fresh_adapter_runs=False,
        )
        identity = "libs/event-contracts/src/ordinary-events.ts::AlphaEvent"
        before = baseline["invariant_measurements"]["event_contracts"]
        self.assertEqual(before["source"], "static:_check_event_contracts")
        self.assertEqual(before["measurements"], {
            "declared_event_count": 1, "missing_schema_count": 1,
            "missing_schema_identities": [identity],
        })
        (contracts.parent / "schemas" / "alpha_event.json").write_text(
            '{"type":"object"}\n', encoding="utf-8",
        )
        result = take_postcheck(
            plan_id=plan_id, cycle_id="schema-restored",
            workspace_root=self.repo, base_dir=self.tools,
            require_fresh_adapter_runs=False,
        )
        self.assertEqual(result["postcheck_measurements"]["event_contracts"]["measurements"], {
            "declared_event_count": 1, "missing_schema_count": 0,
            "missing_schema_identities": [],
        })
        self.assertEqual(result["regression_count"], 0)
        self.assertEqual(result["drift_count"], 1)
        self.assertEqual(result["drifts"], [{
            "invariant": "event_contracts", "field": "missing_schema_identities",
            "baseline_value": [identity], "postcheck_value": [], "direction": "improvement",
        }])
        rows = list_spine_events(plan_id=plan_id, base_dir=self.tools)
        self.assertEqual([row["kind"] for row in rows], [
            "architecture_spine_baseline", "architecture_spine_postcheck",
        ])
        self.assertEqual(rows[0]["details"], baseline)
        self.assertEqual(rows[1]["details"], result)
        self.assertEqual(result["baseline_hash"], baseline["baseline_hash"])

    def test_default_baseline_runs_against_synthetic_repo(self) -> None:
        # No fixtures: use the DEFAULT_INVARIANT_CHECKS path.
        result = take_baseline(
            plan_id="default-checks-smoke",
            cycle_id="cyc-1",
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        # Each invariant block exists; the synthetic empty repo produces
        # zero counts (or pending sentinel for auth_security).
        for inv in INVARIANT_KINDS:
            self.assertIn(inv, result["invariant_measurements"])
        ts_block = result["invariant_measurements"]["tenant_scoping"]["measurements"]
        self.assertEqual(ts_block.get("get_repository_callsite_count"), 0)

    def test_auth_security_pending_when_no_adapter_runs(self) -> None:
        # Plan 019 Phase 6.C — _check_auth_security reads the latest
        # security-boundary-adapter run from runs.jsonl. With no run on
        # disk (synthetic repo), the check returns pending=True with a
        # 'no security-boundary-adapter run' reason.
        result = take_baseline(
            plan_id="auth-pending-smoke",
            cycle_id="cyc-1",
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        auth_block = result["invariant_measurements"]["auth_security"]["measurements"]
        self.assertTrue(auth_block.get("pending"))
        self.assertIn("reason", auth_block)

    def test_auth_security_reads_latest_adapter_run(self) -> None:
        # Plan 019 Phase 6.C — when runs.jsonl carries a
        # security-boundary-adapter row, _check_auth_security must
        # surface its raw_observations + raw_findings counts as
        # invariant measurements.
        runs = self.tools / "runs.jsonl"
        runs.write_text(json.dumps({
            "tool_id": "security-boundary-adapter",
            "status": "ok",
            "recorded_at": "2026-05-07T16:00:00+00:00",
            "run_id": "run-test-1",
            "runner": {
                "exit_code": 0,
                "raw_observations_count": 1710,
                "raw_findings_count": 14,
            },
        }) + "\n", encoding="utf-8")
        result = take_baseline(
            plan_id="auth-real-smoke",
            cycle_id="cyc-1",
            workspace_root=self.repo,
            base_dir=self.tools,
        )
        auth_block = result["invariant_measurements"]["auth_security"]["measurements"]
        self.assertNotIn("pending", auth_block)
        self.assertEqual(auth_block["raw_observations_count"], 1710)
        self.assertEqual(auth_block["raw_findings_count"], 14)
        self.assertEqual(auth_block["adapter_run_id"], "run-test-1")


if __name__ == "__main__":
    unittest.main()
