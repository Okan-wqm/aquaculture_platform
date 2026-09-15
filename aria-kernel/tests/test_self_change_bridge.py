"""B6 — `propose_self_change` has a kernel caller: the mission's next_action is dispatched.

CONFIRMED LIVE 2026-09-12: `open_self_improvement_missions` minted missions
whose `next_action == SELF_CHANGE_NEXT_ACTION`; the orchestrator's mission
branch forwarded that string as free prompt text (`recommended_action`) to
aria-autonomy-planner under the generic `queue_item_projected` contract, and
no code path ever mapped it onto `propose_self_change`. The invariants
I-V12-SELF-01/02 proved the module in isolation — the ORPHAN-694 class.

Pins:
* the mission branch mints the SELF-CHANGE contract for a self_improvement
  mission (must_satisfy = evidence_paths / problem / proposed_change; prompt
  schema `aria/self-change-request/v1`; kernel-scope allowed_scope) and keeps
  the queue contract for every other mission;
* the accepted-result path calls `propose_self_change` with the answer's
  structured fields: proposal + HUMAN_REQUIRED open, `self_change_proposed`
  on governance, the mission parked in HUMAN_REQUIRED;
* an authority surface in the answer is refused BY THE KERNEL
  (`self_change_authority_surface_refused`), no proposal, mission untouched;
* TWO IN-FLIGHT REQUESTS for one mission are routine (the scheduler never
  moves a DISCOVERED mission; the queue de-duplicates per pending item), so
  the accept-time boundary judges the mission AS IT IS: a second accepted
  answer is refused by name (`self_change_mission_moved_on`,
  `self_change_mission_operator_held`, `self_change_adjudication_already_open`),
  the mission — the operator's `next_action` included — is untouched, and
  exactly one adjudication stands; and the drain does not mint the second
  request in the first place while the first is in flight;
* a malformed answer is named field by field by ONE validator that the
  executor's pre-submit gate and the bridge both use;
* `self_improvement` is a ranked mission source;
* every `*_NEXT_ACTION` constant in the kernel is in exactly one of the two
  dispatch tables; a contract pointer is compared against by a production
  module other than the CLI and the table itself; a generic-projection
  pointer carries a non-empty reason and a named consumer that provably
  reads the mission — minted-but-never-dispatched fails either way.
"""
from __future__ import annotations

