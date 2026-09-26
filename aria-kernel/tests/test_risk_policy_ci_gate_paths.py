"""ARIA-CRITICAL-215 — nothing a required check executes is in the unreviewed lane.

L1 is the lane ARIA merges without a reviewer. Pre-fix it was a broad
pattern list (``**/*.spec.ts``, ``**/test_*.py``, ``tests/**``) and held the
repository's own CI gate suites and contract inputs: 69 files under
``e2e/tests`` (``nats-invariants.spec.ts``, ``schema-invariants.spec.ts``),
``tools/lint-gates``, ``tools/shared/invariants``, the OpenAPI contracts. An
unreviewed ARIA merge could weaken the gate that judges it.

The invariant is derived, not listed: every file the required workflows
(``ci-affected.yml`` and the ``aria-*`` lanes) name on a ``run:`` line — a
path, a directory handed to a runner, a glob — plus every file a named test
target or script those lines invoke runs (``--target test:integration``,
``npm run test:water-chemistry``, ``nx run migration-harness:test``: their
project.json / package.json definitions and their jest ``testMatch``), plus
every ``docs/`` file a gate suite reads by literal path. A new invocation of a
file the policy admits to L1 turns this test red until the policy excludes it.

The whole-repository unit target (``--target test`` over affected projects)
is not a named gate: the unit-test trees it runs are L1 by operator decision
(plan 037), and those trees are what L1 admits.
"""
from __future__ import annotations

import json
import re
import subprocess
import unittest
from functools import lru_cache
from pathlib import Path, PurePosixPath

import yaml

from aria_kernel.canonical_path import matches_repo_glob
from aria_kernel.change_paths import CHANGE_STATUSES
from aria_kernel.risk_policy import classify_path

REPO = Path(__file__).resolve().parents[2]

# The review's sample of CI-gate paths (docs/reviews/claude/2026-09-26-aria-merge-lane-review.md,
# ARIA-CRITICAL-215). Globs resolve against the tracked tree and must match.
REVIEW_GATE_SAMPLES = (
    "e2e/tests/integration/nats-invariants.spec.ts",
    "e2e/tests/integration/schema-invariants.spec.ts",
    "tools/lint-gates/*",
    "tools/shared/invariants/test_*.py",
    "docs/api/openapi/farm-service.yaml",
)

# The suites that ARE gates: their literal `docs/...` reads are expected values.
GATE_SUITE_GLOBS = (
    "tests/invariants/**",
    "tools/gates/**",
    "tools/lint-gates/**",
    "tools/shared/invariants/**",
    "e2e/tests/integration/**",
    "scripts/ci/**",
)

_PATH_TOKEN = re.compile(r"[A-Za-z0-9_.*?{}\[\]@<>-]+(?:/[A-Za-z0-9_.*?{},\[\]@<>-]*)+")
# A named gate target is colon-qualified (`test:integration`, `run
# test:water-chemistry`); the bare `test`/`lint`/`build` targets are the
# whole-repository passes the module docstring sets aside.
_NAMED_TARGET = re.compile(r"(?:--target[ =]|\brun\s+|-t\s+)([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)")
_PROJECT_TARGET = re.compile(r"\bnx\s+run\s+([A-Za-z0-9_@/-]+):([A-Za-z0-9_:-]+)")
# A `grep -E '<pattern>'` argument is a path FILTER deciding whether a step
# runs, and an argument of these flags names an install/output root; neither
# is a file the step executes.
_GREP_PATTERN = re.compile(r"""\bgrep\s+(?:-[A-Za-z]+\s+)*(['"])(?:(?!\1).)*\1""")
_NOT_AN_INVOCATION = frozenset({"--prefix", "--cache", "--artifact-dir", "-p", ">", ">>"})
_TEST_MATCH = re.compile(r"testMatch\s*:\s*\[(.*?)\]", re.S)
_QUOTED = re.compile(r"""['"]([^'"]+)['"]""")
_DOCS_LITERAL = re.compile(r"""(?<![\w/.-])['"`](docs/[A-Za-z0-9_./-]+)['"`]""")


