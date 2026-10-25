"""Plan ARIA-V3 Phase B1 — DEBT-2026-05-08-001 retirement + workflow hygiene.

Closes INFRA-CRITICAL-002, INFRA-CRITICAL-003, INFRA-HIGH-007,
INFRA-MEDIUM-011, AUDITTRAIL-HIGH-009 and the legacy
DEBT-2026-05-08-001 finding. Locked invariants (8 cases), updated for the
Claude Code CLI runtime (ORPHAN-MEDIUM-253 — codex→claude migration):

  * I-V3-21 — kernel argv (ci_executor + worker_executor) matches the
    proven_argv YAML block in
    tools/aria-poc/ci_executor_contract_proven.md.
  * I-V3-22 — workflow_dispatch input mock default flipped to ``'false'``.
  * I-V3-22a — vars.ARIA_MOCK_KILL_SWITCH read AHEAD of the workflow
    default (kill switch precedence).
  * I-V3-22b — preflight step refuses to start when effective_mock=false
    AND Claude API-key/proxy-billing mode is rejected, and the kernel's
    Claude credential boundary is checked (ARIA-MEDIUM-563).
  * I-V3-22c — pinned Claude Code CLI preflight step is present BEFORE the
    executor step.
  * I-V3-22d — aria-agent-executor.yml in V2 I-25 _GOVERNED_WORKFLOWS
    (INFRA-HIGH-007).
  * I-V3-23 — proven-contract doc carries verified_at_commit +
    claude_cli_version_minimum + finding_closed fields (structure
    locked even when fields hold PENDING-OPERATOR-LIVE-INVOCATION
    placeholder until operator OOB shake-out).
  * I-V3-23a — ci_executor.py records claude_mock_mode_resolved
    governance row on every invocation (AUDITTRAIL-HIGH-009).
"""

from __future__ import annotations

# ARIA-HIGH-602 — the live partition: the R03 message check reads .github
# through the workflow-shell-safety adapter, which imports tools/gates modules
# outside the kernel surface, so this module runs in aria-kernel.yml's
# always-run `workspace` job (aria_kernel.live_partition).
READS_LIVE_CHECKOUT = (
    "the .github workflows and actions, read through tools/aria-adapters/workflow-shell-safety-adapter.ts "
    "and the tools/gates modules it imports"
)

import json
import re
import subprocess
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


# ARIA-LOW-736 — the R03 shape (a backtick inside a double-quoted echo/printf)
# has one scanner: the workflow-shell-safety adapter's rule, read through the
# one shell reader (tools/aria-adapters/shell-script.ts). This gate asks it.
_WORKFLOW_SHELL_ADAPTER_ARGV = (
    "node",
    "node_modules/ts-node/dist/bin.js",
    "--project",
    "tools/gates/tsconfig.json",
    "tools/aria-adapters/workflow-shell-safety-adapter.ts",
)
_MESSAGE_RULE = "command_substitution_in_message"


