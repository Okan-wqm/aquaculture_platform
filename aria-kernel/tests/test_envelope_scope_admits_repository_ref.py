"""ARIA-HIGH-614 — an envelope must leave its agent a ref it can cite and have admitted.

ARIA-MEDIUM-385 moved the kernel pointers (``cycle:``, ``plan:``, ``seed:`` …)
off ``evidence_refs`` and onto their own fields, and made the mint refuse them
for every role. That closed the pointer channel but left the OTHER half of the
box unanswerable: five producers still mint with an ``allowed_scope`` that is a
non-repository namespace label — ``plan-convergence/<plan_id>``
(decision_questioning), ``cycle/<cycle_id>`` (the Gate B adversarial judge and
the specialist fallback), ``convergent/<seed_id>`` (the genesis drafter and
judge). No repository path can match such a glob, the envelopes carry no
``evidence_refs`` and no ``evidence_scope``, and the response law refuses every
repository citation as ``agent_evidence_outside_allowed_scope``
(evidence_validator.py:921). The agent's only compliant move is to answer with
no evidence at all — a paid run that can only buy a refused answer. Three
``verification`` runs were rejected exactly here on 2026-10-15/16.

Each envelope now carries the repository box its own subject names, and the
mint refuses a box that holds no citable ref at all — the mint-side twin of
the response law's cross-check, as ARIA-HIGH-384/385 require:

* decision_questioning — the closed plan's own record: its ``evidence_refs``
  as ``evidence_refs``, its round-contract ``allowed_scope`` +
  ``evidence_scope`` as the read-only ``evidence_scope``. The prompt already
  told the agent to "re-resolve the plan's evidence_refs"; the envelope never
  carried them.
* review_runner Gate B — the converged plan's surfaces from the same round
  contract: the implementation worked inside the plan's bound, so the judge
  that audits it may cite it.
* specialist_review_runner without a workspace — the same plan context
  ``_specialist_plan_context`` derives with one, from the plan state alone;
  a plan record that cannot be read mints nothing (``specialists_unavailable``)
  instead of an unanswerable envelope.
* dispatcher_factory genesis drafter/judge — the evidence pack's own
  observations as ``evidence_refs`` and its scan surfaces as
  ``evidence_scope``, with the pack itself embedded in the prompt that tells
  the agent to read it.

Every test below mints through the REAL producer entry point and judges the
answer with the REAL response law at a real committed workspace, the same
discipline the ARIA-HIGH-357 suite pinned for planning rounds.
"""
from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    list_agent_invocation_requests,
)
from aria_kernel.evidence_validator import validate_agent_response_evidence
from aria_kernel.request_admission import admit_request
from aria_kernel.tool_registry import GovernanceError, bound_workspace_root, ensure_tools_dir
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.routing_fixture import write_routing_table
from tests._helpers.hermetic_git import apply_hermetic_git_env
from tests.test_decision_questioning import _QuestioningFixture

SPEC = "docs/aria/SPEC.md"
LEAVE = "apps/farm-service/src/leave/leave.service.ts"

_WORKSPACE_SOURCES = {
    SPEC: "# ARIA specification\n\nThe submit law refuses an unevidenced answer.\n",
    LEAVE: "export class LeaveService {\n  approve() {\n    return true;\n  }\n}\n",
}


def _git(repo: Path, *argv: str) -> str:
    """Hermetic git in the fixture repo: no GIT_* location variable may leak in."""
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("GIT_")
    }
    result = subprocess.run(
        ["git", *argv], cwd=repo, text=True, capture_output=True, check=True, env=env,
    )
    return result.stdout.strip()


