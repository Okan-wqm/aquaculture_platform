"""CL-1 (ORPHAN-725) — convergence is a resumable step, never a wait.

Production measured the old shape's failure exactly: the cycle lane
polled for states only the LATER executor run could produce — 13/13
challenger poll-timeouts, zero plans ever CONVERGED, and the round-1
re-entry wedged every adopted plan behind `convergence_invalid_plan`.
Deliberate-breakage pins:

* an adopted DRAFT plan is NEVER re-started (K1);
* no step branch ever sleeps (K2 — waiting is structurally impossible);
* the same live envelope is never double-minted (idempotency);
* a cross-cycle sequence of steps reaches CONVERGED with zero polling;
* an undeliverable envelope exhausts its X4-mirror re-mint budget into
  an HONEST terminal HUMAN_REQUIRED instead of orbiting forever.
"""
from __future__ import annotations

import json
import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from aria_kernel import convergence_drainer as cd
from aria_kernel.ledger import load_jsonl
from aria_kernel.plan_convergence import (
    content_hash,
    events_path,
    fold_plan_state,
    plan_status,
    record_cross_review,
    request_cross_review,
    start_plan,
    submit_challenger_plan,
)

_MS = [{"id": "MS-1", "kind": "obligation", "description": "do x", "source": "test"}]


class _StepCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "workspace"
        agents = self.root / ".claude" / "agents"
        agents.mkdir(parents=True)
        for name, owns in (("farm-expert", "apps/farm-service/**"), ("access-boundary-auditor", "web/**")):
            (agents / f"{name}.md").write_text(
                f"---\nname: {name}\ndescription: r\n---\n\nOwns `{owns}`.\n",
                encoding="utf-8",
            )
        self.tools = Path(self.tmp.name) / "aria-tools"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def plan() -> dict:
        return {
            "schema_version": 1,
            "title": "T",
            "summary": "S",
            "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/plan_convergence.py"]}],
            "key_changes": ["x"],
            "validation_commands": [
                {"cmd": "python3 -m unittest discover aria-kernel -p '*test*.py'"},
            ],
            "evidence_refs": ["docs/aria/SPEC.md"],
        }

    def step(self) -> dict:
        return cd.run_convergence_drainer(
            cycle_id="cyc-step",
            base_dir=self.tools,
            workspace_root=self.root,
            plan_id="plan-1",
            plan_seed=self.plan(),
            must_satisfy=list(_MS),
            evidence_refs=["docs/aria/SPEC.md"],
            allowed_scope=["aria-kernel/**"],
            max_rounds=4,
        )

    def requests(self) -> list[dict]:
        path = self.tools / "agent-invocations" / "requests.jsonl"
        if not path.exists():
            return []
        return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


class AdoptedDraftNeverRestarts(_StepCase):
    def test_draft_plan_steps_without_restart(self) -> None:
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        result = self.step()
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        started_events = [
            row for row in load_jsonl(events_path(self.tools))
            if row.get("event_type") == "plan_started"
        ]
        self.assertEqual(len(started_events), 1, "adopted DRAFT was re-started")
        challengers = [r for r in self.requests() if r.get("role") == "challenger_plan"]
        self.assertEqual(len(challengers), 1)

    def test_second_step_does_not_double_mint_a_live_envelope(self) -> None:
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        self.step()
        before = len(self.requests())
        result = self.step()
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        self.assertEqual(len(self.requests()), before, "live envelope re-minted")