def _ever_l1(path: str) -> bool:
    """L1 under ANY git status. L1 membership depends on the change's
    status (a new test is L1, a modified one is not), so a gate path must be
    non-L1 whatever the change does to it, added included."""
    return any(classify_path(path, status=status) == "L1" for status in sorted(CHANGE_STATUSES))


@lru_cache(maxsize=1)
def _tracked() -> tuple[str, ...]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO, check=True, capture_output=True, text=True,
    ).stdout
    return tuple(path for path in out.split("\0") if path)


def _gate_workflows() -> list[str]:
    return [".github/workflows/ci-affected.yml"] + sorted(
        path for path in _tracked()
        if re.fullmatch(r"\.github/workflows/aria-[^/]+\.ya?ml", path)
    )


def _run_blocks(workflow: str) -> list[str]:
    runs: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "run" and isinstance(value, str):
                    runs.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(yaml.safe_load((REPO / workflow).read_text(encoding="utf-8")))
    return runs


def _resolve(token: str, *, relative_to: str = "") -> set[str]:
    """The tracked files a path-shaped token names: a file, a directory's
    contents, or a glob's matches, relative to ``relative_to`` then to the
    repository root."""
    token = token.strip("'\"`,;()")
    if not token or "$" in token or token.startswith(("/", "http", "-")) or "://" in token:
        return set()
    token = token.replace("<rootDir>/", "")
    candidates = [str(PurePosixPath(relative_to) / token)] if relative_to else []
    candidates.append(token)
    found: set[str] = set()
    for candidate in candidates:
        candidate = candidate.removeprefix("./")
        if any(char in candidate for char in "*?[{"):
            found.update(path for path in _tracked() if matches_repo_glob(path, candidate))
            continue
        if candidate in _tracked():
            found.add(candidate)
            continue
        prefix = candidate.rstrip("/") + "/"
        found.update(path for path in _tracked() if path.startswith(prefix))
    return found


