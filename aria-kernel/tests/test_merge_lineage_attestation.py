"""ARIA-HIGH-409 — a merge nobody classified gets its lineage, append-only, once.

THE LIVE SHAPE (2026-10-10). PR #1906 — ARIA's first merge — was merged by a
person at 01:03Z; its head had only ever moved by GitHub's update-branch
(merges of ``main``), so its lineage is ``base_merged``. A cycle on pre-#1910
code wrote the plan's ``implementation_merged`` with no lineage at 01:28Z; the
first cycle on #1910 backfilled the ``merged`` row as ``backfilled_unverified``
without reading the head. ``merged_row_is_arias`` said no, the promotion said
``not_credited``, agent_eval dropped the merged episode — permanently.

Pins:

* that exact shape is classified with the merge owner's own classifier and
  attested by an appended row and plan event; every reader folds it;
* a diverged head is attested too, and stays uncredited;
* an unreadable head is retried for MAX_LINEAGE_CHECKS cycles, then disclosed;
* one attestation per merge, never over a classified lineage;
* a merged plan with no row is backfilled CLASSIFIED, not stamped unverified.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

from aria_kernel.implementation_reconciler import reconcile_recorded_implementations
from aria_kernel.ledger import load_jsonl
from aria_kernel.merge_record import (
    EVENT_LINEAGE_ATTESTED,
    LINEAGE_BACKFILLED_UNVERIFIED,
    LINEAGE_BASE_MERGED,
    LINEAGE_DELIVERED,
    LINEAGE_DIVERGED,
    LINEAGE_UNVERIFIABLE,
    MAX_LINEAGE_CHECKS,
    MERGED_BY_OBSERVED,
    MergeNotProven,
    attest_merge_lineage,
    fold_lineage,
    fold_merged_rows,
    lifecycle_rows,
    lineage_checks,
    merged_row_is_arias,
    opened_row,
    record_merge,
)
from aria_kernel.plan_convergence import (
    _append_event,
    _record_implementation_merged,
    _idempotency_key,
    _record_implementation_merge_lineage_attested,
    events_path,
    fold_plan_state,
    record_implementation_outcome,
    record_implementation_started,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests.test_implementation_lifecycle_continuity import drive_plan_to_implementation_requested, seed_reviewer_agent
from tests.test_merge_record import MERGE_SHA, PR, TIP, Reader, Unreadable, _git, _opened

MERGED_AT = "2026-10-10T01:03:06Z"


def _merged_rows(tools: Path) -> list[dict]:
    return [row for row in lifecycle_rows(tools) if row.get("event") == "merged"]


def _attested_rows(tools: Path) -> list[dict]:
    return [row for row in lifecycle_rows(tools) if row.get("event") == EVENT_LINEAGE_ATTESTED]


def _plan_events(tools: Path, event_type: str) -> list[dict]:
    return [row for row in load_jsonl(events_path(tools)) if row.get("event_type") == event_type]


def _legacy_plan_merge(tools: Path, *, plan_id: str, merge_sha: str) -> None:
    """The plan event pre-#1910 code wrote (01:28Z): a merge naming no lineage."""
    payload = {"merge_sha": merge_sha, "merged_at": MERGED_AT, "idempotency_key_hash": "sha256:" + "a" * 64}
    _append_event(root=ensure_tools_dir(tools), plan_id=plan_id, event_type="implementation_merged", payload=payload,
                  idempotency_key=_idempotency_key(plan_id, "record-implementation-merged", payload))


def _backfilled_row(tools: Path, *, merge_sha: str) -> None:
    """The row #1910's backfill wrote (03:08Z): no head read, stamped unverified."""
    record_merge(pr=opened_row(lifecycle_rows(tools), pr_number=PR), merged_by=MERGED_BY_OBSERVED, base_dir=tools,
                 merge_sha=merge_sha, merged_at=MERGED_AT, head_lineage=LINEAGE_BACKFILLED_UNVERIFIED)


def _merged_episodes(tools: Path) -> list[dict]:
    from aria_kernel.agent_eval import _performance_episodes
    from aria_kernel.failure_attribution import InvocationLedgersSource

    episodes = _performance_episodes(load_jsonl(events_path(tools)), {}, InvocationLedgersSource(tools))
    return [row for row in episodes if row["role"] == "implementer" and row["outcome"] == "merged"]


