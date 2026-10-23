"""PLAN-v2 B0 — the Board job guard: a Board job runs only as main's code, on a GitHub-hosted runner, and leaks nothing.

ARIA-MEDIUM-766 / §1.9: the Board is outside ARIA's trust domain. Its
secrets (``ARIA_BOARD_SIGNING_KEY``, ``ARIA_BOARD_VAULT_DEPLOY_KEY``,
``ARIA_BOARD_VAULT_DATA_KEY``) live only in the GitHub environment
``aria-board``, whose deployment branch policy admits ``main`` alone
(board/SETUP.md). The workflow side of that boundary is pinned here, for every
job that declares ``environment: aria-board`` (a "Board job"):

* its ``if:`` requires ``github.ref == 'refs/heads/main'`` (the job verifies
  the ref itself, not only through the environment policy) and
  ``vars.ARIA_STOP == ''`` (the Board reads the operator's stop too) in every
  branch — judged by ``workflow_contracts.condition_requires``, the one owner
  of that question;
* it runs on a GitHub-hosted runner (an ``ubuntu-*`` label), never on ARIA's
  self-hosted runner, whose uid is the population the Board must exclude;
* it checks out the Board version — this repository (``repository`` absent or
  naming this repository) at the triggering main commit (``ref`` absent or
  ``${{ github.sha }}``), never a ref an event payload or an input chooses —
  or the vault repository by name, and keeps no credential in a checkout;
* it writes nothing: the workflow declares read-only ``permissions``, the job
  widens none, and no step pushes (B0 has no writer; B2 adds the one named
  signed-totals writer under this guard);
* it uploads no artifact and saves no cache (both are readable by ARIA's own
  jobs on the same branch), and traces no shell — in a ``run:`` body, a step
  ``shell:``, or the job's or workflow's ``defaults.run.shell`` — since a trace
  echoes case content into the log;
* it never runs the ARIA kernel package (B0 corrective R3): no
  setup-aria-kernel action (its unpinned install and its ``import
  aria_kernel``), no ``-m aria_kernel``, no ``PYTHONPATH``; the kernel file it
  runs is ``examination_board.py``, by path, in isolated mode (``python3 -I``),
  and every ``pip install`` it makes is ``--require-hashes``; and
  ``examination_board`` itself imports the standard library and
  ``cryptography`` alone;
* the workflow that holds it runs no pull-request code (no ``pull_request``,
  ``pull_request_target`` or ``merge_group`` trigger);
* no job other than a Board job, and no workflow-level ``env``, names a Board
  secret or the ``aria-board`` environment.

Every rule is a function over one parsed workflow, so the guard is tested the
way it fails: each mutation of the real Board workflow below, applied alone,
must be refused.
"""
from __future__ import annotations

import ast
import base64
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable

import yaml  # type: ignore[import-untyped]

from aria_kernel.examination_board import VAULT_DATA_KEY_ENV, VAULT_REPOSITORY
from aria_kernel.operator_approval import load_operators_policy
from aria_kernel.workflow_contracts import condition_requires

_REPO_ROOT = Path(__file__).resolve().parents[3]
_WORKFLOWS = _REPO_ROOT / ".github" / "workflows"
_BOARD_WORKFLOW = "examination-board.yml"
_BOARD_MODULE = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "examination_board.py"
BOARD_ENVIRONMENT = "aria-board"
_REQUIRED_CONJUNCTS = ("github.ref == 'refs/heads/main'", "vars.ARIA_STOP == ''")
_THIS_REPOSITORY = ("${{ github.repository }}", str(load_operators_policy()["repository"]))
_BOARD_VERSION_REFS = (None, "${{ github.sha }}")
_LEAKING_ACTIONS = ("actions/upload-artifact@", "actions/cache@", "actions/cache/save@")
_KERNEL_SETUP_ACTION = ".github/actions/setup-aria-kernel"
_PR_TRIGGERS = ("pull_request", "pull_request_target", "merge_group")
_READ_ONLY_LEVELS = ("read", "none")
# `set -x`, `set -euxo pipefail`, `bash -ex script`, and any spelling of xtrace
# (`set -o xtrace`, `SHELLOPTS=xtrace`). The first guard required a word
# boundary after the `x`, so `set -euxo pipefail` passed it.
_SHELL_TRACE = re.compile(r"(^|[\s;&|(])(?:set|bash|sh)\s+-[A-Za-z]*x|xtrace", re.MULTILINE)
_GIT_PUSH = re.compile(r"\bgit\b[^\n;&|]*\spush\b")
_KERNEL_PATH = "aria-kernel/aria_kernel/"
_BOARD_ENTRY = re.compile(r"^python3 -I aria-kernel/aria_kernel/examination_board\.py [a-z-]+$")
_THIRD_PARTY = frozenset({"cryptography"})


