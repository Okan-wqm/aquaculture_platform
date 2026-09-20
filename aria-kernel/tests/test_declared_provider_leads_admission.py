"""ARIA-HIGH-161 — the profile's declared provider leads its admission ladder.

Measured on the first production executor after the chain restart (run
35444645590, 2026-09-19 13:20–13:30Z): the adversarial judge's frontmatter
declares ``glm-5.3`` (runtime profile ``judge_glm``), the managed Claude
session was logged in, and the fleet ladder — walked in ``_FLEET``'s fixed
preference order — admitted the request on ``anthropic/opus``. The claude
wrapper then re-resolved the model from the profile, ran the Z.ai transport
as its cross-vendor rung, and could not find ``claude_cli_usage`` in an
envelope built from a plain-text stdout: the finished verdict (a sound
false_positive at 0.6) was released as ``native_runtime_execution_unavailable``
at requeue budget zero, and the attempt row named the cause
``control_or_transport_unavailable`` because the handler overwrote the
``usage_unavailable`` the wrapper had already named. Every night, the same
judge, the same release; two distinct models — the anchor grade's whole
point — could never form.

What this pins, one property per test:

* A profile declaring a Z.ai model is admitted on ``zai`` first when the
  vendor is available; the fleet's preference order stays the failover
  ladder behind it. An Anthropic profile's ladder is unchanged.
* The declared provider is the FIRST in contention: its undecided probe
  halts the ladder even with the fleet's first member available.
* The admission row names the declared provider.
* The envelope builder carries usage handed to it by the run result, so
  a transport that reports usage on the result (not as a stream event)
  seals an envelope the native wrapper accepts.
* A ``result_admission`` the wrapper already named survives the handler.
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.model_fleet import _FLEET
from aria_kernel.native_admission import (
    AdmissionOutcome,
    declared_provider_for_profile,
    fleet_ladder_for,
)
from aria_kernel.status_probe import StatusDecision

from tests.test_native_admission_undecided import (
    _FleetFixture,
    _logged_out,
    _stalled,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
from claude_runtime import ClaudeAuthFailure, ClaudeCliUnavailable, ClaudeCreditExhausted  # noqa: E402


def _judge_glm() -> AgentRuntimeProfile:
    return AgentRuntimeProfile(agent_name="aria-adversarial-judge", model="glm-5.3", effort="max",
                               source="frontmatter", tools=("Read", "Grep", "Glob"))


class TheLadderIsOrderedByTheProfile(unittest.TestCase):
    def test_the_declared_provider_is_read_from_the_model(self) -> None:
        self.assertEqual(declared_provider_for_profile(_judge_glm()), "zai")
        opus = AgentRuntimeProfile(agent_name="planner", model="opus", effort="max", source="frontmatter",
                                   tools=("Read",))
        self.assertEqual(declared_provider_for_profile(opus), "anthropic")

    def test_the_ladder_keeps_every_member_once_with_the_leader_first(self) -> None:
        keys = [provider.key for provider in _FLEET]
        for leader in keys:
            ladder = [provider.key for provider in fleet_ladder_for(leader)]
            self.assertEqual(ladder[0], leader)
            self.assertEqual(sorted(ladder), sorted(keys))
            self.assertEqual([key for key in ladder if key != leader], [key for key in keys if key != leader],
                             "the rungs behind the leader keep the fleet's preference order")


class ADeclaredZaiProfileIsAdmittedOnZai(_FleetFixture):
    def setUp(self) -> None:
        super().setUp()
        self.read_only = _judge_glm()

    def test_zai_leads_when_every_vendor_is_available(self) -> None:
        admission = self._admit({})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["zai", "anthropic", "openai"])
        self.assertEqual((admission.eligible_routes[0]["runtime"], admission.eligible_routes[0]["model"]),
                         ("zai", "glm-5.3"))
        self.assertEqual(self.probed[0], "zai", "the declared provider is probed first")
        self.assertEqual(admission.as_row()["declared_provider"], "zai")

    def test_a_logged_out_zai_fails_over_to_the_fleet_order(self) -> None:
        admission = self._admit({"zai": [_logged_out()]})
        self.assertIs(admission.outcome, AdmissionOutcome.ADMITTED)
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic", "openai"])
        rows = {row["provider"]: row for row in admission.candidate_observations}
        self.assertEqual(rows["zai"]["decision"], "unavailable")

    def test_an_undecided_zai_halts_even_with_anthropic_available(self) -> None:
        admission = self._admit({"zai": [_stalled()] * 3})
        self.assertIs(admission.outcome, AdmissionOutcome.PROVIDER_UNDECIDED)
        self.assertEqual(admission.halting_provider, "zai")
        self.assertEqual(admission.eligible_routes, ())
        rows = {row["provider"]: row for row in admission.candidate_observations}
        self.assertEqual(rows["anthropic"]["decision"], "available", "observed and recorded, never admitted")


class AnAnthropicProfileLadderIsUnchanged(_FleetFixture):
    def test_anthropic_still_leads(self) -> None:
        admission = self._admit({})
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic", "zai", "openai"])
        self.assertEqual(admission.as_row()["declared_provider"], "anthropic")
        self.assertEqual(self.probed[0], "anthropic")


class TheEnvelopeCarriesTheResultsUsage(unittest.TestCase):
    _AGENT_TEXT = json.dumps({
        "$schema": "aria/agent-response/v1", "request_id": "AIR-x", "claim_id": "claim_x",
        "agent_id": "aria-adversarial-judge", "role": "adversarial_judgment", "status": "submitted",
        "satisfaction_matrix": [{"id": "verdict", "verdict": "contradicted", "note": "n",
                                 "evidence_refs": ["a.ts:1"]}],
        "evidence_refs": ["a.ts:1"],
        "details": {"verdict": {"verdict": "false_positive", "confidence": 0.6}},
    })

    def _build(self, usage):
        return ci_executor._build_envelope_from_claude_output(
            raw_stdout=self._AGENT_TEXT, request_id="AIR-x", claim_id="claim_x", agent_id="ci-executor:t",
            role="adversarial_judgment", subagent_type="aria-adversarial-judge",
            must_satisfy=[{"id": "verdict", "description": "d"}], dispatch_model="glm-5.3", usage=usage,
        )

    def test_a_plain_text_transport_reply_carries_the_results_usage(self) -> None:
        usage = {"input_tokens": 1200, "output_tokens": 90}
        envelope = self._build(usage)
        self.assertEqual(envelope["details"]["claude_cli_usage"], usage)

    def test_without_a_result_usage_the_stream_parse_stays_the_source(self) -> None:
        envelope = self._build(None)
        self.assertNotIn("claude_cli_usage", envelope["details"],
                         "a plain-text stdout carries no stream usage; nothing is invented")


class ANamedResultAdmissionSurvivesTheHandler(unittest.TestCase):
    def test_the_wrappers_own_name_stands(self) -> None:
        self.assertEqual(
            ci_executor._result_admission_for(ClaudeCliUnavailable("claude_native_usage_unavailable"), "usage_unavailable"),
            "usage_unavailable",
        )

    def test_an_unnamed_attempt_is_classified_by_exception_family(self) -> None:
        unnamed = ci_executor._NATIVE_CLAUDE_ADMISSION_UNNAMED
        self.assertEqual(ci_executor._result_admission_for(ClaudeAuthFailure("x"), unnamed), "auth_unavailable")
        exhausted = ClaudeCreditExhausted("x", provider="zai", model="glm-5.3", detail={"marker": "x"})
        self.assertEqual(ci_executor._result_admission_for(exhausted, unnamed), "quota_unavailable")
        self.assertEqual(ci_executor._result_admission_for(ClaudeCliUnavailable("x"), unnamed),
                         "control_or_transport_unavailable")


if __name__ == "__main__":
    unittest.main()
