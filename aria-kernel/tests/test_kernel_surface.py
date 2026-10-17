"""The required `aria-kernel` check runs its jobs on every PR that changes their inputs (ARIA-HIGH-530).

`aria-kernel` is a required context and runs on every pull request; its
`changes` job runs `suite`, `lane` and `state` only when the PR touches the
kernel surface, and the verdict accepts their being skipped otherwise. The
surface was a hand list inside aria-kernel.yml (plus a second, different one in
the pre-push selector). It left out inputs those jobs read: the agent prompts
the pedagogy lint and the specialist review read, tools/aria-acceptance, the
composite actions the jobs `uses:`, package.json and its lock. A PR changing
only those passed the required check without running it.

The surface now has one owner, `.github/manifests/aria-kernel-surface.json`,
and this module holds it to what the gated jobs read at the workflow layer:

  * every local action a gated job `uses:` (and every local action those
    composites use, recursively) is on the surface;
  * `npm ci` puts package.json, package-lock.json and .npmrc on it;
  * `npm run S` puts package.json on it, and every path `scripts[S]` names,
    recursively through nested `npm run`;
  * every other shell token of a `run:` that names a tracked file or directory
    is on it.

git decides coverage, exactly as the `changes` job does: the paths go into a
throwaway index and `git ls-files` applies the manifest's `:(glob)`
pathspecs. No second glob matcher exists to drift from git's.

What this module does not see, by construction: reads made at run time by the
programs the steps start (Python and node file reads, the bodies of inline
heredoc programs), and whole-checkout reads (a `.` argument such as
`--workspace-root .`), whose inputs are every tracked file rather than a
surface. Those are a runtime-tracing and a live-checkout question, named in the
ARIA-HIGH-530 commit as not done here.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Iterable, Iterator

import yaml

from tests._helpers.kernel_lane import KERNEL_SURFACE_MANIFEST, kernel_lane_surface, kernel_surface_entries

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_WORKFLOW = ".github/workflows/aria-kernel.yml"
_GATED_IF = "needs.changes.outputs.kernel == 'true'"
_NPM_CI_INPUTS = ("package.json", "package-lock.json", ".npmrc")
# Import roots, not reads: the modules they make importable are read through
# the paths that name them (aria-kernel/** for the kernel).
_IMPORT_ROOT_VARS = ("PYTHONPATH",)
_HEREDOC = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1")
_EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"

# A step a gated job runs whose inputs another required context checks on
# every PR. Each entry is proven below, never trusted: the context is required
# on main, its workflow's pull_request trigger is unfiltered, and one of its
# steps runs exactly this command.
COVERED_ELSEWHERE: dict[str, tuple[str, str]] = {
    # The spec reads docs, plans and agents across the tree; aria-merge-authority
    # runs it on every PR (ARIA live runtime/documentation SSoT).
    "npm run aria:docs:ssot": ("aria-merge-authority", ".github/workflows/aria-merge-authority.yml"),
}


def _load_yaml(relative: str) -> dict[str, Any]:
    loaded = yaml.safe_load((_REPO_ROOT / relative).read_text(encoding="utf-8"))
    assert isinstance(loaded, dict), f"{relative} is not a mapping"
    return loaded


def _on_block(workflow: dict[str, Any]) -> dict[str, Any]:
    # PyYAML reads the bare key `on` as the boolean True.
    on = workflow["on"] if "on" in workflow else workflow[True]
    assert isinstance(on, dict)
    return on


def _git(*args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        ["git", *args], cwd=_REPO_ROOT, env=env, check=True, capture_output=True, text=True
    ).stdout


def _tracked() -> list[str]:
    return [path for path in _git("ls-files", "-z").split("\0") if path]


def uncovered(paths: Iterable[str], surface: list[str]) -> list[str]:
    """The paths no surface glob matches, matched by git with `:(glob)` pathspecs."""
    wanted = sorted(set(paths))
    if not wanted:
        return []
    with tempfile.TemporaryDirectory(prefix="aria-kernel-surface-") as scratch:
        env = {**os.environ, "GIT_INDEX_FILE": str(Path(scratch) / "index")}
        index_info = "".join(f"100644 {_EMPTY_BLOB}\t{path}\n" for path in wanted)
        subprocess.run(
            ["git", "update-index", "--index-info"],
            cwd=_REPO_ROOT, env=env, input=index_info, check=True, capture_output=True, text=True,
        )
        covered = set(_git("ls-files", "--", *(f":(glob){glob}" for glob in surface), env=env).splitlines())
    return [path for path in wanted if path not in covered]


def _strip_heredoc_bodies(script: str) -> str:
    """Keep the shell, drop inline programs: a heredoc body is read by its interpreter at run time."""
    kept: list[str] = []
    lines = script.split("\n")
    index = 0
    while index < len(lines):
        kept.append(lines[index])
        match = _HEREDOC.search(lines[index])
        if match:
            index += 1
            while index < len(lines) and lines[index].strip() != match.group(2):
                index += 1
        index += 1
    return "\n".join(kept)


def shell_tokens(script: str) -> list[str]:
    lexer = shlex.shlex(_strip_heredoc_bodies(script), posix=True, punctuation_chars=True)
    lexer.whitespace_split = True
    return list(lexer)


def _commands(tokens: list[str]) -> Iterator[list[str]]:
    """Split a token stream into simple commands at shell operators."""
    current: list[str] = []
    for token in tokens:
        if token and set(token) <= set(";&|()<>"):
            if current:
                yield current
            current = []
        else:
            current.append(token)
    if current:
        yield current


class _Inputs:
    """What the gated jobs read at the workflow layer, with where each read came from."""

    def __init__(self, tracked: list[str]) -> None:
        self.tracked = set(tracked)
        self.tracked_dirs: dict[str, list[str]] = {}
        for path in tracked:
            parts = path.split("/")
            for depth in range(1, len(parts)):
                self.tracked_dirs.setdefault("/".join(parts[:depth]), []).append(path)
        self.reads: dict[str, set[str]] = {}
        self.package_scripts: dict[str, str] = json.loads(
            (_REPO_ROOT / "package.json").read_text(encoding="utf-8")
        )["scripts"]
        self.covered_elsewhere_used: set[str] = set()

    def need(self, path: str, why: str) -> None:
        self.reads.setdefault(path, set()).add(why)

    def path_token(self, token: str, why: str) -> None:
        candidate = token
        if candidate.startswith("--") and "=" in candidate:
            candidate = candidate.split("=", 1)[1]
        name, sep, value = candidate.partition("=")
        if sep and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            if name in _IMPORT_ROOT_VARS:
                return
            candidate = value
        if not candidate or "$" in candidate or candidate.startswith("/") or any(ch.isspace() for ch in candidate):
            return
        while candidate.startswith("./"):
            candidate = candidate[2:]
        candidate = candidate.rstrip("/")
        if candidate in ("", "."):
            return  # a whole-checkout read: not a surface question (see the module docstring)
        if candidate in self.tracked:
            self.need(candidate, why)
        elif candidate in self.tracked_dirs:
            for path in self.tracked_dirs[candidate]:
                self.need(path, why)

    def run_script(self, script: str, why: str) -> None:
        for command in _commands(shell_tokens(script)):
            self.command(command, why)

    def command(self, command: list[str], why: str) -> None:
        words = [word for word in command if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", word)]
        if words[:2] == ["npm", "ci"]:
            for path in _NPM_CI_INPUTS:
                self.need(path, f"{why}: npm ci")
        if words[:2] == ["npm", "run"] and len(words) >= 3:
            line = f"npm run {words[2]}"
            if line in COVERED_ELSEWHERE:
                self.covered_elsewhere_used.add(line)
                return
            self.need("package.json", f"{why}: {line}")
            script = self.package_scripts.get(words[2])
            assert script is not None, f"{why}: `{line}` names no package.json script"
            self.run_script(script, f"{why}: {line}")
            return
        for token in command:
            self.path_token(token, why)

    def action(self, uses: str, why: str) -> None:
        directory = uses[2:].rstrip("/")
        for name in ("action.yml", "action.yaml"):
            if f"{directory}/{name}" in self.tracked:
                manifest = f"{directory}/{name}"
                break
        else:
            raise AssertionError(f"{why}: `uses: {uses}` has no tracked action.yml")
        self.need(manifest, why)
        for step in _load_yaml(manifest).get("runs", {}).get("steps", []) or []:
            self.step(step, f"{why} > {uses}")

    def step(self, step: dict[str, Any], why: str) -> None:
        uses = step.get("uses")
        if isinstance(uses, str) and uses.startswith("./"):
            self.action(uses, f"{why}: uses {uses}")
        run = step.get("run")
        if isinstance(run, str):
            self.run_script(run, f"{why}: {step.get('name') or run.splitlines()[0][:60]}")


def gated_jobs(workflow: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        name: job for name, job in workflow["jobs"].items()
        if str(job.get("if", "")).strip() == _GATED_IF
    }


def workflow_inputs(workflow: dict[str, Any]) -> _Inputs:
    inputs = _Inputs(_tracked())
    for name, job in gated_jobs(workflow).items():
        for step in job.get("steps", []):
            inputs.step(step, f"{_KERNEL_WORKFLOW} job `{name}`")
    return inputs


class KernelSurfaceManifestTest(unittest.TestCase):
    def test_every_entry_is_a_unique_glob_that_names_its_reader(self) -> None:
        entries = kernel_surface_entries()
        self.assertTrue(entries, f"{KERNEL_SURFACE_MANIFEST} declares no surface")
        globs = [entry["glob"] for entry in entries]
        self.assertEqual(len(globs), len(set(globs)), f"{KERNEL_SURFACE_MANIFEST}: duplicate globs")
        for entry in entries:
            self.assertEqual(set(entry), {"glob", "readers"}, entry)
            self.assertTrue(entry["glob"].strip(), entry)
            self.assertFalse(entry["glob"].startswith(("/", "./", ":")), entry)
            self.assertTrue(entry["readers"].strip(), f"{entry['glob']}: no reader named")

    def test_the_surface_covers_its_own_deciders(self) -> None:
        # Editing the manifest, the workflow that reads it or the helper that
        # reads it is itself a kernel change. (The pre-push selector's place on
        # the surface is pinned by tests/invariants/aria-doc-runtime-ssot.spec.ts,
        # which drives it; naming it here would make the selector's import graph
        # run this module on every selector change.)
        self.assertEqual(
            uncovered(
                [KERNEL_SURFACE_MANIFEST, _KERNEL_WORKFLOW, "aria-kernel/tests/_helpers/kernel_lane.py"],
                kernel_lane_surface(),
            ),
            [],
        )


class KernelWorkflowInputsTest(unittest.TestCase):
    def setUp(self) -> None:
        self.workflow = _load_yaml(_KERNEL_WORKFLOW)

    def test_the_gated_jobs_are_the_kernel_jobs(self) -> None:
        # The check below walks the jobs the surface decision can skip; if the
        # gate expression changes shape, it must not silently walk none.
        self.assertEqual(sorted(gated_jobs(self.workflow)), ["lane", "state", "suite"])

    def test_every_workflow_level_input_of_a_gated_job_is_on_the_surface(self) -> None:
        inputs = workflow_inputs(self.workflow)
        missing = uncovered(inputs.reads, kernel_lane_surface())
        by_reader: dict[str, list[str]] = {}
        for path in missing:
            by_reader.setdefault(sorted(inputs.reads[path])[0], []).append(path)
        report = "\n".join(
            f"  {reader}:\n    " + ", ".join(paths[:5]) + (f" (+{len(paths) - 5} more)" if len(paths) > 5 else "")
            for reader, paths in sorted(by_reader.items())
        )
        self.assertEqual(
            missing, [],
            f"a gated aria-kernel job reads these, but a PR changing only them skips the job "
            f"and passes the required check; add a glob naming the reader to "
            f"{KERNEL_SURFACE_MANIFEST}:\n{report}",
        )

    def test_the_check_sees_the_inputs_the_hand_list_missed(self) -> None:
        # The detector itself: on today's YAML it must find the inputs whose
        # absence from the old hand list was ARIA-HIGH-530, or it proves nothing.
        reads = workflow_inputs(self.workflow).reads
        for expected in (
            ".github/actions/setup-aria-kernel/action.yml",
            ".github/actions/ensure-sandbox-backend/action.yml",
            ".github/actions/restore-aria-state/action.yml",
            ".claude/agents/aria-implementer.md",
            "tests/invariants/agent-pedagogy.allowlist.json",
            "tools/aria-acceptance/harness.py",
            "package.json",
            "package-lock.json",
            ".npmrc",
        ):
            self.assertIn(expected, reads)

    def test_a_step_covered_elsewhere_runs_on_every_pr_in_a_required_context(self) -> None:
        required = json.loads(
            (_REPO_ROOT / ".github/manifests/main-required-status-checks.json").read_text(encoding="utf-8")
        )["required_status_checks"]["contexts"]
        used = workflow_inputs(self.workflow).covered_elsewhere_used
        self.assertEqual(used, set(COVERED_ELSEWHERE), "an exemption no gated step uses is dead")
        for command, (context, workflow_path) in COVERED_ELSEWHERE.items():
            self.assertIn(context, required, f"{command}: {context} is not a required context")
            other = _load_yaml(workflow_path)
            self.assertIn("pull_request", _on_block(other))
            trigger = _on_block(other)["pull_request"] or {}
            self.assertNotIn("paths", trigger, f"{workflow_path}: a filtered trigger skips PRs")
            self.assertNotIn("paths-ignore", trigger, f"{workflow_path}: a filtered trigger skips PRs")
            # The context is the job that reports it (job id, no `name:` override).
            job = other["jobs"].get(context)
            self.assertIsNotNone(job, f"{workflow_path} has no job `{context}`")
            self.assertNotIn("name", job, f"{workflow_path}: job `{context}` reports under another name")
            self.assertNotIn("if", job, f"{workflow_path}: job `{context}` can be skipped")
            runs = [
                line.strip()
                for step in job.get("steps", []) if isinstance(step.get("run"), str)
                for line in step["run"].splitlines()
            ]
            self.assertIn(command, runs, f"{workflow_path} job `{context}` does not run `{command}`")


if __name__ == "__main__":
    unittest.main()