class _LegacyMerge(unittest.TestCase):
    """A RECORDED plan for PR, delivered at ``self.delivered``, merged at ``self.merge_sha`` by old code."""

    delivered = TIP
    merge_sha = MERGE_SHA

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-lineage-attest-")
        self.addCleanup(tmp.cleanup)
        self.tools = Path(tmp.name) / "aria-tools"
        self.root = Path(tmp.name) / "workspace"
        self.make_workspace()
        seed_reviewer_agent(self.root)
        drive_plan_to_implementation_requested(plan_id="plan-r", tools=self.tools, workspace_root=self.root)
        record_implementation_started(plan_id="plan-r", claim_id="claim-1", implementer_agent="aria-implementer",
                                      started_at="2026-10-09T10:00:00Z", base_dir=self.tools)
        record_implementation_outcome(
            plan_id="plan-r", claim_id="claim-1", pr_url=f"https://github.com/o/r/pull/{PR}",
            diff_hash="sha256:" + "c" * 64, branch_tip_sha=self.delivered, base_branch_sha="e" * 40,
            validation_results=[], signer_key_fp="fp-1", completed_at="2026-10-09T10:00:13Z", base_dir=self.tools)
        _opened(self.tools, change_id="chg-r", head_sha=self.delivered)
        _legacy_plan_merge(self.tools, plan_id="plan-r", merge_sha=self.merge_sha)

    def make_workspace(self) -> None:
        self.root.mkdir(parents=True)

    def reconcile(self, reader: Any) -> dict:
        return reconcile_recorded_implementations(base_dir=self.tools, workspace_root=self.root, reader=reader)

    def plan(self) -> dict:
        return fold_plan_state(plan_id="plan-r", base_dir=self.tools)


