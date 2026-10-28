#!/usr/bin/env python3
"""F1.3 slice a — `harness.py baseline-exam`: the stamped, offline baseline exam.

The section test (2026-10-20) said "0/13 located; 29 of 643 named noise, 614 not".
Those numbers were written by driver scripts that are no longer in the tree, at a
system nobody pinned, on a corpus nobody hashed. The exam re-derives what a kept
store can still prove, with no model, and stamps every number with the triple that
makes it comparable (ARIA SHA, corpus hash, provider/model). It computes NO recall:
that belongs to `role_fitness` (ARIA-HIGH-758).

What is pinned here, and which API is new
-----------------------------------------
Everything the tests call is new API: `measurement_stamp`, `stamps_match`,
`baseline_exam`, the `baseline-exam` subcommand and
`tools/aria-acceptance/corpora/bolum-v1.json` do not exist at the branch base, so
the tests that use them are red there because the name or the file is missing. The
first assertion of each says so (`_api`), so the failure names the gap instead of an
AttributeError; a CLI test fails on the exit code the missing subcommand gives. The
one exception is `FixtureRowsAreRealRows`: it checks the fixtures against the real
rows, not the defect, and is green at the base by design. The refusal names
(`baseline_exam_*`) come from the specification; the exception is the kernel's own
`GovernanceError`.

Choices the specification leaves open, made here and listed for the implementer:

* `baseline_exam(corpus=...)` takes the PATH of a manifest file, as every other
  parameter mirrors its CLI flag (`--corpus`); the loader is the harness's own.
* The manifest and the report carry `"$schema"` (the kernel's convention for
  `aria/<name>/v1` documents); `named_noise` entries are
  `{tool_id, rule, path?, reason}`; `contamination` is a list of strings.
* A malformed SHA in a manifest is refused as `baseline_exam_sha_malformed` too: the
  one SHA validator serves the stamp and the corpus.

Fixtures are real: a throwaway git repo (13 planted commits, the last of them the
corpus head, a commit after it and a side commit that is not an ancestor) and one
store written by the kernel's own writers (`register_tool` + `record_run`, ledger
format v2-shadow; one cycle for the numbers and one per refusal), whose rows are
proven to carry the fields of the 17 real rows of the kept store
(`FixtureRowsAreRealRows`). Every fixture git call runs with the GIT_* environment
removed: a hook-run test must never reach the checkout it was started from.
"""
from __future__ import annotations

import ast
import base64
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections.abc import Callable
from pathlib import Path
from typing import Any
from unittest import mock

_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[1]
_HARNESS_PATH = _HERE / "harness.py"
_COMMITTED_MANIFEST = _HERE / "corpora" / "bolum-v1.json"
_FAKE_RUNNER = _REPO_ROOT / "aria-kernel" / "tests" / "_helpers" / "fake_tool_runner.py"


