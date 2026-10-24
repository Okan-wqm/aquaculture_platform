"""PV-R5 — the root the appellate accepted against the R19-R21 round
(/root/aria-handover/2026-10-21/build/PV-R4/appellate-final.json, R23):

* R23 a git failure on a commit the checkout holds is not "no such file".
  ``workspace_view.commit_blob_paths`` answers a commit's whole path set
  through one ``git ls-tree``: a path names a blob only when git lists a
  blob entry of exactly that path, and git failing to read the commit's
  tree raises ``WorkspaceViewRefused('workspace_commit_unreadable:…')``.
  Read as False, a checkout fault was parked as the ledger fact
  ``plan_verdict_path_refused`` at freshness and refused as
  ``evidence_ref_not_in_reviewed_tree`` at record.

Source: SPEC.md (PV P1, P3); finding ARIA-HIGH-779.
"""
from __future__ import annotations

import unittest
from unittest import mock

from aria_kernel import workspace_view
from aria_kernel.plan_convergence import fold_plan_state, plan_verdict_staleness, start_plan
from aria_kernel.tool_registry import GovernanceError
from aria_kernel.workspace_view import WorkspaceViewRefused
from tests.test_plan_verdict_integrity import (
    PLAN_EVIDENCE,
    RISK_EVIDENCE_FILE,
    SURFACE,
    UNRELATED,
    _git,
    _PlanFixture,
    _risk,
    _terminal,
)
from tests.test_plan_verdict_roots_r2 import _event_count
from tests.test_plan_verdict_roots_r4 import UNVERIFIABLE, _DeliveryReading

COMMIT_UNREADABLE = "workspace_commit_unreadable"
FEED = "apps/farm-service/src/feed"
LITERAL_ID = f"{FEED}/[id].ts"
MANY = 1000


def _drop_root_tree(case: _PlanFixture, commit: str) -> None:
    """The commit stays held; its root tree object is gone (a partial or damaged object store)."""
    tree = _git(case.repo, "rev-parse", f"{commit}^{{tree}}")
    loose = case.repo / ".git" / "objects" / tree[:2] / tree[2:]
    case.assertTrue(loose.is_file(), loose)
    loose.unlink()


def _ls_tree_calls(calls: mock.MagicMock) -> int:
    return sum(1 for call in calls.call_args_list if "ls-tree" in call.args)


class R23AnUnreadableTreeIsTheCheckoutsFault(_DeliveryReading):
    """EV-R4R2-B2: `cat-file -t <commit>:<path>` exit 128 read as "no blob" for a missing tree."""

    def _move_head_past_a(self) -> None:
        # HEAD moves on, so dropping A's root tree leaves HEAD's tree whole.
        self.commit(UNRELATED, "export const leave = 2;\n")

    def test_the_call_raises_for_a_held_commit_whose_tree_git_cannot_read(self) -> None:
        self._move_head_past_a()
        _drop_root_tree(self, self.commit_a)
        self.assertEqual(_git(self.repo, "cat-file", "-t", self.commit_a), "commit")
        with self.assertRaisesRegex(WorkspaceViewRefused, f"{COMMIT_UNREADABLE}:{self.commit_a}:git_exit_128"):
            workspace_view.commit_blob_paths(self.repo, self.commit_a, {SURFACE})

    def test_staleness_withholds_it_uncounted_and_the_plan_stays_converged(self) -> None:
        self.converged_at_a([_risk("CR-001", "nice_to_have", evidence_refs=[f"{RISK_EVIDENCE_FILE}:1"])])
        self._move_head_past_a()
        _drop_root_tree(self, self.commit_a)
        refusal = plan_verdict_staleness(self.state(), base_dir=self.tools)
        self.assertTrue(refusal.startswith(f"{UNVERIFIABLE}:{COMMIT_UNREADABLE}:{self.commit_a}"), refusal)
        self.assert_withheld_uncounted()

    def test_record_raises_the_checkout_refusal_not_the_ledger_refusal(self) -> None:
        self.start()
        self.challenger("challenger-rev-0")
        self._move_head_past_a()
        _drop_root_tree(self, self.commit_a)
        before = _event_count(self)
        with self.assertRaisesRegex(WorkspaceViewRefused, f"{COMMIT_UNREADABLE}:{self.commit_a}") as raised:
            self.cross_review([_risk("CR-001", "nice_to_have", evidence_refs=[f"{RISK_EVIDENCE_FILE}:1"])],
                              verdict="agreed", reviewed_at=self.commit_a)
        self.assertNotIsInstance(raised.exception, GovernanceError)
        self.assertEqual(_event_count(self), before)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")


