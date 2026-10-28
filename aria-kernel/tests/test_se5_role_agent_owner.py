"""SE-5 group B — ONE owner answers 'which agents may serve a role', including a per-service seat agent.

``agent_surface.allowed_targets_for_role(role)`` is a one-line lookup of the static
``ROLE_TARGET_PAIRING``. It is read at the mint, by ``agent_contract.validate_request`` and,
as the table itself, by the provider-routing parity check. SE-5 makes it the one place that
also names a per-service agent born into the lifecycle ledger: ``allowed_targets_for_role(role,
base_dir=...)`` is the static pairing plus the seat agents the ledger and the workspace grant,
and ``resolve_seat_agent(role, service, base_dir=...)`` says which agent serves one service
(the generic agent, with the named reason a per-service agent was NOT granted).

A seat agent is granted only when ALL of the following hold (specification D-6): its lifecycle
chain replays valid; its state is exactly ``ACTIVE`` (a closed-world rule, so the states SE-12
adds later need no change here); its ACTIVE row is production scope (no ``evidence.scope``, or
``production``); its file is found in the workspace the store is bound to; the file's frontmatter
says ``replaces_role == <role>`` and ``service == <S>``; the role's provider routing can route it;
and no second agent claims the same (role, service). The grant exists only for the roles in
``SERVICE_SEAT_ROLES`` (``change_intelligence``); every other role keeps its static pairing.

Red at the branch base, every one on an assertion: each test asserts that the API it reaches
exists (``inspect.signature``, ``hasattr``) before it uses it, so nothing fails at import or
collection. Pins (four tests), green at the base and to stay green: the static pairing without a
store (O1), the refusal of a seat agent in each non-ACTIVE state at the mint (O2: at the base nothing
is granted at all, so it is the closed-world rule an implementation must not weaken), the provider
ladder parity (O8a), and a custom narrower whitelist that still binds the static agents (the seat
agents are added to the whitelist, never substituted for it).

New API pinned here, named by the specification: ``allowed_targets_for_role(role, *, base_dir)``,
``service_seat_agents(role, *, base_dir)``, ``resolve_seat_agent(role, service, *, base_dir)``
returning ``SeatResolution(agent, declined)``, ``SERVICE_SEAT_ROLES``.
"""
from __future__ import annotations

import ast
import contextlib
import inspect
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import agent_surface, pr_tracking, runtime_profiles
from aria_kernel.agent_contract import validate_request
from aria_kernel.agent_surface import ROLE_TARGET_PAIRING
from aria_kernel.genesis_lifecycle import GENESIS_LIFECYCLE_STATES
from aria_kernel.runtime_profiles import ProviderRouting, load_provider_routing
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.lifecycle_chain import chain
from tests._helpers.seat_routing import GENERIC, ROLE, SEAT_AGENT_X, try_mint, write_seat_agent

SEAT_CONTEXT = {"changed_files": ["libs/x/src/a.ts"], "impacted_roots": ["libs/x"], "seat": "service:x"}


class _Owner(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-se5-owner-")
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)
        self.ws, self.store = self.workspace("main")

    def workspace(
        self, name: str, *, agent: bool = True, service: str | None = "x", replaces_role: str | None = ROLE,
    ) -> tuple[Path, Path]:
        """A workspace holding the per-service agent's file and the store bound to it (its parent is the workspace)."""
        workspace = self.root / name
        workspace.mkdir()
        if agent:
            write_seat_agent(workspace, SEAT_AGENT_X, service=service, replaces_role=replaces_role)
        return workspace, ensure_tools_dir(workspace / "aria-tools")

    def allowed(self, store: Path | None = None, role: str = ROLE) -> tuple[str, ...]:
        parameters = inspect.signature(agent_surface.allowed_targets_for_role).parameters
        self.assertIn("base_dir", parameters,
                      "allowed_targets_for_role takes no base_dir: the one role -> agent owner cannot name a seat agent")
        return agent_surface.allowed_targets_for_role(role, base_dir=store or self.store)

    def resolve(self, service: str | None = "x", store: Path | None = None) -> Any:
        resolver = getattr(agent_surface, "resolve_seat_agent", None)
        self.assertIsNotNone(resolver, "agent_surface.resolve_seat_agent does not exist: no owner says which agent serves a service")
        return resolver(ROLE, service, base_dir=store or self.store)

    def assertGenericServes(self, resolution: Any, *, declined: str | None) -> None:
        self.assertEqual(resolution.agent, GENERIC)
        self.assertEqual(resolution.declined, declined)


