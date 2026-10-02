"""ORPHAN-HIGH-519 — the kernel mints only plans whose evidence the challenger can cite.

WHY. Four of sixteen drafter episodes and the plan open on 2026-10-02 died
because the kernel minted a plan the challenger could not ground. Failing-CI
plans cited ``gh-run-list:<run>``, which the submit validator rejects as
``agent_evidence_ref_malformed``; failing CI outranks F findings, so every red
workflow on main produced such a plan (episode #13 refused
``agent_refused:evidence``; episode #16 is the plan still open). Operator
plans cited ``aria-tools/operator-feedback.jsonl:<id>``, which the same rule
refuses, and the ORPHAN fallback cited ``orphan-findings.md#<id>``, a path no
file has.

WHAT these pin:

* a failing-CI candidate is grounded in the workflow file GitHub ran and the
  lines of its failing job and step, and those refs pass the challenger's rule;
* a candidate with no admissible ref yields no plan and ONE named skip;
* an operator plan's evidence passes the rule, and the feedback row it consumed
  rides as provenance, where the merge owner reads it;
* every ``plan_started`` a producer causes cites only refs the rule admits;
* the recorded episode #16 inputs no longer mint an inadmissible plan.

"The challenger's rule" is ``evidence_validator.validate_agent_response_evidence``
judging a challenger that cites exactly the refs its request carried, at the
target commit the drainer threads (the checkout HEAD) — the submit path itself.
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from typing import Any, Callable
from unittest import mock

from aria_kernel import plan_synthesizer as ps
from aria_kernel.cycle_phases.plan_source import V9PressureSourceProvider
from aria_kernel.evidence_validator import validate_agent_response_evidence
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.operator_feedback_observation import _consumed_refs
from aria_kernel.plan_convergence import affected_surface_paths, start_plan
from tests._helpers.operator_requests import GROUNDED_FILE, OperatorRequestFixture, git

_REAL_RUN = subprocess.run
_WAL_WORKFLOW_PATH = ".github/workflows/database-wal-archive-freshness.yml"
# The head of that workflow as committed at d3adb0f89 (job `verify`, the step
# that failed in run 36785618591), trimmed to the lines a plan cites.
_WAL_WORKFLOW = """name: Database WAL Archive Freshness

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch: {}

permissions:
  contents: read

jobs:
  verify:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Checkout preflight helper
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Observe production WAL archive runtime
        id: observe
        run: |
          set -euo pipefail
          bash tools/scripts/database/observe-wal-archive.sh

      - name: Enforce the five-minute RPO
        run: bash tools/scripts/database/enforce-rpo.sh
