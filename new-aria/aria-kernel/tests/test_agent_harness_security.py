"""Plan 020 Phase 10 — agent harness security adapter + 5th invariant tests.

What this suite pins:
- 7 detection rules each have a positive case in fixture data.
- workflow_run/pull_request_target untrusted checkout fires only on
  the refined trigger surface (NOT on standalone actions/checkout).
- Spine gate INVARIANT_KINDS contains harness_security.
- Spine gate _check_harness_security reads the latest adapter run from
  runs.jsonl + surfaces raw findings/observations counts.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools" / "aria-poc"))

from agent_harness_security_adapter import scan  # type: ignore[import-not-found]

from aria_kernel.architecture_spine_gate import (
    INVARIANT_KINDS,
    _check_harness_security,
)
from aria_kernel.tool_registry import ensure_tools_dir


def _seed_fake_repo() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-harness-sec-"))
    (repo / ".claude" / "agents").mkdir(parents=True)
    (repo / ".github" / "workflows").mkdir(parents=True)
    (repo / "tools" / "aria-poc").mkdir(parents=True)
    (repo / "package.json").write_text("{}", encoding="utf-8")
    return repo


def _write(repo: Path, rel: str, content: str) -> None:
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


class InvariantKindsTests(unittest.TestCase):
    def test_5th_invariant_present(self) -> None:
        self.assertIn("harness_security", INVARIANT_KINDS)
        self.assertEqual(len(INVARIANT_KINDS), 5)


class DetectionRuleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = _seed_fake_repo()

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def _findings_for(self, rule: str) -> list:
        result = scan(self.repo)
        return [f for f in result["findings"] if f["rule"] == rule]

    def test_secret_leak_aws_key(self) -> None:
        _write(self.repo, ".github/workflows/leak.yml",
               "name: x\nenv:\n  KEY: AKIAABCDEFGHIJKLMNOP\n")
        findings = self._findings_for("secret_leak_in_yaml_or_md")
        self.assertTrue(any(f["label"] == "aws_access_key" for f in findings))

    def test_findings_include_contract_evidence(self) -> None:
        _write(self.repo, ".github/workflows/perm.yml",
               "name: x\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n")
        result = scan(self.repo)
        self.assertTrue(result["findings"])
        self.assertEqual(result["evidence_sources"], [".github/workflows/perm.yml:2"])

    def test_untrusted_checkout_fires_only_on_workflow_run(self) -> None:
        _write(self.repo, ".github/workflows/safe.yml", """
on:
  push:
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
""")
        # Standalone checkout should NOT fire (operator gap #9 refinement).
        self.assertEqual(self._findings_for("workflow_run_or_pr_target_untrusted_checkout"), [])
        _write(self.repo, ".github/workflows/risky.yml", """
on:
  workflow_run:
    workflows: ["x"]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}
""")
        findings = self._findings_for("workflow_run_or_pr_target_untrusted_checkout")
        self.assertTrue(findings)

    def test_broad_shell_permission(self) -> None:
        _write(self.repo, ".github/workflows/perm.yml",
               "name: x\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n")
        findings = self._findings_for("broad_shell_permission")
        self.assertTrue(findings)

    def test_prompt_injection_surface(self) -> None:
        # Agent .md WITHOUT tools: line in frontmatter.
        _write(self.repo, ".claude/agents/no-tools-agent.md",
               "---\nname: x\ndescription: y\n---\nbody\n")
        findings = self._findings_for("prompt_injection_surface")
        self.assertTrue(any(f.get("subkind") == "tools_allowlist_missing" for f in findings))

    def test_direct_anthropic_api_usage(self) -> None:
        _write(self.repo, "tools/aria-poc/danger.py",
               "from @anthropic-ai/sdk import Client  # direct import\n")
        findings = self._findings_for("direct_anthropic_api_usage")
        self.assertTrue(findings)

    def test_lease_token_in_logs(self) -> None:
        _write(self.repo, "tools/aria-poc/leak.py",
               "import sys\nprint(f'token: {lease_token}')\n")
        findings = self._findings_for("lease_token_in_logs")
        self.assertTrue(findings)

    def test_agent_self_modification(self) -> None:
        _write(self.repo, ".claude/agents/edit-agent.md",
               "---\nname: x\ntools: [Edit, Write, Bash]\n---\nbody\n")
        findings = self._findings_for("agent_self_modification_bypass")
        self.assertTrue(findings)


class SpineGateInvariantReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.repo = Path(tempfile.mkdtemp(prefix="aria-harness-spine-"))
        (self.repo / "aria-tools").mkdir()
        ensure_tools_dir(self.repo / "aria-tools")

    def tearDown(self) -> None:
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_check_harness_security_pending_when_no_runs(self) -> None:
        # No runs.jsonl yet → pending.
        meas = _check_harness_security(self.repo)
        self.assertEqual(meas.invariant, "harness_security")
        self.assertTrue(meas.measurements.get("pending"))

    def test_check_harness_security_reads_latest_run(self) -> None:
        # Inject a run row.
        runs = self.repo / "aria-tools" / "runs.jsonl"
        runs.write_text(json.dumps({
            "schema_version": 1,
            "tool_id": "agent-harness-security-adapter",
            "run_id": "rid-test",
            "status": "ok",
            "recorded_at": "2026-05-08T00:00:00+00:00",
            "runner": {"raw_observations_count": 2, "raw_findings_count": 5},
        }) + "\n", encoding="utf-8")
        meas = _check_harness_security(self.repo)
        self.assertEqual(meas.measurements["raw_findings_count"], 5)
        self.assertEqual(meas.measurements["raw_observations_count"], 2)
        self.assertEqual(meas.measurements["adapter_run_status"], "ok")


if __name__ == "__main__":
    unittest.main()
