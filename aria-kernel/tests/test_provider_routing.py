"""ARIA-HIGH-290 — the provider a role runs on is policy data in ONE place.

Operator decision 2026-10-02: role-based routing with automatic failover.
Z.ai glm-5.3 leads the high-volume roles (challenger, cross review, the
evaluation roles, completeness critique) and one judge of the pair; Claude
Opus leads the primary planner and the implementer; each fails over to the
other vendor while its own is cooled, logged out or refused. Before this,
the vendor was the model of the agent's runtime profile (the primary planner
and the challenger share `planner`, so they always shared a vendor), the
ladder order was code, the legacy lane had a second code ladder
(`AUTH_FAILOVER_TIER`) and a third, test-only striping policy existed.

What this pins, with fake status transports only (no provider is called):

* the shipped `provider_routing` block routes every dispatchable role once,
  with the operator's table;
* the native admission walks the role's ladder and fails over in BOTH
  directions on a cooldown, and the Claude rung runs the route's own model;
* ONE data edit (`suspended_providers: ["anthropic"]`) puts every read-only
  role on Z.ai and leaves the implementer waiting by name;
* the loader refuses every malformed table by name;
* the vendor-diversity guard: the two seats of an independence pair run on
  different vendors whenever both lead vendors are available.
"""
from __future__ import annotations

import copy
import itertools
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import runtime_profiles
from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.agent_surface import DISPATCHABLE_ROLES, ROLE_TARGET_PAIRING
from aria_kernel.model_fleet import provider_admits_writes
from aria_kernel.native_admission import AdmissionOutcome
from aria_kernel.provider_cooldown import record_provider_cooldown
from aria_kernel.runtime_profiles import (
    INDEPENDENCE_PAIRS,
    load_provider_routing,
    profiles_path,
    routed_models,
)
from aria_kernel.tool_registry import GovernanceError

from tests.test_native_admission_undecided import _FleetFixture, _logged_out

_SHIPPED = json.loads(profiles_path().read_text(encoding="utf-8"))
_READ = ("Read", "Grep", "Glob")
_WRITE = ("Read", "Grep", "Glob", "Edit", "Write", "Bash")


def _write_table(directory: Path, mutate) -> Path:  # noqa: ANN001 — a callable over the document
    document = copy.deepcopy(_SHIPPED)
    mutate(document["provider_routing"])
    path = directory / "runtime_profiles.json"
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def _head(routing, role: str, target: str) -> str | None:  # noqa: ANN001
    ladder = routing.ladder_for(role, target)
    return ladder[0] if ladder else None


class TheShippedTableIsTheOperatorsDecision(unittest.TestCase):
    def setUp(self) -> None:
        self.routing = load_provider_routing()

    def test_every_dispatchable_role_is_routed_and_nothing_else(self) -> None:
        self.assertEqual(set(self.routing.roles), set(DISPATCHABLE_ROLES))

    def test_claude_leads_the_primary_planner_and_the_implementer(self) -> None:
        self.assertEqual(self.routing.ladder_for("primary_plan", "aria-primary-planner")[:2], ("anthropic", "zai"))
        self.assertEqual(self.routing.ladder_for("implementation", "aria-implementer"), ("anthropic",))

    def test_glm_leads_the_high_volume_roles(self) -> None:
        for role, target in (("challenger_plan", "aria-challenger-planner"), ("cross_review", "aria-cross-reviewer"),
                             ("completeness_critique", "aria-completeness-critic"),
                             ("verification", "aria-adversarial-judge"),
                             ("change_intelligence", "aria-change-intelligence"),
                             ("goldset_curation", "aria-goldset-curator")):
            with self.subTest(role=role):
                self.assertEqual(self.routing.ladder_for(role, target)[:2], ("zai", "anthropic"))

    def test_the_judge_pair_is_cross_vendor(self) -> None:
        self.assertEqual(_head(self.routing, "evidence_judgment", "aria-evidence-judge"), "anthropic")
        self.assertEqual(_head(self.routing, "adversarial_judgment", "aria-adversarial-judge"), "zai")
        panel = {target: _head(self.routing, "human_required_adjudication", target)
                 for target in ROLE_TARGET_PAIRING["human_required_adjudication"]}
        self.assertEqual(panel, {"aria-evidence-judge": "anthropic", "aria-adversarial-judge": "zai",
                                 "aria-consensus-arbiter": "anthropic"})

    def test_the_legacy_lane_reads_the_same_ladders(self) -> None:
        spawn = {"environ": {"PATH": ""}, "runtimes": ("claude", "zai"), "profile_model": "opus"}
        self.assertEqual(routed_models("challenger_plan", "aria-challenger-planner", write_capable=False, **spawn),
                         ("glm-5.3", "opus"))
        self.assertEqual(routed_models("primary_plan", "aria-primary-planner", write_capable=False, **spawn),
                         ("opus", "glm-5.3"))
        self.assertEqual(routed_models("implementation", "aria-implementer", write_capable=True, **spawn),
                         ("opus",))


