"""Y7 (ORPHAN-708) — the panel's clearing verdict gains an EFFECT.

Pre-Y7 OUTCOME_RESOLVED only closed the triage record: the dead request
stayed terminal and its work was silently lost ("resolved" meant "filed").
Operator directive 2026-08-17: HUMAN_REQUIRED must be the exception —
operational deaths (lease exhaustion, anchor staleness) are resolved by
the agent panel itself; the operator keeps policy boundaries only.

Deliberate-breakage pins:
- a resolve quorum with disposition re_mint mints EXACTLY ONE successor
  with remint_of lineage (idempotent across re-folds);
- a resolve quorum with NO/SPLIT disposition on an operational kind does
  NOT close the record — it stamps escalate_operator (CRITICAL, loud);
- quorum-refuse on an operational kind is the panel handing the item to a
  human, stamped the same way; the sweep skips stamped records;
- the anchor_stale kind is admitted TOGETHER with its producer, capped.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel import human_required_adjudication as hra
from aria_kernel.human_required import (
    ANCHOR_STALE_SWEEP_CAP,
    record_human_required,
    sweep_lease_lifecycle_for_human_required,
)
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture


class VocabularyPins(unittest.TestCase):
    def test_dispositions_are_a_closed_set(self) -> None:
        self.assertEqual(
            hra.PANEL_DISPOSITIONS,
            {"re_mint", "drop_with_reason", "escalate_operator"},
        )
        self.assertEqual(
            hra.OPERATIONAL_DISPOSITION_KINDS, {"lease_lifecycle", "anchor_stale"},
        )

    def test_remint_budget_is_separate_from_panel_reopen_budget(self) -> None:
        # Two counters, deliberately NOT shared: a stale PANEL must not eat
        # the WORK's retry budget.
        self.assertEqual(hra.MAX_REQUEST_REMINTS, 2)
        self.assertEqual(hra.MAX_PANEL_REOPENS, 2)

    def test_anchor_stale_kind_is_admitted(self) -> None:
        verdict = hra.escalation_adjudicability(
            {"context": {"kind": "anchor_stale", "request_id": "AIR-x"}},
        )
        self.assertTrue(verdict.adjudicable)


class _PanelCase(unittest.TestCase):
    KIND = "lease_lifecycle"

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-y7-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        self.escalation_id = "AIR-dead-work-1"
        self._seed_dead_work_request(self.escalation_id)
        record_human_required(
            request_id=self.escalation_id,
            reason="three claims released without delivering",
            context={"kind": self.KIND, "request_id": self.escalation_id},
            base_dir=self.tools,
        )

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _seed_dead_work_request(self, request_id: str) -> None:
        requests_path = self.tools / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_fixture(
            requests_path,
            {
                "$schema": "aria/agent-invocation-request/v1",
                "schema_version": 1,
                "request_id": request_id,
                "role": "challenger_plan",
                "target_agent": "aria-challenger-planner",
                "suggested_prompt": "plan the thing",
                "must_satisfy": [{"id": "S1"}],
                "evidence_refs": ["rev-1"],
                "allowed_scope": ["aria-kernel/**"],
                "expected_output_path": str(self.tools / f"out-{request_id}.json"),
                "state": "pending",
                "created_at": "2026-08-17T00:00:00Z",
            },
            expected_surface="agent_invocation_requests",
        )

    def _open(self) -> list[str]:
        row = hra.open_adjudication(
            escalation_request_id=self.escalation_id,
            record={"context": {"kind": self.KIND}},
            base_dir=self.tools,
        )
        return [str(r) for r in row["request_ids"]]

    def _seed_opinion(
        self, request_id: str, *, agent_id: str, verdict: str,
        disposition: str | None = None,
    ) -> None:
        invocations = self.tools / "agent-invocations"
        invocations.mkdir(parents=True, exist_ok=True)
        payload: dict = {"verdict": verdict, "rationale": f"{agent_id} says {verdict}"}
        if disposition is not None:
            payload["disposition"] = disposition
        output = invocations / f"{request_id}.opinion.json"
        output.write_text(json.dumps(payload), encoding="utf-8")
        append_declared_jsonl(
            invocations / "claims.jsonl",
            {
                "request_id": request_id,
                "claim_id": f"claim-{request_id}",
                "agent_id": agent_id,
            },
            expected_surface="agent_invocation_claims",
        )
        append_declared_jsonl(
            invocations / "results.jsonl",
            {
                "request_id": request_id,
                "role": hra.ADJUDICATION_ROLE,
                "status": "accepted",
                "agent_id": agent_id,
                "output_path": output.as_posix(),
                "output_hash": "sha256:" + "0" * 64,
            },
            expected_surface="agent_invocation_results",
        )

    def _record(self) -> dict:
        path = self.tools / "human-required" / f"{self.escalation_id}.json"
        return json.loads(path.read_text(encoding="utf-8"))

    def _governance_kinds(self) -> list[str]:
        gov = self.tools / "governance.jsonl"
        if not gov.exists():
            return []
        return [json.loads(l)["kind"] for l in gov.read_text(encoding="utf-8").splitlines() if l.strip()]

    def _successors(self) -> list[dict]:
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        return [
            r for r in list_agent_invocation_requests(base_dir=self.tools)
            if str(r.get("remint_of") or "") == self.escalation_id
        ]


class ReMintDisposition(_PanelCase):
    def test_resolve_quorum_with_re_mint_mints_one_successor(self) -> None:
        for rid, agent in zip(self._open(), ("judge-a", "judge-b", "judge-c")):
            self._seed_opinion(
                rid, agent_id=agent, verdict=hra.RESOLVE_VERDICT,
                disposition=hra.DISPOSITION_RE_MINT,
            )
        verdict = hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertTrue(verdict.clears_escalation)
        self.assertEqual(verdict.disposition, hra.DISPOSITION_RE_MINT)
        successors = self._successors()
        self.assertEqual(len(successors), 1)
        self.assertNotEqual(successors[0]["request_id"], self.escalation_id)
        record = self._record()
        self.assertEqual(record["status"], "resolved")
        self.assertIn("re_mint", record["resolution_note"])
        # Idempotent: a second fold finds the existing successor, mints none.
        hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(len(self._successors()), 1)

    def test_split_disposition_fails_safe_to_operator(self) -> None:
        rids = self._open()
        self._seed_opinion(rids[0], agent_id="judge-a", verdict=hra.RESOLVE_VERDICT,
                           disposition=hra.DISPOSITION_RE_MINT)
        self._seed_opinion(rids[1], agent_id="judge-b", verdict=hra.RESOLVE_VERDICT,
                           disposition=hra.DISPOSITION_DROP)
        self._seed_opinion(rids[2], agent_id="judge-c", verdict=hra.RESOLVE_VERDICT)
        verdict = hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertIsNone(verdict.disposition)
        record = self._record()
        # The record does NOT close — it is stamped for the operator, loud.
        self.assertEqual(record["status"], "open")
        self.assertEqual(record["panel_disposition"], hra.DISPOSITION_ESCALATE_OPERATOR)
        self.assertEqual(record["severity"], "CRITICAL")
        self.assertIn("human_required_escalated_to_operator", self._governance_kinds())
        self.assertEqual(self._successors(), [])

    def test_invalid_disposition_value_blocks_the_opinion(self) -> None:
        rids = self._open()
        self._seed_opinion(rids[0], agent_id="judge-a", verdict=hra.RESOLVE_VERDICT,
                           disposition=hra.DISPOSITION_RE_MINT)
        invocations = self.tools / "agent-invocations"
        bad = invocations / f"{rids[1]}.opinion.json"
        bad.write_text(json.dumps({"verdict": "resolve", "disposition": "reboot"}), encoding="utf-8")
        append_declared_jsonl(
            invocations / "claims.jsonl",
            {"request_id": rids[1], "claim_id": f"claim-{rids[1]}", "agent_id": "judge-b"},
            expected_surface="agent_invocation_claims",
        )
        append_declared_jsonl(
            invocations / "results.jsonl",
            {"request_id": rids[1], "role": hra.ADJUDICATION_ROLE, "status": "accepted",
             "agent_id": "judge-b", "output_path": bad.as_posix(),
             "output_hash": "sha256:" + "0" * 64},
            expected_surface="agent_invocation_results",
        )
        verdict = hra.fold_adjudication(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertIn("panel_incomplete", verdict.reason)


class DropAndRefuse(_PanelCase):
    def test_drop_with_reason_resolves_and_discloses(self) -> None:
        for rid, agent in zip(self._open(), ("judge-a", "judge-b", "judge-c")):
            self._seed_opinion(rid, agent_id=agent, verdict=hra.RESOLVE_VERDICT,
                               disposition=hra.DISPOSITION_DROP)
        hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        record = self._record()
        self.assertEqual(record["status"], "resolved")
        self.assertIn("drop_with_reason", record["resolution_note"])
        self.assertIn("human_required_dropped_with_reason", self._governance_kinds())
        self.assertEqual(self._successors(), [])

    def test_quorum_refuse_hands_the_item_to_a_human_loudly(self) -> None:
        for rid, agent in zip(self._open(), ("judge-a", "judge-b", "judge-c")):
            self._seed_opinion(rid, agent_id=agent, verdict=hra.REFUSE_VERDICT)
        verdict = hra.adjudicate_human_required(
            escalation_request_id=self.escalation_id, base_dir=self.tools,
        )
        self.assertEqual(verdict.outcome, hra.OUTCOME_REFUSED)
        record = self._record()
        self.assertEqual(record["status"], "open")
        self.assertEqual(record["severity"], "CRITICAL")
        self.assertEqual(record["panel_disposition"], hra.DISPOSITION_ESCALATE_OPERATOR)
        # The sweep never re-panels an operator-stamped record.
        summary = hra.sweep_human_required_adjudications(base_dir=self.tools)
        reasons = {s.get("reason") for s in summary["skipped"]}
        self.assertIn("panel_escalated_to_operator", reasons)


class AnchorStaleProducer(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-y7-anchor-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _seed_stale_request(self, request_id: str, *, remint_of: str | None = None) -> None:
        requests_path = self.tools / "agent-invocations" / "requests.jsonl"
        requests_path.parent.mkdir(parents=True, exist_ok=True)
        row = {
            "$schema": "aria/agent-invocation-request/v1",
            "schema_version": 1,
            "request_id": request_id,
            "role": "challenger_plan",
            "target_agent": "aria-challenger-planner",
            "suggested_prompt": "stale work",
            "must_satisfy": [{"id": "S1"}],
            "evidence_refs": [],
            "allowed_scope": ["aria-kernel/**"],
            "expected_output_path": str(self.tools / f"out-{request_id}.json"),
            "state": "pending",
            # Far past the 3-day anchor window → derives ANCHOR_STALE.
            "created_at": "2026-08-01T00:00:00Z",
        }
        if remint_of:
            row["remint_of"] = remint_of
        append_declared_fixture(
            requests_path, row, expected_surface="agent_invocation_requests",
        )
        # ANCHOR_STALE is stamped by the selection boundary (next_pending's
        # git evaluation writes a claims row); derive_request_state reads
        # that row, never the request's age. Mirror the production shape.
        append_declared_fixture(
            self.tools / "agent-invocations" / "claims.jsonl",
            {
                "schema_version": 1,
                "event": "anchor_stale",
                "claim_id": f"anchor-{request_id}",
                "request_id": request_id,
                "at": "2026-08-05T00:00:00+00:00",
            },
            expected_surface="agent_invocation_claims",
        )

    def test_stale_requests_gain_records_up_to_the_cap(self) -> None:
        for n in range(ANCHOR_STALE_SWEEP_CAP + 2):
            self._seed_stale_request(f"AIR-stale-{n}")
        summary = sweep_lease_lifecycle_for_human_required(base_dir=self.tools)
        anchor_records = [
            r for r in summary["created"]
            if (r.get("context") or {}).get("kind") == "anchor_stale"
        ]
        self.assertEqual(len(anchor_records), ANCHOR_STALE_SWEEP_CAP)

    def test_a_request_with_a_remint_successor_is_recovered_not_escalated(self) -> None:
        self._seed_stale_request("AIR-stale-parent")
        self._seed_stale_request("AIR-stale-child", remint_of="AIR-stale-parent")
        summary = sweep_lease_lifecycle_for_human_required(base_dir=self.tools)
        anchor_ids = {
            r.get("request_id") for r in summary["created"]
            if (r.get("context") or {}).get("kind") == "anchor_stale"
        }
        self.assertNotIn("AIR-stale-parent", anchor_ids)
        reasons = {(s.get("request_id"), s.get("reason")) for s in summary["skipped"]}
        self.assertIn(("AIR-stale-parent", "remint_successor_exists"), reasons)


if __name__ == "__main__":
    unittest.main()