class GrantTests(_Owner):
    """O1 (plan i) — a valid ACTIVE per-service agent is granted, through the one owner, to every reader."""

    def test_a_valid_active_agent_is_named_after_the_static_pairing(self) -> None:
        chain(self.store, SEAT_AGENT_X, "ACTIVE")
        self.assertEqual(self.allowed(), (GENERIC, SEAT_AGENT_X))

    def test_without_a_store_the_static_pairing_stands(self) -> None:
        # Pin. A caller with no store (the room fixtures, every other role's mint) sees the table as it was.
        chain(self.store, SEAT_AGENT_X, "ACTIVE")
        self.assertEqual(agent_surface.allowed_targets_for_role(ROLE), (GENERIC,))
        self.assertEqual(agent_surface.allowed_targets_for_role(ROLE), ROLE_TARGET_PAIRING[ROLE])

    def test_the_seat_agents_are_named_apart_from_the_static_pairing(self) -> None:
        chain(self.store, SEAT_AGENT_X, "ACTIVE")
        named = getattr(agent_surface, "service_seat_agents", None)
        self.assertIsNotNone(named, "agent_surface.service_seat_agents does not exist")
        self.assertEqual(set(named(ROLE, base_dir=self.store)), {SEAT_AGENT_X})

    def test_the_resolver_hands_the_granted_agent_its_service(self) -> None:
        chain(self.store, SEAT_AGENT_X, "ACTIVE")
        self.assertGenericServes(self.resolve("y"), declined=None)  # a service nobody claims: the generic, nothing declined
        resolution = self.resolve("x")
        self.assertEqual((resolution.agent, resolution.declined), (SEAT_AGENT_X, None))

    def test_a_mint_for_the_seat_agent_passes_the_pairing_check_and_the_contract_needs_the_store(self) -> None:
        chain(self.store, SEAT_AGENT_X, "ACTIVE")

        row, refused = try_mint(self.store, target=SEAT_AGENT_X, change_context=SEAT_CONTEXT)

        self.assertIsNone(refused, "the mint for a granted seat agent was refused")
        self.assertEqual(row["target_agent"], SEAT_AGENT_X)
        try:
            validate_request(row, base_dir=self.store)
        except GovernanceError as refusal:
            self.fail(f"the request contract refused a granted seat agent although it was handed the store: {refusal}")
        with self.assertRaises(GovernanceError, msg="the grant must need the store the ledger lives in"):
            validate_request(row)

    def test_a_custom_narrower_whitelist_still_binds_the_static_agents(self) -> None:
        # The contract's target test is the whitelist OR the seat agents: a caller that narrows the whitelist
        # to another agent still refuses the static one (the seat agents are added, never substituted).
        chain(self.store, SEAT_AGENT_X, "ACTIVE")
        row, refused = try_mint(self.store, target=GENERIC)
        self.assertIsNone(refused)
        validate_request(row, base_dir=self.store)
        with self.assertRaises(GovernanceError):
            validate_request(row, base_dir=self.store, target_agent_whitelist=("architectural-arbiter",))


class ClosedWorldTests(_Owner):
    """O2 (plan ii, adapted to the states main has) — only ACTIVE grants; every other state is declined by name."""

    def test_no_state_but_active_is_granted(self) -> None:
        for state in (s for s in GENESIS_LIFECYCLE_STATES if s != "ACTIVE"):
            with self.subTest(state=state):
                _, store = self.workspace(f"state-{state.lower()}")
                chain(store, SEAT_AGENT_X, state)

                self.assertNotIn(SEAT_AGENT_X, self.allowed(store))
                self.assertGenericServes(self.resolve("x", store), declined=f"{SEAT_AGENT_X}:state:{state}")

    def test_the_mint_refuses_the_agent_in_every_state_but_active(self) -> None:
        for state in (s for s in GENESIS_LIFECYCLE_STATES if s != "ACTIVE"):
            with self.subTest(state=state):
                _, store = self.workspace(f"mint-{state.lower()}")
                chain(store, SEAT_AGENT_X, state)

                row, refused = try_mint(store, target=SEAT_AGENT_X)

                self.assertIsNone(row, f"a {state} agent was minted for")
                if state == "SHADOW":
                    # The claim side's SHADOW block is asked first; either named refusal keeps the agent out.
                    self.assertRegex(refused, "shadow_agent_invocation_blocked|role_target_pairing_violation")
                else:
                    self.assertIn("role_target_pairing_violation", refused)


