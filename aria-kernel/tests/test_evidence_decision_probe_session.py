"""Every cycle-side evidence decision runs on ONE git-probe session.

`classify_evidence_ref` grades one ref; a decision grades many — a belief
with N refs, a finding with N evidences, an expert panel with N reviewers'
refs, a debt's action ref. The acceptance validator threads one
`GitProbeSession` through a submission so the baseline is resolved once and
every probe shares one liveness clock (`test_evidence_probe_session`). The
cycle-side callers did not: each ref got a fresh session, so a decision over
N refs resolved its baseline N times and, on a git that had stopped
answering, paid N full retry arcs (up to ~93 s each) before it was reached.

Pinned here for each decision: over N refs the baseline probe
(`git rev-parse --verify <target>^{commit}`) is spawned exactly once, and
every ref reaches the classifier with the same session object.
"""
from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import evidence_probe
from aria_kernel.debt import _validate_short_term_action
from aria_kernel.expert_review_gate import evaluate_expert_consensus
from aria_kernel.finding import _normalize_evidences, _target_sha
from aria_kernel.evidence_probe import GitProbeSession
from aria_kernel.memory import validate_repo_evidence


def _repo_with_files(root: Path, names: tuple[str, ...]) -> str:
    def git(*args: str) -> str:
        return subprocess.run(
            ["git", *args], cwd=str(root), text=True, capture_output=True, check=True,
        ).stdout.strip()

    git("init", "-q")
    git("config", "user.email", "t@example.invalid")
    git("config", "user.name", "t")
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"// {name}\nline two\n", encoding="utf-8")
    git("add", *names)
    git("commit", "-qm", "seed")
    return git("rev-parse", "HEAD")


class _ProbeSpy:
    """Counts the git probes the decision spawned and the sessions it used."""

    def __enter__(self) -> "_ProbeSpy":
        self.rev_parses = 0
        self.sessions: list[GitProbeSession | None] = []
        real_run = evidence_probe.subprocess.run

        def counting_run(argv, **kwargs):
            if argv[:2] == ["git", "rev-parse"]:
                self.rev_parses += 1
            return real_run(argv, **kwargs)

        self._run = mock.patch.object(evidence_probe.subprocess, "run", side_effect=counting_run)
        self._run.start()
        return self

    def spy_classifier(self, module: str) -> mock._patch:
        """Patch ``<module>.classify_evidence_ref`` to record the session each
        ref was graded with."""
        from aria_kernel.evidence_trust import classify_evidence_ref as real_classify

        def recording(ref, **kwargs):
            self.sessions.append(kwargs.get("probe_session"))
            return real_classify(ref, **kwargs)

        return mock.patch(f"{module}.classify_evidence_ref", new=recording)

    def __exit__(self, *exc: object) -> None:
        self._run.stop()

    def assert_one_session_over(self, test: unittest.TestCase, refs: int) -> None:
        test.assertEqual(self.rev_parses, 1, "the baseline must be resolved once per decision")
        test.assertEqual(len(self.sessions), refs)
        test.assertTrue(all(s is not None for s in self.sessions), "every ref carries the session")
        test.assertEqual(len({id(s) for s in self.sessions}), 1, "one session, not one per ref")