class PlannerTwinContextTests(_StepCase):
    def _prepare_named_planner_source(self) -> dict:
        from aria_kernel.cycle import _phase_discovery, _phase_twin_refresh, build_phase_context
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git
        kernel = Path(__file__).resolve().parents[1]
        modules = ("runtime_artifacts", "knowledge_graph", "cycle_phases/memory", "cli", "autonomy_orchestrator",
                   "reflection_inputs", "reflection", "report", "snapshot", "discovery", "twin", "convergence_drainer",
                   "convergent_planning_bridge", "cross_review_bridge", "plan_convergence", "runtime_profile",
                   "agent_surface", "agent_network", "capability_gap", "state_manifest", "tool_registry", "agent_invocations")
        tests = ("test_runtime_artifacts", "test_autonomy_orchestrator", "test_learned_context_and_intent",
                 "test_twin_map", "test_phase2_fates_snapshot", "test_prompt_render_versioning", "test_convergence_resumable_step")
        for relative in [f"aria_kernel/{name}.py" for name in modules] + [f"tests/{name}.py" for name in tests] + ["pyproject.toml"]:
            destination = self.root / "aria-kernel" / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes((kernel / relative).read_bytes())
        docs = self.root / "docs/aria/SPEC.md"
        docs.parent.mkdir(parents=True)
        docs.write_text("Ordinary planner fixture evidence.\n", encoding="utf-8")
        _git(["init", "-q"], cwd=self.root)
        _git(["config", "user.email", "planner-fixture@aria.test"], cwd=self.root)
        _git(["config", "user.name", "Planner Fixture"], cwd=self.root)
        _git(["add", "-A"], cwd=self.root)
        _git(["commit", "-q", "-m", "fixture: selected current planner inputs"], cwd=self.root)
        self.tools = ensure_tools_binding(Path(self.tmp.name) / "store/tools", workspace_root=self.root)
        context = build_phase_context(cycle_id="cyc-step", workspace_root=self.root, base_dir=self.tools,
                                      snapshot_mode="committed")
        context.results["discovery"] = _phase_discovery(context)
        mapped = _phase_twin_refresh(context)
        self.assertTrue(context.results["discovery"]["completion_proof"]["complete"])
        self.assertEqual(mapped["self_features"]["features"]["knowledge_graph.conventions_for_paths"]["implemented"]["status"], "available")
        body = self.plan()
        body["summary"] = "PRIMARY_PROPOSAL_ONLY: reuse the existing convention owner."
        body["evidence_refs"] = ["aria-kernel/aria_kernel/knowledge_graph.py:1", "aria-kernel/aria_kernel/runtime_artifacts.py:1"]
        body["affected_surfaces"] = [{"paths": ["aria-kernel/aria_kernel/knowledge_graph.py", "web/non-authorizing-hint.ts"]}]
        return body

    def _assert_native_current_body(self, role: str, body: dict, *, cycle_id="cyc-step", scope=None,
                                    expected_feature="knowledge_graph.conventions_for_paths") -> dict:
        rows = [row for row in self.requests() if row["role"] == role]
        self.assertEqual(len(rows), 1)
        request = rows[0]
        self._assert_native_body_request(request, body, cycle_id=cycle_id, scope=scope, expected_feature=expected_feature)
        return request

    def _assert_native_body_request(self, request: dict, body: dict, *, cycle_id="cyc-step", scope=None,
                                     expected_feature="knowledge_graph.conventions_for_paths") -> None:
        from aria_kernel import agent_invocations as ai
        self.assertEqual(request["evidence_refs"], body["evidence_refs"])
        self.assertEqual(request["plan_revision_hash"], content_hash(body))
        self.assertEqual(request["allowed_scope"], scope or ["aria-kernel/**"])
        self.assertEqual(request["cycle_id"], cycle_id)
        native = ai.verify_invocation_context_binding(request_id=request["request_id"], context_hash=request["context_hash"],
                                                     prompt_hash=request["prompt_hash"], base_dir=self.tools)
        self.assertEqual(native["context"]["repo_root"], str(self.root.resolve()))
        self.assertEqual(native["context"]["budget_audit_hash"], request["budget_audit_hash"])
        self.assertEqual(native["context"]["ledger_hash"], request["context_ledger_hash"])
        self.assertEqual(native["prompt"]["ledger_hash"], request["prompt_ledger_hash"])
        prompt = ai.render_invocation_prompt(request)
        self.assertEqual(native["prompt"]["prompt_text"], prompt)
        self.assertEqual("sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest(), request["prompt_hash"])
        self.assertEqual(ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)), prompt)
        self.assertEqual(request["repository_map"]["self_features"]["qualification"]["status"], "available")
        self.assertIn(expected_feature, request["repository_map"]["self_features"]["features"])
        self.assertIn(expected_feature, prompt)
        if request["role"] == "challenger_plan":
            self.assertNotIn("PRIMARY_PROPOSAL_ONLY", request["suggested_prompt"])

    def test_adopted_draft_uses_recorded_body_refs_hash_and_features(self) -> None:
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        result = self.step()  # The ordinary resumed caller still supplies the old seed/refs.
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        self._assert_native_current_body("challenger_plan", body)
        before = {name: (self.tools / f"agent-invocations/{name}.jsonl").read_bytes()
                  for name in ("requests", "contexts", "prompts")}
        self.step()
        for name, data in before.items():
            self.assertEqual((self.tools / f"agent-invocations/{name}.jsonl").read_bytes(), data)

    def test_initial_step_uses_the_body_actually_recorded_before_mint(self) -> None:
        body = self._prepare_named_planner_source()
        result = cd.run_convergence_drainer(cycle_id="cyc-step", base_dir=self.tools, workspace_root=self.root,
                                           plan_id="plan-1", plan_seed=body, must_satisfy=list(_MS),
                                           evidence_refs=["docs/aria/SPEC.md"], allowed_scope=["aria-kernel/**"])
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        self.assertEqual(state["plan_started"]["plan_content"], body)
        self._assert_native_current_body("challenger_plan", body)

    def test_round_controller_delivers_recorded_body_and_explicit_source_root(self) -> None:
        from aria_kernel.plan_round_controller import advance_plan_rounds
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        result = advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.root)
        self.assertEqual(result["status"], "challenger_request_opened")
        self._assert_native_current_body("challenger_plan", body, cycle_id=None,
                                         scope=["aria-kernel/**", "aria-tools/**", ".claude/**"])

    def test_real_cli_advance_rounds_delivers_explicit_source_root(self) -> None:
        import io
        from contextlib import redirect_stdout, redirect_stderr
        from aria_kernel.cli import main as cli_main
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        with redirect_stdout(io.StringIO()) as stdout, redirect_stderr(io.StringIO()) as stderr:
            try:
                code = cli_main(["plan", "advance-rounds", "--plan-id", "plan-1", "--tools-dir", str(self.tools),
                                 "--workspace-root", str(self.root), "--workspace-base", str(Path(self.tmp.name) / "workspaces")])
            except SystemExit as exc:
                code = exc.code
        self.assertEqual(code, 0, stderr.getvalue())
        self.assertEqual(json.loads(stdout.getvalue())["status"], "challenger_request_opened")
        self._assert_native_current_body("challenger_plan", body, cycle_id=None,
                                         scope=["aria-kernel/**", "aria-tools/**", ".claude/**"])

    def test_controller_without_source_root_keeps_legacy_optional_context(self) -> None:
        from aria_kernel.plan_round_controller import advance_plan_rounds
        from aria_kernel import agent_invocations as ai
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self.assertEqual(advance_plan_rounds(plan_id="plan-1", base_dir=self.tools)["status"], "challenger_request_opened")
        request = next(row for row in self.requests() if row["role"] == "challenger_plan")
        self.assertEqual(request["evidence_refs"], body["evidence_refs"])
        self.assertEqual(request["allowed_scope"], ["aria-kernel/**", "aria-tools/**", ".claude/**"])
        self.assertIsNone(request["target_sha"])
        self.assertNotIn("self_features", request["repository_map"])
        native = ai.verify_invocation_context_binding(request_id=request["request_id"], context_hash=request["context_hash"],
                                                     prompt_hash=request["prompt_hash"], base_dir=self.tools)
        self.assertIsNone(native["context"]["repo_root"])
        self.assertEqual(native["prompt"]["prompt_text"], ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)))

    def test_affected_paths_reach_mint_without_becoming_evidence_or_write_scope(self) -> None:
        from aria_kernel import agent_invocations as ai
        body = self._prepare_named_planner_source()
        # The actual discovery cycle is historical context, not a source-file
        # citation. Its separately named affected owner supplies retrieval.
        body["evidence_refs"] = ["cycle:cyc-step"]
        body["affected_surfaces"] = [{"paths": ["aria-kernel/aria_kernel/knowledge_graph.py"]}]
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        result = self.step()
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        request = next(row for row in self.requests() if row["role"] == "challenger_plan")
        self.assertEqual(request["evidence_refs"], ["cycle:cyc-step"])
        self.assertEqual(request["allowed_scope"], ["aria-kernel/**"])
        self.assertEqual(request["plan_revision_hash"], content_hash(body))
        self.assertIn("aria-kernel/aria_kernel/knowledge_graph.py",
                      {entry["file"] for entry in request["repository_map"]["files"]},
                      "Actual affected paths must reach the mint's source-context consumer")
        self.assertEqual(request["context_source_paths"], ["aria-kernel/aria_kernel/knowledge_graph.py"])
        native = ai.verify_invocation_context_binding(request_id=request["request_id"], context_hash=request["context_hash"],
                                                     prompt_hash=request["prompt_hash"], base_dir=self.tools)
        self.assertEqual(native["context"]["included_refs"], [{"ref": "cycle:cyc-step", "source": "evidence_refs"}])
        self.assertIn("knowledge_graph.conventions_for_paths", native["prompt"]["prompt_text"])
        self.assertEqual(ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)), native["prompt"]["prompt_text"])

    def test_ordinary_broad_or_long_affected_hints_are_disclosed_without_expansion(self) -> None:
        from aria_kernel import agent_invocations as ai
        body = self._prepare_named_planner_source()
        literal = "aria-kernel/aria_kernel/knowledge_graph.py"
        long_path = "aria-kernel/" + "ordinary-long-filename-" * 30 + ".py"
        body["evidence_refs"] = ["cycle:cyc-step"]
        body["affected_surfaces"] = [{"paths": [literal, "aria-kernel/**", long_path]}]
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["plan_started"]["plan_content"], body)
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        request = next(row for row in self.requests() if row["role"] == "challenger_plan")
        self.assertEqual(request["evidence_refs"], ["cycle:cyc-step"])
        self.assertEqual(request["allowed_scope"], ["aria-kernel/**"])
        self.assertEqual(request["context_source_paths"], [literal])
        self.assertEqual(request["context_source_paths_status"], {
            "status": "partial", "reason": "unsupported_literal_hints", "supplied_count": 3,
            "accepted_count": 1, "omitted_count": 2,
        })
        prompt = ai.render_invocation_prompt(request)
        self.assertNotIn(long_path, prompt)
        self.assertIn("unsupported_literal_hints", prompt)
        self.assertIn("knowledge_graph.conventions_for_paths", prompt)
        self.assertEqual(ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)), prompt)
        native = ai.verify_invocation_context_binding(request_id=request["request_id"], context_hash=request["context_hash"],
                                                     prompt_hash=request["prompt_hash"], base_dir=self.tools)
        self.assertEqual(native["prompt"]["prompt_text"], prompt)
        self.assertEqual(request["prompt_hash"], "sha256:" + hashlib.sha256(prompt.encode("utf-8")).hexdigest())
        self.assertEqual(native["context"]["budget_audit_hash"], request["budget_audit_hash"])

    def _submit_native_challenger(self, body: dict) -> None:
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        submit_challenger_plan(plan_id="plan-1", challenger={
            "challenger_agent": "access-boundary-auditor", "challenger_revision_id": "challenger-r1",
            "source_revision_id": state["latest_revision"]["revision_id"],
            "source_plan_content_hash": state["latest_revision"]["content_hash"],
            "plan_content": {**body, "summary": "An ordinary independent challenger proposal."},
        }, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CHALLENGER_DRAFTED")

    def _complete_native_cross_reviews(self, *, material_risk=False) -> None:
        from datetime import datetime, timedelta, timezone
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        latest = state["latest_revision"]
        tasks = []
        for task_id, reviewer, direction in (("task-p2c", "farm-expert", "primary_to_challenger"),
                                              ("task-c2p", "access-boundary-auditor", "challenger_to_primary")):
            task = {"task_id": task_id, "reviewer_agent": reviewer, "review_direction": direction,
                    "target_revision_id": latest["revision_id"], "target_plan_content_hash": latest["content_hash"],
                    "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()}
            task["task_packet_hash"] = content_hash(task)
            tasks.append(task)
        request_cross_review(plan_id="plan-1", request={"round_number": 1,
            "target_revision_id": latest["revision_id"], "target_plan_content_hash": latest["content_hash"],
            "tasks": tasks}, base_dir=self.tools)
        for index, task in enumerate(tasks):
            risks = [{"risk_id": "RISK-1", "risk_category": "architecture", "severity": "material",
                      "summary": "Plan lacks an ordinary compatibility check", "affected_files": ["aria-kernel/aria_kernel/knowledge_graph.py"],
                      "recommendation": "Include a native regression", "evidence_refs": ["docs/aria/SPEC.md"]}] if material_risk and index == 0 else []
            review = {key: task[key] for key in ("task_packet_hash", "target_revision_id", "target_plan_content_hash",
                                                "reviewer_agent", "review_direction")}
            review["risks"] = risks
            review["review_content_hash"] = content_hash(review)
            record_cross_review(plan_id="plan-1", review=review, workspace_root=self.root, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEWED")

    def _record_current_revision(self, body: dict) -> dict:
        from aria_kernel.plan_convergence import record_revision
        self._submit_native_challenger(body)
        self._complete_native_cross_reviews()
        state = fold_plan_state(plan_id="plan-1", base_dir=self.tools)
        revised = {**body, "summary": "PRIMARY_PROPOSAL_ONLY: revised implementation rationale.",
                   "evidence_refs": ["aria-kernel/aria_kernel/runtime_artifacts.py:1"],
                   "affected_surfaces": [{"paths": ["aria-kernel/aria_kernel/runtime_artifacts.py"]}]}
        record_revision(plan_id="plan-1", revision={"revision_id": "rev-current", "round": 1,
            "content": json.dumps(revised, sort_keys=True), "content_hash": content_hash(revised),
            "parent_revision_hash": state["latest_revision"]["content_hash"], "addresses_review_risk_ids": []}, base_dir=self.tools)
        self.assertEqual(fold_plan_state(plan_id="plan-1", base_dir=self.tools)["state"], "REVISED")
        return revised

    def test_revised_drainer_uses_matched_json_body_after_native_reviews(self) -> None:
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        revised = self._record_current_revision(body)
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        self._assert_native_current_body("challenger_plan", revised, expected_feature="runtime_artifacts.autonomy_output_summary")

    def test_revised_controller_challenger_keeps_primary_proposal_independent(self) -> None:
        from aria_kernel.plan_round_controller import advance_plan_rounds
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        revised = self._record_current_revision(body)
        result = advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.root)
        self.assertEqual(result["status"], "challenger_request_opened")
        self._assert_native_current_body("challenger_plan", revised, cycle_id=None,
                                         scope=["aria-kernel/**", "aria-tools/**", ".claude/**"],
                                         expected_feature="runtime_artifacts.autonomy_output_summary")

    def test_cross_review_drainer_preserves_current_source_context_and_both_proposals(self) -> None:
        from aria_kernel import agent_invocations as ai
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self._submit_native_challenger(body)
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        request = self._assert_native_current_body("cross_review", body)
        prompt = ai.render_invocation_prompt(request)
        self.assertIn("PRIMARY_PROPOSAL_ONLY", prompt)
        self.assertIn("ordinary independent challenger proposal", prompt)

    def test_later_primary_drainer_uses_reviewed_body_and_current_cycle(self) -> None:
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self._submit_native_challenger(body)
        self._complete_native_cross_reviews(material_risk=True)
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        request = self._assert_native_current_body("primary_plan", body)
        self.assertEqual(request["round_number"], 2)

    def test_cross_review_controller_forwards_current_body_and_explicit_root(self) -> None:
        from aria_kernel.plan_round_controller import advance_plan_rounds
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self._submit_native_challenger(body)
        result = advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.root)
        self.assertEqual(result["status"], "cross_review_opened")
        self.assertEqual(result["state"], "CROSS_REVIEW_REQUESTED")
        requests = [row for row in self.requests() if row["role"] == "cross_review"]
        self.assertEqual(len(requests), 2)
        self.assertEqual({json.loads(row["suggested_prompt"])["task"]["review_direction"] for row in requests},
                         {"primary_to_challenger", "challenger_to_primary"})
        for request in requests:
            self._assert_native_body_request(request, body, cycle_id=None,
                                             scope=["aria-kernel/**", "aria-tools/**", ".claude/**"])
            self.assertEqual(request["context_source_paths"], ["aria-kernel/aria_kernel/knowledge_graph.py", "web/non-authorizing-hint.ts"])
        before = {name: (self.tools / f"agent-invocations/{name}.jsonl").read_bytes()
                  for name in ("requests", "contexts", "prompts")}
        self.assertEqual(advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.root)["status"], "waiting_for_reviews")
        for name, data in before.items():
            self.assertEqual((self.tools / f"agent-invocations/{name}.jsonl").read_bytes(), data)

    def test_later_primary_controller_forwards_current_body_and_explicit_root(self) -> None:
        from aria_kernel.plan_round_controller import advance_plan_rounds
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self._submit_native_challenger(body)
        self._complete_native_cross_reviews(material_risk=True)
        result = advance_plan_rounds(plan_id="plan-1", base_dir=self.tools, workspace_root=self.root)
        self.assertEqual(result["status"], "primary_revision_requested")
        self.assertEqual(result["state"], "CROSS_REVIEWED")
        request = self._assert_native_current_body("primary_plan", body, cycle_id=None,
                                                  scope=["aria-kernel/**", "aria-tools/**", ".claude/**"])
        self.assertEqual(request["round_number"], 2)
        self.assertEqual(request["context_source_paths"], ["aria-kernel/aria_kernel/knowledge_graph.py", "web/non-authorizing-hint.ts"])

    def test_revised_cross_review_uses_actual_current_body_after_adoption(self) -> None:
        from aria_kernel.plan_convergence import plan_body_from_state
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        revised = self._record_current_revision(body)
        self._submit_native_challenger(revised)
        current = plan_body_from_state(fold_plan_state(plan_id="plan-1", base_dir=self.tools))
        self.assertEqual(current["plan_content"], revised)
        self.assertEqual(current["content_hash"], content_hash(revised))
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        request = self._assert_native_current_body("cross_review", revised,
                                                  expected_feature="runtime_artifacts.autonomy_output_summary")
        primary_text = request["suggested_prompt"].split('<untrusted_primary_plan revision_id="rev-current">\n', 1)[1].split('\n</untrusted_primary_plan>', 1)[0]
        self.assertEqual(json.loads(primary_text), current["plan_content"])
        self.assertEqual(content_hash(json.loads(primary_text)), current["content_hash"])
        self.assertIn("revised implementation rationale", request["suggested_prompt"])
        self.assertNotIn("reuse the existing convention owner", request["suggested_prompt"])
        self.assertIn("ordinary independent challenger proposal", request["suggested_prompt"])

    def test_legacy_prose_revision_remains_current_text_without_structured_source_claim(self) -> None:
        from aria_kernel.plan_convergence import record_revision
        from aria_kernel import agent_invocations as ai
        body = self._prepare_named_planner_source()
        start_plan(plan_id="plan-1", initial_revision_id="rev-0", plan_content=body, base_dir=self.tools)
        self._submit_native_challenger(body)
        self._complete_native_cross_reviews()
        prose = "An ordinary legacy prose revision with an explicit compatibility check."
        record_revision(plan_id="plan-1", revision={"revision_id": "rev-prose", "round": 1,
            "content": prose, "content_hash": content_hash({"content": prose}),
            "parent_revision_hash": content_hash(body), "addresses_review_risk_ids": []}, base_dir=self.tools)
        self._submit_native_challenger(body)
        self.assertEqual(self.step()["arbiter_verdict"], "in_progress")
        request = next(row for row in self.requests() if row["role"] == "cross_review")
        primary_text = request["suggested_prompt"].split('<untrusted_primary_plan revision_id="rev-prose">\n', 1)[1].split('\n</untrusted_primary_plan>', 1)[0]
        self.assertEqual(primary_text, prose)
        self.assertNotIn("PRIMARY_PROPOSAL_ONLY", request["suggested_prompt"])
        self.assertIn("ordinary independent challenger proposal", request["suggested_prompt"])
        self.assertEqual(request["evidence_refs"], ["docs/aria/SPEC.md"])
        self.assertIsNone(request["plan_revision_hash"])
        self.assertNotIn("context_source_paths", request)
        native = ai.verify_invocation_context_binding(request_id=request["request_id"], context_hash=request["context_hash"],
                                                     prompt_hash=request["prompt_hash"], base_dir=self.tools)
        self.assertEqual(native["prompt"]["prompt_text"], ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)))
        self.assertEqual(native["context"]["repo_root"], str(self.root.resolve()))

    def test_real_discovery_twin_reaches_challenger_context(self) -> None:
        from aria_kernel import agent_invocations as ai
        from aria_kernel.cycle import _phase_discovery, _phase_twin_refresh, build_phase_context
        from aria_kernel.ledger import load_declared_jsonl
        from aria_kernel.tool_registry import ensure_tools_binding
        from tests._helpers.git_fixtures import _git

        for relative, body in {
            "docs/aria/SPEC.md": "# ARIA local planner fixture\nUse repository evidence.\n",
            "aria-kernel/aria_kernel/plan_convergence.py": "def plan_body_from_state(state):\n    return state\n",
        }.items():
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(body, encoding="utf-8")
        _git(["init", "-q"], cwd=self.root)
        _git(["config", "user.email", "planner-fixture@aria.test"], cwd=self.root)
        _git(["config", "user.name", "Planner Fixture"], cwd=self.root)
        _git(["add", "-A"], cwd=self.root)
        _git(["commit", "-q", "-m", "fixture: lawful planner sources and roles"], cwd=self.root)
        head = _git(["rev-parse", "HEAD"], cwd=self.root).stdout.strip()
        self.tools = ensure_tools_binding(Path(self.tmp.name) / "store/tools", workspace_root=self.root)
        context = build_phase_context(
            cycle_id="cyc-step", workspace_root=self.root, base_dir=self.tools,
            snapshot_mode="committed",
        )
        discovered = _phase_discovery(context)
        context.results["discovery"] = discovered
        mapped = _phase_twin_refresh(context)
        self.assertTrue(discovered["completion_proof"]["complete"])
        self.assertEqual(mapped["indexed_sha"], head)
        start_plan(plan_id="plan-1", initial_revision_id="rev-0",
                   plan_content=self.plan(), base_dir=self.tools)
        result = self.step()
        self.assertEqual(result["arbiter_verdict"], "in_progress")
        requests_path = self.tools / "agent-invocations/requests.jsonl"
        requests = load_declared_jsonl(requests_path, expected_surface="agent_invocation_requests")
        challengers = [row for row in requests if row["role"] == "challenger_plan"]
        self.assertEqual(len(challengers), 1)
        request = challengers[0]
        self.assertEqual(request["target_sha"], head)
        binding = ai.verify_invocation_context_binding(
            request_id=request["request_id"], context_hash=request["context_hash"],
            prompt_hash=request["prompt_hash"], base_dir=self.tools,
        )
        prompt = ai.render_invocation_prompt(request)
        self.assertEqual(prompt, binding["prompt"]["prompt_text"])
        self.assertEqual(prompt, ai.render_invocation_prompt(ai.fuse_prompt_envelope(request)))
        self.assertEqual(
            {"repo_root": binding["context"]["repo_root"], "cycle_id": request["cycle_id"]},
            {"repo_root": str(self.root.resolve()), "cycle_id": "cyc-step"},
        )
        before = {name: (self.tools / f"agent-invocations/{name}.jsonl").read_bytes()
                  for name in ("requests", "contexts", "prompts")}
        repeated = self.step()
        self.assertEqual(repeated["arbiter_verdict"], "in_progress")
        for name, content in before.items():
            self.assertEqual((self.tools / f"agent-invocations/{name}.jsonl").read_bytes(), content)


