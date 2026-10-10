"""ARIA-CRITICAL-399 — the seams that execute adapter code go through the room.

Scoped on purpose to the functions that START untrusted code, not a
kernel-wide ban: the kernel has well over a hundred process starts of its own
(git, gh, the state store's push, which carries its credential in
``GIT_CONFIG_*`` deliberately), and they are not adapter code. Each seam
below is named, and the test fails when one of them starts a process
directly or stops passing through ``adapter_room``:

* ``tool_runner.run_tool`` — every scheduled adapter run;
* ``fixture_runner.run_fixture_case`` — every fixture/calibration run;
* ``genesis_adapter_custody.run_staged_adapter`` — the one place a drafted
  adapter's bytes start (ARIA-HIGH-414). The LIVE genesis calibration run
  (``skill_genesis.execute_adapter_against_corpus``, reached through
  ``dispatcher_factory.select_sandbox_runner`` from the nightly
  orchestrator's convergent skill authoring) reaches the room only through
  it, and starts no process of its own. ``skill_genesis_sandbox.
  execute_in_sandbox``, which ran a drafted adapter by FILE PATH, is gone.

The two adapter runners also ask custody first (``verify_genesis_dispatch``),
so a genesis tool runs only as its verified custody bytes.

The other two seams that execute repository or agent code already have their
own pins and are not repeated here: the validation lane builds its child's
environment through ``build_validation_env`` and contains it with the spawn
wrapper (``tests/test_validation_env.py``,
``test_validation_module_reads_os_environ_only_as_the_builder_base``), and an
agent spawn is built by ``agent_env.build_agent_env`` and contained by the
managed sandbox (``tests/invariants/v12/test_phase_v12_b_agent_env.py``,
``I_V12_ENV_03``).
"""
from __future__ import annotations

import ast
import inspect
import re
import textwrap
import unittest
from pathlib import Path

from aria_kernel import adapter_room, fixture_runner, genesis_adapter_custody, skill_genesis, tool_runner

_REPO_ROOT = Path(__file__).resolve().parents[2]
_AUTO_CYCLE = _REPO_ROOT / ".github" / "workflows" / "aria-auto-cycle.yml"

_PROCESS_STARTS = {
    ("subprocess", "run"), ("subprocess", "Popen"), ("subprocess", "call"),
    ("subprocess", "check_call"), ("subprocess", "check_output"),
    ("os", "system"), ("os", "popen"), ("os", "execv"), ("os", "execve"), ("os", "execvp"),
    ("os", "spawnv"), ("os", "posix_spawn"),
}
SEAMS = (
    (tool_runner, "run_tool"),
    (fixture_runner, "run_fixture_case"),
    (genesis_adapter_custody, "run_staged_adapter"),
)
# The genesis calibration path: it reaches the room only through
# `run_staged_adapter`, the seam above.
CALIBRATION_PATH = (
    (skill_genesis, "execute_adapter_against_corpus"),
    (skill_genesis, "_calibrate_staged"),
)


def _function(module, name: str) -> ast.FunctionDef:
    tree = ast.parse(textwrap.dedent(inspect.getsource(getattr(module, name))))
    node = tree.body[0]
    assert isinstance(node, ast.FunctionDef)
    return node


def _calls(node: ast.AST) -> list[ast.Call]:
    return [child for child in ast.walk(node) if isinstance(child, ast.Call)]


def _dotted(call: ast.Call) -> tuple[str, str] | None:
    func = call.func
    if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
        return (func.value.id, func.attr)
    return None


def _called_names(node: ast.AST) -> set[str]:
    names = set()
    for call in _calls(node):
        if isinstance(call.func, ast.Name):
            names.add(call.func.id)
        elif isinstance(call.func, ast.Attribute):
            names.add(call.func.attr)
    return names


class SeamPinTests(unittest.TestCase):
    def test_every_seam_runs_its_adapter_through_the_room(self) -> None:
        for module, name in SEAMS:
            with self.subTest(seam=f"{module.__name__}.{name}"):
                node = _function(module, name)
                self.assertTrue({"prepare_adapter_spawn", "run_adapter"} <= _called_names(node),
                                "the seam must build and run its adapter through adapter_room")

    def test_no_seam_starts_a_process_of_its_own(self) -> None:
        for module, name in SEAMS:
            with self.subTest(seam=f"{module.__name__}.{name}"):
                direct = [_dotted(call) for call in _calls(_function(module, name)) if _dotted(call) in _PROCESS_STARTS]
                self.assertEqual(direct, [], "an adapter process started outside adapter_room.run_adapter")

    def test_the_genesis_calibration_starts_nothing_and_runs_through_custody(self) -> None:
        for module, name in CALIBRATION_PATH:
            with self.subTest(step=f"{module.__name__}.{name}"):
                direct = [_dotted(call) for call in _calls(_function(module, name)) if _dotted(call) in _PROCESS_STARTS]
                self.assertEqual(direct, [], "a drafted adapter started outside run_staged_adapter")
        self.assertIn("run_staged_adapter", _called_names(_function(skill_genesis, "_calibrate_staged")))

    def test_both_adapter_runners_ask_custody_before_they_spawn(self) -> None:
        for module, name in ((tool_runner, "run_tool"), (fixture_runner, "run_fixture_case")):
            with self.subTest(seam=f"{module.__name__}.{name}"):
                self.assertIn("verify_genesis_dispatch", _called_names(_function(module, name)))

    def test_the_room_starts_exactly_one_process_with_the_built_environment(self) -> None:
        tree = ast.parse(inspect.getsource(adapter_room))
        starts = [call for call in _calls(tree) if _dotted(call) in _PROCESS_STARTS]
        self.assertEqual(len(starts), 1, "adapter_room has one process start: run_adapter")
        keywords = {keyword.arg: keyword.value for keyword in starts[0].keywords}
        self.assertIn("env", keywords)
        self.assertEqual(ast.unparse(keywords["env"]), "spawn.env")
        self.assertNotIn("os.environ", ast.unparse(starts[0]))


class LaneProvisioningTests(unittest.TestCase):
    """The nightly lane runs adapters in mock nights too, so it verifies the
    backend on every cycle run — the room has no mock exemption."""

    def test_the_auto_cycle_lane_verifies_the_backend_whatever_the_mock_mode(self) -> None:
        text = _AUTO_CYCLE.read_text(encoding="utf-8")
        step = re.search(
            r"- name: Ensure a verified sandbox backend\n(?P<body>(?:\s{8,}.*\n)+)", text,
        )
        self.assertIsNotNone(step, "the auto-cycle lane must verify a sandbox backend")
        body = step.group("body")
        self.assertIn("uses: ./.github/actions/ensure-sandbox-backend", body)
        condition = re.search(r"^\s+if:\s*(?P<expr>.+)$", body, re.MULTILINE)
        self.assertIsNotNone(condition)
        self.assertNotIn("mock", condition.group("expr"),
                         "a mock night still runs every adapter; the room it needs cannot be skipped")


if __name__ == "__main__":
    unittest.main()
