"""Plan 020 Phase 10 — agent harness security adapter + 5th invariant tests.

What this suite pins:
- 6 detection rules each have a positive case in fixture data.
- workflow_run/pull_request_target untrusted checkout fires only on
  the refined trigger surface (NOT on standalone actions/checkout).
- Spine gate INVARIANT_KINDS contains harness_security.
- The spine gate's harness_security invariant is the adapter's violation
  set, read from the TOOLS ROOT it is given (never
  <workspace>/aria-tools/runs.jsonl, ARIA-HIGH-525).
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

from aria_kernel import architecture_spine_gate as gate
from aria_kernel.architecture_spine_gate import INVARIANT_KINDS
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.tool_runner import run_tool
from tests._helpers.git_fixtures import commit_files, make_local_git_repo
from tests._helpers.spine_fixture import SpineFixture


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
        # ARIA-HIGH-098 — the contract is the kernel validator's, not a `ref`
        # string: per-finding `evidence: [{path, line?}]`, `path`/`line`
        # split, plain paths in `evidence_sources`, and every evidence path
        # declared in `read_paths`. The previous form of this test pinned
        # `evidence_sources == [".github/workflows/perm.yml:2"]` — the exact
        # shape the validator rejected on trial eleven.
        _write(self.repo, ".github/workflows/leak.yml",
               "name: x\nenv:\n  KEY: AKIAABCDEFGHIJKLMNOP\n")
        result = scan(self.repo)
        self.assertTrue(result["findings"])
        finding = result["findings"][0]
        self.assertEqual(finding["path"], ".github/workflows/leak.yml")
        self.assertEqual(finding["evidence"], [{"path": ".github/workflows/leak.yml", "line": 3}])
        self.assertEqual(finding["id"], "secret_leak_in_yaml_or_md:.github/workflows/leak.yml:3")
        self.assertTrue(finding["message"])
        self.assertNotIn("ref", finding)
        self.assertEqual(result["evidence_sources"], [".github/workflows/leak.yml"])
        self.assertIn(".github/workflows/leak.yml", result["read_paths"])

    def test_scan_output_passes_the_kernel_evidence_validator(self) -> None:
        # The validator the runner applies to every production run
        # (`tool_runner.run_tool` → `validate_tool_output_evidence`), applied
        # to the adapter's output under its own manifest scope. This is the
        # check no fixture case ever ran for this adapter before trial
        # eleven, and the reason its 48 findings were `finding_evidence_missing`.
        from aria_kernel.evidence_validator import validate_tool_output_evidence

        _write(self.repo, ".github/workflows/leak.yml",
               "name: x\nenv:\n  KEY: AKIAABCDEFGHIJKLMNOP\n")
        _write(self.repo, ".claude/agents/edit-agent.md",
               "---\nname: x\ntools: [Edit, Write, Bash]\n---\nbody\n")
        _write(self.repo, "tools/aria-poc/leak.py",
               "import sys\nprint(f'token: {lease_token}')\n")
        manifest = json.loads(
            (Path(__file__).resolve().parents[2] / "tools" / "aria-adapters"
             / "agent-harness-security-adapter.tool.json").read_text(encoding="utf-8"),
        )
        result = scan(self.repo)
        self.assertGreaterEqual(len(result["findings"]), 3)
        verdict = validate_tool_output_evidence(manifest, result, self.repo)
        self.assertEqual(verdict["errors"], [])
        self.assertTrue(verdict["valid"])

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

    def test_workflow_token_scope_is_not_a_harness_verdict(self) -> None:
        # ARIA-LOW-592 — workflow token scope has ONE owner:
        # workflow-shell-safety-adapter's overbroad_write_token (write-all,
        # a governed job's uncontracted write scope, an ungoverned job's
        # scoped write). The harness's broad_shell_permission read the same
        # lines under a second rule name, so a single `permissions:
        # write-all` workflow produced two SHADOW findings. The harness
        # observes nothing about token scope.
        _write(self.repo, ".github/workflows/perm.yml",
               "name: x\npermissions: write-all\njobs:\n  build:\n    runs-on: ubuntu-latest\n")
        result = scan(self.repo)
        self.assertEqual(
            [f for f in result["findings"] if f["path"] == ".github/workflows/perm.yml"],
            [],
            "the harness emits no token-scope verdict for a write-all workflow",
        )

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
    """The harness invariant reads its owner's run from the tools root (ARIA-HIGH-525)."""

    HARNESS = "agent-harness-security-adapter"

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.workspace = make_local_git_repo(root, name="work", initial_commit=False)
        commit_files(self.workspace, {"src/agents/a.md": "---\nname: a\n---\n"})
        # The store sits beside the workspace, as in production.
        self.tools = ensure_tools_dir(root / "aria-tools")
        self.spine = SpineFixture(self.workspace, self.tools)
        self.spine.register_clean()
        self.spec = next(spec for spec in gate.SPINE_INVARIANTS if spec.kind == "harness_security")

    def _measure(self) -> gate.InvariantMeasurement:
        return gate._measure_adapter_invariant(self.spec, tools_root=self.tools, refresh=None)

    def test_registered_owner_without_a_run_is_unmeasured_not_pending(self) -> None:
        measurement = self._measure()
        self.assertEqual((measurement.coverage, measurement.coverage_reason), ("unmeasured", "adapter_run_missing"))
        self.assertFalse((self.workspace / "aria-tools").exists())

    def test_latest_recorded_run_of_the_tools_root_is_the_violation_set(self) -> None:
        finding = {"id": "f", "rule": "agent_frontmatter_no_tools_allowlist", "path": "src/agents/a.md",
                   "line": 1, "severity": "high", "message": "agent frontmatter declares no tools allowlist",
                   "evidence": [{"path": "src/agents/a.md", "line": 1}]}
        self.spine.set_findings(self.HARNESS, [finding], commit=True)
        run_tool(self.HARNESS, {"cycle_id": "c"}, "c", workspace_root=self.workspace, base_dir=self.tools)
        measurement = self._measure()
        self.assertEqual(measurement.coverage, "measured", measurement)
        self.assertEqual(measurement.measurements["violation_count"], 1)
        self.assertTrue(measurement.measurements["violation_identities"][0].startswith(
            "src/agents/a.md::agent_frontmatter_no_tools_allowlist::"))
        self.assertEqual(measurement.provenance["selection"], "latest_recorded")
        self.assertEqual(measurement.source, f"adapter:{self.HARNESS}@1.0.0")


if __name__ == "__main__":
    unittest.main()
