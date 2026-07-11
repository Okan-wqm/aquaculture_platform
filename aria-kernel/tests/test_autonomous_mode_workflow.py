"""Stage D — operator-gated autonomous mode wired into aria-auto-cycle.

Pins the enablement surface so a refactor cannot silently demote the
autonomous path back to standard-only:

* the workflow exposes mode=autonomous-cycle (workflow_dispatch choice) and
  an operator_approval_ref input;
* the autonomous step runs ``--profile autonomous`` WITH the approval ref,
  validates the ref non-empty, and replays the async bridge (bounded loop);
* the nightly cron path stays standard (schedule resolves mode='cycle');
* the signing-key surface aria-debts/keys is gitignored (private key
  material must never be stageable) and declared in the workflow contract.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_WF = _REPO / ".github" / "workflows" / "aria-auto-cycle.yml"


class AutonomousModeWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = _WF.read_text(encoding="utf-8")

    def test_mode_choice_includes_autonomous_cycle(self) -> None:
        self.assertIn("- 'autonomous-cycle'", self.text)
        self.assertIn("operator_approval_ref:", self.text)

    def test_autonomous_step_runs_autonomous_profile_with_approval_ref(self) -> None:
        step = self._autonomous_step_block()
        self.assertIn("--profile autonomous", step)
        self.assertIn('--operator-approval-ref "$OPERATOR_APPROVAL_REF"', step)
        # Empty approval ref must hard-fail before any kernel invocation.
        self.assertLess(
            step.index("requires operator_approval_ref"),
            step.index("--profile autonomous"),
        )

    def test_autonomous_step_replays_async_bridge_bounded(self) -> None:
        step = self._autonomous_step_block()
        self.assertIn("bridge_replay_required", step)
        self.assertIn("MAX_PASSES=6", step)

    def test_autonomous_step_is_dispatch_gated_not_scheduled(self) -> None:
        step_if = re.search(
            r"- name: Run operator-gated autonomous cycle\s*\n\s*if: ([^\n]+)",
            self.text,
        )
        self.assertIsNotNone(step_if)
        # `github.event.inputs.mode == 'autonomous-cycle'` is unreachable
        # from the cron trigger (inputs are empty on schedule events).
        self.assertIn("github.event.inputs.mode == 'autonomous-cycle'", step_if.group(1))

    def test_nightly_cycle_step_stays_standard_profile(self) -> None:
        nightly = self._step_block("Run nightly standard-profile cycle")
        self.assertIn("--profile standard", nightly)
        self.assertNotIn("--profile autonomous", nightly)

    def test_signing_key_surface_is_gitignored_and_contracted(self) -> None:
        gitignore = (_REPO / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("aria-debts/keys/", gitignore)
        from aria_kernel.workflow_contract_registry import WORKFLOW_CONTRACTS
        patterns = WORKFLOW_CONTRACTS["aria-auto-cycle"].job_contracts[0].allowed_write_path_patterns
        self.assertIn(r"^aria-debts/keys(/.*)?$", patterns)
        # And the YAML preflight declares the same root.
        self.assertIn('"aria-debts/keys"', self.text)

    def test_preflight_profile_tracks_mode(self) -> None:
        # The persisted audit artifact must record the REAL profile.
        self.assertIn(
            "ARIA_CYCLE_PROFILE: ${{ github.event.inputs.mode == 'autonomous-cycle' && 'autonomous' || 'standard' }}",
            self.text,
        )

    def _autonomous_step_block(self) -> str:
        return self._step_block("Run operator-gated autonomous cycle")

    def _step_block(self, name: str) -> str:
        start = self.text.index(f"- name: {name}")
        nxt = self.text.find("- name: ", start + 1)
        return self.text[start : nxt if nxt != -1 else len(self.text)]


if __name__ == "__main__":
    unittest.main()
