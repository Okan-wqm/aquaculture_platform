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

What this module does not see by itself: reads made at run time by the
programs the steps start (Python file reads, the bodies of inline heredoc
programs), and whole-checkout reads (a `.` argument such as
`--workspace-root .`), whose inputs are every tracked file rather than a
surface. ARIA-HIGH-602 closes both: `scripts/ci/aria_read_trace.py` traces
every read the skippable jobs' Python makes and fails them on a tracked read
outside the surface (pinned below), and the whole-checkout checks live in the
always-run `workspace` job (pinned above). What still is not seen, named:
node reads (`npm ci`, jest, ts-node) and interpreters started with `-I`/`-s`,
which never load the user site the hook rides on.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any, Iterable, Iterator

import yaml

from aria_kernel import report_ingestion
from tests._helpers.kernel_lane import KERNEL_SURFACE_MANIFEST, kernel_lane_surface, kernel_surface_entries
from tests._helpers.witness_sources import tool_closure_paths, witness_tool_paths

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_WORKFLOW = ".github/workflows/aria-kernel.yml"
_TRACER = _REPO_ROOT / "scripts/ci/aria_read_trace.py"
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


# The data the registry CLI reads on every kernel call beside its code: the row
# contract a derived row is held to and the alias sidecar a trailer's name
# resolves through. No import names them, so they are listed here; each must
# still be named by the CLI's own sources (pinned below), so the list cannot
# outlive the read.
_REGISTRY_CLI_DATA = (
    "docs/reviews/_registry/findings.jsonl.schema.json",
    "docs/reviews/_registry/finding-id-aliases.yaml",
)


def _registry_cli_paths() -> tuple[str, ...]:
    return (*tool_closure_paths(report_ingestion._REGISTRY_CLI), report_ingestion._GATES_TSCONFIG)


class KernelToolInputsTest(unittest.TestCase):
    def test_the_plan_coverage_witness_and_its_imports_are_on_the_surface(self) -> None:
        # The kernel runs the witness (aria_kernel/plan_coverage.py) and the
        # suite copies its import closure into fixture repos; a change to any
        # of those files must run the suite on its PR.
        self.assertEqual(uncovered(witness_tool_paths(), kernel_lane_surface()), [])

    def test_the_registry_cli_its_imports_and_its_data_are_on_the_surface(self) -> None:
        # The kernel's only registry reader is the registry CLI, run by
        # report_ingestion.run_registry_cli (read_registry_view, the autonomy
        # closure verifier). Its twelve modules were off the surface: a PR that
        # changed only the projection's output skipped the kernel suite, passed
        # the required check and turned main red on the push run (MF-1 R6).
        self.assertEqual(uncovered([*_registry_cli_paths(), *_REGISTRY_CLI_DATA], kernel_lane_surface()), [])

    def test_every_listed_registry_cli_data_file_is_named_by_the_cli(self) -> None:
        sources = "".join(
            (_REPO_ROOT / path).read_text(encoding="utf-8") for path in _registry_cli_paths() if path.endswith(".ts")
        )
        self.assertEqual([path for path in _REGISTRY_CLI_DATA if path not in sources], [])


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


def _run_lines(job: dict[str, Any]) -> list[str]:
    """Every stripped `run:` script line of ``job``, heredoc bodies included."""

    lines: list[str] = []
    for step in job.get("steps", []):
        run = step.get("run")
        if isinstance(run, str):
            lines.extend(line.strip() for line in run.splitlines() if line.strip())
    return lines


