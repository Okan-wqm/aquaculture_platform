"""PLAN-v2 §2 'Durdurma' / B0 — every ARIA workflow reads the operator's ``vars.ARIA_STOP``.

ARIA-HIGH-765. The stop is a repository variable only the operator can write
(the ARIA GitHub App holds no Variables permission; board/SETUP.md). "Non-empty
means stop", and every ARIA workflow — the merge runner included — reads it
in two places:

* every job's ``if:`` carries ``vars.ARIA_STOP == ''`` as a top-level
  conjunct, so a stopped ARIA starts no job (a top-level ``||`` beside it
  would let a branch run through the stop);
* the workflow-level ``env`` passes it to every step as ``ARIA_STOP``, so the
  kernel's own reads (the preflight kill switch, kernel_change admission, and
  the merge authority right before the merge call; see
  ``tests/test_aria_stop_operator_variable.py``) see the operator's value and
  no hand-set copy.

The governed set is the kernel's own owner of "which workflows are ARIA's":
``workflow_contracts.discover_aria_workflows`` (the ``aria-*`` namespace plus
every workflow that calls the enterprise preflight). Exempt by name, each with
its reason: the two pull-request checks — a skipped job reads as a passing
required check, so gating them would wave every PR through during a stop — and
the external watchdog, the watchman that must keep watching while ARIA is
stopped and that writes nothing.

One reader: exactly one kernel module reads the ``ARIA_STOP`` environment
variable; admission and merge call it (a second reader is how the preflight's
"truthy word" semantics would drift from the merge path's).

Red at the branch base by assertion: no workflow reads ``vars.ARIA_STOP``.
"""
from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

from aria_kernel.workflow_contracts import discover_aria_workflows

_REPO_ROOT = Path(__file__).resolve().parents[3]
_KERNEL = _REPO_ROOT / "aria-kernel" / "aria_kernel"
_STOP_CONJUNCT = "vars.ARIA_STOP == ''"
_STOP_ENV = "${{ vars.ARIA_STOP }}"
STOP_EXEMPT: dict[str, str] = {
    "aria-kernel": "pull-request/push CI of the kernel's own code; a skipped job reads as a passing check",
    "aria-merge-authority": "required pull-request check; a skipped job reads as a passing required check",
    "aria-external-watchdog": "the watchman: writes nothing, imports no kernel, and keeps watching during a stop",
}


def _load(path: Path) -> dict[str, Any]:
    workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
    return workflow if isinstance(workflow, dict) else {}


def _expression(raw: Any) -> str:
    text = re.sub(r"\s+", " ", str(raw)).strip()
    match = re.fullmatch(r"\$\{\{ ?(.*?) ?\}\}", text)
    return (match.group(1) if match else text).strip()


def _has_top_level_or(expression: str) -> bool:
    depth, quoted = 0, False
    for index, char in enumerate(expression):
        if char == "'":
            quoted = not quoted
        elif not quoted and char == "(":
            depth += 1
        elif not quoted and char == ")":
            depth -= 1
        elif not quoted and depth == 0 and expression.startswith("||", index):
            return True
    return False


def stop_gated(job_if: Any) -> bool:
    """``vars.ARIA_STOP == ''`` is the whole condition or its first top-level ``&&`` conjunct."""
    if job_if is None:
        return False
    expression = _expression(job_if)
    if expression == _STOP_CONJUNCT:
        return True
    prefix = _STOP_CONJUNCT + " && "
    return expression.startswith(prefix) and not _has_top_level_or(expression[len(prefix):])


class StopGatePredicateTests(unittest.TestCase):
    def test_the_predicate_reads_the_conjunct_and_refuses_an_or_around_it(self) -> None:
        self.assertTrue(stop_gated("vars.ARIA_STOP == ''"))
        self.assertTrue(stop_gated("${{ vars.ARIA_STOP == '' && (github.event_name == 'schedule' || inputs.x) }}"))
        self.assertTrue(stop_gated("vars.ARIA_STOP == '' &&\n  github.event.workflow_run.conclusion == 'success'"))
        self.assertFalse(stop_gated(None))
        self.assertFalse(stop_gated("github.event_name == 'schedule'"))
        self.assertFalse(stop_gated("vars.ARIA_STOP == '' && a || b"))
        self.assertFalse(stop_gated("a || vars.ARIA_STOP == ''"))
        self.assertFalse(stop_gated("vars.ARIA_STOP != ''"))


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
                if not isinstance(job, dict) or not stop_gated(job.get("if")):
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
        self.assertTrue(stop_gated(job.get("if")), "the merge runner starts no merge job while ARIA is stopped")


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


if __name__ == "__main__":
    unittest.main()