def _load_harness() -> Any:
    spec = importlib.util.spec_from_file_location("aria_acceptance_harness_baseline_exam", _HARNESS_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


harness = _load_harness()  # puts aria-kernel on sys.path

from aria_kernel import judge_calibration  # noqa: E402
from aria_kernel.digest import sha256_digest_file  # noqa: E402
from aria_kernel.ledger import sha256_digest_of_canonical_json  # noqa: E402
from aria_kernel.model_fleet import provider_for_model  # noqa: E402
from aria_kernel.tool_health import record_run  # noqa: E402
from aria_kernel.tool_registry import GovernanceError, register_tool  # noqa: E402

# ── what the real store looks like (the 17 rows of the kept store, cycle goldset-battery-1) ──
REAL_RUN_ROW_KEYS = frozenset({
    "artifact_error", "artifact_hash", "artifact_ref", "artifact_refs", "artifact_status", "cost_units",
    "cycle_id", "duration_ms", "emitted_counts", "evidence_validation", "input_hash", "ledger_hash",
    "memory_candidates", "operator_feedback_refs", "output_hash", "previous_ledger_hash", "read_paths_ref",
    "recorded_at", "repo_snapshot", "run_id", "run_ledger_format", "runner", "schema_version", "status",
    "timeout_ms", "tool_id",
})
REAL_RUNNER_KEYS = frozenset({
    "exit_code", "genesis_adapter_sha256", "parse_error", "raw_findings_count", "raw_findings_sample",
    "raw_observations_count", "sandbox_backend", "scope_out_mutations", "scoped_mutations",
    "spawn_environment", "stderr_hash", "stderr_sample", "timed_out", "type",
})
REAL_ARTIFACT_REF_KEYS = frozenset({
    "artifact_id", "content_type", "produced_by_workflow_run_id", "schema_version", "sha256",
    "source_surface", "uri",
})
REAL_ENVELOPE_KEYS = frozenset({
    "canonical_ref", "content_hash", "envelope_hash", "exists", "glob_match_count", "is_glob", "line",
    "self_output_class", "source_hint", "target_sha", "trust_grade", "validation_errors",
})
REAL_EVIDENCE_VALIDATION_SHAPES = {
    "full": frozenset({"checked_sources", "errors", "evidence_envelopes", "evidence_sources",
                       "repository_mutation_attempt", "self_output_evidence", "valid"}),
    "spilled": frozenset({"errors", "evidence_sources", "evidence_sources_spilled",
                          "repository_mutation_attempt", "spilled_bulk", "valid"}),
    "crash": frozenset({"evidence_sources", "repository_mutation_attempt"}),
}
REAL_REPO_SNAPSHOT_KEYS = frozenset({
    "dirty_snapshot", "file_counts", "legacy_tracked_file_count", "repo_state_id", "schema_version",
    "snapshot_hash", "snapshot_mode", "tool_scope_allowed_count", "tool_scope_path_count",
    "tracked_file_count",
})

# ── the corpus the exit run reads (specification, item 1) ──
REAL_HEAD = "f2c0175d88239312d3254ac853e340d2fabf8749"
REAL_REVERTS = (
    "f2c0175d88239312d3254ac853e340d2fabf8749", "a2bc04e9f27c8b12540278702f923f7d62d01759",
    "8ed21c71ffe1bfe84efc56e0558ca1dde1682510", "32a7a39bd071218cd8ce734b208acf27901b904d",
    "6ca50d2c2eb32883502f0a28b8af3aa8cc5ad0b3", "24b588669be5c5a383d61b43ff946bec52d041d7",
    "d1fbd44f6d5f35263569100635f3ac6d3d49d7eb", "0ad7a74f5c15b329d107fe7de2f3bd525f1e4b97",
    "1336e0e4afe119bfc0ee44d5b28f5e54249cd162", "cf0980693293c690f6115206f8699cb65766f973",
    "99aa377b65a41be6c6bfa122b10dddd185cd956f", "f8d3a00caf5e9d19536c2cde3dca0006a9fd47e6",
    "526cbba55a731299987a9f2c674edff938c72a77",
)
REAL_DETECTOR_REVERTS = frozenset({
    "f2c0175d88239312d3254ac853e340d2fabf8749", "a2bc04e9f27c8b12540278702f923f7d62d01759",
    "6ca50d2c2eb32883502f0a28b8af3aa8cc5ad0b3", "d1fbd44f6d5f35263569100635f3ac6d3d49d7eb",
})
NOT_A_CASE = "40a28a4c9103a9d82dd0a518ec6d5f92e7e0b8dc"  # a chore commit that also edits judge_calibration.py
REAL_NAMED_NOISE = frozenset({
    ("agent-harness-security-adapter", "broad_shell_permission", None),
    ("agent-harness-security-adapter", "direct_anthropic_api_usage", None),
    ("agent-harness-security-adapter", "secret_leak_in_yaml_or_md", None),
    ("kernel-dead-wire-adapter", "policy_key_never_read", "aria-kernel/aria_kernel/data/runtime_profiles.json"),
})

_SHA40 = re.compile(r"[0-9a-f]{40}")
LABEL = "practice_score_contaminated"
RECALL_STATUS = "unmeasured:discovery_recall_producer_not_wired"
FORBIDDEN_RECALL_KEYS = frozenset({"hits", "recall", "located", "rate", "passed", "verdict", "meets_floor", "gate"})

TOOL_A, TOOL_B, TOOL_C, TOOL_D, TOOL_E, TOOL_Z = (
    "adapter-a", "adapter-b", "adapter-c", "adapter-d", "adapter-e", "adapter-z")
BOGUS_HEAD = "9" * 40
UNKNOWN_SHA = "e" * 40

MAIN_CYCLE = "cyc-1"
# What the main cycle holds (see `_World._layout`): status and full-list count per tool.
MAIN_TOOLS = {
    TOOL_A: ("ok", 3),     # its stored sample is truncated to 1: only the run artifact holds all 3
    TOOL_B: ("ok", 2),
    TOOL_C: ("ok", 1),     # its runner block claims a count of 0: the list in the artifact is what counts
    TOOL_Z: ("ok", 0),     # an ok run that found nothing: zero, not "unavailable"
    TOOL_D: ("crash", 0),
    TOOL_E: ("ok", 2),     # its evidence_validation spilled over the inline cap: no envelopes on the row
}
MAIN_RAW, MAIN_NAMED, MAIN_NOT_NAMED = 8, 3, 5  # with the fixture manifest's two named noise entries


def _api(case: unittest.TestCase, name: str) -> Any:
    """The harness attribute `name`, asserting it exists so a missing API fails by saying so."""
    case.assertTrue(
        hasattr(harness, name),
        f"harness.{name} does not exist: F1.3 slice a adds it to tools/aria-acceptance/harness.py",
    )
    return getattr(harness, name)


def _refused(case: unittest.TestCase, name: str, call: Callable[[], Any]) -> GovernanceError:
    """`call` raises the kernel's GovernanceError whose message carries the refusal `name`."""
    with case.assertRaises(GovernanceError) as raised:
        call()
    case.assertIn(name, str(raised.exception))
    return raised.exception


# ── git: a hermetic fixture repo ──
def _fixture_git_env(day: int = 1) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    stamp = f"2026-02-{day:02d}T00:00:00+0000"
    env.update({
        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
        "GIT_AUTHOR_NAME": "F1.3 fixture", "GIT_AUTHOR_EMAIL": "fixture@aria.test",
        "GIT_COMMITTER_NAME": "F1.3 fixture", "GIT_COMMITTER_EMAIL": "fixture@aria.test",
        "GIT_AUTHOR_DATE": stamp, "GIT_COMMITTER_DATE": stamp,
    })
    return env


def _git(repo: Path, *args: str, day: int = 1) -> str:
    done = subprocess.run(
        ["git", "-C", str(repo), "-c", "commit.gpgsign=false", "-c", "gc.auto=0", *args],
        env=_fixture_git_env(day), capture_output=True, text=True, check=True,
    )
    return done.stdout.strip()


# ── fixture rows, shaped like the real ones ──
def _tool_definition(tool_id: str) -> dict[str, Any]:
    empty = {"observations": [], "findings": [], "read_paths": [], "evidence_sources": [], "cost_units": 1}
    return {
        "tool_id": tool_id, "kind": "adapter", "version": "1.0.0", "status": "SHADOW",
        "declared_scope": ["docs/**/*.md"],
        "output_schema": {"type": "object", "required": ["observations", "findings", "read_paths", "evidence_sources"]},
        "fixture_set": f"fixtures/{tool_id}",
        "health_thresholds": {"max_cost_units": 10, "precision_min": 0.85},
        "allowed_read_globs": ["docs/**/*.md"], "forbidden_read_globs": [],
        "claim_types": ["learning"], "owner": "platform",
        # Never executed: the runs below are recorded, not run.
        "runner": {
            "type": "subprocess",
            "argv": ["python3", _FAKE_RUNNER.as_posix(), "--output-b64",
                     base64.b64encode(json.dumps(empty).encode("utf-8")).decode("ascii")],
            "cwd": ".", "timeout_ms": 1000, "stdin_json": True,
        },
        "schema_version": 1,
    }


def _finding(tool_id: str, rule: str, path: str, ordinal: int) -> dict[str, Any]:
    return {
        "evidence": [{"line": ordinal, "path": path}], "id": f"{tool_id}:{rule}:{path}:{ordinal}",
        "line": ordinal, "message": f"{rule} at {path}", "path": path, "rule": rule, "severity": "LOW",
    }


def _envelope(path: str, target_sha: str) -> dict[str, Any]:
    return {
        "canonical_ref": path, "content_hash": "sha256:" + "1" * 64, "envelope_hash": "sha256:" + "2" * 64,
        "exists": True, "glob_match_count": None, "is_glob": False, "line": 1, "self_output_class": None,
        "source_hint": "tool_output", "target_sha": target_sha, "trust_grade": "repo_verified",
        "validation_errors": [],
    }


def _evidence_validation(spec: dict[str, Any]) -> dict[str, Any]:
    if spec["status"] == "crash":
        return {"evidence_sources": [], "repository_mutation_attempt": False}
    sha = spec["sha"]
    validation: dict[str, Any] = {
        "checked_sources": ["docs/a.md"], "errors": [],
        "evidence_envelopes": [_envelope("docs/a.md", sha), _envelope("docs/b.md", sha)] if sha else [],
        "evidence_sources": ["docs/a.md"], "repository_mutation_attempt": False,
        "self_output_evidence": [], "valid": True,
    }
    if spec.get("spill"):
        # Past the inline row cap (128 KiB) the writer keeps only the structural keys and a digest
        # stub: the real rows of the big adapters (doc-staleness, test-gap, ...) look like this.
        validation["checked_sources"] = [f"docs/spilled/{index:05d}-{'x' * 48}.md" for index in range(3200)]
        validation["evidence_sources"] = [f"docs/spilled/{index:05d}.md" for index in range(150)]
    return validation


def _run_envelope(ordinal: int, spec: dict[str, Any]) -> dict[str, Any]:
    findings = [_finding(spec["tool"], rule, path, number)
                for number, (rule, path) in enumerate(spec["findings"], start=1)]
    sample = findings if spec.get("sample") is None else findings[: spec["sample"]]
    return {
        "run_id": f"run-{ordinal:03d}", "tool_id": spec["tool"], "cycle_id": spec["cycle"],
        "status": spec["status"], "input_hash": "sha256:" + "3" * 64, "output_hash": "sha256:" + "4" * 64,
        "read_paths": ["docs/a.md"], "emitted_observations": [], "emitted_findings": [],
        "evidence_validation": _evidence_validation(spec), "operator_feedback_refs": [],
        "duration_ms": 10, "cost_units": 1, "schema_version": 1, "timeout_ms": 120000,
        "memory_candidates": [],
        "repo_snapshot": {
            "dirty_snapshot": False,
            "file_counts": {"allowed": 1, "fated": 1, "generated": 0, "git_tracked": 1, "unknown": 0, "working_tree": 1},
            "legacy_tracked_file_count": 1, "repo_state_id": "repo-state:" + "5" * 64, "schema_version": 1,
            "snapshot_hash": "sha256:" + "6" * 64, "snapshot_mode": "working_tree",
            "tool_scope_allowed_count": 1, "tool_scope_path_count": 1, "tracked_file_count": 1,
        },
        "runner": {
            "exit_code": 0 if spec["status"] == "ok" else 1, "genesis_adapter_sha256": None, "parse_error": None,
            "raw_findings_count": len(findings) if spec.get("count") is None else spec["count"],
            "raw_findings_sample": sample,
            "raw_observations_count": 0, "sandbox_backend": "bwrap", "scope_out_mutations": [],
            "scoped_mutations": [], "spawn_environment": {"declared": [], "passed": ["PATH"], "schema_version": 1},
            "stderr_hash": "sha256:" + "7" * 64, "stderr_sample": "", "timed_out": False,
            "type": spec["runner_type"],
        },
        "raw_findings": findings,
    }


def _run(tool: str, findings: list[tuple[str, str]] | None = None, **overrides: Any) -> dict[str, Any]:
    spec = {"tool": tool, "findings": findings or [], "status": "ok", "runner_type": "subprocess",
            "sha": None, "cycle": MAIN_CYCLE, "sample": None, "spill": False, "ledger": "v2-shadow"}
    spec.update(overrides)
    return spec


def _write_store(root: Path, runs: list[dict[str, Any]]) -> Path:
    """A store written by the kernel's own writers.

    The writers refresh `integrity_index.json` on every call (about half a second each, twenty times
    per run), which makes a store of this size take minutes to build. The refresh is skipped while
    the rows go in and done once at the end, so the finished store is a consistent one.
    """
    from aria_kernel import tool_health, tool_registry

    tools = root / "aria-tools"
    with mock.patch.object(tool_registry, "update_tools_index"), mock.patch.object(tool_health, "update_tools_index"):
        for tool_id in sorted({spec["tool"] for spec in runs}):
            register_tool(_tool_definition(tool_id), base_dir=tools)
        for ordinal, spec in enumerate(runs):
            with mock.patch.dict(os.environ, {"ARIA_RUN_LEDGER_FORMAT": spec["ledger"]}):
                record_run(_run_envelope(ordinal, spec), base_dir=tools)
    tool_registry.update_tools_index(tools)
    return tools


def _snapshot(root: Path) -> dict[str, tuple[Any, ...]]:
    """(kind, size, mtime_ns, sha256) of everything under `root`, for before/after comparisons."""
    seen: dict[str, tuple[Any, ...]] = {}
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if relative == ".git" or relative.startswith(".git/"):
            continue
        if path.is_symlink():
            seen[relative] = ("symlink", os.readlink(path))
        elif path.is_dir():
            seen[relative] = ("dir",)
        else:
            stat = path.stat()
            seen[relative] = ("file", stat.st_size, stat.st_mtime_ns, hashlib.sha256(path.read_bytes()).hexdigest())
    return seen


class _World:
    """One git repo and one store, built once with the kernel's own writers."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.repo = root / "repo"
        self._build_repo()
        self.store = _write_store(root / "store", self._layout())

    def _build_repo(self) -> None:
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], env=_fixture_git_env(), check=True)
        _git(self.repo, "symbolic-ref", "HEAD", "refs/heads/main")
        self.base = self._commit("base", "base.txt", "base\n", day=1)
        self.planted: list[str] = []
        for number in range(1, 14):
            self.planted.append(self._commit(f"planted {number}", f"planted/{number:02d}.txt", f"{number}\n", day=1 + number))
        self.head = self.planted[-1]
        self.head2 = self._commit("after the head", "after.txt", "after\n", day=20)
        _git(self.repo, "checkout", "-q", "-b", "side", self.base)
        self.side = self._commit("side branch, not an ancestor of the head", "side.txt", "side\n", day=21)
        _git(self.repo, "checkout", "-q", "main")

    def _commit(self, subject: str, relative: str, content: str, *, day: int) -> str:
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")
        _git(self.repo, "add", relative, day=day)
        _git(self.repo, "commit", "-q", "-m", subject, day=day)
        return _git(self.repo, "rev-parse", "HEAD", day=day)

    def tree_of(self, commit: str) -> str:
        return _git(self.repo, "rev-parse", f"{commit}^{{tree}}")

    def _layout(self) -> list[dict[str, Any]]:
        """The rows of the one store: the main cycle, and one cycle per refusal scenario.

        One store, because every row costs a second of the kernel's own writers. The other cycles
        double as the check that the exam reads the cycle it is asked about and nothing else: a
        reader that did not filter by cycle would see a tool run twice and two scanned trees.
        """
        head, base = self.head, self.base
        a_findings = [("r1", "docs/a1.md"), ("r1", "docs/a2.md"), ("r2", "docs/a3.md")]
        b_findings = [("r3", "docs/p1.md"), ("r3", "docs/p2.md")]
        return [
            # The main cycle. T1: A has 3 findings with its stored sample truncated to 1, B 2, Z is an ok
            # run that found nothing, D crashed, E's evidence_validation spilled over the inline cap (the
            # row keeps no envelopes). T2: the near-miss negatives for named noise are A/r2 (another rule
            # on a named tool), B/r3 at p2 (a named tool and rule on another path), C/r1 (a named rule on
            # another tool).
            _run(TOOL_A, a_findings, sha=head, sample=1), _run(TOOL_B, b_findings, sha=head),
            _run(TOOL_C, [("r1", "docs/c1.md")], sha=head, count=0), _run(TOOL_Z, [], sha=head),
            _run(TOOL_D, [], status="crash"),
            _run(TOOL_E, [("r4", "docs/e1.md"), ("r4", "docs/e2.md")], sha=head, spill=True),
            # The refusal scenarios, each a cycle of its own.
            _run(TOOL_B, b_findings, sha=head, runner_type="agent", cycle="cyc-agent"),
            _run(TOOL_A, a_findings, sha=head, cycle="cyc-twice"), _run(TOOL_A, a_findings, sha=head, cycle="cyc-twice"),
            _run(TOOL_A, a_findings, cycle="cyc-no-sha"),
            _run(TOOL_A, a_findings, sha=head, cycle="cyc-two-sha"), _run(TOOL_B, b_findings, sha=base, cycle="cyc-two-sha"),
            _run(TOOL_A, a_findings, sha=base, cycle="cyc-wrong-head"),
            _run(TOOL_A, a_findings, sha=BOGUS_HEAD, cycle="cyc-bogus-head"),
            _run(TOOL_A, a_findings, sha=self.head2, cycle="cyc-head2"),
            # A legacy v1 row has no run artifact: its full finding list is nowhere, only a sample.
            _run(TOOL_A, a_findings, sha=head, ledger="v1", cycle="cyc-v1"),
            # A cycle whose id begins with the main cycle's: asking for "cyc-1" must not read "cyc-10"
            # too (it would see tool A twice).
            _run(TOOL_A, a_findings, sha=head, cycle=f"{MAIN_CYCLE}0"),
        ]

    # ── manifests ──
    def manifest(
        self, *, head: str | None = None, named_noise: list[dict[str, Any]] | None = None,
        legacy_tally: tuple[int, int] = (MAIN_NAMED, MAIN_NOT_NAMED), legacy_system_sha: str | None = None,
        detector_positions: tuple[int, ...] = (0, 1, 4, 6),
    ) -> dict[str, Any]:
        head = self.head if head is None else head
        cases = []
        for position, revert in enumerate(reversed(self.planted)):  # newest first, as `git log` lists them
            detector = position in detector_positions
            cases.append({
                "revert_sha": revert, "detector": detector,
                "detector_reason": f"fixture: case {position} reverts a detector module" if detector else None,
            })
        return {
            "$schema": "aria/baseline-corpus/v1", "corpus_id": "fixture-practice-v1", "kind": "practice",
            "head": head,
            "contamination": [
                "the revert subjects name the fix",
                "the corpus tree holds the review documents that describe the bugs",
                "program exits are engineered on the items",
                "most reverts also reverted the fix's tests",
            ],
            "cases": cases,
            "named_noise": named_noise if named_noise is not None else [
                {"tool_id": TOOL_A, "rule": "r1", "reason": "fixture: every r1 finding of A is a known artifact"},
                {"tool_id": TOOL_B, "rule": "r3", "path": "docs/p1.md", "reason": "fixture: r3 at p1 only"},
            ],
            "legacy_claim": {
                "source": "fixture: an earlier section test",
                "system_sha": self.head if legacy_system_sha is None else legacy_system_sha,
                "recall": {"hits": 0, "n": 13},
                "tally": {"named_noise": legacy_tally[0], "not_named_noise": legacy_tally[1]},
            },
        }

    def write_manifest(self, manifest: dict[str, Any], *, label: str = "manifest") -> Path:
        directory = Path(tempfile.mkdtemp(prefix=f"{label}-", dir=self.root))
        path = directory / "corpus.json"
        path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
        return path

    def exam(
        self, *, store: Path | None = None, manifest: dict[str, Any] | Path | None = None,
        cycle: str = MAIN_CYCLE, aria_sha: str | None = None, provider: str = "none", model: str = "none",
    ) -> dict[str, Any]:
        baseline_exam = harness.baseline_exam
        if manifest is None or isinstance(manifest, dict):
            manifest = self.write_manifest(manifest or self.manifest())
        return baseline_exam(
            store=store or self.store, cycle_id=cycle, repo=self.repo, corpus=manifest,
            aria_sha=self.head if aria_sha is None else aria_sha, provider=provider, model=model,
        )

    def cli_args(
        self, out: Path, *, store: Path | None = None, manifest: Path | None = None, cycle: str = MAIN_CYCLE,
        aria_sha: str | None = None, extra: tuple[str, ...] = (),
    ) -> list[str]:
        return [
            "--store", str(store or self.store), "--cycle-id", cycle,
            "--repo", str(self.repo), "--aria-sha", self.head if aria_sha is None else aria_sha,
            "--corpus", str(manifest or self.write_manifest(self.manifest())), "--out", str(out), *extra,
        ]

    def fresh_out(self, name: str = "report.json") -> Path:
        directory = Path(tempfile.mkdtemp(prefix="out-", dir=self.root))
        return directory / name


_WORLD: _World | None = None
_WORLD_TMP: tempfile.TemporaryDirectory[str] | None = None


def setUpModule() -> None:
    global _WORLD, _WORLD_TMP
    _WORLD_TMP = tempfile.TemporaryDirectory(prefix="aria-f13-baseline-exam-")
    _WORLD = _World(Path(_WORLD_TMP.name))


def tearDownModule() -> None:
    if _WORLD_TMP is not None:
        _WORLD_TMP.cleanup()


def _world() -> _World:
    assert _WORLD is not None, "setUpModule did not run"
    return _WORLD


def _cli(*argv: str) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run(
        [sys.executable, str(_HARNESS_PATH), "baseline-exam", *argv],
        capture_output=True, text=True, timeout=300, check=False, env=env,
    )


def _walk_keys(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [str(key) for key in value] + [name for item in value.values() for name in _walk_keys(item)]
    if isinstance(value, list):
        return [name for item in value for name in _walk_keys(item)]
    return []


# ════════════════════════════════════════════════════════════════════════════
# S1, S2 — the measurement stamp
# ════════════════════════════════════════════════════════════════════════════
class MeasurementStampTests(unittest.TestCase):
    SHA = "a" * 40
    CORPUS = "sha256:" + "b" * 64

    def _stamp(self, **overrides: str) -> dict[str, str]:
        fields = {"aria_sha": self.SHA, "corpus_hash": self.CORPUS, "provider": "none", "model": "none"}
        fields.update(overrides)
        return _api(self, "measurement_stamp")(**fields)

    def test_a_stamp_is_exactly_the_triple_with_its_provider_and_model(self) -> None:
        self.assertEqual(self._stamp(), {
            "aria_sha": self.SHA, "corpus_hash": self.CORPUS, "provider": "none", "model": "none"})

    def test_a_sha_that_is_not_forty_lowercase_hex_is_refused_by_name(self) -> None:
        for bad in ("a" * 39, "a" * 41, "A" * 40, "a" * 12, "main", "--upload-pack=x", "", "a" * 39 + "g", "a" * 40 + "\n"):
            with self.subTest(aria_sha=bad):
                _refused(self, "baseline_exam_sha_malformed", lambda bad=bad: self._stamp(aria_sha=bad))

    def test_a_corpus_hash_that_is_not_a_sha256_digest_is_refused(self) -> None:
        for bad in ("sha256:abc", "b" * 64, "sha256:" + "B" * 64, "sha256:" + "b" * 63, "", "sha256:" + "b" * 64 + "\n"):
            with self.subTest(corpus_hash=bad):
                _refused(self, "baseline_exam_", lambda bad=bad: self._stamp(corpus_hash=bad))

    def test_no_model_is_the_none_none_pair_and_a_model_names_its_own_provider(self) -> None:
        self.assertEqual(provider_for_model("opus"), "anthropic", "the fixture's premise: opus is Anthropic's tier")
        self.assertEqual(provider_for_model("glm-5.3"), "zai", "the fixture's premise: glm-5.3 is Z.ai's default")
        for provider, model in (("none", "none"), ("anthropic", "opus"), ("zai", "glm-5.3")):
            with self.subTest(provider=provider, model=model):
                stamp = self._stamp(provider=provider, model=model)
                self.assertEqual((stamp["provider"], stamp["model"]), (provider, model))

    def test_a_provider_that_does_not_own_the_model_is_refused_by_name(self) -> None:
        pairs = (("zai", "opus"), ("none", "opus"), ("anthropic", "none"), ("anthropic", "not-a-fleet-model"),
                 ("none", "glm-5.3"), ("openai", "opus"))
        for provider, model in pairs:
            with self.subTest(provider=provider, model=model):
                _refused(self, "baseline_exam_provider_model_mismatch",
                         lambda provider=provider, model=model: self._stamp(provider=provider, model=model))


class StampsMatchTests(unittest.TestCase):
    BASE = {"aria_sha": "a" * 40, "corpus_hash": "sha256:" + "b" * 64, "provider": "none", "model": "none"}

    def _match(self, left: dict[str, str], right: dict[str, str]) -> list[str]:
        return _api(self, "stamps_match")(left, right)

    def test_identical_stamps_differ_in_nothing(self) -> None:
        self.assertEqual(self._match(self.BASE, dict(self.BASE)), [])

    def test_each_field_changed_alone_is_the_only_name_returned(self) -> None:
        changes = {"aria_sha": "b" * 40, "corpus_hash": "sha256:" + "c" * 64, "provider": "zai", "model": "glm-5.3"}
        for field, value in changes.items():
            with self.subTest(field=field):
                other = {**self.BASE, field: value}
                self.assertEqual(self._match(self.BASE, other), [field])
                self.assertEqual(self._match(other, self.BASE), [field])

    def test_a_prefix_of_the_sha_is_a_difference_not_a_match(self) -> None:
        abbreviated = {**self.BASE, "aria_sha": self.BASE["aria_sha"][:12]}
        self.assertEqual(self._match(self.BASE, abbreviated), ["aria_sha"])
        self.assertEqual(self._match(abbreviated, self.BASE), ["aria_sha"])

    def test_every_differing_field_is_named(self) -> None:
        other = {**self.BASE, "provider": "zai", "model": "glm-5.3", "aria_sha": "c" * 40}
        differing = self._match(self.BASE, other)
        self.assertIsInstance(differing, list)
        self.assertEqual(sorted(differing), ["aria_sha", "model", "provider"])


# ════════════════════════════════════════════════════════════════════════════
# C1 — the committed manifest
# ════════════════════════════════════════════════════════════════════════════
class CommittedManifestTests(unittest.TestCase):
    """The practice corpus the exit run reads: 13 reverts, four of them detector reverts, four named noise
    classes and the legacy claim. A fact about the committed file, so it needs no git and no store."""

    def _manifest(self) -> dict[str, Any]:
        self.assertTrue(_COMMITTED_MANIFEST.is_file(), f"{_COMMITTED_MANIFEST} does not exist: F1.3 slice a commits the corpus manifest")
        return json.loads(_COMMITTED_MANIFEST.read_text(encoding="utf-8"))

    def test_the_manifest_declares_its_schema_kind_and_the_head_it_was_scanned_at(self) -> None:
        manifest = self._manifest()
        self.assertEqual(manifest["$schema"], "aria/baseline-corpus/v1")
        self.assertEqual(manifest["kind"], "practice", "the 13 are a practice set, contaminated, never a gate")
        self.assertIsInstance(manifest["corpus_id"], str)
        self.assertTrue(manifest["corpus_id"].strip())
        self.assertEqual(manifest["head"], REAL_HEAD)

    def test_the_thirteen_reverts_are_unique_full_shas_and_exactly_the_specified_ones(self) -> None:
        cases = self._manifest()["cases"]
        shas = [case["revert_sha"] for case in cases]
        self.assertEqual(len(shas), 13)
        self.assertEqual(len(set(shas)), 13, "a revert listed twice")
        for sha in shas:
            self.assertIsNotNone(_SHA40.fullmatch(sha), f"{sha!r} is not a full lowercase sha")
        self.assertEqual(set(shas), set(REAL_REVERTS))

    def test_the_chore_commit_that_also_edits_the_scorer_is_not_a_case(self) -> None:
        self._manifest()  # asserts the file exists
        self.assertNotIn(NOT_A_CASE, _COMMITTED_MANIFEST.read_text(encoding="utf-8"))

    def test_the_detector_cases_are_exactly_the_four_with_a_reason_and_the_other_nine_have_none(self) -> None:
        cases = self._manifest()["cases"]
        flagged = {case["revert_sha"] for case in cases if case["detector"] is True}
        self.assertEqual(flagged, set(REAL_DETECTOR_REVERTS))
        for case in cases:
            with self.subTest(revert=case["revert_sha"]):
                self.assertIsInstance(case["detector"], bool)
                if case["detector"]:
                    self.assertIsInstance(case["detector_reason"], str)
                    self.assertTrue(case["detector_reason"].strip(), "a detector case without its reason")
                else:
                    self.assertIsNone(case["detector_reason"])

    def test_the_four_contamination_reasons_are_stated(self) -> None:
        reasons = self._manifest()["contamination"]
        self.assertEqual(len(reasons), 4)
        for reason in reasons:
            self.assertIsInstance(reason, str)
            self.assertTrue(reason.strip())

    def test_the_named_noise_is_exactly_the_four_classes_each_with_a_reason(self) -> None:
        named = self._manifest()["named_noise"]
        classes = {(entry["tool_id"], entry["rule"], entry.get("path")) for entry in named}
        self.assertEqual(len(named), 4)
        self.assertEqual(classes, set(REAL_NAMED_NOISE))
        for entry in named:
            with self.subTest(entry=entry["rule"]):
                self.assertIsInstance(entry["reason"], str)
                self.assertTrue(entry["reason"].strip())

    def test_the_legacy_claim_is_the_earlier_measurement_not_corpus(self) -> None:
        legacy = self._manifest()["legacy_claim"]
        self.assertEqual(legacy["system_sha"], REAL_HEAD)
        self.assertEqual(legacy["recall"], {"hits": 0, "n": 13})
        self.assertEqual(legacy["tally"], {"named_noise": 29, "not_named_noise": 614})
        self.assertTrue(str(legacy["source"]).strip())


# ════════════════════════════════════════════════════════════════════════════
# The fixture rows are real rows
# ════════════════════════════════════════════════════════════════════════════
class FixtureRowsAreRealRows(unittest.TestCase):
    """The writer's proof that the store under test has the fields of the kept store's 17 rows. A test
    on a fixture shaped by the test writer's imagination would pin nothing about the real store."""

    def _rows(self) -> list[dict[str, Any]]:
        path = _world().store / "runs.jsonl"
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]

    def _v2_rows(self) -> list[dict[str, Any]]:
        return [row for row in self._rows() if row["cycle_id"] != "cyc-v1"]

    def test_every_fixture_row_has_exactly_the_fields_of_a_real_row(self) -> None:
        for row in self._v2_rows():
            with self.subTest(cycle=row["cycle_id"], tool=row["tool_id"], run=row["run_id"]):
                self.assertEqual(set(row), REAL_RUN_ROW_KEYS)
                self.assertEqual(set(row["runner"]), REAL_RUNNER_KEYS)
                self.assertEqual(set(row["repo_snapshot"]), REAL_REPO_SNAPSHOT_KEYS)
                self.assertEqual(row["schema_version"], 2)

    def test_a_v2_shadow_row_carries_the_artifact_that_holds_its_full_findings(self) -> None:
        for row in self._v2_rows():
            with self.subTest(cycle=row["cycle_id"], tool=row["tool_id"], run=row["run_id"]):
                self.assertEqual(row["run_ledger_format"], "v2-shadow")
                self.assertEqual(row["artifact_status"], "present")
                self.assertEqual(set(row["artifact_ref"]), REAL_ARTIFACT_REF_KEYS)
                self.assertEqual(row["artifact_refs"], [row["artifact_ref"]])

    def test_the_evidence_validation_of_a_fixture_row_is_one_of_the_three_real_shapes(self) -> None:
        seen = set()
        for row in self._v2_rows():
            shape = frozenset(row["evidence_validation"])
            seen.add(shape)
            with self.subTest(cycle=row["cycle_id"], tool=row["tool_id"], run=row["run_id"]):
                self.assertIn(shape, REAL_EVIDENCE_VALIDATION_SHAPES.values())
                for envelope in row["evidence_validation"].get("evidence_envelopes", []):
                    self.assertEqual(set(envelope), REAL_ENVELOPE_KEYS)
        self.assertEqual(seen, set(REAL_EVIDENCE_VALIDATION_SHAPES.values()), "the fixture lacks a real shape")

    def test_a_row_whose_validation_spilled_keeps_no_envelope_so_it_names_no_scanned_sha(self) -> None:
        # The specification says such a row "keeps a sample of envelopes". The kernel's writer does not
        # (`EVIDENCE_VALIDATION_STRUCTURAL_KEYS`), and neither do the real rows of the kept store
        # (doc-staleness, test-gap, bundle-budget, ...): the scanned sha is read from the rows that
        # kept their envelopes, and a spilled row neither contributes one nor disturbs it.
        spilled = [row for row in self._v2_rows() if "spilled_bulk" in row["evidence_validation"]]
        self.assertEqual([row["tool_id"] for row in spilled], [TOOL_E])
        self.assertNotIn("evidence_envelopes", spilled[0]["evidence_validation"])

    def test_the_truncated_sample_of_tool_a_is_shorter_than_its_full_list(self) -> None:
        truncated = [row for row in self._v2_rows() if row["tool_id"] == TOOL_A and row["cycle_id"] == MAIN_CYCLE][0]
        self.assertEqual(len(truncated["runner"]["raw_findings_sample"]), 1)
        self.assertEqual(truncated["runner"]["raw_findings_count"], 3)

    def test_a_v1_fixture_row_has_no_artifact_to_read_its_findings_from(self) -> None:
        legacy = [row for row in self._rows() if row["cycle_id"] == "cyc-v1"][0]
        self.assertEqual(legacy["schema_version"], 1)
        self.assertEqual(legacy["artifact_status"], "legacy_inline_or_sample_only")
        self.assertIsNone(legacy.get("artifact_ref"))