import ast
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import autonomy_orchestrator as ao
from aria_kernel import self_change_bridge as scb
from aria_kernel.agent_contract import RESPONSE_SCHEMA
from aria_kernel.agent_invocations import _invoke_bridges_for_result, create_agent_invocation_request
from aria_kernel.control_reachability import kernel_root, production_sources
from aria_kernel.human_required import list_human_required, resolve_human_required
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.mission import fold_mission, open_mission, transition_mission
from aria_kernel.mission_dispatch import GENERIC_PROJECTION_POINTERS, NEXT_ACTION_CONTRACTS, contract_for_mission
from aria_kernel.mission_scheduler import SOURCE_RANK
from aria_kernel.proposal import list_proposals
from aria_kernel.self_improvement import (
    SELF_CHANGE_MISSION_REFUSALS,
    SELF_CHANGE_MISSION_REFUSED_EVENT,
    SELF_CHANGE_NEXT_ACTION,
    SELF_CHANGE_PROPOSED_EVENT,
    SELF_CHANGE_REFUSED_EVENT,
    SELF_IMPROVEMENT_SOURCE_KIND,
    is_self_change_mission,
    propose_self_change,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from aria_kernel.workspace import canonical_identity

from tests._helpers.declared_fixtures import append_declared_fixture

_REPO = Path(__file__).resolve().parents[2]
_POC = _REPO / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ws = self.root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def governance_rows(self, kind: str) -> list[dict]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        return [row for row in load_declared_jsonl(path, expected_surface="tools_governance") if row.get("kind") == kind]

    def governance_kinds(self) -> list[str]:
        path = self.tools / "governance.jsonl"
        if not path.exists():
            return []
        return [str(row.get("kind")) for row in load_declared_jsonl(path, expected_surface="tools_governance")]

    def mission_refusals(self) -> list[str]:
        return [str(row["details"]["reason"]) for row in self.governance_rows(SELF_CHANGE_MISSION_REFUSED_EVENT)]

    def self_improvement_mission(self, key: str = "doctor_fail:gateway_heartbeat_fresh") -> str:
        # The live shape: a mission `open_self_improvement_missions` mints.
        row = open_mission(source_kind=SELF_IMPROVEMENT_SOURCE_KIND, source_id=key, repo_hash=canonical_identity(self.ws),
                           title=f"Doctor organ {key} failing", next_action=SELF_CHANGE_NEXT_ACTION,
                           wake_condition={"kind": "evidence", "key": key}, priority=1, base_dir=self.tools)
        return str(row["mission_id"])


class TheMissionBranchMintsTheContract(_Store):
    def _drain(self, mission_id: str, queue_item_id: str = "qi-s1") -> dict:
        captured: dict = {}

        def fake_create(**kw):  # type: ignore[no-untyped-def]
            captured.update(kw)
            return {"request_id": "AIR-x"}

        item = {"queue_item_id": queue_item_id, "pressure_id": f"mission:{mission_id}", "source_cycle_id": "cyc-1",
                "recommended_action": SELF_CHANGE_NEXT_ACTION, "candidate_tools": []}
        with patch.object(ao, "read_pending", return_value=[item]), patch.object(ao, "mark_consumed"), \
             patch.object(ao, "_find_projected_queue_request", return_value=None), \
             patch("aria_kernel.agent_invocations.create_agent_invocation_request", fake_create), \
             patch("aria_kernel.tool_registry.append_tools_governance"):
            ao._drain_next_cycle_queue(base_dir=self.tools, daemon_agent_id="t", limit=1, workspace_root=self.ws)
        return captured

    def test_the_live_shape_a_self_improvement_mission_mints_the_self_change_contract(self) -> None:
        mission_id = self.self_improvement_mission()
        captured = self._drain(mission_id)
        self.assertEqual({item["id"] for item in captured["must_satisfy"]}, set(scb.SELF_CHANGE_CONTRACT_IDS))
        self.assertTrue(scb.is_self_change_request({"must_satisfy": captured["must_satisfy"]}))
        prompt = json.loads(captured["suggested_prompt"])
        self.assertEqual(prompt["$schema"], scb.SELF_CHANGE_REQUEST_SCHEMA)
        self.assertEqual((prompt["mission_id"], prompt["queue_item_id"], prompt["next_action"]), (mission_id, "qi-s1", SELF_CHANGE_NEXT_ACTION))
        self.assertEqual(prompt["response_details_fields"], list(scb.SELF_CHANGE_FIELDS))
        self.assertEqual(captured["allowed_scope"], scb.self_change_allowed_scope())
        self.assertEqual((captured["target_agent"], captured["role"]), (scb.SELF_CHANGE_TARGET_AGENT, scb.SELF_CHANGE_ROLE))
        self.assertEqual(captured["pressure_event_id"], f"mission:{mission_id}")

    def test_every_other_mission_keeps_the_queue_contract(self) -> None:
        row = open_mission(source_kind="service_hardening", source_id="auth-service", repo_hash="rh-1", title="Harden auth-service",
                           next_action="Harden auth-service against finding F-1", wake_condition={"kind": "evidence", "key": "finding:F-1"},
                           target_project="auth-service", base_dir=self.tools)
        captured = self._drain(str(row["mission_id"]))
        self.assertEqual([item["id"] for item in captured["must_satisfy"]], ["queue_item_projected"])
        self.assertEqual(json.loads(captured["suggested_prompt"])["$schema"], "aria/next-cycle-queue-request/v1")
        self.assertFalse(scb.is_self_change_request({"must_satisfy": captured["must_satisfy"]}))

    def test_a_foreign_mission_carrying_the_pointer_is_disclosed_not_projected(self) -> None:
        # The pointer alone is not the discriminator: a service_hardening
        # mission minted with `propose_self_change` is a producer defect, and
        # the drain discloses it (`next_cycle_queue_projection_failed`)
        # instead of handing the planner the generic contract.
        row = open_mission(source_kind="service_hardening", source_id="farm-service", repo_hash="rh-1", title="Harden farm-service",
                           next_action=SELF_CHANGE_NEXT_ACTION, wake_condition={"kind": "evidence", "key": "x"},
                           target_project="farm-service", base_dir=self.tools)
        disclosed: list[tuple[str, dict]] = []
        item = {"queue_item_id": "qi-f1", "pressure_id": f"mission:{row['mission_id']}", "source_cycle_id": "cyc-1",
                "recommended_action": SELF_CHANGE_NEXT_ACTION, "candidate_tools": []}
        with patch.object(ao, "read_pending", return_value=[item]), patch.object(ao, "mark_consumed"), \
             patch.object(ao, "_find_projected_queue_request", return_value=None), \
             patch("aria_kernel.agent_invocations.create_agent_invocation_request") as create, \
             patch("aria_kernel.tool_registry.append_tools_governance", side_effect=lambda _r, kind, details: disclosed.append((kind, details))):
            consumed = ao._drain_next_cycle_queue(base_dir=self.tools, daemon_agent_id="t", limit=1, workspace_root=self.ws)
        self.assertEqual((consumed, create.call_count), (0, 0))
        self.assertEqual([kind for kind, _ in disclosed], ["next_cycle_queue_projection_failed"])
        self.assertIn("self_change_pointer_on_foreign_mission", disclosed[0][1]["error"])

    def test_the_issue_triage_pointer_is_the_generic_projection_by_stated_decision(self) -> None:
        from aria_kernel.gateway.router import ISSUE_MISSION_NEXT_ACTION, ISSUE_MISSION_SOURCE_KIND

        self.assertNotIn(ISSUE_MISSION_NEXT_ACTION, NEXT_ACTION_CONTRACTS, "the contract table holds builders only; no None escape hatch")
        entry = GENERIC_PROJECTION_POINTERS[ISSUE_MISSION_NEXT_ACTION]
        self.assertEqual((entry.source_kind, entry.consumer), (ISSUE_MISSION_SOURCE_KIND, "aria_kernel.plan_synthesizer:scan_github_issue_missions"))
        self.assertTrue(entry.reason.strip())
        self.assertIsNone(contract_for_mission(mission_row={"source_kind": ISSUE_MISSION_SOURCE_KIND, "next_action": ISSUE_MISSION_NEXT_ACTION},
                                               queue_item_id="qi-i1", source_cycle_id=None))

    def test_a_mission_with_a_request_in_flight_is_not_asked_the_same_contract_twice(self) -> None:
        # The live shape behind the two-in-flight-requests defect: cycle 1
        # selects the DISCOVERED mission and the drain mints R1; nothing moves
        # the mission until R1 is answered, so cycle 2 selects it again and
        # `append_pending` (per PENDING item) hands the drain a fresh item.
        # The drain must consume that item against R1, not mint R2.
        mission_id = self.self_improvement_mission()

        def drain(queue_item_id: str) -> int:
            item = {"queue_item_id": queue_item_id, "pressure_id": f"mission:{mission_id}", "source_cycle_id": "cyc-1",
                    "recommended_action": SELF_CHANGE_NEXT_ACTION, "candidate_tools": []}
            with patch.object(ao, "read_pending", return_value=[item]), patch.object(ao, "mark_consumed"), \
                 patch.object(ao, "_find_projected_queue_request", return_value=None):
                return ao._drain_next_cycle_queue(base_dir=self.tools, daemon_agent_id="t", limit=1, workspace_root=self.ws)

        from aria_kernel.agent_invocations import list_agent_invocation_requests

        self.assertEqual(drain("qi-c1"), 1)
        first = list_agent_invocation_requests(base_dir=self.tools)
        self.assertEqual(len(first), 1)
        self.assertEqual(drain("qi-c2"), 1, "the second item is consumed, against the standing request")
        self.assertEqual(len(list_agent_invocation_requests(base_dir=self.tools)), 1, "no second request for the same contract")
        held = self.governance_rows("next_cycle_queue_item_mission_request_in_flight")
        self.assertEqual([(row["details"]["queue_item_id"], row["details"]["request_id"], row["details"]["request_state"]) for row in held],
                         [("qi-c2", first[0]["request_id"], "PENDING")])
        self.assertEqual(held[0]["details"]["contract_ids"], sorted(scb.SELF_CHANGE_CONTRACT_IDS))
        # A verdict releases the hold: a REJECTED (or a refused-then-ACCEPTED)
        # answer leaves the mission DISCOVERED, and the re-ask is the intent.
        append_declared_fixture(self.tools / "agent-invocations" / "results.jsonl",
                                {"schema_version": 1, "request_id": first[0]["request_id"], "status": "rejected"},
                                expected_surface="agent_invocation_results")
        self.assertEqual(drain("qi-c3"), 1)
        self.assertEqual(len(list_agent_invocation_requests(base_dir=self.tools)), 2, "a terminal request does not hold the mission")

    def test_a_self_improvement_mission_whose_pointer_moved_on_is_not_a_self_change(self) -> None:
        # ONE discriminator for both doors — the mint (mission_dispatch) and
        # the accept-time boundary (propose_self_change) — owned by the
        # module that owns both constants. Source kind alone lies (the
        # pointer an adjudication replaced), and so does the pointer alone
        # (a foreign mission carrying it).
        self.assertFalse(is_self_change_mission({"source_kind": SELF_IMPROVEMENT_SOURCE_KIND, "next_action": "Operator adjudicates"}))
        self.assertFalse(is_self_change_mission({"source_kind": "service_hardening", "next_action": SELF_CHANGE_NEXT_ACTION}))
        self.assertTrue(is_self_change_mission({"source_kind": SELF_IMPROVEMENT_SOURCE_KIND, "next_action": SELF_CHANGE_NEXT_ACTION}))
        self.assertFalse(hasattr(scb, "is_self_change_mission"), "the bridge imports the owner's discriminator; it does not keep a copy")


class TheBridgeCallsProposeSelfChange(_Store):
    def _request(self, mission_id: str, queue_item_id: str = "qi-s1") -> dict:
        prompt = scb.build_self_change_prompt(queue_item_id=queue_item_id, source_cycle_id="cyc-1",
                                              mission_row=fold_mission(mission_id=mission_id, base_dir=self.tools))
        return create_agent_invocation_request(
            target_agent=scb.SELF_CHANGE_TARGET_AGENT, role=scb.SELF_CHANGE_ROLE, suggested_prompt=json.dumps(prompt, sort_keys=True),
            must_satisfy=scb.self_change_must_satisfy(), allowed_scope=scb.self_change_allowed_scope(), evidence_refs=[queue_item_id],
            pressure_event_id=f"mission:{mission_id}", base_dir=self.tools,
        )

    @staticmethod
    def _envelope(request: dict, details: dict) -> dict:
        return {"$schema": RESPONSE_SCHEMA, "request_id": request["request_id"], "claim_id": "claim_selfchange1", "agent_id": "aria-autonomy-planner",
                "role": scb.SELF_CHANGE_ROLE, "status": "submitted",
                "satisfaction_matrix": [{"id": item_id, "verdict": "satisfied"} for item_id in scb.SELF_CHANGE_CONTRACT_IDS],
                "details": details}

    def _bridge(self, request: dict, details: dict) -> dict:
        return _invoke_bridges_for_result(request=request, envelope=self._envelope(request, details), base_dir=self.tools, root=self.tools,
                                          claim_id="claim_selfchange1", request_id=request["request_id"])

    def test_an_accepted_answer_opens_the_proposal_and_the_adjudication_from_the_kernel(self) -> None:
        mission_id = self.self_improvement_mission()
        request = self._request(mission_id)
        bridged = self._bridge(request, {"evidence_paths": ["aria-kernel/aria_kernel/doctor.py"],
                                         "problem": "the gateway organ warned on a four-day-old heartbeat",
                                         "proposed_change": "fail the doctor when the heartbeat is older than five beats"})
        self.assertEqual(bridged["bridge_errors"], [])
        outcome = bridged["self_change"]
        self.assertEqual(outcome["proposal"]["kind"], "self_change")
        self.assertEqual(outcome["human_required"]["reason"], "self_change_adjudication")
        self.assertIn(SELF_CHANGE_PROPOSED_EVENT, self.governance_kinds())
        self.assertEqual([row["reason"] for row in list_human_required(base_dir=self.tools)], ["self_change_adjudication"])
        mission = fold_mission(mission_id=mission_id, base_dir=self.tools)
        self.assertEqual(mission["state"], "HUMAN_REQUIRED", "the loop closes through a person; the scheduler must not re-select it")
        self.assertIn(outcome["proposal"]["proposal_id"], mission["next_action"])
        self.assertEqual(mission["wake_condition"]["key"], f"human_required:{outcome['human_required']['request_id']}")

    def test_an_authority_surface_in_the_answer_is_refused_by_the_kernel(self) -> None:
        mission_id = self.self_improvement_mission()
        request = self._request(mission_id)
        bridged = self._bridge(request, {"evidence_paths": ["aria-kernel/aria_kernel/hooks.py"], "problem": "p", "proposed_change": "widen"})
        self.assertEqual(len(bridged["bridge_errors"]), 1)
        self.assertIn("self_change_authority_surface_refused:authority_surface:aria-kernel/aria_kernel/hooks.py", bridged["bridge_errors"][0])
        kinds = self.governance_kinds()
        self.assertIn(SELF_CHANGE_REFUSED_EVENT, kinds)
        self.assertNotIn(SELF_CHANGE_PROPOSED_EVENT, kinds)
        self.assertEqual(list_human_required(base_dir=self.tools), [])
        self.assertEqual(fold_mission(mission_id=mission_id, base_dir=self.tools)["state"], "DISCOVERED")

    def test_a_malformed_answer_is_named_field_by_field(self) -> None:
        request = self._request(self.self_improvement_mission())
        errors = scb.validate_self_change_response(request=request, response=self._envelope(request, {"evidence_paths": [], "problem": "  "}))
        self.assertEqual(errors, ["self_change_evidence_paths:empty", "self_change_problem:empty", "self_change_proposed_change:absent"])
        errors = scb.validate_self_change_response(request=request, response=self._envelope(request, {"evidence_paths": ["a", 3]}))
        self.assertIn("self_change_evidence_paths:not_a_list_of_paths", errors)
        self.assertEqual(scb.validate_self_change_response(request={"must_satisfy": [{"id": "queue_item_projected"}]}, response={}), [],
                         "the contract binds self-change requests only")
        bridged = self._bridge(request, {"evidence_paths": ["aria-kernel/aria_kernel/doctor.py"]})
        self.assertIn("self_change_bridge: self_change_response_contract:", bridged["bridge_errors"][0])
        self.assertNotIn(SELF_CHANGE_PROPOSED_EVENT, self.governance_kinds())

    def test_a_terminal_mission_is_refused_before_anything_is_written(self) -> None:
        mission_id = self.self_improvement_mission()
        transition_mission(mission_id=mission_id, to_state="SUPERSEDED", reason_code="test", step_id="s", base_dir=self.tools)
        with self.assertRaises(GovernanceError) as refused:
            propose_self_change(mission_id=mission_id, base_dir=self.tools, workspace_root=self.ws,
                                evidence_paths=["aria-kernel/aria_kernel/doctor.py"], problem="p", proposed_change="c")
        self.assertIn("self_change_mission_terminal", str(refused.exception))
        self.assertEqual(list_human_required(base_dir=self.tools), [])
        self.assertNotIn(SELF_CHANGE_PROPOSED_EVENT, self.governance_kinds())
        self.assertEqual(self.mission_refusals(), ["self_change_mission_terminal"])

    _GOOD = {"evidence_paths": ["aria-kernel/aria_kernel/doctor.py"], "problem": "the gateway organ warned on a stale heartbeat",
             "proposed_change": "fail the doctor when the heartbeat is older than five beats"}

    def _two_in_flight(self) -> tuple[str, dict, dict]:
        # The verifier's reproduction: two requests minted for one mission
        # before either is answered (cycle 1 and cycle 2 both selected the
        # DISCOVERED mission). R1 is accepted first and parks the mission.
        mission_id = self.self_improvement_mission()
        first, second = self._request(mission_id), self._request(mission_id, queue_item_id="qi-s2")
        self.assertNotEqual(first["request_id"], second["request_id"])
        self.assertEqual(self._bridge(first, dict(self._GOOD))["bridge_errors"], [])
        return mission_id, first, second

    def test_a_stale_second_answer_cannot_re_park_a_mission_the_operator_moved_on(self) -> None:
        mission_id, _first, second = self._two_in_flight()
        parked = fold_mission(mission_id=mission_id, base_dir=self.tools)
        self.assertEqual(parked["state"], "HUMAN_REQUIRED")
        operator_sentence = "Implement the approved change on a kernel-change branch"
        transition_mission(mission_id=mission_id, to_state="PLANNING", reason_code="operator_adjudicated", step_id="op-1",
                           next_action=operator_sentence, wake_condition={"kind": "evidence", "key": "operator"}, base_dir=self.tools)

        bridged = self._bridge(second, dict(self._GOOD))

        self.assertEqual(len(bridged["bridge_errors"]), 1)
        self.assertIn(f"self_change_mission_moved_on:{mission_id}:", bridged["bridge_errors"][0])
        after = fold_mission(mission_id=mission_id, base_dir=self.tools)
        self.assertEqual((after["state"], after["next_action"]), ("PLANNING", operator_sentence), "the operator's sentence stands")
        self.assertEqual(len(list_human_required(base_dir=self.tools)), 1, "exactly one adjudication")
        self.assertEqual(len(list_proposals(base_dir=self.tools, kind="self_change")), 1, "exactly one proposal")
        self.assertEqual(self.governance_kinds().count(SELF_CHANGE_PROPOSED_EVENT), 1)
        self.assertEqual(self.mission_refusals(), ["self_change_mission_moved_on"])

    def test_a_stale_second_answer_cannot_overwrite_an_operator_held_mission(self) -> None:
        mission_id, _first, second = self._two_in_flight()
        parked = fold_mission(mission_id=mission_id, base_dir=self.tools)

        bridged = self._bridge(second, dict(self._GOOD))

        self.assertIn(f"self_change_mission_operator_held:{mission_id}:HUMAN_REQUIRED", bridged["bridge_errors"][0])
        after = fold_mission(mission_id=mission_id, base_dir=self.tools)
        self.assertEqual((after["state"], after["next_action"], after["wake_condition"]),
                         (parked["state"], parked["next_action"], parked["wake_condition"]), "the park is untouched")
        self.assertEqual(len(list_human_required(base_dir=self.tools)), 1)
        self.assertEqual(len(list_proposals(base_dir=self.tools, kind="self_change")), 1)
        self.assertEqual(self.mission_refusals(), ["self_change_mission_operator_held"])

    def test_a_re_ask_waits_for_the_open_adjudication_and_proceeds_once_it_is_resolved(self) -> None:
        # The operator re-points the mission at `propose_self_change` (a
        # genuine re-ask) but has not resolved the first adjudication: the
        # second proposal is refused by the OPEN adjudication, and proceeds
        # once that adjudication is resolved — the guard is about what
        # stands, not about history.
        mission_id, _first, second = self._two_in_flight()
        adjudication = list_human_required(base_dir=self.tools)[0]
        transition_mission(mission_id=mission_id, to_state="PLANNING", reason_code="operator_re_ask", step_id="op-1",
                           next_action=SELF_CHANGE_NEXT_ACTION, wake_condition={"kind": "evidence", "key": "re-ask"}, base_dir=self.tools)

        bridged = self._bridge(second, dict(self._GOOD))
        self.assertIn(f"self_change_adjudication_already_open:{mission_id}:{adjudication['request_id']}", bridged["bridge_errors"][0])
        self.assertEqual(fold_mission(mission_id=mission_id, base_dir=self.tools)["state"], "PLANNING")
        self.assertEqual(len(list_proposals(base_dir=self.tools, kind="self_change")), 1)

        resolve_human_required(request_id=str(adjudication["request_id"]), resolution_note="approved on the kernel-change lane",
                               base_dir=self.tools)
        third = self._request(mission_id, queue_item_id="qi-s3")
        bridged = self._bridge(third, dict(self._GOOD))
        self.assertEqual(bridged["bridge_errors"], [])
        self.assertEqual(len(list_proposals(base_dir=self.tools, kind="self_change")), 2)
        self.assertEqual(fold_mission(mission_id=mission_id, base_dir=self.tools)["state"], "HUMAN_REQUIRED")
        self.assertEqual(self.mission_refusals(), ["self_change_adjudication_already_open"])

    def test_every_mission_refusal_is_a_named_member_of_the_closed_set(self) -> None:
        self.assertEqual(SELF_CHANGE_MISSION_REFUSALS, ("self_change_mission_terminal", "self_change_mission_operator_held",
                                                        "self_change_mission_moved_on", "self_change_adjudication_already_open"))

    def test_the_bridge_ignores_every_other_request(self) -> None:
        self.assertIsNone(scb.record_self_change_result(request={"must_satisfy": [{"id": "queue_item_projected"}]}, response={}, base_dir=self.tools))

    def test_the_executor_pre_submit_gate_uses_the_kernel_validator(self) -> None:
        import ci_executor

        request = self._request(self.self_improvement_mission())
        errors = ci_executor._pre_submit_validate_envelope(self._envelope(request, {}), role=scb.SELF_CHANGE_ROLE, request=request)
        self.assertEqual(errors, ["self_change_evidence_paths:absent", "self_change_problem:absent", "self_change_proposed_change:absent"])
        ok = ci_executor._pre_submit_validate_envelope(
            self._envelope(request, {"evidence_paths": ["aria-kernel/aria_kernel/doctor.py"], "problem": "p", "proposed_change": "c"}),
            role=scb.SELF_CHANGE_ROLE, request=request)
        self.assertEqual(ok, [])
        from aria_kernel.agent_invocations import HARNESS_FAULT_RELEASE_REASONS

        self.assertIn(scb.SELF_CHANGE_CONTRACT_RELEASE_REASON, HARNESS_FAULT_RELEASE_REASONS)
        source = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        self.assertIn("SELF_CHANGE_CONTRACT_RELEASE_REASON", source)


class TheSchedulerRanksSelfImprovement(unittest.TestCase):
    def test_self_improvement_is_ranked_between_findings_and_pressure(self) -> None:
        self.assertIn(SELF_IMPROVEMENT_SOURCE_KIND, SOURCE_RANK)
        self.assertGreater(SOURCE_RANK[SELF_IMPROVEMENT_SOURCE_KIND], SOURCE_RANK["finding"])
        self.assertLess(SOURCE_RANK[SELF_IMPROVEMENT_SOURCE_KIND], SOURCE_RANK["pressure"])
        self.assertLess(SOURCE_RANK[SELF_IMPROVEMENT_SOURCE_KIND], SOURCE_RANK["service_hardening"])


def _next_action_constants(root: Path) -> dict[str, Path]:
    """Every module-level `*_NEXT_ACTION = "<literal>"` in the kernel."""
    found: dict[str, Path] = {}
    for path in sorted(root.rglob("*.py")):
        try:
            tree = ast.parse(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError):
            continue
        for node in tree.body:
            if not isinstance(node, ast.Assign) or not isinstance(node.value, ast.Constant) or not isinstance(node.value.value, str):
                continue
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id.endswith("_NEXT_ACTION"):
                    found[target.id] = path
    return found


def _assignment_source(path: Path, name: str) -> str:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
            return ast.unparse(node.value)
    raise AssertionError(f"{name} not assigned in {path}")


def _names_in(node: ast.AST) -> set[str]:
    return {n.id for n in ast.walk(node) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(node) if isinstance(n, ast.Attribute)}


def _dispatch_sites(path: Path) -> set[str]:
    """Constants a module COMPARES against — the structural shape of dispatch.

    A mint passes the constant as a keyword (`next_action=X`); a dispatcher
    compares a folded value with it (`== X`, `in {X}`, `{X: handler}`,
    `case X`). Only the second shape proves anyone reads the pointer.
    """
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return set()
    compared: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Compare):
            for operand in (node.left, *node.comparators):
                compared |= _names_in(operand)
        elif isinstance(node, ast.Dict):
            for key in node.keys:
                if key is not None:
                    compared |= _names_in(key)
        elif isinstance(node, ast.MatchValue):
            compared |= _names_in(node.value)
    return compared


