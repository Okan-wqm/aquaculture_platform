"""PV R9 — the replay fixture's generator keeps what the replay reads, cuts the rest, and refuses sensitive text.

``tests/test_plan_verdict_replay.py`` replays a committed fixture; this module
holds the script that writes it (``tests/_helpers/plan_verdict_replay_fixture.py``)
to the same standard, over a small recorded-shape ledger: the CI run never
touches ``origin/aria/state``, so without these the regeneration path would be
code nothing executes.
"""
from __future__ import annotations

import json
import unittest
from typing import Any

from tests._helpers import plan_verdict_replay_fixture as generator

CUT = "CUT-ME"  # a value in every field the replay does not read: it must not survive
CHAIN = "sha256:" + "a" * 64


def _raw(number: int, plan_id: str, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_id": f"event-{number}", "event_type": event_type, "idempotency_key": CUT, "ledger_hash": CUT,
        "payload": payload, "plan_id": plan_id, "previous_ledger_hash": CUT,
        "recorded_at": "2026-10-07T00:00:00+00:00", "schema_version": 1,
    }


def _risk(risk_id: str, severity: str, summary: str) -> dict[str, Any]:
    return {
        "risk_id": risk_id, "severity": severity, "summary": summary, "recommendation": CUT,
        "affected_files": [CUT], "evidence_refs": [CUT], "risk_category": CUT, "applies_to_direction": CUT,
    }


def _task(direction: str, number: int) -> dict[str, Any]:
    return {
        "review_direction": direction, "status_after": "PENDING", "task_id": f"task-{number}",
        "task_packet_hash": f"sha256:{number:064x}", "reviewer_agent": CUT, "target_agent": CUT,
        "sla_deadline": CUT, "target_revision_id": CUT, "target_plan_content_hash": CUT,
    }


def _review(direction: str, number: int, revision: str, risks: list[dict[str, Any]], verdict: str) -> dict[str, Any]:
    return {
        "agent_invocation_request_id": CUT, "review_content_hash": CHAIN, "review_direction": direction,
        "reviewer_agent": CUT, "risks": risks, "status_after": "ANSWERED", "target_plan_content_hash": CHAIN,
        "target_revision_id": revision, "task_packet_hash": f"sha256:{number:064x}", "verdict": verdict,
    }


def _coverage(round_number: int, revision: str) -> dict[str, Any]:
    return {
        "closure_manifest_hash": CUT, "closure_manifest_path": CUT, "closure_summary": {"projects": 0},
        "computed_at_sha": CUT, "round_number": round_number, "synthetic_risks": [],
        "target_plan_content_hash": CHAIN, "target_revision_id": revision, "uncovered": [], "verdict": "covered",
        "waived": [], "witness": {"tool": CUT},
    }


