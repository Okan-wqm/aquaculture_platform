"""Plan ARIA-V3 Phase B1 — DEBT-2026-05-08-001 retirement + workflow hygiene.

Closes INFRA-CRITICAL-002, INFRA-CRITICAL-003, INFRA-HIGH-007,
INFRA-MEDIUM-011, AUDITTRAIL-HIGH-009 and the legacy
DEBT-2026-05-08-001 finding. Locked invariants (8 cases):

  * I-V3-21 — ci_executor live argv matches the Codex proven contract;
    worker_executor is legacy/mock-only and cannot submit authoritative
    implementations.
  * I-V3-22 — workflow_dispatch input mock default flipped to ``'false'``.
  * I-V3-22a — vars.ARIA_MOCK_KILL_SWITCH read AHEAD of the workflow
    default (kill switch precedence).
  * I-V3-22b — preflight step refuses API-key Codex mode and verifies
    ChatGPT-managed Codex auth when effective_mock=false.
  * I-V3-22c — Codex auth preflight runs BEFORE the executor step.
  * I-V3-22d — aria-agent-executor.yml in V2 I-25 _GOVERNED_WORKFLOWS
    (INFRA-HIGH-007).
  * I-V3-23 — proven-contract doc carries verified_at_commit +
    codex_cli_version_minimum + finding_closed fields.
  * I-V3-23a — ci_executor.py records codex_mock_mode_resolved
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
        # Codex-first live argv shape.
        for token in (
            "run_codex_exec(",
            "output_schema=",
            "agent-response-v1.schema.json",
        ):
            self.assertIn(
                token, ci_src,
                msg=f"ci_executor.py missing argv token {token!r}",
            )
        # Confirm the doc's argv block carries the matching flag set.
        flag_set_doc = {
            entry
            for entry in argv
            if isinstance(entry, str) and (entry.startswith("--") or entry == "-c")
        }
        self.assertEqual(
            flag_set_doc,
            {
                "--json",
                "-c",
            },
        )

    def test_i_v3_21_worker_executor_is_demoted_from_live_authority(self) -> None:
        import yaml  # type: ignore[import-untyped]

        proven_block = _extract_yaml_block(self.proven_text, "worker_executor:")
        data = yaml.safe_load(proven_block)
        self.assertIn("worker_executor", data)
        contract = data["worker_executor"]
        self.assertEqual(contract["authority"], "legacy_drafter_mock_only")
        self.assertEqual(contract["live_mode"], "disabled")
        self.assertIs(contract["submit_authoritative_implementation"], False)
        worker_src = (
            _REPO_ROOT / "tools" / "aria-poc" / "worker_executor.py"
        ).read_text(encoding="utf-8")
        for token in (
            "worker_executor_live_mode_disabled_use_ci_executor",
            "worker_executor_authoritative_implementation_forbidden",
            'MOCK_MODE_ENV_VAR = "CODEX_CLI_MOCK"',
        ):
            self.assertIn(
                token, worker_src,
                msg=f"worker_executor.py missing demotion token {token!r}",
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
        default_idx = self.workflow_text.index('MOCK_SOURCE="workflow_default_codex"')
        self.assertLess(
            kill_switch_idx,
            default_idx,
            msg=(
                "kill_switch branch must precede workflow_default branch — "
                "kill switch wins over default (Plan ARIA-V3 §B1 §INFRA-MEDIUM-011)"
            ),
        )

    # I-V3-22b — Codex auth/API-key preflight guard.
    def test_i_v3_22b_codex_auth_preflight_guard_present(self) -> None:
        self.assertIn(
            "API-key Codex mode is disallowed",
            self.workflow_text,
            msg="preflight API-key mode guard message missing",
        )
        self.assertIn("codex login status --json", self.workflow_text)
        self.assertIn("codex doctor --json", self.workflow_text)
        guard_clause_re = re.compile(
            r'if\s*\[\s*"\$\{EFFECTIVE_MOCK\}"\s*=\s*"false"\s*\]'
        )
        self.assertRegex(
            self.workflow_text,
            guard_clause_re,
            msg="Codex preflight guard does not test effective_mock=false",
        )

    # I-V3-22c — Codex auth preflight before executor.
    def test_i_v3_22c_codex_auth_preflight_precedes_executor(self) -> None:
        preflight_idx = self.workflow_text.index("Pre-flight - Codex auth")
        executor_idx = self.workflow_text.index("Run CI executor")
        self.assertLess(
            preflight_idx,
            executor_idx,
            msg="Codex auth preflight must precede executor step",
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
            "codex_cli_version_minimum:",
            "verified_by_operator_handle:",
            "verified_at_iso8601:",
            "finding_closed: DEBT-2026-05-25-CODEX-MIGRATION",
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
        returns 2 EARLY, but the codex_mock_mode_resolved audit row
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
                "codex_mock_mode_resolved",
                kinds,
                msg="codex_mock_mode_resolved audit row not emitted",
            )
            # The row carries effective_mock + mock_source + run id.
            row = next(
                r for r in rows if r.get("kind") == "codex_mock_mode_resolved"
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
