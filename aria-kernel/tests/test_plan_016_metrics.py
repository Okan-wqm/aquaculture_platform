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
    def test_metric_set_has_nine_named_counters(self) -> None:
        self.assertEqual(len(PLAN_016_METRIC_NAMES), 9)

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
        for i in range(3):
            create_agent_invocation_request(
                target_agent="aria-evidence-judge",
                role="evidence_judgment",
                suggested_prompt=f"prompt {i}",
                base_dir=self.tools,
            )
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_agent_request_total"], 3)
        # No claims yet -> active 0.
        self.assertEqual(metrics["aria_agent_claim_active"], 0)

    def test_claim_active_reflects_currently_held_leases(self) -> None:
        req = create_agent_invocation_request(
            target_agent="aria-primary-planner",
            role="primary_plan",
            suggested_prompt="claim test",
            base_dir=self.tools,
        )
        claim_request(request_id=req["request_id"], agent_id="worker-1", base_dir=self.tools)
        metrics = compute_plan_016_metrics(base_dir=self.tools)
        self.assertEqual(metrics["aria_agent_claim_active"], 1)
        # Releasing the claim returns request to REQUEUED, no longer active.
        from aria_kernel.ledger import load_jsonl
        claims = load_jsonl(self.tools / "agent-invocations" / "claims.jsonl")
        cid = claims[0]["claim_id"]
        release_claim(claim_id=cid, agent_id="worker-1", reason="testing", base_dir=self.tools)
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