class TheLiveShape(_LegacyMerge):
    """#1906 byte for byte: a head moved only by update-branch, a backfilled row, a plan with no lineage."""

    def make_workspace(self) -> None:
        # main A -> B -> C; ARIA delivered D on A; update-branch merged B,
        # then C, into the PR (U1, U2); a person merged U2 into main (S).
        self.root.mkdir(parents=True)
        repo = self.root
        _git(repo, "init", "-q", "-b", "main")
        (repo / "base.txt").write_text("a\n")
        _git(repo, "add", "base.txt")
        _git(repo, "commit", "-q", "-m", "A")
        _git(repo, "checkout", "-q", "-b", "aria-impl")
        (repo / "feature.txt").write_text("aria\n")
        _git(repo, "add", "feature.txt")
        _git(repo, "commit", "-q", "-m", "D")
        self.delivered = _git(repo, "rev-parse", "HEAD")
        for name in ("B", "C"):
            _git(repo, "checkout", "-q", "main")
            (repo / f"{name}.txt").write_text(f"{name}\n")
            _git(repo, "add", f"{name}.txt")
            _git(repo, "commit", "-q", "-m", name)
            _git(repo, "checkout", "-q", "aria-impl")
            _git(repo, "merge", "-q", "--no-ff", "-m", "Merge branch 'main' into aria-impl", "main")
        self.head = _git(repo, "rev-parse", "HEAD")
        _git(repo, "checkout", "-q", "main")
        _git(repo, "merge", "-q", "--no-ff", "-m", f"Merge pull request #{PR}", self.head)
        self.merge_sha = _git(repo, "rev-parse", "HEAD")

    def setUp(self) -> None:
        super().setUp()
        _backfilled_row(self.tools, merge_sha=self.merge_sha)
        self.reader = Reader(headRefOid=self.head, mergeCommit={"oid": self.merge_sha}, mergedAt=MERGED_AT)
        # The defect as observed: nothing credits ARIA's first merge.
        [row] = fold_merged_rows(lifecycle_rows(self.tools))
        self.assertFalse(merged_row_is_arias(row))
        self.assertIsNone(self.plan()["implementation"]["head_lineage"])
        self.assertEqual(_merged_episodes(self.tools), [])

    def test_a_base_merged_head_is_attested_and_every_reader_credits_it(self) -> None:
        result = self.reconcile(self.reader)
        self.assertEqual(result["lineage_attested"], [{
            "plan_id": "plan-r", "pr_number": PR, "head_lineage": LINEAGE_BASE_MERGED,
            "lifecycle_row": False, "attested_row": True, "plan_event": True}], result)
        # Append-only: the backfilled row is untouched; one row is added.
        [raw] = _merged_rows(self.tools)
        self.assertEqual(raw["head_lineage"], LINEAGE_BACKFILLED_UNVERIFIED)
        [attested] = _attested_rows(self.tools)
        self.assertEqual((attested["head_lineage"], attested["merged_head_sha"], attested["delivered_head_sha"],
                          attested["merge_sha"]), (LINEAGE_BASE_MERGED, self.head, self.delivered, self.merge_sha))
        # merge_record's fold, pr-lifecycle side.
        [row] = fold_merged_rows(lifecycle_rows(self.tools))
        self.assertEqual(row["head_lineage"], LINEAGE_BASE_MERGED)
        self.assertTrue(merged_row_is_arias(row))
        # plan_convergence's reducer, plan side; the promotion reads it.
        impl = self.plan()["implementation"]
        self.assertEqual((impl["head_lineage"], impl["head_lineage_attested"]["merged_head_sha"]),
                         (LINEAGE_BASE_MERGED, self.head))
        [promotion] = result["promotions"]
        self.assertNotEqual(promotion.get("status"), "not_credited", promotion)
        # agent_eval: the merge event's one episode.
        self.assertEqual(len(_merged_episodes(self.tools)), 1)
        # change_outcome's merge anchor.
        from aria_kernel.change_outcome import _merge_index

        self.assertTrue(merged_row_is_arias(_merge_index(ensure_tools_dir(self.tools))["chg-r"]))
        # pr_tracking: ingested once, attributed, keyed on the merged row's own head.
        from aria_kernel.pr_tracking import ingest_merged_pr_lifecycle

        [ingested] = ingest_merged_pr_lifecycle(base_dir=self.tools)["ingested"]
        self.assertEqual((ingested["head_sha"], ingested["attributed_to_aria"]), (self.delivered, True))
        self.assertEqual(ingest_merged_pr_lifecycle(base_dir=self.tools)["ingested"], [])

    def test_one_attestation_per_merge(self) -> None:
        self.reconcile(self.reader)
        again = self.reconcile(self.reader)
        self.assertEqual(again["lineage_attested"], [])
        self.assertEqual(self.reader.asked, [PR])
        self.assertEqual((len(_merged_rows(self.tools)), len(_attested_rows(self.tools))), (1, 1))
        self.assertEqual(len(_plan_events(self.tools, "implementation_merge_lineage_attested")), 1)
        self.assertEqual(len(_merged_episodes(self.tools)), 1)
        # The owner, asked again, writes nothing; asked with another verdict, it refuses by name.
        attest = dict(pr=opened_row(lifecycle_rows(self.tools), pr_number=PR), plan_id="plan-r",
                      merge_sha=self.merge_sha, merged_at=MERGED_AT, merged_head_sha=self.head, base_dir=self.tools)
        written = attest_merge_lineage(head_lineage=LINEAGE_BASE_MERGED, **attest)
        self.assertEqual((written["lifecycle_row"], written["attested_row"], written["plan_event"]),
                         (False, False, None))
        with self.assertRaisesRegex(MergeNotProven, "lineage_disagrees"):
            attest_merge_lineage(head_lineage=LINEAGE_DIVERGED, **attest)
        self.assertEqual(fold_merged_rows(lifecycle_rows(self.tools))[0]["head_lineage"], LINEAGE_BASE_MERGED)


