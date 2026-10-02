"""V9.5 check 12 — ingestion drops unsigned rows, records evidence, the gate reads it.

Contract (docs/aria/v3-v9-5-safety-contracts-policy.md §12; request rows
superseded by ADR-0020): a request row whose operator signature is missing
or does not verify against the allowed-signers file committed at the cycle
checkout's HEAD, or that names no F finding, is dropped with one
``unsigned_operator_feedback`` governance event per drop; a request is
admitted once (ADR-0018 D3); the pre-merge predicate proves from captured
evidence that the rule was applied to the merged plan's synthesis, with no
key file on the merge lane. Pre-fix: the HMAC key the rows were checked
against lived on the self-hosted runner, was swept every job, and was never
on the GitHub-hosted merge lane, so a consumed row could not re-verify there.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as safety
from aria_kernel import operator_feedback_ingestion as ingestion
from aria_kernel import operator_feedback_signature as ofs
from aria_kernel import operator_request_signature as ors
from aria_kernel.cycle_phases.plan_source import V9PressureSourceProvider
from aria_kernel.finding_grounding import admit_candidate
from aria_kernel.ledger import _verify_jsonl_from_text, load_declared_jsonl
from aria_kernel.plan_convergence import content_hash, fold_plan_state, start_plan
from aria_kernel.plan_synthesizer import (
    convert_candidate_to_plan_content,
    rank_candidate_sources,
    scan_operator_feedback,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_requests import (
    GROUNDED_FILE,
    OperatorRequestFixture,
    allowed_signers_line,
    mint_ed25519_key,
)


def _governance(tools: Path, kind: str) -> list[dict]:
    return [row for row in load_declared_jsonl(tools / "governance.jsonl", expected_surface="tools_governance")
            if row["kind"] == kind]


def _ingestion_rows(tools: Path) -> list[dict]:
    return load_declared_jsonl(ingestion.ingestion_ledger_path(tools), expected_surface=ingestion.INGESTION_SURFACE)


def _feedback_rows(tools: Path) -> list[dict]:
    path = tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME
    return _verify_jsonl_from_text(path, path.read_text(encoding="utf-8"), expected_surface="operator_feedback")[1]


def _unsigned_subject(row: dict) -> dict:
    return {k: v for k, v in row.items() if k not in ("signature", "ledger_hash", "previous_ledger_hash")}


class _Fixture(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-ofi-")
        self.addCleanup(self.tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        # Hermetic: the failing-CI source asks GitHub; these suites rank the
        # operator source, so the network source answers nothing here.
        ci = mock.patch("aria_kernel.plan_synthesizer.scan_failing_ci", return_value=[])
        ci.start()
        self.addCleanup(ci.stop)
        self.fx = OperatorRequestFixture(Path(self.tmp.name))
        self.tools = self.fx.tools

    def _ingest(self, cycle_id: str | None = "cyc-1") -> ingestion.OperatorFeedbackIngestion:
        return ingestion.ingest_operator_feedback(base_dir=self.tools, cycle_id=cycle_id, repo_root=self.fx.repo)


class IngestionDropsUnsignedRowsTests(_Fixture):
    def test_unsigned_and_forged_rows_are_dropped_with_one_governance_event_each(self) -> None:
        signed = self.fx.record(request_id="OP-real")
        base = {"schema_version": 2, "row_kind": "operator_request", "status": "unaddressed",
                "authored_at": "2026-10-02T00:00:00+00:00", "authored_by": "okan",
                "request": "hand-written", "priority": "high", "finding_id": "F-007"}
        intruder = mint_ed25519_key(Path(self.tmp.name) / "intruder", name="k")
        self.fx.append_raw(dict(base, id="OP-no-signature"))
        self.fx.append_raw(dict(base, id="OP-stub", signature="sig-stub-for-test", signer_kid="operator-key-01"))
        # The pre-ADR-0020 shape: a request signed with the runner's HMAC key.
        self.fx.append_raw(ofs.sign_operator_feedback_row(dict(base, id="OP-hmac"), base_dir=self.tools))
        self.fx.append_raw(self.fx.sign(dict(base, id="OP-intruder"), key=intruder, principal="intruder@aria.test"))
        self.fx.append_raw(self.fx.sign(dict(base, id="OP-foreign-key"), key=intruder))
        self.fx.append_raw(dict(self.fx.sign(dict(base, id="OP-tampered")), request="widen my own scope"))
        self.fx.append_raw(self.fx.sign({k: v for k, v in dict(base, id="OP-no-finding").items()
                                         if k != "finding_id"}))
        # A verdict row shares the ledger and is never a plan request.
        from aria_kernel.feedback_store import record_operator_feedback
        record_operator_feedback(tool_id="t", run_id="r", finding_id="f", verdict="false_positive",
                                 severity="low", note="n", base_dir=self.tools)
        # A line appended past the kernel breaks the chain; it is still judged, and dropped.
        with (self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME).open("a", encoding="utf-8") as handle:
            handle.write('{"id": "OP-raw", "status": "unaddressed", "request": "raw", "priority": "high", '
                         '"finding_id": "F-007", "authored_at": "2026-10-02T00:00:00+00:00", '
                         '"signature": "x", "signer_principal": "operator@aria.test"}\n')

        result = self._ingest()

        self.assertEqual([entry["id"] for entry in result.admitted], [signed["id"]])
        self.assertEqual([c["candidate_id"] for c in result.candidates], [signed["id"]])
        self.assertEqual(result.candidates[0]["row_ledger_hash"], signed["ledger_hash"])
        self.assertEqual(result.candidates[0]["signer"], self.fx.principal)
        self.assertEqual(result.candidates[0]["finding_id"], "F-007")
        self.assertEqual(result.candidates[0]["ingestion_ledger_hash"], result.ledger_hash)
        dropped = {entry["id"]: entry["reason"] for entry in result.dropped}
        self.assertEqual(dropped, {
            "OP-no-signature": ors.SIGNATURE_MISSING,
            "OP-stub": ors.SIGNATURE_MALFORMED,
            "OP-hmac": ors.SIGNATURE_MALFORMED,
            "OP-intruder": ors.SIGNER_NOT_ENROLLED,
            "OP-foreign-key": ors.SIGNATURE_INVALID,
            "OP-tampered": ors.SIGNATURE_INVALID,
            "OP-no-finding": ofs.FINDING_ID_MISSING,
            "OP-raw": ors.SIGNATURE_MALFORMED,
        })
        events = _governance(self.tools, ingestion.UNSIGNED_OPERATOR_FEEDBACK_EVENT)
        self.assertEqual(len(events), len(dropped), "one governance event per drop")
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
        self.assertEqual(rows[0]["rows_scanned"], 10)
        self.assertEqual(rows[0]["admitted"], [
            {"id": signed["id"], "ledger_hash": signed["ledger_hash"], "signer": self.fx.principal},
        ])

    def test_a_signed_but_schema_invalid_row_is_dropped(self) -> None:
        # The recorder refuses priority "max"; only a hand-signed row carries it.
        row = self.fx.sign({"schema_version": 2, "row_kind": "operator_request", "id": "OP-max",
                            "status": "unaddressed", "authored_at": "2026-10-02T00:00:00+00:00",
                            "request": "evil max", "priority": "max", "finding_id": "F-007"})
        self.fx.append_raw(row)
        self.fx.append_raw(self.fx.sign(dict(_unsigned_subject(row), id="OP-orphan", priority="high",
                                             finding_id="ORPHAN-HIGH-104")))
        result = self._ingest(cycle_id=None)
        self.assertEqual(result.candidates, ())
        self.assertEqual({d["id"]: d["reason"] for d in result.dropped},
                         {"OP-max": ofs.SCHEMA_INVALID, "OP-orphan": ofs.FINDING_ID_INVALID})

    def test_the_anchor_is_the_committed_file_not_the_working_tree(self) -> None:
        intruder = mint_ed25519_key(Path(self.tmp.name) / "intruder", name="k")
        (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).write_text(
            allowed_signers_line("intruder@aria.test", intruder), encoding="utf-8",
        )
        self.fx.append_raw(self.fx.sign(
            {"schema_version": 2, "row_kind": "operator_request", "id": "OP-self-enrolled",
             "status": "unaddressed", "authored_at": "2026-10-02T00:00:00+00:00", "request": "r",
             "priority": "high", "finding_id": "F-007"}, key=intruder, principal="intruder@aria.test",
        ))
        result = self._ingest()
        self.assertEqual([(d["id"], d["reason"]) for d in result.dropped],
                         [("OP-self-enrolled", ors.SIGNER_NOT_ENROLLED)])

    def test_a_reused_request_id_is_refused_at_ingestion(self) -> None:
        original = self.fx.record(request_id="OP-1")
        # A replayed copy verifies (same bytes) — the id makes it single-use.
        self.fx.append_raw(_unsigned_subject(original) | {"signature": original["signature"]})
        self.fx.append_raw(self.fx.sign(dict(_unsigned_subject(original), request="a second ask")))
        result = self._ingest()
        self.assertEqual([entry["ledger_hash"] for entry in result.admitted], [original["ledger_hash"]])
        self.assertEqual([d["reason"] for d in result.dropped],
                         [ingestion.REQUEST_ID_REUSED, ingestion.REQUEST_ID_REUSED])

    def test_scan_orders_admitted_candidates_and_records_even_an_absent_ledger(self) -> None:
        self.assertEqual(scan_operator_feedback(self.fx.repo), [])
        rows = _ingestion_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertFalse(rows[0]["ledger_present"])
        for identifier, priority in (("L1", "low"), ("H1", "high"), ("M1", "medium")):
            self.fx.record(request=identifier, priority=priority, request_id=identifier)
        ordered = scan_operator_feedback(self.fx.repo, base_dir=self.tools, cycle_id="cyc-2")
        self.assertEqual([c["candidate_id"] for c in ordered], ["H1", "M1", "L1"])
        self.assertEqual(ordered[0]["source_type"], "operator_feedback")

    def test_no_anchor_admits_nothing(self) -> None:
        self.fx.record(request_id="OP-1")
        bare = Path(self.tmp.name) / "not-a-checkout"
        bare.mkdir()
        result = ingestion.ingest_operator_feedback(base_dir=self.tools, cycle_id="c", repo_root=bare)
        self.assertEqual(result.candidates, ())
        self.assertEqual([d["reason"] for d in result.dropped], [ors.ALLOWED_SIGNERS_UNAVAILABLE])

    def test_scanner_never_bootstraps_a_tools_root(self) -> None:
        bare = Path(self.tmp.name) / "elsewhere"
        bare.mkdir()
        with self.assertRaisesRegex(GovernanceError, "operator_feedback_tools_root_unavailable"):
            scan_operator_feedback(bare)
        self.assertFalse((bare / "aria-tools").exists())


class ConsumeOnceTests(_Fixture):
    """ADR-0018 D3 — spent is computed at ingestion from the kernel's own ledgers."""

    def setUp(self) -> None:
        super().setUp()
        self.fx.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        self.signed = self.fx.record(request_id="OP-once")

    def _bind(self, cycle_id: str) -> dict:
        candidate = next(c for c in rank_candidate_sources(
            workspace_root=self.fx.repo, base_dir=self.tools, cycle_id=cycle_id,
        ) if c["source_type"] == "operator_feedback")
        envelope = convert_candidate_to_plan_content(
            candidate, admission=admit_candidate(candidate, repo_root=self.fx.repo),
        )
        ingestion.bind_plan_synthesis(base_dir=self.tools, cycle_id=cycle_id,
                                      plan_content=envelope.content, candidate=candidate)
        return envelope.content

    def test_a_binding_whose_plan_never_started_is_admitted_again(self) -> None:
        self._bind("cyc-1")
        result = self._ingest("cyc-2")
        self.assertEqual([entry["id"] for entry in result.admitted], ["OP-once"])
        self.assertEqual(result.spent, ())

    def test_a_binding_whose_plan_started_spends_the_request(self) -> None:
        content = self._bind("cyc-1")
        start_plan(plan_id="plan-once", plan_content=content, initial_revision_id="plan-once-r1",
                   base_dir=self.tools)
        result = self._ingest("cyc-2")
        self.assertEqual(result.admitted, ())
        self.assertEqual(list(result.spent), [{"id": "OP-once", "ledger_hash": self.signed["ledger_hash"],
                                               "reason": "consumed_by_started_plan"}])
        # The id stays claimed: a re-signed copy cannot buy a second plan.
        self.fx.append_raw(self.fx.sign(dict(_unsigned_subject(self.signed), request="again")))
        again = self._ingest("cyc-3")
        self.assertEqual(again.admitted, ())
        self.assertEqual([d["reason"] for d in again.dropped], [ingestion.REQUEST_ID_REUSED])

    def test_a_refused_request_is_spent(self) -> None:
        candidate = next(c for c in scan_operator_feedback(self.fx.repo, base_dir=self.tools, cycle_id="c1"))
        ingestion.record_request_refused(base_dir=self.tools, cycle_id="c1", candidate=candidate,
                                         reason="finding_not_open", refused_surfaces=[])
        result = self._ingest("c2")
        self.assertEqual(result.admitted, ())
        self.assertEqual([s["reason"] for s in result.spent], ["refused"])
        with self.assertRaisesRegex(GovernanceError, "operator_request_refusal_reason_unknown"):
            ingestion.record_request_refused(base_dir=self.tools, cycle_id="c1", candidate=candidate,
                                             reason="because", refused_surfaces=[])


