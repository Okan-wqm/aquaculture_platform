"""ARIA-HIGH-386 — a chain edge GitHub never fires is not an edge.

GitHub creates no ``workflow_run`` event for a run that was started with the
job token (``github.token``); ``workflow_dispatch`` is the one event that
token may create. The executor's ``chain-next-cycle`` job and the dataflow
watchdog both start ``aria-auto-cycle`` with the job token, and the drain
followed the cycle only through a ``workflow_run`` trigger, so every chained
cycle ended with no drain after it. Cycle 37728223278 (2026-10-08) finished
and the CONVERGED plan it left waited for a human to dispatch the executor.

  * I-CHAIN-01 — no workflow listens for ``workflow_run`` on a workflow that
                 any workflow starts with the job token: those runs would
                 never reach the listener.
  * I-CHAIN-02 — the cycle → drain edge exists: ``aria-auto-cycle`` dispatches
                 ``aria-agent-executor`` after its ``cycle`` job on every
                 completion an operator did not cancel.
  * I-CHAIN-03 — the drain → cycle edge exists (the rhythm's return edge).
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path
from typing import Any

import yaml  # type: ignore[import-untyped]

_REPO_ROOT = Path(__file__).resolve().parents[2]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
_DISPATCH = re.compile(r"gh workflow run\s+([\w.-]+\.ya?ml)")
_JOB_TOKEN = re.compile(r"\$\{\{\s*(github\.token|secrets\.GITHUB_TOKEN)\s*\}\}")


def _load(path: Path) -> dict[str, Any]:
    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
    return loaded if isinstance(loaded, dict) else {}


def _triggers(workflow: dict[str, Any]) -> dict[str, Any]:
    # PyYAML reads the bare key `on` as the boolean True.
    triggers = workflow.get("on", workflow.get(True))
    return triggers if isinstance(triggers, dict) else {}


def _steps(workflow: dict[str, Any]) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
    for job_id, job in (workflow.get("jobs") or {}).items():
        for step in job.get("steps") or []:
            out.append((job_id, job, step))
    return out


def job_token_dispatches(workflows: dict[str, dict[str, Any]]) -> dict[str, list[str]]:
    """Workflow file → the workflows that start it with the job token."""
    starters: dict[str, list[str]] = {}
    for name, workflow in workflows.items():
        for job_id, job, step in _steps(workflow):
            run = str(step.get("run") or "")
            token = str({**(job.get("env") or {}), **(step.get("env") or {})}.get("GH_TOKEN") or "")
            if not _JOB_TOKEN.search(token):
                continue
            for target in _DISPATCH.findall(run):
                starters.setdefault(target, []).append(f"{name}:{job_id}")
    return starters


def _all_workflows() -> dict[str, dict[str, Any]]:
    return {path.name: _load(path) for path in sorted(_WORKFLOWS.glob("*.yml"))}


class ChainEdgesFire(unittest.TestCase):
    def test_i_chain_01_no_listener_waits_on_a_job_token_start(self) -> None:
        workflows = _all_workflows()
        file_by_name = {str(w.get("name")): f for f, w in workflows.items() if w.get("name")}
        starters = job_token_dispatches(workflows)
        self.assertIn(
            "aria-auto-cycle.yml", starters,
            "nothing starts the cycle with the job token any more — re-derive this "
            "contract rather than let it pass vacuously",
        )
        for listener, workflow in workflows.items():
            watched = (_triggers(workflow).get("workflow_run") or {}).get("workflows") or []
            for watched_name in watched:
                source = file_by_name.get(watched_name)
                with self.subTest(listener=listener, watches=watched_name):
                    self.assertNotIn(
                        source, starters,
                        f"{listener} waits for workflow_run of {watched_name}, but "
                        f"{starters.get(source)} start it with the job token, and GitHub "
                        "creates no workflow_run event for those runs",
                    )

    def test_i_chain_02_the_cycle_dispatches_the_drain(self) -> None:
        cycle = _load(_WORKFLOWS / "aria-auto-cycle.yml")
        edges = [
            (job_id, job) for job_id, job, step in _steps(cycle)
            if "aria-agent-executor.yml" in _DISPATCH.findall(str(step.get("run") or ""))
        ]
        self.assertEqual(len(edges), 1, "aria-auto-cycle must dispatch the executor from exactly one job")
        _, job = edges[0]
        needs = job.get("needs")
        self.assertIn("cycle", needs if isinstance(needs, list) else [needs])
        self.assertEqual(str(job.get("if")).replace(" ", ""), "${{!cancelled()}}")
        self.assertEqual(job.get("permissions"), {"actions": "write"})

    def test_i_chain_03_the_drain_dispatches_the_cycle(self) -> None:
        executor = _load(_WORKFLOWS / "aria-agent-executor.yml")
        targets = [
            target for _, _, step in _steps(executor)
            for target in _DISPATCH.findall(str(step.get("run") or ""))
        ]
        self.assertIn("aria-auto-cycle.yml", targets)

    def test_the_detector_sees_the_trap(self) -> None:
        """The pre-fix shape: a listener on a workflow the other starts with
        the job token must be flagged."""
        workflows = {
            "a.yml": {"name": "a", "jobs": {"j": {"steps": [{
                "env": {"GH_TOKEN": "${{ github.token }}"},
                "run": "gh workflow run b.yml --ref main",
            }]}}},
            "b.yml": {"name": "b", "jobs": {}},
            "c.yml": {"name": "c", True: {"workflow_run": {"workflows": ["b"]}}, "jobs": {}},
        }
        self.assertEqual(job_token_dispatches(workflows), {"b.yml": ["a.yml:j"]})


if __name__ == "__main__":
    unittest.main()
