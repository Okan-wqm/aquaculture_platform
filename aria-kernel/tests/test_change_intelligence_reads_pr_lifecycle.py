"""ARIA-LOW-424 — the change-intelligence phase reads merges where their one writer records them.

`merge_record.record_merge` is the only writer of a `merged` row
(ARIA-HIGH-390), in `pr-lifecycle.jsonl`. The phase used to copy each new
merged row into `merge-events.jsonl` and `pr-events.jsonl`
(`pr_tracking.ingest_merged_pr_lifecycle` → `observe_pr_event`) and read the
copy: impact planning took the copy's last row, change intelligence walked the
copy newest first. These tests pin that the phase reads the owner's rows,
copies nothing, and, on a store the copy already served (production's shape on
aria/state f5c5c86a1: PR 1906 copied, its impact planned), plans and asks
nothing again.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import cycle as cycle_mod
from aria_kernel.agent_invocations import create_agent_invocation_request, list_agent_invocation_requests
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, record_merge
from aria_kernel.pr_tracking import (
    CHANGE_INTELLIGENCE_AGENT,
    CHANGE_INTELLIGENCE_ROLE,
    change_intelligence_subject_ref,
)
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import ensure_tools_dir
from tests._helpers.declared_fixtures import append_declared_fixture

HEAD = "c" * 40


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.workspace = Path(self._tmp.name)
        self.tools = ensure_tools_dir(self.workspace / "aria-tools")

    def merge(self, pr_number: int = 7, head_sha: str = HEAD) -> None:
        record_merge(
            pr={"number": pr_number, "head_sha": head_sha, "base_branch": "main",
                "changed_files": ["apps/farm-service/src/batch/batch.service.ts"]},
            merged_by=MERGED_BY_MERGE_LANE, base_dir=self.tools, head_lineage="delivered",
        )

    def run_phase(self, cycle_id: str) -> dict:
        context = cycle_mod.build_phase_context(cycle_id=cycle_id, workspace_root=self.workspace, base_dir=self.tools)
        return cycle_mod._phase_change_intelligence(context)

    def impacts(self) -> list[dict]:
        path = self.tools / "evidence-impact.jsonl"
        return load_declared_jsonl(path, expected_surface="evidence_impact") if path.exists() else []

    def requests(self) -> list[dict]:
        return list_agent_invocation_requests(base_dir=self.tools, role=CHANGE_INTELLIGENCE_ROLE)


class TheOwnersRowsAreRead(_Store):
    def test_a_merge_is_planned_and_asked_about_without_a_copy(self) -> None:
        self.merge()

        result = self.run_phase("cyc-1")

        self.assertFalse((self.tools / "merge-events.jsonl").exists())
        self.assertFalse((self.tools / "pr-events.jsonl").exists())
        self.assertEqual((result["impact_status"], result["change_intelligence_requests_minted"], result["blocked"]),
                         ("planned", 1, []))
        [impact] = self.impacts()
        self.assertEqual(impact["pr_event"], {"pr_number": 7, "event": "merged", "head_sha": HEAD,
                                              "merge_commit_sha": None})
        [request] = self.requests()
        # ARIA-MEDIUM-385 — the merge is the request's subject, never a citation.
        self.assertEqual(request["subject_ref"], change_intelligence_subject_ref(pr_number=7, head_sha=HEAD))

    def test_a_second_run_plans_and_asks_nothing(self) -> None:
        self.merge()
        self.run_phase("cyc-1")

        result = self.run_phase("cyc-2")

        self.assertEqual((result["impact_status"], result["change_intelligence_requests_minted"]),
                         ("no_new_merge", 0))
        self.assertEqual((len(self.impacts()), len(self.requests())), (1, 1))

    def test_an_idle_store_writes_no_impact_row(self) -> None:
        result = self.run_phase("cyc-1")

        self.assertEqual(result["impact_status"], "no_new_merge")
        self.assertEqual(self.impacts(), [])

    def test_a_new_merge_is_planned_and_asked_about_on_its_own(self) -> None:
        self.merge()
        self.run_phase("cyc-1")
        self.merge(pr_number=8, head_sha="d" * 40)

        result = self.run_phase("cyc-2")

        self.assertEqual((result["impact_status"], result["change_intelligence_requests_minted"]), ("planned", 1))
        self.assertEqual([row["pr_event"]["pr_number"] for row in self.impacts()], [7, 8])


class AStoreTheCopyAlreadyServed(_Store):
    """Production's shape: the copy holds PR 1906, its impact is planned, the
    change-intelligence mint for it is on the request ledger (or still refused
    by admission). Upgrading must neither re-plan nor re-ask."""

    def setUp(self) -> None:
        super().setUp()
        self.merge(pr_number=1906)
        legacy = {"schema_version": 1, "recorded_at": "2026-10-10T03:08:55+00:00", "pr_number": 1906,
                  "event": "merged", "base_sha": None, "head_sha": HEAD, "merge_commit_sha": "5" * 40,
                  "changed_files": ["apps/farm-service/src/batch/batch.service.ts"], "author": None,
                  "labels": [], "merged_at": None, "source": "pr_lifecycle", "proposal_id": None,
                  "apply_ref": None, "validation_refs": [], "attributed_to_aria": False}
        append_declared_fixture(self.tools / "pr-events.jsonl", legacy, expected_surface="pr_events")
        append_declared_fixture(self.tools / "merge-events.jsonl", legacy, expected_surface="merge_events")
        append_declared_fixture(self.tools / "evidence-impact.jsonl", {
            "schema_version": 1, "recorded_at": "2026-10-10T03:08:56+00:00", "cycle_id": "cyc-20261010T025128Z-auto",
            "status": "planned",
            "pr_event": {"pr_number": 1906, "event": "merged", "base_sha": None, "head_sha": HEAD,
                         "merge_commit_sha": "5" * 40},
            "changed_files": ["apps/farm-service/src/batch/batch.service.ts"], "impacted_beliefs": [],
            "carried_forward_beliefs": [], "impacted_findings": [], "impacted_adapters": [],
            "actions": ["carry_forward_confirmed_memory"],
        }, expected_surface="evidence_impact")

    def test_the_planned_merge_is_not_planned_again(self) -> None:
        result = self.run_phase("cyc-next")

        self.assertEqual(result["impact_status"], "no_new_merge")
        self.assertEqual(len(self.impacts()), 1)

    def test_a_merge_asked_about_from_the_copy_is_not_asked_again(self) -> None:
        # The request the copy-reading dispatcher minted: same producer, same subject.
        admission = admit_request("change_review.merge_feed", CHANGE_INTELLIGENCE_ROLE,
                                  base_dir=self.tools, cycle_id="cyc-legacy")
        self.assertTrue(admission.admitted)
        create_agent_invocation_request(
            target_agent=CHANGE_INTELLIGENCE_AGENT, role=CHANGE_INTELLIGENCE_ROLE,
            suggested_prompt="Plan the revalidation impact of this merge.",
            must_satisfy=[{"id": "impact-map", "description": "details.impact_map"}],
            allowed_scope=["**"],
            subject_ref=change_intelligence_subject_ref(pr_number=1906, head_sha=HEAD),
            cycle_id="cyc-legacy", target_sha=HEAD, base_dir=self.tools, admission=admission,
        )

        result = self.run_phase("cyc-next")

        self.assertEqual(result["change_intelligence_requests_minted"], 0)
        self.assertEqual(len(self.requests()), 1)

    def test_the_copies_stay_as_history_and_do_not_grow(self) -> None:
        self.merge(pr_number=1907, head_sha="e" * 40)

        self.run_phase("cyc-next")

        for name, surface in (("pr-events.jsonl", "pr_events"), ("merge-events.jsonl", "merge_events")):
            self.assertEqual([row["pr_number"] for row in load_declared_jsonl(self.tools / name,
                                                                               expected_surface=surface)], [1906])


if __name__ == "__main__":
    unittest.main()
