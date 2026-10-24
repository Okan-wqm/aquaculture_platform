"""ARIA-HIGH-431 — trusted repo code is anchored to the checkout's root.

The implementer's command policy trusted any absolute path that CONTAINED a
trusted prefix (``"/tools/aria-poc/" in path``), so
``python3 /tmp/x/tools/aria-poc/evil.py`` and
``python3 <checkout>/apps/x/tools/aria-poc/e.py``, which an implementer can
write, both passed. The hook passed the absolute workspace as ``cwd``, which
the relative-path branch read as the command's working directory. So the
same gate refused every RELATIVE trusted script
(``python3 tools/aria-poc/poc.py --help``, the policy's own allow example).
The rule now has one owner (``trusted_python_script``): the path relative to
the checkout root the CALLER names must start with a trusted prefix.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel import implementation_safety as impl
from aria_kernel.hooks import decide_pre_tool
from aria_kernel.implementation_safety import (
    TRUSTED_PYTHON_SCRIPT_PREFIXES,
    BashAllowlistMiss,
    readonly_paths,
    verify_bash_command_allowed,
)

_CHECKOUT = Path(__file__).resolve().parents[2]


def _bash(command: str, workspace: Path):
    return decide_pre_tool({"tool_name": "Bash", "tool_input": {"command": command}}, workspace_root=workspace)


class CheckoutFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-trust-", dir="/var/tmp")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        for relative in ("tools/aria-poc/poc.py", "apps/x/tools/aria-poc/e.py", "aria-kernel/tests/_helpers/h.py"):
            (self.root / relative).parent.mkdir(parents=True, exist_ok=True)
            (self.root / relative).write_text("print('x')\n", encoding="utf-8")


class TheImplementerGateTests(CheckoutFixture):
    """The PreToolUse hook — the gate the implementer's Bash actually meets."""

    def test_the_security_reviewers_repros_are_refused(self) -> None:
        for command in (
            "python3 /tmp/x/tools/aria-poc/evil.py",
            f"python3 {self.root}/apps/x/tools/aria-poc/e.py",
            "python3 /etc/x/aria-kernel/tests/_helpers/e.py",
            f"python3 {self.root}/tools/aria-poc/../../apps/x/tools/aria-poc/e.py",
            "python3 apps/x/tools/aria-poc/e.py",
        ):
            with self.subTest(command=command):
                verdict = _bash(command, self.root)
                self.assertEqual(verdict.decision, "deny", verdict.reason)

    def test_the_checkouts_own_trusted_code_is_allowed_relative_or_absolute(self) -> None:
        for command in (
            "python3 tools/aria-poc/poc.py --help",
            f"python3 {self.root}/tools/aria-poc/poc.py --help",
            "python3 aria-kernel/tests/_helpers/h.py",
        ):
            with self.subTest(command=command):
                verdict = _bash(command, self.root)
                self.assertEqual(verdict.decision, "allow", verdict.reason)

    def test_a_symlink_under_a_trusted_prefix_does_not_carry_trust_elsewhere(self) -> None:
        (self.root / "tools" / "aria-poc" / "link.py").symlink_to(self.root / "apps" / "x" / "tools" / "aria-poc" / "e.py")
        self.assertEqual(_bash("python3 tools/aria-poc/link.py", self.root).decision, "deny")


class TheRuleTests(CheckoutFixture):
    def test_an_absolute_program_needs_the_root_that_anchors_it(self) -> None:
        program = f"{self.root}/tools/aria-poc/poc.py"
        with self.assertRaisesRegex(BashAllowlistMiss, "no checkout root anchors it"):
            verify_bash_command_allowed(["python3", program])
        verify_bash_command_allowed(["python3", program], checkout_root=self.root)
        with self.assertRaisesRegex(BashAllowlistMiss, "outside the checkout root"):
            verify_bash_command_allowed(["python3", program], checkout_root=self.root / "apps")
        self.assertEqual(impl.trusted_python_script(program, checkout_root=self.root), "tools/aria-poc/poc.py")

    def test_a_relative_program_is_read_from_a_checkout_relative_cwd(self) -> None:
        verify_bash_command_allowed(["python3", "poc.py"], cwd="tools/aria-poc", checkout_root=self.root)
        with self.assertRaisesRegex(BashAllowlistMiss, "cwd must be checkout-relative"):
            verify_bash_command_allowed(["python3", "poc.py"], cwd=str(self.root / "tools/aria-poc"))
        with self.assertRaises(BashAllowlistMiss):
            verify_bash_command_allowed(["python3", "e.py"], cwd="apps/x/tools/aria-poc", checkout_root=self.root)

    def test_the_hard_fail_check_anchors_at_the_actions_workspace(self) -> None:
        context = impl.HardFailContext(bash_argv=("python3", f"{self.root}/apps/x/tools/aria-poc/e.py"), workspace_root=self.root)
        self.assertFalse(impl._check_bash_command_allowlist(context).passed)
        context = impl.HardFailContext(bash_argv=("python3", "tools/aria-poc/poc.py"), workspace_root=self.root)
        self.assertTrue(impl._check_bash_command_allowlist(context).passed)


class AdapterRunnerTests(unittest.TestCase):
    """A registered runner's absolute program is trusted only as the running
    kernel's own code, the rule the room binds by."""

    def test_a_runner_definition_names_kernel_code_or_is_rejected(self) -> None:
        from aria_kernel.tool_registry import GovernanceError, validate_runner_definition

        helper = _CHECKOUT / "aria-kernel" / "tests" / "_helpers" / "adapter_room_probe.py"
        runner = {"type": "subprocess", "cwd": ".", "timeout_ms": 1000, "stdin_json": False}
        validate_runner_definition({**runner, "argv": ["python3", str(helper)]})
        for planted in ("/tmp/x/tools/aria-poc/evil.py", f"{_CHECKOUT}/apps/x/tools/aria-poc/e.py"):
            with self.subTest(planted=planted), self.assertRaises(GovernanceError):
                validate_runner_definition({**runner, "argv": ["python3", planted]})


class TrustedPrefixesAreReadOnlyTests(unittest.TestCase):
    def test_every_trusted_prefix_is_a_tracked_directory_under_a_readonly_path(self) -> None:
        # A spawn with a write scope can create nothing under a trusted
        # prefix of its own checkout: READONLY_PATHS are ro-bound and refused
        # by the Edit/Write hook. A prefix outside them would let an
        # implementer author the code the policy then trusts.
        tracked = subprocess.run(
            ["git", "-C", str(_CHECKOUT), "ls-files", "--", *TRUSTED_PYTHON_SCRIPT_PREFIXES],
            capture_output=True, text=True, check=True, env={k: v for k, v in os.environ.items() if not k.startswith("GIT_")},
        ).stdout.splitlines()
        for prefix in TRUSTED_PYTHON_SCRIPT_PREFIXES:
            with self.subTest(prefix=prefix):
                self.assertTrue(any(ro.endswith("/") and prefix.startswith(ro) for ro in readonly_paths()), prefix)
                self.assertTrue(any(path.startswith(prefix) for path in tracked), prefix)


if __name__ == "__main__":
    unittest.main()
