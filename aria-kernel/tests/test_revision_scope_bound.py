"""ADR-0021 (ARIA-MEDIUM-261) — a plan revision cannot write outside its admitted surfaces and closure.

Pre-fix a finding- or operator-sourced plan was held to its ``finding_id``
only: a challenger draft or revision could widen ``affected_surfaces`` to any
path, and the implementation's ``allowed_scope`` was whatever the CONVERGED
body declared. ``start_plan`` now records the admission bound on
``plan_started`` (the admitted surfaces plus the roots of their
``impact_graph.plan_downstream_impact`` project closure, computed by the
kernel), every submitted body is refused a path outside it
(``revision_scope_exceeds_admission_closure``, paths named, one governance
row), and ``implementation_allowed_scope`` cannot return a scope beyond it.

The fixture workspace is a four-project graph: ``farm-service`` imports
``shared-lib``, ``gateway`` imports ``farm-service``, ``auth-service`` imports
nothing, so each admitted surface has a closure the test can name.
"""
from __future__ import annotations

import inspect
import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel.bridge_exceptions import BridgeContractViolation
from aria_kernel.cross_review_bridge import issue_implementation_envelope
from aria_kernel.finding_grounding import FindingAdmission
from aria_kernel.finding_seed import FindingSeed
from aria_kernel.impact_graph import plan_downstream_impact
from aria_kernel.implementation_safety import implementation_allowed_scope
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.plan_convergence import (
    _append_event,
    content_hash,
    evaluate_plan,
    fold_plan_state,
    plan_status,
    record_critique,
    record_revision,
    request_critics,
    start_plan,
    submit_challenger_plan,
)
from aria_kernel.plan_origin import (
    ADMISSION_SCOPE_MISSING,
    REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE,
    AdmissionScopeExceeded,
    compute_admission_scope,
    paths_outside_admission_scope,
)
from aria_kernel.plan_synthesizer import PlanEvidenceGround, convert_candidate_to_plan_content
from aria_kernel.tool_registry import GovernanceError
from tests._helpers.git_fixtures import make_local_git_repo
from tests._helpers.operator_acts import operator_set_profile
from tests.test_implementation_lifecycle_continuity import (
    converging_plan_content,
    drive_plan_to_converged,
    seed_reviewer_agent,
)

SHARED = "libs/shared-lib/src/index.ts"
FARM = "apps/farm-service/src/main.ts"
GATEWAY = "apps/gateway/src/main.ts"
AUTH = "apps/auth-service/src/main.ts"


_WORKSPACE_SOURCES = {
    SHARED: "export const shared = 1;\n",
    FARM: "import { shared } from '@aqua/shared-lib';\nexport const farm = shared;\n",
    GATEWAY: "import { farm } from '@aqua/farm-service';\nexport const gateway = farm;\n",
    AUTH: "export const auth = 1;\n",
}


def _write_workspace(root: Path) -> None:
    """The four-project sources and the reviewer agent, written but not committed."""
    for relpath, text in _WORKSPACE_SOURCES.items():
        (root / relpath).parent.mkdir(parents=True, exist_ok=True)
        (root / relpath).write_text(text, encoding="utf-8")
    seed_reviewer_agent(root)


def _seed_workspace(root: Path) -> None:
    # ORPHAN-HIGH-519 — the converter cites a ref only when the challenger's
    # evidence rule admits it at the checkout's HEAD, so the sources are committed.
    make_local_git_repo(root.parent, name=root.name)
    _write_workspace(root)
    for argv in (["add", "--", *_WORKSPACE_SOURCES], ["commit", "-q", "-m", "chore(test): the project graph"]):
        subprocess.run(["git", *argv], cwd=root, check=True, capture_output=True)


def _seed(root: Path, source_type: str, finding_id: str, surfaces: list[str]) -> dict:
    """The plan body the kernel converter writes for an admitted finding, grounded at ``root``'s HEAD."""
    admission = FindingAdmission(finding_id, None, evidence_refs=tuple(surfaces), affected_surfaces=tuple(surfaces))
    if source_type == "operator_feedback":
        candidate = {"source_type": source_type, "candidate_id": "OP-1", "finding_id": finding_id,
                     "request": "Remediate at the root.", "priority": "P0"}
    else:
        candidate = {"source_type": source_type, "candidate_id": finding_id}
    # ARIA-HIGH-369 — an F plan is built from the finding's seed (its refs at the anchor).
    seed = FindingSeed(finding_id, None, evidence_refs=tuple(surfaces), affected_surfaces=tuple(surfaces))
    conversion = convert_candidate_to_plan_content(
        candidate, admission=admission, ground=PlanEvidenceGround.of(root),
        seed=seed if source_type == "f_finding" else None)
    assert conversion.envelope is not None, conversion
    return conversion.envelope.content


