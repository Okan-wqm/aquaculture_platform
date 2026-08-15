"""Plan 020 Phase 2 — context budget gate tests.

What this suite pins (≥10 tests):
- estimate_tokens fallback semantics (char/4 ceil) when tiktoken absent.
- Role-cap table: judges 0.35 / planners 0.55 / executors 0.45 /
  emergency 0.65 / domain reviewers 0.45 / default fallback 0.40.
- audit_dispatch_context returns breakdown without raising on cap breach.
- enforce_context_budget raises GovernanceError + emits
  context_budget_exceeded governance event on breach.
- context_budget_audited governance event always emitted.
- aria-tools/context-audits.jsonl Plan 020 surface persistence.
- agent_resolver three-directory lookup (root + _maintenance + product-audit).
- Knowledge bookmark @.claude/knowledge/... reference parsing.
- Frozen profile blocks the audit ledger write
  (enforce_profile_for_write('context_audits', ...)).
- Opt-in kwarg in agent_invocations.create_agent_invocation_request.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_resolver import resolve_agent_md_path
from aria_kernel.context_budget_gate import (
    CONTEXT_AUDITS_FILENAME,
    DEFAULT_CONTEXT_WINDOW_TOKENS,
    DEFAULT_ROLE_CAP,
    ROLE_CAP_MAP,
    audit_dispatch_context,
    enforce_context_budget,
    estimate_tokens,
    list_context_audits,
)
from aria_kernel.runtime_profile import set_profile
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


class _FakeRepo:
    """Minimal repo skeleton with .claude/agents/ + .claude/knowledge/."""

    def __init__(self, root: Path) -> None:
        self.root = root
        (root / ".claude" / "agents").mkdir(parents=True, exist_ok=True)
        (root / ".claude" / "agents" / "_maintenance").mkdir(parents=True, exist_ok=True)
        (root / ".claude" / "agents" / "product-audit").mkdir(parents=True, exist_ok=True)
        (root / ".claude" / "knowledge").mkdir(parents=True, exist_ok=True)

    def write_agent(self, location: str, name: str, body: str) -> Path:
        target = self.root / ".claude" / "agents"
        if location == "maintenance":
            target = target / "_maintenance"
        elif location == "product-audit":
            target = target / "product-audit"
        path = target / f"{name}.md"
        path.write_text(body, encoding="utf-8")
        return path

    def write_knowledge(self, name: str, body: str) -> Path:
        path = self.root / ".claude" / "knowledge" / name
        path.write_text(body, encoding="utf-8")
        return path


def _seed_workspace() -> tuple[Path, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="aria-ctx-budget-"))
    tools = tmp / "aria-tools"
    ensure_tools_dir(tools)
    repo = tmp / "repo"
    repo.mkdir()
    return tools, repo


class EstimateTokensTests(unittest.TestCase):
    def test_empty_string_zero_tokens(self) -> None:
        self.assertEqual(estimate_tokens(""), 0)

    def test_char_div_4_ceil_fallback(self) -> None:
        # tiktoken not installed in CI/sandbox; deterministic fallback.
        # 7 chars → ceil(7/4) = 2.
        self.assertEqual(estimate_tokens("abcdefg"), 2)
        # 8 chars → 2 exactly.
        self.assertEqual(estimate_tokens("abcdefgh"), 2)
        # 9 chars → 3.
        self.assertEqual(estimate_tokens("abcdefghi"), 3)


class RoleCapTableTests(unittest.TestCase):
    def test_judge_caps_are_035(self) -> None:
        for role in ("evidence_judgment", "adversarial_judgment", "consensus_arbitration"):
            self.assertEqual(ROLE_CAP_MAP[role], 0.35, msg=role)

    def test_planner_caps_are_055(self) -> None:
        for role in ("primary_plan", "challenger_plan", "cross_review"):
            self.assertEqual(ROLE_CAP_MAP[role], 0.55, msg=role)

    def test_executor_caps_are_045(self) -> None:
        for role in ("implementation", "gap_closure"):
            self.assertEqual(ROLE_CAP_MAP[role], 0.45, msg=role)

    def test_emergency_cap_is_065(self) -> None:
        # E14 — `architectural_arbitration` left this table with the role
        # itself: no kernel path minted it. HUMAN_REQUIRED packets are the
        # remaining emergency consumer.
        self.assertEqual(ROLE_CAP_MAP["human_required_packet"], 0.65)

    def test_domain_review_cap_is_the_role_that_is_minted(self) -> None:
        # The three per-domain caps were replaced by the cap of the role the
        # specialist runner actually mints.
        self.assertEqual(ROLE_CAP_MAP["specialist_domain_review"], 0.45)

    def test_default_fallback_is_040(self) -> None:
        self.assertEqual(DEFAULT_ROLE_CAP, 0.40)


class AgentResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_resolves_root_agent_md(self) -> None:
        path = self.fake.write_agent("root", "auth-security-expert", "---\nname: auth\n---\n")
        result = resolve_agent_md_path("auth-security-expert", self.repo)
        self.assertEqual(result, path)

    def test_resolves_maintenance_agent_md(self) -> None:
        path = self.fake.write_agent("maintenance", "aria-primary-planner", "---\nname: planner\n---\n")
        result = resolve_agent_md_path("aria-primary-planner", self.repo)
        self.assertEqual(result, path)

    def test_resolves_product_audit_agent_md(self) -> None:
        path = self.fake.write_agent("product-audit", "product-audit-orchestrator", "---\nname: orch\n---\n")
        result = resolve_agent_md_path("product-audit-orchestrator", self.repo)
        self.assertEqual(result, path)

    def test_returns_none_when_no_match(self) -> None:
        self.assertIsNone(resolve_agent_md_path("nope-doesnt-exist", self.repo))

    def test_path_traversal_rejected(self) -> None:
        self.assertIsNone(resolve_agent_md_path("../../../etc/passwd", self.repo))


class AuditDispatchContextTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)
        self.fake.write_agent("root", "tiny-agent", "---\nname: tiny\n---\nshort body\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_audit_returns_breakdown_dict(self) -> None:
        row = audit_dispatch_context(
            request="hello world",
            target_agent="tiny-agent",
            role="primary_plan",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertEqual(row["target_agent"], "tiny-agent")
        self.assertEqual(row["role"], "primary_plan")
        self.assertEqual(row["cap_applied"], 0.55)
        self.assertEqual(row["context_window_tokens"], DEFAULT_CONTEXT_WINDOW_TOKENS)
        self.assertGreater(row["request_token_estimate"], 0)
        self.assertGreater(row["agent_token_estimate"], 0)
        self.assertEqual(row["knowledge_token_estimate"], 0)
        self.assertFalse(row["cap_breached"])
        self.assertEqual(row["missing_knowledge_refs"], [])

    def test_audit_persists_to_context_audits_jsonl(self) -> None:
        audit_dispatch_context(
            request="probe",
            target_agent="tiny-agent",
            role="evidence_judgment",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        path = self.tools / CONTEXT_AUDITS_FILENAME
        self.assertTrue(path.exists())
        rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["role"], "evidence_judgment")
        self.assertEqual(rows[0]["cap_applied"], 0.35)

    def test_audit_emits_context_budget_audited_governance_event(self) -> None:
        audit_dispatch_context(
            request="x",
            target_agent="tiny-agent",
            role="primary_plan",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("context_budget_audited", kinds)

    def test_audit_does_not_raise_on_cap_breach(self) -> None:
        # Force a breach by clamping the window absurdly small.
        row = audit_dispatch_context(
            request="x" * 1_000,
            target_agent="tiny-agent",
            role="primary_plan",
            base_dir=self.tools,
            repo_root=self.repo,
            context_window_tokens_override=100,  # almost certainly breaches
        )
        self.assertTrue(row["cap_breached"])

    def test_audit_includes_missing_knowledge_refs(self) -> None:
        self.fake.write_agent(
            "root", "ref-agent",
            "---\nname: ref\n---\nbody\n@.claude/knowledge/missing-file.md\n",
        )
        row = audit_dispatch_context(
            request="x",
            target_agent="ref-agent",
            role="primary_plan",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertIn(".claude/knowledge/missing-file.md", row["missing_knowledge_refs"])

    def test_audit_resolves_knowledge_token_estimate(self) -> None:
        self.fake.write_knowledge("layer-1-aria.md", "x" * 800)  # 200 tokens fallback
        self.fake.write_agent(
            "root", "ref-agent",
            "---\nname: ref\n---\nbody\n@.claude/knowledge/layer-1-aria.md\n",
        )
        row = audit_dispatch_context(
            request="x",
            target_agent="ref-agent",
            role="primary_plan",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertGreater(row["knowledge_token_estimate"], 100)


class EnforceContextBudgetTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)
        self.fake.write_agent("root", "small-agent", "---\nname: s\n---\nbody\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_within_cap_returns_audit_row(self) -> None:
        row = enforce_context_budget(
            request="x",
            target_agent="small-agent",
            role="primary_plan",
            base_dir=self.tools,
            repo_root=self.repo,
        )
        self.assertFalse(row["cap_breached"])

    def test_cap_breach_raises_governance_error(self) -> None:
        with self.assertRaises(GovernanceError) as cm:
            enforce_context_budget(
                request="x" * 100_000,
                target_agent="small-agent",
                role="evidence_judgment",  # tightest cap 0.35
                base_dir=self.tools,
                repo_root=self.repo,
                context_window_tokens_override=10_000,
            )
        self.assertIn("context_budget_exceeded", str(cm.exception))

    def test_cap_breach_emits_context_budget_exceeded_governance_event(self) -> None:
        with self.assertRaises(GovernanceError):
            enforce_context_budget(
                request="x" * 100_000,
                target_agent="small-agent",
                role="evidence_judgment",
                base_dir=self.tools,
                repo_root=self.repo,
                context_window_tokens_override=10_000,
            )
        gov = (self.tools / "governance.jsonl").read_text(encoding="utf-8").splitlines()
        kinds = [json.loads(line)["kind"] for line in gov if line.strip()]
        self.assertIn("context_budget_exceeded", kinds)

    def test_role_cap_override_applied(self) -> None:
        # Override pushes the planner cap from 0.55 to 0.01 so even small
        # input breaches.
        with self.assertRaises(GovernanceError):
            enforce_context_budget(
                request="x" * 1_000,
                target_agent="small-agent",
                role="primary_plan",
                base_dir=self.tools,
                repo_root=self.repo,
                role_cap_override={"primary_plan": 0.01},
                context_window_tokens_override=1_000,
            )


class FrozenProfileBlocksAuditWriteTests(unittest.TestCase):
    """Plan 020 Phase 1.B — context_audits is in PLAN_020_WRITE_SURFACES.

    Frozen profile must reject the audit write (consistent with the no-write
    invariant). The pure audit math still runs in memory; the persist step
    is what raises.
    """

    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)
        self.fake.write_agent("root", "tiny-agent", "---\nname: tiny\n---\nshort body\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_frozen_blocks_audit_persist(self) -> None:
        set_profile(
            "frozen",
            operator_approval_ref="test:plan-020-phase-2:frozen",
            base_dir=self.tools,
        )
        with self.assertRaises(GovernanceError) as cm:
            audit_dispatch_context(
                request="x",
                target_agent="tiny-agent",
                role="primary_plan",
                base_dir=self.tools,
                repo_root=self.repo,
            )
        self.assertIn("frozen profile", str(cm.exception))
        self.assertIn("context_audits", str(cm.exception))


class ListContextAuditsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)
        self.fake.write_agent("root", "agent-a", "---\nname: a\n---\nbody\n")
        self.fake.write_agent("root", "agent-b", "---\nname: b\n---\nbody\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_empty_list_when_no_audits(self) -> None:
        self.assertEqual(list_context_audits(base_dir=self.tools), [])

    def test_filter_by_target_agent(self) -> None:
        for ag in ("agent-a", "agent-b", "agent-a"):
            audit_dispatch_context(
                request="x", target_agent=ag, role="primary_plan",
                base_dir=self.tools, repo_root=self.repo,
            )
        rows = list_context_audits(base_dir=self.tools, target_agent="agent-a")
        self.assertEqual(len(rows), 2)
        self.assertEqual({r["target_agent"] for r in rows}, {"agent-a"})


class CreateAgentInvocationRequestOptInTests(unittest.TestCase):
    """Phase 2.B — opt-in enforce_context_budget kwarg on the request creator."""

    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)
        self.fake.write_agent("root", "tiny-agent", "---\nname: tiny\n---\nbody\n")
        self.fake.write_agent("root", "aria-evidence-judge", "---\nname: judge\n---\nbody\n")

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def test_default_off_does_not_call_gate(self) -> None:
        from aria_kernel.agent_invocations import create_agent_invocation_request
        # Plan 024 §B-2 — context-budget tests focus on the budget gate,
        # not the strict matrix; escape hatch keeps the test minimal.
        row = create_agent_invocation_request(
            target_agent="tiny-agent",
            role="primary_plan",
            suggested_prompt="x" * 100_000,
            legacy_strict_fields_optional=True,
            base_dir=self.tools,
        )
        self.assertEqual(row["target_agent"], "tiny-agent")

    def test_enforce_kwarg_raises_on_cap_breach(self) -> None:
        from aria_kernel.agent_invocations import create_agent_invocation_request
        with self.assertRaises(GovernanceError) as cm:
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt="x" * 100_000,
                legacy_strict_fields_optional=True,
                base_dir=self.tools,
                enforce_context_budget=True,
                context_repo_root=self.repo,
                context_window_tokens_override=10_000,
            )
        self.assertIn("context_budget_exceeded", str(cm.exception))


class DocsRefWideningTests(unittest.TestCase):
    """E17-d — @docs/aria + @docs/adr refs join the audited context cost.

    Every ARIA judge/planner preamble cold-reads ~138KB of static docs via
    @docs/aria/{SPEC,CONTRACTS,PIPELINES}.md lines, and the pre-E17-d regex
    counted ONLY @.claude/knowledge/ — the biggest per-spawn cost was
    invisible to the audit. These tests pin the widened parser end-to-end
    through the same resolution + tokenization path, including the
    deliberate-break: a huge @docs/aria ref must now push a judge-role
    request over its cap.
    """

    # The real five-doc preamble shape (.claude/agents/aria-evidence-judge.md).
    _PREAMBLE = (
        "---\nname: judge\n---\n"
        "- @.claude/knowledge/layer-1-aria.md\n"
        "- @.claude/knowledge/layer-2-aria-canonical-envelope.md\n"
        "- @docs/aria/SPEC.md\n"
        "- @docs/aria/CONTRACTS.md\n"
        "- @docs/aria/PIPELINES.md\n"
    )

    def setUp(self) -> None:
        self.tools, self.repo = _seed_workspace()
        self.fake = _FakeRepo(self.repo)
        (self.repo / "docs" / "aria").mkdir(parents=True)
        (self.repo / "docs" / "adr").mkdir(parents=True)
        self.fake.write_knowledge("layer-1-aria.md", "k" * 400)  # 100 tokens
        self.fake.write_knowledge("layer-2-aria-canonical-envelope.md", "k" * 400)
        for name in ("SPEC.md", "CONTRACTS.md", "PIPELINES.md"):
            (self.repo / "docs" / "aria" / name).write_text("d" * 4000, encoding="utf-8")  # 1000 tokens each
        self.fake.write_agent("root", "five-doc-judge", self._PREAMBLE)

    def tearDown(self) -> None:
        shutil.rmtree(self.tools.parent, ignore_errors=True)

    def _audit(self, target: str) -> dict:
        return audit_dispatch_context(
            request="probe",
            target_agent=target,
            role="evidence_judgment",
            base_dir=self.tools,
            repo_root=self.repo,
            write_ledger=False,
        )

    def test_five_doc_preamble_docs_tokens_now_visible(self) -> None:
        # Before/after visible: knowledge alone is 200 tokens; the three
        # docs/aria files add 3000. The pre-widening audit reported <=200
        # here — an estimate above 3000 is only reachable because @docs/aria
        # refs now flow through the SAME resolution + tokenization path.
        row = self._audit("five-doc-judge")
        self.assertGreaterEqual(row["knowledge_token_estimate"], 3200)
        self.assertEqual(row["missing_knowledge_refs"], [])
        knowledge_surface = next(
            entry for entry in row["biggest_files"] if entry["surface"] == "knowledge"
        )
        self.assertIn("docs/aria/SPEC.md", knowledge_surface["refs"])
        self.assertIn("docs/aria/CONTRACTS.md", knowledge_surface["refs"])
        self.assertIn("docs/aria/PIPELINES.md", knowledge_surface["refs"])
        self.assertIn(".claude/knowledge/layer-1-aria.md", knowledge_surface["refs"])

    def test_docs_adr_ref_resolves_through_same_path(self) -> None:
        (self.repo / "docs" / "adr" / "ADR-031-aria.md").write_text(
            "a" * 800, encoding="utf-8",
        )
        self.fake.write_agent(
            "root", "adr-agent",
            "---\nname: adr\n---\nbody\n@docs/adr/ADR-031-aria.md\n",
        )
        row = self._audit("adr-agent")
        self.assertGreaterEqual(row["knowledge_token_estimate"], 200)
        self.assertEqual(row["missing_knowledge_refs"], [])

    def test_missing_docs_ref_lands_in_missing_refs(self) -> None:
        self.fake.write_agent(
            "root", "ghost-agent",
            "---\nname: ghost\n---\nbody\n@docs/aria/DOES-NOT-EXIST.md\n",
        )
        row = self._audit("ghost-agent")
        self.assertIn("docs/aria/DOES-NOT-EXIST.md", row["missing_knowledge_refs"])

    def test_huge_docs_aria_ref_breaches_judge_cap(self) -> None:
        # Deliberate-break: window 10_000 → judge cap 0.35 = 3_500 tokens.
        # The synthetic doc alone is 5_000 tokens; pre-widening this exact
        # dispatch passed the gate because the doc was invisible.
        (self.repo / "docs" / "aria" / "HUGE-SYNTHETIC.md").write_text(
            "h" * 20_000, encoding="utf-8",
        )
        self.fake.write_agent(
            "root", "huge-doc-judge",
            "---\nname: huge\n---\nbody\n@docs/aria/HUGE-SYNTHETIC.md\n",
        )
        with self.assertRaises(GovernanceError) as cm:
            enforce_context_budget(
                request="probe",
                target_agent="huge-doc-judge",
                role="evidence_judgment",
                base_dir=self.tools,
                repo_root=self.repo,
                context_window_tokens_override=10_000,
            )
        self.assertIn("context_budget_exceeded", str(cm.exception))
        self.assertIn("evidence_judgment", str(cm.exception))

    def test_counterfactual_same_agent_without_doc_ref_stays_under_cap(self) -> None:
        # The breach above is CAUSED by the @docs ref, not by the agent body
        # or request — the identical dispatch without the ref passes.
        self.fake.write_agent(
            "root", "no-doc-judge", "---\nname: bare\n---\nbody\n",
        )
        row = enforce_context_budget(
            request="probe",
            target_agent="no-doc-judge",
            role="evidence_judgment",
            base_dir=self.tools,
            repo_root=self.repo,
            context_window_tokens_override=10_000,
        )
        self.assertFalse(row["cap_breached"])


if __name__ == "__main__":
    unittest.main()
