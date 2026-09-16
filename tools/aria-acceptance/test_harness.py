#!/usr/bin/env python3
"""Tests for the ARIA acceptance harness (Plan 030).

The drift classifier is the deterministic truth gate; these tests pin its TP/FP/
unverifiable verdicts. The cycle + scenario checks are exercised as integration
smoke tests (they drive the real kernel in an isolated temp dir)."""
from __future__ import annotations

import importlib.util
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_HARNESS = Path(__file__).with_name("harness.py")
_spec = importlib.util.spec_from_file_location("aria_acceptance_harness", _HARNESS)
assert _spec and _spec.loader
harness = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = harness
_spec.loader.exec_module(harness)

from aria_kernel.evidence_probe import GitProbeSession  # noqa: E402 — path set by harness


def _drift_fixture_repo(root: Path) -> None:
    """A committed `a.ts` + `b.sql` — the harness verifies refs against HEAD,
    so its fixture must BE a repository with a HEAD (the same lesson
    `harness._git_init_fixture` records for the cycle check): a bare
    directory has no baseline to read, and the classifier now says so
    (`verification_unavailable`) instead of grading the files worktree_candidate."""
    (root / "a.ts").write_text("x\n", encoding="utf-8")
    (root / "b.sql").write_text("y\n", encoding="utf-8")
    harness._git_init_fixture(root)