class OneProbeSessionPerDecision(unittest.TestCase):
    REFS = ("src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts")

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-decision-session-"))
        self.sha = _repo_with_files(self.root, self.REFS)

    def tearDown(self) -> None:
        shutil.rmtree(self.root, ignore_errors=True)

    def test_a_belief_over_n_refs_resolves_its_baseline_once(self) -> None:
        with _ProbeSpy() as spy, spy.spy_classifier("aria_kernel.memory"):
            validate_repo_evidence([f"{ref}:1" for ref in self.REFS], workspace_root=self.root)
        spy.assert_one_session_over(self, len(self.REFS))

    def test_a_finding_over_n_evidences_resolves_its_baseline_once(self) -> None:
        # The emitting decision resolves HEAD through its session and then
        # grades every evidence against the id it got back: one probe for
        # the baseline, none for the id that was just resolved.
        evidences = [{"ref": f"{ref}:1", "summary": ref} for ref in self.REFS]
        with _ProbeSpy() as spy, spy.spy_classifier("aria_kernel.finding"):
            session = GitProbeSession()
            target_sha = _target_sha(self.root, session)
            normalized = _normalize_evidences(
                self.root, evidences, target_sha=target_sha, probe_session=session,
            )
        self.assertEqual(target_sha, self.sha)
        self.assertEqual(
            [row["evidence_envelope"]["trust_grade"] for row in normalized],
            ["repo_verified"] * len(self.REFS),
        )
        spy.assert_one_session_over(self, len(self.REFS))

    def test_the_finding_target_sha_is_a_bounded_probe(self) -> None:
        # The unbounded `git rev-parse HEAD` is gone: the resolution runs
        # through the session and an answer that is not a readable commit
        # is a governance refusal naming why, not a hang or a bare failure.
        from aria_kernel.tool_registry import GovernanceError

        plain = Path(tempfile.mkdtemp(prefix="aria-decision-norepo-"))
        try:
            with mock.patch.dict("os.environ", {"GIT_CEILING_DIRECTORIES": str(plain.parent)}):
                with self.assertRaisesRegex(
                    GovernanceError, "finding_evidence_target_sha_unavailable: baseline_unreachable",
                ):
                    _target_sha(plain, GitProbeSession())
        finally:
            shutil.rmtree(plain, ignore_errors=True)

    def test_an_expert_panel_over_n_refs_resolves_its_baseline_once(self) -> None:
        verdicts = [
            {"expert": "security-reviewer", "verdict": "satisfied", "confidence": 0.9,
             "evidence_refs": [f"{self.REFS[0]}:1", f"{self.REFS[1]}:1"]},
            {"expert": "architectural-arbiter", "verdict": "satisfied", "confidence": 0.9,
             "evidence_refs": [f"{self.REFS[2]}:1", f"{self.REFS[3]}:1"]},
        ]
        with _ProbeSpy() as spy, spy.spy_classifier("aria_kernel.expert_review_gate"):
            result = evaluate_expert_consensus(
                verdicts=verdicts, workspace_root=self.root, base_sha=self.sha,
            )
        self.assertTrue(result["approved"], result)
        spy.assert_one_session_over(self, len(self.REFS))

    def test_a_debt_action_is_graded_with_the_decisions_session(self) -> None:
        # One ref today; the session is the emitting decision's, passed in,
        # so a second ref would share it rather than mint its own.
        session = GitProbeSession()
        action = {"kind": "test_added", "ref": f"{self.REFS[0]}:1",
                  "rationale": "Regression test asserts the guard"}
        with _ProbeSpy() as spy, spy.spy_classifier("aria_kernel.debt"):
            stamped = _validate_short_term_action(
                action, repo_root=self.root, probe_session=session,
            )
            _validate_short_term_action(
                {**action, "ref": f"{self.REFS[1]}:1"}, repo_root=self.root,
                probe_session=session,
            )
        self.assertEqual(stamped["ref_evidence_envelope"]["trust_grade"], "repo_verified")
        self.assertEqual(spy.rev_parses, 1)
        self.assertEqual(spy.sessions, [session, session])

    def test_the_emitting_decisions_construct_one_session_each(self) -> None:
        # Source pin for the two emitters whose full call needs a workspace
        # and a ledger: each constructs exactly one session and threads it.
        import inspect

        from aria_kernel import debt, finding

        emit_finding_source = inspect.getsource(finding.emit_finding)
        self.assertEqual(emit_finding_source.count("GitProbeSession()"), 1)
        self.assertIn("probe_session=probe_session", emit_finding_source)
        emit_debt_source = inspect.getsource(debt.emit_debt)
        self.assertEqual(emit_debt_source.count("GitProbeSession()"), 1)


if __name__ == "__main__":
    unittest.main()
