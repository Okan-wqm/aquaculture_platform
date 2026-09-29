"""ARIA-HIGH-240 — every kernel change compacts and verifies the real aria/state tip.

ARIA-HIGH-185's compaction change (8028bbb005) merged with a green kernel lane
and made every compacted tree one the kernel's own verify refuses
(ARIA-HIGH-239): no pre-merge lane ran the maintenance compaction on real
state, so the first run to do it was the next scheduled
``aria-state-maintenance``, and that lane stayed red from 2026-09-21 to
2026-09-29. The ``state`` job of ``aria-kernel.yml`` runs that lane's
compaction and verify with the change's own kernel on the live tip.

A gate that stands in for another lane is only worth what its likeness is, so
these tests pin the likeness on the parsed workflow graph — the same way
``test_compaction_attestation`` pins the maintenance lane's verify to the
executor's: the gate's compact and verify steps ARE the maintenance lane's
(name, id, env and run, byte for byte), the store comes from the one restore
action, a refused tree fails the job, nothing is published, and the lane's
verdict job requires the gate.
"""

from __future__ import annotations

import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

_WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
KERNEL = _WORKFLOWS / "aria-kernel.yml"
MAINTENANCE = _WORKFLOWS / "aria-state-maintenance.yml"

RESTORE_ACTION = "./.github/actions/restore-aria-state"
COMPACT_STEP = "Compact surfaces and strip old artifacts (canonical CLI)"
VERIFY_STEP = "Verify ARIA state integrity"
# The keys that make a step do what it does. `if:` is among them: the
# maintenance lane has none on these two steps, so neither may the gate.
_BEHAVIOUR_KEYS = ("name", "id", "env", "run", "if", "uses", "with")


def _workflow(path: Path) -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def _steps(path: Path, job: str) -> list[dict[str, Any]]:
    return _workflow(path)["jobs"][job]["steps"]


def _named(steps: list[dict[str, Any]], name: str) -> dict[str, Any]:
    matches = [step for step in steps if step.get("name") == name]
    if len(matches) != 1:
        raise AssertionError(f"expected one step named {name!r}, found {len(matches)}")
    return matches[0]


def _behaviour(step: dict[str, Any]) -> dict[str, Any]:
    return {key: step[key] for key in _BEHAVIOUR_KEYS if key in step}


class TheGateIsTheMaintenanceLanesCompaction(unittest.TestCase):
    def setUp(self) -> None:
        self.gate = _steps(KERNEL, "state")
        self.maintenance = _steps(MAINTENANCE, "compact")

    def test_the_compact_and_verify_steps_are_the_maintenance_lanes_own(self) -> None:
        for name in (COMPACT_STEP, VERIFY_STEP):
            with self.subTest(step=name):
                self.assertEqual(
                    _behaviour(_named(self.gate, name)),
                    _behaviour(_named(self.maintenance, name)),
                )

    def test_the_store_comes_from_the_one_restore_action_before_the_compaction(self) -> None:
        uses = [step.get("uses") for step in self.gate]
        names = [step.get("name") for step in self.gate]
        self.assertEqual(uses.count(RESTORE_ACTION), 1)
        restore = uses.index(RESTORE_ACTION)
        self.assertLess(restore, names.index(COMPACT_STEP))
        self.assertLess(names.index(COMPACT_STEP), names.index(VERIFY_STEP))

    def test_a_tree_the_verifier_refuses_fails_the_job(self) -> None:
        names = [step.get("name") or "" for step in self.gate]
        verify = names.index(VERIFY_STEP)
        failing = [
            step
            for step in self.gate[verify + 1:]
            if "steps.integrity.outputs.state_valid != 'true'" in str(step.get("if", ""))
        ]
        self.assertEqual(len(failing), 1)
        self.assertIn("always()", failing[0]["if"])
        self.assertIn("exit 1", failing[0]["run"])


class TheGatePublishesNothing(unittest.TestCase):
    def test_no_step_publishes_commits_or_pushes(self) -> None:
        for step in _steps(KERNEL, "state"):
            run = step.get("run", "")
            for verb in ("state publish", "git commit", "git push"):
                with self.subTest(step=step.get("name") or step.get("uses"), verb=verb):
                    self.assertNotIn(verb, run)

    def test_the_restore_can_neither_create_the_branch_nor_write_it(self) -> None:
        restore = next(step for step in _steps(KERNEL, "state") if step.get("uses") == RESTORE_ACTION)
        # No bootstrap-ack: a missing aria/state is refused, never created.
        self.assertNotIn("bootstrap-ack", restore.get("with") or {})
        workflow = _workflow(KERNEL)
        self.assertEqual(workflow["permissions"], {"contents": "read"})
        self.assertNotIn("permissions", workflow["jobs"]["state"])


class TheLaneVerdictRequiresTheGate(unittest.TestCase):
    def test_the_aria_kernel_job_needs_the_gate_and_requires_its_success(self) -> None:
        verdict = _workflow(KERNEL)["jobs"]["aria-kernel"]
        self.assertIn("state", verdict["needs"])
        required = [step for step in verdict["steps"] if "STATE_RESULT" in (step.get("env") or {})]
        self.assertEqual(len(required), 1)
        self.assertEqual(required[0]["env"]["STATE_RESULT"], "${{ needs.state.result }}")
        self.assertIn('test "${STATE_RESULT}" = success', required[0]["run"])


if __name__ == "__main__":
    unittest.main()
