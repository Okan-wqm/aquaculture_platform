"""ARIA-HIGH-104 (2) — ONE validation suite a change must evidence.

Pre-fix: ``auto_merge._HYGIENE_DIMENSIONS`` demanded a verified exit-0 run
containing ``format:check`` — a command outside
``CANONICAL_VALIDATION_COMMANDS``, so outside what the plan contract admitted,
what staging ran as baseline, what the implementer was told to run and what
the pre-PR-open perimeter required. A change that ran exactly the suite every
contract stated could never merge.
"""
from __future__ import annotations

import shlex
import tempfile
import unittest
from pathlib import Path

from aria_kernel import auto_merge, command_policy, validation_suite
from aria_kernel.hooks import decide_pre_tool
from aria_kernel.implementation_safety import (
    BashAllowlistMiss,
    CANONICAL_VALIDATION_COMMANDS,
    CANONICAL_VALIDATION_COMMANDS_EXECUTABLE,
    HardFailContext,
    _check_test_gate_canonical_suite,
    canonical_command_satisfied_by,
    verify_bash_command_allowed,
)
from aria_kernel.plan_contract import plan_contract_violations, plan_validation_suite
from aria_kernel.validation import parse_allowed_command

_REPO_ROOT = Path(__file__).resolve().parents[2]


class OneSuiteTests(unittest.TestCase):
    def test_the_merge_gate_requires_exactly_the_canonical_suite(self) -> None:
        # Derived, not retyped: the hygiene battery IS the canonical tuple.
        self.assertIs(auto_merge._HYGIENE_DIMENSIONS, CANONICAL_VALIDATION_COMMANDS)
        self.assertIn("npm run format:check", CANONICAL_VALIDATION_COMMANDS)

    def test_every_merge_gate_command_is_one_the_plan_contract_admits(self) -> None:
        # What the merge gate demands evidence for must be declarable by a
        # plan — otherwise a plan doing everything it was told still cannot
        # merge — and runnable by the lane that records the evidence.
        with tempfile.TemporaryDirectory() as tmp:
            tools = Path(tmp) / "aria-tools"
            for command in auto_merge._HYGIENE_DIMENSIONS:
                with self.subTest(command=command):
                    body = {"validation_commands": [{"cmd": command}], "architectural_tier": 1, "key_changes": ["x"]}
                    self.assertEqual(plan_contract_violations(body, base_dir=tools), [])
                    self.assertIn(
                        [spelling for spelling in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE
                         if canonical_command_satisfied_by(spelling, command)][0],
                        plan_validation_suite(body, base_dir=tools),
                    )
            for spelling in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
                parse_allowed_command(spelling)

    def test_every_merge_gate_command_is_one_the_implementer_is_told_to_run(self) -> None:
        contract = (_REPO_ROOT / ".claude/agents/_shared/aria-implementer-safety-contract.md").read_text(encoding="utf-8")
        agent = (_REPO_ROOT / ".claude/agents/aria-implementer.md").read_text(encoding="utf-8")
        for command in auto_merge._HYGIENE_DIMENSIONS:
            with self.subTest(command=command):
                self.assertIn(command, contract)
        self.assertIn("CANONICAL_VALIDATION_COMMANDS", agent)
        self.assertNotIn("hygiene battery is\n   MANDATORY", agent)

    def test_the_perimeter_and_the_merge_gate_share_one_matching_rule(self) -> None:
        # Recorded runs are spelled the way the lane executes them; the
        # perimeter reads declared commands. Both read the same predicate, so
        # the executable spelling satisfies every canonical dimension on both.
        context = HardFailContext(validation_commands=tuple(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        self.assertTrue(_check_test_gate_canonical_suite(context).passed)
        runs = [{"status": "ok", "cmd": spelling, "validation_run_id": f"run-{index}"}
                for index, spelling in enumerate(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE)]
        self.assertEqual(auto_merge._hygiene_battery_result(runs)["missing"], [])
        # A narrowed suite (trailing argument) still counts; a mention does not.
        self.assertTrue(canonical_command_satisfied_by("npx nx affected --target=test --parallel=1", "nx affected --target=test"))
        self.assertFalse(canonical_command_satisfied_by("echo 'nx affected --target=test'", "nx affected --target=test"))
        self.assertFalse(canonical_command_satisfied_by("npm run format", "npm run format:check"))

    def test_every_suite_entry_is_runnable_under_the_implementer_s_own_gate(self) -> None:
        """The gap the verifier of ARIA-HIGH-104 found: the envelope and the
        prompt told the implementer to run the suite, and the Bash allowlist
        it runs under (``verify_bash_command_allowed`` — the PreToolUse hook's
        rule) refused ``npm run format:check`` and every ``npx nx …`` entry.
        The allow rules are now DERIVED from the suite (``command_policy.
        VALIDATION_SUITE_RULES``), so every executable spelling, narrowed or
        not, passes the kernel matcher, the hook and the Claude projection."""
        self.assertIs(validation_suite.CANONICAL_VALIDATION_COMMANDS_EXECUTABLE, CANONICAL_VALIDATION_COMMANDS_EXECUTABLE)
        self.assertEqual(
            [rule.pattern for rule in command_policy.VALIDATION_SUITE_RULES],
            [validation_suite.bash_allow_pattern_for(s) for s in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE],
        )
        allow, _deny = command_policy.claude_permission_rules(external_writes=False)
        with tempfile.TemporaryDirectory() as workspace:
            for spelling in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
                for command in (spelling, f"{spelling} --projects=farm-service"):
                    with self.subTest(command=command):
                        verify_bash_command_allowed(shlex.split(command))
                        self.assertNotEqual(command_policy.classify_command(command)[0], "unknown")
                        verdict = decide_pre_tool(
                            {"tool_name": "Bash", "tool_input": {"command": command}}, workspace_root=workspace,
                        )
                        self.assertEqual(verdict.decision, "allow", verdict)
                        self.assertTrue(
                            any(command_policy.claude_rule_matches(rule, command) for rule in allow), command,
                        )
        # The derived rule admits the invocation, not a mention of it and not
        # a longer word it prefixes.
        for spelling in CANONICAL_VALIDATION_COMMANDS_EXECUTABLE:
            for refused in (f"echo '{spelling}'", f"{spelling}ing"):
                with self.subTest(refused=refused), self.assertRaises(BashAllowlistMiss):
                    verify_bash_command_allowed(shlex.split(refused))
        self.assertEqual(command_policy.verify_examples(), [])

    def test_the_battery_names_the_missing_command_in_its_own_spelling(self) -> None:
        runs = [{"status": "ok", "cmd": "npx nx affected --target=test", "validation_run_id": "run-1"},
                {"status": "failed", "cmd": "npm run format:check", "validation_run_id": "run-2"}]
        result = auto_merge._hygiene_battery_result(runs)
        self.assertEqual(result["satisfied"], {"nx affected --target=test": "run-1"})
        self.assertEqual(
            result["missing"],
            [command for command in CANONICAL_VALIDATION_COMMANDS if command != "nx affected --target=test"],
        )


if __name__ == "__main__":
    unittest.main()