def _body(seed: dict, surfaces: list[str], **extra: object) -> dict:
    return dict(seed, affected_surfaces=surfaces, architectural_tier=2, summary="revised",
                key_changes=[{"id": "kc-1", "description": "fix the drift", "paths": surfaces}], **extra)


class _ScopeBoundFixture(unittest.TestCase):
    """The four-project workspace and the plan moves the bound is tested through."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-scope-bound-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        _seed_workspace(self.root)
        self.tools = Path(self.tmp.name) / "aria-tools"
        self.counter = 0

    def _start(self, body: dict) -> str:
        self.counter += 1
        plan_id = f"plan-{self.counter}"
        start_plan(plan_id=plan_id, plan_content=body, initial_revision_id=f"{plan_id}-r0",
                   base_dir=self.tools, workspace_root=self.root)
        return plan_id

    def _critiqued(self, plan_id: str) -> None:
        latest = plan_status(plan_id=plan_id, base_dir=self.tools)["latest_revision"]
        deadline = (datetime.now(timezone.utc) + timedelta(minutes=60)).isoformat()
        task = {"task_id": f"{plan_id}-t1", "task_packet_hash": content_hash({"task": plan_id}),
                "target_agent": "farm-expert", "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"], "sla_deadline": deadline}
        request_critics(plan_id=plan_id, request={
            "round_number": 1, "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "tasks": [task],
        }, base_dir=self.tools)
        record_critique(plan_id=plan_id, critique={
            "task_packet_hash": task["task_packet_hash"], "target_revision_id": latest["revision_id"],
            "target_plan_content_hash": latest["content_hash"], "reviewer": "farm-expert", "risks": [],
            "critique_content_hash": content_hash({"reviewer": "farm-expert", "risks": []}),
        }, workspace_root=self.root, base_dir=self.tools)

    def _revise(self, plan_id: str, body: dict, revision_id: str = "r1") -> dict:
        state = plan_status(plan_id=plan_id, base_dir=self.tools)
        return record_revision(plan_id=plan_id, revision={
            "revision_id": f"{plan_id}-{revision_id}", "round": state["current_round"],
            "content_hash": content_hash(body), "parent_revision_hash": state["latest_revision"]["content_hash"],
            "content": json.dumps(body, sort_keys=True), "addresses_review_risk_ids": [],
        }, base_dir=self.tools)

    def _challenge(self, plan_id: str, body: dict) -> dict:
        latest = plan_status(plan_id=plan_id, base_dir=self.tools)["latest_revision"]
        return submit_challenger_plan(plan_id=plan_id, challenger={
            "challenger_agent": "aria-challenger-planner", "challenger_revision_id": f"{plan_id}-c1",
            "source_revision_id": latest["revision_id"], "source_plan_content_hash": latest["content_hash"],
            "plan_content": body,
        }, base_dir=self.tools)

    def _refusals(self) -> list[dict]:
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        return [row["details"] for row in rows if row["kind"] == REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE]

    def _scope(self, plan_id: str) -> dict:
        return fold_plan_state(plan_id=plan_id, base_dir=self.tools)["plan_started"]["admission_scope"]


class RevisionScopeBoundTests(_ScopeBoundFixture):
    def test_a_revision_adding_a_surface_inside_the_closure_passes(self) -> None:
        plan_id = self._start(_seed(self.root, "f_finding", "F-007", [SHARED]))
        self._critiqued(plan_id)
        # gateway is downstream of shared-lib only through farm-service.
        widened = [SHARED, "libs/shared-lib/src/index.spec.ts", FARM, GATEWAY]
        self.assertEqual(paths_outside_admission_scope(self._scope(plan_id), widened), [])
        self.assertTrue(self._revise(plan_id, _body(_seed(self.root, "f_finding", "F-007", [SHARED]), widened))["event_appended"])
        self.assertEqual(self._refusals(), [])

    def test_a_revision_adding_a_surface_outside_is_refused_with_the_paths_named(self) -> None:
        seed = _seed(self.root, "f_finding", "F-007", [FARM])
        plan_id = self._start(seed)
        self._critiqued(plan_id)
        # `apps/farm-service-extra` shares a prefix with a closure root, not the root itself.
        escapes = [FARM, AUTH, SHARED, "docs/elsewhere.md", "apps/farm-service-extra/x.ts"]
        with self.assertRaisesRegex(GovernanceError, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE) as raised:
            self._revise(plan_id, _body(seed, escapes))
        offending = [AUTH, SHARED, "docs/elsewhere.md", "apps/farm-service-extra/x.ts"]
        for path in offending:
            self.assertIn(path, str(raised.exception))
        self.assertEqual(self._refusals(), [{"plan_id": plan_id, "stage": "plan_submission",
                                             "offending_paths": offending}])
        # A path only a key change names is a path the body names.
        hidden = dict(_body(seed, [FARM]), key_changes=[{"id": "kc-1", "description": "d", "paths": [AUTH]}])
        with self.assertRaisesRegex(GovernanceError, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE):
            self._revise(plan_id, hidden)
        self.assertEqual(plan_status(plan_id=plan_id, base_dir=self.tools)["state"], "CRITIQUED")

    def test_an_operator_request_plan_and_an_f_finding_plan_are_both_bounded(self) -> None:
        for source_type, finding_id in (("operator_feedback", "F-007"), ("f_finding", "F-008")):
            with self.subTest(source=source_type):
                seed = _seed(self.root, source_type, finding_id, [FARM])
                plan_id = self._start(seed)
                self.assertEqual(self._scope(plan_id)["origin_finding_id"], finding_id)
                with self.assertRaisesRegex(GovernanceError, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE):
                    self._challenge(plan_id, _body(seed, [FARM, AUTH]))
                self.assertTrue(self._challenge(plan_id, _body(seed, [FARM, GATEWAY]))["event_appended"])

    def test_the_closure_is_the_kernels_and_planner_claims_cannot_move_it(self) -> None:
        # No caller of start_plan can hand it a bound; it computes one.
        self.assertNotIn("admission_scope", inspect.signature(start_plan).parameters)
        seed = _seed(self.root, "f_finding", "F-007", [SHARED])
        plan_id = self._start(dict(seed, admission_scope={"closure_roots": ["apps"]}))
        scope = self._scope(plan_id)
        impact = plan_downstream_impact(changed_files=[SHARED], workspace_root=self.root, base_dir=self.tools)
        self.assertEqual(scope["admitted_surfaces"], [SHARED])
        self.assertEqual(scope["closure_projects"], sorted([*impact["changed_projects"], *impact["downstream_projects"]]))
        self.assertEqual(scope["closure_projects"], ["farm-service", "gateway", "shared-lib"])
        self.assertEqual(scope["closure_roots"], ["apps/farm-service", "apps/gateway", "libs/shared-lib"])
        self.assertEqual(scope["policy_pins"], [])
        self._critiqued(plan_id)
        claimed = {"closure_roots": ["apps", "libs"], "admitted_surfaces": [AUTH]}
        with self.assertRaisesRegex(GovernanceError, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE):
            self._revise(plan_id, _body(seed, [SHARED, AUTH], admission_scope=claimed))
        self.assertTrue(self._revise(plan_id, _body(seed, [SHARED, GATEWAY]))["event_appended"])
        self.assertEqual(self._scope(plan_id), scope)
        # Subject pins come from the committed policy alone (test_subject_pin_policy).

    def test_a_tampered_admitted_half_is_refused_on_the_record(self) -> None:
        seed = _seed(self.root, "f_finding", "F-007", [FARM])
        scope = compute_admission_scope(seed, workspace_root=self.root, base_dir=self.tools)
        with self.assertRaisesRegex(GovernanceError, "admitted_surfaces must be the started plan's surfaces"):
            _append_event(root=self.tools, plan_id="plan-tampered", event_type="plan_started",
                          idempotency_key=content_hash({"t": 1}), payload={
                              "plan_content": seed, "content_hash": content_hash(seed),
                              "initial_revision_id": "plan-tampered-r0",
                              "admission_scope": dict(scope, admitted_surfaces=[FARM, AUTH]),
                          })

    def test_a_finding_plan_without_its_admission_record_is_refused(self) -> None:
        seed = _seed(self.root, "f_finding", "F-007", [FARM])
        with self.assertRaisesRegex(GovernanceError, ADMISSION_SCOPE_MISSING):
            start_plan(plan_id="plan-nows", plan_content=seed, initial_revision_id="plan-nows-r0",
                       base_dir=self.tools)
        # A ledger written before the bound existed carries no record: its
        # bodies are refused rather than left unbounded.
        _append_event(root=self.tools, plan_id="plan-legacy", event_type="plan_started",
                      idempotency_key=content_hash({"legacy": 1}), payload={
                          "plan_content": seed, "content_hash": content_hash(seed),
                          "initial_revision_id": "plan-legacy-r0"})
        with self.assertRaisesRegex(GovernanceError, ADMISSION_SCOPE_MISSING):
            self._challenge("plan-legacy", _body(seed, [FARM]))


class ImplementationScopeNeverExceedsTheBoundTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-scope-impl-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "workspace"
        _seed_workspace(self.root)
        self.tools = Path(self.tmp.name) / "aria-tools"
        operator_set_profile("strict", base_dir=self.tools, scheduler_ceiling="strict")
        drive_plan_to_converged(
            plan_id="plan-impl", tools=self.tools, workspace_root=self.root,
            plan_content=converging_plan_content(
                "Bounded plan", finding_id="F-007",
                affected_surfaces=[{"paths": [FARM, "aria-kernel/aria_kernel/cli.py"]}],
                key_changes=[{"id": "kc-1", "description": "fix", "paths": [FARM]}],
            ),
        )
        self.scope = fold_plan_state(plan_id="plan-impl", base_dir=self.tools)["plan_started"]["admission_scope"]

    def _mint(self) -> dict:
        return issue_implementation_envelope(
            plan_id="plan-impl", cross_review_revision_id="cr-1", cross_review_summary_text="{}",
            proposal_id="proposal-261", change_id="chg-261", branch="aria-impl-0123456789abcdef",
            base_sha="0" * 40, base_dir=self.tools, cycle_id="cyc-261",
        )

    def test_the_scope_function_refuses_a_path_outside_the_bound(self) -> None:
        with self.assertRaises(AdmissionScopeExceeded) as raised:
            implementation_allowed_scope([FARM, GATEWAY, AUTH, "infra/x.yaml"], admission_scope=self.scope)
        self.assertEqual(raised.exception.offending, (AUTH, "infra/x.yaml"))
        writable, refused = implementation_allowed_scope([FARM, GATEWAY], admission_scope=self.scope)
        self.assertEqual((writable, refused), ([FARM, GATEWAY], []))
        # A plan with no finding origin has no admission bound to apply.
        self.assertEqual(implementation_allowed_scope([AUTH], admission_scope=None), ([AUTH], []))

    def test_the_minted_scope_lies_inside_the_bound(self) -> None:
        row = self._mint()
        self.assertEqual(row["allowed_scope"], [FARM])
        self.assertEqual(paths_outside_admission_scope(self.scope, row["allowed_scope"]), [])

    def test_a_converged_body_outside_the_bound_mints_nothing(self) -> None:
        narrower = dict(self.scope, closure_roots=[], admitted_surfaces=["aria-kernel/aria_kernel/cli.py"])
        with mock.patch("aria_kernel.cross_review_bridge.admission_scope_for_plan", return_value=narrower), \
                self.assertRaisesRegex(BridgeContractViolation, REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE):
            self._mint()
        rows = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        refusals = [row["details"] for row in rows if row["kind"] == REVISION_SCOPE_EXCEEDS_ADMISSION_CLOSURE]
        self.assertEqual(refusals, [{"plan_id": "plan-impl", "stage": "implementation_mint",
                                     "offending_paths": [FARM]}])
        self.assertEqual(fold_plan_state(plan_id="plan-impl", base_dir=self.tools)["state"], "CONVERGED")


if __name__ == "__main__":
    unittest.main()