def _ledger(extra_events: tuple[dict[str, Any], ...] = (), summary: str = "the first objection") -> str:
    """One plan that converged in round 2 under the old law, one that did not, and the tail an implementation writes."""
    plan, other = "plan-a", "plan-b"
    revision_body = json.dumps({"title": CUT, "key_changes": [
        {"id": "kc-1", "description": CUT},
        {"id": "kc-2", "description": CUT, "imports": [
            {"specifier": "@scope/lib", "from_path": "libs/lib/src/index.ts", "note": CUT}]},
    ]})
    rows = [
        _raw(1, plan, "plan_started", {
            "admission_scope": {"x": CUT}, "content_hash": CHAIN, "initial_revision_id": "plan-a-r1",
            "plan_content": {"schema_version": 2, "summary": CUT}}),
        _raw(2, plan, "challenger_plan_drafted", {
            "challenger_agent": CUT, "challenger_revision_id": "chal-1", "content_hash": CHAIN,
            "plan_content": {"summary": CUT}, "source_plan_content_hash": CHAIN, "source_revision_id": "plan-a-r1"}),
        _raw(3, plan, "cross_review_tasks_requested", {
            "replaces_task_ids": [], "round_number": 1, "target_plan_content_hash": CHAIN,
            "target_revision_id": "plan-a-r1",
            "tasks": [_task("challenger_to_primary", 1), _task("primary_to_challenger", 2)]}),
        _raw(4, plan, "cross_review_recorded", _review(
            "challenger_to_primary", 1, "plan-a-r1", [_risk("CR-001", "blocking", summary)], "material_risks_present")),
        _raw(5, plan, "cross_review_recorded", _review("primary_to_challenger", 2, "plan-a-r1", [], "agreed")),
        _raw(6, plan, "coverage_computed", _coverage(1, "chal-1")),
        _raw(7, plan, "revision_recorded", {
            "addresses_review_risk_ids": ["CR-001"], "content": revision_body, "content_hash": CHAIN,
            "parent_revision_hash": CUT, "revised_by_agent": CUT, "revision_id": "rev-1", "round": 1}),
        _raw(8, plan, "challenger_plan_drafted", {
            "challenger_agent": CUT, "challenger_revision_id": "chal-2", "content_hash": CHAIN,
            "plan_content": {"summary": CUT}, "source_plan_content_hash": CHAIN, "source_revision_id": "rev-1"}),
        _raw(9, plan, "cross_review_tasks_requested", {
            "replaces_task_ids": [], "round_number": 2, "target_plan_content_hash": CHAIN, "target_revision_id": "rev-1",
            "tasks": [_task("challenger_to_primary", 3), _task("primary_to_challenger", 4)]}),
        _raw(10, plan, "cross_review_recorded", _review("challenger_to_primary", 3, "rev-1", [], "agreed")),
        _raw(11, plan, "cross_review_recorded", _review(
            "primary_to_challenger", 4, "rev-1", [_risk("CR-001", "material", "a different, new objection")],
            "material_risks_present")),
        _raw(12, plan, "coverage_computed", {**_coverage(2, "rev-1"), "import_resolution": {
            "verdict": "resolved", "target_revision_id": "rev-1", "target_plan_content_hash": CHAIN,
            "synthetic_risks": [], "checked": 1, "unresolved": [], "config_planned": [CUT]}}),
        _raw(13, plan, "plan_evaluated", {
            "gate_decisions": [{"gate": "material_cross_review_zero", "passed": True},
                               {"gate": "no_pending_tasks", "passed": True},
                               {"gate": "max_rounds", "max_rounds": 2, "passed": False}],
            "reason_codes": ["cross_review_convergence_gates_passed"],
            "risks_rollup_summary": {"active_cross_review_risks": 0, "material_cross_review_risks": 0,
                                     "resolved_review_risks": 1, "pending_tasks": 0},
            "round_number": 2, "terminal_state": "CONVERGED"}),
        _raw(14, plan, "implementation_requested", {
            "converged_plan_content_hash": CHAIN, "converged_plan_revision_id": "rev-1", "implementer_agent": CUT}),
        _raw(15, other, "plan_started", {
            "content_hash": CHAIN, "initial_revision_id": "plan-b-r1", "plan_content": {"schema_version": 2}}),
        _raw(16, other, "plan_evaluated", {
            "gate_decisions": [], "reason_codes": ["max_rounds_reached"], "risks_rollup_summary": {},
            "round_number": 1, "terminal_state": "HUMAN_REQUIRED"}),
    ]
    rows[12:12] = extra_events  # before the evaluation: an event the fold would have read
    return "\n".join(json.dumps(row) for row in rows) + "\n"


