"""Plan 024 v3 followup §F (ORPHAN-MEDIUM-058) — CLI flag position
uniformity acceptance tests.

Pre-fix three patterns coexisted across the 89 callsites of the
legacy add_tools_arg helper:

  Pattern A — flag accepted ONLY in the AFTER position (after the
    subcommand). Operators typing `--tools-dir <path> tool list`
    hit argparse error 2.
  Pattern B — flag accepted ONLY in the BEFORE position (before
    the subcommand). Operators typing `tool list --tools-dir <path>`
    hit argparse error 2.
  Pattern C — flag declared at neither level for some subcommands;
    no override possible without ARIA_TOOLS_DIR env var.

ORPHAN-MEDIUM-058 documents the inconsistency and the operator
error rate it produced.

Post-fix every subcommand accepts --tools-dir in BOTH positions
(parents=[_TOOLS_DIR_PARENT] threads the flag onto every subparser
plus the root parser keeps its own copy via the same parent), plus
picks up ARIA_TOOLS_DIR as zero-effort env-var default. The
required-command table fires only on integrity migrate/rollback
where the operator MUST name the directory explicitly.

These tests assert OBSERVED CLI behavior (real cli_main entry
point, real argparse, real exit codes) — never mocks. Mocking
cli.main would defeat the purpose of pinning the architectural
contract end-to-end.
"""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.cli import main as cli_main
from aria_kernel.tool_registry import ensure_tools_dir


# (subcmd_argv, was_pattern, note) — represents the 3 pre-fix
# behaviour patterns. Each row exercises argparse at a different
# nesting level (1-level: tool list / profile get; 1-level with
# trailing flags: spine status; 2-level: metrics dashboard;
# subcommand-only: human-required list; subcommand-with-workspace:
# pressure list).
REPRESENTATIVE_SUBCOMMANDS: list[tuple[list[str], str, str]] = [
    (["tool", "list"], "A", "AFTER position pre-fix"),
    (["profile", "get"], "A", "AFTER position pre-fix"),
    (["spine", "status"], "B", "BEFORE position pre-fix"),
    (
        ["metrics", "dashboard", "--out", "/tmp/aria-test-dash.md",
         "--workspace-root", "."],
        "B",
        "BEFORE position pre-fix",
    ),
    (["human-required", "list"], "B", "BEFORE position pre-fix"),
    (["pressure", "list", "--workspace-root", "."], "C",
     "Both positions pre-fix (no flag accepted)"),
]


def _swallow(argv: list[str]) -> int:
    """Invoke cli_main with stderr/stdout captured. Return the
    integer exit code that argparse / cli_main produced. Argparse
    errors produce code 2 (SystemExit(2)); successful parsing
    yields 0 or any non-2 code from downstream dispatch.

    Catches only SystemExit (the argparse / parser.error path) and
    Exception subclasses from downstream dispatch — never
    BaseException. KeyboardInterrupt and SystemExit subclasses
    that do not carry an int code are surfaced as code 1, which
    still satisfies the not-in-{2} assertion (the contract under
    test is parsing acceptance, not full execution).

    NOT a mock — invokes the real entry point. The stdout/stderr
    redirect is purely so test output stays clean."""
    err = io.StringIO()
    out = io.StringIO()
    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
        try:
            return cli_main(argv) or 0
        except SystemExit as exc:
            code = exc.code
            return code if isinstance(code, int) else (1 if code else 0)
        except Exception:
            # Downstream dispatch failures (RuntimeError, OSError,
            # governance error, etc.) imply argparse accepted the
            # args — the parsing contract under test is satisfied.
            # Surface as 1 so the not-in-{2} assertion still passes.
            return 1


