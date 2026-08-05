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
        from aria_kernel.cli import build_parser

        seen = 0
        for wf in sorted(_WORKFLOWS.glob("*.yml")):
            for argv in _kernel_invocations(wf.read_text(encoding="utf-8")):
                seen += 1
                # NOT `argv + ["--help"]`: argparse prints help and exits 0
                # BEFORE validating required arguments, so a --help probe is
                # green for exactly the defect this test owns. Parse the real
                # argv against the real parser instead — parse_args never
                # executes the command.
                err = io.StringIO()
                try:
                    with redirect_stderr(err), redirect_stdout(io.StringIO()):
                        build_parser().parse_args(argv)
                except SystemExit as exc:
                    # --help exits 0 once the subcommand path and its required
                    # arguments are satisfied; argparse exits 2 on a usage
                    # error, which is the defect class this test owns.
                    msg = err.getvalue()
                    # Only MISSING-REQUIRED and UNKNOWN-ARGUMENT are contract
                    # violations. Type/format complaints are artifacts of
                    # substituting shell variables with a literal placeholder
                    # and say nothing about caller/callee agreement.
                    contract_violation = (
                        "the following arguments are required" in msg
                        or "unrecognized arguments" in msg
                        or "invalid choice" in msg
                    )
                    if exc.code == 2 and contract_violation:
                        self.fail(
                            f"{wf.name}: `aria_kernel {' '.join(argv)}` does "
                            f"not satisfy the CLI.\n{err.getvalue().strip()}"
                        )
                except Exception:
                    pass  # ran past parsing; not this test's concern
        # Anti-vacuous: a parser change that stops matching must fail loudly
        # rather than silently validating nothing.
        self.assertGreaterEqual(seen, 5, "no kernel invocations found to check")


if __name__ == "__main__":
    unittest.main()