# ════════════════════════════════════════════════════════════════════════════
# C2, C3 — the corpus: its hash and its verification against the repo
# ════════════════════════════════════════════════════════════════════════════
class CorpusHashTests(unittest.TestCase):
    def _hash(self, manifest: dict[str, Any], *, cycle: str = MAIN_CYCLE, aria_sha: str | None = None) -> str:
        _api(self, "baseline_exam")
        return _world().exam(manifest=manifest, cycle=cycle, aria_sha=aria_sha)["stamp"]["corpus_hash"]

    def test_the_hash_is_the_digest_of_the_manifest_without_its_legacy_claim_and_the_head_tree(self) -> None:
        world = _world()
        manifest = world.manifest()
        expected = sha256_digest_of_canonical_json({
            "manifest": {key: value for key, value in manifest.items() if key != "legacy_claim"},
            "head_tree": world.tree_of(world.head),
        })
        self.assertEqual(self._hash(manifest), expected)

    def test_the_hash_does_not_change_when_only_the_legacy_claim_changes(self) -> None:
        world = _world()
        original = self._hash(world.manifest())
        edited = world.manifest(legacy_tally=(40, 2), legacy_system_sha="d" * 40)
        edited["legacy_claim"]["source"] = "fixture: another earlier measurement"
        edited["legacy_claim"]["recall"] = {"hits": 5, "n": 13}
        self.assertEqual(self._hash(edited), original)

    def test_the_hash_changes_when_a_detector_flag_flips(self) -> None:
        world = _world()
        self.assertNotEqual(self._hash(world.manifest(detector_positions=(0, 1, 4, 6))),
                            self._hash(world.manifest(detector_positions=(0, 1, 4, 6, 8))))
        self.assertNotEqual(self._hash(world.manifest(detector_positions=(0, 1, 4, 6))),
                            self._hash(world.manifest(detector_positions=(0, 1, 4))))

    def test_the_hash_changes_when_a_named_noise_entry_changes(self) -> None:
        world = _world()
        original = world.manifest()
        renamed = world.manifest()
        renamed["named_noise"][0]["rule"] = "r1-renamed"
        reworded = world.manifest()
        reworded["named_noise"][1]["reason"] = "fixture: another reason"
        repathed = world.manifest()
        repathed["named_noise"][1]["path"] = "docs/p2.md"
        extended = world.manifest()
        extended["named_noise"].append({"tool_id": TOOL_C, "rule": "r1", "reason": "fixture: one more class"})
        reference = self._hash(original)
        for label, variant in (("rule", renamed), ("reason", reworded), ("path", repathed), ("entry added", extended)):
            with self.subTest(change=label):
                self.assertNotEqual(self._hash(variant), reference)

    def test_the_hash_changes_when_the_head_changes(self) -> None:
        world = _world()
        at_head = self._hash(world.manifest())
        moved = world.manifest(head=world.head2, legacy_system_sha=world.head2)
        self.assertNotEqual(self._hash(moved, cycle="cyc-head2", aria_sha=world.head2), at_head)

    def test_the_hash_is_a_sha256_digest(self) -> None:
        self.assertRegex(self._hash(_world().manifest()), r"\Asha256:[0-9a-f]{64}\Z")


