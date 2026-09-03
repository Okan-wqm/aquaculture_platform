from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from aria_kernel.skill_genesis import draft_skill, parse_fixture_blocks, request_skill_genesis, sandbox_skill
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class SkillSandboxMarkdownDeviationTests(unittest.TestCase):
    """Phase-4.1 D2 — skill sandbox parses ## Fixture: <id> blocks from markdown.

    JSON checklist_results path is preserved for backward compat (deprecated).
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        request_skill_genesis(capability_gap_key="cg:demo", title="demo", base_dir=self.tools_dir)
        self.draft = draft_skill(
            request_id="skill-request-cg-demo",
            name="demo-skill",
            description="demo",
            owners=["operator"],
            handoff_agents=["operator"],
            base_dir=self.tools_dir,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _write_markdown(self, content: str) -> Path:
        path = Path(self.tmp.name) / "skill.md"
        path.write_text(content, encoding="utf-8")
        return path

    def test_parse_fixture_blocks_extracts_three_pass_results(self):
        markdown = "## Fixture: tp1\nbody\n## Fixture: fp1\nbody\n## Fixture: handoff\nbody\n"
        parsed = parse_fixture_blocks(markdown)
        self.assertEqual([row["fixture_id"] for row in parsed], ["tp1", "fp1", "handoff"])
        self.assertTrue(all(row["status"] == "pass" for row in parsed))

    def test_markdown_path_with_three_fixtures_passes_sandbox(self):
        path = self._write_markdown("## Fixture: tp1\n## Fixture: fp1\n## Fixture: handoff\n")
        result = sandbox_skill(draft_id=self.draft["draft_id"], markdown_path=path, base_dir=self.tools_dir)
        self.assertEqual(result["decision"], "pass")
        self.assertEqual(result["source"], "markdown")
        self.assertEqual(len(result["checklist_results"]), 3)

    def test_markdown_path_with_two_fixtures_fails_minimum_count(self):
        path = self._write_markdown("## Fixture: tp1\n## Fixture: fp1\n")
        with self.assertRaises(GovernanceError):
            sandbox_skill(draft_id=self.draft["draft_id"], markdown_path=path, base_dir=self.tools_dir)

    def test_json_checklist_path_requires_explicit_synthetic_mode(self):
        result = sandbox_skill(
            draft_id=self.draft["draft_id"],
            checklist_results=[
                {"id": "tp1", "status": "pass"},
                {"id": "fp1", "status": "pass"},
                {"id": "handoff", "status": "pass"},
            ],
            base_dir=self.tools_dir,
            synthetic_test_mode=True,
            operator_approval_ref="test-synthetic-fixture",
        )
        self.assertEqual(result["decision"], "pass")
        self.assertEqual(result["source"], "checklist_json")
        self.assertTrue(result["synthetic_test_mode"])

    def test_mutually_exclusive_inputs_are_rejected(self):
        path = self._write_markdown("## Fixture: tp1\n## Fixture: fp1\n## Fixture: handoff\n")
        with self.assertRaises(GovernanceError):
            sandbox_skill(
                draft_id=self.draft["draft_id"],
                markdown_path=path,
                checklist_results=[{"id": "x", "status": "pass"}],
                base_dir=self.tools_dir,
            )


class RecordCrossReviewFileSubmissionTests(unittest.TestCase):
    """Phase-4.1 D3 — `plan record-cross-review --review-file` ARIA-computes the
    review_content_hash from file bytes; explicit-hash mismatch is rejected at the CLI.

    Validation runs the CLI as a subprocess so we exercise the full
    Path-read → hashlib → record_cross_review pipeline end-to-end.
    """

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        self.workspace = Path(self.tmp.name) / "workspace"
        self.workspace.mkdir()
        # Minimal .claude/agents/ stub so reviewer_names() resolves without the real repo.
        agents_dir = self.workspace / ".claude" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "farm-expert.md").write_text(
            "---\nname: farm-expert\ndescription: x\n---\n", encoding="utf-8",
        )

    def tearDown(self):
        self.tmp.cleanup()

    def _run_cli(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                sys.executable,
                "-m",
                "aria_kernel.cli",
                *args,
                "--workspace-base",
                str(Path(self.tmp.name) / "workspaces"),
            ],
            cwd=Path(__file__).resolve().parents[1],
            text=True,
            capture_output=True,
            check=False,
        )

    def test_cli_rejects_review_file_with_explicit_hash_mismatch(self):
        review_file = Path(self.tmp.name) / "review.json"
        review_file.write_text(
            json.dumps({
                "task_packet_hash": "sha256:" + "0" * 64,
                "target_revision_id": "rev-0",
                "target_plan_content_hash": "sha256:" + "1" * 64,
                "reviewer_agent": "farm-expert",
                "review_direction": "primary_to_challenger",
                "risks": [],
                "review_content_hash": "sha256:" + "f" * 64,
            }),
            encoding="utf-8",
        )
        result = self._run_cli(
            "plan", "record-cross-review",
            "--workspace-root", str(self.workspace),
            "--tools-dir", str(self.tools_dir),
            "--plan-id", "plan-d3-mismatch",
            "--review-file", str(review_file),
        )
        self.assertNotEqual(result.returncode, 0, result.stderr)
        self.assertIn("review_file_content_hash_mismatch", result.stderr)


if __name__ == "__main__":
    unittest.main()
