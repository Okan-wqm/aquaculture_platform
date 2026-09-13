"""ARIA-HIGH-104 — the implementer→merge seam, end to end.

One plan the real gate drove to CONVERGED; the real V9 implementation
runner under ``strict`` (staging, envelope mint, state transition); git and
ssh-keygen real; only the validation children (``npx nx …`` / ``npm run …``,
minutes of CI that prove nothing about this seam) and the GitHub
installation token (``ARIA_DRY_RUN``, the kernel's own no-network gate) are
answered without leaving the box. The envelope that comes out is held to
every contract the five gaps found unstated: it validates under
``agent_contract.validate_request``, carries the plan's validation suite,
its commit contract, and a prompt that names ``paths`` and the trailer; the
branch the implementer then commits is refused by the pre-PR-open perimeter
when its trailer is not the derived one, and opened when it is.

The plan's key change is worded, and its file named, with words from
``BANNED_PHRASES_DEFAULT`` — the shape the ARIA-HIGH-104 verifier drove to
CONVERGED and then watched the runner refuse at the implementation mint
(``IMPLEMENTATION_REQUEST_REFUSED``, ``envelope_governance_error``), every
cycle, with the plan left CONVERGED: the mint scanned obligation text it had
copied from the plan for a rule the plan contract never applied. The words
are read from the SSoT the scan reads, never spelled here; the runner has to
DISPATCH on them.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import validation as validation_module
from aria_kernel.agent_contract import validate_request
from aria_kernel.agent_invocations import (
    fuse_prompt_envelope,
    list_agent_invocation_requests,
    render_invocation_prompt,
)
from aria_kernel.apply_engine import run_apply_gate
from aria_kernel.cycle_phases.implementer import AutonomousV9ImplementationRunner
from aria_kernel.draft_intent import BANNED_PHRASES_DEFAULT
from aria_kernel.implementation_safety import CANONICAL_VALIDATION_COMMANDS_EXECUTABLE
from aria_kernel.plan_contract import plan_validation_suite
from aria_kernel.plan_convergence import fold_plan_state, plan_body_from_state
from aria_kernel.plan_origin import commit_contract_for_plan
from aria_kernel.pr_manager import PERIMETER_REFUSED_PREFIX, open_pr_for_action
from aria_kernel.proposal import get_proposal
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_binding

from tests._helpers.git_fixtures import make_repo_with_initial_commit
from tests.test_implementation_lifecycle_continuity import (
    converging_plan_content,
    drive_plan_to_converged,
    seed_reviewer_agent,
)
from tests.test_pr_manager_e2e import _fake_child_process

# A file whose name carries a banned word, a key change worded with another.
_PATH_WORD, _WORDING_WORD = BANNED_PHRASES_DEFAULT[2], BANNED_PHRASES_DEFAULT[8]
SOURCE = f"apps/farm-service/src/{_PATH_WORD}-sample-interval.ts"
KEY_CHANGE_TEXT = f"halve the {_WORDING_WORD}-shipment sample interval"
PLAN_ID = "plan-aria-high-104"
CYCLE_ID = "cyc-aria-high-104"
FINDING = "ORPHAN-HIGH-104"


class ImplementerMergeSeamTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-104-seam-")
        fixture = Path(self.tmp.name).resolve()
        self.repo = make_repo_with_initial_commit(fixture, {
            SOURCE: "export const sampleIntervalMs = 60000;\n",
            # The signing key the runner mints lands under aria-debts/keys/;
            # the real repository ignores it and staging refuses a dirty tree.
            ".gitignore": "aria-debts/keys/\n",
        }, name="workspace")
        self.tools = fixture / "aria-tools"
        seed_reviewer_agent(self.repo)
        self._git("add", ".claude")
        self._git("commit", "-q", "-m", "fixture: reviewer agent")
        set_profile("strict", operator_approval_ref="test:aria-high-104:seam",
                    base_dir=self.tools, set_by="operator", scheduler_ceiling="strict")
        ensure_tools_binding(self.tools, workspace_root=self.repo)
        drive_plan_to_converged(
            plan_id=PLAN_ID, tools=self.tools, workspace_root=self.repo,
            plan_content=converging_plan_content(
                "ARIA-HIGH-104 seam plan",
                affected_surfaces=[{"paths": [SOURCE]}],
                key_changes=[{"id": "kc-1", "description": KEY_CHANGE_TEXT, "paths": [SOURCE]}],
                evidence_refs=[SOURCE],
                finding_id=FINDING,
            ),
        )
        # The token factory's no-network gate: a sentinel token file instead
        # of an installation-token POST or an operator PAT copy.
        env = patch.dict(os.environ, {"ARIA_DRY_RUN": "1"})
        env.start()
        self.addCleanup(env.stop)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _git(self, *argv: str) -> str:
        return subprocess.run(["git", *argv], cwd=self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def _run_runner(self):
        with _fake_child_process(validation_module):
            return AutonomousV9ImplementationRunner().run(
                cycle_id=CYCLE_ID, plan_id=PLAN_ID, workspace_root=self.repo, base_dir=self.tools,
                cross_review_summary={"verdict": "agreed", "revision_id": "cr-1"}, profile="strict",
            )

    def _implementation_row(self) -> dict:
        rows = [row for row in list_agent_invocation_requests(base_dir=self.tools, convergence_id=PLAN_ID)
                if row.get("role") == "implementation"]
        self.assertEqual(len(rows), 1, rows)
        return rows[0]

    def _implement(self, row: dict, *, trailer: str | None, subject: str) -> str:
        ids = row["implementation_ids"]
        self._git("switch", "-q", "-c", ids["branch"], ids["base_sha"])
        (self.repo / SOURCE).write_text("export const sampleIntervalMs = 30000;\n", encoding="utf-8")
        self._git("add", SOURCE)
        message = subject + "\n\nWHY: the plan says so.\n" + (f"\n{trailer}\n" if trailer else "")
        self._git("commit", "-q", "-m", message)
        with _fake_child_process(validation_module):
            gated = run_apply_gate(proposal_id=ids["proposal_id"], change_id=ids["change_id"],
                                   base_dir=self.tools, runner_identity="ci-executor:gha-test")
        self.assertEqual(gated["status"], "ready_for_pr")
        return ids["proposal_id"]

    def test_the_minted_envelope_honours_every_seam_contract(self) -> None:
        result = self._run_runner()
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_DISPATCHED", result)
        self.assertEqual(fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["state"], "IMPLEMENTATION_REQUESTED")

        row = self._implementation_row()
        # (5) + (1): the request contract accepts the row the queue minted,
        # with the store so the plan-revision agreement check runs.
        validate_request(row, base_dir=self.tools)
        self.assertEqual(row["cycle_id"], CYCLE_ID)

        body = plan_body_from_state(fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools))
        expected_suite = list(plan_validation_suite(body["plan_content"], base_dir=self.tools))
        # (1): the envelope's suite is the plan's — and the suite staging ran
        # as baseline and recorded on the proposal, one derivation.
        self.assertEqual(row["validation_commands"], expected_suite)
        self.assertEqual(expected_suite, list(CANONICAL_VALIDATION_COMMANDS_EXECUTABLE))
        proposal = get_proposal(proposal_id=row["implementation_ids"]["proposal_id"], base_dir=self.tools)
        self.assertEqual(proposal["validation_scope"]["commands"], expected_suite)
        suite_obligation = next(item for item in row["must_satisfy"] if item["id"] == "validation:canonical_suite")
        self.assertEqual(suite_obligation["validation_commands"], expected_suite)

        # (4): the commit contract is the kernel's derivation, as data.
        self.assertEqual(row["commit_contract"], commit_contract_for_plan(body["plan_content"], plan_id=PLAN_ID))
        self.assertEqual(row["commit_contract"]["trailer"], f"Closes: docs/reviews/orphan-findings.md#{FINDING}")
        self.assertEqual(row["forbidden_scope"][0], ".claude/agents/")

        # The prompt the agent reads — re-rendered from the fused projection
        # the claim hands out, which must reproduce the sealed hash.
        prompt = render_invocation_prompt(fuse_prompt_envelope(row))
        self.assertEqual("sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest(), row["prompt_hash"])
        self.assertIn("## Validation commands", prompt)
        for command in expected_suite:
            self.assertIn(f"  - `{command}`", prompt)
        self.assertIn("## Commit contract", prompt)
        self.assertIn(f"`Closes: docs/reviews/orphan-findings.md#{FINDING}`", prompt)
        # (3): the prompt speaks `paths`, never the field no producer wrote.
        self.assertIn("paths", prompt)
        self.assertNotIn("key_changes[].file", prompt)
        # The obligation text is the kernel's; the plan's wording and paths
        # ride under the obligation's data block (render v6).
        self.assertIn("- **key_change:0**: Apply key_changes[0] of the CONVERGED plan", prompt)
        self.assertIn('<obligation_data id="key_change:0">', prompt)
        self.assertIn(f'"plan_description": "{KEY_CHANGE_TEXT}"', prompt)
        self.assertIn(f'"paths": ["{SOURCE}"]', prompt)
        # The words the plan brought reach the agent as data and nowhere else:
        # no obligation's scanned text carries either.
        for item in row["must_satisfy"]:
            for word in (_PATH_WORD, _WORDING_WORD):
                self.assertNotIn(word, item["description"], item["id"])

    def test_a_checkout_git_cannot_sign_in_is_refused_before_the_implementer_runs(self) -> None:
        """ARIA-HIGH-114 — the merge gate verifies every implementer commit
        against the cycle key, so a checkout the mint could not wire is a
        run that can only end refused. The runner reads the mint's receipt
        and refuses by name, spending no implementer turn and leaving the
        plan CONVERGED for a checkout that can sign."""
        from aria_kernel import gh_token_factory
        from aria_kernel.ledger import load_declared_jsonl

        with patch.object(gh_token_factory, "_resolve_signing_checkout", lambda root: None):
            result = self._run_runner()
        self.assertEqual(result.terminal_state, "IMPLEMENTATION_REQUEST_REFUSED")
        self.assertEqual(result.rejection_class, "git_signing_unconfigured")
        rows = [row for row in load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
                if row.get("kind") == "implementation_git_signing_unconfigured"]
        self.assertEqual(len(rows), 1, rows)
        self.assertEqual(rows[0]["details"]["reason"], "not_a_checkout")
        self.assertEqual(rows[0]["details"]["cycle_id"], CYCLE_ID)
        self.assertEqual(fold_plan_state(plan_id=PLAN_ID, base_dir=self.tools)["state"], "CONVERGED",
                         "no envelope was minted; the plan waits for a checkout that can sign")
        self.assertEqual(
            [row for row in list_agent_invocation_requests(base_dir=self.tools, convergence_id=PLAN_ID)
             if row.get("role") == "implementation"], [],
        )
        self.assertEqual(sorted(p.name for p in (self.repo / "aria-debts" / "keys").iterdir()), [],
                         "the cycle key is revoked on the refusal path too")

    def test_the_perimeter_refuses_an_invented_trailer_and_opens_the_derived_one(self) -> None:
        self._run_runner()
        row = self._implementation_row()
        proposal_id = self._implement(
            row, subject="fix(farm-service): halve the sample interval",
            trailer="Closes: aria-findings/F-V9-01.json#F-V9-01",
        )
        with self.assertRaisesRegex(GovernanceError, PERIMETER_REFUSED_PREFIX + ".*commit_contract_honoured:commit_contract_violated"):
            open_pr_for_action(proposal_id=proposal_id, workspace_root=self.repo, base_dir=self.tools, dry_run=True)
        # Rewrite the branch's one commit with the derived trailer: the same
        # diff, the trailer the contract printed, and the perimeter opens it.
        self._git("commit", "-q", "--amend", "-m",
                  "fix(farm-service): halve the sample interval\n\nWHY: the plan says so.\n\n" + row["commit_contract"]["trailer"])
        with _fake_child_process(validation_module):
            run_apply_gate(proposal_id=proposal_id, change_id=row["implementation_ids"]["change_id"],
                           base_dir=self.tools, runner_identity="ci-executor:gha-test")
        opened = open_pr_for_action(proposal_id=proposal_id, workspace_root=self.repo, base_dir=self.tools, dry_run=True)
        self.assertEqual(opened["head_sha"], self._git("rev-parse", "HEAD"))


if __name__ == "__main__":
    unittest.main()