"""
_WAL_STEP_LINE = _WAL_WORKFLOW.splitlines().index("      - name: Observe production WAL archive runtime") + 1
_WAL_JOB_LINE = _WAL_WORKFLOW.splitlines().index("  verify:") + 1

# Episode #16, as recorded on origin/aria/state @ 5351fcb18 (read with
# `git show`): tools/plans/events.jsonl plan_started of
# plan-cyc-20260930T214247Z-auto (ledger_hash sha256:7619f044…),
# tools/governance.jsonl plan_candidate_source_selected (ledger_hash
# sha256:1a174f4d…, candidate ci-run-36785618591, source failing_ci) and
# tools/agent-invocations/requests.jsonl AIR-aria-challenger-planner-83a038b1b7ac
# (evidence_refs ["gh-run-list:ci-run-36785618591"], allowed_scope
# [".github/workflows/"], target_sha 7166e2f5…).
EPISODE_16_PLAN_CONTENT: dict[str, Any] = {
    "affected_surfaces": [".github/workflows/"],
    "evidence_refs": ["gh-run-list:ci-run-36785618591"],
    "key_changes": [{
        "description": "Failing CI workflow 'Database WAL Archive Freshness' on head "
                       "7166e2f5ef29285510de509da8965e83d648a390; diagnose root cause + land architectural fix.",
        "id": "ci-run-36785618591-key-change-001",
        "paths": [".github/workflows/"],
    }],
    "schema_version": 2,
    "summary": "Failing CI workflow 'Database WAL Archive Freshness' on head "
               "7166e2f5ef29285510de509da8965e83d648a390; diagnose root cause + land architectural fix.",
    "title": "Fix failing CI workflow 'Database WAL Archive Freshness' (run #36785618591)",
    "validation_commands": [
        {"cmd": "nx affected --target=lint", "expected_exit": 0, "timeout_ms": 600000},
        {"cmd": "nx affected --target=test", "expected_exit": 0, "timeout_ms": 1800000},
    ],
}
# The candidate the scanner handed the converter that night: the fields the
# plan above was built from (the scanner then read no workflow file).
EPISODE_16_CANDIDATE: dict[str, Any] = {
    "source_type": "failing_ci",
    "candidate_id": "ci-run-36785618591",
    "workflow_name": "Database WAL Archive Freshness",
    "head_sha": "7166e2f5ef29285510de509da8965e83d648a390",
    "conclusion": "failure",
    "title_hint": "Fix failing CI workflow 'Database WAL Archive Freshness' (run #36785618591)",
}
# What GitHub answers for that run (read-only `gh run view` / `gh workflow
# list`, 2026-10-02): workflow 314901929 at the path above, job `verify`
# failed at the step named here.
EPISODE_16_RUN_ROW: dict[str, Any] = {
    "databaseId": 36785618591, "workflowDatabaseId": 314901929,
    "workflowName": "Database WAL Archive Freshness",
    "headSha": "7166e2f5ef29285510de509da8965e83d648a390",
    "conclusion": "failure", "createdAt": "2026-09-30T22:26:53Z", "event": "schedule",
}
EPISODE_16_WORKFLOWS: list[dict[str, Any]] = [
    {"id": 314901929, "name": "Database WAL Archive Freshness", "path": _WAL_WORKFLOW_PATH},
]
EPISODE_16_JOBS: dict[str, Any] = {"jobs": [{
    "name": "verify", "conclusion": "failure",
    "steps": [
        {"name": "Set up job", "conclusion": "success", "number": 1},
        {"name": "Checkout preflight helper", "conclusion": "success", "number": 2},
        {"name": "Observe production WAL archive runtime", "conclusion": "failure", "number": 5},
        {"name": "Enforce the five-minute RPO", "conclusion": "skipped", "number": 7},
    ],
}]}


def _fake_gh(*, runs: list[dict[str, Any]], workflows: list[dict[str, Any]],
             jobs: dict[str, Any]) -> tuple[Callable[..., Any], list[list[str]]]:
    """A `gh` that answers run list / workflow list / run view; every other argv runs for real."""
    calls: list[list[str]] = []

    def run(argv: Any, *args: Any, **kwargs: Any) -> Any:
        if not (isinstance(argv, list) and argv and str(argv[0]).endswith("gh")):
            return _REAL_RUN(argv, *args, **kwargs)
        calls.append(list(argv))
        answers = {("run", "list"): runs, ("workflow", "list"): workflows, ("run", "view"): jobs}
        payload = answers.get((argv[1], argv[2]))
        return subprocess.CompletedProcess(argv, 0 if payload is not None else 1,
                                           stdout=json.dumps(payload), stderr="")
    return run, calls


def _scan(workspace: Path, **answers: Any) -> tuple[list[dict[str, Any]], list[list[str]]]:
    fake, calls = _fake_gh(**answers)
    with tempfile.TemporaryDirectory() as cache, \
            mock.patch.object(ps.subprocess, "run", side_effect=fake), \
            mock.patch("shutil.which", return_value="/usr/bin/gh"), \
            mock.patch.dict(os.environ, {"ARIA_DRY_RUN": ""}):
        return ps.scan_failing_ci(workspace, cache_dir=cache), calls


def challenger_verdict(plan_content: dict[str, Any], repo: Path) -> dict[str, Any]:
    """The submit path's verdict on a challenger citing exactly the plan's refs."""
    refs = list(plan_content["evidence_refs"])
    request = {
        "role": "challenger_plan",
        "target_sha": git(repo, "rev-parse", "HEAD").strip(),
        "allowed_scope": affected_surface_paths(plan_content["affected_surfaces"]),
        "evidence_refs": refs,
        "allow_empty_satisfaction_matrix": True,
    }
    return validate_agent_response_evidence(
        response={"evidence_refs": refs, "satisfaction_matrix": []}, workspace_root=repo, request=request,
    )


class _Checkout(unittest.TestCase):
    """A checkout on main with a tools store, F-findings, a workflow and the orphan register."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory(prefix="aria-plan-evidence-")
        self.addCleanup(tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k != "ARIA_REPO_STATE_ROOT"}
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fx = OperatorRequestFixture(Path(tmp.name))
        self.fx.commit_files({
            _WAL_WORKFLOW_PATH: _WAL_WORKFLOW,
            "docs/reviews/orphan-findings.md": "# Orphans\n\n## ORPHAN-HIGH-104\n\nStatus: OPEN\n",
        }, message="chore(test): workflow and orphan register")
        self.repo = self.fx.repo
        self.tools = self.fx.tools

    def synthesize(self, candidates: list[dict[str, Any]], cycle_id: str = "cyc-test") -> Any:
        """The production provider over exactly ``candidates``; the git-diff fallback finds nothing."""
        with mock.patch("aria_kernel.plan_synthesizer.rank_candidate_sources", return_value=candidates), \
                mock.patch("aria_kernel.plan_synthesizer.synthesize_plan_content_from_cycle", return_value=None):
            return V9PressureSourceProvider().synthesize(
                cycle_id=cycle_id, workspace_root=self.repo, base_dir=self.tools, profile="standard",
            )

    def governance(self, kind: str) -> list[dict[str, Any]]:
        path = self.tools / "governance.jsonl"
        rows = load_declared_jsonl(path, expected_surface="tools_governance") if path.exists() else []
        return [row["details"] for row in rows if row["kind"] == kind]

    def assert_challenger_can_ground(self, content: dict[str, Any]) -> None:
        verdict = challenger_verdict(content, self.repo)
        self.assertTrue(content["evidence_refs"], "a plan cites at least one ref")
        self.assertEqual(verdict["errors"], [], content["evidence_refs"])