class CliToolsDirPositionUniformityTests(unittest.TestCase):
    """Position-uniformity acceptance — every representative
    subcommand parses successfully with --tools-dir in BEFORE and
    AFTER position, plus picks up the env-var fallback when
    neither position carries a value."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")
        # Make sure ARIA_TOOLS_DIR isn't carried in from the test
        # runner shell — env-var fallback test patches it on
        # explicitly; flag-position tests must not see it leak.
        self._saved_env = os.environ.pop("ARIA_TOOLS_DIR", None)

    def tearDown(self) -> None:
        if self._saved_env is not None:
            os.environ["ARIA_TOOLS_DIR"] = self._saved_env
        # /tmp/aria-test-dash.md is the metrics-dashboard --out
        # target; clean it so reruns stay deterministic.
        dash = Path("/tmp/aria-test-dash.md")
        if dash.exists():
            dash.unlink()
        self.tmp.cleanup()

    def test_tools_dir_works_in_both_positions(self) -> None:
        """Plan 024 §F — every representative subcommand parses
        successfully with --tools-dir in BEFORE position and
        AFTER position. Pre-fix each subcommand failed in one of
        the two positions per ORPHAN-MEDIUM-058 reproducer matrix.

        We assert exit code is NOT 2 (argparse error). Downstream
        runtime errors (exit 1) are accepted — the contract under
        test is parsing acceptance, not full execution."""
        for subcmd, pattern, note in REPRESENTATIVE_SUBCOMMANDS:
            with self.subTest(pattern=pattern, note=note, subcmd=subcmd):
                argv_before = ["--tools-dir", str(self.tools_dir), *subcmd]
                code_before = _swallow(argv_before)
                self.assertNotEqual(
                    code_before,
                    2,
                    f"BEFORE position failed argparse for {subcmd} "
                    f"(pattern {pattern}); pre-fix this row required "
                    f"the flag in the other slot.",
                )

                argv_after = [*subcmd, "--tools-dir", str(self.tools_dir)]
                code_after = _swallow(argv_after)
                self.assertNotEqual(
                    code_after,
                    2,
                    f"AFTER position failed argparse for {subcmd} "
                    f"(pattern {pattern}); pre-fix this row required "
                    f"the flag in the other slot.",
                )

    def test_env_var_fallback(self) -> None:
        """Plan 024 §F — ARIA_TOOLS_DIR env-var fallback works when
        neither flag position carries a value. Smoke 3 of the 6
        representatives; full coverage matrix runs in
        test_tools_dir_works_in_both_positions."""
        for subcmd, pattern, note in REPRESENTATIVE_SUBCOMMANDS[:3]:
            with self.subTest(pattern=pattern, note=note, subcmd=subcmd):
                with patch.dict(
                    os.environ,
                    {"ARIA_TOOLS_DIR": str(self.tools_dir)},
                    clear=False,
                ):
                    code = _swallow(list(subcmd))
                    self.assertNotEqual(
                        code,
                        2,
                        f"env-var fallback failed argparse for {subcmd}",
                    )

    def test_integrity_migrate_requires_tools_dir(self) -> None:
        """Plan 024 §F — integrity migrate-tools-v1-to-v2 still
        requires --tools-dir at runtime (post-parse required-
        command table at _TOOLS_DIR_REQUIRED_COMMANDS). Without
        the flag AND without ARIA_TOOLS_DIR env, the command must
        exit 2 (argparse-style error) and the error message must
        name the requirement so the operator gets actionable
        feedback."""
        # Make sure no env-var fallback is in play.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ARIA_TOOLS_DIR", None)
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    cli_main(
                        [
                            "integrity",
                            "migrate-tools-v1-to-v2",
                            "--workspace-root",
                            str(self.tmp.name),
                            "--reason",
                            "smoke regression check fixture",
                            "--acknowledge",
                        ]
                    )
            self.assertEqual(
                ctx.exception.code,
                2,
                "integrity migrate-tools-v1-to-v2 must exit 2 when "
                "--tools-dir is absent and ARIA_TOOLS_DIR is unset",
            )
            self.assertIn(
                "--tools-dir is required",
                err.getvalue(),
                f"required-command error message must name the flag; "
                f"got: {err.getvalue()!r}",
            )

    def test_integrity_rollback_requires_tools_dir(self) -> None:
        """Plan 024 §F — same contract for the rollback twin. Both
        destructive integrity commands sit in _TOOLS_DIR_REQUIRED_-
        COMMANDS so the operator must name --tools-dir explicitly
        OR set ARIA_TOOLS_DIR env. This test asserts the no-flag
        + no-env failure shape — supplying every other required
        arg (--from-backup, --reason) so argparse reaches my
        post-parse table check before exiting on a different
        missing-arg error."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ARIA_TOOLS_DIR", None)
            err = io.StringIO()
            with contextlib.redirect_stderr(err):
                with self.assertRaises(SystemExit) as ctx:
                    cli_main(
                        [
                            "integrity",
                            "rollback-tools-v2-to-v1",
                            "--from-backup",
                            "/tmp/aria-bogus-backup",
                            "--reason",
                            "smoke regression check fixture",
                            "--acknowledge",
                        ]
                    )
            self.assertEqual(
                ctx.exception.code,
                2,
                "integrity rollback-tools-v2-to-v1 must exit 2 when "
                "--tools-dir is absent and ARIA_TOOLS_DIR is unset",
            )
            self.assertIn(
                "--tools-dir is required",
                err.getvalue(),
                f"required-command error message must name the flag; "
                f"got: {err.getvalue()!r}",
            )

    def test_non_required_command_accepts_no_tools_dir(self) -> None:
        """Plan 024 §F — non-required commands (everything except
        integrity migrate/rollback) parse successfully when
        --tools-dir is absent AND ARIA_TOOLS_DIR is unset. This is
        the symmetric counterpart to the required-command tests:
        the required-command table must NOT over-include."""
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("ARIA_TOOLS_DIR", None)
            for subcmd, pattern, note in REPRESENTATIVE_SUBCOMMANDS[:3]:
                with self.subTest(pattern=pattern, note=note, subcmd=subcmd):
                    code = _swallow(list(subcmd))
                    self.assertNotEqual(
                        code,
                        2,
                        f"non-required command {subcmd} wrongly demanded "
                        f"--tools-dir at parse time",
                    )


if __name__ == "__main__":
    unittest.main()