class CorpusVerificationTests(unittest.TestCase):
    """With a repo, each case SHA and the head must exist and each revert must be an ancestor of the head."""

    def test_the_fixture_corpus_verifies_with_a_revert_that_is_the_head_itself(self) -> None:
        world = _world()
        manifest = world.manifest()
        self.assertEqual(manifest["cases"][0]["revert_sha"], manifest["head"], "the real corpus's head is one of its cases")
        _api(self, "baseline_exam")
        self.assertEqual(world.exam(manifest=manifest)["stamp"]["aria_sha"], world.head)

    def test_a_revert_that_is_not_in_the_repo_is_refused_by_name(self) -> None:
        world = _world()
        manifest = world.manifest()
        manifest["cases"][3]["revert_sha"] = UNKNOWN_SHA
        _api(self, "baseline_exam")
        _refused(self, "baseline_exam_corpus_commit_missing", lambda: world.exam(manifest=manifest))

    def test_a_revert_that_is_not_an_ancestor_of_the_head_is_refused_by_the_same_name(self) -> None:
        world = _world()
        manifest = world.manifest()
        manifest["cases"][3]["revert_sha"] = world.side
        _api(self, "baseline_exam")
        _refused(self, "baseline_exam_corpus_commit_missing", lambda: world.exam(manifest=manifest))

    def test_a_head_that_is_not_in_the_repo_is_refused_by_name(self) -> None:
        world = _world()
        manifest = world.manifest(head=BOGUS_HEAD, legacy_system_sha=BOGUS_HEAD)
        _api(self, "baseline_exam")
        _refused(self, "baseline_exam_corpus_commit_missing",
                 lambda: world.exam(cycle="cyc-bogus-head", manifest=manifest, aria_sha=BOGUS_HEAD))

    def test_a_malformed_sha_is_refused_before_any_git_call(self) -> None:
        world = _world()
        _api(self, "baseline_exam")
        malformed = ("main", "HEAD", "--upload-pack=x", "A" * 40, "a" * 39, "a" * 41, "a" * 12, "")
        for field in ("revert_sha", "head"):
            for bad in malformed:
                manifest = world.manifest()
                if field == "head":
                    manifest["head"] = bad
                else:
                    manifest["cases"][5]["revert_sha"] = bad
                path = world.write_manifest(manifest)
                with self.subTest(field=field, sha=bad):
                    with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("git ran for a malformed sha")) as popen, \
                            mock.patch.object(subprocess, "run", side_effect=AssertionError("git ran for a malformed sha")) as run:
                        _refused(self, "baseline_exam_", lambda path=path: world.exam(manifest=path))
                    self.assertEqual((popen.call_count, run.call_count), (0, 0))

    def test_a_malformed_sha_in_a_case_is_refused_by_the_one_sha_validator(self) -> None:
        world = _world()
        manifest = world.manifest()
        manifest["cases"][5]["revert_sha"] = "--upload-pack=x"
        _api(self, "baseline_exam")
        _refused(self, "baseline_exam_sha_malformed", lambda: world.exam(manifest=manifest))

    def test_a_malformed_head_in_the_manifest_is_refused_by_the_one_sha_validator_before_any_git_call(self) -> None:
        # The head is read by the same loader as the reverts and checked by the same validator. The
        # name is the pin: a body that skips the head would be stopped later by another refusal (the
        # store was not scanned at that head, or git does not know it), which is not this one.
        world = _world()
        _api(self, "baseline_exam")
        for bad in ("main", "HEAD", "--upload-pack=x", "A" * 40, "a" * 39, "a" * 41, "a" * 12, ""):
            manifest = world.manifest()
            manifest["head"] = bad
            path = world.write_manifest(manifest)
            with self.subTest(head=bad):
                with mock.patch.object(subprocess, "Popen", side_effect=AssertionError("git ran for a malformed head")) as popen, \
                        mock.patch.object(subprocess, "run", side_effect=AssertionError("git ran for a malformed head")) as run:
                    _refused(self, "baseline_exam_sha_malformed", lambda path=path: world.exam(manifest=path))
                self.assertEqual((popen.call_count, run.call_count), (0, 0))

    def test_git_runs_hermetically_whatever_the_callers_environment_steers_it_at(self) -> None:
        # ARIA-MEDIUM-824: a git child that inherits the environment (GIT_DIR, GIT_OBJECT_DIRECTORY, ...)
        # reads another repository. The corpus check runs git under the scrubbed environment.
        world = _world()
        decoy = world.root / "decoy"
        decoy.mkdir()
        subprocess.run(["git", "init", "-q", str(decoy)], env=_fixture_git_env(), check=True)
        _api(self, "baseline_exam")
        steering = {"GIT_DIR": str(decoy / ".git"), "GIT_WORK_TREE": str(decoy),
                    "GIT_OBJECT_DIRECTORY": str(decoy / ".git" / "objects"), "GIT_INDEX_FILE": str(decoy / "index")}
        with mock.patch.dict(os.environ, steering):
            report = world.exam()
        self.assertEqual(report["stamp"]["aria_sha"], world.head)