class _RoleFixture(_FleetFixture):
    def _as(self, role: str, agent: str, tools: tuple[str, ...] = _READ) -> None:
        self.role = role
        self.read_only = AgentRuntimeProfile(agent_name=agent, model="opus", effort="max", source="kernel_profile",
                                             tools=tools, write_scope=("**",) if "Edit" in tools else ())

    def _cool(self, provider: str) -> dict:
        signature = {"anthropic": "claude_usage_limit_notice", "zai": "zai_quota_refusal"}[provider]
        return {provider: record_provider_cooldown(
            self.tools, provider=provider, model="m", cooldown_seconds=900, request_id="AIR-x",
            claim_id=f"CL-{provider}", detection={"signature": signature})["details"]}


class TheAdmissionWalksTheRolesLadder(_RoleFixture):
    def test_the_challenger_is_admitted_on_zai_and_the_primary_on_claude(self) -> None:
        self._as("challenger_plan", "aria-challenger-planner")
        self.assertEqual(self._admit({}).eligible_routes[0]["provider"], "zai")
        self._as("primary_plan", "aria-primary-planner")
        self.assertEqual(self._admit({}).eligible_routes[0]["provider"], "anthropic")

    def test_a_cooled_claude_fails_the_primary_planner_over_to_glm(self) -> None:
        self._as("primary_plan", "aria-primary-planner")
        admission = self._admit({}, cooled=self._cool("anthropic"))
        self.assertEqual((admission.eligible_routes[0]["provider"], admission.eligible_routes[0]["model"]),
                         ("zai", "glm-5.3"))
        self.assertNotIn("anthropic", self.probed, "a cooled provider is never attempted")

    def test_a_cooled_zai_fails_the_challenger_over_to_claude_on_its_own_model(self) -> None:
        self._as("challenger_plan", "aria-challenger-planner")
        admission = self._admit({}, cooled=self._cool("zai"))
        self.assertEqual((admission.eligible_routes[0]["provider"], admission.eligible_routes[0]["model"]),
                         ("anthropic", "opus"))

    def test_a_glm_declared_profile_failing_over_runs_opus_on_claude(self) -> None:
        self._as("adversarial_judgment", "aria-adversarial-judge")
        self.read_only = AgentRuntimeProfile(agent_name="aria-adversarial-judge", model="glm-5.3", effort="max",
                                             source="kernel_profile", tools=_READ)
        route = self._admit({}, cooled=self._cool("zai")).eligible_routes[0]
        self.assertEqual((route["provider"], route["model"]), ("anthropic", "opus"))

    def test_the_implementer_waits_while_claude_is_cooled(self) -> None:
        self._as("implementation", "aria-implementer", tools=_WRITE)
        admission = self._admit({}, cooled=self._cool("anthropic"))
        self.assertIs(admission.outcome, AdmissionOutcome.NO_ELIGIBLE_PROVIDER)
        self.assertEqual([row["provider"] for row in admission.candidate_observations], ["anthropic"])


class OneDataEditFlipsEveryRoleToZai(_RoleFixture):
    def setUp(self) -> None:
        super().setUp()
        self.flipped = _write_table(self.root, lambda block: block.update(suspended_providers=["anthropic"]))

    def test_every_read_only_seat_leads_with_zai_and_writers_have_no_rung(self) -> None:
        routing = load_provider_routing(self.flipped)
        for role, entry in routing.roles.items():
            targets = list(entry) if isinstance(entry, dict) else ["aria-any"]
            for target in targets:
                with self.subTest(role=role, target=target):
                    expected = None if role in runtime_profiles.WRITE_SCOPE_ROLES else "zai"
                    self.assertEqual(_head(routing, role, target), expected)

    def test_the_admission_reads_the_flipped_table(self) -> None:
        with patch.object(runtime_profiles, "profiles_path", return_value=self.flipped):
            self._as("primary_plan", "aria-primary-planner")
            self.assertEqual(self._admit({}).eligible_routes[0]["provider"], "zai")
            self._as("implementation", "aria-implementer", tools=_WRITE)
            self.assertIs(self._admit({}).outcome, AdmissionOutcome.NO_ELIGIBLE_PROVIDER)


