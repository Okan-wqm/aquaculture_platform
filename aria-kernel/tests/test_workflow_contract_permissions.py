"""ARIA-HIGH-589 — a governed job's token is judged by what it GRANTS.

GitHub reads a job's ``permissions:`` either as a scope map or as one of the
keywords ``write-all`` / ``read-all``; a job that declares one replaces the
workflow-level value entirely. The contract verifier used to read only a
mapping, so a governed job declaring ``permissions: write-all`` fell back to
the workflow-level map and passed its least-privilege contract while its
token could write every scope.

Each case drives the real entry point (``verify_workflow_contract``) on a
copy of the live ``rule-health-report.yml`` whose job ``generate`` the
registry governs (contract: ``contents: write``, ``pull-requests: write``).
"""

from __future__ import annotations

import re
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.workflow_contract_registry import (
    GITHUB_TOKEN_SCOPES,
    WORKFLOW_CONTRACTS,
    declared_token_permissions,
)
from aria_kernel.workflow_contracts import verify_workflow_contract

REPO = Path(__file__).resolve().parents[2]
WORKFLOW_ID = "rule-health-report"
JOB_ID = "generate"
CONTRACT = WORKFLOW_CONTRACTS[WORKFLOW_ID]
LIVE = (REPO / CONTRACT.workflow_file).read_text(encoding="utf-8")
GRANTED = {
    key
    for job in CONTRACT.job_contracts
    if job.job_id == JOB_ID
    for key, value in job.required_permissions
    if value == "write"
}
TOP_PERMISSIONS = re.compile(r"^permissions:\n(?:  [^\n]*\n)+", re.MULTILINE)


class GovernedJobTokenPermissionsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-wf-permissions-"))
        self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)

    def _verify(self, text: str):  # noqa: ANN202 - the verdict dataclass
        path = self.root / CONTRACT.workflow_file
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        return verify_workflow_contract(workflow_id=WORKFLOW_ID, workspace_root=self.root)

    def _with_job_permissions(self, value: str) -> str:
        marker = f"\n  {JOB_ID}:\n"
        self.assertIn(marker, LIVE)
        return LIVE.replace(marker, f"{marker}    permissions: {value}\n", 1)

    def _with_top_permissions(self, value: str) -> str:
        self.assertRegex(LIVE, TOP_PERMISSIONS)
        return TOP_PERMISSIONS.sub(f"permissions: {value}\n", LIVE, count=1)

    def _uncontracted(self, reasons: tuple[str, ...]) -> set[str]:
        prefix = f"workflow_uncontracted_write_permission:{JOB_ID}:"
        return {reason[len(prefix) :] for reason in reasons if reason.startswith(prefix)}

    def test_the_live_workflow_is_valid(self) -> None:
        verdict = self._verify(LIVE)
        self.assertTrue(verdict.valid, verdict.reasons)

    def test_job_level_write_all_is_refused_for_every_uncontracted_scope(self) -> None:
        verdict = self._verify(self._with_job_permissions("write-all"))
        self.assertFalse(verdict.valid)
        self.assertIn("workflow_permissions", verdict.failure_classes)
        self.assertEqual(self._uncontracted(verdict.reasons), set(GITHUB_TOKEN_SCOPES) - GRANTED)

    def test_workflow_level_write_all_reaches_a_job_without_its_own_block(self) -> None:
        verdict = self._verify(self._with_top_permissions("write-all"))
        self.assertFalse(verdict.valid)
        self.assertEqual(self._uncontracted(verdict.reasons), set(GITHUB_TOKEN_SCOPES) - GRANTED)

    def test_job_level_read_all_replaces_the_workflow_writes(self) -> None:
        # The job's read-all REPLACES the workflow-level write map: the token
        # writes nothing, so the contract's required writes are missing.
        verdict = self._verify(self._with_job_permissions("read-all"))
        self.assertFalse(verdict.valid)
        self.assertEqual(self._uncontracted(verdict.reasons), set())
        for scope in GRANTED:
            self.assertIn(
                f"workflow_permission_mismatch:{JOB_ID}:{scope}:'read'!='write'",
                verdict.reasons,
            )

    def test_job_level_empty_map_replaces_the_workflow_writes(self) -> None:
        verdict = self._verify(self._with_job_permissions("{}"))
        self.assertFalse(verdict.valid)
        for scope in GRANTED:
            self.assertIn(f"workflow_permission_mismatch:{JOB_ID}:{scope}:None!='write'", verdict.reasons)

    def test_a_keyword_github_does_not_accept_is_refused(self) -> None:
        verdict = self._verify(self._with_job_permissions("write-everything"))
        self.assertFalse(verdict.valid)
        self.assertIn(f"workflow_permissions_invalid:{JOB_ID}:'write-everything'", verdict.reasons)


class DeclaredTokenPermissionsTests(unittest.TestCase):
    """The one reading of a ``permissions:`` value (job or workflow level)."""

    def test_keywords_grant_every_scope(self) -> None:
        self.assertEqual(declared_token_permissions("write-all"), {s: "write" for s in GITHUB_TOKEN_SCOPES})
        self.assertEqual(declared_token_permissions("read-all"), {s: "read" for s in GITHUB_TOKEN_SCOPES})

    def test_a_map_is_read_as_declared_and_an_empty_value_grants_nothing(self) -> None:
        self.assertEqual(declared_token_permissions({"contents": "read"}), {"contents": "read"})
        self.assertEqual(declared_token_permissions({}), {})
        self.assertEqual(declared_token_permissions(None), {})

    def test_an_unknown_keyword_is_not_a_grant(self) -> None:
        self.assertIsNone(declared_token_permissions("write-everything"))
        self.assertIsNone(declared_token_permissions(["contents"]))

    def test_the_scope_list_has_no_duplicates(self) -> None:
        self.assertEqual(len(GITHUB_TOKEN_SCOPES), len(set(GITHUB_TOKEN_SCOPES)))


if __name__ == "__main__":
    unittest.main()
