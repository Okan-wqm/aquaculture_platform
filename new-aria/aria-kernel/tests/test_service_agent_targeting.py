"""E15-c — service-specific auditor targeting tests.

The trigger is deterministic: open tool-finding count per service
(E15-a dimension) crossing the ``service_auditor_threshold`` policy
value mints exactly one agent-genesis request via the SAME writer the
learning router uses. Deliberate-break coverage: each suppression
(existing agent file, already-minted request) is proven by showing the
re-mint that would otherwise happen does NOT happen, and the learning
wiring is proven record-and-continue by making the producer raise and
watching the night survive.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.feedback_store import record_findings_for_run
from aria_kernel.genesis_policy import OVERRIDE_RELPATH
from aria_kernel.ledger import load_jsonl
from aria_kernel.service_agent_targeting import (
    propose_service_auditor_requests,
    service_auditor_agent_name,
)
from aria_kernel.tool_registry import ensure_tools_dir


class ServiceAuditorAgentNameTests(unittest.TestCase):
    def test_apps_service_maps_to_plain_slug(self) -> None:
        self.assertEqual(
            service_auditor_agent_name("farm-service"),
            "aria-svc-farm-service-auditor",
        )

    def test_namespace_colon_collapses_to_filename_safe_hyphen(self) -> None:
        # shared:/web: dimensions must still land on a legal
        # .claude/agents/<name>.md filename.
        self.assertEqual(
            service_auditor_agent_name("shared:backend-common"),
            "aria-svc-shared-backend-common-auditor",
        )
        self.assertEqual(
            service_auditor_agent_name("web:farm-module"),
            "aria-svc-web-farm-module-auditor",
        )


class ServiceAuditorTargetingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.tools_dir = ensure_tools_dir(root / "aria-tools")
        self.repo = root / "repo"
        self.repo.mkdir()

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _seed_findings(
        self,
        count: int,
        *,
        service_dir: str = "farm-service",
        rule: str = "missing-tenant-guard",
        prefix: str = "f",
    ) -> None:
        # Seed through the REAL mint path (record_findings_for_run) so the
        # rows carry the E15-a mint-time dimension the trigger groups on.
        for index in range(count):
            record_findings_for_run(
                {
                    "tool_id": "tenant-scoping-adapter",
                    "run_id": f"run-{prefix}-{index}",
                    "emitted_findings": [
                        {
                            "id": f"{prefix}-{index}",
                            "rule": rule,
                            "path": f"apps/{service_dir}/src/mod{index}.ts",
                            "message": f"finding {prefix}-{index}",
                        }
                    ],
                },
                base_dir=self.tools_dir,
            )

    def _requests(self) -> list[dict]:
        return load_jsonl(self.tools_dir / "agent-genesis" / "requests.jsonl")

    def _propose(self, **kwargs) -> dict:
        return propose_service_auditor_requests(
            cycle_id=kwargs.pop("cycle_id", "cyc-e15c"),
            base_dir=self.tools_dir,
            repo_root=self.repo,
            **kwargs,
        )

    def test_threshold_crossing_mints_exactly_one_request(self) -> None:
        self._seed_findings(3)
        result = self._propose(threshold=3)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["requested_count"], 1)
        self.assertEqual(result["service_counts"], {"farm-service": 3})
        rows = self._requests()
        self.assertEqual(len(rows), 1)
        row = rows[0]
        self.assertEqual(row["status"], "requested")
        self.assertEqual(row["capability_gap_key"], "service-auditor:farm-service")
        self.assertIn("aria-svc-farm-service-auditor", row["title"])
        self.assertIn("farm-service", row["title"])
        self.assertIn("missing-tenant-guard", row["title"])
        self.assertTrue(row["evidence_refs"])
        governance = load_jsonl(self.tools_dir / "governance.jsonl")
        emitted = [g for g in governance if g.get("kind") == "service_auditor_request_emitted"]
        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["details"]["target_agent"], "aria-svc-farm-service-auditor")
        self.assertEqual(emitted[0]["details"]["service"], "farm-service")

    def test_below_threshold_mints_nothing(self) -> None:
        self._seed_findings(2)
        result = self._propose(threshold=3)
        self.assertEqual(result["requested_count"], 0)
        self.assertEqual(result["service_counts"], {"farm-service": 2})
        self.assertEqual(self._requests(), [])

    def test_default_policy_threshold_is_25(self) -> None:
        # 24 findings sit under the shipped default; the 25th crosses it.
        self._seed_findings(24)
        self.assertEqual(self._propose()["requested_count"], 0)
        self._seed_findings(1, prefix="extra")
        result = self._propose()
        self.assertEqual(result["threshold"], 25)
        self.assertEqual(result["requested_count"], 1)

    def test_existing_agent_file_suppresses(self) -> None:
        agents_dir = self.repo / ".claude" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "aria-svc-farm-service-auditor.md").write_text(
            "---\nname: aria-svc-farm-service-auditor\n---\n", encoding="utf-8"
        )
        self._seed_findings(3)
        result = self._propose(threshold=3)
        # Deliberate break: with the agent file on disk the mint that a
        # broken suppression would perform must NOT happen.
        self.assertEqual(result["requested_count"], 0)
        self.assertEqual(
            result["suppressed"],
            [{
                "service": "farm-service",
                "target_agent": "aria-svc-farm-service-auditor",
                "reason": "existing_agent",
            }],
        )
        self.assertEqual(self._requests(), [])

    def test_existing_pending_request_suppresses_re_mint(self) -> None:
        self._seed_findings(3)
        first = self._propose(threshold=3, cycle_id="cyc-night-1")
        self.assertEqual(first["requested_count"], 1)
        # Deliberate break: the second night still crosses the threshold;
        # only the pending-request suppression stands between it and a
        # duplicate row.
        second = self._propose(threshold=3, cycle_id="cyc-night-2")
        self.assertEqual(second["requested_count"], 0)
        self.assertEqual(second["suppressed"][0]["reason"], "pending_request")
        self.assertEqual(len(self._requests()), 1)

    def test_policy_override_changes_the_threshold(self) -> None:
        override = self.repo / OVERRIDE_RELPATH
        override.parent.mkdir(parents=True)
        override.write_text(
            json.dumps({"service_auditor_threshold": 2}), encoding="utf-8"
        )
        self._seed_findings(2)
        result = self._propose()
        self.assertEqual(result["threshold"], 2)
        self.assertEqual(result["requested_count"], 1)
        self.assertEqual(
            self._requests()[0]["capability_gap_key"],
            "service-auditor:farm-service",
        )

    def test_disabled_genesis_policy_skips_the_producer(self) -> None:
        override = self.repo / OVERRIDE_RELPATH
        override.parent.mkdir(parents=True)
        override.write_text(
            json.dumps({"enable_request_generation": False}), encoding="utf-8"
        )
        self._seed_findings(3)
        result = self._propose(threshold=3)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "genesis_disabled")
        self.assertEqual(self._requests(), [])

    def test_max_requests_per_cycle_caps_the_lane(self) -> None:
        override = self.repo / OVERRIDE_RELPATH
        override.parent.mkdir(parents=True)
        override.write_text(
            json.dumps({"max_requests_per_cycle": 1}), encoding="utf-8"
        )
        self._seed_findings(3, service_dir="farm-service", prefix="farm")
        self._seed_findings(5, service_dir="auth-service", rule="weak-jwt", prefix="auth")
        result = self._propose(threshold=3)
        # Deliberate break: both services cross the threshold, so a
        # producer that ignored the operator's genesis ceiling would mint
        # two rows and make max_requests_per_cycle a lie.
        self.assertEqual(result["eligible_count"], 2)
        self.assertEqual(result["requested_count"], 1)
        self.assertEqual(result["capped_count"], 1)
        # Sickest service first: auth-service carries 5 open findings.
        self.assertEqual(
            [row["capability_gap_key"] for row in self._requests()],
            ["service-auditor:auth-service"],
        )

    def test_each_qualifying_service_gets_its_own_request(self) -> None:
        self._seed_findings(3, service_dir="farm-service", prefix="farm")
        self._seed_findings(3, service_dir="auth-service", rule="weak-jwt", prefix="auth")
        self._seed_findings(1, service_dir="hr-service", prefix="hr")
        result = self._propose(threshold=3)
        self.assertEqual(result["requested_count"], 2)
        keys = sorted(row["capability_gap_key"] for row in self._requests())
        self.assertEqual(
            keys,
            ["service-auditor:auth-service", "service-auditor:farm-service"],
        )


class LearningWiringTests(unittest.TestCase):
    """The producer runs in the genesis phase family with
    record-and-continue semantics."""

    def setUp(self) -> None:
        from aria_kernel.tool_registry import ensure_tools_binding
        from aria_kernel.workspace import ensure_workspace, workspace_paths

        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.repo = root / "repo"
        self.repo.mkdir()
        self.paths = workspace_paths(self.repo, root / "workspaces")
        ensure_workspace(self.paths)
        self.tools_dir = ensure_tools_binding(
            root / "aria-tools", workspace_root=self.repo
        )

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_hook_runs_after_skill_or_agent_genesis(self) -> None:
        from aria_kernel.learning import LEARNING_HOOK_ORDER

        order = list(LEARNING_HOOK_ORDER)
        self.assertIn("service_auditor_targeting", order)
        self.assertEqual(
            order.index("service_auditor_targeting"),
            order.index("skill_or_agent_genesis") + 1,
        )

    def test_producer_failure_never_costs_the_night(self) -> None:
        from aria_kernel.learning import run_learning_pass

        # Deliberate break: the producer raises; the hook loop must record
        # the failure and still run the hooks after it.
        with patch(
            "aria_kernel.learning.propose_service_auditor_requests",
            side_effect=RuntimeError("targeting exploded"),
        ):
            result = run_learning_pass(
                self.paths, cycle_id="cyc-wire", tools_root=self.tools_dir
            )
        by_name = {row["hook_name"]: row for row in result["hooks"]}
        self.assertEqual(by_name["service_auditor_targeting"]["status"], "failed")
        self.assertEqual(by_name["agent_fitness_score"]["status"], "ok")

    def test_producer_runs_clean_on_an_empty_night(self) -> None:
        from aria_kernel.learning import run_learning_pass

        result = run_learning_pass(
            self.paths, cycle_id="cyc-empty", tools_root=self.tools_dir
        )
        by_name = {row["hook_name"]: row for row in result["hooks"]}
        self.assertEqual(by_name["service_auditor_targeting"]["status"], "ok")
        self.assertEqual(
            by_name["service_auditor_targeting"]["result"]["requested_count"], 0
        )


if __name__ == "__main__":
    unittest.main()
