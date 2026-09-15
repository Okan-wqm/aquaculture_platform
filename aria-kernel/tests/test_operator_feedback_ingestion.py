"""V9.5 check 12 — ingestion drops unsigned rows, records evidence, the gate reads it.

Contract (docs/aria/v3-v9-5-safety-contracts-policy.md §12): a row with a
missing OR invalid ``signature`` / ``signer_kid`` is dropped with one
``unsigned_operator_feedback`` governance event per drop; the synthesizer
continues with the remaining valid rows; the pre-merge predicate proves
from captured evidence that the rule was applied to the merged plan's
synthesis. Pre-fix every one of these pins fails: a stub signature was
admitted, no governance row was ever written, no ingestion evidence
existed, and the predicate was ``check_not_implemented``.
"""
from __future__ import annotations

import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from aria_kernel import implementation_safety as safety
from aria_kernel import operator_feedback_ingestion as ingestion
from aria_kernel import operator_feedback_signature as ofs
from aria_kernel.cycle_phases.plan_source import V9PressureSourceProvider
from aria_kernel.ledger import _verify_jsonl_from_text, load_declared_jsonl
from aria_kernel.plan_convergence import content_hash, fold_plan_state, start_plan
from aria_kernel.plan_synthesizer import (
    convert_candidate_to_plan_content,
    rank_candidate_sources,
    scan_operator_feedback,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


def _governance(tools: Path, kind: str) -> list[dict]:
    return [row for row in load_declared_jsonl(tools / "governance.jsonl", expected_surface="tools_governance")
            if row["kind"] == kind]


def _ingestion_rows(tools: Path) -> list[dict]:
    return load_declared_jsonl(ingestion.ingestion_ledger_path(tools), expected_surface=ingestion.INGESTION_SURFACE)


def _feedback_rows(tools: Path) -> list[dict]:
    path = tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME
    return _verify_jsonl_from_text(path, path.read_text(encoding="utf-8"), expected_surface="operator_feedback")[1]


class IngestionDropsUnsignedRowsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ofi-")
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def _unsigned_shapes(self) -> dict[str, dict]:
        base = {"schema_version": 1, "status": "unaddressed", "authored_at": "2026-09-12T00:00:00+00:00",
                "request": "hand-written", "priority": "high"}
        return {
            "OP-no-signature": dict(base, id="OP-no-signature"),
            "OP-stub": dict(base, id="OP-stub", signature="sig-stub-for-test", signer_kid="operator-key-01"),
        }

    def test_unsigned_rows_are_dropped_with_one_governance_event_each(self) -> None:
        signed = ofs.record_operator_request(request="real", priority="medium", authored_by="okan", base_dir=self.tools)
        for row in self._unsigned_shapes().values():
            append_declared_fixture(self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME, row, expected_surface="operator_feedback")
        # A verdict row shares the ledger and is never a plan request.
        from aria_kernel.feedback_store import record_operator_feedback
        record_operator_feedback(tool_id="t", run_id="r", finding_id="f", verdict="false_positive",
                                 severity="low", note="n", base_dir=self.tools)
        # A line appended past the kernel breaks the chain; it is still judged, and dropped.
        with (self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME).open("a", encoding="utf-8") as handle:
            handle.write('{"id": "OP-raw", "status": "unaddressed", "request": "raw", "priority": "high", '
                         '"authored_at": "2026-09-12T00:00:00+00:00", "signature": "x", "signer_kid": "k"}\n')

        result = ingestion.ingest_operator_feedback(base_dir=self.tools, cycle_id="cyc-1")

        self.assertEqual([entry["id"] for entry in result.admitted], [signed["id"]])
        self.assertEqual([c["candidate_id"] for c in result.candidates], [signed["id"]])
        self.assertEqual(result.candidates[0]["row_ledger_hash"], signed["ledger_hash"])
        self.assertEqual(result.candidates[0]["signer_kid"], signed["signer_kid"])
        self.assertEqual(result.candidates[0]["ingestion_ledger_hash"], result.ledger_hash)
        dropped = {entry["id"]: entry["reason"] for entry in result.dropped}
        self.assertEqual(dropped, {
            "OP-no-signature": ofs.SIGNER_KID_MISSING,
            "OP-stub": ofs.SIGNATURE_MALFORMED,
            "OP-raw": ofs.SIGNATURE_MALFORMED,
        })
        events = _governance(self.tools, ingestion.UNSIGNED_OPERATOR_FEEDBACK_EVENT)
        self.assertEqual(len(events), 3, "one governance event per drop")
        self.assertEqual({e["details"]["id"]: e["details"]["reason"] for e in events}, dropped)
        self.assertEqual({e["ledger_hash"] for e in events},
                         {entry["governance_ledger_hash"] for entry in result.dropped})
        for event in events:
            self.assertNotIn("request", event["details"], "the untrusted body never enters governance")
        rows = _ingestion_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ledger_hash"], result.ledger_hash)
        self.assertEqual(rows[0]["row_type"], ingestion.INGESTION_ROW_TYPE)
        self.assertEqual(rows[0]["cycle_id"], "cyc-1")
        self.assertEqual(rows[0]["rows_scanned"], 5)
        self.assertEqual(rows[0]["admitted"], [
            {"id": signed["id"], "ledger_hash": signed["ledger_hash"], "signer_kid": signed["signer_kid"]},
        ])

    def test_signed_but_schema_invalid_row_is_dropped(self) -> None:
        # Only a leaked key could produce this; it is still not a candidate.
        signed = ofs.sign_operator_feedback_row(
            {"id": "OP-max", "status": "unaddressed", "authored_at": "2026-09-12T00:00:00+00:00",
             "request": "evil max", "priority": "max"}, base_dir=self.tools,
        )
        append_declared_fixture(self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME, signed, expected_surface="operator_feedback")
        result = ingestion.ingest_operator_feedback(base_dir=self.tools, cycle_id=None)
        self.assertEqual(result.candidates, ())
        self.assertEqual(result.dropped[0]["reason"], ingestion.SCHEMA_INVALID)

    def test_scan_orders_admitted_candidates_and_records_even_an_absent_ledger(self) -> None:
        self.assertEqual(scan_operator_feedback(self.workspace), [])
        rows = _ingestion_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["ledger_present"])
        for identifier, priority in (("L1", "low"), ("H1", "high"), ("M1", "medium")):
            ofs.record_operator_request(request=identifier, priority=priority, authored_by="okan",
                                        request_id=identifier, base_dir=self.tools)
        ordered = scan_operator_feedback(self.workspace, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual([c["candidate_id"] for c in ordered], ["H1", "M1", "L1"])
        self.assertEqual(ordered[0]["source_type"], "operator_feedback")

    def test_scanner_never_bootstraps_a_tools_root(self) -> None:
        bare = Path(self.tmp.name) / "elsewhere"
        bare.mkdir()
        with self.assertRaisesRegex(GovernanceError, "operator_feedback_tools_root_unavailable"):
            scan_operator_feedback(bare)
        self.assertFalse((bare / "aria-tools").exists())


class SynthesisBindingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ofb-")
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def test_provider_binds_the_selected_synthesis_to_its_ingestion(self) -> None:
        signed = ofs.record_operator_request(request="Tighten validator", priority="high",
                                             authored_by="okan", request_id="OP-bind", base_dir=self.tools)
        envelope = V9PressureSourceProvider().synthesize(
            cycle_id="cyc-bind", workspace_root=self.workspace, base_dir=self.tools, profile="standard",
        )
        self.assertIsNotNone(envelope)
        self.assertEqual(envelope.metadata["_candidate_id"], "OP-bind")
        rows = _ingestion_rows(self.tools)
        self.assertEqual([row["row_type"] for row in rows], [ingestion.INGESTION_ROW_TYPE, ingestion.SYNTHESIS_BOUND_ROW_TYPE])
        scan, bound = rows
        self.assertEqual(bound["ingestion_ledger_hash"], scan["ledger_hash"])
        self.assertEqual(bound["plan_content_hash"], content_hash(envelope.content))
        self.assertEqual(bound["consumed"], [
            {"id": "OP-bind", "ledger_hash": signed["ledger_hash"], "signer_kid": signed["signer_kid"]},
        ])
        selected = _governance(self.tools, "plan_candidate_source_selected")[-1]["details"]
        self.assertEqual(selected["operator_feedback_binding_hash"], bound["ledger_hash"])
        self.assertEqual(selected["operator_feedback_ingestion_hash"], scan["ledger_hash"])

    def test_binding_records_an_absent_ingestion_rather_than_inventing_one(self) -> None:
        with patch("aria_kernel.plan_synthesizer.rank_candidate_sources",
                   return_value=[{"candidate_id": "ORPHAN-HIGH-1", "source_type": "orphan_finding",
                                  "severity": "HIGH", "raw_id": "1", "title_hint": "x"}]):
            envelope = V9PressureSourceProvider().synthesize(
                cycle_id="cyc-nobind", workspace_root=self.workspace, base_dir=self.tools, profile="standard",
            )
        self.assertIsNotNone(envelope)
        rows = _ingestion_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["row_type"], ingestion.SYNTHESIS_BOUND_ROW_TYPE)
        self.assertIsNone(rows[0]["ingestion_ledger_hash"])
        self.assertEqual(rows[0]["consumed"], [])