class ProofAndScopeTests(_Owner):
    def test_a_forged_active_without_the_proof_is_declined_with_the_chain_reason(self) -> None:
        # O3 (plan iv)
        chain(self.store, SEAT_AGENT_X, "ACTIVE", with_proof=False)

        self.assertNotIn(SEAT_AGENT_X, self.allowed())
        resolution = self.resolve()
        self.assertEqual(resolution.agent, GENERIC)
        self.assertIn(SEAT_AGENT_X, resolution.declined or "")
        self.assertIn("chain_invalid:", resolution.declined or "")
        self.assertIn("active_requires_kernel_computed_eval_superiority", resolution.declined or "")

    def test_a_room_scoped_active_row_does_not_grant_a_production_seat(self) -> None:
        # O4 (plan v)
        chain(self.store, SEAT_AGENT_X, "ACTIVE", scope="room:abc")

        self.assertNotIn(SEAT_AGENT_X, self.allowed())
        resolution = self.resolve()
        self.assertEqual(resolution.agent, GENERIC)
        self.assertIn(SEAT_AGENT_X, resolution.declined or "")
        self.assertIn("scope:room:abc", resolution.declined or "")

    def test_a_production_scope_or_no_scope_is_granted(self) -> None:
        # O4 near-miss
        for name, scope in (("production", "production"), ("unscoped", None)):
            with self.subTest(scope=name):
                _, store = self.workspace(f"scope-{name}")
                chain(store, SEAT_AGENT_X, "ACTIVE", scope=scope)

                self.assertIn(SEAT_AGENT_X, self.allowed(store))
                self.assertEqual(self.resolve("x", store).agent, SEAT_AGENT_X)


class ClosedRoleSetTests(_Owner):
    def test_only_the_change_intelligence_role_has_seat_agents(self) -> None:
        # O5 — the same ACTIVE agent, whose file claims another role, grants nothing for that role.
        self.assertEqual(set(getattr(agent_surface, "SERVICE_SEAT_ROLES", ())), {ROLE},
                         "agent_surface.SERVICE_SEAT_ROLES is not the closed set {change_intelligence}")
        _, store = self.workspace("other-role", replaces_role="evidence_judgment")
        chain(store, SEAT_AGENT_X, "ACTIVE")

        self.assertEqual(self.allowed(store, "evidence_judgment"), ("aria-evidence-judge",))
        self.assertEqual(self.allowed(store, "evidence_judgment"), ROLE_TARGET_PAIRING["evidence_judgment"])

    def test_a_file_that_serves_another_service_grants_nothing_for_this_one(self) -> None:
        # O5
        _, store = self.workspace("other-service", service="y")
        chain(store, SEAT_AGENT_X, "ACTIVE")

        self.assertGenericServes(self.resolve("x", store), declined=None)
        self.assertEqual(self.resolve("y", store).agent, SEAT_AGENT_X, "the near-miss: the agent serves the service its file names")


class FrontmatterMatrixTests(_Owner):
    """O6 — each key the grant reads is required; the generic agent serves otherwise, never a half-granted one."""

    def _assert_not_granted(self, store: Path) -> None:
        self.assertEqual(self.allowed(store), (GENERIC,))
        resolution = self.resolve("x", store)
        self.assertEqual(resolution.agent, GENERIC)
        self.assertTrue(
            resolution.declined is None or resolution.declined.startswith(f"{SEAT_AGENT_X}:"),
            f"the declined reason {resolution.declined!r} names something that is not the per-service agent",
        )

    def test_a_missing_file_grants_nothing(self) -> None:
        _, store = self.workspace("no-file", agent=False)
        chain(store, SEAT_AGENT_X, "ACTIVE")
        self._assert_not_granted(store)

    def test_a_file_for_another_role_grants_nothing(self) -> None:
        _, store = self.workspace("wrong-role", replaces_role="evidence_judgment")
        chain(store, SEAT_AGENT_X, "ACTIVE")
        self._assert_not_granted(store)

    def test_a_file_that_names_no_role_grants_nothing(self) -> None:
        _, store = self.workspace("no-role", replaces_role=None)
        chain(store, SEAT_AGENT_X, "ACTIVE")
        self._assert_not_granted(store)

    def test_a_file_that_names_no_service_grants_nothing(self) -> None:
        _, store = self.workspace("no-service", service=None)
        chain(store, SEAT_AGENT_X, "ACTIVE")
        self._assert_not_granted(store)

    def test_a_ledger_entity_whose_name_is_not_the_files_grants_nothing(self) -> None:
        # The file is aria-svc-x-reviewer.md; the ACTIVE chain belongs to an entity of another name.
        _, store = self.workspace("name-differs")
        chain(store, "aria-svc-x-other", "ACTIVE")
        self._assert_not_granted(store)

    def test_a_file_without_a_chain_grants_nothing(self) -> None:
        _, store = self.workspace("no-chain")
        self._assert_not_granted(store)