# The Claude Code CLI argv flags the proven doc declares for both executors.
_EXPECTED_CLAUDE_FLAGS = {
    "--output-format",
    "--verbose",
    "--model",
    "--effort",
    "--dangerously-skip-permissions",
    # Plan 032 Faz 032b — the kernel runtime profile's tool envelope.
    "--disallowedTools",
    # Plan 032 Faz 032g — MCP: the kernel registry only, strictly.
    "--strict-mcp-config",
    "--mcp-config",
}


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
        claude_src = (
            _REPO_ROOT / "tools" / "aria-poc" / "claude_runtime.py"
        ).read_text(encoding="utf-8")
        for token in (
            '"claude"',
            '"-p"',
            '"--output-format"',
            '"stream-json"',
            '"--model"',
            "CLAUDE_DEFAULT_MODEL",
        ):
            self.assertIn(
                token, claude_src,
                msg=f"claude_runtime.py missing argv token {token!r}",
            )
        flag_set_doc = {
            entry for entry in argv if isinstance(entry, str) and entry.startswith("--")
        }
        self.assertEqual(flag_set_doc, _EXPECTED_CLAUDE_FLAGS)

    def test_i_v3_21_worker_executor_argv_matches_proven_doc(self) -> None:
        import yaml  # type: ignore[import-untyped]

        proven_block = _extract_yaml_block(self.proven_text, "worker_executor:")
        data = yaml.safe_load(proven_block)
        self.assertIn("worker_executor", data)
        argv = data["worker_executor"]["argv"]
        claude_src = (
            _REPO_ROOT / "tools" / "aria-poc" / "claude_runtime.py"
        ).read_text(encoding="utf-8")
        for token in (
            '"claude"',
            '"-p"',
            '"--output-format"',
            '"stream-json"',
            '"--model"',
        ):
            self.assertIn(
                token, claude_src,
                msg=f"claude_runtime.py missing argv token {token!r}",
            )
        flag_set_doc = {
            entry for entry in argv if isinstance(entry, str) and entry.startswith("--")
        }
        self.assertEqual(flag_set_doc, _EXPECTED_CLAUDE_FLAGS)

    def test_proven_doc_fail_safe_values_match_the_runtime_profile_defaults(self) -> None:
        """The argv the doc names as the fail-safe IS the resolver's
        fail-safe (operator decision 2026-09-12: opus, never fable)."""
        import yaml  # type: ignore[import-untyped]
        from aria_kernel.agent_runtime_profile import DEFAULT_EFFORT, DEFAULT_MODEL

        data = yaml.safe_load(_extract_yaml_block(self.proven_text, "ci_executor:"))
        for executor in ("ci_executor", "worker_executor"):
            with self.subTest(executor=executor):
                argv = data[executor]["argv"]
                self.assertEqual(argv[argv.index("--model") + 1], DEFAULT_MODEL)
                self.assertEqual(argv[argv.index("--effort") + 1], DEFAULT_EFFORT)
        self.assertIn(
            f"The `{DEFAULT_MODEL}`/`{DEFAULT_EFFORT}` values above are the fail-safe defaults",
            " ".join(self.proven_text.split()),
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
        default_idx = self.workflow_text.index('MOCK_SOURCE="workflow_default_claude"')
        self.assertLess(
            kill_switch_idx,
            default_idx,
            msg=(
                "kill_switch branch must precede workflow_default branch — "
                "kill switch wins over default (Plan ARIA-V3 §B1 §INFRA-MEDIUM-011)"
            ),
        )

    # I-V3-22b — Claude API-key refusal + kernel credential check.
    def test_i_v3_22b_claude_auth_preflight_guard_present(self) -> None:
        self.assertIn(
            "API-key Claude mode is disallowed",
            self.workflow_text,
            msg="Claude API-key-mode rejection message missing",
        )
        # API-key / proxy-billing env vars are rejected in live mode.
        self.assertIn("ANTHROPIC_API_KEY", self.workflow_text)
        self.assertIn("ANTHROPIC_AUTH_TOKEN", self.workflow_text)
        # The kernel's Claude credential boundary is checked on the runner
        # through the kernel's one reader (ARIA-MEDIUM-563: the gateway's
        # token, not the host login) — and reported, never a job refusal
        # (ARIA-HIGH-441): whether a request needs Claude is its route's
        # question, and the lane cools anthropic per request
        # (claude_logged_out) while work routed to Z.ai runs.
        self.assertNotIn(".credentials.json", self.workflow_text)
        check = "python3 -m aria_kernel.provider_credentials check anthropic"
        self.assertIn(check, self.workflow_text)
        block = self.workflow_text.split(check, 1)[1].split("fi\n", 1)[0]
        self.assertIn("::warning::the kernel's Claude credential boundary refused", block)
        self.assertNotIn("exit 1", block)
        # The retired Codex auth probes must be gone.
        self.assertNotIn("codex login status", self.workflow_text)
        self.assertNotIn("codex doctor", self.workflow_text)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", self.workflow_text)

    def test_no_message_runs_a_command_through_backticks(self) -> None:
        # ARIA-MEDIUM-563 review: `echo "... (`claude setup-token` ...)"` is
        # command substitution in bash: the API-key refusal path would start
        # the interactive token mint inside a CI step and print its output to
        # the Actions log. A backtick inside a double-quoted echo/printf
        # string runs a command; a message names one in plain quotes. The
        # adapter decides (its own test pins the shapes it flags and the
        # ones it does not); a file it could not parse is not clean.
        completed = subprocess.run(
            list(_WORKFLOW_SHELL_ADAPTER_ARGV),
            cwd=_REPO_ROOT,
            input=json.dumps({"roots": [".github"]}),
            capture_output=True,
            text=True,
            check=False,
            timeout=600,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr[-4000:])
        output = json.loads(completed.stdout)
        summary = next(o for o in output["observations"] if o["type"] == "workflow_shell_summary")
        self.assertEqual(summary["details"]["parse_failures"], 0, "every .github file was read")
        offenders = [
            f"{finding['path']}:{finding['line']}"
            for finding in output["findings"]
            if finding["rule"] == _MESSAGE_RULE
        ]
        self.assertEqual(offenders, [], "command substitution inside a double-quoted message")

    # I-V3-22c — Claude Code binary preflight step.
    def test_i_v3_22c_claude_binary_preflight_step_present(self) -> None:
        self.assertIn(
            "Pre-flight - Claude Code CLI present",
            self.workflow_text,
            msg="Claude Code CLI preflight step missing",
        )
        self.assertIn("claude --version", self.workflow_text)
        preflight_idx = self.workflow_text.index("Pre-flight - Claude Code CLI present")
        executor_idx = self.workflow_text.index("Run CI executor")
        self.assertLess(
            preflight_idx,
            executor_idx,
            msg="Claude Code preflight step must precede executor step",
        )
        # The retired Codex preflight must be gone.
        self.assertNotIn("codex --version", self.workflow_text)

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
            "finding_closed: DEBT-2026-06-29-CLAUDE-CLI-MIGRATION",
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
        """Call ``_record_mock_mode_audit`` directly with a tools_dir and
        assert the ``claude_mock_mode_resolved`` governance row is written
        with the required detail keys. This proves the emission happens per
        invocation (AUDITTRAIL-HIGH-009)."""
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
                "claude_mock_mode_resolved",
                kinds,
                msg="claude_mock_mode_resolved audit row not emitted",
            )
            row = next(
                r for r in rows if r.get("kind") == "claude_mock_mode_resolved"
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
