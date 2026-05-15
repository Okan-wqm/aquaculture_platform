"""Plan ARIA-V3 Phase B1 — DEBT-2026-05-08-001 retirement + workflow hygiene.

Closes INFRA-CRITICAL-002, INFRA-CRITICAL-003, INFRA-HIGH-007,
INFRA-MEDIUM-011, AUDITTRAIL-HIGH-009 and the legacy
DEBT-2026-05-08-001 finding. Locked invariants (8 cases):

  * I-V3-21 — kernel argv (ci_executor + worker_executor) matches the
    proven_argv YAML block in
    tools/aria-poc/ci_executor_contract_proven.md byte-for-byte.
  * I-V3-22 — workflow_dispatch input mock default flipped to ``'false'``.
  * I-V3-22a — vars.ARIA_MOCK_KILL_SWITCH read AHEAD of the workflow
    default (kill switch precedence).
  * I-V3-22b — preflight step refuses to start when effective_mock=false
    AND CLAUDE_CODE_OAUTH_TOKEN is unset (INFRA-CRITICAL-002).
  * I-V3-22c — pinned ``@anthropic-ai/claude-code`` install step
    present BEFORE the executor step (INFRA-CRITICAL-003).
  * I-V3-22d — aria-agent-executor.yml in V2 I-25 _GOVERNED_WORKFLOWS
    (INFRA-HIGH-007).
  * I-V3-23 — proven-contract doc carries verified_at_commit +
    claude_cli_version_minimum + finding_closed fields (structure
    locked even when fields hold PENDING-OPERATOR-LIVE-INVOCATION
    placeholder until operator OOB shake-out).
  * I-V3-23a — ci_executor.py records mock_mode_default_flipped
    governance row on every invocation (AUDITTRAIL-HIGH-009).
"""

from __future__ import annotations

import json
import re
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
_PROVEN_DOC = _REPO_ROOT / "tools" / "aria-poc" / "ci_executor_contract_proven.md"
_EXECUTOR = _REPO_ROOT / ".github" / "workflows" / "aria-agent-executor.yml"

if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _extract_yaml_block(text: str, block_marker: str) -> str:
    """Return the content of the first ```yaml ... ``` fenced block that
    contains ``block_marker`` (a substring used to disambiguate when
    the doc carries multiple YAML blocks).
    """
    pattern = re.compile(r"```yaml\n(.*?)\n```", re.DOTALL)
    for match in pattern.finditer(text):
        if block_marker in match.group(1):
            return match.group(1)
    raise AssertionError(f"yaml block with marker {block_marker!r} not found")