class FailingCiPlansAreGroundedInTheirWorkflowTests(_Checkout):
    def test_the_scanner_resolves_a_red_run_to_its_workflow_file_and_failing_step(self) -> None:
        candidates, calls = _scan(self.repo, runs=[EPISODE_16_RUN_ROW], workflows=EPISODE_16_WORKFLOWS,
                                  jobs=EPISODE_16_JOBS)
        self.assertEqual(len(candidates), 1)
        candidate = candidates[0]
        self.assertEqual(candidate["candidate_id"], "ci-run-36785618591")
        self.assertEqual(candidate["workflow_path"], _WAL_WORKFLOW_PATH)
        self.assertEqual(candidate["failing_jobs"],
                         [{"name": "verify", "failed_steps": ["Observe production WAL archive runtime"]}])
        self.assertEqual([argv[1:3] for argv in calls], [["run", "list"], ["workflow", "list"], ["run", "view"]])

    def test_the_plan_cites_the_failing_step_and_job_lines_and_the_challenger_can_ground_it(self) -> None:
        candidates, _ = _scan(self.repo, runs=[EPISODE_16_RUN_ROW], workflows=EPISODE_16_WORKFLOWS,
                              jobs=EPISODE_16_JOBS)
        envelope = self.synthesize(candidates)
        self.assertIsNotNone(envelope)
        content = envelope.content
        self.assertEqual(content["evidence_refs"], [
            f"{_WAL_WORKFLOW_PATH}:{_WAL_STEP_LINE}", f"{_WAL_WORKFLOW_PATH}:{_WAL_JOB_LINE}", _WAL_WORKFLOW_PATH,
        ])
        self.assertEqual(content["affected_surfaces"], [_WAL_WORKFLOW_PATH])
        self.assert_challenger_can_ground(content)
        # The run is where the plan came from, not what it cites.
        self.assertFalse(any("gh-run-list" in ref for ref in content["evidence_refs"]))
        self.assertEqual(content["provenance_refs"], ["gh-run-list:ci-run-36785618591"])
        self.assertEqual(envelope.metadata["_candidate_id"], "ci-run-36785618591")