class ADivergedOrUnreadableHead(_LegacyMerge):
    def setUp(self) -> None:
        super().setUp()
        _backfilled_row(self.tools, merge_sha=MERGE_SHA)

    def test_a_diverged_head_is_attested_and_stays_uncredited(self) -> None:
        with patch("aria_kernel.implementation_reconciler.classify_merged_head", return_value=LINEAGE_DIVERGED):
            result = self.reconcile(Reader(headRefOid="7" * 40))
        self.assertEqual([row["head_lineage"] for row in result["lineage_attested"]], [LINEAGE_DIVERGED])
        [row] = fold_merged_rows(lifecycle_rows(self.tools))
        self.assertEqual(row["head_lineage"], LINEAGE_DIVERGED)
        self.assertFalse(merged_row_is_arias(row))
        self.assertEqual(result["promotions"],
                         [{"plan_id": "plan-r", "status": "not_credited", "head_lineage": LINEAGE_DIVERGED}])
        self.assertEqual(_merged_episodes(self.tools), [])
        from aria_kernel.pr_tracking import ingest_merged_pr_lifecycle

        [ingested] = ingest_merged_pr_lifecycle(base_dir=self.tools)["ingested"]
        self.assertFalse(ingested["attributed_to_aria"])

    def test_an_unreadable_head_is_retried_then_disclosed_at_the_bound(self) -> None:
        # N2 — the workspace is no checkout, so the head cannot be read: asked
        # again each cycle, never stamped at once; at the bound the merge is
        # attested `head_unverifiable`, which no reader credits, and settled.
        reader = Reader(headRefOid="7" * 40)
        for check in range(1, MAX_LINEAGE_CHECKS):
            result = self.reconcile(reader)
            self.assertEqual(result["lineage_unverified"],
                             [{"plan_id": "plan-r", "pr_number": PR, "checks": check, "max_checks": MAX_LINEAGE_CHECKS}])
            self.assertEqual(_attested_rows(self.tools), [])
            self.assertIsNone(self.plan()["implementation"]["head_lineage"])
        self.assertEqual(lineage_checks(lifecycle_rows(self.tools), PR), MAX_LINEAGE_CHECKS - 1)
        result = self.reconcile(reader)
        self.assertEqual([row["head_lineage"] for row in result["lineage_attested"]], [LINEAGE_UNVERIFIABLE])
        self.assertEqual(self.plan()["implementation"]["head_lineage"], LINEAGE_UNVERIFIABLE)
        self.assertFalse(merged_row_is_arias(fold_merged_rows(lifecycle_rows(self.tools))[0]))
        self.reconcile(reader)
        self.assertEqual(len(reader.asked), MAX_LINEAGE_CHECKS)

    def test_github_unreadable_waits_without_counting_a_check(self) -> None:
        result = self.reconcile(Unreadable())
        self.assertEqual(result["lineage_waiting"], [{"plan_id": "plan-r", "pr_number": PR}])
        self.assertEqual(result["status"], "unreadable")
        self.assertEqual(lineage_checks(lifecycle_rows(self.tools), PR), 0)
        # Learning from durable evidence still runs offline.
        self.assertEqual([row["plan_id"] for row in result["promotions"]], ["plan-r"])

    def test_a_merge_commit_github_does_not_report_is_not_this_merges_head(self) -> None:
        reader = Reader(headRefOid=TIP, mergeCommit={"oid": "8" * 40})
        result = self.reconcile(reader)
        self.assertEqual([row["checks"] for row in result["lineage_unverified"]], [1])
        self.assertEqual(_attested_rows(self.tools), [])


class AMergedPlanWithNoRow(_LegacyMerge):
    def test_the_backfill_classifies_the_head_instead_of_stamping_it(self) -> None:
        waiting = self.reconcile(Unreadable())
        self.assertEqual(waiting["lineage_waiting"], [{"plan_id": "plan-r", "pr_number": PR}])
        self.assertEqual(_merged_rows(self.tools), [])
        result = self.reconcile(Reader(mergedAt=MERGED_AT))  # GitHub's head is the delivered head
        self.assertEqual(result["lifecycle_backfilled"], [{"plan_id": "plan-r", "pr_number": PR}])
        [row] = _merged_rows(self.tools)
        self.assertEqual((row["head_lineage"], row["head_sha"], row["merge_sha"], row["merged_at"]),
                         (LINEAGE_DELIVERED, TIP, MERGE_SHA, MERGED_AT))
        self.assertEqual(_attested_rows(self.tools), [])
        self.assertEqual(self.plan()["implementation"]["head_lineage"], LINEAGE_DELIVERED)
        self.assertEqual(len(_merged_episodes(self.tools)), 1)

    def test_a_classified_row_attests_its_plan_without_a_read(self) -> None:
        # A pass that stopped between the row and the plan event.
        record_merge(pr=opened_row(lifecycle_rows(self.tools), pr_number=PR), merged_by=MERGED_BY_OBSERVED,
                     base_dir=self.tools, merge_sha=MERGE_SHA, merged_at=MERGED_AT, merged_head_sha="7" * 40,
                     head_lineage=LINEAGE_BASE_MERGED)
        reader = Reader()
        result = self.reconcile(reader)
        self.assertEqual(reader.asked, [])
        self.assertEqual([row["plan_event"] for row in result["lineage_attested"]], [True])
        impl = self.plan()["implementation"]
        self.assertEqual((impl["head_lineage"], impl["head_lineage_attested"]["merged_head_sha"]),
                         (LINEAGE_BASE_MERGED, "7" * 40))

    def test_a_row_naming_another_merge_is_a_named_disagreement_not_a_read(self) -> None:
        record_merge(pr=opened_row(lifecycle_rows(self.tools), pr_number=PR), merged_by=MERGED_BY_OBSERVED,
                     base_dir=self.tools, merge_sha="8" * 40, merged_at=MERGED_AT,
                     head_lineage=LINEAGE_BACKFILLED_UNVERIFIED)
        reader = Reader()
        result = self.reconcile(reader)
        self.assertEqual(result["merge_errors"],
                         [{"plan_id": "plan-r", "reason": "attested_merge_is_not_the_recorded_merge"}])
        self.assertEqual((reader.asked, _attested_rows(self.tools)), ([], []))