class TheLoaderRefusesAMalformedTable(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-routing-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))

    def _refused(self, mutate, needle: str) -> None:  # noqa: ANN001
        with self.assertRaises(GovernanceError) as refused:
            load_provider_routing(_write_table(self.tmp, mutate))
        self.assertIn(needle, str(refused.exception))

    def test_each_defect_is_refused_by_name(self) -> None:
        cases = {
            "unknown_key": (lambda b: b.update(extra=1), "provider_routing_shape"),
            "missing_role": (lambda b: b["roles"].pop("cross_review"), "provider_routing_roles"),
            "extra_role": (lambda b: b["roles"].update(gap_finding="claude_first"), "provider_routing_roles"),
            "unknown_provider": (lambda b: b["ladders"]["glm_first"].append("mistral"), "provider_routing_ladder"),
            "duplicate_rung": (lambda b: b["ladders"]["glm_first"].append("zai"), "provider_routing_ladder"),
            "empty_ladder": (lambda b: b["ladders"].update(claude_writer=[]), "provider_routing_ladder"),
            "unknown_ladder": (lambda b: b["roles"].update(cross_review="fastest"), "provider_routing_role_ladder"),
            "writer_on_glm": (lambda b: b["roles"].update(implementation="glm_first"), "provider_routing_write_scope"),
            "pair_shares_a_head": (lambda b: b["roles"].update(challenger_plan="claude_first"),
                                   "provider_routing_independence"),
            "suspended_unknown": (lambda b: b.update(suspended_providers=["mistral"]), "provider_routing_suspended"),
            "panel_targets": (lambda b: b["roles"]["human_required_adjudication"].pop("aria-consensus-arbiter"),
                              "provider_routing_targets"),
            "schema": (lambda b: b.update(schema_version=2), "provider_routing_shape"),
        }
        for name, (mutate, needle) in cases.items():
            with self.subTest(defect=name):
                self._refused(mutate, needle)

    def test_an_unrouted_role_is_refused_at_the_reader(self) -> None:
        with self.assertRaises(GovernanceError) as refused:
            # `gap_finding` was removed from REQUEST_ROLES (program rev3.1);
            # `maintenance_utility` used to stand here, and pinned as a
            # refusal the very gap that failed every executor run.
            load_provider_routing().ladder_for("gap_finding", "aria-any")
        self.assertIn("provider_routing_role_unrouted:gap_finding", str(refused.exception))


class TheTwoSeatsOfAPairNeverShareAVendor(_RoleFixture):
    """The convergent gate's independence (primary vs challenger planner, and
    the drafter and judge pairs): with BOTH lead vendors available the two
    seats run on different vendors; with one of them out, both run on the
    vendor that is left — the operator's failover, not a third choice."""

    _SEATS = {"primary_plan": "aria-primary-planner", "challenger_plan": "aria-challenger-planner",
              "primary_authoring": "aria-primary-drafter", "challenger_authoring": "aria-challenger-drafter",
              "evidence_judgment": "aria-evidence-judge", "adversarial_judgment": "aria-adversarial-judge"}

    def _admitted(self, role: str, out: tuple[str, ...]) -> str | None:
        self.probed.clear()
        self._as(role, self._SEATS[role])
        admission = self._admit({provider: [_logged_out()] for provider in out})
        return admission.eligible_routes[0]["provider"] if admission.eligible_routes else None

    def test_for_every_availability_set_the_pair_is_apart_while_both_leads_are_up(self) -> None:
        routing = load_provider_routing()
        providers = ("anthropic", "zai", "openai")
        for first, second in INDEPENDENCE_PAIRS:
            leads = {routing.ladder_for(first, self._SEATS[first])[0], routing.ladder_for(second, self._SEATS[second])[0]}
            self.assertEqual(len(leads), 2, (first, second))
            for size in range(len(providers)):
                for out in itertools.combinations(providers, size):
                    with self.subTest(pair=(first, second), out=out):
                        a, b = self._admitted(first, out), self._admitted(second, out)
                        if leads.isdisjoint(out):
                            self.assertNotEqual(a, b)
                            self.assertEqual({a, b}, leads)

    def test_with_zai_out_the_challenger_fails_over_to_claude(self) -> None:
        self.assertEqual(self._admitted("challenger_plan", ("zai",)), "anthropic")
        self.assertEqual(self._admitted("primary_plan", ("zai",)), "anthropic")

    def test_with_claude_out_the_primary_fails_over_to_glm(self) -> None:
        self.assertEqual(self._admitted("primary_plan", ("anthropic",)), "zai")
        self.assertEqual(self._admitted("challenger_plan", ("anthropic",)), "zai")


class EveryWriterRungAdmitsWrites(unittest.TestCase):
    def test_write_scope_ladders_name_only_write_capable_runtimes(self) -> None:
        routing = load_provider_routing()
        for role in runtime_profiles.WRITE_SCOPE_ROLES:
            for target in ROLE_TARGET_PAIRING.get(role, ("aria-any",)):
                self.assertTrue(all(provider_admits_writes(p) for p in routing.ladder_for(role, target)), role)


if __name__ == "__main__":
    unittest.main()