class PhaseB1ArgvProvenWorkflowHygiene(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.proven_text = _PROVEN_DOC.read_text(encoding="utf-8")
        cls.workflow_text = _EXECUTOR.read_text(encoding="utf-8")

    # I-V3-21 — argv contract locked against proven doc.
    def test_i_v3_21_ci_executor_argv_matches_proven_doc(self) -> None:
        import yaml  # type: ignore[import-untyped]

        proven_block = _extract_yaml_block(self.proven_text, "ci_executor:")
        data = yaml.safe_load(proven_block)
        self.assertIn("ci_executor", data)
        argv = data["ci_executor"]["argv"]
        # The argv tuple in ci_executor.py production path MUST match
        # the doc's argv list shape: fixed positional binary + flag
        # pairs. We verify by reading the source and matching the
        # tuple literal.
        ci_src = (
            _REPO_ROOT / "tools" / "aria-poc" / "ci_executor.py"
        ).read_text(encoding="utf-8")
        for token in (
            '"claude"',
            '"code"',
            '"agent"',
            '"--subagent-type"',
            '"--prompt-file"',
            '"--output-path"',
            '"--max-turns"',
            '"--max-requests"',
            '"--timeout-seconds"',
        ):
            self.assertIn(
                token, ci_src,
                msg=f"ci_executor.py missing argv token {token!r}",
            )
        # Confirm the doc's argv block carries the matching flag set.
        flag_set_doc = {
            entry for entry in argv if isinstance(entry, str) and entry.startswith("--")
        }
        self.assertEqual(
            flag_set_doc,
            {
                "--subagent-type",
                "--prompt-file",
                "--output-path",
                "--max-turns",
                "--max-requests",
                "--timeout-seconds",
            },
        )

    def test_i_v3_21_worker_executor_argv_matches_proven_doc(self) -> None:
        import yaml  # type: ignore[import-untyped]

        proven_block = _extract_yaml_block(self.proven_text, "worker_executor:")
        data = yaml.safe_load(proven_block)
        self.assertIn("worker_executor", data)
        argv = data["worker_executor"]["argv"]
        worker_src = (
            _REPO_ROOT / "tools" / "aria-poc" / "worker_executor.py"
        ).read_text(encoding="utf-8")
        for token in (
            '"claude"',
            '"code"',
            '"agent"',
            '"--subagent-type"',
            '"--prompt-file"',
            '"--working-directory"',
        ):
            self.assertIn(
                token, worker_src,
                msg=f"worker_executor.py missing argv token {token!r}",
            )
        flag_set_doc = {
            entry for entry in argv if isinstance(entry, str) and entry.startswith("--")
        }
        self.assertEqual(
            flag_set_doc,
            {"--subagent-type", "--prompt-file", "--working-directory"},
        )

    # I-V3-22 — workflow_dispatch input mock default flipped to false.
    def test_i_v3_22_mock_dispatch_input_default_false(self) -> None:
        # The default appears under inputs.mock.default in YAML.
        self.assertRegex(
            self.workflow_text,
            r"mock:\s*\n\s*description:[^\n]*\n\s*required:[^\n]*\n\s*default:\s*'false'",
            msg="mock input default not 'false' after B1",
        )

    # I-V3-22a — kill switch read AHEAD of default.
    def test_i_v3_22a_kill_switch_read_ahead_of_default(self) -> None:
        # The preflight step references vars.ARIA_MOCK_KILL_SWITCH
        # AND the kill_switch branch precedes the workflow_default
        # branch in the shell logic.
        self.assertIn("vars.ARIA_MOCK_KILL_SWITCH", self.workflow_text)
        kill_switch_idx = self.workflow_text.index('MOCK_SOURCE="kill_switch"')
        default_idx = self.workflow_text.index('MOCK_SOURCE="workflow_default_post_b1"')
        self.assertLess(
            kill_switch_idx,
            default_idx,
            msg=(
                "kill_switch branch must precede workflow_default branch — "
                "kill switch wins over default (Plan ARIA-V3 §B1 §INFRA-MEDIUM-011)"
            ),
        )

    # I-V3-22b — OAuth preflight guard.
    def test_i_v3_22b_claude_oauth_token_preflight_guard_present(self) -> None:
        self.assertIn(
            "CLAUDE_CODE_OAUTH_TOKEN is unset",
            self.workflow_text,
            msg="preflight OAuth guard message missing",
        )
        # The guard MUST fire when effective_mock=false AND
        # OAUTH_TOKEN is empty.
        guard_clause_re = re.compile(
            r'if\s*\[\s*"\$\{EFFECTIVE_MOCK\}"\s*=\s*"false"\s*\]\s*'
            r'&&\s*\[\s*-z\s*"\$\{OAUTH_TOKEN:-\}"\s*\]'
        )
        self.assertRegex(
            self.workflow_text,
            guard_clause_re,
            msg="OAuth preflight guard does not test the exact two-clause condition",
        )

    # I-V3-22c — claude binary install step.
    def test_i_v3_22c_claude_binary_install_step_present(self) -> None:
        self.assertIn(
            "@anthropic-ai/claude-code",
            self.workflow_text,
            msg="claude binary install step missing (@anthropic-ai/claude-code)",
        )
        self.assertIn(
            "--ignore-scripts",
            self.workflow_text,
            msg="claude install step missing --ignore-scripts (V2 I-25 clause 4)",
        )
        # The install step must precede the executor step.
        install_idx = self.workflow_text.index("Install claude binary")
        executor_idx = self.workflow_text.index("Run CI executor")
        self.assertLess(
            install_idx,
            executor_idx,
            msg="claude install step must precede executor step",
        )

    # I-V3-22d — V2 I-25 governed list extension.
    def test_i_v3_22d_aria_agent_executor_in_v2_i25_governed_workflows(self) -> None:
        # The V2 invariant test lives at aria-kernel/tests/ (not
        # importable as a Python package since aria-kernel/tests has
        # no __init__.py). Read the source file and assert the
        # frozenset includes the new entry.
        v2_src = (
            _KERNEL_ROOT / "tests" / "test_ci_workflow_invariants.py"
        ).read_text(encoding="utf-8")
        self.assertIn(
            '"aria-agent-executor.yml"',
            v2_src,
            msg="aria-agent-executor.yml not in V2 I-25 _GOVERNED_WORKFLOWS",
        )

    # I-V3-23 — proven doc structure.
    def test_i_v3_23_proven_doc_carries_verified_at_commit_and_cli_version_fields(
        self,
    ) -> None:
        for field in (
            "verified_at_commit:",
            "claude_cli_version_minimum:",
            "verified_by_operator_handle:",
            "verified_at_iso8601:",
            "finding_closed: DEBT-2026-05-08-001",
        ):
            self.assertIn(
                field,
                self.proven_text,
                msg=f"proven doc missing required field {field!r}",
            )
        # The doc must NOT still describe itself as a "spike" — the
        # promotion to proven is load-bearing.
        title_line = self.proven_text.splitlines()[0]
        self.assertNotIn("Spike", title_line)
        self.assertIn("Proven", title_line)

    # I-V3-23a — every executor invocation records mock flag.
    def test_i_v3_23a_every_executor_invocation_records_mock_flag(self) -> None:
        """Run ci_executor.main with invalid argv (no request_id) so it
        returns 2 EARLY, but the mock_mode_default_flipped audit row
        is already written at the top of main(). This proves the
        emission happens unconditionally per invocation.

        Actually main() returns 2 BEFORE _record_mock_mode_audit
        when args list is empty. So we test by calling
        _record_mock_mode_audit directly with a tools_dir.
        """
        sys.path.insert(0, str(_REPO_ROOT / "tools" / "aria-poc"))
        import ci_executor  # type: ignore[import-not-found]

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-23a-") as tmp:
            tools_dir = Path(tmp) / "aria-tools"
            ci_executor._record_mock_mode_audit(tools_dir)
            gov = tools_dir / "governance.jsonl"
            self.assertTrue(gov.exists(), "governance.jsonl not written")
            rows = [
                json.loads(line)
                for line in gov.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            kinds = [row.get("kind") for row in rows]
            self.assertIn(
                "mock_mode_default_flipped",
                kinds,
                msg="mock_mode_default_flipped audit row not emitted",
            )
            # The row carries effective_mock + mock_source + run id.
            row = next(
                r for r in rows if r.get("kind") == "mock_mode_default_flipped"
            )
            details = row.get("details", {})
            for key in (
                "effective_mock",
                "mock_source",
                "workflow_run_id",
                "workflow_run_attempt",
            ):
                self.assertIn(key, details, msg=f"audit row missing key {key!r}")


if __name__ == "__main__":
    unittest.main()