class WorkspaceJobTest(unittest.TestCase):
    """ARIA-HIGH-602 — whole-checkout reads leave the jobs the surface decision may skip.

    The `changes` job runs `suite`, `lane` and `state` only when a PR touches
    the kernel surface. Some checks in those jobs read the WHOLE checkout: the
    tools/aria-poc drift bound walks the repository, `discovery run
    --workspace-root .` and the acceptance harness read product code, and the
    suite's live partition runs the real adapter over apps/farm-service/src.
    A PR that changed only what such a check read skipped it and passed the
    required check. Those checks live in `workspace`, which has no `needs` and
    no `if` — it runs on every PR, whatever the surface decision said.
    """

    def setUp(self) -> None:
        self.workflow = _load_yaml(_KERNEL_WORKFLOW)

    def test_the_workspace_job_runs_on_every_pr(self) -> None:
        job = self.workflow["jobs"].get("workspace")
        self.assertIsNotNone(job, "aria-kernel.yml has no `workspace` job")
        assert job is not None
        self.assertNotIn("needs", job, "the workspace job must not wait on the surface decision")
        self.assertNotIn("if", job, "the workspace job must run on every PR")
        # The image the discovery sandbox needs (see `suite`), and a hang guard.
        self.assertEqual(job["runs-on"], "ubuntu-22.04")
        # A hang guard above the measured ~17 min run (aria-kernel.yml's
        # comment): the live partition is 29 modules.
        self.assertLessEqual(int(job["timeout-minutes"]), 30)

    def test_the_whole_checkout_checks_live_only_in_workspace(self) -> None:
        workspace = _run_lines(self.workflow["jobs"].get("workspace") or {})
        gated = {name: _run_lines(job) for name, job in gated_jobs(self.workflow).items()}
        # (label, needle, exact-line?) for every whole-checkout check. The
        # acceptance harness is exact-line so the self-test script
        # (`test:aria-acceptance:unit`, a tools/aria-acceptance-only read that
        # the surface covers) does not match it.
        checks = (
            ("the suite's live partition", "aria-suite-run.sh --live", False),
            ("the tools/aria-poc invariant tests", "unittest discover tools/aria-poc/invariants", False),
            ("the acceptance harness", "npm run test:aria-acceptance", True),
            ("the tools bootstrap over the workspace", "integrity migrate-tools-bootstrap", False),
            ("the discovery run", "discovery run --workspace-root .", False),
            ("the integrity verify over the workspace", "integrity verify --workspace-root .", False),
        )
        for label, needle, exact in checks:
            present = any(line == needle if exact else needle in line for line in workspace)
            self.assertTrue(present, f"the workspace job does not run {label} (`{needle}`)")
            holders = [
                name for name, lines in gated.items()
                if any(line == needle if exact else needle in line for line in lines)
            ]
            self.assertEqual(holders, [], f"{label} sits in a job the surface decision may skip: {holders}")

    def test_a_gated_job_reads_the_whole_checkout_only_through_verify_registry(self) -> None:
        # `workflow verify-registry --workspace-root .` reads workflow files,
        # which the surface covers (.github/**); it is traced like any other
        # read. Any other `--workspace-root .` in a gated job is a whole-checkout
        # read a PR off the surface skips.
        for name, job in gated_jobs(self.workflow).items():
            for step in job.get("steps", []):
                run = step.get("run")
                if isinstance(run, str) and "--workspace-root ." in run:
                    self.assertEqual(
                        step.get("name"), "Verify workflow registry (whole inventory)",
                        f"aria-kernel.yml job `{name}` step `{step.get('name')}` reads the whole "
                        "checkout in a job the surface decision may skip; it belongs in `workspace`",
                    )

    def test_the_verdict_requires_workspace_success_whatever_the_surface_said(self) -> None:
        verdict = self.workflow["jobs"]["aria-kernel"]
        self.assertIn("workspace", verdict.get("needs") or [], "the verdict does not need `workspace`")
        require = next(
            step for step in verdict["steps"] if step.get("name") == "Require every kernel job"
        )
        self.assertIn("WORKSPACE_RESULT", require.get("env") or {})
        self.assertIn('test "${WORKSPACE_RESULT}" = success', require["run"])

    def test_the_required_check_contract_names_the_workspace_job(self) -> None:
        manifest = json.loads(
            (_REPO_ROOT / ".github/manifests/main-required-status-checks.json").read_text(encoding="utf-8")
        )
        contracts = [
            context
            for contract in manifest["workflow_contracts"]
            if contract["workflow"] == _KERNEL_WORKFLOW
            for context in contract["contexts"]
        ]
        self.assertTrue(contracts, f"main-required-status-checks.json has no contract for {_KERNEL_WORKFLOW}")
        for context in contracts:
            self.assertIn(
                "workspace", context["requires_jobs"],
                f"the {context['context']} contract's requires_jobs does not name `workspace`",
            )