class _WorkspaceFixture(unittest.TestCase):
    """A committed two-file workspace, a tools store, and a started plan citing it."""

    def setUp(self) -> None:
        apply_hermetic_git_env()
        import tempfile

        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        make_local_git_repo(self.root.parent, name=self.root.name, initial_commit=False)
        (self.root / ".claude" / "agents").mkdir(parents=True)
        for relpath, text in _WORKSPACE_SOURCES.items():
            (self.root / relpath).parent.mkdir(parents=True, exist_ok=True)
            (self.root / relpath).write_text(text, encoding="utf-8")
        _git(self.root, "add", "--", SPEC, LEAVE, ".claude")
        _git(self.root, "commit", "-q", "-m", "chore(test): the cited workspace")
        self.head = _git(self.root, "rev-parse", "HEAD")
        self.tools = ensure_tools_dir(Path(self.tmp.name) / "aria-tools")

    def _plan_content(self, *, surfaces: list[str]) -> dict:
        return {
            "schema_version": 1,
            "title": "Envelope scope fixture",
            "summary": "A plan whose evidence and surfaces exist in the workspace.",
            "key_changes": [{"id": "kc-1", "description": "fix the drift", "paths": surfaces}],
            "evidence_refs": [SPEC],
            "validation_commands": [{"cmd": "nx affected --target=test"}],
            "affected_surfaces": [{"paths": surfaces}],
            "architectural_tier": 2,
        }

    def _start_plan(self, plan_id: str, *, surfaces: list[str]) -> None:
        from aria_kernel.plan_convergence import start_plan

        start_plan(
            plan_id=plan_id,
            initial_revision_id=f"rev-{plan_id}-0",
            plan_content=self._plan_content(surfaces=surfaces),
            base_dir=self.tools,
        )

    def _requests(self, **filters) -> list[dict]:
        return list_agent_invocation_requests(base_dir=self.tools, **filters)

    def _judge_response(self, row: dict, ref: str) -> dict:
        """The response law's verdict for an answer citing ``ref``, as the
        executor's submit path threads it: the request row plus the proven
        ``evidence_target_sha`` override (agent_invocations.py sets the same
        field on the strict view before validating)."""
        return validate_agent_response_evidence(
            response={
                "evidence_refs": [ref],
                "satisfaction_matrix": [
                    {"id": str(item.get("id") or "ms"), "evidence_refs": [ref]}
                    for item in (row.get("must_satisfy") or [{"id": "ms"}])
                ],
            },
            workspace_root=self.root,
            request={**row, "evidence_target_sha": self.head},
        )

    def assert_citable(self, row: dict, ref: str) -> None:
        verdict = self._judge_response(row, ref)
        codes = [str(error.get("code")) for error in verdict["errors"]]
        self.assertNotIn(
            "agent_evidence_outside_allowed_scope",
            codes,
            f"{ref} refused for the envelope {row['request_id']} scoped "
            f"{row.get('allowed_scope')}/{row.get('evidence_scope')}",
        )
        self.assertTrue(verdict["valid"], verdict["errors"])


class TheVerificationEnvelopeCarriesItsPlan(_QuestioningFixture):
    """decision_questioning — the plan's evidence and surfaces become the box."""

    def setUp(self) -> None:
        super().setUp()
        apply_hermetic_git_env()
        for relpath, text in _WORKSPACE_SOURCES.items():
            (self.root / relpath).parent.mkdir(parents=True, exist_ok=True)
            (self.root / relpath).write_text(text, encoding="utf-8")
        make_local_git_repo(self.root.parent, name=self.root.name, initial_commit=False)
        _git(self.root, "add", "--", SPEC, LEAVE)
        _git(self.root, "commit", "-q", "-m", "chore(test): the questioned workspace")
        self.head = _git(self.root, "rev-parse", "HEAD")

    def test_the_answer_citing_the_plans_evidence_passes_the_response_law(self) -> None:
        from aria_kernel.decision_questioning import open_decision_questioning

        self._converge("plan-closed")
        open_decision_questioning(base_dir=self.tools_dir)
        [row] = self._requests_by_plan()
        verdict = self._judge(row)
        self.assertNotIn(
            "agent_evidence_outside_allowed_scope",
            [str(error.get("code")) for error in verdict["errors"]],
        )
        self.assertTrue(verdict["valid"], verdict["errors"])

    def test_the_envelope_carries_the_plans_refs_and_read_only_scope(self) -> None:
        from aria_kernel.decision_questioning import open_decision_questioning

        self._converge("plan-closed")
        open_decision_questioning(base_dir=self.tools_dir)
        [row] = self._requests_by_plan()
        self.assertEqual(row["evidence_refs"], [SPEC])
        self.assertIn(
            "aria-kernel/aria_kernel/decision_questioning.py",
            row.get("evidence_scope") or [],
        )

    def _requests_by_plan(self) -> list[dict]:
        from aria_kernel.decision_questioning import QUESTIONING_ROLE

        return list_agent_invocation_requests(
            base_dir=self.tools_dir, convergence_id="plan-closed", role=QUESTIONING_ROLE,
        )

    def _judge(self, row: dict) -> dict:
        return validate_agent_response_evidence(
            response={
                "evidence_refs": [f"{SPEC}:2"],
                "satisfaction_matrix": [
                    {"id": "question-decision-plan-closed", "evidence_refs": [f"{SPEC}:2"]}
                ],
            },
            workspace_root=self.root,
            request={**row, "evidence_target_sha": self.head},
        )


