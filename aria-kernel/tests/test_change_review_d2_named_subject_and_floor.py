"""WP-D2 conformance rows R2 and R15, pinned by an independent test writer.

Both behaviours were already correct when these tests were written, so they
pass at birth; each is shown to fail under its mutation (see the commit body).

R2  A named subject is the only subject. ``dispatch_change_intelligence`` reads
    the merge feed ONLY when no subject is named: a merged row recorded beside
    a named change must neither be minted nor change what is minted.

R15 The recall floor is pre-registered. ``change_review.context.recall_floor``
    is 0.95 in the shipped default policy; the audit found that moving it (a
    post-hoc edit after a measurement) kept every test green. The value is now
    pinned here, read from the shipped file itself and through the strict
    parser, so a changed default goes red.
"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any

from aria_kernel import genesis_policy
from aria_kernel.agent_invocations import list_agent_invocation_requests
from aria_kernel.genesis_policy import change_review_policy, default_policy
from aria_kernel.pr_tracking import (
    CHANGE_INTELLIGENCE_ROLE,
    dispatch_change_intelligence,
    resolve_change_subject,
)
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths
from tests._helpers.service_facts import facts_without_contract_edges
from tests.test_change_review_envelope_d2 import _git, _merged_change_repo

# The value registered BEFORE any measurement (commit 26625b654). It is written
# out here on purpose: a pin that reads the number back from the thing it pins
# can never disagree with it.
REGISTERED_RECALL_FLOOR = 0.95
MERGED_PR_NUMBER = 77
SHIPPED_POLICY_FILE = Path(genesis_policy.__file__).resolve().parent / "data" / genesis_policy.DEFAULT_FILENAME


class NamedSubjectIsTheOnlySubjectTests(unittest.TestCase):
    """R2 — a merged row beside a named subject: only the subject is minted."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-d2-r2-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.repo, self.merge_sha, self.feature_head = _merged_change_repo(self.tmp)
        self.workspace_base = self.tmp / "ws"
        paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(paths)
        self.paths = paths

    def tools_dir(self, name: str) -> Path:
        return ensure_tools_dir(self.tmp / name)

    def _record(self, tools: Path) -> None:
        from aria_kernel.merge_record import MERGED_BY_MERGE_LANE, record_merge

        record_merge(
            pr={"number": MERGED_PR_NUMBER, "head_sha": self.feature_head, "base_branch": "main",
                "changed_files": ["libs/zz-core/src/i.ts"]},
            merged_by=MERGED_BY_MERGE_LANE, base_dir=tools, head_lineage="delivered",
            merge_sha=self.merge_sha,
        )

    def _requests(self, tools: Path) -> list[dict[str, Any]]:
        return list_agent_invocation_requests(base_dir=tools, role=CHANGE_INTELLIGENCE_ROLE)

    def test_the_seeded_merged_row_is_a_subject_of_the_merge_feed_when_no_subject_is_named(self) -> None:
        # The control: without a named subject the very same ledger mints the merge.
        # Without this, "the merge feed minted nothing" below could be an empty ledger.
        tools = self.tools_dir("control")
        self._record(tools)
        with facts_without_contract_edges():
            dispatch = dispatch_change_intelligence(cycle_id="d2-r2-control", base_dir=tools, workspace=self.paths)
        # SE-5 — the change touches one service (libs/zz-core) and a code root: its service seat and the lens.
        self.assertEqual(
            [m["subject_ref"] for m in dispatch["minted"]],
            [f"merged-pr:{MERGED_PR_NUMBER}:{self.feature_head}"] * 2,
        )

    def test_a_named_subject_is_minted_and_the_merge_feed_mints_nothing_for_that_dispatch(self) -> None:
        tools = self.tools_dir("named")
        self._record(tools)
        base = _git(self.repo, "rev-parse", f"{self.feature_head}^")
        subject = resolve_change_subject(self.repo, change_base=base, change_head=self.feature_head)
        with facts_without_contract_edges():
            dispatch = dispatch_change_intelligence(
                cycle_id="d2-r2-named", base_dir=tools, subject=subject, workspace=self.paths,
            )
        # SE-5 — the named change's two seats (the service seat of libs/zz-core and the lens), both about the subject.
        self.assertEqual([m["subject_ref"] for m in dispatch["minted"]], [subject.ref] * 2)
        self.assertEqual(dispatch["skipped"], [], "the merged row beside the subject was considered, not ignored")
        refs = [row.get("subject_ref") for row in self._requests(tools)]
        self.assertEqual(refs, [subject.ref] * 2, "the ledger holds a request that is not the named subject's")
        self.assertFalse(any(str(ref).startswith("merged-pr:") for ref in refs), "the merge feed minted a request")


class RegisteredRecallFloorTests(unittest.TestCase):
    """R15 — the pre-registered floor's VALUE is pinned, so a post-hoc edit goes red."""

    @staticmethod
    def _floor_is_the_registered_value(block: dict[str, Any]) -> bool:
        return block["context"]["recall_floor"] == REGISTERED_RECALL_FLOOR

    def test_the_shipped_default_file_registers_the_floor_value(self) -> None:
        raw = json.loads(SHIPPED_POLICY_FILE.read_text(encoding="utf-8"))
        self.assertEqual(raw["change_review"]["context"]["recall_floor"], REGISTERED_RECALL_FLOOR)

    def test_the_strict_parser_hands_back_the_registered_value(self) -> None:
        floor = change_review_policy()["context"]["recall_floor"]
        self.assertIsInstance(floor, float)
        self.assertEqual(floor, REGISTERED_RECALL_FLOOR)
        self.assertEqual(default_policy()["change_review"]["context"]["recall_floor"], REGISTERED_RECALL_FLOOR)

    def test_a_changed_floor_in_a_temporary_override_copy_is_detected_by_the_pin(self) -> None:
        repo = Path(tempfile.mkdtemp(prefix="aria-d2-floor-"))
        self.addCleanup(shutil.rmtree, repo, True)
        (repo / "aria-config").mkdir()
        # An override replaces the change_review block whole: copy the shipped block, move only the floor.
        block = json.loads(json.dumps(default_policy()["change_review"]))
        self.assertTrue(self._floor_is_the_registered_value(block), "the copy does not start at the registered value")
        block["context"]["recall_floor"] = 0.5
        (repo / "aria-config" / "genesis_policy.json").write_text(json.dumps({"change_review": block}), "utf-8")
        overridden = change_review_policy(repo)
        self.assertEqual(overridden["context"]["recall_floor"], 0.5, "the override was not read: the probe proves nothing")
        self.assertFalse(
            self._floor_is_the_registered_value(overridden),
            "a floor moved to 0.5 passes the pin",
        )
        self.assertTrue(self._floor_is_the_registered_value(change_review_policy()))


if __name__ == "__main__":
    unittest.main()