class NoAdmissibleRefMeansNoPlanTests(_Checkout):
    def test_an_orphan_whose_refs_resolve_nowhere_is_skipped_once_by_name(self) -> None:
        candidate = {
            "source_type": "orphan_finding", "candidate_id": "ORPHAN-HIGH-901", "severity": "HIGH",
            "raw_id": "901", "title_hint": "Address ORPHAN-HIGH-901",
            "evidence": ["apps/never-written.ts:3", "scripts/ci/x.mjs:162-166 (prose, not a ref)"],
        }
        self.assertIsNone(self.synthesize([candidate]))
        skipped = self.governance("plan_candidate_conversion_skipped")
        self.assertEqual([(s["candidate_id"], s["reason"]) for s in skipped],
                         [("ORPHAN-HIGH-901", "plan_evidence_inadmissible")])
        refused = {entry["ref"] for entry in skipped[0]["refused_evidence_refs"]}
        self.assertIn("apps/never-written.ts:3", refused)
        self.assertEqual(self.governance("plan_candidate_source_selected"), [])

    def test_a_ref_past_the_end_of_its_file_is_dropped_and_named(self) -> None:
        candidate = {
            "source_type": "orphan_finding", "candidate_id": "ORPHAN-HIGH-104", "severity": "HIGH",
            "raw_id": "104", "title_hint": "Address ORPHAN-HIGH-104", "heading_line": 3,
            "evidence": [f"{GROUNDED_FILE}:9999", f"{GROUNDED_FILE}:12"],
        }
        envelope = self.synthesize([candidate])
        self.assertEqual(envelope.content["evidence_refs"],
                         [f"{GROUNDED_FILE}:12", "docs/reviews/orphan-findings.md:3"])
        self.assertEqual(envelope.content["affected_surfaces"], [GROUNDED_FILE])
        self.assert_challenger_can_ground(envelope.content)
        selected = self.governance("plan_candidate_source_selected")[-1]
        self.assertEqual([entry["ref"] for entry in selected["refused_evidence_refs"]], [f"{GROUNDED_FILE}:9999"])


class OperatorRequestPlansCiteOnlyAdmissibleRefsTests(_Checkout):
    def test_the_feedback_row_is_provenance_and_the_signed_grounding_is_the_evidence(self) -> None:
        self.fx.seed_finding("F-007", refs=[f"{GROUNDED_FILE}:12"])
        self.fx.record(finding_id="F-007", request_id="OP-ground")
        with mock.patch("aria_kernel.plan_synthesizer.scan_failing_ci", return_value=[]), \
                mock.patch("aria_kernel.plan_synthesizer.scan_orphan_findings", return_value=[]), \
                mock.patch("aria_kernel.plan_synthesizer.scan_f_findings", return_value=[]), \
                mock.patch("aria_kernel.plan_synthesizer.synthesize_plan_content_from_cycle", return_value=None):
            envelope = V9PressureSourceProvider().synthesize(
                cycle_id="cyc-op", workspace_root=self.repo, base_dir=self.tools, profile="standard",
            )
        self.assertEqual(envelope.metadata["_pressure_source_type"], "operator_feedback")
        content = envelope.content
        self.assertEqual(content["evidence_refs"], [f"{GROUNDED_FILE}:12"])
        self.assert_challenger_can_ground(content)
        self.assertEqual(content["provenance_refs"], ["aria-tools/operator-feedback.jsonl:OP-ground"])
        # The merge owner joins the plan to the request it consumed through
        # the provenance channel.
        self.assertEqual(_consumed_refs(content), {"OP-ground"})