class AmbiguityTests(_Owner):
    def test_two_active_agents_claiming_one_service_are_both_declined_and_named_sorted(self) -> None:
        # O7
        first, second = "aria-svc-x-alpha", "aria-svc-x-beta"
        for name in (second, first):
            write_seat_agent(self.ws, name, service="x")
            chain(self.store, name, "ACTIVE")

        self.assertEqual(self.allowed(), (GENERIC,), "an ambiguous service granted one of its two claimants")
        resolution = self.resolve("x")
        self.assertEqual(resolution.agent, GENERIC)
        declined = resolution.declined or ""
        self.assertIn(first, declined)
        self.assertIn(second, declined)
        self.assertLess(declined.index(first), declined.index(second), "the claimants are named in sorted order")


class ProviderRoutingTests(_Owner):
    """O8 (plan iii) — a seat agent is granted only where the role's provider routing can route it."""

    def test_a_string_ladder_routes_every_target_of_its_role(self) -> None:
        # Pin: change_intelligence rides one ladder, so the seat agent inherits the generic agent's.
        routing = load_provider_routing()
        self.assertEqual(routing.ladder_for(ROLE, SEAT_AGENT_X), routing.ladder_for(ROLE, GENERIC))

    def test_the_routing_parity_check_reads_the_one_owner_not_the_constant(self) -> None:
        # (b) The shipped table, with the owner naming one more judge for the dict-routed panel role: the loader's
        # parity rule must refuse the table, because the owner (not ROLE_TARGET_PAIRING) is what it compares with.
        shipped = json.loads(Path(runtime_profiles.profiles_path()).read_text(encoding="utf-8"))
        table = shipped[runtime_profiles.PROVIDER_ROUTING_KEY]
        self.assertIsInstance(table["roles"]["human_required_adjudication"], dict, "the fixture needs a dict-routed role")
        real = agent_surface.allowed_targets_for_role

        def owner(role: str, *args: Any, **kwargs: Any) -> Any:
            targets = real(role)
            return (*targets, "aria-svc-extra-judge") if role == "human_required_adjudication" else targets

        with contextlib.ExitStack() as patched:
            patched.enter_context(mock.patch.object(agent_surface, "allowed_targets_for_role", owner))
            if hasattr(runtime_profiles, "allowed_targets_for_role"):
                patched.enter_context(mock.patch.object(runtime_profiles, "allowed_targets_for_role", owner))
            with self.assertRaises(GovernanceError, msg="the loader still compares with the constant") as refused:
                runtime_profiles._validate_routing(table)
        self.assertIn("provider_routing_targets:", str(refused.exception))

    def test_a_per_target_routing_that_does_not_name_the_agent_does_not_grant_it(self) -> None:
        # (c)
        chain(self.store, SEAT_AGENT_X, "ACTIVE")
        real = load_provider_routing()
        per_target = ProviderRouting(
            suspended_providers=real.suspended_providers, ladders=dict(real.ladders),
            roles={**real.roles, ROLE: {GENERIC: "glm_first"}},
        )
        with contextlib.ExitStack() as patched:
            patched.enter_context(mock.patch.object(runtime_profiles, "load_provider_routing", return_value=per_target))
            if hasattr(agent_surface, "load_provider_routing"):
                patched.enter_context(mock.patch.object(agent_surface, "load_provider_routing", return_value=per_target))
            allowed = self.allowed()
            resolution = self.resolve()

        self.assertEqual(allowed, (GENERIC,), "the agent was granted although its role's routing cannot route it")
        self.assertGenericServes(resolution, declined=f"{SEAT_AGENT_X}:provider_routing_target_unrouted")


class RemovedLiteralTests(unittest.TestCase):
    def test_pr_tracking_names_the_generic_agent_through_the_owner_not_a_literal(self) -> None:
        # O9 — the AST of the module, not a substring of its text: a string constant equal to the agent's name.
        literals = [
            node.lineno for node in ast.walk(ast.parse(inspect.getsource(pr_tracking)))
            if isinstance(node, ast.Constant) and node.value == GENERIC
        ]
        self.assertEqual(literals, [], "pr_tracking spells the role's agent as a literal beside the owner's table")
        self.assertEqual(pr_tracking.CHANGE_INTELLIGENCE_AGENT, ROLE_TARGET_PAIRING[ROLE][0])


if __name__ == "__main__":
    unittest.main()
