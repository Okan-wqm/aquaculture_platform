"""Plan 032 Faz 032i — decision memory, token economy, self-improvement without widening authority.

Invariants:
  I-V12-MEM-01  decisions are collected only from rows that state a reason (recovery,
                control, curation, human-required, plan/mission events, governance
                with reason/rationale); ranking is deterministic (overlap, then
                recency); the pack is hash-addressed and cut to the token budget.
  I-V12-MEM-02  the pack is attached at MINT, rendered as a tagged DATA block, sealed
                by the prompt hash (re-rendering the row reproduces the text), and a
                request with nothing applicable carries no block.
  I-V12-ECON-01 tokens per ACCEPTED result joins usage and results; a sustained
                overrun (or no acceptance across ≥ min spawns) recommends ONE rung
                down (never below medium); recommendations are ledgered with closed
                kinds/actions; `effective_effort` applies a fresh downgrade only and
                writes a governance row; the executor asks it before the spawn.
  I-V12-SELF-01 signals become `self_improvement` missions (idempotent, bounded);
                a self_change proposal must point inside the kernel scope and never
                at an authority surface (refusal is a governance row); every
                proposal opens a HUMAN_REQUIRED adjudication; apply_engine still
                refuses self_change outside the kernel-change lane.
  I-V12-SELF-02 the scheduler carries `self_improve` and `economy` (one-way door
                17); doctor has the `economy` organ; CLI exposes context compile,
                economy stats/recommend, self-improve scan/open/propose; the
                harness-parity report is current with every row verified.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import context_compiler as cc
from aria_kernel import control
from aria_kernel import self_improvement as si
from aria_kernel import token_economy as te
from aria_kernel.agent_invocations import create_agent_invocation_request, render_invocation_prompt
from aria_kernel.gateway.scheduler import SCHEDULE_ACTIONS
from aria_kernel.harness_parity import check_parity, render_parity_report
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"


class _Store(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ws = self.root / "repo"
        self.ws.mkdir()
        subprocess.run(["git", "init", "-q", str(self.ws)], check=True)
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def governance(self) -> str:
        path = self.tools / "governance.jsonl"
        return path.read_text(encoding="utf-8") if path.exists() else ""


class DecisionMemory(_Store):
    def test_I_V12_MEM_01_collect_rank_budget(self) -> None:
        self.assertEqual(cc.collect_decisions(base_dir=self.tools), [])
        control.record_control("cancel", base_dir=self.tools, request_id="AIR-1", reason="tenant isolation plan superseded by the farm-service split")
        control.record_control("pause", base_dir=self.tools, reason="deploy window")
        control.record_control("resume", base_dir=self.tools)  # no reason → not a decision with a why? it is recorded with empty why
        from aria_kernel import recovery

        recovery.classify_recovery("AIR-2", base_dir=self.tools, fingerprint="fp", remote_reader=lambda i: None)
        decisions = cc.collect_decisions(base_dir=self.tools)
        sources = {d.source for d in decisions}
        self.assertTrue({"control", "recovery"} <= sources, sources)
        for d in decisions:
            self.assertIn(d.source, cc.DECISION_SOURCES)
        ranked = cc.rank_decisions(decisions, query="tenant isolation farm-service", k=2)
        self.assertIn("AIR-1", ranked[0].what)
        pack = cc.compile_context(request={"request_id": "r", "suggested_prompt": "tenant isolation plan"}, base_dir=self.tools, budget_tokens=60)
        self.assertTrue(pack.pack_hash.startswith("sha256:"))
        self.assertLessEqual(pack.token_estimate, 60)
        self.assertGreaterEqual(len(pack.decisions), 1)
        again = cc.compile_context(request={"request_id": "r", "suggested_prompt": "tenant isolation plan"}, base_dir=self.tools, budget_tokens=60, record=False)
        self.assertEqual(again.pack_hash, pack.pack_hash, "deterministic")
        self.assertIn(cc.CONTEXT_PACK_EVENT, self.governance())
        self.assertEqual(cc.render_decision_memory(None), "")
        self.assertIn("because:", cc.render_decision_memory(pack.to_dict()))

    def test_I_V12_MEM_01_d4_embedder_ranks_semantically_and_degrades(self) -> None:
        control.record_control("cancel", base_dir=self.tools, request_id="AIR-1", reason="tenant isolation plan superseded")
        control.record_control("pause", base_dir=self.tools, reason="sensor gateway deploy window")
        decisions = cc.collect_decisions(base_dir=self.tools)

        def fake_embed(text: str) -> list[float]:  # "sensor" axis vs "tenant" axis
            return [float("sensor" in text or "gateway" in text), float("tenant" in text)]

        embedder = (fake_embed, "fake-v1")
        self.assertEqual(cc.embed_decisions(decisions, base_dir=self.tools, embedder=embedder), len(decisions))
        self.assertEqual(cc.embed_decisions(decisions, base_dir=self.tools, embedder=embedder), 0, "idempotent on ref id")
        ranked = cc.rank_decisions(decisions, query="deploy the sensor gateway", base_dir=self.tools, embedder=embedder)
        self.assertIn("pause", ranked[0].what)
        lexical = cc.rank_decisions(decisions, query="tenant isolation")
        self.assertIn("AIR-1", lexical[0].what)

        def broken(text: str) -> list[float]:
            raise RuntimeError("model down")

        degraded = cc.rank_decisions(decisions, query="tenant isolation", base_dir=self.tools, embedder=(broken, "broken-v1"))
        self.assertIn("AIR-1", degraded[0].what, "a failing embedder degrades to lexical ranking")
        from aria_kernel.semantic_memory import _KNOWN_KINDS

        self.assertIn("decision", _KNOWN_KINDS)

    def test_I_V12_MEM_02_sealed_at_mint_rendered_as_data(self) -> None:
        bare = create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan", suggested_prompt="anything",
            must_satisfy=[{"id": "x", "criterion": "y"}], allowed_scope=["apps/**"], convergence_id="conv-0", base_dir=self.tools)
        self.assertNotIn("decision_memory", bare)
        self.assertNotIn('section="decision_memory"', render_invocation_prompt(bare))
        control.record_control("cancel", base_dir=self.tools, request_id="AIR-9", reason="the tenant isolation approach was rejected by the panel")
        req = create_agent_invocation_request(
            target_agent="aria-challenger-planner", role="challenger_plan", suggested_prompt="challenge the tenant isolation plan",
            must_satisfy=[{"id": "x", "criterion": "y"}], allowed_scope=["apps/**"], convergence_id="conv-1", base_dir=self.tools)
        self.assertIn("decision_memory", req)
        prompt = render_invocation_prompt(req)
        self.assertIn('<derived_context section="decision_memory">', prompt)
        self.assertIn("rejected by the panel", prompt)
        self.assertIn("**not evidence**", prompt)
        self.assertEqual(render_invocation_prompt(dict(req)), prompt, "re-rendering the row reproduces the sealed text")
        stripped = {k: v for k, v in req.items() if k != "decision_memory"}
        self.assertNotEqual(render_invocation_prompt(stripped), prompt, "dropping the pack changes the prompt → hash binding catches it")
        source = (_REPO_ROOT / "aria-kernel" / "aria_kernel" / "agent_invocations.py").read_text(encoding="utf-8")
        self.assertIn('    "decision_memory",\n', source)


class TokenEconomy(_Store):
    def _usage(self, rid: str, agent: str, role: str, tokens: int, when: datetime) -> None:
        path = self.tools / "knowledge-graph" / "context-usage.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, {"schema_version": 1, "recorded_at": when.isoformat(), "request_id": rid, "role": role,
                                     "target_agent": agent, "model": "opus", "input_tokens": tokens, "output_tokens": 0,
                                     "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}, expected_surface="context_usage")

    def _accept(self, rid: str) -> None:
        path = self.tools / "agent-invocations" / "results.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, {"schema_version": 1, "row_id": f"result:{rid}", "row_type": "result", "claim_id": f"c-{rid}",
                                     "request_id": rid, "status": "accepted", "role": "challenger_plan"}, expected_surface="agent_invocation_results")

    def test_I_V12_ECON_01_stats_recommendations_governor(self) -> None:
        now = datetime(2026, 9, 3, tzinfo=timezone.utc)
        for i in range(6):
            self._usage(f"AIR-{i}", "aria-a", "challenger_plan", 100_000, now - timedelta(days=1))
        self._accept("AIR-0")
        for i in range(6):
            self._usage(f"AIR-b{i}", "aria-b", "cross_review", 1_000, now - timedelta(days=1))
            self._accept(f"AIR-b{i}")
        self._usage("AIR-old", "aria-a", "challenger_plan", 9_999_999, now - timedelta(days=40))
        stats = {(s.target_agent, s.role): s for s in te.usage_per_accepted_result(base_dir=self.tools, now=now)}
        a, b = stats[("aria-a", "challenger_plan")], stats[("aria-b", "cross_review")]
        self.assertEqual((a.spawns, a.accepted, a.tokens_total, a.tokens_per_accepted), (6, 1, 600_000, 600_000.0), "the 40-day-old row is outside the window")
        self.assertEqual((b.spawns, b.accepted, b.tokens_per_accepted), (6, 6, 1_000.0))
        recs = {(r["target_agent"], r["role"]): r for r in te.recommend_efforts(list(stats.values()))}
        self.assertEqual(recs[("aria-a", "challenger_plan")]["action"], "downgrade")
        self.assertEqual(recs[("aria-b", "cross_review")]["action"], "hold")
        self.assertEqual(te.recommend_efforts([te.UsageStat("x", "r", 2, 0, 5, None)]), [], "below min spawns")
        self.assertEqual(te.recommend_efforts([te.UsageStat("x", "human_required_packet", 9, 0, 5, None)]), [], "excluded role")
        with self.assertRaises(ValueError):
            te.record_recommendations([{"kind": "vibe", "action": "downgrade"}], base_dir=self.tools)
        rows = te.record_recommendations([*recs.values(), *te.calibrate_role_caps(list(stats.values()))], base_dir=self.tools)
        self.assertEqual({r["kind"] for r in rows}, {"effort", "cap_calibration"})
        self.assertIn("economy_downgrade_recommended", self.governance())
        self.assertEqual(te.effective_effort("max", target_agent="aria-a", role="challenger_plan", base_dir=self.tools, request_id="AIR-7"), "xhigh")
        self.assertEqual(te.effective_effort("medium", target_agent="aria-a", role="challenger_plan", base_dir=self.tools), "medium", "the floor holds")
        self.assertEqual(te.effective_effort("max", target_agent="aria-b", role="cross_review", base_dir=self.tools), "max")
        self.assertEqual(te.effective_effort("max", target_agent="aria-a", role="challenger_plan", base_dir=self.tools, now=datetime.now(timezone.utc) + timedelta(days=30)), "max", "a stale recommendation expires")
        self.assertIn(te.EFFORT_DOWNGRADED_EVENT, self.governance())
        self.assertEqual(te.lower_effort("low"), "medium")
        self.assertEqual([te.lower_effort(e) for e in te.EFFORT_LADDER], ["medium", "medium", "medium", "high", "xhigh"])
        executor = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        self.assertLess(executor.index("_effort = effective_effort(agent_profile.effort"), executor.index("effort=_effort,"))


class SelfImprovement(_Store):
    def test_I_V12_SELF_01_missions_authority_surfaces_adjudication(self) -> None:
        self.assertEqual(si.authority_surface_violations(["aria-kernel/aria_kernel/search.py", "tools/aria-poc/claude_runtime.py"]), [])
        self.assertEqual(si.authority_surface_violations(["aria-kernel/aria_kernel/hooks.py"]), ["authority_surface:aria-kernel/aria_kernel/hooks.py"])
        self.assertEqual(si.authority_surface_violations([".github/workflows/aria-auto-cycle.yml"]), ["authority_surface:.github/workflows/aria-auto-cycle.yml"])
        self.assertEqual(si.authority_surface_violations(["apps/farm-service/x.py"]), ["outside_kernel_scope:apps/farm-service/x.py"])
        for surface in si.AUTHORITY_SURFACES:
            self.assertTrue(si.authority_surface_violations([surface]) or surface.endswith("/"), surface)
        from aria_kernel import recovery

        recovery.record_intent(request_id="AIR-1", effect_kind="git_push", target="origin/x", intended_postcondition={}, base_dir=self.tools)
        signals = si.scan_signals(base_dir=self.tools, workspace_root=self.ws)
        for signal in signals:
            self.assertIn(signal.kind, si.SIGNAL_KINDS)
        opened = si.open_self_improvement_missions(base_dir=self.tools, workspace_root=self.ws, max_new=2)
        self.assertLessEqual(len(opened), 2)
        again = si.open_self_improvement_missions(base_dir=self.tools, workspace_root=self.ws, max_new=2)
        self.assertTrue(all(o["idempotent"] for o in again), "the same signals reopen nothing")
        from aria_kernel.mission import list_open_missions, open_mission
        from aria_kernel.workspace import canonical_identity

        missions = [m for m in list_open_missions(base_dir=self.tools) if m["source_kind"] == si.SELF_IMPROVEMENT_SOURCE_KIND]
        self.assertEqual(len(missions), len(opened))
        foreign = open_mission(source_kind="github_issue", source_id="issue-1", repo_hash=canonical_identity(self.ws), title="t",
                               next_action="triage_github_issue", wake_condition={"kind": "timer", "key": "k"}, base_dir=self.tools)
        with self.assertRaises(GovernanceError):
            si.propose_self_change(mission_id=str(foreign["mission_id"]), base_dir=self.tools, workspace_root=self.ws,
                                   evidence_paths=["aria-kernel/aria_kernel/search.py"], problem="p", proposed_change="c")
        mission_id = str(missions[0]["mission_id"]) if missions else str(open_mission(
            source_kind=si.SELF_IMPROVEMENT_SOURCE_KIND, source_id="manual:x", repo_hash=canonical_identity(self.ws), title="manual",
            next_action=si.SELF_CHANGE_NEXT_ACTION, wake_condition={"kind": "evidence", "key": "manual"}, base_dir=self.tools)["mission_id"])
        with self.assertRaises(GovernanceError):
            si.propose_self_change(mission_id=mission_id, base_dir=self.tools, workspace_root=self.ws,
                                   evidence_paths=["aria-kernel/aria_kernel/data/runtime_profiles.json"], problem="p", proposed_change="widen")
        self.assertIn(si.SELF_CHANGE_REFUSED_EVENT, self.governance())
        result = si.propose_self_change(mission_id=mission_id, base_dir=self.tools, workspace_root=self.ws,
                                        evidence_paths=["aria-kernel/aria_kernel/search.py"], problem="search misses journal rows",
                                        proposed_change="index files_touched")
        self.assertEqual(result["proposal"]["kind"], "self_change")
        self.assertEqual(result["human_required"]["reason"], "self_change_adjudication")
        self.assertIn(si.SELF_CHANGE_PROPOSED_EVENT, self.governance())
        from aria_kernel import apply_engine

        self.assertIn('if proposal.get("kind") == "self_change":\n        raise GovernanceError', Path(apply_engine.__file__).read_text(encoding="utf-8"))

    def test_I_V12_SELF_02_scheduler_doctor_cli_parity(self) -> None:
        self.assertIn("self_improve", SCHEDULE_ACTIONS)
        self.assertIn("economy", SCHEDULE_ACTIONS)
        from aria_kernel.doctor import run_doctor

        organs = {c.name for c in run_doctor(base_dir=self.tools, workspace_root=self.ws).checks}
        self.assertIn("economy", organs)
        from aria_kernel.cli import build_parser

        parser = build_parser()
        self.assertEqual(parser.parse_args(["context", "compile", "--query", "x"]).context_command, "compile")
        self.assertTrue(parser.parse_args(["economy", "recommend", "--dry-run"]).dry_run)
        self.assertEqual(parser.parse_args(["self-improve", "propose", "--mission-id", "m", "--evidence", "a", "--problem", "p", "--proposed-change", "c"]).evidence_paths, ["a"])
        records = check_parity(repo_root=_REPO_ROOT)
        self.assertEqual([r for r in records if r["problems"]], [])
        generated = _REPO_ROOT / "docs" / "aria" / "generated" / "harness-parity.md"
        self.assertEqual(generated.read_text(encoding="utf-8"), render_parity_report(repo_root=_REPO_ROOT))


if __name__ == "__main__":
    unittest.main()