class EveryPlanStartedRefValidatesTests(_Checkout):
    """The invariant over every producer: what plan_started records, the challenger can cite."""

    def _commit_diff(self) -> None:
        self.fx.commit_files({"apps/hr-service/src/leave/leave.policy.ts": "export const policy = 1;\n"},
                             message="feat(test): a change for the git-diff source")

    def test_every_producer_starts_plans_the_challenger_can_ground(self) -> None:
        self.fx.seed_finding("F-008", refs=[f"{GROUNDED_FILE}:40"])
        self.fx.seed_finding("F-009", refs=[f"{GROUNDED_FILE}:41"])
        self.fx.record(finding_id="F-009", request_id="OP-invariant")
        operator = next(c for c in ps.scan_operator_feedback(self.repo, base_dir=self.tools, cycle_id="cyc-inv")
                        if c["candidate_id"] == "OP-invariant")
        candidates = {
            "operator_feedback": operator,
            "failing_ci": {
                "source_type": "failing_ci", "candidate_id": "ci-run-7", "workflow_name": "Database WAL Archive Freshness",
                "head_sha": "a" * 40, "title_hint": "Fix failing CI workflow (run #7)",
                "workflow_path": _WAL_WORKFLOW_PATH,
                "failing_jobs": [{"name": "verify", "failed_steps": ["Observe production WAL archive runtime"]}],
            },
            "orphan_finding": {
                "source_type": "orphan_finding", "candidate_id": "ORPHAN-HIGH-104", "severity": "HIGH",
                "raw_id": "104", "title_hint": "Address ORPHAN-HIGH-104", "heading_line": 3,
            },
            "f_finding": {"source_type": "f_finding", "candidate_id": "F-008", "title_hint": "Process F-008"},
        }
        contents: dict[str, dict[str, Any]] = {}
        for source, candidate in candidates.items():
            envelope = self.synthesize([candidate], cycle_id=f"cyc-{source}")
            self.assertIsNotNone(envelope, source)
            contents[source] = envelope.content
        self._commit_diff()
        git_diff = ps.synthesize_plan_content_from_cycle(
            cycle_id="cyc-git-diff", workspace_root=self.repo, base_dir=self.tools,
        )
        self.assertIsNotNone(git_diff)
        contents["git_diff"] = git_diff
        for source, content in contents.items():
            start_plan(plan_id=f"plan-{source.replace('_', '-')}", plan_content=content,
                       initial_revision_id=f"plan-{source.replace('_', '-')}-r1", base_dir=self.tools)
        started = [row for row in load_declared_jsonl(self.tools / "plans" / "events.jsonl",
                                                      expected_surface="plan_convergence_events")
                   if row["event_type"] == "plan_started"]
        self.assertEqual(len(started), len(contents))
        for row in started:
            with self.subTest(plan=row["plan_id"]):
                self.assert_challenger_can_ground(row["payload"]["plan_content"])


class Episode16ReplayTests(_Checkout):
    def test_the_recorded_plan_cites_a_ref_the_challenger_rule_rejects(self) -> None:
        codes = {error["code"] for error in challenger_verdict(EPISODE_16_PLAN_CONTENT, self.repo)["errors"]}
        self.assertIn("agent_evidence_ref_malformed", codes)

    def test_the_recorded_candidate_mints_no_plan_and_one_named_skip(self) -> None:
        self.assertIsNone(self.synthesize([dict(EPISODE_16_CANDIDATE)], cycle_id="cyc-20260930T214247Z-auto"))
        skipped = self.governance("plan_candidate_conversion_skipped")
        self.assertEqual([(s["candidate_id"], s["source_type"], s["reason"]) for s in skipped],
                         [("ci-run-36785618591", "failing_ci", "plan_evidence_inadmissible")])

    def test_the_recorded_run_through_the_scanner_mints_a_plan_the_challenger_can_ground(self) -> None:
        candidates, _ = _scan(self.repo, runs=[EPISODE_16_RUN_ROW], workflows=EPISODE_16_WORKFLOWS,
                              jobs=EPISODE_16_JOBS)
        envelope = self.synthesize(candidates, cycle_id="cyc-20260930T214247Z-auto")
        self.assertIsNotNone(envelope)
        self.assertNotEqual(envelope.content["evidence_refs"], EPISODE_16_PLAN_CONTENT["evidence_refs"])
        self.assert_challenger_can_ground(envelope.content)


if __name__ == "__main__":
    unittest.main()