class GeneratorKeepsWhatTheReplayReads(unittest.TestCase):
    def setUp(self) -> None:
        self.rows = generator.parse_ledger(_ledger())
        self.plans = generator.derive_plans(self.rows)
        self.fixture_text, self.header_text = generator.derive(_ledger())

    def test_a_plan_is_selected_by_its_converged_evaluation_and_cut_there(self) -> None:
        self.assertEqual([plan["plan_id"] for plan in self.plans], ["plan-a"])
        types = [event["event_type"] for event in self.plans[0]["events"]]
        self.assertEqual(types[0], "plan_started")
        self.assertEqual(types[-1], "plan_evaluated")
        self.assertNotIn("implementation_requested", types)
        self.assertEqual([event["ledger_line"] for event in self.plans[0]["events"]], list(range(1, 14)))

    def test_only_the_fields_the_replay_reads_survive(self) -> None:
        self.assertNotIn(CUT, self.fixture_text)
        kept = {event["event_type"]: sorted(event["payload"]) for event in self.plans[0]["events"]}
        self.assertEqual(kept["cross_review_recorded"], sorted([
            "target_revision_id", "target_plan_content_hash", "task_packet_hash", "status_after",
            "review_direction", "verdict", "risks"]))
        review = next(e for e in self.plans[0]["events"] if e["event_type"] == "cross_review_recorded")
        self.assertEqual(sorted(review["payload"]["risks"][0]), ["risk_id", "severity", "summary"])
        self.assertEqual(kept["plan_started"], ["content_hash", "initial_revision_id", "plan_content"])
        self.assertEqual(kept["revision_recorded"], [
            "addresses_review_risk_ids", "content", "content_hash", "revision_id", "round"])

    def test_a_revision_body_keeps_only_the_key_changes_that_prescribe_imports(self) -> None:
        revision = next(e for e in self.plans[0]["events"] if e["event_type"] == "revision_recorded")
        self.assertEqual(json.loads(revision["payload"]["content"]), {"key_changes": [
            {"id": "kc-2", "imports": [{"specifier": "@scope/lib", "from_path": "libs/lib/src/index.ts"}]}]})

    def test_the_recorded_gate_rows_the_replay_reads_are_kept_and_the_rest_cut(self) -> None:
        evaluated = self.plans[0]["events"][-1]["payload"]
        self.assertEqual([row["gate"] for row in evaluated["gate_decisions"]], ["material_cross_review_zero", "max_rounds"])
        self.assertEqual(evaluated["risks_rollup_summary"]["resolved_review_risks"], 1)

    def test_the_derivation_is_deterministic_and_one_event_per_line(self) -> None:
        self.assertEqual(generator.derive(_ledger()), (self.fixture_text, self.header_text))
        events = [line for line in self.fixture_text.splitlines() if line.lstrip().startswith('{"event_type"')]
        self.assertEqual(len(events), len(self.plans[0]["events"]))
        self.assertEqual(json.loads(self.fixture_text)["plans"][0]["plan_id"], "plan-a")

    def test_the_header_pins_the_derived_bytes_and_counts_the_ledger(self) -> None:
        header = json.loads(self.header_text)
        self.assertEqual(header["fixture_sha256"], generator._sha256(self.fixture_text))
        self.assertEqual(header["fixture_bytes"], len(self.fixture_text.encode("utf-8")))
        self.assertEqual((header["plans"], header["events"]), (1, 13))
        self.assertEqual(
            (header["source"]["ledger_events"], header["source"]["ledger_plans"],
             header["source"]["ledger_evaluations"], header["source"]["ledger_converged_evaluations"]),
            (16, 2, 2, 1))


class GeneratorRefusesALossyOrSensitiveDerivation(unittest.TestCase):
    def test_a_projection_that_changes_what_the_fold_reads_is_refused(self) -> None:
        rows = generator.parse_ledger(_ledger())
        plans = generator.derive_plans(rows)
        generator.assert_projection_is_lossless(rows, plans)
        review = next(e for e in plans[0]["events"] if e["event_type"] == "cross_review_recorded" and e["payload"]["risks"])
        review["payload"]["risks"][0]["severity"] = "nice_to_have"
        with self.assertRaisesRegex(AssertionError, "plan-a: the projection changed"):
            generator.assert_projection_is_lossless(rows, plans)

    def test_an_event_the_replay_has_no_projection_for_is_refused_not_dropped(self) -> None:
        reaped = _raw(99, "plan-a", "stale_tasks_reaped", {"round_number": 1, "reaped_task_ids": []})
        with self.assertRaisesRegex(ValueError, "no projection for event type 'stale_tasks_reaped'"):
            generator.derive(_ledger(extra_events=(reaped,)))

    def test_text_with_personal_or_secret_data_is_never_written(self) -> None:
        for leak in ("mail someone@example.com about it", "tenant 3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b",
                     "host 10.0.0.12 refused", "token ghp_" + "a" * 30):
            with self.subTest(leak=leak), self.assertRaisesRegex(ValueError, "not written"):
                generator.derive(_ledger(summary=leak))

    def test_the_scan_names_each_class_and_passes_arias_own_redaction_marker(self) -> None:
        for label, text in (
            ("email address", "a@b.example"), ("uuid (tenant or user id)", "3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b"),
            ("tenant schema", "tenant_3f2b8c1e"), ("ipv4 address", "192.168.1.20"), ("jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0."),
            ("private key", "-----BEGIN RSA PRIVATE KEY-----"), ("credential assignment", "password = hunter2hunter2"),
            ("operator or maintainer name", "reviewed by Okan"),
        ):
            with self.subTest(label=label):
                self.assertEqual([found.split(":")[0] for found in generator.scan_for_sensitive_data(text)], [label])
        self.assertEqual(generator.scan_for_sensitive_data("accepts http://<secret-redacted>:5173 only"), [])


if __name__ == "__main__":
    unittest.main()