class SynthesisBindingTests(_Fixture):
    def test_provider_binds_the_selected_synthesis_to_its_ingestion(self) -> None:
        self.fx.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        signed = self.fx.record(request_id="OP-bind")
        envelope = V9PressureSourceProvider().synthesize(
            cycle_id="cyc-bind", workspace_root=self.fx.repo, base_dir=self.tools, profile="standard",
        )
        self.assertIsNotNone(envelope)
        self.assertEqual(envelope.metadata["_candidate_id"], "OP-bind")
        rows = _ingestion_rows(self.tools)
        self.assertEqual([row["row_type"] for row in rows], [ingestion.INGESTION_ROW_TYPE, ingestion.SYNTHESIS_BOUND_ROW_TYPE])
        scan, bound = rows
        self.assertEqual(bound["ingestion_ledger_hash"], scan["ledger_hash"])
        self.assertEqual(bound["plan_content_hash"], content_hash(envelope.content))
        self.assertEqual(bound["consumed"], [
            {"id": "OP-bind", "ledger_hash": signed["ledger_hash"], "signer": self.fx.principal},
        ])
        selected = _governance(self.tools, "plan_candidate_source_selected")[-1]["details"]
        self.assertEqual(selected["operator_feedback_binding_hash"], bound["ledger_hash"])
        self.assertEqual(selected["operator_feedback_ingestion_hash"], scan["ledger_hash"])

    def test_binding_records_an_absent_ingestion_rather_than_inventing_one(self) -> None:
        with mock.patch("aria_kernel.plan_synthesizer.rank_candidate_sources",
                        return_value=[{"candidate_id": "ORPHAN-HIGH-1", "source_type": "orphan_finding",
                                       "severity": "HIGH", "raw_id": "1", "title_hint": "x"}]):
            envelope = V9PressureSourceProvider().synthesize(
                cycle_id="cyc-nobind", workspace_root=self.fx.repo, base_dir=self.tools, profile="standard",
            )
        self.assertIsNotNone(envelope)
        rows = _ingestion_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["row_type"], ingestion.SYNTHESIS_BOUND_ROW_TYPE)
        self.assertIsNone(rows[0]["ingestion_ledger_hash"])
        self.assertEqual(rows[0]["consumed"], [])