# ════════════════════════════════════════════════════════════════════════════
# T1..T4, R1..R3 — the exam itself
# ════════════════════════════════════════════════════════════════════════════
class TallyTests(unittest.TestCase):
    def setUp(self) -> None:
        _api(self, "baseline_exam")

    def test_the_raw_findings_are_the_sum_of_every_tools_full_list(self) -> None:
        report = _world().exam()
        self.assertEqual(report["measurements"]["tally"]["raw_findings"], MAIN_RAW)
        self.assertEqual(MAIN_RAW, sum(count for _, count in MAIN_TOOLS.values()))

    def test_every_tool_is_listed_with_its_status_and_its_count_and_a_crash_is_named(self) -> None:
        store = _world().exam()["store"]
        self.assertEqual(set(store["tools"]), set(MAIN_TOOLS))
        for tool, (status, count) in MAIN_TOOLS.items():
            with self.subTest(tool=tool):
                self.assertEqual(store["tools"][tool]["status"], status)
                self.assertEqual(store["tools"][tool]["raw_findings"], count)
        self.assertEqual(store["crashed_tools"], [TOOL_D])

    def test_a_row_whose_stored_sample_is_truncated_counts_its_full_list(self) -> None:
        # Tool A's row keeps `raw_findings_sample` of 1 and `raw_findings_count` of 3 only by sample;
        # the whole list is in the run artifact, and only `run_raw_findings` reads that.
        report = _world().exam()
        self.assertEqual(report["store"]["tools"][TOOL_A]["raw_findings"], 3)

    def test_a_count_field_that_disagrees_with_the_artifact_list_is_not_believed(self) -> None:
        # Findings are read through `run_raw_findings` and nowhere else: not from the runner's own
        # `raw_findings_count` (tool C's says 0 and its artifact holds 1), not from the sample.
        report = _world().exam()
        self.assertEqual(report["store"]["tools"][TOOL_C]["raw_findings"], 1)

    def test_an_ok_run_that_found_nothing_is_zero_and_is_not_a_crash(self) -> None:
        store = _world().exam()["store"]
        self.assertEqual(store["tools"][TOOL_Z], {"status": "ok", "raw_findings": 0})
        self.assertNotIn(TOOL_Z, store["crashed_tools"])

    def test_a_row_with_no_artifact_backed_list_is_refused_not_counted_as_zero(self) -> None:
        world = _world()
        _refused(self, "baseline_exam_findings_unavailable", lambda: world.exam(cycle="cyc-v1"))

    def test_a_row_whose_evidence_validation_spilled_neither_disturbs_the_scan_nor_loses_findings(self) -> None:
        report = _world().exam()
        self.assertEqual(report["store"]["scanned_sha"], _world().head)
        self.assertEqual(report["store"]["tools"][TOOL_E], {"status": "ok", "raw_findings": 2})

    def test_the_other_cycles_in_the_store_are_not_counted_when_one_is_asked(self) -> None:
        # The store also holds a tool run twice, a run by an agent, runs on other trees, a v1 row and a
        # cycle whose id begins with this one's: reading any of them with the main cycle's would be
        # refused or would change the count.
        world = _world()
        report = world.exam()
        self.assertEqual(report["measurements"]["tally"]["raw_findings"], MAIN_RAW)
        self.assertEqual(report["store"]["cycle_id"], MAIN_CYCLE)
        self.assertEqual(report["store"]["scanned_sha"], world.head)


