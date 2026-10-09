"""V9.5 check 12 — ingestion drops unsigned rows, spends a request once, the gate reads it back.

Contract (docs/aria/v3-v9-5-safety-contracts-policy.md §12; request rows
superseded by ADR-0020): a request row whose operator signature is missing
or does not verify against the allowed-signers file committed at a commit
proven on main, or that names no F finding, is dropped with one
``unsigned_operator_feedback`` governance event (reported once); only the
hash-chain-verified prefix of the ledger is admissible; a request is admitted
once, keyed on its signed id; its signed terms (audience, expiry, grounding
digest) are re-checked at ingestion and at merge; a runner fault never spends
it; and the pre-merge predicate proves all of it from captured evidence with
no key file on the merge lane. Review round 2 pins: AISAFETY-HIGH-001,
GSEC-MEDIUM-001/003/004, GSEC-LOW-009.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import implementation_safety as safety
from aria_kernel import main_anchor
from aria_kernel import operator_feedback_ingestion as ingestion
from aria_kernel import operator_feedback_signature as ofs
from aria_kernel import operator_request_signature as ors
from aria_kernel.cycle_phases.plan_source import V9PressureSourceProvider
from aria_kernel.finding_grounding import admit_candidate, load_grounding_context
from aria_kernel.ledger import _verify_jsonl_from_text, load_declared_jsonl
from aria_kernel.operator_feedback_observation import ALREADY_MERGED, observe_operator_feedback_for_plan
from aria_kernel.operator_request_terms import (
    REQUEST_AUDIENCE_MISMATCH,
    REQUEST_EXPIRED,
    REQUEST_EXPIRY_INVALID,
)
from aria_kernel.plan_convergence import content_hash, fold_plan_state, start_plan
from aria_kernel.plan_synthesizer import (
    PlanEvidenceGround,
    convert_candidate_to_plan_content,
    rank_candidate_sources,
    scan_operator_feedback,
)
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.operator_requests import (
    GROUNDED_FILE,
    OperatorRequestFixture,
    allowed_signers_line,
    git,
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


def _plan_events(tools: Path) -> list[dict]:
    return load_declared_jsonl(tools / "plans" / "events.jsonl", expected_surface="plan_convergence_events")


def _unsigned_subject(row: dict) -> dict:
    return {k: v for k, v in row.items() if k not in ("signature", "ledger_hash", "previous_ledger_hash")}


def _signed_copy(row: dict) -> dict:
    return _unsigned_subject(row) | {"signature": row["signature"]}


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
        self.fx.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        self.tools = self.fx.tools

    def _ingest(self, cycle_id: str | None = "cyc-1", *, now: datetime | None = None) -> ingestion.OperatorFeedbackIngestion:
        return ingestion.ingest_operator_feedback(base_dir=self.tools, cycle_id=cycle_id,
                                                  repo_root=self.fx.repo, now=now)

    def _refused(self) -> list[dict]:
        return [row for row in _ingestion_rows(self.tools) if row["row_type"] == "request_refused"]

    def _bind_and_maybe_start(self, cycle_id: str, *, start: bool, plan_id: str = "plan-once") -> dict:
        context = load_grounding_context(self.fx.repo)
        candidate = next(c for c in rank_candidate_sources(
            workspace_root=self.fx.repo, base_dir=self.tools, cycle_id=cycle_id,
            findings=context.findings,
        ) if c["source_type"] == "operator_feedback")
        envelope = convert_candidate_to_plan_content(
            candidate, admission=admit_candidate(candidate, context),
            ground=PlanEvidenceGround.of(self.fx.repo),
        ).envelope
        ingestion.bind_plan_synthesis(base_dir=self.tools, cycle_id=cycle_id,
                                      plan_content=envelope.content, candidate=candidate)
        if start:
            start_plan(plan_id=plan_id, plan_content=envelope.content, initial_revision_id=f"{plan_id}-r1",
                       base_dir=self.tools, workspace_root=self.fx.repo)
        return envelope.content


class IngestionDropsUnsignedRowsTests(_Fixture):
    def test_unsigned_and_forged_rows_are_dropped_with_one_governance_event_each(self) -> None:
        signed = self.fx.record(request_id="OP-real")
        intruder = mint_ed25519_key(Path(self.tmp.name) / "intruder", name="k")
        base = self.fx.request_row()
        self.fx.append_raw(dict(base, id="OP-no-signature"))
        self.fx.append_raw(dict(base, id="OP-stub", signature="sig-stub-for-test", signer_kid="operator-key-01"))
        # The pre-ADR-0020 shape: a request signed with the runner's HMAC key.
        self.fx.append_raw(ofs.sign_operator_feedback_row(dict(base, id="OP-hmac"), base_dir=self.tools))
        self.fx.append_raw(self.fx.sign(dict(base, id="OP-intruder"), key=intruder, principal="intruder@aria.test"))
        self.fx.append_raw(self.fx.sign(dict(base, id="OP-foreign-key"), key=intruder))
        self.fx.append_raw(dict(self.fx.sign(dict(base, id="OP-tampered")), request="widen my own scope"))
        # A verdict row shares the ledger and is never a plan request.
        from aria_kernel.feedback_store import record_operator_feedback
        record_operator_feedback(tool_id="t", run_id="r", finding_id="f", verdict="false_positive",
                                 severity="low", note="n", base_dir=self.tools)
        # A line appended past the kernel breaks the chain; the merge owner
        # cannot vouch for it, so it is refused by that name.
        with (self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME).open("a", encoding="utf-8") as handle:
            handle.write('{"id": "OP-raw", "status": "unaddressed", "request": "raw", "priority": "high"}\n')

        result = self._ingest()

        self.assertEqual([entry["id"] for entry in result.admitted], [signed["id"]])
        self.assertEqual([c["candidate_id"] for c in result.candidates], [signed["id"]])
        candidate = result.candidates[0]
        self.assertEqual((candidate["row_ledger_hash"], candidate["signer"], candidate["finding_id"]),
                         (signed["ledger_hash"], self.fx.principal, "F-007"))
        self.assertEqual(candidate["subject_digest"], ors.request_subject_digest(signed))
        self.assertEqual(candidate["grounding_digest"], signed["grounding_digest"])
        self.assertEqual(candidate["ingestion_ledger_hash"], result.ledger_hash)
        dropped = {entry["id"]: entry["reason"] for entry in result.dropped}
        self.assertEqual(dropped, {
            "OP-no-signature": ors.SIGNATURE_MISSING,
            "OP-stub": ors.SIGNATURE_MALFORMED,
            "OP-hmac": ors.SIGNATURE_MALFORMED,
            "OP-intruder": ors.SIGNER_NOT_ENROLLED,
            "OP-foreign-key": ors.SIGNATURE_INVALID,
            "OP-tampered": ors.SIGNATURE_INVALID,
            "OP-raw": ingestion.LEDGER_CHAIN_BROKEN,
        })
        events = _governance(self.tools, ingestion.UNSIGNED_OPERATOR_FEEDBACK_EVENT)
        self.assertEqual(len(events), len(dropped), "one governance event per drop")
        self.assertEqual({e["details"]["id"]: e["details"]["reason"] for e in events}, dropped)
        for event in events:
            self.assertNotIn("request", event["details"], "the untrusted body never enters governance")
        self.assertEqual(self._refused(), [], "an unauthenticated row cannot spend any id")
        rows = _ingestion_rows(self.tools)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["rows_scanned"], 9)
        self.assertEqual(rows[0]["admitted"], [{"id": signed["id"], "ledger_hash": signed["ledger_hash"],
                                                "signer": self.fx.principal,
                                                "subject_digest": ors.request_subject_digest(signed)}])
        head = git(self.fx.repo, "rev-parse", "HEAD").strip()
        self.assertEqual(rows[0]["anchor"]["commit"], head)
        self.assertEqual(rows[0]["anchor"]["allowed_signers_blob"],
                         git(self.fx.repo, "rev-parse", f"{head}:{ors.ALLOWED_SIGNERS_PATH}").strip())

    def test_a_signed_row_with_bad_terms_is_refused_and_spent(self) -> None:
        now = datetime.now(timezone.utc).replace(microsecond=0)
        cases = {
            "OP-max": (dict(priority="max"), ofs.SCHEMA_INVALID),
            "OP-orphan": (dict(finding_id="ORPHAN-HIGH-104"), ofs.FINDING_ID_INVALID),
            "OP-expired": (dict(authored_at=(now - timedelta(hours=10)).isoformat(),
                                expires_at=(now - timedelta(hours=1)).isoformat()), REQUEST_EXPIRED),
            "OP-forever": (dict(expires_at=(now + timedelta(hours=500)).isoformat()), REQUEST_EXPIRY_INVALID),
            "OP-elsewhere": (dict(audience="someone/else"), REQUEST_AUDIENCE_MISMATCH),
        }
        for identifier, (overrides, _reason) in cases.items():
            self.fx.append_raw(self.fx.sign(self.fx.request_row(id=identifier, **overrides)))
        result = self._ingest("c1")
        self.assertEqual(result.candidates, ())
        expected = {identifier: reason for identifier, (_o, reason) in cases.items()}
        self.assertEqual({d["id"]: d["reason"] for d in result.dropped}, expected)
        self.assertEqual({r["id"]: r["reason"] for r in self._refused()}, expected, "signed: refused and spent")
        again = self._ingest("c2")
        self.assertEqual({s["id"] for s in again.spent}, set(cases))
        self.assertEqual(again.dropped, ())

    def test_the_anchor_is_the_committed_file_on_main_not_the_working_tree(self) -> None:
        intruder = mint_ed25519_key(Path(self.tmp.name) / "intruder", name="k")
        (self.fx.repo / ors.ALLOWED_SIGNERS_PATH).write_text(
            allowed_signers_line("intruder@aria.test", intruder), encoding="utf-8",
        )
        self.fx.append_raw(self.fx.sign(self.fx.request_row(id="OP-self-enrolled"),
                                        key=intruder, principal="intruder@aria.test"))
        result = self._ingest()
        self.assertEqual([(d["id"], d["reason"]) for d in result.dropped],
                         [("OP-self-enrolled", ors.SIGNER_NOT_ENROLLED)])

    def test_an_anchor_off_main_is_a_runner_fault_that_spends_nothing(self) -> None:
        self.fx.record(request_id="OP-1")
        self.fx.commit_files({"apps/hr-service/src/extra.ts": "x\n"}, on_main=False)
        result = self._ingest("c1")
        self.assertEqual([(d["reason"], d["runner_fault"]) for d in result.dropped],
                         [(ors.ALLOWED_SIGNERS_UNAVAILABLE, True)])
        self.assertEqual(_ingestion_rows(self.tools)[-1]["anchor"], {"reason": main_anchor.ANCHOR_NOT_ON_MAIN})
        self.assertEqual(self._refused(), [])
        git(self.fx.repo, "update-ref", main_anchor.MAIN_TRACKING_REF, "HEAD")
        self.assertEqual([e["id"] for e in self._ingest("c2").admitted], ["OP-1"])

    def test_a_drop_is_reported_once_not_every_cycle(self) -> None:
        # GSEC-LOW-009 — a row that stays bad does not flood governance.
        self.fx.append_raw(dict(self.fx.request_row(), id="OP-unsigned"))
        first, second = self._ingest("c1"), self._ingest("c2")
        self.assertEqual(len(_governance(self.tools, ingestion.UNSIGNED_OPERATOR_FEEDBACK_EVENT)), 1)
        self.assertEqual([d["reported_before"] for d in first.dropped + second.dropped], [False, True])

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
        self.assertEqual([(d["reason"], d["runner_fault"]) for d in result.dropped],
                         [(ors.ALLOWED_SIGNERS_UNAVAILABLE, True)])

    def test_scanner_never_bootstraps_a_tools_root(self) -> None:
        bare = Path(self.tmp.name) / "elsewhere"
        bare.mkdir()
        with self.assertRaisesRegex(GovernanceError, "operator_feedback_tools_root_unavailable"):
            scan_operator_feedback(bare)
        self.assertFalse((bare / "aria-tools").exists())


class ChainBreakTests(_Fixture):
    """GSEC-MEDIUM-004 — the synthesizer admits only what the merge owner can vouch for."""

    def test_rows_after_a_chain_break_are_never_admitted(self) -> None:
        before = self.fx.record(request_id="OP-before")
        with (self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME).open("a", encoding="utf-8") as handle:
            handle.write("garbage that is not a ledger row\n")
        after = self.fx.sign(self.fx.request_row(id="OP-after"))
        with (self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME).open("a", encoding="utf-8") as handle:
            import json

            handle.write(json.dumps(dict(after, ledger_hash="sha256:" + "f" * 64)) + "\n")
        result = self._ingest()
        self.assertEqual([e["id"] for e in result.admitted], [before["id"]])
        self.assertEqual([(d["id"], d["reason"]) for d in result.dropped],
                         [(None, ingestion.LEDGER_CHAIN_BROKEN), ("OP-after", ingestion.LEDGER_CHAIN_BROKEN)])


class ConsumeOnceTests(_Fixture):
    """ADR-0018 D3 + review round 2 — spent is keyed on the signed id, from the kernel's own history."""

    def setUp(self) -> None:
        super().setUp()
        self.signed = self.fx.record(request_id="OP-once")

    def test_a_binding_whose_plan_never_started_is_admitted_again(self) -> None:
        self._bind_and_maybe_start("cyc-1", start=False)
        result = self._ingest("cyc-2")
        self.assertEqual([entry["id"] for entry in result.admitted], ["OP-once"])
        self.assertEqual(result.spent, ())

    def test_a_binding_whose_plan_started_spends_the_request(self) -> None:
        self._bind_and_maybe_start("cyc-1", start=True)
        result = self._ingest("cyc-2")
        self.assertEqual(result.admitted, ())
        self.assertEqual([(s["id"], s["reason"]) for s in result.spent], [("OP-once", "consumed_by_started_plan")])
        # A re-signed row under the same id cannot buy a second plan.
        self.fx.append_raw(self.fx.sign(dict(_unsigned_subject(self.signed), request="again")))
        again = self._ingest("cyc-3")
        self.assertEqual(again.admitted, ())
        self.assertEqual([d["reason"] for d in again.dropped], [ingestion.REQUEST_ID_REUSED])

    def test_a_copy_at_a_new_position_with_a_new_ledger_hash_is_still_spent(self) -> None:
        # Round 1 keyed the spend on (id, ledger_hash) and the reused-id set on
        # rows still in the feedback file; ledger_hash is unsigned and
        # positional. With the original gone from the feedback ledger (rewritten
        # or rolled back) the copy was a fresh request (AISAFETY-HIGH-001).
        from aria_kernel.feedback_store import record_operator_feedback

        self._bind_and_maybe_start("cyc-1", start=True)
        (self.tools / ofs.OPERATOR_FEEDBACK_LEDGER_NAME).unlink()
        record_operator_feedback(tool_id="t", run_id="r", finding_id="f", verdict="false_positive",
                                 severity="low", note="a row that moves the copy's position", base_dir=self.tools)
        copy = self.fx.append_raw(_signed_copy(self.signed))
        self.assertNotEqual(copy["ledger_hash"], self.signed["ledger_hash"])
        result = self._ingest("cyc-2")
        self.assertEqual(result.admitted, ())
        self.assertEqual({(s["id"], s["reason"]) for s in result.spent}, {("OP-once", "consumed_by_started_plan")})

    def test_a_refused_request_is_spent_and_a_fault_cannot_spend(self) -> None:
        candidate = next(c for c in scan_operator_feedback(self.fx.repo, base_dir=self.tools, cycle_id="c1"))
        refusal = dict(base_dir=self.tools, cycle_id="c1", request_id=candidate["candidate_id"],
                       request_ledger_hash=candidate["row_ledger_hash"], subject_digest=candidate["subject_digest"],
                       finding_id="F-007", refused_surfaces=[])
        for fault in ("checkout_unavailable", "finding_store_unreadable", "finding_store_unavailable"):
            with self.subTest(fault=fault), self.assertRaisesRegex(GovernanceError, "refusal_reason_unknown"):
                ingestion.record_request_refused(reason=fault, **refusal)
        ingestion.record_request_refused(reason="finding_not_open", **refusal)
        result = self._ingest("c2")
        self.assertEqual(result.admitted, ())
        self.assertEqual([s["reason"] for s in result.spent], ["refused"])