class TheGateBJudgeCarriesItsPlan(_WorkspaceFixture):
    """review_runner — the adversarial judge audits inside the plan's bound."""

    def _run_review(self) -> None:
        from aria_kernel.review_runner import run_review_runner

        run_review_runner(
            cycle_id="cyc-614",
            base_dir=self.tools,
            workspace_root=None,
            plan_id="plan-614",
            convergence_id="plan-614",
            impl_artifacts_ref="",
            worker_artifact_hash="",
            must_satisfy=[{"id": "MS-1", "description": "the implementation closes the plan"}],
            max_review_rounds=1,
            judge_timeout_seconds=0.05,
        )

    def test_the_verdict_citing_the_implementation_surface_passes(self) -> None:
        self._start_plan("plan-614", surfaces=[LEAVE])
        self._run_review()
        [row] = self._requests(role="adversarial_judgment")
        self.assert_citable(row, f"{LEAVE}:2")

    def test_a_plan_record_that_cannot_be_read_blocks_rather_than_mints(self) -> None:
        # No plan in the store: the judge has no subject to audit, so no
        # envelope may be minted for it — the merge stays blocked, named.
        from aria_kernel.review_runner import run_review_runner

        result = run_review_runner(
            cycle_id="cyc-614",
            base_dir=self.tools,
            workspace_root=None,
            plan_id="plan-absent",
            convergence_id="plan-absent",
            impl_artifacts_ref="",
            worker_artifact_hash="",
            must_satisfy=[{"id": "MS-1", "description": "the implementation closes the plan"}],
            max_review_rounds=1,
            judge_timeout_seconds=0.05,
        )
        self.assertEqual(result["review_verdict"], "gaps_open")
        self.assertTrue(
            any("scope" in str(gap.get("id", "")) for gap in result["gaps_found"]),
            msg=f"gaps_found did not name the unanswerable scope: {result['gaps_found']}",
        )
        self.assertEqual(self._requests(), [])


class TheSpecialistFallbackCarriesItsPlan(_WorkspaceFixture):
    """specialist_review_runner without a workspace — the plan state is the box."""

    def _run_specialists(self) -> None:
        from aria_kernel.specialist_review_runner import run_specialist_review_runner

        # The store's workspace routes the touched service to its specialist (SE-2).
        write_routing_table(bound_workspace_root(self.tools), {"apps/farm-service/**": ("farm-expert", "")})
        return run_specialist_review_runner(
            cycle_id="cyc-614",
            base_dir=self.tools,
            workspace_root=None,
            plan_id="plan-614",
            convergence_id="plan-614",
            touched_services=["apps/farm-service/"],
            pressures=[],
            profile="standard",
            max_specialists_per_cycle=1,
            specialist_timeout_seconds=0.05,
        )

    def test_the_fallback_envelope_cites_inside_the_plans_surfaces(self) -> None:
        self._start_plan("plan-614", surfaces=[LEAVE])
        self._run_specialists()
        rows = self._requests(role="specialist_domain_review")
        self.assertTrue(rows, "the fallback must still mint its specialist envelopes")
        for row in rows:
            self.assert_citable(row, f"{LEAVE}:2")

    def test_a_plan_record_that_cannot_be_read_reports_unavailable(self) -> None:
        result = self._run_specialists()
        self.assertEqual(result["consolidated_verdict"], "specialists_unavailable")
        self.assertEqual(self._requests(), [])