class ARowWithoutAMergeSha(_LegacyMerge):
    """Review of #1932, F1 — the writer and the fold must agree on a merged row that names no merge commit."""

    def setUp(self) -> None:
        super().setUp()
        record_merge(pr=opened_row(lifecycle_rows(self.tools), pr_number=PR), merged_by=MERGED_BY_OBSERVED,
                     base_dir=self.tools, head_lineage=LINEAGE_BACKFILLED_UNVERIFIED)
        self.assertNotIn("merge_sha", _merged_rows(self.tools)[0])

    def test_its_attestation_is_folded_and_the_merge_settles(self) -> None:
        reader = Reader()
        result = self.reconcile(reader)
        self.assertEqual([row["head_lineage"] for row in result["lineage_attested"]], [LINEAGE_DELIVERED])
        [row] = fold_merged_rows(lifecycle_rows(self.tools))
        self.assertEqual(row["head_lineage"], LINEAGE_DELIVERED)
        self.assertTrue(merged_row_is_arias(row))
        self.assertEqual(self.plan()["implementation"]["head_lineage"], LINEAGE_DELIVERED)
        again = self.reconcile(reader)
        self.assertEqual((again["lineage_attested"], reader.asked), ([], [PR]))

    def test_an_unreadable_head_reaches_the_bound(self) -> None:
        reader = Reader(headRefOid="7" * 40)
        for _ in range(MAX_LINEAGE_CHECKS + 2):
            self.reconcile(reader)
        self.assertEqual(lineage_checks(lifecycle_rows(self.tools), PR), MAX_LINEAGE_CHECKS - 1)
        self.assertEqual(fold_merged_rows(lifecycle_rows(self.tools))[0]["head_lineage"], LINEAGE_UNVERIFIABLE)
        self.assertEqual(len(reader.asked), MAX_LINEAGE_CHECKS)