class R23ABlobIsAListedBlobEntryOfExactlyThatPath(_PlanFixture):
    def test_the_blob_subset_of_the_asked_set(self) -> None:
        (self.repo / LITERAL_ID).write_text("export const id = 1;\n", encoding="utf-8")
        _git(self.repo, "add", "--", LITERAL_ID)
        _git(self.repo, "commit", "-q", "-m", "fixture: a literal [id] file")
        head = _git(self.repo, "rev-parse", "HEAD")
        asked = {
            SURFACE,                      # a blob
            LITERAL_ID,                   # a blob whose name is pathspec glob text
            f"{FEED}/absent.ts",          # no such path
            f"{SURFACE}#L1",              # a line anchor read as a file name
            f"{FEED}/*.ts",               # glob text, read literally
            FEED,                         # a directory
        }
        self.assertEqual(workspace_view.commit_blob_paths(self.repo, head, asked), frozenset({SURFACE, LITERAL_ID}))
        self.assertEqual(workspace_view.commit_blob_paths(self.repo, None, asked), frozenset())

    def test_a_commit_the_checkout_does_not_hold_raises(self) -> None:
        with self.assertRaisesRegex(WorkspaceViewRefused, COMMIT_UNREADABLE):
            workspace_view.commit_blob_paths(self.repo, "e" * 40, {SURFACE})


class R23OneGitProcessAnswersTheWholeSet(_PlanFixture):
    """The cited set is answered once per read, not one or two processes per ref."""

    def _many_files(self) -> list[str]:
        paths = [f"{FEED}/cited/f{index:04d}.ts" for index in range(MANY)]
        for rel in paths:
            target = self.repo / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(f"export const f = {rel!r};\n", encoding="utf-8")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture: many cited files")
        return paths

    def test_a_thousand_cited_refs_cost_one_ls_tree_per_freshness_read(self) -> None:
        paths = self._many_files()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0",
                   plan_content=self.plan(evidence_refs=[PLAN_EVIDENCE, *(f"{p}:1" for p in paths)]),
                   base_dir=self.tools)
        self.challenger("challenger-rev-0")
        self.cross_review([], verdict="agreed")
        self.assertEqual(_terminal(self.evaluate(1)), "CONVERGED")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        with mock.patch.object(workspace_view, "hermetic_git", wraps=workspace_view.hermetic_git) as calls:
            self.assertIsNone(plan_verdict_staleness(state, base_dir=self.tools))
        self.assertEqual(_ls_tree_calls(calls), 1)

    def test_every_risk_ref_of_a_record_costs_one_ls_tree_per_law_pass(self) -> None:
        paths = self._many_files()
        self.start()
        self.challenger("challenger-rev-0")
        risks = [_risk(f"CR-{index:03d}", "nice_to_have", evidence_refs=[f"{p}:1" for p in paths[index::4]])
                 for index in range(4)]
        with mock.patch.object(workspace_view, "hermetic_git", wraps=workspace_view.hermetic_git) as calls:
            self.cross_review(risks, verdict="agreed")
        # The V8 door judges the risks before it appends the round's request,
        # and each direction's record validator judges them again as the
        # event's own law: three passes, one process each, whatever the count
        # of refs across the four risks.
        self.assertEqual(_ls_tree_calls(calls), 3)


if __name__ == "__main__":
    unittest.main()
