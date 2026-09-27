"""ARIA-CRITICAL-215 (user decision 2026-09-26) — L1 admits a NEW test, never a changed one.

With the unit-test trees in L1, ARIA could self-merge a change that weakens
an existing test (an assert deleted) that required CI executes: exactly
what 215's rule forbids. L1 membership is therefore a property of the
change, not of the path:

* ``docs/**/*.md`` — added (A) or modified (M) is L1, deleted (D) is L2;
* the unit-test globs — only added (A) is L1; M, D and T are L2;
* a rename is D + A (``--no-renames``), so moving an existing test is L2 by
  its deleted side;
* every L3 rule and the CODEOWNERS fail-safe still win;
* a path whose status is unknown (the platform's file list, a bare path) is
  never L1: the change is refused by name.

The change fixtures run through git (``record_risk_decision_for_pr``,
``merge_route_for_change``), the path the merge chain actually takes.
"""
from __future__ import annotations

import copy
import subprocess
import tempfile
import unittest
from pathlib import Path

from aria_kernel.risk_policy import (
    classify_change,
    classify_path,
    load_risk_policy,
    merge_route_for_change,
    record_risk_decision_for_pr,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir
from tests._helpers.git_fixtures import make_local_git_repo

SPEC = "apps/farm-service/src/batch/__tests__/batch.spec.ts"
SRC_SPEC = "apps/farm-service/src/batch/batch.service.spec.ts"
NEW_SPEC = "apps/farm-service/src/batch/__tests__/harvest.spec.ts"
DOC = "docs/runbooks/guide.md"
NEW_DOC = "docs/runbooks/new-guide.md"


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


class _ChangeCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        root = Path(self._tmp.name)
        self.repo = make_local_git_repo(root)
        _git(self.repo, "config", "diff.renames", "copies")
        self.tools = root / "aria-tools"
        ensure_tools_dir(self.tools)
        for path in (SPEC, SRC_SPEC, DOC):
            self._write(path, "it('holds', () => expect(1).toBe(1));\n")
        self.base = self._commit("base")

    def _write(self, relative: str, text: str) -> None:
        target = self.repo / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")

    def _commit(self, message: str) -> str:
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", message)
        return _git(self.repo, "rev-parse", "HEAD")

    def _decide(self, head: str, listed: list[str]) -> dict:
        pr = {
            "number": 3, "repository": "okan/aqua", "base_branch": "main", "head_ref": "aria/impl/x",
            "base_sha": self.base, "head_sha": head,
            "changed_files": [{"path": path} for path in listed], "changed_files_count": len(listed),
        }
        return record_risk_decision_for_pr(pr, workspace_root=self.repo, base_dir=self.tools)

    def _route(self, head: str) -> dict:
        return merge_route_for_change(self.repo, self.base, head)


class UnitTestStatusTests(_ChangeCase):
    def test_an_added_spec_is_l1(self) -> None:
        self._write(NEW_SPEC, "it('new', () => expect(2).toBe(2));\n")
        head = self._commit("add a spec")
        row = self._decide(head, [NEW_SPEC])
        self.assertTrue(row["valid"], row["reason_codes"])
        self.assertEqual(row["lane"], "L1")
        self.assertEqual(row["changed_entries"], [["A", NEW_SPEC]])
        self.assertFalse(self._route(head)["human_merge"])

    def test_a_modified_spec_is_l2(self) -> None:
        # The weakening the rule exists for: an existing assert deleted.
        self._write(SPEC, "it('holds', () => {});\n")
        head = self._commit("weaken a spec")
        row = self._decide(head, [SPEC])
        self.assertEqual(row["lane"], "L2")
        self.assertEqual(row["changed_entries"], [["M", SPEC]])
        self.assertTrue(self._route(head)["human_merge"])

    def test_a_modified_src_spec_is_l2(self) -> None:
        self._write(SRC_SPEC, "it('holds', () => {});\n")
        head = self._commit("weaken a src spec")
        self.assertEqual(self._decide(head, [SRC_SPEC])["lane"], "L2")

    def test_a_deleted_spec_is_l2(self) -> None:
        (self.repo / SPEC).unlink()
        head = self._commit("delete a spec")
        row = self._decide(head, [SPEC])
        self.assertEqual(row["lane"], "L2")
        self.assertEqual(row["changed_entries"], [["D", SPEC]])
        self.assertTrue(self._route(head)["human_merge"])

    def test_a_renamed_spec_is_not_l1_by_its_deleted_side(self) -> None:
        _git(self.repo, "mv", SPEC, NEW_SPEC)
        head = self._commit("move a spec")
        row = self._decide(head, [NEW_SPEC])
        self.assertNotEqual(row["lane"], "L1")
        self.assertFalse(row["valid"])
        self.assertEqual(sorted(row["changed_entries"]), [["A", NEW_SPEC], ["D", SPEC]])
        # The deleted side is L2; the new side alone would be L1. A change
        # holding both lanes is refused as mixed, never classified L1.
        self.assertEqual(classify_path(SPEC, status="D"), "L2")
        self.assertEqual(classify_path(NEW_SPEC, status="A"), "L1")
        self.assertIn("risk_mixed_lanes", row["reason_codes"])
        self.assertEqual(row["matched_lanes"], ["L1", "L2"])
        self.assertTrue(self._route(head)["human_merge"])

    def test_a_new_spec_with_a_modified_spec_is_not_l1(self) -> None:
        self._write(NEW_SPEC, "it('new', () => expect(2).toBe(2));\n")
        self._write(SPEC, "it('holds', () => {});\n")
        head = self._commit("add one, weaken one")
        row = self._decide(head, [NEW_SPEC, SPEC])
        self.assertNotEqual(row["lane"], "L1")
        self.assertFalse(row["valid"])
        self.assertIn("risk_mixed_lanes", row["reason_codes"])
        self.assertEqual(row["matched_lanes"], ["L1", "L2"])
        self.assertTrue(self._route(head)["human_merge"])


class DocStatusTests(_ChangeCase):
    def test_an_added_doc_is_l1(self) -> None:
        self._write(NEW_DOC, "# new\n")
        head = self._commit("add a doc")
        row = self._decide(head, [NEW_DOC])
        self.assertEqual((row["valid"], row["lane"]), (True, "L1"))
        self.assertEqual(row["changed_entries"], [["A", NEW_DOC]])

    def test_a_modified_doc_is_l1(self) -> None:
        self._write(DOC, "# rewritten\n")
        head = self._commit("edit a doc")
        row = self._decide(head, [DOC])
        self.assertEqual((row["valid"], row["lane"]), (True, "L1"))
        self.assertFalse(self._route(head)["human_merge"])

    def test_a_deleted_doc_is_l2(self) -> None:
        (self.repo / DOC).unlink()
        head = self._commit("delete a doc")
        row = self._decide(head, [DOC])
        self.assertEqual(row["lane"], "L2")
        self.assertEqual(row["changed_entries"], [["D", DOC]])
        self.assertTrue(self._route(head)["human_merge"])


class StatusIsRequiredForL1Tests(unittest.TestCase):
    def test_a_bare_path_is_never_l1_and_is_refused_by_name(self) -> None:
        # The platform's file list carries no status; nothing it alone
        # names can be L1.
        for path in (NEW_SPEC, DOC):
            with self.subTest(path=path):
                verdict = classify_change([path])
                self.assertFalse(verdict.valid)
                self.assertNotEqual(verdict.lane, "L1")
                self.assertIn("risk_change_status_unknown", verdict.reason_codes)
                self.assertNotEqual(classify_path(path, status=None), "L1")

    def test_a_status_the_policy_does_not_know_is_unknown(self) -> None:
        verdict = classify_change([("R100", NEW_SPEC)])
        self.assertNotEqual(verdict.lane, "L1")
        self.assertIn("risk_change_status_unknown", verdict.reason_codes)

    def test_a_status_blind_path_that_is_never_l1_keeps_its_lane(self) -> None:
        # Status only decides L1 membership; an L3 path is L3 whatever it is.
        self.assertEqual(classify_change(["docs/aria/x.md"]).lane, "L3")
        self.assertEqual(classify_change([("D", "docs/adr/x.md")]).lane, "L3")

    def test_l3_and_codeowners_win_over_an_added_file(self) -> None:
        for path in (
            "e2e/tests/integration/nats-invariants.spec.ts",
            "apps/farm-service/src/__tests__/invariants/new.spec.ts",
            "apps/farm-service/src/batch/__tests__/integration/new.integration.spec.ts",
            "docs/adr/099-new.md",
            "docs/plans/new/README.md",
        ):
            with self.subTest(path=path):
                self.assertEqual(classify_path(path, status="A"), "L3")

    def test_a_type_change_is_never_l1(self) -> None:
        self.assertEqual(classify_path(SPEC, status="T"), "L2")
        self.assertEqual(classify_path(DOC, status="T"), "L2")


class PolicyDeclaresStatusesTests(unittest.TestCase):
    def _policy_with_l1(self, l1: dict) -> dict:
        policy = copy.deepcopy(load_risk_policy())
        policy["lanes"]["L1"] = l1
        return policy

    def test_a_status_blind_l1_glob_list_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "risk_policy_l1_entries_required"):
            load_risk_policy(self._policy_with_l1({"reason_code": "x", "globs": ["docs/**/*.md"]}))

    def test_an_l1_entry_without_statuses_is_refused(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "risk_policy_l1_entry_statuses_required"):
            load_risk_policy(self._policy_with_l1({
                "reason_code": "x", "disallowed_status_lane": "L2",
                "entries": [{"glob": "docs/**/*.md"}],
            }))

    def test_l1_never_admits_a_deletion_or_a_type_change(self) -> None:
        for statuses in (["A", "D"], ["T"], [], ["a"]):
            with self.subTest(statuses=statuses), self.assertRaisesRegex(
                GovernanceError, "risk_policy_l1_entry_statuses_required",
            ):
                load_risk_policy(self._policy_with_l1({
                    "reason_code": "x", "disallowed_status_lane": "L2",
                    "entries": [{"glob": "docs/**/*.md", "allowed_statuses": statuses}],
                }))

    def test_the_disallowed_status_lane_is_never_l1(self) -> None:
        for lane in ("L1", None, "blocked"):
            with self.subTest(lane=lane), self.assertRaisesRegex(
                GovernanceError, "risk_policy_l1_disallowed_status_lane",
            ):
                load_risk_policy(self._policy_with_l1({
                    "reason_code": "x", "disallowed_status_lane": lane,
                    "entries": [{"glob": "docs/**/*.md", "allowed_statuses": ["A"]}],
                }))

    def test_the_repository_policy_admits_tests_only_as_added_files(self) -> None:
        entries = load_risk_policy()["lanes"]["L1"]["entries"]
        self.assertEqual(
            [(entry["glob"], entry["allowed_statuses"]) for entry in entries],
            [
                ("docs/**/*.md", ["A", "M"]),
                ("apps/**/__tests__/**", ["A"]),
                ("libs/**/__tests__/**", ["A"]),
                ("web/**/__tests__/**", ["A"]),
                ("apps/**/src/**/*.spec.ts", ["A"]),
                ("libs/**/src/**/*.spec.ts", ["A"]),
                ("web/**/src/**/*.spec.ts", ["A"]),
            ],
        )


class TheEvaluationReadsStatusesTests(unittest.TestCase):
    def test_the_status_blind_evaluation_is_never_low_risk(self) -> None:
        from aria_kernel.auto_merge import classify_changed_files

        verdict = classify_changed_files([NEW_SPEC])
        self.assertNotEqual(verdict["risk_class"], "low")
        self.assertIn("risk_change_status_unknown", verdict["enterprise_risk"]["reason_codes"])
        self.assertEqual(classify_changed_files([("A", NEW_SPEC)])["risk_class"], "low")
        self.assertNotEqual(classify_changed_files([("M", SPEC)])["risk_class"], "low")


if __name__ == "__main__":
    unittest.main()