class ReadTracerTest(unittest.TestCase):
    """S3 (ARIA-HIGH-602) — a tracked read outside the kernel surface fails the PR that adds it.

    The tracer is driven end to end, the way the workflow drives it: `install`
    writes the audit hook's usercustomize into a temp user site, a child
    interpreter (which loads that site the moment it exists) does the reading,
    and `verify` — run isolated, `python3 -I`, so it does not trace itself —
    computes tracked reads minus the manifest's coverage. Nothing of the
    process under test is mocked.
    """

    _SURFACE = {
        "schema_version": 1,
        "surface": [
            {"glob": "aria-kernel/**", "readers": "the kernel and its suite"},
            {"glob": ".github/**", "readers": "workflow definitions"},
        ],
    }

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-read-trace-")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.repo = self.tmp / "repo"
        (self.repo / "aria-kernel" / "tests").mkdir(parents=True)
        (self.repo / "apps").mkdir(parents=True)
        (self.repo / ".github" / "manifests").mkdir(parents=True)
        (self.repo / "aria-kernel" / "tests" / "test_x.py").write_text("import unittest\n", encoding="utf-8")
        (self.repo / "apps" / "x.ts").write_text("export {}\n", encoding="utf-8")
        self.manifest = self.repo / ".github" / "manifests" / "aria-kernel-surface.json"
        self.manifest.write_text(json.dumps(self._SURFACE, indent=2) + "\n", encoding="utf-8")
        git = {
            **{key: value for key, value in os.environ.items() if not key.startswith(("GIT_", "PYTEST"))},
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "tracer",
            "GIT_AUTHOR_EMAIL": "tracer@example.invalid",
            "GIT_COMMITTER_NAME": "tracer",
            "GIT_COMMITTER_EMAIL": "tracer@example.invalid",
        }
        for args in (("init", "--quiet", "--initial-branch", "main"), ("add", "-A"),
                     ("commit", "--quiet", "-m", "fixture")):
            subprocess.run(["git", *args], cwd=self.repo, env=git, check=True, capture_output=True)
        self.trace = self.tmp / "trace"
        # PYTHONUSERBASE points the interpreter's user site at the fixture, so
        # install writes there and every child interpreter loads the hook.
        self.env = {
            **git,
            "PYTHONUSERBASE": str(self.tmp / "userbase"),
            "GITHUB_WORKSPACE": str(self.repo),
            "ARIA_READ_TRACE_DIR": str(self.trace),
        }

    def _install(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(_TRACER), "install", "--trace-dir", str(self.trace)],
            env=self.env, capture_output=True, text=True, timeout=120, check=False,
        )

    def _child(self, code: str, *interpreter_args: str) -> subprocess.CompletedProcess[str]:
        script = self.tmp / "child.py"
        script.write_text(code, encoding="utf-8")
        return subprocess.run(
            [sys.executable, *interpreter_args, str(script)],
            env=self.env, cwd=self.repo, capture_output=True, text=True, timeout=120, check=False,
        )

    def _verify(self) -> subprocess.CompletedProcess[str]:
        env = {key: value for key, value in os.environ.items()
               if not key.startswith(("GIT_", "PYTEST", "PYTHON", "ARIA_READ"))}
        env["GIT_CONFIG_GLOBAL"] = "/dev/null"
        env["GIT_CONFIG_NOSYSTEM"] = "1"
        return subprocess.run(
            [sys.executable, "-I", str(_TRACER), "verify",
             "--trace-dir", str(self.trace), "--manifest", str(self.manifest)],
            cwd=self.repo, env=env, capture_output=True, text=True, timeout=120, check=False,
        )

    def test_a_traced_read_outside_the_surface_fails_the_verify(self) -> None:
        self.assertEqual(self._install().returncode, 0)
        child = self._child("open('apps/x.ts').read()\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertNotEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("apps/x.ts", verify.stdout + verify.stderr)

    def test_a_traced_read_under_the_kernel_surface_passes(self) -> None:
        self.assertEqual(self._install().returncode, 0)
        child = self._child("open('aria-kernel/tests/test_x.py').read()\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)

    def test_an_untracked_read_does_not_gate(self) -> None:
        (self.repo / "untracked.txt").write_text("local scratch\n", encoding="utf-8")
        self.assertEqual(self._install().returncode, 0)
        child = self._child("open('untracked.txt').read()\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(self._verify().returncode, 0)

    def test_a_git_show_read_is_traced_like_a_file_read(self) -> None:
        self.assertEqual(self._install().returncode, 0)
        child = self._child(
            "import subprocess, sys\n"
            "raise SystemExit(subprocess.run(['git', 'show', 'HEAD:apps/x.ts'],\n"
            "                                capture_output=True).returncode)\n",
        )
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertNotEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("apps/x.ts", verify.stdout + verify.stderr)

    def test_a_git_run_in_another_directory_names_that_directory_s_files(self) -> None:
        # A suite test that runs `git show HEAD:apps/x.ts` with cwd= a temp
        # fixture repo reads the FIXTURE, not the live checkout. The reader
        # resolved the token against the calling process's cwd and blamed the
        # live checkout's apps/x.ts (run 39753472319: dozens of such phantom
        # reads, e.g. apps/farm-service/src/main.ts).
        fixture = self.tmp / "fixture-repo"
        subprocess.run(["git", "clone", "--quiet", str(self.repo), str(fixture)], env=self.env,
                       check=True, capture_output=True)
        self.assertEqual(self._install().returncode, 0)
        child = self._child(
            "import subprocess, sys\n"
            f"raise SystemExit(subprocess.run(['git', 'show', 'HEAD:apps/x.ts'], cwd={str(fixture)!r},\n"
            "                                capture_output=True).returncode)\n",
        )
        self.assertEqual(child.returncode, 0, child.stderr)
        child = self._child(
            "import subprocess, sys\n"
            f"raise SystemExit(subprocess.run(['git', '-C', {str(fixture)!r}, 'show', 'HEAD:apps/x.ts'],\n"
            "                                capture_output=True).returncode)\n",
        )
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)

    def test_a_directory_listing_is_reported_but_does_not_gate(self) -> None:
        self.assertEqual(self._install().returncode, 0)
        child = self._child("import os\nos.listdir('apps')\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("apps", verify.stdout, "the listing is reported, not silent")

    def test_a_corrupt_trace_line_fails_the_verify(self) -> None:
        self.assertEqual(self._install().returncode, 0)
        child = self._child("open('aria-kernel/tests/test_x.py').read()\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        trace_files = sorted(self.trace.glob("trace-*.tsv"))
        self.assertTrue(trace_files, "the child wrote no trace")
        trace_files[0].write_text("not a trace line\n", encoding="utf-8")
        verify = self._verify()
        self.assertNotEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("not a trace line", verify.stdout + verify.stderr)

    def test_a_git_argument_carrying_a_line_break_keeps_the_trace_well_formed(self) -> None:
        # Run 39744490984 (shards 4, 6, 9, 10): a `git commit -m` body naming a
        # `Closes:` path was recorded as a path, its line breaks split the
        # trace line, and verify refused the whole trace as corrupt — so the
        # off-surface reads of four shards were never even listed.
        self.assertEqual(self._install().returncode, 0)
        child = self._child(
            "import subprocess\n"
            "raise SystemExit(subprocess.run(['git', 'log', '-1', '--grep',\n"
            "    'subject\\n\\nCloses: docs/reviews/x.md#X-1\\tend'], capture_output=True).returncode)\n",
        )
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertNotIn("corrupt", verify.stdout + verify.stderr)

    def test_a_tracked_name_carrying_the_escape_character_is_named_as_written(self) -> None:
        # The trace escapes the line breaks a name can carry; a name that
        # already holds the escape character must come back unchanged.
        odd = self.repo / "apps" / "a%0Ab.ts"
        odd.write_text("export {}\n", encoding="utf-8")
        subprocess.run(["git", "add", "-A"], cwd=self.repo, env=self.env, check=True, capture_output=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "odd name"], cwd=self.repo, env=self.env,
                       check=True, capture_output=True)
        self.assertEqual(self._install().returncode, 0)
        child = self._child("open('apps/a%0Ab.ts').read()\n")
        self.assertEqual(child.returncode, 0, child.stderr)
        verify = self._verify()
        self.assertNotEqual(verify.returncode, 0, verify.stdout + verify.stderr)
        self.assertIn("  apps/a%0Ab.ts\n", verify.stderr)

    def test_the_hook_loads_no_module_the_traced_program_did_not(self) -> None:
        # Run 39744490984 (shard 9): the hook module imported subprocess,
        # argparse and pathlib at interpreter startup, so the genesis adapter
        # launcher — which refuses the import of any module not already loaded
        # — found subprocess preloaded and seven bypass spellings ran. An
        # observer that changes sys.modules changes the program it observes.
        probe = "import sys\nprint('\\n'.join(sorted(sys.modules)))\n"
        bare = self._child(probe)
        self.assertEqual(bare.returncode, 0, bare.stderr)
        self.assertEqual(self._install().returncode, 0)
        traced = self._child(probe)
        self.assertEqual(traced.returncode, 0, traced.stderr)
        added = set(traced.stdout.split()) - set(bare.stdout.split())
        self.assertEqual(added, {"usercustomize", "aria_read_trace_hook"})

    def test_isolated_python_is_not_traced(self) -> None:
        # `python3 -I` never loads the user site, so the hook cannot ride on
        # it: the named residual of the user-site install choice.
        self.assertEqual(self._install().returncode, 0)
        child = self._child("open('apps/x.ts').read()\n", "-I")
        self.assertEqual(child.returncode, 0, child.stderr)
        self.assertEqual(self._verify().returncode, 0, "an -I read must not reach the trace")

    def test_install_refuses_a_foreign_usercustomize(self) -> None:
        # The user site is the fixture's (PYTHONUSERBASE), not this test
        # process's: ask the same interpreter install uses.
        probe = subprocess.run(
            [sys.executable, "-c", "import site; print(site.getusersitepackages())"],
            env=self.env, capture_output=True, text=True, timeout=60, check=True,
        )
        user_site = Path(probe.stdout.strip())
        user_site.mkdir(parents=True, exist_ok=True)
        (user_site / "usercustomize.py").write_text("# someone else's hook\n", encoding="utf-8")
        self.assertNotEqual(self._install().returncode, 0)


class TracerWiringTest(unittest.TestCase):
    """S3 wiring — the skippable jobs trace their reads; the workspace job does not."""

    def setUp(self) -> None:
        self.workflow = _load_yaml(_KERNEL_WORKFLOW)

    def _install_step(self, job: dict[str, Any]) -> dict[str, Any]:
        steps = job.get("steps", [])
        setup = [index for index, step in enumerate(steps)
                 if step.get("uses") == "./.github/actions/setup-aria-kernel"]
        self.assertEqual(len(setup), 1)
        self.assertLess(setup[0] + 1, len(steps))
        return steps[setup[0] + 1]

    def test_the_skippable_jobs_install_the_tracer_right_after_setup(self) -> None:
        for name in ("suite", "lane", "state"):
            with self.subTest(job=name):
                step = self._install_step(self.workflow["jobs"][name])
                self.assertEqual(step.get("name"), "Install the kernel read tracer")
                run = step.get("run", "")
                self.assertIn("scripts/ci/aria_read_trace.py install", run)
                self.assertIn("RUNNER_TEMP", run)

    def test_the_skippable_jobs_verify_their_reads_last(self) -> None:
        for name in ("suite", "lane", "state"):
            with self.subTest(job=name):
                steps = self.workflow["jobs"][name]["steps"]
                verify = steps[-1]
                self.assertEqual(verify.get("name"), "Verify every tracked read is on the kernel surface")
                self.assertEqual(verify.get("if"), "${{ !cancelled() }}")
                self.assertIn("python3 -I scripts/ci/aria_read_trace.py verify", verify.get("run", ""))

    def test_the_workspace_job_carries_neither_tracer_step(self) -> None:
        # Its inputs are the whole checkout by declaration, and it runs on
        # every PR: a tracer there would only ever fail on its own rule.
        names = [step.get("name") for step in self.workflow["jobs"]["workspace"].get("steps", [])]
        self.assertNotIn("Install the kernel read tracer", names)
        self.assertNotIn("Verify every tracked read is on the kernel surface", names)

    def test_the_tracer_is_on_the_kernel_surface(self) -> None:
        # A PR that changes the tracer is a PR the traced lane must run on.
        self.assertEqual(uncovered(["scripts/ci/aria_read_trace.py"], kernel_lane_surface()), [])


if __name__ == "__main__":
    unittest.main()