class NoStepEverSleeps(_StepCase):
    def test_every_state_branch_completes_without_waiting(self) -> None:
        # WALL-CLOCK, not a sleep patch. A blanket `time.sleep` patch
        # cannot tell the step waiting (the defect) from the OS waiting
        # on the git subprocess that resolves target_sha (unavoidable and
        # bounded) — it caught the latter the moment a neighbouring train
        # made that subprocess reachable from this fixture. The
        # source-level "the module never sleeps" claim is pinned by
        # I-V10.5-5-02; this asks what that one cannot: does a step take
        # step-time or wait-time?
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        started = time.monotonic()
        first = self.step()   # DRAFT branch
        second = self.step()  # idempotent await branch
        elapsed = time.monotonic() - started
        self.assertEqual(first["arbiter_verdict"], "in_progress")
        self.assertEqual(second["arbiter_verdict"], "in_progress")
        self.assertLess(
            elapsed, 30.0,
            f"two steps took {elapsed:.1f}s — something is waiting for work "
            "the executor lane delivers between cycles.",
        )


class CrossCycleConvergence(_StepCase):
    def _cross_task(self, task_id: str, reviewer: str, direction: str, rev: str, h: str) -> dict:
        from datetime import datetime, timedelta, timezone

        return {
            "task_id": task_id,
            "reviewer_agent": reviewer,
            "review_direction": direction,
            "target_revision_id": rev,
            "target_plan_content_hash": h,
            "task_packet_hash": content_hash({"t": task_id}),
            "sla_deadline": (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat(),
        }

    def test_steps_reach_converged_across_cycles_with_zero_polling(self) -> None:
        # Cycle 1: no plan yet → started + challenger minted.
        first = self.step()
        self.assertEqual(first["arbiter_verdict"], "in_progress")
        # "Executor" delivers the challenger (kernel-native fold).
        state = plan_status(plan_id="plan-1", base_dir=self.tools)
        challenger = self.plan()
        challenger["title"] = "Challenger Plan"
        submit_challenger_plan(
            plan_id="plan-1",
            challenger={
                "challenger_agent": "access-boundary-auditor",
                "challenger_revision_id": "challenger-rev-0",
                "source_revision_id": state["latest_revision"]["revision_id"],
                "source_plan_content_hash": state["latest_revision"]["content_hash"],
                "plan_content": challenger,
            },
            base_dir=self.tools,
        )
        # Cycle 2: CHALLENGER_DRAFTED → cross_review envelope minted.
        second = self.step()
        self.assertEqual(second["arbiter_verdict"], "in_progress")
        self.assertEqual(
            len([r for r in self.requests() if r.get("role") == "cross_review"]), 1,
        )
        # "Executor" delivers both cross-review directions.
        state = plan_status(plan_id="plan-1", base_dir=self.tools)
        latest = state["latest_revision"]
        request_cross_review(
            plan_id="plan-1",
            request={
                "round_number": 1,
                "target_revision_id": latest["revision_id"],
                "target_plan_content_hash": latest["content_hash"],
                "tasks": [
                    self._cross_task("task-p2c-1", "farm-expert", "primary_to_challenger", latest["revision_id"], latest["content_hash"]),
                    self._cross_task("task-c2p-1", "access-boundary-auditor", "challenger_to_primary", latest["revision_id"], latest["content_hash"]),
                ],
            },
            base_dir=self.tools,
        )
        for task_id, reviewer, direction in (
            ("task-p2c-1", "farm-expert", "primary_to_challenger"),
            ("task-c2p-1", "access-boundary-auditor", "challenger_to_primary"),
        ):
            state = plan_status(plan_id="plan-1", base_dir=self.tools)
            current = state["cross_reviews"][state["current_round"]]
            task = next(t for t in current["tasks"].values() if t["task_id"] == task_id)
            record_cross_review(
                plan_id="plan-1",
                review={
                    "task_packet_hash": task["task_packet_hash"],
                    "target_revision_id": task["target_revision_id"],
                    "target_plan_content_hash": task["target_plan_content_hash"],
                    "reviewer_agent": reviewer,
                    "review_direction": direction,
                    "risks": [],
                    "review_content_hash": content_hash({"r": reviewer}),
                },
                workspace_root=self.root,
                base_dir=self.tools,
            )
        self.assertEqual(
            plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "CROSS_REVIEWED",
        )
        # Cycle 3: CROSS_REVIEWED → evaluate → terminal (schema v1: no
        # coverage gate; zero risks converge). Independence may honestly
        # downgrade (the kernel-native folds carry no claim trail), so the
        # pin is: a TERMINAL verdict with zero polling governance rows.
        third = self.step()
        self.assertIn(
            third["arbiter_verdict"], {"converged", "cross_review_self_agreement"},
        )
        self.assertEqual(
            plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "CONVERGED",
        )
        gov_path = self.tools / "governance.jsonl"
        gov = gov_path.read_text(encoding="utf-8") if gov_path.exists() else ""
        self.assertNotIn("poll_timeout", gov)
        self.assertIn("convergence_step_advanced", gov)


class DeadEnvelope(_StepCase):
    def test_dead_envelope_forces_honest_terminal_not_an_orbit(self) -> None:
        # Retry budgeting lives at the request layer (Y1) and bridge
        # mints are idempotent, so a dead envelope cannot be re-minted —
        # the step must escalate to a TERMINAL HUMAN_REQUIRED instead of
        # returning in_progress forever.
        start_plan(
            plan_id="plan-1", initial_revision_id="rev-0",
            plan_content=self.plan(), base_dir=self.tools,
        )
        first = self.step()
        self.assertEqual(first["arbiter_verdict"], "in_progress")
        with mock.patch.object(cd, "_live_request_id", return_value=None):
            second = self.step()
        self.assertNotEqual(second["arbiter_verdict"], "in_progress")
        self.assertEqual(
            plan_status(plan_id="plan-1", base_dir=self.tools)["state"], "HUMAN_REQUIRED",
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8")
        self.assertIn("convergence_envelope_dead", gov)
        # Next cycle: terminal plan short-circuits — fresh plans are the
        # adopter's business, not this one's.
        final = self.step()
        self.assertNotEqual(final["arbiter_verdict"], "in_progress")


if __name__ == "__main__":
    unittest.main()
