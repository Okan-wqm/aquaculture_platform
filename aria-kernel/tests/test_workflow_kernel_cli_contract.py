"""Every `python3 -m aria_kernel ...` call in a workflow must satisfy the CLI.

WHY THIS EXISTS
---------------
The lane cutover (#1073) shipped `state publish --repo-root --cycle-id` while
the CLI requires `--snapshot-id`. Nothing caught it: the workflow YAML is not
type-checked, the contract registry pins step NAMES rather than argv, and the
lanes had never executed (no self-hosted runner). The first real nightly
(2026-08-05) failed on it — after the cycle itself had already succeeded, so
the run produced state and then could not publish it.

This test parses each workflow's kernel invocations and asks the CLI's own
argparse whether they would parse. It is the tier-3 form of "the caller and
the callee agree": no runner, no network, no execution required.
"""
from __future__ import annotations

import argparse
import io
import re
import shlex
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

_REPO = Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO / ".github" / "workflows"

# Placeholders the shell would expand; argparse only needs a token.
# Long enough to satisfy validators with minimum-length rules (e.g.
# `--reason` requires >=10 non-whitespace chars); short placeholders would
# produce false failures that have nothing to do with the contract.
_PLACEHOLDER = "workflow-placeholder-value"
_EXPAND = re.compile(r"\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\$\{\{[^}]*\}\}")


def _contract_violation(msg: str) -> bool:
    """Is this argparse error a CALLER/CALLEE disagreement, or an artifact?

    Missing-required, unknown-argument and invalid-choice all are once the
    caller has run through `_parse_argv_against_cli`: that loop substitutes
    a VALID member of `choices` for every runtime-resolved placeholder
    before giving up, so an `invalid choice` that survives to reporting is
    a value the workflow literally wrote (`--profile stricty`), never the
    placeholder.

    ORPHAN-HIGH-728 originally excluded the placeholder BY NAME here. That
    exemption was the ORPHAN-CRITICAL-754 escape: argparse processes
    arguments left-to-right, `--profile "$ARIA_CYCLE_PROFILE"` precedes
    later flags, the exempted invalid-choice error fired and exited before
    argparse ever reached a reintroduced `--implementer-poll-seconds` — a
    green test for a workflow whose nightly dies at step one. Substitution
    replaces exemption: the parser is satisfied past the choice and the
    trailing dead flag gets its `unrecognized arguments` reported.
    """
    if "the following arguments are required" in msg:
        return True
    if "unrecognized arguments" in msg:
        return True
    if "invalid choice" in msg:
        return True
    return False


_INVALID_CHOICE_MSG = re.compile(
    r"argument (?P<flag>--[A-Za-z0-9_-]+): invalid choice: '(?P<value>[^']*)' "
    r"\(choose from (?P<choices>.*)\)"
)


def _substitute_placeholder_choice(msg: str, argv: list[str]) -> list[str] | None:
    """Rewrite one placeholder invalid-choice error into a valid argv.

    Returns the substituted argv, or None when the rejected value is not
    the placeholder (a workflow-written literal must stay a violation).
    The choices are taken from argparse's own error message, so this never
    hardcodes a flag list: a new choice-argument is covered the day it
    lands, which a curated map never is.
    """
    m = _INVALID_CHOICE_MSG.search(msg)
    if m is None or m.group("value") != _PLACEHOLDER:
        return None
    choices = re.findall(r"'([^']*)'", m.group("choices"))
    if not choices:
        return None
    flag, replacement = m.group("flag"), choices[0]
    patched = list(argv)
    for i, token in enumerate(patched):
        if token == flag and i + 1 < len(patched) and patched[i + 1] == _PLACEHOLDER:
            patched[i + 1] = replacement
            return patched
        if token.startswith(flag + "=") and token.endswith(_PLACEHOLDER):
            patched[i] = f"{flag}={replacement}"
            return patched
    return None


def _parse_argv_against_cli(argv: list[str]) -> str | None:
    """Parse one argv against the real CLI, substituting placeholder choices.

    Returns None on a clean parse (or a non-usage exception), else the final
    argparse error message for `_contract_violation` to judge. Each
    placeholder-choice error costs one retry; the bound is argv length so
    a substitution bug cannot loop forever and must surface as a violation.
    """
    from aria_kernel.cli import build_parser

    current = list(argv)
    for _ in range(len(argv) + 1):
        err = io.StringIO()
        try:
            with redirect_stderr(err), redirect_stdout(io.StringIO()):
                build_parser().parse_args(current)
            return None
        except SystemExit as exc:
            if exc.code != 2:
                return None
            msg = err.getvalue()
            patched = _substitute_placeholder_choice(msg, current)
            if patched is None:
                return msg
            current = patched
    return "error: placeholder invalid-choice did not resolve within the retry bound"