class CopyAndRollbackTests(_Fixture):
    """GSEC-MEDIUM-001 — copies, forged positions and a rolled-back store."""

    def test_a_copy_written_before_the_original_is_one_request(self) -> None:
        row = self.fx.sign(self.fx.request_row(id="OP-early"))
        first = self.fx.append_raw(row)    # the copy an attacker placed first
        self.fx.append_raw(dict(row))      # the operator's publish arrives later
        result = self._ingest("c1")
        self.assertEqual([(e["id"], e["ledger_hash"]) for e in result.admitted], [("OP-early", first["ledger_hash"])])
        self.assertEqual([d["reason"] for d in result.dropped], [ingestion.REQUEST_DUPLICATE_COPY])
        self._bind_and_maybe_start("c2", start=True, plan_id="plan-early")
        later = self._ingest("c3")
        self.assertEqual(later.admitted, ())
        self.assertEqual({s["id"] for s in later.spent}, {"OP-early"})

    def test_two_subjects_under_one_id_are_both_refused_in_any_order(self) -> None:
        for order in ((1, 2), (2, 1)):
            with self.subTest(order=order):
                fixture = OperatorRequestFixture(Path(self.tmp.name) / f"order-{order[0]}")
                fixture.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
                rows = {n: fixture.sign(fixture.request_row(id="OP-twin", request=f"variant {n}")) for n in (1, 2)}
                for n in order:
                    fixture.append_raw(rows[n])
                result = ingestion.ingest_operator_feedback(base_dir=fixture.tools, cycle_id="c", repo_root=fixture.repo)
                self.assertEqual(result.admitted, ())
                self.assertEqual([d["reason"] for d in result.dropped], [ingestion.REQUEST_ID_REUSED] * 2)

    def test_a_rolled_back_store_cannot_readmit_a_request_after_it_expires(self) -> None:
        self.fx.record(request_id="OP-rollback", expires_in_hours=2)
        self._bind_and_maybe_start("c1", start=True, plan_id="plan-rollback")
        # aria/state rolled back past the spend: the kernel's history is gone.
        ingestion.ingestion_ledger_path(self.tools).unlink()
        (self.tools / "plans" / "events.jsonl").unlink()
        # Inside the signed window the history was the only memory: that is
        # the bound the expiry sets, and check 12's merged-once proof backs it.
        self.assertEqual([e["id"] for e in self._ingest("c2").admitted], ["OP-rollback"])
        later = datetime.now(timezone.utc) + timedelta(hours=3)
        result = self._ingest("c3", now=later)
        self.assertEqual(result.admitted, ())
        self.assertEqual([d["reason"] for d in result.dropped], [REQUEST_EXPIRED])