class NamedNoiseTests(unittest.TestCase):
    """A finding is named noise iff its tool and rule equal an entry's and, when the entry has a path,
    its path equals it. Nothing else is judged."""

    def setUp(self) -> None:
        _api(self, "baseline_exam")
        self.tally = _world().exam()["measurements"]["tally"]

    def test_named_and_not_named_noise_are_counted_by_the_manifest_entries_only(self) -> None:
        # A/r1 x2 and B/r3 at p1 are named; A/r2, B/r3 at p2, C/r1 and E/r4 x2 are not: A/r2 is another
        # rule on a named tool, B/r3 at p2 the named rule on another path, C/r1 a named rule on another tool.
        self.assertEqual(self.tally["raw_findings"], MAIN_RAW)
        self.assertEqual(self.tally["named_noise"], MAIN_NAMED)
        self.assertEqual(self.tally["not_named_noise"], MAIN_NOT_NAMED)

    def test_the_classes_are_counted_in_manifest_order_each_with_its_reason(self) -> None:
        classes = [(entry["tool_id"], entry["rule"], entry.get("path"), entry["count"], entry["reason"])
                   for entry in self.tally["by_class"]]
        self.assertEqual(classes, [
            (TOOL_A, "r1", None, 2, "fixture: every r1 finding of A is a known artifact"),
            (TOOL_B, "r3", "docs/p1.md", 1, "fixture: r3 at p1 only"),
        ])

    def test_the_path_of_an_entry_is_part_of_the_match(self) -> None:
        world = _world()
        wider = world.manifest(named_noise=[{"tool_id": TOOL_B, "rule": "r3", "reason": "fixture: r3 anywhere"}])
        tally = world.exam(manifest=wider)["measurements"]["tally"]
        self.assertEqual((tally["named_noise"], tally["not_named_noise"]), (2, MAIN_RAW - 2))
        narrower = world.manifest(named_noise=[{"tool_id": TOOL_B, "rule": "r3", "path": "docs/p2.md", "reason": "fixture"}])
        tally = world.exam(manifest=narrower)["measurements"]["tally"]
        self.assertEqual((tally["named_noise"], tally["not_named_noise"]), (1, MAIN_RAW - 1))

    def test_the_tool_of_an_entry_is_part_of_the_match(self) -> None:
        world = _world()
        other_tool = world.manifest(named_noise=[{"tool_id": TOOL_C, "rule": "r1", "reason": "fixture: C only"}])
        tally = world.exam(manifest=other_tool)["measurements"]["tally"]
        self.assertEqual((tally["named_noise"], tally["not_named_noise"]), (1, MAIN_RAW - 1))

    def test_the_rule_counts_by_tool_and_rule_cover_the_findings_when_nothing_is_named(self) -> None:
        world = _world()
        nothing = world.manifest(named_noise=[{"tool_id": "no-such-adapter", "rule": "r0", "reason": "fixture: matches nothing"}])
        tally = world.exam(manifest=nothing)["measurements"]["tally"]
        self.assertEqual((tally["named_noise"], tally["not_named_noise"]), (0, MAIN_RAW))
        self.assertEqual(tally["by_rule"], {
            f"{TOOL_A}/r1": 2, f"{TOOL_A}/r2": 1, f"{TOOL_B}/r3": 2, f"{TOOL_C}/r1": 1, f"{TOOL_E}/r4": 2})

    def test_the_share_of_the_rest_that_is_true_is_never_reported_as_a_number(self) -> None:
        # Adjudicating the not-named findings needs a model or a person; the exam measures neither.
        tally = self.tally
        self.assertIn("verified_true", tally)
        self.assertIsNone(tally["verified_true"])
        self.assertEqual(tally["verification"], "not_measured_here")
        self.assertEqual(tally["named_noise"] + tally["not_named_noise"], tally["raw_findings"])


class RefusalTests(unittest.TestCase):
    """Each refusal is named, leaves the store untouched, and (through the CLI) leaves --out absent."""

    def refusals(self) -> list[tuple[str, dict[str, Any]]]:
        base = _world().base
        return [
            ("baseline_exam_non_deterministic_run", {"cycle": "cyc-agent"}),
            ("baseline_exam_ambiguous_runs", {"cycle": "cyc-twice"}),
            ("baseline_exam_no_runs_for_cycle", {"cycle": "cyc-unknown"}),
            ("baseline_exam_scanned_sha_unknown", {"cycle": "cyc-no-sha"}),
            ("baseline_exam_scanned_sha_ambiguous", {"cycle": "cyc-two-sha"}),
            ("baseline_exam_store_not_scanned_at_corpus_head", {"cycle": "cyc-wrong-head", "aria_sha": base}),
            ("baseline_exam_aria_sha_not_the_scanned_tree", {"aria_sha": base}),
            ("baseline_exam_findings_unavailable", {"cycle": "cyc-v1"}),
        ]

    def setUp(self) -> None:
        _api(self, "baseline_exam")

    def test_each_refusal_is_raised_by_name_and_leaves_the_store_unchanged(self) -> None:
        world = _world()
        for name, options in self.refusals():
            with self.subTest(refusal=name):
                before = _snapshot(world.store)
                _refused(self, name, lambda options=options: world.exam(**options))
                self.assertEqual(_snapshot(world.store), before, f"{name} wrote to the store")

    def test_each_refusal_through_the_cli_exits_non_zero_by_name_and_creates_no_report(self) -> None:
        world = _world()
        for name, options in self.refusals():
            with self.subTest(refusal=name):
                out = world.fresh_out()
                before = _snapshot(world.store)
                done = _cli(*world.cli_args(out, **options))
                self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
                self.assertIn(name, done.stdout + done.stderr)
                self.assertFalse(out.exists(), f"{name} left a report behind")
                self.assertEqual(_snapshot(out.parent), {}, f"{name} left something in the output directory")
                self.assertEqual(_snapshot(world.store), before)

    def test_a_malformed_aria_sha_is_refused_by_the_one_sha_validator(self) -> None:
        world = _world()
        for bad in ("main", world.head[:12], world.head.upper()):
            with self.subTest(aria_sha=bad):
                _refused(self, "baseline_exam_sha_malformed", lambda bad=bad: world.exam(aria_sha=bad))

    def test_a_provider_that_does_not_own_the_model_is_refused_by_the_exam_too(self) -> None:
        world = _world()
        _refused(self, "baseline_exam_provider_model_mismatch", lambda: world.exam(provider="zai", model="opus"))


