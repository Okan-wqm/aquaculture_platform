"""Tests for the Plan 016 Faz D7 nine-counter metric set + dashboard writer."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    claim_request,
    create_agent_invocation_request,
    release_claim,
)
from aria_kernel.plan_016_metrics import (
    PLAN_016_METRIC_NAMES,
    compute_plan_016_metrics,
    render_dashboard_markdown,
    write_dashboard,
)
from aria_kernel.tool_registry import append_tools_governance, ensure_tools_dir


def _seed_tools() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-d7-"))
    tools = repo / "aria-tools"
    ensure_tools_dir(tools)
    return tools


class CounterShapeTests(unittest.TestCase):
    def test_metric_set_has_nine_baseline_counters_plus_plan020_extensions(self) -> None:
        # Plan 016 baseline 9 + Plan 020 Phase 6 +2 (mock/real eval) +
        # Phase 9 +1 (chain validation pct) + Phase 13 +1 (dispatch
        # rationale) = 13 (Plan 020 final counter set).
        from aria_kernel.plan_016_metrics import (
            PLAN_016_BASELINE_METRIC_NAMES,
            PLAN_020_PHASE_6_METRIC_NAMES,
            PLAN_020_PHASE_9_METRIC_NAMES,
            PLAN_020_PHASE_13_METRIC_NAMES,
        )
        self.assertEqual(len(PLAN_016_BASELINE_METRIC_NAMES), 9)
        self.assertEqual(len(PLAN_020_PHASE_6_METRIC_NAMES), 2)
        self.assertEqual(len(PLAN_020_PHASE_9_METRIC_NAMES), 1)
        self.assertEqual(len(PLAN_020_PHASE_13_METRIC_NAMES), 1)
        self.assertEqual(len(PLAN_016_METRIC_NAMES), 13)

    def test_compute_returns_zero_baseline_on_fresh_tools(self) -> None:
        tools = _seed_tools()
        try:
            metrics = compute_plan_016_metrics(base_dir=tools)
            self.assertEqual(set(metrics.keys()), set(PLAN_016_METRIC_NAMES))
            for name in PLAN_016_METRIC_NAMES:
                self.assertEqual(metrics[name], 0, f"{name} should start at 0")
        finally:
            import shutil
            shutil.rmtree(tools.parent, ignore_errors=True)


class CounterIncrementTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_request_total_increments_with_create(self) -> None:
        # Plan 024 §B-2 — metrics test only counts request rows; matrix
        # specifics are not the test's focus, so escape-hatch is fine.
        for i in range(3):
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt=f"prompt {i}",
                legacy_strict_fields_optional=True,
                base_dir=self.tools,
            )
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_agent_request_total"], 3)
        # No claims yet -> active 0.
        self.assertEqual(metrics["aria_agent_claim_active"], 0)

    def test_claim_active_reflects_currently_held_leases(self) -> None:
        # Plan 024 §B-2 — claim_active flow goes through claim_request →
        # _strict_request_view, so the request needs real strict fields
        # to avoid request_state_legacy_unmigrated rejection.
        req = create_agent_invocation_request(
            target_agent="aria-primary-planner",
            role="primary_plan",
            suggested_prompt="claim test",
            must_satisfy=[{"id": "claim-test", "criterion": "claim is active"}],
            allowed_scope=["aria-kernel/**"],
            base_dir=self.tools,
        )
        claim = claim_request(request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools)
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_agent_claim_active"], 1)
        # Releasing the claim returns request to REQUEUED, no longer active.
        # Plan 026R §B.1 — release_claim now requires lease_token.
        release_claim(
            claim_id=claim["claim_id"],
            agent_id="worker-1",
            lease_token=claim["lease_token"],
            reason="testing",
            base_dir=self.tools,
        )
        metrics_after = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics_after["aria_agent_claim_active"], 0)

    def test_self_approval_rejected_counter_pulls_from_governance(self) -> None:
        # Synthesize a governance event the kernel would emit on self-approval.
        append_tools_governance(
            self.tools, "self_approval_rejected",
            {"claim_id": "c1", "request_id": "r1", "agent_id": "a1"},
        )
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_self_approval_rejected_total"], 1)

    def test_pr_created_total_pulls_from_governance(self) -> None:
        for _ in range(2):
            append_tools_governance(self.tools, "pr_created", {"plan_id": "p1"})
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_pr_created_total"], 2)


class ImpactUnknownCountSemanticsTests(unittest.TestCase):
    """Plan 019 Phase 7.5 — operator critique #5+#6 semantic fix.

    The pre-Phase-7.5 implementation walked aria-tools/impact-graphs/*.json
    and SUMMED unknown entries across ALL graphs (double-counting old
    runs + breaking when the directory is gitignored). The corrected
    semantic reads the LATEST impact_graph_computed governance event's
    unknown_count field — governance.jsonl is the hash-chained SSoT for
    graph summaries, the local directory is a runtime artifact.
    """

    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_no_governance_events_means_zero_unknown(self) -> None:
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_impact_unknown_total"], 0)

    def test_latest_event_unknown_count_is_returned(self) -> None:
        # Three sequential impact_graph_computed events with descending
        # unknown counts (5 -> 3 -> 0). The metric should return the
        # LATEST (0), not the sum (8) and not the first (5).
        for unknown in (5, 3, 0):
            append_tools_governance(
                self.tools, "impact_graph_computed",
                {
                    "fingerprint": f"fp-{unknown}",
                    "entry_count": 10,
                    "unknown_count": unknown,
                    "known_count": 10 - unknown,
                    "explicitly_blocked_count": 0,
                    "source_breakdown": {"event_contract": 10},
                    "max_depth_reached": 1,
                    "intended_files": [f"libs/event-contracts/src/file{unknown}.ts"],
                    "path": f"impact-graphs/fp-{unknown}.json",
                },
            )
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_impact_unknown_total"], 0,
                         "metric must reflect the LATEST event, not the sum")

    def test_directory_artifacts_no_longer_consulted(self) -> None:
        # Plan 019 Phase 7.5: after the semantic fix, even if a stale
        # impact-graphs/<fp>.json file exists with status=unknown
        # entries, the metric returns 0 because the governance event
        # is the SSoT and no event has been emitted yet.
        impact_dir = self.tools / "impact-graphs"
        impact_dir.mkdir(parents=True, exist_ok=True)
        (impact_dir / "stale.json").write_text(json.dumps({
            "entries": [
                {"status": "unknown", "source": "graphql_api", "path": "x.graphql"},
                {"status": "unknown", "source": "db_entity", "path": "y.entity.ts"},
            ],
        }), encoding="utf-8")
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_impact_unknown_total"], 0)

    def test_other_event_kinds_ignored(self) -> None:
        # The metric must filter on kind == 'impact_graph_computed' and
        # not pick up unknown_count fields from unrelated events.
        append_tools_governance(self.tools, "debt_emitted", {"unknown_count": 99})
        append_tools_governance(self.tools, "review_recorded", {"unknown_count": 99})
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_impact_unknown_total"], 0)


class DashboardWriterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_render_dashboard_includes_all_six_sections(self) -> None:
        text = render_dashboard_markdown(base_dir=self.tools, repo_root=self.repo)
        for section in (
            "## Active Plans",
            "## Unresolved Risks",
            "## Pending Agent Requests",
            "## Failed Satisfaction Items",
            "## Impact Coverage",
            "## PR Readiness",
        ):
            self.assertIn(section, text, f"missing section {section}")

    def test_write_dashboard_creates_default_path(self) -> None:
        target = write_dashboard(base_dir=self.tools, repo_root=self.repo)
        self.assertTrue(target.exists())
        self.assertEqual(
            target.relative_to(self.tools).as_posix(), "reports/dashboard.md"
        )

    def test_write_dashboard_honors_out_arg(self) -> None:
        custom = self.tools / "custom" / "dash.md"
        target = write_dashboard(
            base_dir=self.tools, repo_root=self.repo, out_path=custom
        )
        self.assertEqual(target, custom)
        self.assertTrue(custom.exists())


if __name__ == "__main__":
    unittest.main()