class APlanThatNamedItsLineage(unittest.TestCase):
    """Review of #1932, F2 — a classified plan lineage is the evidence; GitHub is not asked again."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-lineage-plan-")
        self.addCleanup(tmp.cleanup)
        self.tools, self.root = Path(tmp.name) / "aria-tools", Path(tmp.name) / "workspace"
        seed_reviewer_agent(self.root)
        drive_plan_to_implementation_requested(plan_id="plan-r", tools=self.tools, workspace_root=self.root)
        record_implementation_started(plan_id="plan-r", claim_id="claim-1", implementer_agent="aria-implementer",
                                      started_at="2026-10-09T10:00:00Z", base_dir=self.tools)
        record_implementation_outcome(
            plan_id="plan-r", claim_id="claim-1", pr_url=f"https://github.com/o/r/pull/{PR}",
            diff_hash="sha256:" + "c" * 64, branch_tip_sha=TIP, base_branch_sha="e" * 40,
            validation_results=[], signer_key_fp="fp-1", completed_at="2026-10-09T10:00:13Z", base_dir=self.tools)
        _opened(self.tools, change_id="chg-r")
        _record_implementation_merged(plan_id="plan-r", merge_sha=MERGE_SHA, merged_at=MERGED_AT,
                                      idempotency_key_hash="sha256:" + "a" * 64, head_lineage=LINEAGE_DIVERGED,
                                      base_dir=self.tools)

    def reconcile(self, reader: Any) -> dict:
        return reconcile_recorded_implementations(base_dir=self.tools, workspace_root=self.root, reader=reader)

    def test_a_missing_row_takes_the_plans_diverged_lineage_unread(self) -> None:
        reader = Reader()  # GitHub's head == delivered: a read would say `delivered`
        self.reconcile(reader)
        self.assertEqual(reader.asked, [])
        [row] = fold_merged_rows(lifecycle_rows(self.tools))
        self.assertEqual(row["head_lineage"], LINEAGE_DIVERGED)
        self.assertFalse(merged_row_is_arias(row))

    def test_a_backfilled_row_is_attested_with_the_plans_lineage(self) -> None:
        _backfilled_row(self.tools, merge_sha=MERGE_SHA)
        reader = Reader()
        self.reconcile(reader)
        self.assertEqual(reader.asked, [])
        self.assertEqual(fold_merged_rows(lifecycle_rows(self.tools))[0]["head_lineage"], LINEAGE_DIVERGED)

    def test_the_owner_never_contradicts_a_classified_lineage(self) -> None:
        with self.assertRaisesRegex(MergeNotProven, "lineage_disagrees_with_the_plan"):
            attest_merge_lineage(pr=opened_row(lifecycle_rows(self.tools), pr_number=PR), plan_id="plan-r",
                                 head_lineage=LINEAGE_DELIVERED, merge_sha=MERGE_SHA, merged_at=MERGED_AT,
                                 merged_head_sha=TIP, base_dir=self.tools)
        self.assertEqual(_merged_rows(self.tools), [])


class TheReducerIsTheLastGuard(_LegacyMerge):
    """Review of #1932, M5/M11 — the plan event has no runtime owner token, so a hand-appended
    attestation is refused when the plan is folded, not only when the owner writes it."""

    def append(self, *, plan_id: str = "plan-r", merge_sha: str = MERGE_SHA, key: str = "1") -> None:
        payload = {"head_lineage": LINEAGE_BASE_MERGED, "merge_sha": merge_sha, "pr_number": PR,
                   "delivered_head_sha": TIP, "merged_head_sha": None}
        _append_event(root=ensure_tools_dir(self.tools), plan_id=plan_id,
                      event_type="implementation_merge_lineage_attested", payload=payload,
                      idempotency_key="sha256:" + key * 64)

    def test_an_attestation_over_a_classified_lineage_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools, root = Path(tmp) / "aria-tools", Path(tmp) / "workspace"
            seed_reviewer_agent(root)
            drive_plan_to_implementation_requested(plan_id="plan-c", tools=tools, workspace_root=root)
            record_implementation_started(plan_id="plan-c", claim_id="claim-1", implementer_agent="aria-implementer",
                                          started_at="2026-10-09T10:00:00Z", base_dir=tools)
            record_implementation_outcome(
                plan_id="plan-c", claim_id="claim-1", pr_url=f"https://github.com/o/r/pull/{PR}",
                diff_hash="sha256:" + "c" * 64, branch_tip_sha=TIP, base_branch_sha="e" * 40,
                validation_results=[], signer_key_fp="fp-1", completed_at="2026-10-09T10:00:13Z", base_dir=tools)
            _record_implementation_merged(plan_id="plan-c", merge_sha=MERGE_SHA, merged_at=MERGED_AT,
                                          idempotency_key_hash="sha256:" + "a" * 64, head_lineage=LINEAGE_DIVERGED,
                                          base_dir=tools)
            self.tools = tools
            self.append(plan_id="plan-c")
            with self.assertRaisesRegex(GovernanceError, "already names its lineage"):
                fold_plan_state(plan_id="plan-c", base_dir=tools)

    def test_a_replayed_attestation_is_refused(self) -> None:
        self.append(key="1")
        self.assertEqual(self.plan()["implementation"]["head_lineage"], LINEAGE_BASE_MERGED)
        self.append(key="2")
        with self.assertRaisesRegex(GovernanceError, "already names its lineage"):
            self.plan()

    def test_an_attestation_of_another_merge_is_refused(self) -> None:
        self.append(merge_sha="8" * 40)
        with self.assertRaisesRegex(GovernanceError, "another merge"):
            self.plan()


class TheAttestationsOwnRules(_LegacyMerge):
    def test_only_an_unclassified_lineage_is_replaced(self) -> None:
        self.assertEqual(fold_lineage(LINEAGE_BACKFILLED_UNVERIFIED, LINEAGE_BASE_MERGED), LINEAGE_BASE_MERGED)
        self.assertEqual(fold_lineage(None, LINEAGE_BASE_MERGED), LINEAGE_BASE_MERGED)
        self.assertEqual(fold_lineage(LINEAGE_DIVERGED, LINEAGE_BASE_MERGED), LINEAGE_DIVERGED)
        self.assertEqual(fold_lineage(None, LINEAGE_BACKFILLED_UNVERIFIED), None)
        merged = {"event": "merged", "pr_number": PR, "merge_sha": MERGE_SHA}
        attested = {"event": EVENT_LINEAGE_ATTESTED, "pr_number": PR, "merge_sha": MERGE_SHA,
                    "head_lineage": LINEAGE_BASE_MERGED}
        for row_lineage, attested_sha, expected in ((LINEAGE_DIVERGED, MERGE_SHA, LINEAGE_DIVERGED),
                                                    (LINEAGE_BACKFILLED_UNVERIFIED, "8" * 40,
                                                     LINEAGE_BACKFILLED_UNVERIFIED),
                                                    (LINEAGE_BACKFILLED_UNVERIFIED, MERGE_SHA, LINEAGE_BASE_MERGED)):
            with self.subTest(row=row_lineage, attested=attested_sha):
                [row] = fold_merged_rows([{**merged, "head_lineage": row_lineage},
                                          {**attested, "merge_sha": attested_sha}])
                self.assertEqual(row["head_lineage"], expected)

    def test_the_owner_refuses_what_is_not_a_classification(self) -> None:
        pr = opened_row(lifecycle_rows(self.tools), pr_number=PR)
        with self.assertRaises(ValueError):
            attest_merge_lineage(pr=pr, head_lineage=LINEAGE_BACKFILLED_UNVERIFIED, merge_sha=MERGE_SHA,
                                 merged_at=MERGED_AT, merged_head_sha=None, base_dir=self.tools)
        with self.assertRaisesRegex(MergeNotProven, "attestation_needs"):
            attest_merge_lineage(pr={"number": PR}, head_lineage=LINEAGE_DELIVERED, merge_sha=MERGE_SHA,
                                 merged_at=MERGED_AT, merged_head_sha=None, base_dir=self.tools)
        from aria_kernel.auto_merge import record_pr_lifecycle

        with self.assertRaisesRegex(GovernanceError, "has_one_writer"):
            record_pr_lifecycle({"number": PR}, event=EVENT_LINEAGE_ATTESTED, base_dir=self.tools)

    def test_the_reducer_attests_a_merged_plan_once_for_its_own_merge(self) -> None:
        attest = dict(plan_id="plan-r", head_lineage=LINEAGE_BASE_MERGED, pr_number=PR, delivered_head_sha=TIP,
                      merged_head_sha="7" * 40, base_dir=self.tools)
        with self.assertRaises(GovernanceError):  # another merge commit than the plan's
            _record_implementation_merge_lineage_attested(merge_sha="8" * 40, **attest)
        self.assertTrue(_record_implementation_merge_lineage_attested(merge_sha=MERGE_SHA, **attest)["event_appended"])
        self.assertTrue(_record_implementation_merge_lineage_attested(merge_sha=MERGE_SHA, **attest)["idempotent"])
        self.assertEqual(len(_plan_events(self.tools, "implementation_merge_lineage_attested")), 1)
        self.assertEqual(self.plan()["implementation"]["head_lineage"], LINEAGE_BASE_MERGED)

    def test_a_plan_that_named_its_lineage_is_never_attested(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            tools, root = Path(tmp) / "aria-tools", Path(tmp) / "workspace"
            seed_reviewer_agent(root)
            drive_plan_to_implementation_requested(plan_id="plan-c", tools=tools, workspace_root=root)
            with self.assertRaises(GovernanceError):  # not merged at all
                _record_implementation_merge_lineage_attested(
                    plan_id="plan-c", head_lineage=LINEAGE_BASE_MERGED, merge_sha=MERGE_SHA, pr_number=PR,
                    delivered_head_sha=TIP, merged_head_sha=None, base_dir=tools)


if __name__ == "__main__":
    unittest.main()