class ReadOnlyStoreTests(unittest.TestCase):
    """The exam reads the store the way a frozen profile does: `ensure_tools_dir_readonly` and the plain
    path. `tool_health.runs_path` and `ensure_tools_dir` rewrite `integrity_index.json` and bootstrap a
    directory that is not a store."""

    def setUp(self) -> None:
        _api(self, "baseline_exam")

    def test_a_successful_exam_changes_no_file_of_the_store(self) -> None:
        world = _world()
        before = _snapshot(world.store)
        world.exam()
        self.assertEqual(_snapshot(world.store), before)

    def test_a_successful_cli_run_changes_no_file_of_the_store_and_writes_only_its_report(self) -> None:
        world = _world()
        out = world.fresh_out()
        store_before = _snapshot(world.store)
        repo_before = _snapshot(world.repo)
        manifest = world.write_manifest(world.manifest())
        manifest_dir_before = _snapshot(manifest.parent)
        done = _cli(*world.cli_args(out, manifest=manifest))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertEqual(_snapshot(world.store), store_before)
        self.assertEqual(_snapshot(world.repo), repo_before, "the exam wrote into the repo it only reads")
        self.assertEqual(_snapshot(manifest.parent), manifest_dir_before)
        self.assertEqual(sorted(entry.name for entry in out.parent.iterdir()), [out.name], "the command wrote something besides --out")

    def test_a_directory_that_is_not_a_store_is_refused_and_stays_empty(self) -> None:
        world = _world()
        empty = world.root / "not-a-store"
        empty.mkdir()
        _refused(self, "baseline_exam_not_a_store", lambda: world.exam(store=empty))
        self.assertEqual(list(empty.iterdir()), [], "the exam bootstrapped a directory that is not a store")

    def test_a_path_that_does_not_exist_is_not_a_store_and_is_not_created(self) -> None:
        world = _world()
        missing = world.root / "no-such-store"
        _refused(self, "baseline_exam_not_a_store", lambda: world.exam(store=missing))
        self.assertFalse(missing.exists())

    def test_a_directory_with_a_runs_ledger_but_no_identity_is_not_a_store(self) -> None:
        world = _world()
        half = world.root / "half-a-store"
        shutil.copytree(world.store, half)
        (half / "repo_identity.json").unlink()
        before = _snapshot(half)
        _refused(self, "baseline_exam_not_a_store", lambda: world.exam(store=half))
        self.assertEqual(_snapshot(half), before)


class ReportTests(unittest.TestCase):
    def setUp(self) -> None:
        _api(self, "baseline_exam")
        self.world = _world()
        self.report = self.world.exam()

    def test_the_report_names_its_schema_and_is_plain_json(self) -> None:
        self.assertEqual(self.report["$schema"], "aria/baseline-exam/v1")
        self.assertEqual(json.loads(json.dumps(self.report, sort_keys=True)), self.report,
                         "a report that does not survive a JSON round trip (tuple, Path, ...) cannot be compared later")

    def test_the_stamp_is_the_triple_of_this_run(self) -> None:
        manifest = self.world.manifest()
        expected_hash = sha256_digest_of_canonical_json({
            "manifest": {key: value for key, value in manifest.items() if key != "legacy_claim"},
            "head_tree": self.world.tree_of(self.world.head),
        })
        self.assertEqual(self.report["stamp"], {
            "aria_sha": self.world.head, "corpus_hash": expected_hash, "provider": "none", "model": "none"})

    def test_the_same_exam_twice_gives_the_same_report(self) -> None:
        # `--against` compares a later run with an earlier one; a clock or a random id in the report
        # would make every comparison a difference.
        self.assertEqual(self.world.exam(), self.report)

    def test_the_sha_basis_says_the_run_was_declared_not_proven(self) -> None:
        # No offline read can prove which kernel executed the stored runs; slice c closes that.
        self.assertEqual(self.report["aria_sha_basis"], "in_tree_run_declared")

    def test_the_store_block_names_the_cycle_and_the_scanned_sha(self) -> None:
        self.assertEqual(self.report["store"]["cycle_id"], MAIN_CYCLE)
        self.assertEqual(self.report["store"]["scanned_sha"], self.world.head)

    def test_the_scorer_is_identified_by_the_digest_of_the_harness_file(self) -> None:
        scorer = self.report["scorer"]
        self.assertEqual(Path(scorer["path"]).name, "harness.py")
        self.assertEqual(scorer["sha256"], sha256_digest_file(_HARNESS_PATH))

    def test_every_measurement_block_carries_the_same_four_key_stamp(self) -> None:
        measurements = self.report["measurements"]
        self.assertIn("tally", measurements)
        self.assertIn("recall", measurements)
        for name, block in measurements.items():
            with self.subTest(block=name):
                self.assertEqual(block["stamp"], self.report["stamp"])
                self.assertEqual(set(block["stamp"]), {"aria_sha", "corpus_hash", "provider", "model"})

    def test_recall_is_left_unmeasured_by_name_with_its_label_and_its_contamination(self) -> None:
        recall = self.report["measurements"]["recall"]
        manifest = self.world.manifest()
        self.assertEqual(recall["status"], RECALL_STATUS)
        self.assertEqual(recall["producer"], "role_fitness.measure_discovery_recall (D9; ARIA-HIGH-758)")
        self.assertEqual(recall["label"], LABEL)
        self.assertEqual(recall["contamination"], manifest["contamination"])
        self.assertEqual(recall["n_cases"], 13)

    def test_the_cases_are_split_by_whether_a_revert_touches_a_detector(self) -> None:
        recall = self.report["measurements"]["recall"]
        manifest = self.world.manifest()
        detectors = [case["revert_sha"] for case in manifest["cases"] if case["detector"]]
        self.assertEqual(len(detectors), 4)
        self.assertEqual(recall["detector_cases"]["n"], 4)
        self.assertEqual(recall["detector_cases"]["revert_shas"], detectors)
        self.assertEqual(recall["other_cases"]["n"], 9)

    def test_no_key_anywhere_in_the_report_but_the_legacy_claim_says_hits_rate_or_verdict(self) -> None:
        # `recall` itself is the name of the block under `measurements`, so it is checked inside the block.
        unlegacy = {key: value for key, value in self.report.items() if key != "legacy_claim"}
        found = sorted(set(_walk_keys(unlegacy)) & (FORBIDDEN_RECALL_KEYS - {"recall"}))
        self.assertEqual(found, [], "the exam computed or judged a recall: only role_fitness may (ARIA-HIGH-758)")

    def test_the_recall_block_carries_no_count_of_located_cases(self) -> None:
        recall = self.report["measurements"]["recall"]
        self.assertEqual(sorted(set(_walk_keys(recall)) & FORBIDDEN_RECALL_KEYS), [])


class LegacyClaimTests(unittest.TestCase):
    """The earlier section test's 0/13 and 29/614 are carried as a claim about a different measurement:
    never comparable to a stamped number, never printed without its label and its exact interval."""

    def setUp(self) -> None:
        _api(self, "baseline_exam")
        self.world = _world()

    def _legacy(self, **kwargs: Any) -> dict[str, Any]:
        return self.world.exam(manifest=self.world.manifest(**kwargs))["legacy_claim"]

    def test_the_claim_has_no_stamp_and_is_not_comparable_to_a_stamped_number(self) -> None:
        legacy = self._legacy()
        self.assertIn("stamp", legacy)
        self.assertIsNone(legacy["stamp"])
        self.assertIs(legacy["comparable_to_stamped"], False)

    def test_the_claim_is_copied_from_the_manifest(self) -> None:
        legacy = self._legacy(legacy_tally=(MAIN_NAMED, MAIN_NOT_NAMED))
        self.assertEqual(legacy["source"], "fixture: an earlier section test")
        self.assertEqual(legacy["tally"], {"named_noise": MAIN_NAMED, "not_named_noise": MAIN_NOT_NAMED})
        self.assertEqual((legacy["recall"]["hits"], legacy["recall"]["n"]), (0, 13))

    def test_the_recall_is_labelled_and_carries_its_exact_interval(self) -> None:
        recall = self._legacy()["recall"]
        self.assertEqual(recall["label"], LABEL)
        self.assertEqual(recall["interval_exact_95"], [0.0, 0.2471])
        self.assertEqual(recall["interval_exact_95"], list(judge_calibration.exact_binomial_interval(0, 13, confidence=0.95)))

    def test_the_interval_comes_from_the_one_owner_not_from_a_formula_in_the_harness(self) -> None:
        self.assertTrue(hasattr(judge_calibration, "exact_binomial_interval"),
                        "judge_calibration.exact_binomial_interval does not exist")
        with mock.patch.object(judge_calibration, "exact_binomial_interval", return_value=(0.0, 0.5)):
            recall = self._legacy()["recall"]
        self.assertEqual(recall["interval_exact_95"], [0.0, 0.5])

    def test_the_interval_follows_the_claims_own_counts(self) -> None:
        manifest = self.world.manifest()
        manifest["legacy_claim"]["recall"] = {"hits": 2, "n": 13}
        recall = self.world.exam(manifest=manifest)["legacy_claim"]["recall"]
        self.assertEqual((recall["hits"], recall["n"]), (2, 13))
        self.assertEqual(recall["interval_exact_95"], list(judge_calibration.exact_binomial_interval(2, 13, confidence=0.95)))

    def test_the_tally_is_reproduced_when_the_system_is_the_same_and_the_counts_are_equal(self) -> None:
        legacy = self._legacy(legacy_tally=(MAIN_NAMED, MAIN_NOT_NAMED))
        self.assertIs(legacy["reproduced_from_store"]["tally"], True)

    def test_the_tally_is_not_reproduced_when_the_counts_differ(self) -> None:
        for counts in ((MAIN_NAMED - 1, MAIN_NOT_NAMED), (MAIN_NAMED, MAIN_NOT_NAMED + 1), (MAIN_NAMED + 1, MAIN_NOT_NAMED - 1),
                       (MAIN_NAMED + 1, MAIN_NOT_NAMED)):
            with self.subTest(legacy_tally=counts):
                self.assertIs(self._legacy(legacy_tally=counts)["reproduced_from_store"]["tally"], False)

    def test_the_tally_is_neither_reproduced_nor_refuted_for_another_system(self) -> None:
        # A different system's counts are not comparable (M11): null, whatever the counts are.
        for counts in ((MAIN_NAMED, MAIN_NOT_NAMED), (99, 1)):
            with self.subTest(legacy_tally=counts):
                legacy = self._legacy(legacy_tally=counts, legacy_system_sha=self.world.base)
                self.assertIsNone(legacy["reproduced_from_store"]["tally"])