@lru_cache(maxsize=1)
def _definitions() -> tuple[tuple[str, str, str, str], ...]:
    """``(owner_dir, project_name, target_name, definition_text)`` for every
    tracked project.json target and package.json script."""
    rows: list[tuple[str, str, str, str]] = []
    for path in _tracked():
        name = PurePosixPath(path).name
        if name not in ("project.json", "package.json") or "node_modules/" in path:
            continue
        owner = str(PurePosixPath(path).parent)
        owner = "" if owner == "." else owner
        try:
            payload = json.loads((REPO / path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        project = str(payload.get("name") or "")
        if name == "project.json":
            for target, spec in (payload.get("targets") or {}).items():
                rows.append((owner, project, target, json.dumps(spec)))
        else:
            for script, command in (payload.get("scripts") or {}).items():
                if isinstance(command, str):
                    rows.append((owner, project, script, command))
    return tuple(rows)


def _jest_test_match(config: str) -> set[str]:
    text = (REPO / config).read_text(encoding="utf-8")
    root = str(PurePosixPath(config).parent)
    found: set[str] = set()
    for block in _TEST_MATCH.findall(text):
        for pattern in _QUOTED.findall(block):
            found |= _resolve(pattern.replace("<rootDir>/", ""), relative_to=root)
    return found


def _definition_files(owner: str, text: str) -> set[str]:
    found: set[str] = set()
    for token in _PATH_TOKEN.findall(text):
        resolved = _resolve(token, relative_to=owner)
        for path in resolved:
            if re.search(r"jest[^/]*\.config\.[cm]?[jt]s$", path):
                found |= _jest_test_match(path)
        found |= resolved
    return found


def _invocation_tokens(run: str) -> list[str]:
    text = _GREP_PATTERN.sub(" ", run)
    tokens: list[str] = []
    for match in _PATH_TOKEN.finditer(text):
        before = text[: match.start()].split()
        if before and before[-1] in _NOT_AN_INVOCATION:
            continue
        tokens.append(match.group(0))
    return tokens


def _named_invocations(run: str) -> set[str]:
    found: set[str] = set()
    for target in _NAMED_TARGET.findall(run):
        for owner, _project, name, text in _definitions():
            if name == target:
                found |= _definition_files(owner, text)
    for project, target in _PROJECT_TARGET.findall(run):
        for owner, name_of_project, name, text in _definitions():
            if name_of_project == project and name == target:
                found |= _definition_files(owner, text)
    return found


@lru_cache(maxsize=1)
def ci_invoked_paths() -> dict[str, frozenset[str]]:
    """Workflow -> every tracked file its ``run:`` lines invoke."""
    invoked: dict[str, frozenset[str]] = {}
    for workflow in _gate_workflows():
        files: set[str] = set()
        for run in _run_blocks(workflow):
            for token in _invocation_tokens(run):
                files |= _resolve(token)
            files |= _named_invocations(run)
        invoked[workflow] = frozenset(files)
    return invoked


@lru_cache(maxsize=1)
def gate_read_docs() -> frozenset[str]:
    """Every tracked ``docs/`` file a gate suite names as a literal path."""
    tracked = set(_tracked())
    suites = [path for path in _tracked() if any(matches_repo_glob(path, glob) for glob in GATE_SUITE_GLOBS)]
    found: set[str] = set()
    for suite in suites:
        try:
            text = (REPO / suite).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        found.update(literal for literal in _DOCS_LITERAL.findall(text) if literal in tracked)
    return frozenset(found)


class CiGatePathsAreNeverL1Tests(unittest.TestCase):
    def test_the_derivation_sees_the_gates_it_must(self) -> None:
        # A derivation that found nothing would pass vacuously; pin that it
        # reaches every indirection kind it claims to.
        invoked = set().union(*ci_invoked_paths().values())
        for expected in (
            # a path on a run line
            "apps/sensor-service/src/edge-device/__tests__/agent-io-config-v2.spec.ts",
            # a directory handed to a runner
            "tools/shared/invariants/__init__.py",
            # `--target test:integration` -> project.json -> jest testMatch
            "apps/farm-service/src/batch/__tests__/integration/batch-lifecycle.integration.spec.ts",
            # `--target test:contract` -> project.json command
            "apps/admin-api-service/src/__tests__/contract-validation.spec.ts",
            # `npm --workspace ... run test:water-chemistry` -> package.json script
            "web/modules/farm-module/src/pages/water-chemistry/WaterChemistryPage.spec.ts",
            # `nx run migration-harness:test` -> project target -> jest testMatch
            "libs/migration-harness/src/__tests__/add-missing-columns.integration.spec.ts",
        ):
            with self.subTest(path=expected):
                if expected not in _tracked():
                    self.fail(f"fixture path moved: {expected}")
                self.assertIn(expected, invoked)
        self.assertIn("docs/architecture/farm-enterprise-ssot.md", gate_read_docs())

    def test_no_file_a_required_workflow_invokes_is_l1(self) -> None:
        offenders = {
            path: workflow
            for workflow, files in ci_invoked_paths().items()
            for path in files
            if _ever_l1(path)
        }
        self.assertEqual(offenders, {}, "exclude these from L1 in docs/aria/policy/risk-policy.json")

    def test_no_docs_file_a_gate_suite_reads_is_l1(self) -> None:
        offenders = sorted(path for path in gate_read_docs() if _ever_l1(path))
        self.assertEqual(offenders, [], "exclude these from L1 in docs/aria/policy/risk-policy.json")

    def test_the_reviews_gate_samples_are_not_l1(self) -> None:
        for sample in REVIEW_GATE_SAMPLES:
            resolved = _resolve(sample)
            with self.subTest(sample=sample):
                self.assertTrue(resolved, f"{sample} resolves to no tracked file")
                self.assertEqual(sorted(path for path in resolved if _ever_l1(path)), [])


if __name__ == "__main__":
    unittest.main()