def _pointer_values() -> dict[str, str]:
    """Every kernel `*_NEXT_ACTION` constant name -> its literal value."""
    constants = _next_action_constants(kernel_root(_REPO))
    return {name: ast.literal_eval(_assignment_source(path, name)) for name, path in constants.items()}


class EveryNextActionHasADispatcher(unittest.TestCase):
    def test_every_next_action_constant_is_in_exactly_one_dispatch_table(self) -> None:
        # The two tables PARTITION the pointers (the DEFAULT_SCHEDULES /
        # OPERATOR_ONLY_ACTIONS shape): a contract pointer has a builder, a
        # generic-projection pointer has a stated reason and a named
        # consumer. A pointer in neither is minted-but-unread; a pointer in
        # both is two dispatchers disagreeing.
        values = _pointer_values()
        self.assertIn("SELF_CHANGE_NEXT_ACTION", values, "the scan must still see the constant this lane connected")
        contracts, generic = set(NEXT_ACTION_CONTRACTS), set(GENERIC_PROJECTION_POINTERS)
        self.assertEqual(contracts & generic, set(), "a pointer cannot both mint a contract and be the generic projection")
        missing = sorted(name for name, value in values.items() if value not in contracts | generic)
        self.assertEqual(missing, [], "next_action constants in neither mission_dispatch table: " + ", ".join(missing))
        for pointer, builder in NEXT_ACTION_CONTRACTS.items():
            self.assertTrue(callable(builder), f"{pointer}: the contract table holds builders only")
        for pointer, entry in GENERIC_PROJECTION_POINTERS.items():
            self.assertTrue(entry.reason.strip(), f"{pointer}: a generic-projection pointer needs the reason it mints no contract")
            self.assertTrue(entry.source_kind.strip(), f"{pointer}: the mission source kind its consumer reads")
            self.assertRegex(entry.consumer, r"^[a-z_][a-z0-9_.]*:[a-z_][a-z0-9_]*$", f"{pointer}: consumer is module:function")

    def test_every_generic_projection_pointer_has_a_consumer_that_reads_the_mission(self) -> None:
        # Named is not enough — the consumer is resolved and RUN against a
        # mission minted with the pointer, and must return that mission.
        import importlib

        for pointer, entry in GENERIC_PROJECTION_POINTERS.items():
            module_name, function_name = entry.consumer.split(":", 1)
            consumer = getattr(importlib.import_module(module_name), function_name)
            with tempfile.TemporaryDirectory() as tmp:
                workspace = Path(tmp) / "repo"
                workspace.mkdir()
                subprocess.run(["git", "init", "-q", str(workspace)], check=True)
                tools = ensure_tools_dir(workspace / "aria-tools")
                row = open_mission(source_kind=entry.source_kind, source_id=f"consumer-proof:{pointer}", repo_hash=canonical_identity(workspace),
                                   title=f"consumer proof for {pointer}", next_action=pointer,
                                   wake_condition={"kind": "evidence", "key": "consumer-proof"}, base_dir=tools)
                candidates = consumer(workspace)
                self.assertIn(str(row["mission_id"]), {str(c.get("candidate_id")) for c in candidates},
                              f"{pointer}: {entry.consumer} does not read a {entry.source_kind} mission carrying the pointer")

    def test_every_contract_pointer_is_compared_against_outside_the_cli_and_the_table(self) -> None:
        # The AST scan is the "make it detectable" net: a contract pointer's
        # discriminator (the rule the accept-time boundary re-applies) has to
        # COMPARE against the pointer somewhere the table and the CLI are
        # not. The table's own dict keys are excluded on purpose — a key in
        # NEXT_ACTION_CONTRACTS certified ISSUE_MISSION_NEXT_ACTION as
        # dispatched when its entry was None and nobody read it.
        values = _pointer_values()
        contract_names = {name for name, value in values.items() if value in NEXT_ACTION_CONTRACTS}
        self.assertEqual(contract_names, {"SELF_CHANGE_NEXT_ACTION"})
        excluded = {(kernel_root(_REPO) / "cli.py").resolve(), (kernel_root(_REPO) / "mission_dispatch.py").resolve()}
        dispatched: dict[str, list[str]] = {name: [] for name in values}
        for path in production_sources(_REPO):
            if path.resolve() in excluded:
                continue  # the CLI is an operator hand (ORPHAN-694); the table cannot certify itself
            for name in _dispatch_sites(path) & set(values):
                dispatched[name].append(path.relative_to(_REPO).as_posix())
        undispatched = sorted(name for name in contract_names if not dispatched[name])
        self.assertEqual(undispatched, [], "contract next_action constants nothing outside the table compares against: " + ", ".join(undispatched))
        self.assertIn("aria-kernel/aria_kernel/self_improvement.py", dispatched["SELF_CHANGE_NEXT_ACTION"],
                      "the accept-time boundary's discriminator is the compare site")
        # The hole the net used to have, demonstrated closed: the generic
        # pointer IS a key in the table's module and is compared against
        # nowhere else — so with the table excluded the net could fail it.
        self.assertIn("ISSUE_MISSION_NEXT_ACTION", _dispatch_sites(kernel_root(_REPO) / "mission_dispatch.py"))
        self.assertEqual(dispatched["ISSUE_MISSION_NEXT_ACTION"], [], "a dict key in the table is not a dispatch site")

    def test_the_scan_distinguishes_a_mint_from_a_dispatch(self) -> None:
        # Deliberate breakage of the scanner: a mint (keyword argument) must
        # not count, or the owner module's own `open_mission(next_action=X)`
        # would certify every pointer as dispatched.
        with tempfile.TemporaryDirectory() as tmp:
            mint = Path(tmp) / "mint.py"
            mint.write_text("X_NEXT_ACTION = 'x'\n\ndef m():\n    return open(next_action=X_NEXT_ACTION)\n", encoding="utf-8")
            self.assertEqual(_next_action_constants(Path(tmp)), {"X_NEXT_ACTION": mint})
            self.assertNotIn("X_NEXT_ACTION", _dispatch_sites(mint))
            for shape in ("row.get('next_action') == X_NEXT_ACTION", "row['next_action'] in {X_NEXT_ACTION}", "{X_NEXT_ACTION: 1}[row]"):
                dispatch = Path(tmp) / "dispatch.py"
                dispatch.write_text(f"def d(row):\n    return {shape}\n", encoding="utf-8")
                self.assertIn("X_NEXT_ACTION", _dispatch_sites(dispatch), shape)


if __name__ == "__main__":
    unittest.main()