def _workflows() -> dict[str, dict[str, Any]]:
    loaded = {}
    for path in sorted([*_WORKFLOWS.glob("*.yml"), *_WORKFLOWS.glob("*.yaml")]):
        workflow = yaml.safe_load(path.read_text(encoding="utf-8"))
        loaded[path.name] = workflow if isinstance(workflow, dict) else {}
    return loaded


def _environment(job: dict[str, Any]) -> str | None:
    env = job.get("environment")
    return str(env.get("name")) if isinstance(env, dict) else (str(env) if env is not None else None)


def _board_jobs_of(workflow: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    return [(job_id, job) for job_id, job in (workflow.get("jobs") or {}).items()
            if isinstance(job, dict) and _environment(job) == BOARD_ENVIRONMENT]


def _steps(job: dict[str, Any]) -> list[dict[str, Any]]:
    return [step for step in job.get("steps") or [] if isinstance(step, dict)]


def _shell_traces(shell: Any) -> bool:
    """A ``shell:`` value that turns on xtrace: a short-option cluster holding ``x``, or ``xtrace``."""
    words = str(shell or "").split()
    return "xtrace" in words or any(w.startswith("-") and not w.startswith("--") and "x" in w[1:] for w in words)


def _defaults_shell(holder: dict[str, Any]) -> Any:
    defaults = holder.get("defaults") or {}
    return ((defaults.get("run") or {}) if isinstance(defaults, dict) else {}).get("shell")


def _read_only(permissions: Any) -> bool:
    if permissions == "read-all":
        return True
    return isinstance(permissions, dict) and all(level in _READ_ONLY_LEVELS for level in permissions.values())


def _condition_violations(job: dict[str, Any]) -> list[str]:
    return [f"if: does not require {required}" for required in _REQUIRED_CONJUNCTS
            if not condition_requires(job.get("if"), required)]


def _runner_violations(job: dict[str, Any]) -> list[str]:
    runs_on = job.get("runs-on")
    if not isinstance(runs_on, str) or not runs_on.startswith("ubuntu-"):
        return [f"runs-on {runs_on!r} is not a GitHub-hosted ubuntu label"]
    return []


def _checkout_violations(job: dict[str, Any]) -> list[str]:
    checkouts = [s for s in _steps(job) if str(s.get("uses") or "").startswith("actions/checkout@")]
    violations: list[str] = []
    board_version = False
    for step in checkouts:
        options = step.get("with") or {}
        if str(options.get("persist-credentials")).lower() != "false":
            violations.append("a checkout keeps its credential")
        repository = options.get("repository")
        if repository is None or repository in _THIS_REPOSITORY:
            board_version = True
            if options.get("ref") not in _BOARD_VERSION_REFS:
                violations.append(f"this repository checked out at a chosen ref {options.get('ref')!r}")
        elif repository != VAULT_REPOSITORY:
            violations.append(f"a checkout of {repository!r}, neither this repository nor the vault")
    if not board_version:
        violations.append("the Board version is not checked out")
    return violations


def _write_violations(workflow: dict[str, Any], job: dict[str, Any]) -> list[str]:
    violations: list[str] = []
    if not _read_only(workflow.get("permissions")):
        violations.append(f"workflow permissions {workflow.get('permissions')!r} are not read-only")
    if "permissions" in job and not _read_only(job.get("permissions")):
        violations.append(f"job permissions {job.get('permissions')!r} are not read-only")
    violations += [f"step pushes: {step.get('name') or str(step.get('run'))[:60]}" for step in _steps(job)
                   if _GIT_PUSH.search(str(step.get("run") or ""))]
    return violations


def _leak_violations(workflow: dict[str, Any], job: dict[str, Any]) -> list[str]:
    violations: list[str] = []
    for holder, where in ((workflow, "workflow"), (job, "job")):
        if _shell_traces(_defaults_shell(holder)):
            violations.append(f"{where} defaults.run.shell traces")
    for step in _steps(job):
        uses, run = str(step.get("uses") or ""), str(step.get("run") or "")
        if uses.startswith(_LEAKING_ACTIONS):
            violations.append(f"step uploads or caches: {uses}")
        if _SHELL_TRACE.search(run) or _shell_traces(step.get("shell")):
            violations.append(f"step traces its shell: {step.get('name') or run[:60]}")
    return violations


def _kernel_violations(workflow: dict[str, Any], job: dict[str, Any]) -> list[str]:
    violations: list[str] = []
    for holder, where in ((workflow, "workflow"), (job, "job")):
        if "PYTHONPATH" in (holder.get("env") or {}):
            violations.append(f"{where} env sets PYTHONPATH")
    for step in _steps(job):
        uses, run = str(step.get("uses") or ""), str(step.get("run") or "")
        label = step.get("name") or uses or run[:60]
        if uses.endswith(_KERNEL_SETUP_ACTION):
            violations.append(f"step provisions the ARIA kernel: {label}")
        if "PYTHONPATH" in run or "PYTHONPATH" in (step.get("env") or {}):
            violations.append(f"step sets PYTHONPATH: {label}")
        if re.search(r"-m\s+aria_kernel", run):
            violations.append(f"step runs the aria_kernel package: {label}")
        if (_KERNEL_PATH in run or "aria_kernel" in run) and not _BOARD_ENTRY.fullmatch(run.strip()):
            violations.append(f"step runs kernel code other than examination_board.py in isolation: {label}")
        if "pip install" in run and "--require-hashes" not in run:
            violations.append(f"step installs without --require-hashes: {label}")
    return violations


def _trigger_violations(workflow: dict[str, Any]) -> list[str]:
    triggers = workflow.get(True, workflow.get("on")) or {}
    names = [triggers] if isinstance(triggers, str) else list(triggers)
    return [f"pull-request trigger {name}" for name in names if name in _PR_TRIGGERS]


_RULES: dict[str, Callable[[dict[str, Any], dict[str, Any]], list[str]]] = {
    "condition": lambda workflow, job: _condition_violations(job),
    "runner": lambda workflow, job: _runner_violations(job),
    "checkout": lambda workflow, job: _checkout_violations(job),
    "writes": _write_violations,
    "leaks": _leak_violations,
    "kernel": _kernel_violations,
    "triggers": lambda workflow, job: _trigger_violations(workflow),
}


def board_violations(workflow: dict[str, Any]) -> dict[str, list[str]]:
    """Every guard rule's violations, per Board job of ``workflow`` (``{}`` when it holds none)."""
    found: dict[str, list[str]] = {}
    for job_id, job in _board_jobs_of(workflow):
        violations = [f"{rule}: {v}" for rule, check in _RULES.items() for v in check(workflow, job)]
        if violations:
            found[job_id] = violations
    return found


class BoardJobGuardTests(unittest.TestCase):
    def test_board_jobs_exist(self) -> None:
        self.assertTrue([name for name, workflow in _workflows().items() if _board_jobs_of(workflow)],
                        f"no workflow job declares environment: {BOARD_ENVIRONMENT}")

    def test_every_board_job_keeps_every_rule(self) -> None:
        found = {name: violations for name, workflow in _workflows().items()
                 if (violations := board_violations(workflow))}
        self.assertEqual(found, {})


def _custody_job(workflow: dict[str, Any]) -> dict[str, Any]:
    return workflow["jobs"]["vault-custody"]


def _set(path: tuple[Any, ...], value: Any) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        holder = workflow
        for key in path[:-1]:
            holder = holder.setdefault(key, {}) if isinstance(key, str) else holder[key]
        holder[path[-1]] = value
    return mutate


def _checkout_with(**options: Any) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        _steps(_custody_job(workflow))[0].setdefault("with", {}).update(options)
    return mutate


def _add_step(step: dict[str, Any]) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        _custody_job(workflow)["steps"].append(step)
    return mutate


def _custody_step(**fields: Any) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        _steps(_custody_job(workflow))[-1].update(fields)
    return mutate


# The reviewer's mutated Board workflow (B0 review round 1, BLK-3 / p14) passed
# every rule of the first guard; each of its changes, and the R3 entry
# changes, must now be refused alone.
_MUTATIONS: dict[str, Callable[[dict[str, Any]], None]] = {
    "workflow_contents_write": _set(("permissions",), {"contents": "write"}),
    "workflow_write_all": _set(("permissions",), "write-all"),
    "job_contents_write": lambda w: _custody_job(w).update({"permissions": {"contents": "write"}}),
    "this_repository_named_at_an_input_ref": _checkout_with(repository="${{ github.repository }}",
                                                            ref="${{ inputs.ref }}"),
    "this_repository_by_literal_name_at_a_branch": _checkout_with(repository=_THIS_REPOSITORY[1], ref="feature"),
    "another_repository": _checkout_with(repository="someone/else"),
    "checkout_keeps_its_credential": _checkout_with(**{"persist-credentials": True}),
    "push_to_aria_state": _add_step({"name": "write", "run": "git add totals.json && git commit -m x && "
                                                              "git push origin HEAD:aria/state"}),
    "step_shell_traces": _add_step({"name": "echo", "shell": "bash -x {0}", "run": 'echo "$CASE"'}),
    "workflow_defaults_shell_traces": _set(("defaults",), {"run": {"shell": "bash -x {0}"}}),
    "job_defaults_shell_traces": lambda w: _custody_job(w).update({"defaults": {"run": {"shell": "bash -ex {0}"}}}),
    "run_traces": _add_step({"name": "trace", "run": "set -euxo pipefail\necho ok"}),
    "uploads_an_artifact": _add_step({"uses": "actions/upload-artifact@v4", "with": {"path": "cases"}}),
    "provisions_the_kernel": _add_step({"uses": "./.github/actions/setup-aria-kernel"}),
    "runs_the_package": _custody_step(
        run="PYTHONPATH=aria-kernel python3 -m aria_kernel.examination_board vault-custody-check"),
    "runs_the_file_without_isolation": _custody_step(
        run="python3 aria-kernel/aria_kernel/examination_board.py vault-custody-check"),
    "runs_another_kernel_file": _custody_step(run="python3 -I aria-kernel/aria_kernel/cycle.py run"),
    "pythonpath_in_job_env": lambda w: _custody_job(w).update({"env": {"PYTHONPATH": "aria-kernel"}}),
    "installs_unpinned": _add_step({"name": "install", "run": "python3 -m pip install cryptography"}),
    "condition_or_branch": lambda w: _custody_job(w).update(
        {"if": "vars.ARIA_STOP == '' && github.ref == 'refs/heads/main' || inputs.force"}),
    "condition_without_main": lambda w: _custody_job(w).update({"if": "vars.ARIA_STOP == ''"}),
    "self_hosted": lambda w: _custody_job(w).update({"runs-on": ["self-hosted", "linux"]}),
    "pull_request_trigger": _set(("on",), {"pull_request": {}, "workflow_dispatch": {}}),
}


class EachMutationIsRefusedTests(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = _workflows()[_BOARD_WORKFLOW]
        self.assertEqual(board_violations(self.workflow), {}, "the real Board workflow keeps the guard")

    def test_each_mutation_alone_breaks_the_guard(self) -> None:
        for name, mutate in _MUTATIONS.items():
            with self.subTest(mutation=name):
                mutated = copy.deepcopy(self.workflow)
                if "on" not in mutated and True in mutated:
                    mutated["on"] = mutated.pop(True)
                mutate(mutated)
                self.assertTrue(board_violations(mutated), f"{name} passed the guard")

    def test_the_vault_repository_by_name_is_a_board_checkout(self) -> None:
        mutated = copy.deepcopy(self.workflow)
        _add_step({"uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                   "with": {"repository": VAULT_REPOSITORY, "path": "vault", "persist-credentials": False}})(mutated)
        self.assertEqual(board_violations(mutated), {})


class TheKeyHoldingProcessLoadsNoAriaKernelTests(unittest.TestCase):
    """B0 corrective R3: the process that holds the vault key runs examination_board.py alone."""

    def _custody_run(self) -> str:
        steps = [s for s in _steps(_custody_job(_workflows()[_BOARD_WORKFLOW]))
                 if VAULT_DATA_KEY_ENV in (s.get("env") or {})]
        self.assertEqual(len(steps), 1, "one step holds the vault data key")
        return str(steps[0]["run"]).strip()

    def test_examination_board_imports_the_standard_library_and_cryptography_alone(self) -> None:
        tree = ast.parse(_BOARD_MODULE.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                self.assertEqual(node.level, 0, "a relative import reaches the aria_kernel package")
                imported.add(str(node.module).split(".")[0])
            elif isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
        foreign = sorted(name for name in imported
                         if name not in sys.stdlib_module_names and name not in _THIRD_PARTY)
        self.assertEqual(foreign, [])

    def test_the_board_step_runs_isolated_and_loads_no_aria_kernel_module(self) -> None:
        run = self._custody_run()
        self.assertRegex(run, _BOARD_ENTRY)
        with tempfile.TemporaryDirectory(prefix="aria-board-entry-") as scratch:
            # The exact run: line, with `python3` resolved to this interpreter
            # and -X importtime added so every module the process loads is named.
            bin_dir = Path(scratch)
            (bin_dir / "python3").symlink_to(sys.executable)
            env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}",
                   VAULT_DATA_KEY_ENV: base64.b64encode(os.urandom(32)).decode("ascii")}
            traced = run.replace("python3 -I ", "python3 -I -X importtime ", 1)
            for line, label in ((run, "exact"), (traced, "importtime")):
                with self.subTest(line=label):
                    done = subprocess.run(["bash", "-c", line], cwd=_REPO_ROOT, env=env, capture_output=True,
                                          text=True, timeout=120, check=False)
                    self.assertEqual(done.returncode, 0, done.stderr[-2000:])
                    self.assertEqual(json.loads(done.stdout)["board_vault_key"], "ok")
                    if label == "importtime":
                        loaded = {row.split("|")[-1].strip() for row in done.stderr.splitlines()
                                  if row.startswith("import time:")}
                        self.assertIn("cryptography", loaded, "the trace names every module the process loads")
                        self.assertEqual(sorted(m for m in loaded if m.startswith("aria_kernel")), [])


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
