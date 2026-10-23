"""PLAN-v2 §2 'Durdurma' / B0 — every ARIA workflow reads the operator's ``vars.ARIA_STOP``.

ARIA-HIGH-765. The stop is a repository variable only the operator can write
(the ARIA GitHub App may READ variables, never write them; board/SETUP.md UI
check 2). "Non-empty means stop", and every ARIA workflow — the merge runner
included — reads it in two places:

* every job's ``if:`` requires ``vars.ARIA_STOP == ''`` in every branch, so a
  stopped ARIA starts no job (a top-level ``||`` beside it would let a branch
  run through the stop);
* the workflow-level ``env`` passes it to every step as ``ARIA_STOP``: the
  value GitHub evaluated when the job started, which the workflow preflight's
  kill switch reads (the job gate inside the kernel). It cannot change while
  the job runs, so the kernel's in-process re-checks — kernel_change
  admission and the merge authority right before the merge call — read the
  LIVE repository variable instead (``preflight.operator_stop_engaged``;
  ``tests/test_aria_stop_operator_variable.py``).

The governed set is the kernel's own owner of "which workflows are ARIA's":
``workflow_contracts.discover_aria_workflows`` (the ``aria-*`` namespace plus
every workflow that calls the enterprise preflight). Exempt by name, each with
its reason: the two pull-request checks — a skipped job reads as a passing
required check, so gating them would wave every PR through during a stop — and
the external watchdog, the watchman that must keep watching while ARIA is
stopped (it imports no kernel and writes only its own incident issue).

One owner each: exactly one kernel module reads the ``ARIA_STOP``
environment variable (the job-start snapshot), and exactly one names the
repository-variables API (the live read). Whether a job condition requires the
stop is decided by ``workflow_contracts.condition_requires``, the one owner of
that question (B0 corrective R4); this file keeps no parser of its own.

Red at the branch base by assertion: no workflow reads ``vars.ARIA_STOP``.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

from aria_kernel.workflow_contracts import condition_requires, discover_aria_workflows

_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_STOP_CONJUNCT = "vars.ARIA_STOP == ''"
_STOP_ENV = "${{ vars.ARIA_STOP }}"
STOP_EXEMPT: dict[str, str] = {
    "aria-kernel": "pull-request/push CI of the kernel's own code; a skipped job reads as a passing check",
    "aria-merge-authority": "required pull-request check; a skipped job reads as a passing required check",
    "aria-external-watchdog": "the watchman: imports no kernel, writes only its incident issue, keeps watching",
}


def _load(path: Path) -> dict[str, Any]:
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    return workflow if isinstance(workflow, dict) else {}


class ConditionRequiresTests(unittest.TestCase):
    """The one predicate, on the inputs the three former parsers answered differently (B0 review P08)."""

    def test_one_answer_per_input(self) -> None:
        cases = {
            "vars.ARIA_STOP == ''": True,
            "vars.ARIA_STOP==''": True,
            "${{ vars.ARIA_STOP == '' && (github.event_name == 'schedule' || inputs.x) }}": True,
            "vars.ARIA_STOP == '' &&\n  github.event.workflow_run.conclusion == 'success'": True,
            "a && vars.ARIA_STOP == ''": True,
            "(vars.ARIA_STOP == '' && a) || (vars.ARIA_STOP == '' && b)": True,
            "(vars.ARIA_STOP == '')": True,
            "github.head_ref == 'x || y' && vars.ARIA_STOP == ''": True,
            "vars.ARIA_STOP == '' && a || b": False,
            "a || vars.ARIA_STOP == ''": False,
            "${{ vars.ARIA_STOP == '' || always() }}": False,
            "vars.ARIA_STOP != ''": False,
            "!(vars.ARIA_STOP == '')": False,
            "always() && (github.ref == 'refs/heads/main' || vars.ARIA_STOP == '')": False,
            "vars.ARIA_STOP == ' '": False,
            # The conjunct's text inside a string literal is not the conjunct.
            "github.head_ref == 'vars.ARIA_STOP == ''''' && a": False,
            "github.event_name == 'schedule'": False,
            "": False,
            # B0 corrective round 4, R4-2: an if: that mixes ${{ }} with text
            # outside it is a string template to GitHub, always truthy.
            "${{ vars.ARIA_STOP == '' }} && x": False,
            "x && ${{ vars.ARIA_STOP == '' }}": False,
            "${{ vars.ARIA_STOP == '' }} && ${{ github.ref == 'refs/heads/main' }}": False,
            "(${{ vars.ARIA_STOP == '' }})": False,
            "${{ vars.ARIA_STOP == ''": False,
            "${{ ${{ vars.ARIA_STOP == '' && x }}": False,
            "${{ vars.ARIA_STOP == '' && github.head_ref == '}}' }}": True,
        }
        for condition, expected in cases.items():
            with self.subTest(condition=condition):
                self.assertIs(condition_requires(condition, _STOP_CONJUNCT), expected)
        self.assertFalse(condition_requires(None, _STOP_CONJUNCT))


class EveryAriaWorkflowReadsTheStopTests(unittest.TestCase):
    def setUp(self) -> None:
        self.discovered = discover_aria_workflows(_REPO_ROOT)
        self.assertIn("aria-merge-runner", self.discovered)

    def test_every_exemption_names_a_workflow_that_exists(self) -> None:
        self.assertLessEqual(set(STOP_EXEMPT), set(self.discovered))

    def test_every_job_of_every_aria_workflow_is_gated_by_the_stop(self) -> None:
        ungated: list[str] = []
        for workflow_id, path in sorted(self.discovered.items()):
            if workflow_id in STOP_EXEMPT:
                continue
            for job_id, job in sorted((_load(path).get("jobs") or {}).items()):
                if not isinstance(job, dict) or not condition_requires(job.get("if"), _STOP_CONJUNCT):
                    ungated.append(f"{workflow_id}/{job_id}")
        self.assertEqual(ungated, [], f"jobs that start while the operator's stop is set ({_STOP_CONJUNCT})")

    def test_every_aria_workflow_passes_the_stop_to_the_kernel(self) -> None:
        missing = [
            workflow_id for workflow_id, path in sorted(self.discovered.items())
            if workflow_id not in STOP_EXEMPT and (_load(path).get("env") or {}).get("ARIA_STOP") != _STOP_ENV
        ]
        self.assertEqual(missing, [], f"workflow-level env ARIA_STOP: '{_STOP_ENV}' missing")

    def test_the_merge_runner_merge_job_is_gated(self) -> None:
        job = _load(self.discovered["aria-merge-runner"])["jobs"]["merge"]
        self.assertTrue(condition_requires(job.get("if"), _STOP_CONJUNCT),
                        "the merge runner starts no merge job while ARIA is stopped")


def _environment_reads(tree: ast.AST) -> list[int]:
    """Lines where ``"ARIA_STOP"`` is read as an environment variable (not a file name)."""
    lines: list[int] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and any(
                isinstance(arg, ast.Constant) and arg.value == "ARIA_STOP" for arg in node.args):
            name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            if name in {"get", "getenv", "pop", "setdefault"} or "env" in name.lower():
                lines.append(node.lineno)
        elif isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) \
                and node.slice.value == "ARIA_STOP" and "environ" in ast.unparse(node.value):
            lines.append(node.lineno)
        elif isinstance(node, ast.Compare) and isinstance(node.left, ast.Constant) \
                and node.left.value == "ARIA_STOP" and any("environ" in ast.unparse(c) for c in node.comparators):
            lines.append(node.lineno)
    return lines


class OneKernelReaderOfTheStopTests(unittest.TestCase):
    def test_exactly_one_kernel_module_reads_the_stop_variable(self) -> None:
        readers = {}
        for path in sorted(_KERNEL.rglob("*.py")):
            lines = _environment_reads(ast.parse(path.read_text(encoding="utf-8")))
            if lines:
                readers[path.relative_to(_KERNEL).as_posix()] = lines
        self.assertEqual(len(readers), 1, f"one owner reads ARIA_STOP from the environment; found {readers}")

    def test_exactly_one_kernel_module_reads_the_repository_variable(self) -> None:
        readers = sorted(path.relative_to(_KERNEL).as_posix() for path in _KERNEL.rglob("*.py")
                         if "/actions/variables" in path.read_text(encoding="utf-8"))
        self.assertEqual(readers, ["preflight.py"], "one owner reads the live vars.ARIA_STOP")


if __name__ == "__main__":
    unittest.main()
