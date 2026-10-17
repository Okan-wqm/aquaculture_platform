"""Architecture spine gate (Plan 019 Phase 5.5; ARIA-HIGH-045, ARIA-HIGH-525, ARIA-MEDIUM-526).

What this suite pins:
- An invariant is the VIOLATION SET of the adapter that owns its rule, by
  location-free identity. Counts are never compared: a swap of one violation
  for another is one regression plus one improvement (ARIA-HIGH-045), and a
  total (declared events, entities, observations) is not a measurement at all
  (ARIA-MEDIUM-526).
- The gate reads the run the refresh produced, from the TOOLS ROOT it was
  given, never ``<workspace>/aria-tools/runs.jsonl`` (ARIA-HIGH-525: production
  keeps its store outside the workspace, so the auth and harness invariants
  were a pending stub on both sides and silently clean).
- What the gate cannot measure is ``unmeasured`` and fails closed
  (``architecture_spine_unmeasured``, the plan's comparison unavailable); a
  quarantined owner is ``excluded`` and named.
- A cycle baseline retained from the pre-identity contract is superseded,
  carrying the regressions it held.

The integration cases run the REAL tool runner through
``tests/_helpers/spine_fixture.py``: each spine adapter is a fake tool that
reports the findings the test wrote into the workspace, and the tools root sits
beside the workspace, not inside it, as in production.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel import architecture_spine_gate as gate
from aria_kernel import spine_orchestrator
from aria_kernel.architecture_spine_gate import (
    DEFAULT_MAX_REGRESSION_ROUNDS,
    INVARIANT_KINDS,
    InvariantMeasurement,
    list_spine_events,
    take_baseline,
    take_postcheck,
)
from aria_kernel.ledger import LEDGER_ROW_MAX_BYTES, load_jsonl
from aria_kernel.quarantine import quarantine_tool
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir, utc_now
from aria_kernel.tool_runner import run_tool
from tests._helpers.git_fixtures import commit_files, make_local_git_repo
from tests._helpers.spine_fixture import SPINE_FIXTURE_VERSION, SpineFixture

TENANT = "tenant-scoping-adapter"
EVENTS = "event-contracts-adapter"
ENTITY = "typeorm-entity-schema-adapter"
AUTH = "security-boundary-adapter"
HARNESS = "agent-harness-security-adapter"


def _finding(path: str, symbol: str, *, rule: str = "tenant_unscoped_repository_call", line: int = 1,
             finding_id: str | None = None, **extra: Any) -> dict[str, Any]:
    """One adapter finding about ``symbol`` in ``path``, seen at ``line``."""
    return {
        "id": finding_id or f"{path}:{line}",
        "rule": rule,
        "path": path,
        "line": line,
        "severity": "high",
        "message": f"{symbol} reads a repository without tenant scope",
        "details": {"enclosingSymbol": symbol},
        "evidence": [{"path": path, "line": line}],
        **extra,
    }


def _measured(invariant: str, identities: list[str], *, source: str | None = None) -> InvariantMeasurement:
    return InvariantMeasurement(
        invariant=invariant, measured_at=utc_now(),
        measurements={"violation_count": len(identities), "violation_identities": sorted(identities)},
        source=source or f"fixture:{invariant}",
    )


def _checks(**identities: list[str]) -> dict:
    """Synthetic checks: every invariant measured, ``identities`` overriding the empty set."""
    return {
        kind: (lambda _root, _kind=kind: _measured(_kind, identities.get(_kind, [])))
        for kind in INVARIANT_KINDS
    }


def _identities(details: dict[str, Any], invariant: str, *, side: str) -> list[str]:
    block = details["invariant_measurements" if side == "baseline" else "postcheck_measurements"][invariant]
    return block["measurements"]["violation_identities"]


class FrameworkShapeTests(unittest.TestCase):
    def test_invariant_kinds_derive_from_the_one_declaration(self) -> None:
        self.assertEqual(INVARIANT_KINDS, (
            "tenant_scoping", "event_contracts", "schema_entity", "auth_security", "harness_security",
        ))
        self.assertEqual(INVARIANT_KINDS, tuple(spec.kind for spec in gate.SPINE_INVARIANTS))
        self.assertEqual(gate.SPINE_ADAPTER_IDS, (TENANT, EVENTS, ENTITY, AUTH, HARNESS))

    def test_default_max_regression_rounds_is_5(self) -> None:
        self.assertEqual(DEFAULT_MAX_REGRESSION_ROUNDS, 5)

    def test_the_gate_holds_no_rule_of_its_own(self) -> None:
        # ARIA-HIGH-045 / ARIA-MEDIUM-526 — the static producers were second
        # copies of rules their adapters own (and the event one matched
        # schemas/**/*.json stems where the catalogs are .schema.ts).
        for name in ("_check_tenant_scoping", "_check_event_contracts", "_check_schema_entity",
                     "_check_auth_security", "_check_harness_security", "DEFAULT_INVARIANT_CHECKS",
                     "detect_drift", "_GET_REPOSITORY_RE", "_SHARED_SCHEMA_TABLES"):
            self.assertFalse(hasattr(gate, name), name)


class MeasurementShapeTests(unittest.TestCase):
    """Test 17 — the old count-only shape cannot be built (tier 1)."""

    def test_measured_measurement_without_identities_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "spine_measurement_without_identities"):
            InvariantMeasurement(invariant="tenant_scoping", measured_at=utc_now(),
                                 measurements={"get_repository_callsite_count": 3}, source="fixture")

    def test_count_that_is_not_the_set_size_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "spine_measurement_count_mismatch"):
            InvariantMeasurement(invariant="tenant_scoping", measured_at=utc_now(),
                                 measurements={"violation_count": 2, "violation_identities": ["a"]},
                                 source="fixture")

    def test_unmeasured_and_excluded_name_their_reason(self) -> None:
        for coverage in ("unmeasured", "excluded"):
            with self.subTest(coverage=coverage):
                with self.assertRaisesRegex(GovernanceError, "spine_measurement_reason_required"):
                    InvariantMeasurement(invariant="auth_security", measured_at=utc_now(),
                                         measurements={}, source="fixture", coverage=coverage)
        with self.assertRaisesRegex(GovernanceError, "spine_measurement_coverage_unknown"):
            InvariantMeasurement(invariant="auth_security", measured_at=utc_now(), measurements={},
                                 source="fixture", coverage="pending", coverage_reason="stub")


class CompareSpineMeasurementsTests(unittest.TestCase):
    """compare_spine_measurements over stored blocks, no runs."""

    @staticmethod
    def _blocks(**overrides: InvariantMeasurement) -> dict[str, dict[str, Any]]:
        measurements = [overrides.get(kind) or _measured(kind, []) for kind in INVARIANT_KINDS]
        return gate._measurements_to_dict(measurements)

    def test_identity_swap_at_equal_count_is_one_regression_and_one_improvement(self) -> None:
        comparison = gate.compare_spine_measurements(
            baseline=self._blocks(tenant_scoping=_measured("tenant_scoping", ["a", "b", "c"])),
            postcheck=self._blocks(tenant_scoping=_measured("tenant_scoping", ["a", "b", "d"])),
        )
        self.assertEqual([(d.invariant, d.field, d.direction, d.baseline_value, d.postcheck_value)
                          for d in comparison.drifts], [
            ("tenant_scoping", "violation_identities", "improvement", ["c"], []),
            ("tenant_scoping", "violation_identities", "regression", [], ["d"]),
        ])
        self.assertEqual(comparison.unmeasured, ())

    def test_fix_two_break_one_names_the_introduced_violation(self) -> None:
        comparison = gate.compare_spine_measurements(
            baseline=self._blocks(tenant_scoping=_measured("tenant_scoping", ["a", "b", "c"])),
            postcheck=self._blocks(tenant_scoping=_measured("tenant_scoping", ["a", "d"])),
        )
        regressions = [d for d in comparison.drifts if d.direction == "regression"]
        self.assertEqual([d.postcheck_value for d in regressions], [["d"]])

    def test_unchanged_sets_are_no_drift(self) -> None:
        blocks = self._blocks(auth_security=_measured("auth_security", ["x"]))
        comparison = gate.compare_spine_measurements(baseline=blocks, postcheck=blocks)
        self.assertEqual((comparison.drifts, comparison.unmeasured, comparison.excluded), ((), (), ()))

    def test_excluded_and_unmeasured_are_named_and_never_compared(self) -> None:
        quarantined = InvariantMeasurement(invariant="harness_security", measured_at=utc_now(), measurements={},
                                           source="adapter:x", coverage="excluded", coverage_reason="tool_quarantined")
        failed = InvariantMeasurement(invariant="auth_security", measured_at=utc_now(), measurements={},
                                      source="adapter:y", coverage="unmeasured",
                                      coverage_reason="adapter_run_status:crash")
        comparison = gate.compare_spine_measurements(
            baseline=self._blocks(harness_security=quarantined),
            postcheck=self._blocks(harness_security=_measured("harness_security", ["new"]), auth_security=failed),
        )
        self.assertEqual(comparison.drifts, ())
        self.assertEqual(comparison.excluded, ({"invariant": "harness_security", "reason": "tool_quarantined"},))
        self.assertEqual(comparison.unmeasured, (
            {"invariant": "auth_security", "reason": "postcheck:adapter_run_status:crash"},
        ))

    def test_quarantine_since_the_baseline_is_unmeasured_not_a_pass(self) -> None:
        quarantined = InvariantMeasurement(invariant="tenant_scoping", measured_at=utc_now(), measurements={},
                                           source="adapter:x", coverage="excluded", coverage_reason="tool_quarantined")
        comparison = gate.compare_spine_measurements(
            baseline=self._blocks(tenant_scoping=_measured("tenant_scoping", ["a"])),
            postcheck=self._blocks(tenant_scoping=quarantined),
        )
        self.assertEqual(comparison.unmeasured, (
            {"invariant": "tenant_scoping", "reason": "tool_quarantined_since_baseline"},
        ))

    def test_a_changed_producer_is_unmeasured(self) -> None:
        comparison = gate.compare_spine_measurements(
            baseline=self._blocks(schema_entity=_measured("schema_entity", ["a"], source="adapter:e@1.0.0")),
            postcheck=self._blocks(schema_entity=_measured("schema_entity", ["b"], source="adapter:e@1.1.0")),
        )
        self.assertEqual(comparison.drifts, ())
        self.assertEqual(comparison.unmeasured, ({"invariant": "schema_entity", "reason": "producer_changed"},))

    def test_a_pre_identity_baseline_block_is_unmeasured(self) -> None:
        # ARIA-MEDIUM-526 — the v1 blocks compared totals as violations; a
        # v1 block is no observation of a violation set.
        baseline = self._blocks()
        baseline["event_contracts"] = {
            "invariant": "event_contracts", "measured_at": utc_now(), "source": "static:_check_event_contracts",
            "measurements": {"declared_event_count": 243, "missing_schema_count": 243},
        }
        comparison = gate.compare_spine_measurements(baseline=baseline, postcheck=self._blocks())
        self.assertEqual(comparison.drifts, ())
        self.assertEqual(comparison.unmeasured, ({"invariant": "event_contracts", "reason": "baseline_pre_v2"},))


class SyntheticLifecycleTests(unittest.TestCase):
    """take_baseline / take_postcheck over synthetic checks (no runs)."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo = Path(tmp.name) / "repo"
        self.repo.mkdir()
        self.tools = ensure_tools_dir(Path(tmp.name) / "aria-tools")

    def _baseline(self, plan: str, **identities: list[str]) -> dict:
        return take_baseline(plan_id=plan, cycle_id="cyc-base", workspace_root=self.repo,
                             base_dir=self.tools, invariant_checks=_checks(**identities))

    def _postcheck(self, plan: str, cycle: str, checks: dict) -> dict:
        return take_postcheck(plan_id=plan, cycle_id=cycle, workspace_root=self.repo,
                              base_dir=self.tools, invariant_checks=checks)

    def _kinds(self) -> list[str]:
        return [row["kind"] for row in load_jsonl(self.tools / "governance.jsonl")]

    @staticmethod
    def _unmeasured_auth() -> dict:
        checks = _checks()
        checks["auth_security"] = lambda _root: InvariantMeasurement(
            invariant="auth_security", measured_at=utc_now(), measurements={}, source="fixture:auth_security",
            coverage="unmeasured", coverage_reason="adapter_run_status:crash",
        )
        return checks

    def test_baseline_carries_every_invariant_and_the_contract(self) -> None:
        result = self._baseline("plan-shape")
        self.assertEqual(set(result["invariant_measurements"]), set(INVARIANT_KINDS))
        self.assertEqual(result["spine_contract"], gate.SPINE_CONTRACT)
        self.assertIn("architecture_spine_baseline", self._kinds())

    def test_empty_plan_id_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "plan_id is required"):
            self._baseline("")

    def test_postcheck_without_baseline_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "no baseline recorded"):
            self._postcheck("plan-none", "cyc-1", _checks())

    def test_clean_and_regression_postchecks(self) -> None:
        self._baseline("plan-a", tenant_scoping=["a"])
        clean = self._postcheck("plan-a", "cyc-clean", _checks(tenant_scoping=["a"]))
        self.assertEqual((clean["regression_count"], clean["drifts"]), (0, []))
        regressed = self._postcheck("plan-a", "cyc-reg", _checks(tenant_scoping=["b"]))
        self.assertEqual(regressed["regression_count"], 1)
        self.assertEqual(self._kinds()[-2:], ["architecture_spine_postcheck", "architecture_spine_regression"])

    def test_5_consecutive_regressions_emit_human_required(self) -> None:
        self._baseline("plan-5")
        for number in range(5):
            self._postcheck("plan-5", f"cyc-{number}", _checks(tenant_scoping=[f"v{number}"]))
        self.assertEqual(self._kinds().count("architecture_spine_regression"), 5)
        self.assertIn("human_required_recorded", self._kinds())

    def test_clean_postcheck_resets_regression_streak(self) -> None:
        self._baseline("plan-mixed")
        for number in range(3):
            self._postcheck("plan-mixed", f"reg-{number}", _checks(tenant_scoping=["v"]))
        self._postcheck("plan-mixed", "clean", _checks())
        for number in range(4):
            self._postcheck("plan-mixed", f"reg2-{number}", _checks(tenant_scoping=["v"]))
        self.assertEqual(self._kinds().count("architecture_spine_regression"), 7)
        self.assertNotIn("human_required_recorded", self._kinds())

    def test_unmeasured_postcheck_is_its_own_kind_and_the_plan_comparison_unavailable(self) -> None:
        self._baseline("plan-u")
        result = self._postcheck("plan-u", "cyc-u", self._unmeasured_auth())
        self.assertEqual(self._kinds()[-1], "architecture_spine_unmeasured")
        self.assertEqual(result["unmeasured_invariants"],
                         [{"invariant": "auth_security", "reason": "postcheck:adapter_run_status:crash"}])
        obligation = gate._plan_comparison_obligation(self.tools, "plan-u")
        self.assertEqual((obligation["status"], obligation["reason"]), ("unavailable", "invariant_unmeasured"))
        self.assertEqual(obligation["unmeasured_invariants"], result["unmeasured_invariants"])
        self.assertEqual([row["kind"] for row in list_spine_events(plan_id="plan-u", base_dir=self.tools)],
                         ["architecture_spine_baseline", "architecture_spine_unmeasured"])

    def test_unmeasured_row_neither_counts_nor_resets_streak(self) -> None:
        self._baseline("plan-streak")
        for number in range(4):
            self._postcheck("plan-streak", f"reg-{number}", _checks(tenant_scoping=["v"]))
            self._postcheck("plan-streak", f"unm-{number}", self._unmeasured_auth())
        self.assertNotIn("human_required_recorded", self._kinds())
        fifth = self._postcheck("plan-streak", "reg-4", _checks(tenant_scoping=["v"]))
        self.assertEqual(fifth["round_count"], 5, "the unmeasured rows did not reset the streak")
        self.assertIn("human_required_recorded", self._kinds())

    def test_retention_skips_unmeasured_rows(self) -> None:
        baseline = self._baseline("plan-keep")
        self._postcheck("plan-keep", "cyc-reg", _checks(tenant_scoping=["v"]))
        self._postcheck("plan-keep", "cyc-unm", self._unmeasured_auth())
        retained = gate._take_cycle_baseline(plan_id="plan-keep", cycle_id="cyc-next",
                                             workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(retained["baseline_hash"], baseline["baseline_hash"])
        self.assertEqual(retained["baseline_reuse"]["reason"], "unresolved_regression")
        self.assertEqual(retained["baseline_reuse"]["previous_postcheck_cycle_id"], "cyc-reg")

    def test_identity_budget_fits_the_row_cap_and_an_over_budget_set_is_unmeasured(self) -> None:
        # Two blocks per invariant (baseline + postcheck) at the budget still
        # leave a row inside the ledger's cap.
        self.assertLess(2 * len(INVARIANT_KINDS) * gate.SPINE_IDENTITY_BUDGET_BYTES + 64 * 1024,
                        LEDGER_ROW_MAX_BYTES)
        too_many = [f"apps/x/f{n:06d}.ts::rule::{n:012x}#0" for n in range(3000)]
        self.assertGreater(len(json.dumps(too_many)), gate.SPINE_IDENTITY_BUDGET_BYTES)
        self.assertEqual(gate._identity_budget_issue(too_many), "identity_set_over_budget")
        self.assertIsNone(gate._identity_budget_issue(too_many[:10]))

    def test_retained_pre_identity_baseline_is_superseded_with_its_regressions(self) -> None:
        # ARIA-HIGH-045 D7 — a plan whose retained baseline is the count-only
        # contract gets a fresh baseline that names what it supersedes.
        v1_measurements = {kind: {"invariant": kind, "measured_at": utc_now(), "source": f"static:{kind}",
                                  "measurements": {"count": 1}} for kind in INVARIANT_KINDS}
        append_tools_governance(self.tools, "architecture_spine_baseline", {
            "plan_id": "plan-v1", "cycle_id": "cyc-v1", "baseline_hash": "sha256:00000000000000v1",
            "invariant_measurements": v1_measurements, "fresh_adapter_runs_required": True,
        })
        v1_regression = {"invariant": "event_contracts", "field": "declared_event_count",
                         "baseline_value": 243, "postcheck_value": 244, "direction": "regression"}
        append_tools_governance(self.tools, "architecture_spine_regression", {
            "plan_id": "plan-v1", "cycle_id": "cyc-v1", "baseline_hash": "sha256:00000000000000v1",
            "postcheck_measurements": v1_measurements, "drift_count": 1, "regression_count": 1,
            "drifts": [v1_regression],
        })
        with patch.object(gate, "_default_invariant_checks", return_value=_checks()):
            fresh = gate._take_cycle_baseline(plan_id="plan-v1", cycle_id="cyc-v2",
                                              workspace_root=self.repo, base_dir=self.tools)
        self.assertNotEqual(fresh["baseline_hash"], "sha256:00000000000000v1")
        self.assertEqual(fresh["spine_contract"], gate.SPINE_CONTRACT)
        self.assertEqual(fresh["supersedes"], {
            "baseline_hash": "sha256:00000000000000v1", "spine_contract": None,
            "unresolved_regressions": [v1_regression],
        })
        # Until a v2 verdict exists, the next cycle reuses the superseding
        # baseline instead of refusing a "replaced anchor".
        again = gate._take_cycle_baseline(plan_id="plan-v1", cycle_id="cyc-v2b",
                                          workspace_root=self.repo, base_dir=self.tools)
        self.assertEqual(again["baseline_hash"], fresh["baseline_hash"])
        self.assertEqual(again["baseline_reuse"]["reason"], "superseded_pre_v2_regression")


class SpineIntegrationCase(unittest.TestCase):
    """Real runs: the five spine adapters as fake tools, the store beside the workspace."""

    FILES = {
        # Long enough that a finding can move to line 40 and still cite a real line.
        "src/orders.ts": "".join(f"export const orders{n} = {n};\n" for n in range(60)),
        "src/users.ts": "export const users = 1;\n",
        "src/stock.ts": "export const stock = 1;\n",
        "src/audit.ts": "export const audit = 1;\n",
        "apps/billing/src/invoice.entity.ts": "export class Invoice {}\n",
        "apps/billing/src/payment.entity.ts": "export class Payment {}\n",
    }

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        commit_files(self.workspace, dict(self.FILES))
        # ARIA-HIGH-525 — the store is NOT <workspace>/aria-tools.
        self.tools = ensure_tools_dir(root / "aria-tools")
        self.assertFalse((self.workspace / "aria-tools").exists())
        self.spine = SpineFixture(self.workspace, self.tools)
        self.spine.register_clean()

    def _baseline(self, plan: str, cycle: str = "cyc-base") -> dict:
        return take_baseline(plan_id=plan, cycle_id=cycle, workspace_root=self.workspace, base_dir=self.tools)

    def _postcheck(self, plan: str, cycle: str = "cyc-post") -> dict:
        return take_postcheck(plan_id=plan, cycle_id=cycle, workspace_root=self.workspace, base_dir=self.tools)

    def _block(self, details: dict, invariant: str, *, side: str) -> dict:
        return details["invariant_measurements" if side == "baseline" else "postcheck_measurements"][invariant]


class AdapterSetIdentityTests(SpineIntegrationCase):
    def test_equal_count_tenant_swap_reports_one_regression_one_improvement(self) -> None:
        a, b, c, d = (_finding("src/orders.ts", "OrderService.list"), _finding("src/users.ts", "UserService.find"),
                      _finding("src/stock.ts", "StockService.read"), _finding("src/audit.ts", "AuditService.scan"))
        self.spine.set_findings(TENANT, [a, b, c], commit=True)
        baseline = self._baseline("plan-tenant-swap")
        self.spine.set_findings(TENANT, [a, b, d], commit=False)
        result = self._postcheck("plan-tenant-swap")
        self.assertEqual(result["regression_count"], 1, result["drifts"])
        regression = next(d for d in result["drifts"] if d["direction"] == "regression")
        improvement = next(d for d in result["drifts"] if d["direction"] == "improvement")
        self.assertEqual((regression["invariant"], regression["field"]), ("tenant_scoping", "violation_identities"))
        self.assertEqual(len(regression["postcheck_value"]), 1)
        self.assertTrue(regression["postcheck_value"][0].startswith("src/audit.ts::tenant_unscoped_repository_call::"))
        self.assertTrue(improvement["baseline_value"][0].startswith("src/stock.ts::"))
        self.assertEqual(len(_identities(baseline, "tenant_scoping", side="baseline")), 3)
        self.assertEqual(self._block(result, "tenant_scoping", side="postcheck")["measurements"]["violation_count"], 3)
        self.assertEqual([row["kind"] for row in list_spine_events(plan_id="plan-tenant-swap", base_dir=self.tools)],
                         ["architecture_spine_baseline", "architecture_spine_regression"])

    def test_fix_two_break_one_reports_the_introduced_violation(self) -> None:
        a, b, c, d = (_finding("src/orders.ts", "OrderService.list"), _finding("src/users.ts", "UserService.find"),
                      _finding("src/stock.ts", "StockService.read"), _finding("src/audit.ts", "AuditService.scan"))
        self.spine.set_findings(TENANT, [a, b, c], commit=True)
        self._baseline("plan-fix-two")
        self.spine.set_findings(TENANT, [a, d], commit=False)
        result = self._postcheck("plan-fix-two")
        self.assertEqual(result["regression_count"], 1, "the net improvement must not absorb the new violation")
        self.assertEqual(sorted(d["direction"] for d in result["drifts"]), ["improvement", "regression"])

    def test_equal_count_schema_swap_is_a_regression(self) -> None:
        rule = "entity_schema_missing"
        invoice = _finding("apps/billing/src/invoice.entity.ts", "Invoice", rule=rule)
        payment = _finding("apps/billing/src/payment.entity.ts", "Payment", rule=rule)
        self.spine.set_findings(ENTITY, [invoice], commit=True)
        self._baseline("plan-entity-swap")
        self.spine.set_findings(ENTITY, [payment], commit=False)
        result = self._postcheck("plan-entity-swap")
        self.assertEqual(result["regression_count"], 1)
        self.assertEqual({d["invariant"] for d in result["drifts"]}, {"schema_entity"})

    def test_moved_lines_and_an_identical_rerun_are_not_drift(self) -> None:
        a = _finding("src/orders.ts", "OrderService.list", line=3, finding_id="t-1")
        self.spine.set_findings(TENANT, [a], commit=True)
        baseline = self._baseline("plan-moved")
        identical = self._postcheck("plan-moved", "cyc-identical")
        self.assertEqual(identical["unmeasured_invariants"], [])
        self.assertEqual((identical["drift_count"], identical["regression_count"]), (0, 0))
        # Line, column, id and evidence all move; the subject does not.
        moved = _finding("src/orders.ts", "OrderService.list", line=40, finding_id="t-99", column=7,
                         confidence=0.4)
        self.spine.set_findings(TENANT, [moved], commit=False)
        result = self._postcheck("plan-moved", "cyc-moved")
        self.assertEqual(result["unmeasured_invariants"], [], "a moved finding is still a measured one")
        self.assertEqual((result["drift_count"], result["regression_count"]), (0, 0), result["drifts"])
        self.assertEqual(_identities(result, "tenant_scoping", side="postcheck"),
                         _identities(baseline, "tenant_scoping", side="baseline"))

    def test_totals_and_observations_are_not_compared(self) -> None:
        # ARIA-MEDIUM-526 — the event catalogs are .schema.ts; the old
        # producer matched .json stems, called every event missing, and
        # made a valid event addition a regression twice over.
        commit_files(self.workspace, {
            "libs/event-contracts/src/order-events.ts": (
                "export interface OrderPlacedEvent extends BaseEvent { orderId: string }\n"),
            "libs/event-contracts/src/schemas/order-events.schema.ts": "export const OrderPlacedSchema = {};\n",
        })
        baseline = self._baseline("plan-events")
        (self.workspace / "libs/event-contracts/src/order-events.ts").write_text(
            "export interface OrderPlacedEvent extends BaseEvent { orderId: string }\n"
            "export interface OrderShippedEvent extends BaseEvent { orderId: string }\n", encoding="utf-8")
        (self.workspace / "libs/event-contracts/src/schemas/order-events.schema.ts").write_text(
            "export const OrderPlacedSchema = {};\nexport const OrderShippedSchema = {};\n", encoding="utf-8")
        result = self._postcheck("plan-events")
        self.assertEqual((result["regression_count"], result["drifts"]), (0, []))
        for details, side in ((baseline, "baseline"), (result, "postcheck")):
            block = self._block(details, "event_contracts", side=side)
            self.assertEqual(block["measurements"], {"violation_count": 0, "violation_identities": []})
            self.assertEqual(block["source"], f"adapter:{EVENTS}@{SPINE_FIXTURE_VERSION}")

    def test_ok_run_with_zero_findings_is_an_observed_empty_set(self) -> None:
        baseline = self._baseline("plan-clean")
        for invariant, spec in zip(INVARIANT_KINDS, gate.SPINE_INVARIANTS):
            block = self._block(baseline, invariant, side="baseline")
            self.assertEqual(block["coverage"], "measured", block)
            self.assertEqual(block["measurements"], {"violation_count": 0, "violation_identities": []})
            self.assertEqual(block["source"], f"adapter:{spec.adapter_id}@{SPINE_FIXTURE_VERSION}")
            self.assertEqual(block["provenance"]["selection"], "refreshed")


class ToolsRootTests(SpineIntegrationCase):
    """ARIA-HIGH-525 — the gate measures the store it was given, the run the refresh produced."""

    def test_tools_root_outside_workspace_is_measured(self) -> None:
        self.spine.set_findings(AUTH, [_finding("src/users.ts", "AdminController.delete",
                                                 rule="public_write_endpoint")], commit=True)
        baseline = self._baseline("plan-auth")
        for invariant in ("auth_security", "harness_security"):
            block = self._block(baseline, invariant, side="baseline")
            self.assertEqual(block["coverage"], "measured", block)
        self.assertEqual(len(_identities(baseline, "auth_security", side="baseline")), 1)
        self.spine.set_findings(AUTH, [], commit=False)
        self.spine.set_findings(HARNESS, [_finding("src/audit.ts", "settings", rule="secret_in_prompt")],
                                commit=False)
        result = self._postcheck("plan-auth")
        self.assertEqual(sorted((d["invariant"], d["direction"]) for d in result["drifts"]), [
            ("auth_security", "improvement"), ("harness_security", "regression"),
        ])

    def test_postcheck_reads_the_refreshed_run_not_a_newer_unrelated_run(self) -> None:
        real_refresh = spine_orchestrator.refresh_spine_adapters
        refreshed: dict[str, Any] = {}

        def refresh_then_newer_run(**kwargs: Any) -> dict:
            result = real_refresh(**kwargs)
            refreshed.update(result)
            # Another caller records a NEWER tenant run over an edit the
            # refresh never measured; the gate must not pick it up.
            self.spine.set_findings(TENANT, [_finding("src/orders.ts", "OrderService.list")], commit=False)
            run_tool(TENANT, {"cycle_id": "other-caller"}, "other-caller",
                     workspace_root=self.workspace, base_dir=self.tools)
            self.spine.set_findings(TENANT, [], commit=False)
            return result

        with patch.object(spine_orchestrator, "refresh_spine_adapters", side_effect=refresh_then_newer_run):
            baseline = self._baseline("plan-refreshed")
        rows = [row for row in load_jsonl(self.tools / "runs.jsonl") if row.get("tool_id") == TENANT]
        self.assertEqual(rows[-1]["runner"]["raw_findings_count"], 1, "the newer row exists")
        block = self._block(baseline, "tenant_scoping", side="baseline")
        self.assertEqual(block["provenance"]["run_id"], refreshed["run_ids"][TENANT])
        self.assertEqual(block["measurements"], {"violation_count": 0, "violation_identities": []})

    def test_without_a_refresh_the_latest_recorded_run_of_the_tools_root_is_read(self) -> None:
        self.spine.set_findings(AUTH, [_finding("src/users.ts", "AdminController.delete",
                                                 rule="public_write_endpoint")], commit=True)
        spine_orchestrator.refresh_spine_adapters(base_dir=self.tools, workspace_root=self.workspace,
                                                  cycle_id="cyc-warm")
        baseline = take_baseline(plan_id="plan-cached", cycle_id="cyc-cached", workspace_root=self.workspace,
                                 base_dir=self.tools, require_fresh_adapter_runs=False)
        block = self._block(baseline, "auth_security", side="baseline")
        self.assertEqual(block["coverage"], "measured", block)
        self.assertEqual(block["provenance"]["selection"], "latest_recorded")
        self.assertEqual(block["measurements"]["violation_count"], 1)


class CoverageTests(SpineIntegrationCase):
    def test_failed_adapter_is_unmeasured_kind_and_obligation_unavailable(self) -> None:
        self._baseline("plan-failed")
        # A finding citing a file the snapshot does not hold: record_run
        # stores evidence_error, so there is no observed set.
        self.spine.set_findings(AUTH, [_finding("src/missing.ts", "Ghost.handler", rule="public_write_endpoint")],
                                commit=False)
        result = self._postcheck("plan-failed")
        self.assertEqual(result["regression_count"], 0)
        self.assertEqual(result["unmeasured_invariants"], [
            {"invariant": "auth_security", "reason": "postcheck:adapter_run_status:evidence_error"},
        ])
        self.assertEqual(list_spine_events(plan_id="plan-failed", base_dir=self.tools)[-1]["kind"],
                         "architecture_spine_unmeasured")
        obligation = gate._plan_comparison_obligation(self.tools, "plan-failed")
        self.assertEqual((obligation["status"], obligation["reason"]), ("unavailable", "invariant_unmeasured"))

    def test_quarantined_at_baseline_is_excluded_and_named(self) -> None:
        quarantine_tool(HARNESS, "fixture quarantine", base_dir=self.tools)
        baseline = self._baseline("plan-excluded")
        block = self._block(baseline, "harness_security", side="baseline")
        self.assertEqual((block["coverage"], block["coverage_reason"]), ("excluded", "tool_quarantined"))
        result = self._postcheck("plan-excluded")
        self.assertEqual(result["excluded_invariants"], [{"invariant": "harness_security", "reason": "tool_quarantined"}])
        self.assertEqual(list_spine_events(plan_id="plan-excluded", base_dir=self.tools)[-1]["kind"],
                         "architecture_spine_postcheck")
        obligation = gate._plan_comparison_obligation(self.tools, "plan-excluded")
        self.assertEqual(obligation["status"], "clean")
        self.assertEqual(obligation["excluded_invariants"], result["excluded_invariants"])

    def test_quarantined_since_baseline_is_unmeasured(self) -> None:
        self._baseline("plan-quarantined-later")
        quarantine_tool(TENANT, "fixture quarantine", base_dir=self.tools)
        result = self._postcheck("plan-quarantined-later")
        self.assertEqual(result["unmeasured_invariants"], [
            {"invariant": "tenant_scoping", "reason": "tool_quarantined_since_baseline"},
        ])


if __name__ == "__main__":
    unittest.main()