class OneOwnerPerConceptTests(unittest.TestCase):
    """The harness calls the kernel's owners for a digest and an interval; it keeps no copy of either."""

    def test_the_harness_imports_no_hash_library_and_no_special_functions_of_its_own(self) -> None:
        _api(self, "baseline_exam")
        tree = ast.parse(_HARNESS_PATH.read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        self.assertFalse(imported & {"hashlib", "math", "scipy", "statistics"}, sorted(imported))


class BoardCandidateTests(unittest.TestCase):
    """R3. `baseline_exam` only SCORES. A Board candidate entry is exempt from the derived authority set,
    so a scorer must not be one: its imports have to join the set."""

    def test_the_scorers_are_not_board_candidate_entries_and_the_entries_are_unchanged(self) -> None:
        for name in ("baseline_exam", "measurement_stamp", "stamps_match"):
            self.assertTrue(callable(_api(self, name)))
        self.assertEqual(harness.BOARD_CANDIDATE_ENTRIES, ("run_cycle_acceptance", "assert_reacts_to_scenarios", "review_change"))
        for name in ("baseline_exam", "measurement_stamp", "stamps_match"):
            self.assertNotIn(name, harness.BOARD_CANDIDATE_ENTRIES)


# ════════════════════════════════════════════════════════════════════════════
# X1 — the command line
# ════════════════════════════════════════════════════════════════════════════
class BaselineExamCliTests(unittest.TestCase):
    REQUIRED = ("--store", "--cycle-id", "--repo", "--aria-sha", "--out")

    def setUp(self) -> None:
        self.world = _world()
        self.manifest = self.world.write_manifest(self.world.manifest())

    def _args(self, out: Path, **kwargs: Any) -> list[str]:
        return self.world.cli_args(out, manifest=self.manifest, **kwargs)

    def test_the_subcommand_documents_every_flag(self) -> None:
        done = _cli("--help")
        self.assertEqual(done.returncode, 0, done.stderr)
        for flag in (*self.REQUIRED, "--corpus", "--provider", "--model", "--against"):
            with self.subTest(flag=flag):
                self.assertIn(flag, done.stdout)

    def test_a_missing_required_flag_is_a_usage_error_naming_it_and_creates_nothing(self) -> None:
        for missing in self.REQUIRED:
            with self.subTest(missing=missing):
                out = self.world.fresh_out()
                argv = self._args(out)
                index = argv.index(missing)
                del argv[index: index + 2]
                before = _snapshot(self.world.store)
                done = _cli(*argv)
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                # argparse's usage line lists every flag, so only the error line can name the missing one.
                error = [line for line in done.stderr.splitlines() if "error:" in line]
                self.assertTrue(error, done.stderr)
                self.assertIn(missing, error[-1], "the usage error must name the missing flag")
                self.assertFalse(out.exists())
                self.assertEqual(_snapshot(out.parent), {})
                self.assertEqual(_snapshot(self.world.store), before)

    def test_an_existing_out_is_refused_and_its_bytes_are_unchanged(self) -> None:
        out = self.world.fresh_out()
        out.write_bytes(b"a report somebody keeps\n")
        done = _cli(*self._args(out))
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertIn("baseline_exam_out_exists", done.stdout + done.stderr)
        self.assertEqual(out.read_bytes(), b"a report somebody keeps\n")

    def test_an_out_that_is_a_dangling_symlink_is_not_written_through(self) -> None:
        # Exclusive creation: a non-exclusive write follows the link and creates its target.
        out = self.world.fresh_out()
        target = out.parent / "elsewhere.json"
        out.symlink_to(target)
        done = _cli(*self._args(out))
        self.assertNotEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("baseline_exam_out_exists", done.stdout + done.stderr)
        self.assertFalse(target.exists(), "--out was written through a link: it is not created exclusively")

    def test_an_out_inside_the_store_is_refused_and_nothing_is_created_there(self) -> None:
        store = self.world.store
        before = _snapshot(store)
        for label, out in (
            ("directly inside", store / "report.json"),
            ("in a new subdirectory", store / "reports" / "report.json"),
            ("through a parent reference", store / ".." / store.name / "report.json"),
        ):
            with self.subTest(out=label):
                done = _cli(*self._args(out))
                self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
                self.assertIn("baseline_exam_out_inside_store", done.stdout + done.stderr)
                self.assertEqual(_snapshot(store), before)

    def test_a_successful_run_writes_the_json_the_function_returns(self) -> None:
        out = self.world.fresh_out()
        done = _cli(*self._args(out))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        written = json.loads(out.read_text(encoding="utf-8"))
        in_process = _api(self, "baseline_exam")(
            store=self.world.store, cycle_id=MAIN_CYCLE, repo=self.world.repo, corpus=self.manifest,
            aria_sha=self.world.head, provider="none", model="none",
        )
        self.assertEqual(written, json.loads(json.dumps(in_process)))

    def test_without_corpus_the_committed_manifest_is_the_corpus(self) -> None:
        # The committed manifest names the real corpus head, which the fixture store was not scanned at
        # and the fixture repo does not hold: the refusal is what shows that file was read.
        out = self.world.fresh_out()
        argv = self._args(out)
        index = argv.index("--corpus")
        del argv[index: index + 2]
        done = _cli(*argv)
        output = done.stdout + done.stderr
        self.assertNotEqual(done.returncode, 0, output)
        self.assertTrue(
            "baseline_exam_store_not_scanned_at_corpus_head" in output or "baseline_exam_corpus_commit_missing" in output, output)
        self.assertFalse(out.exists())

    def test_the_provider_and_the_model_default_to_none(self) -> None:
        out = self.world.fresh_out()
        done = _cli(*self._args(out))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        stamp = json.loads(out.read_text(encoding="utf-8"))["stamp"]
        self.assertEqual((stamp["provider"], stamp["model"]), ("none", "none"))

    def test_the_legacy_zero_of_thirteen_is_never_printed_without_its_label_and_interval(self) -> None:
        out = self.world.fresh_out()
        done = _cli(*self._args(out))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        for line in (done.stdout + done.stderr).splitlines():
            if re.search(r"\b0\s*/\s*13\b", line):
                with self.subTest(line=line):
                    self.assertIn(LABEL, line)
                    self.assertIn("0.2471", line)

    # ── --against ──
    def _prior(self) -> tuple[Path, dict[str, Any]]:
        out = self.world.fresh_out("prior.json")
        done = _cli(*self._args(out))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        return out, json.loads(out.read_text(encoding="utf-8"))

    def _against(self, prior: dict[str, Any]) -> tuple[subprocess.CompletedProcess[str], Path]:
        prior_path = self.world.fresh_out("edited-prior.json")
        prior_path.write_text(json.dumps(prior), encoding="utf-8")
        out = self.world.fresh_out()
        return _cli(*self._args(out), "--against", str(prior_path)), out

    def test_the_same_exam_twice_reproduces(self) -> None:
        prior_path, _ = self._prior()
        out = self.world.fresh_out()
        done = _cli(*self._args(out), "--against", str(prior_path))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertRegex(done.stdout + done.stderr, r"reproduced\W+true")

    def test_the_same_triple_with_a_different_count_exits_one_naming_the_block(self) -> None:
        _, prior = self._prior()
        prior["measurements"]["tally"]["raw_findings"] = 987654
        done, _ = self._against(prior)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        output = done.stdout + done.stderr
        self.assertRegex(output, r"reproduced\W+false")
        self.assertIn("tally", output)

    def test_a_different_recall_block_is_named_as_the_one_that_differs(self) -> None:
        _, prior = self._prior()
        prior["measurements"]["recall"]["n_cases"] = 99
        done, _ = self._against(prior)
        self.assertEqual(done.returncode, 1, done.stdout + done.stderr)
        output = done.stdout + done.stderr
        self.assertIn("recall", output)
        self.assertNotIn("tally", output, "only the block that differs is named")

    def test_a_prior_with_another_stamp_is_exit_two_and_no_number_is_compared(self) -> None:
        _, prior = self._prior()
        # Distinct numbers on the prior's side: none of them may appear in a comparison that must not happen.
        prior["measurements"]["tally"]["raw_findings"] = 987654321
        prior["measurements"]["tally"]["named_noise"] = 7654321
        variants = {
            "corpus_hash": {"corpus_hash": "sha256:" + "9" * 64},
            "aria_sha": {"aria_sha": "d" * 40},
            "provider and model": {"provider": "anthropic", "model": "opus"},
        }
        for label, change in variants.items():
            with self.subTest(differs=label):
                edited = json.loads(json.dumps(prior))
                edited["stamp"] = {**edited["stamp"], **change}
                done, out = self._against(edited)
                output = done.stdout + done.stderr
                self.assertEqual(done.returncode, 2, output)
                self.assertIn("baseline_exam_stamps_differ", output)
                for field in change:
                    self.assertIn(field, output, "the differing field is named")
                for token in ("987654321", "7654321", "reproduced", "raw_findings", "named_noise"):
                    self.assertNotIn(token, output, "a number or a verdict was printed for unequal triples")

    def test_against_does_not_excuse_an_existing_out(self) -> None:
        prior_path, _ = self._prior()
        existing = self.world.fresh_out()
        existing.write_text("kept", encoding="utf-8")
        done = _cli(*self._args(existing), "--against", str(prior_path))
        self.assertEqual(done.returncode, 2, done.stdout + done.stderr)
        self.assertEqual(existing.read_text(encoding="utf-8"), "kept")


if __name__ == "__main__":
    unittest.main()