class PreMergeObservationTests(_Fixture):
    """The walk plan_started → binding → ingestion → consumed rows, and every gap it names."""

    def setUp(self) -> None:
        super().setUp()
        self.fx.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        self.signed = self.fx.record(request_id="OP-obs")
        candidates = rank_candidate_sources(workspace_root=self.fx.repo, base_dir=self.tools, cycle_id="cyc-obs")
        self.candidate = next(c for c in candidates if c["source_type"] == "operator_feedback")
        self.envelope = convert_candidate_to_plan_content(
            self.candidate, admission=admit_candidate(self.candidate, repo_root=self.fx.repo),
        )
        self.binding = ingestion.bind_plan_synthesis(
            base_dir=self.tools, cycle_id="cyc-obs", plan_content=self.envelope.content, candidate=self.candidate,
        )
        start_plan(plan_id="plan-obs", plan_content=self.envelope.content,
                   initial_revision_id="plan-obs-r1", base_dir=self.tools)
        self.state = fold_plan_state(plan_id="plan-obs", base_dir=self.tools)
        self.anchor = ors.committed_allowed_signers(self.fx.repo, rev="HEAD")

    def _observe(self, *, plan_started=None, ingestion_rows=None, feedback_rows=None, allowed_signers=b"default"):
        return ingestion.observe_operator_feedback_for_plan(
            plan_started=self.state["plan_started"] if plan_started is None else plan_started,
            ingestion_rows=_ingestion_rows(self.tools) if ingestion_rows is None else ingestion_rows,
            feedback_rows=_feedback_rows(self.tools) if feedback_rows is None else feedback_rows,
            allowed_signers=self.anchor if allowed_signers == b"default" else allowed_signers,
        )

    def test_the_walk_closes_with_no_key_material_anywhere_on_the_lane(self) -> None:
        # The GitHub-hosted lane holds no key file: there is none to hold.
        self.assertEqual([p for p in self.tools.rglob("*") if p.is_file() and "secrets" in p.parts], [])
        observation = self._observe()
        self.assertTrue(observation["operator_feedback_verified"], observation)
        self.assertNotIn("operator_feedback_unavailable_reason", observation)
        self.assertEqual(observation["operator_feedback_plan_started_hash"], self.state["plan_started"]["content_hash"])
        self.assertEqual(observation["operator_feedback_bound_content_hash"], self.binding["plan_content_hash"])
        self.assertEqual(observation["operator_feedback_binding_hash"], self.binding["ledger_hash"])
        self.assertEqual(observation["operator_feedback_ingestion_hash"], self.binding["ingestion_ledger_hash"])
        self.assertEqual(observation["operator_feedback_dropped_count"], 0)
        self.assertEqual(observation["operator_feedback_consumed_row_hashes"], (self.signed["ledger_hash"],))
        self.assertEqual(observation["operator_feedback_consumed_signers"], (self.fx.principal,))
        # The observation is exactly the evidence vocabulary the predicate reads.
        evidence = safety._PreMergeEvidence((), **observation)
        self.assertTrue(evidence.operator_feedback_verified)

    def test_a_signer_the_anchor_no_longer_enrols_fails(self) -> None:
        successor = mint_ed25519_key(Path(self.tmp.name) / "successor", name="k")
        self.fx.commit_files({ors.ALLOWED_SIGNERS_PATH: allowed_signers_line("successor@aria.test", successor)},
                             message="chore(test): revoke the fixture operator")
        revoked = ors.committed_allowed_signers(self.fx.repo, rev="HEAD")
        observation = self._observe(allowed_signers=revoked)
        self.assertFalse(observation["operator_feedback_verified"])
        self.assertEqual(observation["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ors.SIGNER_NOT_ENROLLED)
        self.assertEqual(self._observe(allowed_signers=None)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ors.ALLOWED_SIGNERS_UNAVAILABLE)

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
                observation = self._observe(**kwargs)
                self.assertFalse(observation["operator_feedback_verified"])
                self.assertEqual(observation["operator_feedback_unavailable_reason"], expected)
                safety._PreMergeEvidence((), **observation)
        # An ingestion that never admitted the consumed row is a mismatch too.
        forged = [dict(r, admitted=[]) if r["ledger_hash"] == scan_row["ledger_hash"] else r for r in rows]
        observation = self._observe(ingestion_rows=forged)
        self.assertEqual(observation["operator_feedback_unavailable_reason"], "operator_feedback_consumption_mismatch")
        # A consumed row rewritten after admission no longer verifies.
        tampered = [dict(r, request="rewritten") if r.get("id") == "OP-obs" else r for r in _feedback_rows(self.tools)]
        self.assertEqual(self._observe(feedback_rows=tampered)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ors.SIGNATURE_INVALID)

    def test_merge_authority_wrapper_reads_the_anchor_at_the_trusted_commit(self) -> None:
        from aria_kernel.merge_authority import _capture_pre_merge_operator_feedback

        rows = {"operator_feedback_ingestion": _ingestion_rows(self.tools), "operator_feedback": _feedback_rows(self.tools)}
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.fx.repo, check=True,
                              capture_output=True, text=True).stdout.strip()
        observation = _capture_pre_merge_operator_feedback(
            state=self.state, rows=rows, workspace=self.fx.repo, trust_sha=head,
        )
        self.assertTrue(observation["operator_feedback_verified"], observation)
        root_commit = subprocess.run(["git", "rev-list", "--max-parents=0", "HEAD"], cwd=self.fx.repo,
                                     check=True, capture_output=True, text=True).stdout.strip()
        before_anchor = _capture_pre_merge_operator_feedback(
            state=self.state, rows=rows, workspace=self.fx.repo, trust_sha=root_commit,
        )
        self.assertEqual(before_anchor["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ors.ALLOWED_SIGNERS_UNAVAILABLE)


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
            operator_feedback_consumed_signers=("operator@aria.test",),
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
        result = self._run(self._bound(operator_feedback_consumed_row_hashes=(), operator_feedback_consumed_signers=()))
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