class PreMergeObservationTests(unittest.TestCase):
    """The walk plan_started → binding → ingestion → consumed rows, and every gap it names."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ofo-")
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")
        self.signed = ofs.record_operator_request(request="Tighten validator", priority="high",
                                                  authored_by="okan", request_id="OP-obs", base_dir=self.tools)
        candidates = rank_candidate_sources(workspace_root=self.workspace, base_dir=self.tools, cycle_id="cyc-obs")
        self.candidate = next(c for c in candidates if c["source_type"] == "operator_feedback")
        self.envelope = convert_candidate_to_plan_content(self.candidate)
        self.binding = ingestion.bind_plan_synthesis(
            base_dir=self.tools, cycle_id="cyc-obs", plan_content=self.envelope.content, candidate=self.candidate,
        )
        start_plan(plan_id="plan-obs", plan_content=self.envelope.content,
                   initial_revision_id="plan-obs-r1", base_dir=self.tools)
        self.state = fold_plan_state(plan_id="plan-obs", base_dir=self.tools)

    def _observe(self, *, plan_started=None, ingestion_rows=None, feedback_rows=None):
        return ingestion.observe_operator_feedback_for_plan(
            tools=self.tools,
            plan_started=self.state["plan_started"] if plan_started is None else plan_started,
            ingestion_rows=_ingestion_rows(self.tools) if ingestion_rows is None else ingestion_rows,
            feedback_rows=_feedback_rows(self.tools) if feedback_rows is None else feedback_rows,
        )

    def test_the_walk_closes_for_a_synthesized_plan(self) -> None:
        observation, files = self._observe()
        self.assertTrue(observation["operator_feedback_verified"], observation)
        self.assertNotIn("operator_feedback_unavailable_reason", observation)
        self.assertEqual(observation["operator_feedback_plan_started_hash"], self.state["plan_started"]["content_hash"])
        self.assertEqual(observation["operator_feedback_bound_content_hash"], self.binding["plan_content_hash"])
        self.assertEqual(observation["operator_feedback_binding_hash"], self.binding["ledger_hash"])
        self.assertEqual(observation["operator_feedback_ingestion_hash"], self.binding["ingestion_ledger_hash"])
        self.assertEqual(observation["operator_feedback_dropped_count"], 0)
        self.assertEqual(observation["operator_feedback_consumed_row_hashes"], (self.signed["ledger_hash"],))
        self.assertEqual(observation["operator_feedback_consumed_signer_kids"], (self.signed["signer_kid"],))
        self.assertEqual(list(files), [ofs.signing_key_path(self.tools)])
        self.assertIsNotNone(files[ofs.signing_key_path(self.tools)])
        # The observation is exactly the evidence vocabulary the predicate reads.
        evidence = safety._PreMergeEvidence((), **observation)
        self.assertTrue(evidence.operator_feedback_verified)

    def test_every_gap_is_a_named_reason(self) -> None:
        hand_started = {"plan_content": dict(self.envelope.content, title="hand-authored"),
                        "content_hash": content_hash(dict(self.envelope.content, title="hand-authored"))}
        rows = _ingestion_rows(self.tools)
        scan_row = next(r for r in rows if r["row_type"] == ingestion.INGESTION_ROW_TYPE)
        unbound_ingestion = [dict(r, ingestion_ledger_hash=None) if r["row_type"] == ingestion.SYNTHESIS_BOUND_ROW_TYPE else r
                             for r in rows]
        mismatched_started = {"plan_content": dict(self.envelope.content, evidence_refs=[ingestion.EVIDENCE_REF_PREFIX + "OP-other"]),
                              "content_hash": self.state["plan_started"]["content_hash"]}
        cases = {
            "operator_feedback_plan_start_unavailable": dict(plan_started={}),
            "operator_feedback_synthesis_binding_unavailable": dict(plan_started=hand_started),
            "operator_feedback_ingestion_unavailable": dict(ingestion_rows=unbound_ingestion),
            "operator_feedback_consumption_mismatch": dict(plan_started=mismatched_started),
            "operator_feedback_consumed_row_unavailable": dict(feedback_rows=[]),
        }
        for expected, kwargs in cases.items():
            with self.subTest(reason=expected):
                observation, _files = self._observe(**kwargs)
                self.assertFalse(observation["operator_feedback_verified"])
                self.assertEqual(observation["operator_feedback_unavailable_reason"], expected)
                safety._PreMergeEvidence((), **observation)
        # An ingestion that never admitted the consumed row is a mismatch too.
        forged = [dict(r, admitted=[]) if r["ledger_hash"] == scan_row["ledger_hash"] else r for r in rows]
        observation, _files = self._observe(ingestion_rows=forged)
        self.assertEqual(observation["operator_feedback_unavailable_reason"], "operator_feedback_consumption_mismatch")

    def test_a_consumed_row_the_store_can_no_longer_vouch_for_fails(self) -> None:
        ofs.signing_key_path(self.tools).unlink()
        observation, files = self._observe()
        self.assertFalse(observation["operator_feedback_verified"])
        self.assertEqual(observation["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ofs.SIGNER_KID_UNKNOWN)
        self.assertIsNone(files[ofs.signing_key_path(self.tools)])

    def test_merge_authority_wrapper_hands_the_owner_the_captured_prefixes(self) -> None:
        from aria_kernel.merge_authority import _capture_pre_merge_operator_feedback

        observation, files = _capture_pre_merge_operator_feedback(
            tools=self.tools, state=self.state,
            rows={"operator_feedback_ingestion": _ingestion_rows(self.tools), "operator_feedback": _feedback_rows(self.tools)},
        )
        self.assertTrue(observation["operator_feedback_verified"], observation)
        self.assertIn(ofs.signing_key_path(self.tools), files)


class PredicateTests(unittest.TestCase):
    """The registry predicate over the evidence vocabulary the capture produces."""

    def _bound(self, **overrides) -> safety._PreMergeEvidence:
        sha = "a" * 40
        base = dict(
            unavailable_reasons=(), repo_identity="repo", snapshot_hash="snap", pr_row_hash="h1",
            planned_row_hash="h2", committed_row_hash="h3", request_id="req", claim_id="claim",
            request_row_hash="h4", claim_row_hash="h5", result_row_hash="h6", implementation_event_hash="h7",
            base_sha=sha, head_sha=sha, implementation_base_sha=sha, implementation_head_sha=sha,
            plan_revision_id="r1", plan_content_hash="sha256:" + "b" * 64,
            operator_feedback_plan_started_hash="sha256:" + "c" * 64,
            operator_feedback_bound_content_hash="sha256:" + "c" * 64,
            operator_feedback_binding_hash="sha256:" + "d" * 64,
            operator_feedback_ingestion_hash="sha256:" + "e" * 64,
            operator_feedback_dropped_count=2,
            operator_feedback_consumed_row_hashes=("sha256:" + "f" * 64,),
            operator_feedback_consumed_signer_kids=("kid-1",),
            operator_feedback_verified=True,
        )
        base.update(overrides)
        return safety._PreMergeEvidence(**base)

    def _run(self, evidence: safety._PreMergeEvidence | None) -> safety.HardFailResult:
        report = safety.run_hard_fail_checks(
            safety.HardFailContext(pre_merge_evidence=evidence), gate=safety.GATE_PRE_MERGE,
        )
        return next(r for r in report.results if r.name == "operator_feedback_signature")

    def test_registry_entry_is_live(self) -> None:
        entry = next(c for c in safety.HARD_FAIL_CHECKS if c.name == "operator_feedback_signature")
        self.assertIs(entry.check, safety._check_operator_feedback_signature)
        self.assertEqual(entry.gate, safety.GATE_PRE_MERGE)
        self.assertEqual(self._run(None).reason, "native_implementation_binding_unavailable")

    def test_verified_evidence_passes(self) -> None:
        result = self._run(self._bound())
        self.assertTrue(result.passed, result.reason)
        self.assertEqual(result.reason, "native_operator_feedback_ingestion_verified")
        # A synthesis that consumed no operator row still proves the rule ran.
        result = self._run(self._bound(operator_feedback_consumed_row_hashes=(), operator_feedback_consumed_signer_kids=()))
        self.assertTrue(result.passed, result.reason)

    def test_named_capture_reasons_and_missing_fields_refuse(self) -> None:
        cases = {
            "operator_feedback_synthesis_binding_unavailable": dict(
                operator_feedback_unavailable_reason="operator_feedback_synthesis_binding_unavailable",
                operator_feedback_verified=False),
            "operator_feedback_consumed_row_unsigned:signature_invalid": dict(
                operator_feedback_unavailable_reason="operator_feedback_consumed_row_unsigned:signature_invalid",
                operator_feedback_verified=False),
            "native_operator_feedback_binding_unavailable": dict(operator_feedback_ingestion_hash=None),
            "native_operator_feedback_signature_unverified": dict(operator_feedback_verified=None),
        }
        for expected, overrides in cases.items():
            with self.subTest(reason=expected):
                result = self._run(self._bound(**overrides))
                self.assertFalse(result.passed)
                self.assertEqual(result.reason, expected)
        drifted = self._bound(operator_feedback_bound_content_hash="sha256:" + "9" * 64)
        self.assertEqual(self._run(drifted).reason, "native_operator_feedback_binding_unavailable")
        self.assertEqual(self._run(replace(self._bound(), operator_feedback_verified=False)).reason,
                         "native_operator_feedback_signature_unverified")


if __name__ == "__main__":
    unittest.main()
