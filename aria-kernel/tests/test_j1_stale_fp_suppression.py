"""J1 (ARIA-MEDIUM-783) — ground-truth suppression goes stale when the cited code changes.

A false-positive ANCHOR suppresses every later finding with its fingerprint
(`_confirmed_false_positive_fingerprints`, read by the raw-findings writer,
the findings writer, the sampler and judge liveness). Before J1 it did so
forever: the verdict judged code at one commit and kept suppressing after
that code changed, so a real defect introduced into the same lines was
filed as `suppressed_false_positive` and never shown to a judge again.

The rule (SEPT-HARVEST J1): a verdict holds only while the evidence it
judged is unchanged, and when that is unknown the finding is NOT suppressed.

* At consensus mint the anchor row is stamped with ``cited_code_hash`` —
  ``evidence_trust.cited_blobs_code_hash`` over the row's ``evidence_refs``
  at its ``target_sha``. That is the one blob law the verdict cache
  (``judgment_cache``) keys on; J1 adds no second owner.
* The suppression read honours an anchor only while the same law, applied
  to the store's declared workspace (``tool_registry.declared_bound_repo_root``)
  at its current HEAD, yields the stamped hash.
* No stamp (a legacy anchor), a cited blob git cannot read, or a git that
  does not answer is "unknown": the finding is offered, not suppressed.

Pins (all on the production writers, against a real fixture repository):
the mint stamp (a new field the spec introduces), a changed citation, a
legacy stampless anchor, an unreadable blob, a silent git; and the positive
control — an unchanged citation, with HEAD moved by an unrelated commit,
still suppresses.
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel.evidence_trust import cited_blobs_code_hash
from aria_kernel.feedback_store import (
    ANCHOR_MIN_JUDGE_COUNT,
    _confirmed_false_positive_fingerprints,
    finding_fingerprint,
    generate_ai_consensus,
    is_ground_truth_row,
    raw_findings_path,
    record_operator_feedback,
    record_raw_findings_for_run,
)
from aria_kernel.ledger import load_jsonl
from aria_kernel.tool_registry import ensure_tools_binding
from tests._helpers.git_fixtures import commit_files, make_local_git_repo

TOOL = "tool-a"
CITED = "src/f-1.ts"
CITED_REF = f"{CITED}:10"
FINDING = {
    "id": "F-1",
    "rule": "no-dead-branch",
    "path": CITED,
    "line": 10,
    "message": "branch is never taken",
    "evidence": [{"path": CITED, "line": 10}],
}
JUDGES = ("aria-evidence-judge", "aria-adversarial-judge", "aria-consensus-arbiter")


def _source(marker: str) -> str:
    return "".join(f"export const line{n} = '{marker}';\n" for n in range(1, 13))


class StaleFalsePositiveSuppressionTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-j1-")
        tmp = Path(self._tmp.name)
        self.repo = make_local_git_repo(tmp, name="repo")
        self.sha1 = commit_files(self.repo, {CITED: _source("judged")}, message="fixture: the judged code")
        self.tools = ensure_tools_binding(tmp / "store" / "aria-tools", workspace_root=self.repo)
        self.fingerprint = finding_fingerprint(TOOL, FINDING)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # -- fixture writers (production producers only) ------------------------

    def _mint_anchor(self) -> dict:
        """Three agreeing seats at sha1 settle a false-positive ANCHOR."""
        for index, judge_id in enumerate(JUDGES):
            record_operator_feedback(
                tool_id=TOOL,
                run_id="run-1",
                finding_id="F-1",
                verdict="false_positive",
                severity="high",
                note=f"{judge_id} reading {index}: the branch guard at line 10 is unreachable here",
                source_type="ai_judge",
                judge_id=judge_id,
                model="claude-opus-5" if index < 2 else "fable",
                confidence=0.95,
                evidence_refs=[CITED_REF],
                judgment_group_id=f"judge:{TOOL}:F-1",
                finding_fingerprint=self.fingerprint,
                target_sha=self.sha1,
                base_dir=self.tools,
            )
        result = generate_ai_consensus(tool_id=TOOL, base_dir=self.tools, workspace_root=self.repo)
        anchors = [row for row in result["consensus"] if is_ground_truth_row(row)]
        self.assertEqual(len(anchors), 1, f"fixture must mint exactly one anchor: {result}")
        return anchors[0]

    def _record_run(self, run_id: str = "run-2") -> dict:
        record_raw_findings_for_run(
            {"tool_id": TOOL, "run_id": run_id, "cycle_id": "cyc-2", "status": "ok"},
            [dict(FINDING)],
            base_dir=self.tools,
        )
        rows = [row for row in load_jsonl(raw_findings_path(self.tools)) if row.get("run_id") == run_id]
        self.assertEqual(len(rows), 1)
        return rows[0]

    def _assert_not_suppressed(self, why: str) -> None:
        self.assertNotIn(self.fingerprint, _confirmed_false_positive_fingerprints(self.tools), why)
        row = self._record_run()
        self.assertEqual(row["status"], "raw", why)
        self.assertIsNone(row["suppressed_by_feedback"], why)

    # -- the mint stamp (new field, J1 API pin) -----------------------------

    def test_mint_stamps_cited_code_hash_through_the_one_blob_law(self) -> None:
        anchor = self._mint_anchor()
        self.assertEqual(anchor["target_sha"], self.sha1)
        expected = cited_blobs_code_hash(self.repo, [CITED_REF], self.sha1)
        self.assertIsNotNone(expected)
        self.assertEqual(
            anchor.get("cited_code_hash"), expected,
            "the anchor must carry the code identity it judged, computed by "
            "evidence_trust.cited_blobs_code_hash (the verdict cache's law)",
        )

    # -- positive control ---------------------------------------------------

    def test_an_unchanged_citation_still_suppresses(self) -> None:
        """HEAD moves (unrelated file), the cited blob does not: the anchor holds."""
        self._mint_anchor()
        commit_files(self.repo, {"src/other.ts": "export const other = 1;\n"}, message="fixture: unrelated")
        self.assertIn(self.fingerprint, _confirmed_false_positive_fingerprints(self.tools))
        row = self._record_run()
        self.assertEqual(row["status"], "suppressed_false_positive")

    # -- red: the defect ----------------------------------------------------

    def test_a_changed_citation_no_longer_suppresses(self) -> None:
        """SEPT-HARVEST J1's test: FP anchor at sha1, cited file changed at
        sha2 -> the sha2 finding is `raw`, not `suppressed_false_positive`."""
        self._mint_anchor()
        commit_files(self.repo, {CITED: _source("rewritten")}, message="fixture: the cited code changes")
        self._assert_not_suppressed("the anchor judged code that no longer exists at HEAD")

    def test_a_legacy_anchor_without_a_stamp_does_not_suppress(self) -> None:
        """An anchor written before J1 cannot say what code it judged."""
        legacy = record_operator_feedback(
            tool_id=TOOL,
            run_id="run-1",
            finding_id="F-1",
            verdict="false_positive",
            severity="high",
            note="legacy anchor",
            source_type="ai_consensus",
            judge_id="aria-consensus-arbiter",
            confidence=0.95,
            evidence_refs=[CITED_REF],
            judgment_group_id=f"judge:{TOOL}:F-1",
            finding_fingerprint=self.fingerprint,
            judge_count=ANCHOR_MIN_JUDGE_COUNT,
            judges_voted=ANCHOR_MIN_JUDGE_COUNT,
            observers=[{"judge_id": judge_id, "model": "claude-opus-5"} for judge_id in JUDGES],
            target_sha=self.sha1,
            base_dir=self.tools,
        )
        self.assertTrue(is_ground_truth_row(legacy), "precondition: the row is an anchor")
        self.assertNotIn("cited_code_hash", legacy, "precondition: the row carries no stamp")
        self._assert_not_suppressed("no stamp means the judged code is unknown")

    def test_an_unreadable_cited_blob_does_not_suppress(self) -> None:
        """HEAD unchanged, but git can no longer read the cited blob."""
        self._mint_anchor()
        blob = subprocess.run(
            ["git", "rev-parse", f"HEAD:{CITED}"], cwd=self.repo,
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        loose = self.repo / ".git" / "objects" / blob[:2] / blob[2:]
        self.assertTrue(loose.is_file(), "precondition: the fixture blob is a loose object")
        loose.unlink()
        self._assert_not_suppressed("a blob git cannot read is not evidence the code is unchanged")

    def test_a_git_that_does_not_answer_leaves_the_anchor_unknown(self) -> None:
        """No git on PATH: the current code identity is unknown, not 'same'."""
        self._mint_anchor()
        no_git = Path(self._tmp.name) / "empty-path"
        no_git.mkdir()
        with mock.patch.dict(os.environ, {"PATH": str(no_git)}):
            self._assert_not_suppressed("unknown current code must never suppress")


if __name__ == "__main__":
    unittest.main()
