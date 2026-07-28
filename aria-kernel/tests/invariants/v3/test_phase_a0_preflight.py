"""Plan ARIA-V3 Phase A0 — Pre-flight invariants.

Locks:
  * I-V3-00a — `aria-drafter` agent file exists with locked scope
  * I-V3-00b — `lane` derivation rejects operator override (CLI has no `--lane`)
  * I-V3-00c — auto_action_policy L3 exclusion list contains every required entry
  * I-V3-00d — secret-rotation runbook + workflow govern ARIA ack key and do not list legacy Claude token
  * I-V3-00e — snowball runtime captures are not tracked live state
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]


class PhaseA0Preflight(unittest.TestCase):
    def test_i_v3_00a_drafter_agent_file_exists_with_locked_scope(self) -> None:
        path = _REPO_ROOT / ".claude" / "agents" / "_maintenance" / "aria-drafter.md"
        self.assertTrue(path.exists(), f"aria-drafter.md missing at {path}")
        text = path.read_text(encoding="utf-8")
        # YAML frontmatter present
        self.assertTrue(text.startswith("---\n"), "aria-drafter must open with YAML frontmatter")
        # name + tools + model fields present. Writer-grade ARIA agents
        # are pinned to opus/xhigh by the Codex runtime contract.
        self.assertIn("name: aria-drafter", text)
        self.assertIn("model: fable", text)
        self.assertIn("effort: max", text)
        # Scope-locking sections present
        for required in (
            "## Mandate",
            "## Invocation contract",
            "## Output contract",
            "## Forbidden actions",
            "Plan ARIA-V3",
        ):
            self.assertIn(required, text, f"aria-drafter missing required section: {required!r}")
        # Hard-locked forbidden paths must be named
        for forbidden in ("aria-kernel/", "auth", "tenant", "migrations", "secrets", "billing"):
            self.assertIn(forbidden, text, f"aria-drafter forbidden-paths must name {forbidden!r}")

    def test_i_v3_00b_lane_derivation_rejects_operator_override(self) -> None:
        # The CLI must NOT expose --lane on any subcommand. Grep cli.py.
        cli_path = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "cli.py"
        if not cli_path.exists():
            self.skipTest("cli.py absent")
        text = cli_path.read_text(encoding="utf-8")
        # Reject any add_argument variant that introduces a --lane flag.
        violations: list[tuple[int, str]] = []
        for line_no, line in enumerate(text.splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if re.search(r'add_argument\(\s*["\']--lane["\']', line):
                violations.append((line_no, line.strip()))
        self.assertEqual(
            violations,
            [],
            msg=(
                "Plan ARIA-V3 §2c locks lane as kernel-derived. CLI must NOT "
                f"expose --lane. Violations: {violations}"
            ),
        )

    def test_i_v3_00b_lane_classifier_module_present(self) -> None:
        path = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "lane_classifier.py"
        self.assertTrue(path.exists(), f"lane_classifier.py missing at {path}")
        text = path.read_text(encoding="utf-8")
        for required in (
            "derive_lane_from_base_branch",
            "derive_lane_from_pr_metadata",
            "LaneDecision",
            "HISTORICAL_SNOWBALL_BRANCH",
            "L0-main",
        ):
            self.assertIn(required, text)

    def test_i_v3_00b_lane_classifier_recognises_snowball_and_main_only(self) -> None:
        # Import the module via the same PYTHONPATH-bootstrap the kernel uses.
        import sys
        kernel_root = _REPO_ROOT / "aria-kernel"
        if str(kernel_root) not in sys.path:
            sys.path.insert(0, str(kernel_root))
        from aria_kernel.lane_classifier import derive_lane_from_base_branch

        snowball = derive_lane_from_base_branch("snowball")
        self.assertIsNone(snowball.lane)
        self.assertEqual(
            snowball.decision_reason,
            "base_branch_is_historical_snowball",
        )
        self.assertEqual(derive_lane_from_base_branch("main").lane, "L0-main")
        self.assertIsNone(derive_lane_from_base_branch("feature/foo").lane)
        self.assertIsNone(derive_lane_from_base_branch("").lane)
        # Whitespace + case tolerance
        self.assertIsNone(derive_lane_from_base_branch("  SnowBall  ").lane)

    def test_i_v3_00c_auto_action_policy_l3_exclusion_list_present(self) -> None:
        path = (
            _REPO_ROOT
            / "aria-kernel"
            / "aria_kernel"
            / "data"
            / "auto_action_policy.json"
        )
        self.assertTrue(path.exists(), f"auto_action_policy.json missing at {path}")
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data.get("schema_version"), 1)
        globs = data.get("l3_lane_exclusion_globs") or []
        self.assertIsInstance(globs, list)
        # Every required exclusion class MUST be represented by at least one glob.
        required_classes = {
            "kernel": ["aria-kernel/**"],
            "auth": ["**/auth/**", "apps/auth-service/**"],
            "tenant": ["**/tenant/**"],
            "migrations": ["**/migrations/**"],
            "infra": ["infrastructure/**", ".github/workflows/**"],
            "secrets": ["**/secrets/**", ".env*"],
            "billing": ["**/billing/**", "apps/billing-service/**"],
            "production": ["**/production/**"],
        }
        for class_name, expected_options in required_classes.items():
            self.assertTrue(
                any(opt in globs for opt in expected_options),
                msg=(
                    f"L3 exclusion class {class_name!r} not represented; "
                    f"expected at least one of {expected_options} in {globs}"
                ),
            )
        # Reason codes must cover every glob.
        reason_codes = data.get("l3_lane_exclusion_reason_codes") or {}
        for glob in globs:
            self.assertIn(
                glob,
                reason_codes,
                msg=f"glob {glob!r} has no reason code (decision-audit gap)",
            )

    def test_i_v3_00d_secret_rotation_runbook_lists_aria_ack_key_and_no_claude_token(self) -> None:
        path = _REPO_ROOT / "docs" / "runbooks" / "secret-rotation.md"
        self.assertTrue(path.exists())
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", text)
        self.assertNotIn("claude-code-oauth-token", text)
        # Must link to aria-ack-key-rotation runbook AND name aria-ack-hmac-key
        self.assertIn("aria-ack-hmac-key", text)
        self.assertIn("aria-ack-key-rotation.md", text)

    def test_i_v3_00d_secret_rotation_workflow_lists_aria_ack_key_and_no_claude_token(self) -> None:
        path = (
            _REPO_ROOT / ".github" / "workflows" / "secret-rotation-reminder.yml"
        )
        self.assertTrue(path.exists())
        text = path.read_text(encoding="utf-8")
        self.assertNotIn("claude-code-oauth-token", text)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", text)
        self.assertIn("aria-ack-hmac-key", text)

    def test_i_v3_00d_aria_ack_key_rotation_runbook_present(self) -> None:
        path = _REPO_ROOT / "docs" / "runbooks" / "aria-ack-key-rotation.md"
        self.assertTrue(path.exists(), f"DR runbook missing at {path}")
        text = path.read_text(encoding="utf-8")
        for required in (
            "## 1. Key custody",
            "## 2. Scheduled rotation",
            "## 3. Emergency rotation",
            "## 4. Key loss / DR",
            "ack init",
            "ack rotate-key",
            "ack verify",
            "ARIA-V3",
        ):
            self.assertIn(required, text, f"DR runbook missing section: {required!r}")

    def test_i_v3_00e_historical_runtime_state_is_not_tracked(self) -> None:
        completed = subprocess.run(
            [
                "git",
                "-C",
                str(_REPO_ROOT),
                "ls-files",
                "aria-findings",
                "aria-tools/preflight",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        result = completed.stdout.splitlines()
        self.assertEqual(
            result,
            [],
            msg=(
                "Historical ARIA findings and snowball preflight captures are "
                f"runtime state, not live authority: {result}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
