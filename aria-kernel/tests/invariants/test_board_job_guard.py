"""PLAN-v2 B0 — the Board job guard: a Board job runs only as main's code, on a GitHub-hosted runner, and leaks nothing.

ARIA-MEDIUM-766 / §1.9: the Board is outside ARIA's trust domain. Its
secrets (``ARIA_BOARD_SIGNING_KEY``, ``ARIA_BOARD_VAULT_DEPLOY_KEY``,
``ARIA_BOARD_VAULT_DATA_KEY``) live only in the GitHub environment
``aria-board``, whose deployment branch policy admits ``main`` alone
(board/SETUP.md). The workflow side of that boundary is pinned here, for every
job that declares ``environment: aria-board`` (a "Board job").

The guard is an ALLOW-LIST (B0 corrective round 3, R3-1): it lists what a
Board job may be, and refuses anything it does not list. The steps of one job
share the VM, the user and the runner's GITHUB_ENV and GITHUB_PATH files, so a
step that holds no key still decides what the key step runs; a list of
forbidden shapes always misses one. A Board job:

* carries the job keys ``name``, ``if``, ``runs-on``, ``timeout-minutes``,
  ``environment``, ``permissions``, ``concurrency`` and ``steps`` alone (no
  ``container:``, ``services:`` or ``env:``), and its workflow declares no
  ``env:``;
* holds steps of four shapes alone, each with only the step keys it lists:
  (a) ``actions/checkout`` at a full commit SHA; (b) ``actions/setup-python``
  at a full commit SHA, given a ``python-version`` alone; (c) exactly
  ``python3 -I -m pip install --require-hashes --only-binary ':all:' --no-deps
  -r .github/board/<name>-requirements.txt`` (without ``-I``, ``-m pip``
  imports a ``pip/`` package from the checkout), with no env, shell or working
  directory; (d) the key step: exactly ``python3 -I
  aria-kernel/aria_kernel/examination_board.py <command>`` (the kernel FILE,
  by path, isolated, so the ARIA-changeable ``aria_kernel`` package never
  loads), with the default shell and working directory and an env of Board
  secrets alone. ``examination_board`` itself imports the standard library and
  ``cryptography`` alone.

Over that shape, the rules that judge its values:

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
* it writes nothing: the workflow declares ``permissions``, and neither it nor
  the job grants a ``write`` scope, each value read by its one owner
  (``workflow_contract_registry.declared_token_permissions``) (B0 has no
  writer; B2 adds the one named signed-totals writer under this guard);
* it traces no shell — a ``defaults.run.shell`` of the workflow traces nothing
  — since a trace echoes case content into the log;
* a Board secret reaches two places only (B0 corrective round 2, R2-1): the
  key step's env entry named for it, and the vault checkout's ``ssh-key`` (the
  deploy key alone). Which Board secrets an expression reaches has one reader,
  ``board_secrets_reached`` (round 3, R3-2): its literal name, or every Board
  secret for any dynamic access (``secrets[...]``, ``toJSON(secrets)``). It
  reads the workflow's env and every position of the job, and the
  secrets-stay check below; and the workflow's ``defaults.run`` sets no shell
  or working directory for the key step;
* the workflow that holds it runs no pull-request code (no ``pull_request``,
  ``pull_request_target`` or ``merge_group`` trigger);
* no workflow-level ``env`` reaches a Board secret, and no job other than a
  Board job names one or the ``aria-board`` environment.

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
from aria_kernel.workflow_contract_registry import declared_token_permissions
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
# R3-1: the allow-list. A Board job carries these keys alone; its steps are
# the shapes of _step_shape alone.
_BOARD_JOB_KEYS = frozenset({"name", "if", "runs-on", "timeout-minutes", "environment", "permissions",
                             "concurrency", "steps"})
_PINNED_CHECKOUT = re.compile(r"actions/checkout@[0-9a-f]{40}")
_PINNED_SETUP_PYTHON = re.compile(r"actions/setup-python@[0-9a-f]{40}")
_CHECKOUT_INPUTS = frozenset({"repository", "ref", "path", "fetch-depth", "persist-credentials", "ssh-key"})
_BOARD_INSTALL = re.compile(r"python3 -I -m pip install --require-hashes --only-binary ':all:' --no-deps"
                            r" -r \.github/board/[a-z0-9][a-z0-9-]*-requirements\.txt")
_PR_TRIGGERS = ("pull_request", "pull_request_target", "merge_group")
# `set -x`, `set -euxo pipefail`, `bash -ex script`, and any spelling of xtrace
# (`set -o xtrace`, `SHELLOPTS=xtrace`). The first guard required a word
# boundary after the `x`, so `set -euxo pipefail` passed it.
_SHELL_TRACE = re.compile(r"(^|[\s;&|(])(?:set|bash|sh)\s+-[A-Za-z]*x|xtrace", re.MULTILINE)
_GIT_PUSH = re.compile(r"\bgit\b[^\n;&|]*\spush\b")
_KERNEL_PATH = "aria-kernel/aria_kernel/"
_BOARD_ENTRY = re.compile(r"^python3 -I aria-kernel/aria_kernel/examination_board\.py [a-z-]+$")
# Every pip the Board runs is `python3 -I -m pip`: without -I, `-m pip` imports
# a `pip/` package from the checkout (the working directory), which could
# plant a sitecustomize the key-holding step then loads.
_PIP = re.compile(r"\bpip3?\b")
_ISOLATED_PIP = re.compile(r"(?:^|[\s;&|(])python3 -I -m pip install\b")
# A Board secret, as an expression names it (property names are case-insensitive).
_BOARD_SECRET = re.compile(r"\bsecrets\s*\.\s*(ARIA_BOARD_[A-Za-z0-9_]*)", re.IGNORECASE)
# The secrets context reached other than by a literal name: `secrets[...]`,
# `toJSON(secrets)`, a bare `secrets` — any of them can hand over a Board secret.
_DYNAMIC_SECRETS = re.compile(r"\bsecrets\b(?!\s*\.\s*[A-Za-z_])", re.IGNORECASE)
_EXPRESSION = re.compile(r"\$\{\{(.*?)\}\}", re.DOTALL)
VAULT_DEPLOY_KEY = "ARIA_BOARD_VAULT_DEPLOY_KEY"
# The aria-board environment's secrets (board/SETUP.md, 2026-10-21).
BOARD_SECRETS = frozenset({"ARIA_BOARD_SIGNING_KEY", VAULT_DEPLOY_KEY, VAULT_DATA_KEY_ENV})
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


def _grant_violations(where: str, declared: Any) -> list[str]:
    """A declared ``permissions:`` value, read by its one owner: a value GitHub accepts, granting no write."""
    granted = declared_token_permissions(declared)
    if granted is None:
        return [f"{where} permissions {declared!r} are not a grant GitHub accepts"]
    return [f"{where} permissions grant {scope}: write" for scope, level in granted.items() if level == "write"]


def _write_violations(workflow: dict[str, Any], job: dict[str, Any]) -> list[str]:
    # The workflow declares its grant (undeclared is the repository default,
    # which this guard cannot see) and no Board job widens it.
    violations = (_grant_violations("workflow", workflow["permissions"]) if "permissions" in workflow
                  else ["workflow declares no permissions"])
    if "permissions" in job:
        violations += _grant_violations("job", job["permissions"])
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
        if "PYTHONPATH" in run or "PYTHONPATH" in (step.get("env") or {}):
            violations.append(f"step sets PYTHONPATH: {label}")
        if re.search(r"-m\s+aria_kernel", run):
            violations.append(f"step runs the aria_kernel package: {label}")
        if (_KERNEL_PATH in run or "aria_kernel" in run) and not _BOARD_ENTRY.fullmatch(run.strip()):
            violations.append(f"step runs kernel code other than examination_board.py in isolation: {label}")
        if "pip install" in run and "--require-hashes" not in run:
            violations.append(f"step installs without --require-hashes: {label}")
        if _PIP.search(run) and not _ISOLATED_PIP.search(run):
            violations.append(f"step runs pip other than as python3 -I -m pip: {label}")
    return violations


def _expressions(value: Any, path: tuple[Any, ...] = ()) -> list[tuple[tuple[Any, ...], str]]:
    """Every expression in ``value``, with where it sits: each ``${{ }}`` body, and every ``if:`` whole."""
    if isinstance(value, dict):
        return [found for key, item in value.items() for found in _expressions(item, (*path, key))]
    if isinstance(value, list):
        return [found for index, item in enumerate(value) for found in _expressions(item, (*path, index))]
    if not isinstance(value, str):
        return []
    found = [(path, body) for body in _EXPRESSION.findall(value)]
    return [(path, value), *found] if path and path[-1] == "if" else found


def _is_key_step(step: dict[str, Any]) -> bool:
    """The one kind of step a Board key may reach as env: examination_board.py, isolated, as written."""
    return ("uses" not in step and "shell" not in step and "working-directory" not in step
            and _BOARD_ENTRY.fullmatch(str(step.get("run") or "").strip()) is not None)


def _is_vault_checkout(step: dict[str, Any]) -> bool:
    return (str(step.get("uses") or "").startswith("actions/checkout@")
            and (step.get("with") or {}).get("repository") == VAULT_REPOSITORY)


def board_secrets_reached(expression: str) -> frozenset[str]:
    """The Board secrets ``expression`` (one ``${{ }}`` body, or an ``if:``) reaches: THE one reader of that question.

    B0 corrective round 3, R3-2. A literal ``secrets.<name>`` reaches that
    name (property names are case-insensitive, so it is upper-cased); any
    other access to the secrets context — ``secrets['...']``,
    ``toJSON(secrets)``, a bare ``secrets`` — can hand over any of them, so it
    reaches every Board secret.
    """
    if _DYNAMIC_SECRETS.search(expression):
        return BOARD_SECRETS
    return frozenset(name.upper() for name in _BOARD_SECRET.findall(expression))


def _secret_allowed_at(job: dict[str, Any], path: tuple[Any, ...]) -> frozenset[str]:
    """The one Board secret a position of ``job`` may carry, or none.

    Two positions only: an env entry of the key step, which carries the
    secret it is named for, and the vault checkout's ``ssh-key``, which
    carries the deploy key.
    """
    steps = job.get("steps") or []
    if len(path) < 3 or path[0] != "steps" or not isinstance(path[1], int) or not isinstance(steps[path[1]], dict):
        return frozenset()
    step = steps[path[1]]
    if len(path) == 4 and path[2] == "env" and _is_key_step(step) and path[3] in BOARD_SECRETS:
        return frozenset({path[3]})
    if path[2:] == ("with", "ssh-key") and _is_vault_checkout(step):
        return frozenset({VAULT_DEPLOY_KEY})
    return frozenset()


def _secret_violations(workflow: dict[str, Any], job: dict[str, Any]) -> list[str]:
    """A Board secret reaches the key step's env, as the secret its entry is named for, or the vault checkout's ssh-key.

    B0 corrective rounds 2 and 3 (R2-1, R3-2; §1.9: ARIA's self-change can
    neither read nor write the Board's key). Every expression of the
    workflow's env and of the job, wherever it sits, is read by
    :func:`board_secrets_reached`; whatever it reaches beyond what its
    position may carry (:func:`_secret_allowed_at`) hands a Board secret to a
    process ARIA's code can change, and is refused. A key step keeps the
    default shell and working directory (a ``shell:`` runs its own command
    line with the key in its env; a ``working-directory:`` changes which file
    the entry runs).
    """
    violations: list[str] = []
    if any(_shell_or_directory(holder) for holder in (workflow, job)):
        violations.append("defaults.run sets a shell or working directory for the key step")
    found = [(("env", *path), body, frozenset()) for path, body in _expressions(workflow.get("env") or {})]
    found += [(path, body, _secret_allowed_at(job, path)) for path, body in _expressions(job)]
    for path, body, allowed in found:
        beyond = board_secrets_reached(body) - allowed
        if beyond:
            violations.append(f"{', '.join(sorted(beyond))} reached at {'/'.join(map(str, path))}")
    return violations


def _step_shape(step: dict[str, Any]) -> str | None:
    """Which permitted Board step ``step`` is, or None: the allow-list every Board step must match whole.

    (a) ``checkout`` — ``actions/checkout`` at a full commit SHA (the checkout
    rule judges what it fetches); (b) ``setup-python`` — ``actions/setup-python``
    at a full commit SHA, given a Python version alone (no cache, no pip
    install of its own); (c) ``install`` — exactly the hash-pinned
    ``python3 -I -m pip install`` of one ``.github/board/<name>-requirements.txt``,
    with no env, shell or working directory; (d) ``key`` — the isolated
    ``examination_board.py`` step (:func:`_is_key_step`) whose env holds Board
    secrets alone. Each shape lists the step keys it may carry; any other key
    makes the step none of them.
    """
    keys, options = set(step), step.get("with") or {}
    uses = str(step.get("uses") or "")
    if _PINNED_CHECKOUT.fullmatch(uses) and keys <= {"name", "uses", "with"} and set(options) <= _CHECKOUT_INPUTS:
        return "checkout"
    if _PINNED_SETUP_PYTHON.fullmatch(uses) and keys <= {"name", "uses", "with"} and set(options) <= {"python-version"}:
        return "setup-python"
    if keys <= {"name", "run"} and _BOARD_INSTALL.fullmatch(str(step.get("run") or "").strip()):
        return "install"
    if keys <= {"name", "run", "env"} and _is_key_step(step) and set(step.get("env") or {}) <= BOARD_SECRETS:
        return "key"
    return None


def _shape_violations(workflow: dict[str, Any], job: dict[str, Any]) -> list[str]:
    """B0 corrective round 3, R3-1: a Board job is a permitted shape, whole; anything not listed is refused.

    The steps of one job share the VM, the user and the runner's GITHUB_ENV
    and GITHUB_PATH files, so a step that holds no key still decides what the
    key step runs (its PATH, BASH_ENV, site-packages). The guard therefore
    lists what a Board job may be, never what it may not: its keys are
    :data:`_BOARD_JOB_KEYS` (no ``container:``, ``services:`` or ``env:``),
    its workflow declares no ``env:``, and every step is one shape of
    :func:`_step_shape`.
    """
    violations = ["workflow declares env"] if "env" in workflow else []
    violations += [f"job key {key!r} is not a permitted Board-job key" for key in job if key not in _BOARD_JOB_KEYS]
    violations += [f"step {index} is no permitted Board step: {step.get('name') or step.get('uses') or step.get('run')}"
                   for index, step in enumerate(job.get("steps") or [])
                   if not isinstance(step, dict) or _step_shape(step) is None]
    return violations


def _shell_or_directory(holder: dict[str, Any]) -> bool:
    defaults = holder.get("defaults") or {}
    run = (defaults.get("run") or {}) if isinstance(defaults, dict) else {}
    return bool(run.get("shell") or run.get("working-directory"))


def _trigger_violations(workflow: dict[str, Any]) -> list[str]:
    triggers = workflow.get(True, workflow.get("on")) or {}
    names = [triggers] if isinstance(triggers, str) else list(triggers)
    return [f"pull-request trigger {name}" for name in names if name in _PR_TRIGGERS]


_RULES: dict[str, Callable[[dict[str, Any], dict[str, Any]], list[str]]] = {
    "steps": _shape_violations,
    "condition": lambda workflow, job: _condition_violations(job),
    "runner": lambda workflow, job: _runner_violations(job),
    "checkout": lambda workflow, job: _checkout_violations(job),
    "writes": _write_violations,
    "leaks": _leak_violations,
    "kernel": _kernel_violations,
    "secrets": _secret_violations,
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


_DATA_KEY = "${{ secrets.ARIA_BOARD_VAULT_DATA_KEY }}"
_SIGNING_KEY = "${{ secrets.ARIA_BOARD_SIGNING_KEY }}"
_DEPLOY_KEY = "${{ secrets.ARIA_BOARD_VAULT_DEPLOY_KEY }}"


def _key_to_job_env_with_a_local_action(workflow: dict[str, Any]) -> None:
    job = _custody_job(workflow)
    job["env"] = job["steps"][-1].pop("env")
    job["steps"].insert(-1, {"uses": "./.github/actions/restore-aria-state", "with": {"bootstrap-ack": ""}})


def _step_at(index: int, **fields: Any) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        _steps(_custody_job(workflow))[index].update(fields)
    return mutate


def _before_key(step: dict[str, Any]) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        _custody_job(workflow)["steps"].insert(-1, step)
    return mutate


def _key_env(**env: str) -> Callable[[dict[str, Any]], None]:
    def mutate(workflow: dict[str, Any]) -> None:
        _steps(_custody_job(workflow))[-1]["env"].update(env)
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
    # B0 corrective round 2, R2-1: a Board secret reaches no process but the
    # isolated examination_board.py step and the vault checkout. The first
    # three are the arch lens's P4, the rest the security lens's P3 and the
    # ways around the key step's fullmatch.
    "key_in_job_env_with_a_local_action": _key_to_job_env_with_a_local_action,
    "key_step_runs_another_repo_script": _custody_step(run="python3 -I tools/aria-acceptance/acceptance.py"),
    "second_key_step_runs_node": _add_step({"name": "sign", "env": {"ARIA_BOARD_SIGNING_KEY": _SIGNING_KEY},
                                            "run": "npx tsx tools/aria-board/sign.ts"}),
    "job_env_holds_the_key": lambda w: _custody_job(w).update({"env": {"ARIA_BOARD_VAULT_DATA_KEY": _DATA_KEY}}),
    "workflow_env_holds_the_key": _set(("env",), {"ARIA_BOARD_VAULT_DATA_KEY": _DATA_KEY}),
    "pip_step_env_holds_the_key": _step_at(2, env={"ARIA_BOARD_VAULT_DATA_KEY": _DATA_KEY}),
    "run_inlines_the_key": _add_step({"name": "dbg", "run": f"echo {_DATA_KEY} | base64 -d | xxd"}),
    "third_party_action_gets_the_key": _add_step({"uses": "someone/action@v1", "with": {"k": _DATA_KEY}}),
    "local_composite_action": _add_step({"uses": "./.github/actions/anything"}),
    "key_step_through_a_custom_shell": _custody_step(shell="python3 -c 'import os; print(os.environ)' {0}"),
    "key_step_in_another_directory": _custody_step(**{"working-directory": "vault"}),
    "every_secret_as_json": _add_step({"name": "dump", "run": "echo '${{ toJSON(secrets) }}' > /dev/null"}),
    "a_secret_by_index": _add_step({"name": "idx", "run": "echo ${{ secrets['ARIA_BOARD_SIGNING_KEY'] }}"}),
    "deploy_key_to_this_repository_checkout": _checkout_with(**{"ssh-key": _DEPLOY_KEY}),
    "deploy_key_to_an_action": _add_step({"uses": "someone/ssh-agent@v1", "with": {"ssh-private-key": _DEPLOY_KEY}}),
    "data_key_as_the_vault_ssh_key": _add_step({
        "uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "with": {"repository": VAULT_REPOSITORY, "path": "vault", "persist-credentials": False,
                 "ssh-key": _DATA_KEY}}),
    # Security non-blocking 1 (P4): `python3 -m pip` imports a `pip/` package
    # from the checkout, which can plant a sitecustomize the key step loads.
    "pip_from_the_checkout": _step_at(2, run="python3 -m pip install --require-hashes --only-binary ':all:' "
                                              "--no-deps -r .github/board/cipher-requirements.txt"),
    # B0 corrective round 3, R3-1 (arch P2, evidence p07/p08/p14, ssot P03):
    # the steps of one job share the VM, the user and the runner's GITHUB_ENV
    # and GITHUB_PATH files, so a step that holds no key still decides what
    # the key step runs. Each passed the round-3 guard, which listed forbidden
    # shapes; only an allow-list of permitted ones refuses them all.
    "step_runs_repository_python": _before_key({"name": "prep", "run": "python3 tools/aria-board/prepare.py"}),
    "step_runs_repository_node": _before_key({"name": "prep", "run": "node tools/aria-acceptance/prepare.mjs"}),
    "step_prepends_a_checkout_directory_to_path": _before_key(
        {"name": "path", "run": 'echo "$GITHUB_WORKSPACE/tools/aria-board/bin" >> "$GITHUB_PATH"'}),
    "step_sets_bash_env_for_later_steps": _before_key(
        {"name": "env", "run": 'echo "BASH_ENV=$GITHUB_WORKSPACE/tools/aria-board/env.sh" >> "$GITHUB_ENV"'}),
    "step_plants_a_sitecustomize": _before_key(
        {"run": "printf 'import os\\n' > \"$(python3 -c 'import site;print(site.getsitepackages()[0])')"
                "/sitecustomize.py\""}),
    "key_step_env_sets_bash_env": _key_env(BASH_ENV="tools/aria-board/env.sh"),
    "key_step_env_sets_ld_preload": _key_env(LD_PRELOAD="tools/aria-board/hook.so"),
    "unpinned_third_party_action": _before_key({"uses": "someone/unpinned-action@v1"}),
    "this_repository_action_by_owner_repo_path_at_sha": _before_key(
        {"uses": f"{_THIS_REPOSITORY[1]}/.github/actions/setup-aria-kernel@0123456789abcdef0123456789abcdef01234567"}),
    "checkout_by_a_movable_tag": _step_at(0, uses="actions/checkout@v4"),
    "setup_python_by_a_movable_tag": _step_at(1, uses="actions/setup-python@v6"),
    "setup_python_saves_a_cache": _step_at(1, **{"with": {"python-version": "3.12", "cache": "pip"}}),
    "checkout_fetches_submodules": _checkout_with(submodules="recursive"),
    "install_step_reads_another_index": _step_at(2, env={"PIP_INDEX_URL": "https://example.invalid/simple"}),
    "install_step_installs_another_file": _step_at(
        2, run="python3 -I -m pip install --require-hashes --only-binary ':all:' --no-deps -r tools/req.txt"),
    "job_runs_in_a_container": lambda w: _custody_job(w).update({"container": "python:3.12"}),
    "job_starts_a_service": lambda w: _custody_job(w).update({"services": {"db": {"image": "postgres:16"}}}),
    "job_env_without_a_secret": lambda w: _custody_job(w).update({"env": {"BASH_ENV": "tools/aria-board/env.sh"}}),
    "workflow_env_without_a_secret": _set(("env",), {"LD_PRELOAD": "tools/aria-board/hook.so"}),
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

    def test_a_bare_workflow_permissions_grants_nothing_and_passes(self) -> None:
        # B0 corrective round 2, R2-6: a bare ``permissions:`` is an empty
        # grant (declared_token_permissions), not an undeclared one.
        mutated = copy.deepcopy(self.workflow)
        mutated["permissions"] = None
        self.assertEqual(board_violations(mutated), {})

    def test_undeclared_workflow_permissions_are_refused(self) -> None:
        # Undeclared means the repository default, which this guard cannot see.
        mutated = copy.deepcopy(self.workflow)
        del mutated["permissions"]
        self.assertTrue(board_violations(mutated))

    def test_the_vault_repository_by_name_is_a_board_checkout(self) -> None:
        mutated = copy.deepcopy(self.workflow)
        _add_step({"uses": "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                   "with": {"repository": VAULT_REPOSITORY, "path": "vault", "persist-credentials": False,
                            "ssh-key": _DEPLOY_KEY}})(mutated)
        self.assertEqual(board_violations(mutated), {})


class PermissionsHaveOneReaderTests(unittest.TestCase):
    """B0 corrective round 2, R2-6: the guard judges ``permissions:`` through its owner, never its own reading."""

    def test_the_guard_reads_permissions_only_through_declared_token_permissions(self) -> None:
        source = Path(__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        imported = {alias.name for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
                    and node.module == "aria_kernel.workflow_contract_registry" for alias in node.names}
        self.assertIn("declared_token_permissions", imported)
        defined = {node.name for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        self.assertNotIn("_read_only", defined)
        keyword = '"read' + '-all"'
        self.assertNotIn(keyword, source, "a second reading of the read-all keyword")


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


def board_secret_leaks(workflows: dict[str, dict[str, Any]]) -> list[str]:
    """Each workflow env that reaches a Board secret, and each other job that names one or the Board environment."""
    leaks: list[str] = []
    for name, workflow in workflows.items():
        if any(board_secrets_reached(body) for _path, body in _expressions(workflow.get("env") or {})):
            leaks.append(f"{name}:env")
        for job_id, job in (workflow.get("jobs") or {}).items():
            if not isinstance(job, dict) or _environment(job) == BOARD_ENVIRONMENT:
                continue
            text = yaml.safe_dump(job)
            if "ARIA_BOARD_" in text or BOARD_ENVIRONMENT in text:
                leaks.append(f"{name}/{job_id}")
    return leaks


class BoardSecretsStayInBoardJobsTests(unittest.TestCase):
    def test_no_other_job_or_workflow_env_names_a_board_secret_or_the_board_environment(self) -> None:
        self.assertEqual(board_secret_leaks(_workflows()), [])


# B0 corrective round 3, R3-2 (ssot B0-R3-SSOT-1, P03): the guard read
# "which Board secrets an expression reaches" in pieces — workflow and job env
# by literal name only, the dynamic scan skipping job env, the secrets-stay
# check by an "ARIA_BOARD_" substring — so dynamic access in an env passed.
_ENV_REACHES_THE_SECRETS: dict[str, Callable[[dict[str, Any]], None]] = {
    "job_env_toJSON_secrets": lambda w: _custody_job(w).update({"env": {"ALL": "${{ toJSON(secrets) }}"}}),
    "workflow_env_toJSON_secrets": _set(("env",), {"ALL": "${{ toJSON(secrets) }}"}),
    "job_env_secrets_by_index": lambda w: _custody_job(w).update(
        {"env": {"K": "${{ secrets['ARIA_BOARD_VAULT_DATA_KEY'] }}"}}),
}


class BoardSecretsHaveOneReaderTests(unittest.TestCase):
    """B0 corrective round 3, R3-2: one reader decides which Board secrets an expression reaches, everywhere."""

    def setUp(self) -> None:
        self.workflow = _workflows()[_BOARD_WORKFLOW]

    def test_the_secrets_rule_refuses_an_env_that_reaches_the_secrets_dynamically(self) -> None:
        for name, mutate in _ENV_REACHES_THE_SECRETS.items():
            with self.subTest(mutation=name):
                mutated = copy.deepcopy(self.workflow)
                mutate(mutated)
                self.assertTrue(_RULES["secrets"](mutated, _custody_job(mutated)), f"{name} passed the secrets rule")

    def test_a_workflow_env_that_reaches_the_secrets_is_a_leak(self) -> None:
        mutated = copy.deepcopy(self.workflow)
        _ENV_REACHES_THE_SECRETS["workflow_env_toJSON_secrets"](mutated)
        self.assertIn(f"{_BOARD_WORKFLOW}:env", board_secret_leaks({_BOARD_WORKFLOW: mutated}))

    def test_only_board_secrets_reached_reads_the_secrets_context(self) -> None:
        tree = ast.parse(Path(__file__).read_text(encoding="utf-8"))
        readers = sorted({function.name for function in ast.walk(tree) if isinstance(function, ast.FunctionDef)
                          for node in ast.walk(function)
                          if isinstance(node, ast.Name) and node.id in ("_BOARD_SECRET", "_DYNAMIC_SECRETS")})
        self.assertEqual(readers, ["board_secrets_reached"])


if __name__ == "__main__":
    unittest.main()