class SynthesisBindingTests(_Fixture):
    def test_provider_binds_the_selected_synthesis_to_its_ingestion(self) -> None:
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
            {"id": "OP-bind", "ledger_hash": signed["ledger_hash"], "signer": self.fx.principal,
             "subject_digest": ors.request_subject_digest(signed)},
        ])
        selected = _governance(self.tools, "plan_candidate_source_selected")[-1]["details"]
        self.assertEqual(selected["operator_feedback_binding_hash"], bound["ledger_hash"])
        self.assertEqual(selected["operator_feedback_ingestion_hash"], scan["ledger_hash"])

    def test_binding_records_an_absent_ingestion_rather_than_inventing_one(self) -> None:
        with mock.patch("aria_kernel.plan_synthesizer.rank_candidate_sources",
                        return_value=[{"candidate_id": "ORPHAN-HIGH-1", "source_type": "orphan_finding",
                                       "severity": "HIGH", "raw_id": "1", "title_hint": "x",
                                       "evidence": [f"{GROUNDED_FILE}:12"]}]):
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
        self.signed = self.fx.record(request_id="OP-obs")
        self.content = self._bind_and_maybe_start("cyc-obs", start=True, plan_id="plan-obs")
        self.state = fold_plan_state(plan_id="plan-obs", base_dir=self.tools)
        self.anchor = ors.allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools)[0]

    def _observe(self, *, plan_started=None, ingestion_rows=None, feedback_rows=None, plan_events=None,
                 allowed_signers=b"default", now=None):
        return observe_operator_feedback_for_plan(
            plan_id="plan-obs",
            plan_started=self.state["plan_started"] if plan_started is None else plan_started,
            ingestion_rows=_ingestion_rows(self.tools) if ingestion_rows is None else ingestion_rows,
            feedback_rows=_feedback_rows(self.tools) if feedback_rows is None else feedback_rows,
            plan_events=_plan_events(self.tools) if plan_events is None else plan_events,
            allowed_signers=self.anchor if allowed_signers == b"default" else allowed_signers,
            now=now,
        )

    def test_the_walk_closes_with_no_key_material_anywhere_on_the_lane(self) -> None:
        self.assertEqual([p for p in self.tools.rglob("*") if p.is_file() and "secrets" in p.parts], [])
        observation = self._observe()
        self.assertTrue(observation["operator_feedback_verified"], observation)
        self.assertNotIn("operator_feedback_unavailable_reason", observation)
        self.assertEqual(observation["operator_feedback_plan_started_hash"], self.state["plan_started"]["content_hash"])
        self.assertEqual(observation["operator_feedback_consumed_row_hashes"], (self.signed["ledger_hash"],))
        self.assertEqual(observation["operator_feedback_consumed_signers"], (self.fx.principal,))
        evidence = safety._PreMergeEvidence((), **observation)
        self.assertTrue(evidence.operator_feedback_verified)

    def test_a_signer_the_anchor_no_longer_enrols_fails(self) -> None:
        successor = mint_ed25519_key(Path(self.tmp.name) / "successor", name="k")
        # ADR-0023 — a rotation is a signed enrolment by a key the parent enrols.
        self.fx.enrol({ors.ALLOWED_SIGNERS_PATH: allowed_signers_line("successor@aria.test", successor)})
        revoked = ors.allowed_signers_for_checkout(self.fx.repo, base_dir=self.fx.tools)[0]
        self.assertIsNotNone(revoked)
        self.assertEqual(self._observe(allowed_signers=revoked)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ors.SIGNER_NOT_ENROLLED)
        self.assertEqual(self._observe(allowed_signers=None)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unsigned:" + ors.ALLOWED_SIGNERS_UNAVAILABLE)

    def test_an_expired_request_cannot_merge(self) -> None:
        later = datetime.now(timezone.utc) + timedelta(hours=200)
        self.assertEqual(self._observe(now=later)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_refused:" + REQUEST_EXPIRED)

    def test_a_request_merged_through_another_plan_cannot_merge_again(self) -> None:
        other_content = dict(self.content, title="a second plan for the same request")
        candidate = {"source_type": "operator_feedback", "candidate_id": "OP-obs",
                     "row_ledger_hash": self.signed["ledger_hash"], "signer": self.fx.principal,
                     "subject_digest": ors.request_subject_digest(self.signed)}
        ingestion.bind_plan_synthesis(base_dir=self.tools, cycle_id="cyc-other",
                                      plan_content=other_content, candidate=candidate)
        start_plan(plan_id="plan-other", plan_content=other_content, initial_revision_id="plan-other-r1",
                   base_dir=self.tools, workspace_root=self.fx.repo)
        events = _plan_events(self.tools) + [{"plan_id": "plan-other", "event_type": "implementation_merged",
                                              "payload": {}}]
        self.assertEqual(self._observe(plan_events=events)["operator_feedback_unavailable_reason"], ALREADY_MERGED)
        merged_self = _plan_events(self.tools) + [{"plan_id": "plan-obs", "event_type": "implementation_merged",
                                                   "payload": {}}]
        self.assertTrue(self._observe(plan_events=merged_self)["operator_feedback_verified"])

    def test_every_gap_is_a_named_reason(self) -> None:
        hand_started = {"plan_content": dict(self.content, title="hand-authored"),
                        "content_hash": content_hash(dict(self.content, title="hand-authored"))}
        rows = _ingestion_rows(self.tools)
        scan_row = next(r for r in rows if r["row_type"] == ingestion.INGESTION_ROW_TYPE)
        unbound_ingestion = [dict(r, ingestion_ledger_hash=None) if r["row_type"] == ingestion.SYNTHESIS_BOUND_ROW_TYPE else r
                             for r in rows]
        mismatched_started = {"plan_content": dict(self.content, provenance_refs=[ingestion.PROVENANCE_REF_PREFIX + "OP-other"]),
                              "content_hash": self.state["plan_started"]["content_hash"]}
        swapped = [dict(r, request="swapped under the same id and position") if r.get("id") == "OP-obs" else r
                   for r in _feedback_rows(self.tools)]
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
        forged = [dict(r, admitted=[]) if r["ledger_hash"] == scan_row["ledger_hash"] else r for r in rows]
        self.assertEqual(self._observe(ingestion_rows=forged)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumption_mismatch")
        self.assertEqual(self._observe(feedback_rows=swapped)["operator_feedback_unavailable_reason"],
                         "operator_feedback_consumed_row_unavailable")

    def test_merge_authority_wrapper_reads_the_anchor_at_the_trusted_commit(self) -> None:
        from aria_kernel.merge_authority import _capture_pre_merge_operator_feedback

        rows = {"operator_feedback_ingestion": _ingestion_rows(self.tools),
                "operator_feedback": _feedback_rows(self.tools),
                "plan_convergence_events": _plan_events(self.tools)}
        head = git(self.fx.repo, "rev-parse", "HEAD").strip()
        observation = _capture_pre_merge_operator_feedback(
            plan_id="plan-obs", state=self.state, rows=rows, workspace=self.fx.repo, trust_sha=head,
            tools=self.fx.tools,
        )
        self.assertTrue(observation["operator_feedback_verified"], observation)
        root_commit = subprocess.run(["git", "rev-list", "--max-parents=0", "HEAD"], cwd=self.fx.repo,
                                     check=True, capture_output=True, text=True).stdout.strip()
        before_anchor = _capture_pre_merge_operator_feedback(
            plan_id="plan-obs", state=self.state, rows=rows, workspace=self.fx.repo, trust_sha=root_commit,
            tools=self.fx.tools,
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
        result = self._run(self._bound(operator_feedback_consumed_row_hashes=(), operator_feedback_consumed_signers=()))
        self.assertTrue(result.passed, result.reason)

    def test_named_capture_reasons_and_missing_fields_refuse(self) -> None:
        cases = {
            "operator_feedback_synthesis_binding_unavailable": dict(
                operator_feedback_unavailable_reason="operator_feedback_synthesis_binding_unavailable",
                operator_feedback_verified=False),
            ALREADY_MERGED: dict(operator_feedback_unavailable_reason=ALREADY_MERGED, operator_feedback_verified=False),
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
