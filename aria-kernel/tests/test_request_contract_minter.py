"""ARIA-HIGH-104 (1) — the request row IS the request envelope, and its
``validation_commands`` are the plan's.

Pre-fix: ``aria/agent-request/v1`` listed ``validation_commands`` (and
``forbidden_scope``) as REQUIRED and the prompt printed a "Validation
commands" section, but ``create_agent_invocation_request`` never wrote either
field and stamped a different ``$schema`` — so the request validator could
not accept a single row the queue produced, and the implementer's prompt
printed ``_(none)_`` under the section that was supposed to tell it what to
run.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_contract import REQUEST_REQUIRED_FIELDS, REQUEST_SCHEMA, validate_request
from aria_kernel.agent_invocations import create_agent_invocation_request, render_invocation_prompt
from aria_kernel.convergent_planning_bridge import issue_challenger_envelope
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE
from aria_kernel.must_satisfy import must_satisfy_item
from aria_kernel.plan_contract import plan_validation_suite
from aria_kernel.plan_convergence import fold_plan_state, plan_body_for_revision, start_plan
from aria_kernel.tool_registry import GovernanceError

from tests.test_implementation_lifecycle_continuity import converging_plan_content


class MinterWritesTheContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        start_plan(
            plan_id="plan-104-seed", initial_revision_id="rev-0",
            plan_content=converging_plan_content("seed"), base_dir=self.tools,
        )
        self.seed_hash = fold_plan_state(plan_id="plan-104-seed", base_dir=self.tools)["latest_revision"]["content_hash"]

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _mint(self, **overrides):
        kwargs = dict(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="judge it",
            must_satisfy=[must_satisfy_item(id="verdict", description="true or false")],
            allowed_scope=["apps/svc/**"], evidence_refs=["apps/svc/src/a.ts:1"],
            base_dir=self.tools, cycle_id="cyc-104",
        )
        kwargs.update(overrides)
        return create_agent_invocation_request(**kwargs)

    def test_the_minter_writes_every_required_field_of_the_schema(self) -> None:
        # Caller and callee pinned together: the schema's REQUIRED tuple is
        # read from the contract module and every name must be a key the
        # queue wrote — not a key a reader defaulted in later.
        row = self._mint()
        self.assertEqual(row["$schema"], REQUEST_SCHEMA)
        missing = [field for field in REQUEST_REQUIRED_FIELDS if field not in row]
        self.assertEqual(missing, [])
        self.assertEqual(row["forbidden_scope"], [])
        self.assertEqual(row["validation_commands"], [])
        validate_request(row, base_dir=self.tools)

    def test_a_row_naming_a_plan_revision_carries_that_revisions_suite(self) -> None:
        row = self._mint(convergence_id="plan-104-seed", plan_revision_hash=self.seed_hash)
        body = plan_body_for_revision(plan_id="plan-104-seed", content_hash=self.seed_hash, base_dir=self.tools)
        expected = list(plan_validation_suite(body["plan_content"], base_dir=self.tools))
        self.assertEqual(row["validation_commands"], expected)
        self.assertEqual(expected[: len(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE)], list(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        prompt = render_invocation_prompt(row)
        self.assertIn("## Validation commands", prompt)
        for command in expected:
            self.assertIn(f"  - `{command}`", prompt)
        validate_request(row, base_dir=self.tools)

    def test_a_planner_envelope_carries_the_seeds_suite(self) -> None:
        row = issue_challenger_envelope(
            plan_id="plan-104-seed", round_number=1,
            must_satisfy=[must_satisfy_item(id="draft", description="write a competing plan")],
            evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["docs/**"],
            base_dir=self.tools, plan_revision_hash=self.seed_hash, cycle_id="cyc-104",
        )
        body = plan_body_for_revision(plan_id="plan-104-seed", content_hash=self.seed_hash, base_dir=self.tools)
        self.assertEqual(row["validation_commands"], list(plan_validation_suite(body["plan_content"], base_dir=self.tools)))
        validate_request(row, base_dir=self.tools)

    def test_a_seed_the_contract_refuses_never_opens_a_plan(self) -> None:
        # The drainer's opener refuses before `start_plan`, in the contract's
        # wording: a seed with an undeclared command would otherwise start
        # rounds whose envelopes cannot derive a suite and whose body the
        # CONVERGED gate refuses anyway.
        from aria_kernel.convergent_planning_bridge import start_convergent_plan_drafted_by_primary

        seed = converging_plan_content("bad seed", validation_commands=[{"cmd": "python3 -m unittest discover"}])
        seed.pop("architectural_tier")
        with self.assertRaisesRegex(GovernanceError, "plan_contract_violation: plan_validation_command_not_declared"):
            start_convergent_plan_drafted_by_primary(
                plan_id="plan-104-bad-seed", plan_content=seed, initial_revision_id="r1", base_dir=self.tools,
            )
        self.assertFalse(fold_plan_state(plan_id="plan-104-bad-seed", base_dir=self.tools).get("plan_started"))
        good = converging_plan_content("good seed")
        good.pop("architectural_tier")
        start_convergent_plan_drafted_by_primary(
            plan_id="plan-104-good-seed", plan_content=good, initial_revision_id="r1", base_dir=self.tools,
        )

    def test_a_body_the_contract_refuses_carries_no_suite_and_cannot_be_implemented(self) -> None:
        # A plan started by hand around the opener (the CLI, a fixture) with a
        # command the contract refuses: its planner envelopes state no suite
        # rather than one the lane cannot run, both sides agreeing through
        # `plan_contract.envelope_validation_suite`; an implementation
        # envelope on it is refused outright.
        from aria_kernel.plan_origin import commit_contract_for_plan

        start_plan(
            plan_id="plan-104-hand-started", initial_revision_id="rev-0",
            plan_content=converging_plan_content("hand", validation_commands=[{"cmd": "npx nx test notification-service"}]),
            base_dir=self.tools,
        )
        hand_hash = fold_plan_state(plan_id="plan-104-hand-started", base_dir=self.tools)["latest_revision"]["content_hash"]
        row = self._mint(convergence_id="plan-104-hand-started", plan_revision_hash=hand_hash)
        self.assertEqual(row["validation_commands"], [])
        validate_request(row, base_dir=self.tools)
        envelope = dict(row, role="implementation", target_agent="aria-implementer",
                        commit_contract=commit_contract_for_plan({}, plan_id="plan-104-hand-started"))
        with self.assertRaisesRegex(GovernanceError, "implementation_plan_breaks_the_plan_contract"):
            validate_request(envelope, base_dir=self.tools)

    def test_a_revision_the_ledger_holds_no_body_for_carries_no_suite(self) -> None:
        row = self._mint(convergence_id="plan-104-seed", plan_revision_hash="sha256:" + "f" * 64)
        self.assertEqual(row["validation_commands"], [])
        validate_request(row, base_dir=self.tools)


class ValidatorRefusesDisagreementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools = Path(self.tmp.name) / "aria-tools"
        start_plan(
            plan_id="plan-104-seed", initial_revision_id="rev-0",
            plan_content=converging_plan_content("seed"), base_dir=self.tools,
        )
        self.seed_hash = fold_plan_state(plan_id="plan-104-seed", base_dir=self.tools)["latest_revision"]["content_hash"]
        self.row = create_agent_invocation_request(
            target_agent="aria-evidence-judge", role="evidence_judgment",
            suggested_prompt="judge it",
            must_satisfy=[must_satisfy_item(id="verdict", description="true or false")],
            allowed_scope=["apps/svc/**"], evidence_refs=["apps/svc/src/a.ts:1"],
            base_dir=self.tools, cycle_id="cyc-104",
            convergence_id="plan-104-seed", plan_revision_hash=self.seed_hash,
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_absent_validation_commands_are_refused(self) -> None:
        envelope = {key: value for key, value in self.row.items() if key != "validation_commands"}
        with self.assertRaisesRegex(GovernanceError, "missing required fields: \\['validation_commands'\\]"):
            validate_request(envelope, base_dir=self.tools)

    def test_a_suite_disagreeing_with_the_named_revision_is_refused(self) -> None:
        envelope = dict(self.row)
        envelope["validation_commands"] = ["npm run test"]
        with self.assertRaisesRegex(GovernanceError, "validation_commands_disagree_with_plan_revision"):
            validate_request(envelope, base_dir=self.tools)
        envelope["validation_commands"] = []
        with self.assertRaisesRegex(GovernanceError, "validation_commands_disagree_with_plan_revision"):
            validate_request(envelope, base_dir=self.tools)

    def test_an_implementation_envelope_must_name_a_reproducible_body(self) -> None:
        from aria_kernel.plan_origin import commit_contract_for_plan

        envelope = dict(self.row)
        envelope.update(role="implementation", target_agent="aria-implementer",
                        plan_revision_hash="sha256:" + "e" * 64, validation_commands=[],
                        commit_contract=commit_contract_for_plan({}, plan_id="plan-104-seed"))
        with self.assertRaisesRegex(GovernanceError, "implementation_plan_body_unavailable"):
            validate_request(envelope, base_dir=self.tools)
        envelope.update(convergence_id=None, plan_revision_hash=None)
        with self.assertRaisesRegex(GovernanceError, "implementation_envelope_names_no_plan_revision"):
            validate_request(envelope, base_dir=self.tools)

    def test_an_implementation_envelope_must_carry_the_plans_own_commit_contract(self) -> None:
        from aria_kernel.plan_contract import plan_validation_suite
        from aria_kernel.plan_convergence import plan_body_for_revision
        from aria_kernel.plan_origin import commit_contract_for_plan

        body = plan_body_for_revision(plan_id="plan-104-seed", content_hash=self.seed_hash, base_dir=self.tools)
        envelope = dict(self.row)
        envelope.update(role="implementation", target_agent="aria-implementer",
                        validation_commands=list(plan_validation_suite(body["plan_content"], base_dir=self.tools)))
        with self.assertRaisesRegex(GovernanceError, "commit_contract_required"):
            validate_request(envelope, base_dir=self.tools)
        envelope["commit_contract"] = commit_contract_for_plan({"finding_id": "ORPHAN-HIGH-999"}, plan_id="plan-104-seed")
        with self.assertRaisesRegex(GovernanceError, "commit_contract_disagrees_with_plan_origin"):
            validate_request(envelope, base_dir=self.tools)
        envelope["commit_contract"] = commit_contract_for_plan(body["plan_content"], plan_id="plan-104-seed")
        validate_request(envelope, base_dir=self.tools)


if __name__ == "__main__":
    unittest.main()