class TheGenesisEnvelopesCarryTheirEvidencePack(_WorkspaceFixture):
    """dispatcher_factory — the pack's observations and surfaces are the box."""

    # The pack Phase 0 actually produces: observations over a scan scope,
    # bound to a base commit (evidence_collector.collect_evidence_pack).
    PACK = {
        "seed_id": "seed-614",
        "base_commit_sha": None,  # bound per-test to the fixture HEAD
        "declared_scope": ["apps/farm-service/"],
        "claim_types": ["api_contract"],
        "observations": [
            {"file_path": LEAVE, "line": 2, "snippet": "  approve() {", "claim_class": "api_contract"},
            {"file_path": LEAVE, "line": 3, "snippet": "    return true;", "claim_class": "api_contract"},
            {"file_path": SPEC, "line": 3, "snippet": "The submit law", "claim_class": "api_contract"},
        ],
    }

    def setUp(self) -> None:
        super().setUp()
        self.pack = dict(self.PACK)
        self.pack["base_commit_sha"] = self.head

    def _config(self):
        from aria_kernel.dispatcher_factory import DispatcherConfig

        return DispatcherConfig({"poll_timeout_seconds": 0.05, "poll_interval_seconds": 0.01})

    def test_the_drafter_envelope_is_answerable_from_the_pack(self) -> None:
        from aria_kernel.dispatcher_factory import select_drafter

        drafter = select_drafter(
            role="primary_authoring", base_dir=self.tools, config=self._config(), cycle_id="cyc-614",
        )
        drafter(
            seed_id="seed-614",
            must_satisfy=[{"id": "r", "description": "cite three evidence refs per rule"}],
            evidence_pack=self.pack,
            round_number=1,
        )
        [row] = self._requests(role="primary_authoring")
        self.assert_citable(row, f"{LEAVE}:2")

    def test_the_pack_the_prompt_names_is_on_the_envelope(self) -> None:
        from aria_kernel.dispatcher_factory import select_drafter

        drafter = select_drafter(
            role="primary_authoring", base_dir=self.tools, config=self._config(), cycle_id="cyc-614",
        )
        drafter(
            seed_id="seed-614",
            must_satisfy=[{"id": "r", "description": "cite three evidence refs per rule"}],
            evidence_pack=self.pack,
            round_number=1,
        )
        [row] = self._requests(role="primary_authoring")
        prompt = row["suggested_prompt"]
        # The prompt says "Read the supplied evidence_pack"; the pack's own
        # observations must ride with it, or the instruction names nothing.
        self.assertIn(f"{LEAVE}:2", prompt)
        self.assertIn("apps/farm-service/**", prompt)

    def test_the_judge_envelope_is_answerable_from_the_pack(self) -> None:
        from aria_kernel.dispatcher_factory import select_judge

        judge = select_judge(
            role="evidence_judgment", base_dir=self.tools, config=self._config(), cycle_id="cyc-614",
        )
        judge(primary_draft={}, sandbox_result={"precision": 1.0}, evidence_pack=self.pack)
        [row] = self._requests(role="evidence_judgment")
        self.assert_citable(row, f"{LEAVE}:2")


class TheMintRefusesABoxNoRefCanAnswer(_WorkspaceFixture):
    """The mint-side twin of the response law's cross-check."""

    def _mint(self, **overrides):
        role = overrides.get("role", "verification")
        kwargs = dict(
            target_agent="aria-adversarial-judge",
            role=role,
            suggested_prompt="verify the decision",
            must_satisfy=[{"id": "MS-1", "description": "cite the repository"}],
            allowed_scope=["cycle/cyc-614"],
            base_dir=self.tools,
            admission=admit_request("operator_cli.request", role, base_dir=self.tools),
        )
        kwargs.update(overrides)
        return create_agent_invocation_request(**kwargs)

    def test_a_namespace_only_box_is_refused_at_the_mint(self) -> None:
        with self.assertRaises(GovernanceError) as raised:
            self._mint()
        self.assertIn("agent_request_scope_admits_no_repository_ref", str(raised.exception))
        self.assertEqual(self._requests(), [])

    def test_a_citable_ref_opens_the_box(self) -> None:
        row = self._mint(evidence_refs=[f"{LEAVE}:2"])
        self.assertTrue(row["request_id"])

    def test_a_read_only_evidence_scope_opens_the_box(self) -> None:
        row = self._mint(evidence_scope=["apps/farm-service/**"])
        self.assertEqual(row["evidence_scope"], ["apps/farm-service/**"])

    def test_a_ledger_pointer_only_box_still_mints_for_the_adjudication_lane(self) -> None:
        # human_required_adjudication mints exactly this shape: its SUBJECT is
        # the escalation record, and the response law admits the pointer by
        # identity — the refusal is for namespace labels, not for pointers.
        row = self._mint(
            target_agent="aria-consensus-arbiter",
            role="human_required_adjudication",
            allowed_scope=["human-required:AIR-614-1"],
            evidence_refs=["human-required:AIR-614-1"],
        )
        self.assertTrue(row["request_id"])

    def test_the_operator_legacy_lane_is_untouched(self) -> None:
        row = self._mint(legacy_strict_fields_optional=True, allowed_scope=None)
        self.assertEqual(row["allowed_scope"], [])


class ANamespaceLabelNeverMatchesARepositoryPath(unittest.TestCase):
    """The live evidence, structurally: three paid verification runs were
    rejected for citing the only ref their box offered — a namespace label no
    repository path can match (the cross-check at evidence_validator.py:921)."""

    def test_the_cross_check_glob_never_matches_a_label(self) -> None:
        from aria_kernel.evidence_validator import _path_matches_any_glob

        self.assertFalse(_path_matches_any_glob("apps/farm-service/src/main.ts", ["cycle/cyc-1"]))
        self.assertFalse(
            _path_matches_any_glob("apps/farm-service/src/main.ts", ["plan-convergence/plan-1"])
        )
        self.assertFalse(_path_matches_any_glob("apps/farm-service/src/main.ts", ["convergent/seed-1"]))
        self.assertTrue(_path_matches_any_glob("apps/farm-service/src/main.ts", ["apps/**"]))


if __name__ == "__main__":
    unittest.main()