class _StalledGit:
    """A `git` on PATH that never answers — the loaded-host shape.

    ``stall_when_argv_contains`` limits the stall to invocations whose argv
    carries that text (one path's `git show`); without it every invocation
    stalls. The sleeper is exec'd so the probe's timeout kills it directly.
    """

    def __init__(self, *, stall_when_argv_contains: str | None = None) -> None:
        self._needle = stall_when_argv_contains

    def __enter__(self) -> "_StalledGit":
        real_git = shutil.which("git")
        assert real_git, "a real git is required to script one"
        self._dir = Path(tempfile.mkdtemp(prefix="aria-acceptance-fake-git-"))
        fake = self._dir / "git"
        if self._needle is None:
            script = "#!/bin/sh\nexec sleep 5\n"
        else:
            script = (
                "#!/bin/sh\n"
                f'case "$*" in *"{self._needle}"*) exec sleep 5 ;; esac\n'
                f'exec "{real_git}" "$@"\n'
            )
        fake.write_text(script, encoding="utf-8")
        fake.chmod(fake.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        self._env = mock.patch.dict(
            os.environ, {"PATH": f"{self._dir}{os.pathsep}{os.environ.get('PATH', '')}"},
        )
        self._env.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._env.stop()
        shutil.rmtree(self._dir, ignore_errors=True)


def _short_session() -> GitProbeSession:
    """A probe session that gives up on a stall in well under a second — the
    real parameter the harness threads, sized for a test."""
    return GitProbeSession(
        attempt_timeout_seconds=0.2, attempts=2, backoff_seconds=(0.01,), liveness_seconds=5.0,
    )


class DriftClassifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        _drift_fixture_repo(self.repo)
        self.session = GitProbeSession()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_true_positive(self) -> None:
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": []}
        verdict, _ = harness._classify_drift(d, self.repo, self.session)
        self.assertEqual(verdict, "true_positive")

    def test_false_positive_no_value_difference(self) -> None:
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": [], "missing_in_sql": [], "existing_gate_refs": []}
        verdict, _ = harness._classify_drift(d, self.repo, self.session)
        self.assertEqual(verdict, "false_positive")

    def test_false_positive_already_gated(self) -> None:
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": ["tests/x.ts:1 (Status)"]}
        verdict, _ = harness._classify_drift(d, self.repo, self.session)
        self.assertEqual(verdict, "false_positive")

    def test_unverifiable_when_ref_missing(self) -> None:
        d = {"ts": {"ref": "ghost.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": []}
        verdict, reason = harness._classify_drift(d, self.repo, self.session)
        self.assertEqual(verdict, "unverifiable")
        self.assertIn("not resolvable", reason)

    def test_a_git_that_does_not_answer_is_the_hosts_gap_not_arias(self) -> None:
        # Both refs are real committed files; the host's git stalls. Before
        # this change the drift graded `unverifiable` — ARIA billed for
        # citing evidence that "does not resolve" while nothing was compared.
        d = {"ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": []}
        with _StalledGit():
            verdict, reason = harness._classify_drift(d, self.repo, _short_session())
        self.assertEqual(verdict, "verification_unavailable")
        self.assertIn("could not verify", reason)

    def test_a_fabricated_ref_stays_arias_even_beside_a_stalled_probe(self) -> None:
        # One ref the tree does not carry, the other unprobeable: the
        # fabricated one is ARIA's whichever way the host behaved.
        d = {"ts": {"ref": "ghost.ts:1"}, "sql": {"ref": "b.sql:1"},
             "missing_in_ts": ["archived"], "existing_gate_refs": []}
        with _StalledGit(stall_when_argv_contains="b.sql"):
            verdict, _ = harness._classify_drift(d, self.repo, _short_session())
        self.assertEqual(verdict, "unverifiable")


class ZeroSampleVerdictTests(unittest.TestCase):
    """A check that examined nothing must never report success.

    Measured gap: `validate_drift_output` collapsed "ARIA cited no bad
    evidence" and "ARIA emitted nothing" into one `passed` flag, so the truth
    layer of the acceptance lane printed `[PASS] checked=0 TP=0 FP=0` — a
    green produced by an empty sample. These tests pin the three states apart.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        _drift_fixture_repo(self.repo)
        self._real_run_poc = harness._run_poc

    def tearDown(self) -> None:
        harness._run_poc = self._real_run_poc
        self._tmp.cleanup()

    def _with_artifact(self, artifact: dict, session: GitProbeSession | None = None) -> dict:
        harness._run_poc = lambda repo_root, out_dir: artifact
        return harness.validate_drift_output(repo_root=self.repo, probe_session=session)

    def test_empty_output_is_inconclusive_not_pass(self) -> None:
        r = self._with_artifact({"drifts_above_threshold": []})
        self.assertEqual(r["verdict"], "inconclusive")
        self.assertFalse(r["passed"], "an empty sample must not set the ACCEPT flag")
        self.assertIsNone(r["fp_rate"], "no sample means no rate, not a rate of 0.0")

    def test_sub_threshold_signal_alone_is_a_sample(self) -> None:
        # Nothing crossed the threshold, but ARIA did emit something whose
        # evidence can be verified — that is a measurement, not a blank.
        r = self._with_artifact({
            "drifts_above_threshold": [],
            "frontend_dropdown_drifts": [
                {"concept": "x", "ui": {"ref": "a.ts:1"}, "source": {"ref": "b.sql:1"}}
            ],
        })
        self.assertEqual(r["verdict"], "pass")
        self.assertEqual(r["unexamined_signals"], 1)
        self.assertEqual(r["unresolved_refs"], [])

    def test_unresolvable_sub_threshold_ref_fails(self) -> None:
        # A fabricated ref is a fabricated ref at any Jaccard score; scoping
        # the integrity sweep to above-threshold drifts is what let three of
        # four emitted signals go unexamined.
        r = self._with_artifact({
            "drifts_above_threshold": [],
            "drifts_filtered_below_threshold": [
                {"concept": "x", "ts": {"ref": "ghost.ts:1"}, "sql": {"ref": "b.sql:1"}}
            ],
        })
        self.assertEqual(r["verdict"], "fail")
        self.assertFalse(r["passed"])
        self.assertEqual(len(r["unresolved_refs"]), 1)


class HostUnavailableVerdictTests(unittest.TestCase):
    """A host that could not answer is not ARIA citing unresolvable evidence.

    Measured gap: `_ref_resolvable` folded the kernel's
    `verification_unavailable` grade into "not resolvable", so a stalled git
    on the CI runner became an `unverifiable` drift, entered fp_rate, and
    flipped `clean` — the lane's REJECT read as ARIA misconduct. The verdict
    is now its own outcome, outside fp_rate and `clean`; a run in which
    nothing could be measured is inconclusive, like the empty sample.
    """

    _DRIFT_A = {"concept": "a", "ts": {"ref": "a.ts:1"}, "sql": {"ref": "b.sql:1"},
                "missing_in_ts": ["archived"], "existing_gate_refs": []}

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self._tmp.name)
        _drift_fixture_repo(self.repo)
        (self.repo / "c.ts").write_text("z\n", encoding="utf-8")
        subprocess.run(["git", "add", "c.ts"], cwd=self.repo, check=True, capture_output=True)
        subprocess.run(
            ["git", "-c", "user.name=t", "-c", "user.email=t@acceptance.local",
             "commit", "--quiet", "-m", "c"],
            cwd=self.repo, check=True, capture_output=True,
        )
        self._real_run_poc = harness._run_poc

    def tearDown(self) -> None:
        harness._run_poc = self._real_run_poc
        self._tmp.cleanup()

    def _run(self, artifact: dict, session: GitProbeSession) -> dict:
        harness._run_poc = lambda repo_root, out_dir: artifact
        return harness.validate_drift_output(repo_root=self.repo, probe_session=session)

    def test_nothing_measurable_is_inconclusive_and_never_billed_to_aria(self) -> None:
        with _StalledGit():
            r = self._run({"drifts_above_threshold": [self._DRIFT_A]}, _short_session())
        self.assertEqual(r["verification_unavailable"], 1)
        self.assertEqual((r["true_positive"], r["false_positive"], r["unverifiable"]), (0, 0, 0))
        self.assertIsNone(r["fp_rate"], "an unmeasured drift is not a rate")
        self.assertEqual(r["measured"], 0)
        self.assertEqual(r["verdict"], "inconclusive")
        self.assertEqual(r["inconclusive_reason"], "verification_unavailable")
        self.assertFalse(r["passed"])
        self.assertEqual(r["details"][0]["verdict"], "verification_unavailable")

    def test_an_unprobeable_drift_leaves_the_measured_sample_untouched(self) -> None:
        # One drift the host answers (a true positive), one it cannot probe.
        # The measured half decides the verdict; the other half is reported
        # beside it and enters neither fp_rate nor `clean`.
        drift_c = {"concept": "c", "ts": {"ref": "c.ts:1"}, "sql": {"ref": "b.sql:1"},
                   "missing_in_ts": ["archived"], "existing_gate_refs": []}
        with _StalledGit(stall_when_argv_contains="c.ts"):
            r = self._run(
                {"drifts_above_threshold": [self._DRIFT_A, drift_c]}, _short_session(),
            )
        self.assertEqual(r["true_positive"], 1)
        self.assertEqual(r["verification_unavailable"], 1)
        self.assertEqual(r["fp_rate"], 0.0)
        self.assertEqual(r["measured"], 1)
        self.assertEqual(r["verdict"], "pass")
        self.assertTrue(r["passed"])

    def test_an_unprobeable_sub_threshold_ref_is_listed_apart_from_unresolved(self) -> None:
        artifact = {
            "drifts_above_threshold": [self._DRIFT_A],
            "drifts_filtered_below_threshold": [
                {"concept": "x", "ts": {"ref": "c.ts:1"}, "sql": {"ref": "b.sql:1"}},
            ],
        }
        with _StalledGit(stall_when_argv_contains="c.ts"):
            r = self._run(artifact, _short_session())
        self.assertEqual(r["unresolved_refs"], [])
        self.assertEqual(len(r["unavailable_refs"]), 1)
        self.assertEqual(r["unavailable_refs"][0]["trust_grade"], "verification_unavailable")
        self.assertEqual(r["verdict"], "pass", "the host's gap must not flip clean")

    def test_the_run_threads_one_probe_session_through_every_ref(self) -> None:
        sessions: list[object] = []
        real_classify = harness.classify_evidence_ref

        def spy(ref, **kwargs):
            sessions.append(kwargs.get("probe_session"))
            return real_classify(ref, **kwargs)

        artifact = {
            "drifts_above_threshold": [self._DRIFT_A],
            "frontend_dropdown_drifts": [
                {"concept": "y", "ui": {"ref": "c.ts:1"}, "source": {"ref": "b.sql:1"}},
            ],
        }
        session = GitProbeSession()
        with mock.patch.object(harness, "classify_evidence_ref", new=spy):
            r = self._run(artifact, session)
        self.assertEqual(r["verdict"], "pass")
        self.assertEqual(len(sessions), 4)
        self.assertTrue(all(s is session for s in sessions))


class CycleFixtureTests(unittest.TestCase):
    """The acceptance fixture must be a git repository.

    Measured gap: the fixture was a bare directory, so `experiment_night`
    failed with `experiment_night_head_sha_unavailable`, the cycle terminated
    'failed', and the harness returned REJECT unconditionally — for a reason
    that said nothing about ARIA.
    """

    def test_fixture_workspace_has_a_resolvable_head_sha(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            ws = Path(td) / "workspace"
            (ws / "src").mkdir(parents=True)
            (ws / "src" / "app.ts").write_text("export const app = true;\n", encoding="utf-8")
            harness._git_init_fixture(ws)
            head = subprocess.run(
                ["git", "rev-parse", "HEAD"], cwd=ws, capture_output=True, text=True, check=True
            )
            self.assertRegex(head.stdout.strip(), r"^[0-9a-f]{40}$")


class ScenarioReactionTests(unittest.TestCase):
    def test_aria_reacts_to_all_scenarios(self) -> None:
        result = harness.assert_reacts_to_scenarios()
        self.assertTrue(result["passed"], result["scenarios"])


class CycleAcceptanceTests(unittest.TestCase):
    def test_isolated_cycle_closes_and_keeps_ledger_valid(self) -> None:
        result = harness.run_cycle_acceptance()
        # ARIA-AUDIT-025: only 'completed' is a passing terminal state; the
        # oracle must not green-pin a failed cycle that behaved structurally.
        self.assertEqual(
            result["cycle_status"], "completed", result.get("failed_phases")
        )
        self.assertTrue(
            result["passed"],
            "a completed cycle with intact phase keys + ledger must pass",
        )


class ScorecardPersistenceTests(unittest.TestCase):
    """SI-0 — persistence is the DEFAULT, opt-out is explicit.

    Measured gap: eight days of "continuous" acceptance measurement
    produced zero scorecard artifacts, because persistence hid behind an
    opt-in flag nobody passed. A measurement nobody can read later is a
    claim, not a measurement.
    """

    def test_default_invocation_names_a_dated_scorecard(self) -> None:
        import re

        source = (Path(harness.__file__)).read_text(encoding="utf-8")
        self.assertIn('"acceptance"', source)
        self.assertIn("--no-artifact", source)
        # The default path is derived from _REPO_ROOT (repo-relative), so
        # the artifact lands beside the daily reports wherever the
        # checkout lives — never at an ambient cwd.
        self.assertTrue(
            re.search(r'_REPO_ROOT\s*/\s*"aria-tools"\s*/\s*"reports"\s*/\s*"acceptance"', source),
            "default scorecard path must derive from _REPO_ROOT",
        )

    def test_no_artifact_flag_suppresses_persistence(self) -> None:
        # The flag is the ONLY way to run without a scorecard; its absence
        # plus no --json-out must resolve to the dated default.
        import argparse

        source = (Path(harness.__file__)).read_text(encoding="utf-8")
        self.assertIn("if json_out is None and not args.no_artifact:", source)


if __name__ == "__main__":
    unittest.main()
