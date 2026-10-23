"""WP-J B-2 (seats) — the four method seats land in every E14 table at
once, the judgment lane can mint a whole panel through the roles
parameter, and a panel is minted whole or not at all.

E14: a role joins REQUEST_ROLES, DISPATCHABLE_ROLES, ROLE_TARGET_PAIRING
and PRODUCER_CLASSES in ONE commit; the routing table is an exact set over
DISPATCHABLE_ROLES and the ci_executor standalone mirror must not drift.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.agent_surface import (
    DISPATCHABLE_ROLES,
    EXPERT_METHODS,
    JUDGE_ROLES,
    REQUEST_ROLES,
    ROLE_TARGET_PAIRING,
)
from aria_kernel.feedback_store import generate_ai_consensus
from aria_kernel.judge_fanout import dispatch_judges_for_sample

from aria_kernel.agent_surface import METHOD_REQUIRED_EVIDENCE
from aria_kernel.request_admission import PRODUCER_CLASSES
from aria_kernel.tool_registry import ensure_tools_dir

from tests._helpers.rule_contracts import register_contracted_tool

# The four panel seats this slice adds (the static tracer and the devil's
# advocate already exist as evidence_judgment / adversarial_judgment).
NEW_SEATS: dict[str, tuple[str, ...]] = {
    "bug_hunt": ("aria-bug-hunter",),
    "reproduction_test": ("aria-test-writer",),
    "impact_assessment": ("aria-impact-assessor",),
    "architecture": ("architectural-arbiter",),
}

# The six seats the funnel can route by claim_type, and the six DISTINCT
# methods they practice.
SIX_METHOD_SEATS = (
    "evidence_judgment",
    "adversarial_judgment",
    "bug_hunt",
    "reproduction_test",
    "impact_assessment",
    "architecture",
)

_METHOD_REQUIRED_FIELDS = {
    "bug_hunt": "failing_input",
    "reproduction_test": "reproduction",
    "impact_assessment": "visible_consequence",
    "architecture_contract": "blast_radius",
}


class PanelSeatRegistrationTests(unittest.TestCase):
    """E14: mint side, claim side, pairing and producer door, one commit."""

    def test_each_new_seat_lands_in_all_four_tables(self) -> None:
        for role, targets in NEW_SEATS.items():
            self.assertIn(role, REQUEST_ROLES, role)
            self.assertIn(role, DISPATCHABLE_ROLES, role)
            self.assertEqual(ROLE_TARGET_PAIRING.get(role), targets, role)
        panel = PRODUCER_CLASSES["judge_fanout.panel"]
        for role in NEW_SEATS:
            self.assertIn(role, panel.roles, role)

    def test_each_new_seat_folds_its_verdict_through_the_judge_bridge(self) -> None:
        """A seat whose response the bridge ignores (is_judge_role False) is
        a paid envelope that can never vote — E14 from the response side."""
        for role in NEW_SEATS:
            self.assertIn(role, JUDGE_ROLES, role)
            self.assertIn(role, EXPERT_METHODS, role)

    def test_six_seats_practice_six_distinct_methods(self) -> None:
        methods = [EXPERT_METHODS[role] for role in SIX_METHOD_SEATS]
        self.assertEqual(len(methods), len(set(methods)))
        for method, field in _METHOD_REQUIRED_FIELDS.items():
            self.assertIn(method, methods)
            self.assertIn(method, METHOD_REQUIRED_EVIDENCE)
            self.assertEqual(METHOD_REQUIRED_EVIDENCE[method], field)

    def test_the_new_agents_resolve_and_the_reproduction_seat_writes(self) -> None:
        from aria_kernel.agent_contract import DEFAULT_TARGET_AGENT_WHITELIST
        from aria_kernel.agent_runtime_profile import read_agent_runtime_profile
        from aria_kernel.runtime_profiles import WRITE_SCOPE_ROLES, load_provider_routing
        from aria_kernel.model_fleet import provider_admits_writes

        repo_root = Path(__file__).resolve().parents[2]
        for targets in NEW_SEATS.values():
            for target in targets:
                self.assertIn(target, DEFAULT_TARGET_AGENT_WHITELIST, target)
                self.assertIsNotNone(
                    read_agent_runtime_profile(target, repo_root=repo_root).profile_id
                    or read_agent_runtime_profile(target, repo_root=repo_root).model,
                    target,
                )
        # The test-writer seat WRITES and RUNS: its ladder may name only
        # write-admitting providers (anthropic + zai today).
        self.assertIn("reproduction_test", WRITE_SCOPE_ROLES)
        routing = load_provider_routing()
        ladder = routing.ladder_for("reproduction_test", NEW_SEATS["reproduction_test"][0])
        self.assertTrue(ladder)
        for provider in ladder:
            self.assertTrue(provider_admits_writes(provider), provider)
        for role in NEW_SEATS:
            routing.ladder_for(role, NEW_SEATS[role][0])


class _PanelCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-wpjb2-")
        self.tools = Path(self._tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        register_contracted_tool(self.tools, "tool-x")
        # The host's presence is the test's fact (`provider_outage.host_providers`),
        # never the machine's PATH: these cases mint a panel on a host that runs
        # every vendor, so the reproduction seat's write rung is live. Read from
        # PATH, a runner without the claude CLI dropped that seat
        # (`seat_write_rung_unavailable`) and the mint counts changed with the
        # machine. The degraded host is its own owner's case
        # (test_panel_single_provider_night).
        host = mock.patch(
            "aria_kernel.provider_outage.host_providers",
            return_value=frozenset({"anthropic", "zai", "openai"}),
        )
        host.start()
        self.addCleanup(host.stop)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _sample(self) -> dict:
        return {
            "cycle_id": "c1",
            "items": [{
                "tool_id": "tool-x", "run_id": "r1", "cycle_id": "c1", "finding_id": "F1",
                "rule": "rule-a", "severity": "high", "path": "src/f1.py:1",
                "message": "suspicious", "evidence": ["src/f1.py:1"],
                "finding_fingerprint": "fp1",
            }],
        }


class PanelMintTests(_PanelCase):
    def test_a_roles_set_mints_one_envelope_per_seat_with_its_method(self) -> None:
        roles = tuple(
            (role, NEW_SEATS[role][0]) for role in ("bug_hunt", "reproduction_test", "impact_assessment")
        )
        result = dispatch_judges_for_sample(sample=self._sample(), base_dir=self.tools, roles=roles)
        self.assertEqual(result["minted_count"], 3)
        from aria_kernel.agent_invocations import list_agent_invocation_requests

        minted = list_agent_invocation_requests(base_dir=self.tools)
        self.assertEqual(
            {row["agent_method"] for row in minted},
            {"bug_hunt", "reproduction_test", "impact_assessment"},
        )

    def test_the_default_lane_still_mints_the_two_legacy_seats(self) -> None:
        result = dispatch_judges_for_sample(sample=self._sample(), base_dir=self.tools)
        self.assertEqual(result["minted_count"], 2)
        self.assertEqual(
            {m["role"] for m in result["minted"]},
            {"evidence_judgment", "adversarial_judgment"},
        )

    def test_the_panel_is_minted_whole_or_not_at_all_on_the_backlog_cap(self) -> None:
        """ARIA-HIGH-364's own discipline, extended to N seats: a panel whose
        one seat is backlog-capped must mint NOTHING for the finding — a
        3-of-4 panel is a finding that can never settle at its tier."""
        roles = tuple(
            (role, NEW_SEATS[role][0]) for role in ("bug_hunt", "reproduction_test", "impact_assessment")
        )
        result = dispatch_judges_for_sample(
            sample=self._sample(), base_dir=self.tools, roles=roles,
            max_pending_per_role=0,
        )
        self.assertEqual(result["minted_count"], 0)
        self.assertTrue(result["skipped"])

    def test_the_panel_is_minted_whole_or_not_at_all_on_a_refused_door(self) -> None:
        from aria_kernel.request_admission import Admission

        def refusing(producer, role, **_kwargs):
            return Admission(
                producer, role, "discretionary", "cyc", 1,
                role != "bug_hunt", "provider_unavailable",
            )

        roles = tuple(
            (role, NEW_SEATS[role][0]) for role in ("bug_hunt", "reproduction_test", "impact_assessment")
        )
        with mock.patch("aria_kernel.judge_fanout.admit_request", side_effect=refusing):
            result = dispatch_judges_for_sample(sample=self._sample(), base_dir=self.tools, roles=roles)
        self.assertEqual(result["minted_count"], 0)
        self.assertEqual(
            {s.get("reason") for s in result["skipped"]},
            {"request_admission_throttled:provider_unavailable"},
        )


if __name__ == "__main__":
    unittest.main()