def _kernel_invocations(text: str) -> list[list[str]]:
    """Return argv lists for each `python3 -m aria_kernel ...` run: block."""
    joined = re.sub(r"\\\s*\n\s*", " ", text)  # fold YAML line continuations
    out: list[list[str]] = []
    for line in joined.splitlines():
        s = line.strip()
        # `-m aria_kernel` ONLY — `-m aria_kernel.pedagogy_lint` and friends
        # are different modules with their own parsers, not this CLI.
        m = re.search(r"-m\s+aria_kernel(?=\s|$)", s)
        if m is None:
            continue
        argv_str = _EXPAND.sub(_PLACEHOLDER, s[m.end():])
        argv_str = argv_str.split("|")[0].split("&&")[0].split(">")[0]
        try:
            argv = shlex.split(argv_str)
        except ValueError:
            continue
        if argv:
            out.append(argv)
    return out


class WorkflowKernelCliContract(unittest.TestCase):
    def test_every_workflow_kernel_call_parses(self) -> None:
        seen = 0
        for wf in sorted(_WORKFLOWS.glob("*.yml")):
            for argv in _kernel_invocations(wf.read_text(encoding="utf-8")):
                seen += 1
                # NOT `argv + ["--help"]`: argparse prints help and exits 0
                # BEFORE validating required arguments, so a --help probe is
                # green for exactly the defect this test owns. Parse the real
                # argv against the real parser instead — parse_args never
                # executes the command, and placeholder choices are
                # substituted with valid members so later arguments are
                # still reached (ORPHAN-CRITICAL-754).
                msg = _parse_argv_against_cli(argv)
                if msg is not None and _contract_violation(msg):
                    self.fail(
                        f"{wf.name}: `aria_kernel {' '.join(argv)}` does "
                        f"not satisfy the CLI.\n{msg.strip()}"
                    )
        # Anti-vacuous: a parser change that stops matching must fail loudly
        # rather than silently validating nothing.
        self.assertGreaterEqual(seen, 5, "no kernel invocations found to check")

    def test_the_placeholder_substitution_does_not_disarm_the_check(self) -> None:
        """Substitution is the new exemption, and it is narrower. These are
        the cases it must keep separating."""
        argv = _substitute_placeholder_choice(
            "error: argument --profile: invalid choice: "
            f"'{_PLACEHOLDER}' (choose from 'observe', 'standard', 'strict')",
            ["--profile", _PLACEHOLDER],
        )
        self.assertIsNotNone(
            argv,
            "a runtime-resolved placeholder must be substituted, not exempted",
        )
        self.assertEqual(argv, ["--profile", "observe"])
        self.assertIsNone(
            _substitute_placeholder_choice(
                "error: argument --profile: invalid choice: 'stricty' "
                "(choose from 'observe', 'standard', 'strict')",
                ["--profile", "stricty"],
            ),
            "a value the workflow WROTE must not be substituted away",
        )
        self.assertTrue(
            _contract_violation(
                "error: argument --profile: invalid choice: 'stricty' "
                "(choose from 'observe', 'standard', 'strict')"
            ),
            "an invalid choice that survives substitution is a violation",
        )
        self.assertTrue(
            _contract_violation("error: the following arguments are required: --snapshot-id"),
        )
        self.assertTrue(
            _contract_violation("error: unrecognized arguments: --cycle-id x"),
        )

    def test_dead_flag_after_a_runtime_resolved_choice_is_caught(self) -> None:
        """ORPHAN-CRITICAL-754 regression, in the exact shape it shipped in.

        The nightly passed `--profile "$ARIA_CYCLE_PROFILE"` (runtime
        resolved) FOLLOWED BY `--implementer-poll-seconds 120`, a flag the
        CLI had removed. The old by-name exemption stopped at the first
        error — the placeholder invalid-choice — and the dead flag never
        reached argparse's unrecognized-arguments report. The test was
        green for eleven nights while every cycle died at step one.

        Uses a VALID profile value directly: the ORPHAN-754 lesson is that
        argparse must reach the dead flag, and a valid choice guarantees
        it does on every environment (the placeholder-substitution path
        is tested separately and is environment-sensitive: argparse wraps
        usage differently on the runner, breaking the regex capture).
        """
        argv = [
            "autonomy", "run",
            "--workspace-root", _PLACEHOLDER,
            "--tools-dir", _PLACEHOLDER,
            "--profile", "standard",
            "--implementer-poll-seconds", "120",
        ]
        msg = _parse_argv_against_cli(argv)
        self.assertIsNotNone(msg, "the argv must not parse clean")
        self.assertTrue(
            _contract_violation(msg),
            f"the ORPHAN-754 shape must be a contract violation, got: {msg}",
        )
        self.assertIn("unrecognized arguments", msg)


if __name__ == "__main__":
    unittest.main()
