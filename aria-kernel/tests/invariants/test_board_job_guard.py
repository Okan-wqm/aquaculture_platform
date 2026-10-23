"""PLAN-v2 B0 — the Board job guard: a Board job runs only as main's code, on a GitHub-hosted runner, and leaks nothing.

ARIA-MEDIUM-766 / §1.9: the Board is outside ARIA's trust domain. Its
secrets (``ARIA_BOARD_SIGNING_KEY``, ``ARIA_BOARD_VAULT_DEPLOY_KEY``,
``ARIA_BOARD_VAULT_DATA_KEY``) live only in the GitHub environment
``aria-board``, whose deployment branch policy admits ``main`` alone
(board/SETUP.md). The workflow side of that boundary is pinned here, for every
job that declares ``environment: aria-board`` (a "Board job"):

* its ``if:`` carries, as top-level conjuncts, ``github.ref == 'refs/heads/main'``
  (the job verifies the ref itself, not only through the environment policy)
  and ``vars.ARIA_STOP == ''`` (the Board reads the operator's stop too), with
  no top-level ``||`` that could run a branch past them;
* it runs on a GitHub-hosted runner (an ``ubuntu-*`` label), never on ARIA's
  self-hosted runner, whose uid is the population the Board must exclude;
* it checks out the Board version — this repository at the triggering main
  commit (``ref`` absent or ``${{ github.sha }}``), never a ref an event payload
  or an input chooses — and keeps no credential in the checkout;
* it uploads no artifact and saves no cache (both are readable by ARIA's own
  jobs on the same branch), and runs no shell trace that would echo case
  content into the log;
* the workflow that holds it runs no pull-request code (no ``pull_request``,
  ``pull_request_target`` or ``merge_group`` trigger);
* no job other than a Board job, and no workflow-level ``env``, names a Board
  secret or the ``aria-board`` environment.

Red at the branch base by assertion: no Board job exists.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
BOARD_ENVIRONMENT = "aria-board"
_REQUIRED_CONJUNCTS = ("github.ref == 'refs/heads/main'", "vars.ARIA_STOP == ''")
_LEAKING_ACTIONS = ("actions/upload-artifact@", "actions/cache@", "actions/cache/save@")
_PR_TRIGGERS = ("pull_request", "pull_request_target", "merge_group")
_SHELL_TRACE = re.compile(r"(^|[\s;])(set\s+-[a-wyz]*x|set\s+-o\s+xtrace|bash\s+-[a-wyz]*x)\b", re.MULTILINE)


def _workflows() -> dict[str, dict[str, Any]]:
    loaded = {}
    for path in sorted([*_WORKFLOWS.glob("*.yml"), *_WORKFLOWS.glob("*.yaml")]):
        workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
        loaded[path.name] = workflow if isinstance(workflow, dict) else {}
    return loaded


def _environment(job: dict[str, Any]) -> str | None:
    env = job.get("environment")
    return str(env.get("name")) if isinstance(env, dict) else (str(env) if env is not None else None)


def _board_jobs() -> list[tuple[str, str, dict[str, Any], dict[str, Any]]]:
    return [(name, job_id, job, workflow) for name, workflow in _workflows().items()
            for job_id, job in (workflow.get("jobs") or {}).items()
            if isinstance(job, dict) and _environment(job) == BOARD_ENVIRONMENT]


def _top_level_split(expression: str, operator: str) -> list[str]:
    parts, depth, quoted, start, index = [], 0, False, 0, 0
    while index < len(expression):
        char = expression[index]
        if char == "'":
            quoted = not quoted
        elif not quoted and char == "(":
            depth += 1
        elif not quoted and char == ")":
            depth -= 1
        elif not quoted and depth == 0 and expression.startswith(operator, index):
            parts.append(expression[start:index].strip())
            start = index + len(operator)
            index = start
            continue
        index += 1
    parts.append(expression[start:].strip())
    return parts


def top_level_conjuncts(job_if: Any) -> list[str] | None:
    """The ``&&`` conjuncts of a job condition, or None when a top-level ``||`` makes them optional."""
    if job_if is None:
        return []
    text = re.sub(r"\s+", " ", str(job_if)).strip()
    match = re.fullmatch(r"\$\{\{ ?(.*?) ?\}\}", text)
    expression = (match.group(1) if match else text).strip()
    if len(_top_level_split(expression, "||")) > 1:
        return None
    return _top_level_split(expression, "&&")


class ConjunctPredicateTests(unittest.TestCase):
    def test_the_predicate_reads_top_level_conjuncts_only(self) -> None:
        self.assertEqual(top_level_conjuncts("${{ github.ref == 'refs/heads/main' && vars.ARIA_STOP == '' }}"),
                         ["github.ref == 'refs/heads/main'", "vars.ARIA_STOP == ''"])
        self.assertIsNone(top_level_conjuncts("github.ref == 'refs/heads/main' || inputs.force"))
        self.assertEqual(top_level_conjuncts("a && (b || c)"), ["a", "(b || c)"])
        self.assertEqual(top_level_conjuncts(None), [])


class BoardJobGuardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.jobs = _board_jobs()
        self.assertTrue(self.jobs, f"no workflow job declares environment: {BOARD_ENVIRONMENT}")

    def test_a_board_job_verifies_main_and_the_operator_stop(self) -> None:
        for name, job_id, job, _ in self.jobs:
            with self.subTest(job=f"{name}/{job_id}"):
                conjuncts = top_level_conjuncts(job.get("if"))
                self.assertIsNotNone(conjuncts, "a top-level || would run a branch past the guard")
                for required in _REQUIRED_CONJUNCTS:
                    self.assertIn(required, conjuncts)

    def test_a_board_job_runs_on_a_github_hosted_runner(self) -> None:
        for name, job_id, job, _ in self.jobs:
            with self.subTest(job=f"{name}/{job_id}"):
                runs_on = job.get("runs-on")
                self.assertIsInstance(runs_on, str, "a label list is how a job reaches a self-hosted runner")
                self.assertTrue(str(runs_on).startswith("ubuntu-"), runs_on)

    def test_a_board_job_checks_out_main_as_triggered_and_keeps_no_credential(self) -> None:
        for name, job_id, job, _ in self.jobs:
            checkouts = [s for s in job.get("steps") or [] if str(s.get("uses") or "").startswith("actions/checkout@")]
            with self.subTest(job=f"{name}/{job_id}"):
                self.assertTrue(checkouts, "the Board version is checked out explicitly")
                for step in checkouts:
                    options = step.get("with") or {}
                    self.assertIn(str(options.get("persist-credentials")).lower(), ("false",))
                    if "repository" not in options:
                        self.assertIn(options.get("ref"), (None, "${{ github.sha }}"),
                                      "the Board runs the main commit that triggered it, never a chosen ref")

    def test_a_board_job_uploads_nothing_and_traces_no_shell(self) -> None:
        for name, job_id, job, _ in self.jobs:
            for step in job.get("steps") or []:
                uses, run = str(step.get("uses") or ""), str(step.get("run") or "")
                with self.subTest(job=f"{name}/{job_id}", step=step.get("name") or uses or run[:40]):
                    self.assertFalse(uses.startswith(_LEAKING_ACTIONS), uses)
                    self.assertIsNone(_SHELL_TRACE.search(run), "a shell trace echoes case content into the log")

    def test_a_board_workflow_runs_no_pull_request_code(self) -> None:
        for name in sorted({name for name, *_ in self.jobs}):
            workflow = _workflows()[name]
            triggers = workflow.get(True, workflow.get("on")) or {}
            names = [triggers] if isinstance(triggers, str) else list(triggers)
            with self.subTest(workflow=name):
                self.assertFalse(set(names) & set(_PR_TRIGGERS), names)


class BoardSecretsStayInBoardJobsTests(unittest.TestCase):
    def test_no_other_job_or_workflow_env_names_a_board_secret_or_the_board_environment(self) -> None:
        leaks: list[str] = []
        for name, workflow in _workflows().items():
            if "ARIA_BOARD_" in yaml.safe_dump(workflow.get("env") or {}):
                leaks.append(f"{name}:env")
            for job_id, job in (workflow.get("jobs") or {}).items():
                if not isinstance(job, dict) or _environment(job) == BOARD_ENVIRONMENT:
                    continue
                text = yaml.safe_dump(job)
                if "ARIA_BOARD_" in text or BOARD_ENVIRONMENT in text:
                    leaks.append(f"{name}/{job_id}")
        self.assertEqual(leaks, [])


if __name__ == "__main__":
    unittest.main()
