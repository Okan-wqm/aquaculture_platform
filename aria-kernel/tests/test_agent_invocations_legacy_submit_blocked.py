"""Plan 024 §B-1 — legacy `agent-invocations submit-result` closure tests.

The legacy CLI subparser is removed; the underlying function is renamed
to `_submit_legacy_invocation_result_internal` and gated behind
`operator_migration_approval_ref`. Every invocation emits a
`legacy_submit_path_invoked` governance event so audit captures who
used the helper, when, and with what approval ref.

`request` and `list` subparsers under `agent-invocations` are
intentionally preserved (they are creation/listing surfaces, not the
submission surface that needed strict-path replacement).

The strict CLI surface `agent submit-result` is verified to still
exist (regression).

Tests:
1. argparse rejects `agent-invocations submit-result`.
2. argparse still accepts `agent-invocations request --help`.
3. argparse still accepts `agent-invocations list --help`.
4. argparse still accepts `agent submit-result --help` (strict path).
5. Internal helper without operator_migration_approval_ref raises.
6. Internal helper with operator_migration_approval_ref succeeds and
   emits the governance event.
7. is_legacy_decided_request() flags requests whose terminal state
   came from a legacy result row (no claim_id binding).
"""
from __future__ import annotations

import contextlib
import io
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    _submit_legacy_invocation_result_internal,
    create_agent_invocation_request,
    is_legacy_decided_request,
)
from aria_kernel.cli import main as cli_main
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _argparse_help_exit_code(argv: list[str]) -> int:
    """Run cli_main(argv) and return the SystemExit code. Stderr/stdout are
    swallowed because argparse prints --help / error messages."""
    err_buf = io.StringIO()
    out_buf = io.StringIO()
    with contextlib.redirect_stderr(err_buf), contextlib.redirect_stdout(out_buf):
        try:
            return cli_main(argv) or 0
        except SystemExit as exc:
            code = exc.code
            if isinstance(code, int):
                return code
            return 1 if code else 0


class LegacySubmitBlockedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    # --- CLI surface tests ----------------------------------------------

    def test_cli_rejects_legacy_submit_result_subcommand(self) -> None:
        """Plan 024 §B-1 acceptance (a): argparse must reject the legacy
        subcommand. argparse exits with code 2 on invalid choice."""
        code = _argparse_help_exit_code(
            ["agent-invocations", "submit-result", "--tools-dir", str(self.tools_dir)]
        )
        # argparse "invalid choice" exits with 2; help would exit 0.
        self.assertEqual(code, 2,
            "agent-invocations submit-result must be rejected (argparse code 2)")

    def test_cli_still_offers_request_subcommand(self) -> None:
        """Plan 024 §B-1 acceptance (b): non-submit creation surface
        preserved; --help on request returns 0."""
        code = _argparse_help_exit_code(
            ["agent-invocations", "request", "--help"]
        )
        self.assertEqual(code, 0,
            "agent-invocations request subparser must still exist")

    def test_cli_still_offers_list_subcommand(self) -> None:
        """Plan 024 §B-1 acceptance (b): listing surface preserved."""
        code = _argparse_help_exit_code(
            ["agent-invocations", "list", "--help"]
        )
        self.assertEqual(code, 0,
            "agent-invocations list subparser must still exist")

    def test_cli_strict_agent_submit_result_unchanged(self) -> None:
        """Plan 024 §B-1 acceptance (regression): strict CLI path
        `agent submit-result` is unaffected by the legacy removal."""
        code = _argparse_help_exit_code(
            ["agent", "submit-result", "--help"]
        )
        self.assertEqual(code, 0,
            "strict `agent submit-result` CLI path must still exist")

    # --- Internal helper tests ------------------------------------------

    def test_internal_helper_without_approval_ref_raises(self) -> None:
        """Plan 024 §B-1 acceptance (c): the migration helper rejects any
        caller missing the operator_migration_approval_ref kwarg."""
        # Plan 024 §B-2 — these tests target the LEGACY submit path,
        # which writes results.jsonl directly (no strict claim path
        # involvement). Escape hatch keeps the test focused on B-1 and
        # avoids strict-matrix concerns from B-2.
        request = create_agent_invocation_request(
            target_agent="farm-expert",
            role="cross_review",
            suggested_prompt="hello",
            legacy_strict_fields_optional=True,
            base_dir=self.tools_dir,
        )
        out = self.tools_dir / "out.md"
        out.write_text("ok\n", encoding="utf-8")
        with self.assertRaises(GovernanceError) as ctx:
            _submit_legacy_invocation_result_internal(
                request_id=request["request_id"],
                output_path=out,
                base_dir=self.tools_dir,
            )
        self.assertIn(
            "legacy_submit_path_requires_operator_migration_approval",
            str(ctx.exception),
        )

    def test_internal_helper_emits_governance_event(self) -> None:
        """Plan 024 §B-1 acceptance (d): a successful invocation emits
        legacy_submit_path_invoked with {request_id, approval_ref,
        caller_module} so audit captures who used the helper."""
        request = create_agent_invocation_request(
            target_agent="farm-expert",
            role="cross_review",
            suggested_prompt="hello",
            legacy_strict_fields_optional=True,
            expected_output_path=(self.tools_dir / "expected.md").as_posix(),
            base_dir=self.tools_dir,
        )
        expected_path = Path(request["expected_output_path"])
        expected_path.write_text("ok\n", encoding="utf-8")
        gov = self.tools_dir / "governance.jsonl"
        before_rows = load_jsonl(gov) if gov.exists() else []
        result = _submit_legacy_invocation_result_internal(
            request_id=request["request_id"],
            output_path=expected_path,
            base_dir=self.tools_dir,
            operator_migration_approval_ref="OP-PLAN-024-B1-TEST",
        )
        self.assertEqual(result["status"], "completed")
        after_rows = load_jsonl(gov)
        new_rows = after_rows[len(before_rows):]
        invoked = [r for r in new_rows if r.get("kind") == "legacy_submit_path_invoked"]
        self.assertEqual(
            len(invoked), 1,
            f"expected 1 legacy_submit_path_invoked event, got {invoked!r}",
        )
        details = invoked[0].get("details") or {}
        self.assertEqual(
            details.get("operator_migration_approval_ref"), "OP-PLAN-024-B1-TEST")
        self.assertEqual(details.get("request_id"), request["request_id"])

    def test_is_legacy_decided_request_flags_legacy_terminal_row(self) -> None:
        """Plan 024 §B-1 acceptance (e): observability helper flags
        requests whose terminal state came from a legacy result row
        (no claim_id binding)."""
        request = create_agent_invocation_request(
            target_agent="farm-expert",
            role="cross_review",
            suggested_prompt="hello",
            legacy_strict_fields_optional=True,
            expected_output_path=(self.tools_dir / "expected2.md").as_posix(),
            base_dir=self.tools_dir,
        )
        rid = request["request_id"]
        # Before any result: not legacy-decided.
        self.assertFalse(is_legacy_decided_request(
            request_id=rid, base_dir=self.tools_dir))
        expected_path = Path(request["expected_output_path"])
        expected_path.write_text("ok\n", encoding="utf-8")
        _submit_legacy_invocation_result_internal(
            request_id=rid,
            output_path=expected_path,
            base_dir=self.tools_dir,
            operator_migration_approval_ref="OP-PLAN-024-B1-TEST",
        )
        # Legacy result row written without claim_id -> flagged.
        self.assertTrue(is_legacy_decided_request(
            request_id=rid, base_dir=self.tools_dir))


if __name__ == "__main__":
    unittest.main()
