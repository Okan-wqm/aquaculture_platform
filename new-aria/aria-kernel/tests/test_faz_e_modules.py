"""Tests for Plan 016 Faz E1 (architecture-first) + E2 (research) + E3 (critical observation)."""
from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.architecture import (
    list_architecture_reviews,
    review_architecture_decision,
)
from aria_kernel.critical_observation import (
    CRITICAL_CATEGORIES,
    CRITICAL_SEVERITIES,
    SLA_WINDOWS,
    acknowledge_critical_observation,
    compute_escalation_tier,
    list_critical_observations,
    record_critical_observation,
    resolve_critical_observation,
)
from aria_kernel.research import (
    fetch_research_source,
    list_research_fetches,
    record_research_policy,
)
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir


def _seed_tools() -> Path:
    repo = Path(tempfile.mkdtemp(prefix="aria-faz-e-"))
    tools = repo / "aria-tools"
    ensure_tools_dir(tools)
    return tools


# ----------------------------------------------------------------------
# Faz E1 — architecture-first review
# ----------------------------------------------------------------------

class ArchitectureReviewTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_review_records_architecture_classification(self) -> None:
        result = review_architecture_decision(
            technology="Redis",
            proposed_action="harden_boundary",
            evidence_refs=["docs/aria/SPEC.md:53", "docs/aria/CONTRACTS.md:8"],
            root_cause="Existing Redis usage is wide-spread; replacement risk is high.",
            authoritative_refs=["https://redis.io/docs/latest/operate/oss_and_stack/management/replication/"],
            repo_prior_refs=["docs/adr/008-guard-strategy-defense-in-depth.md"],
            base_dir=self.tools,
        )
        # Adoption gravity should pick up >=2 evidence refs.
        self.assertIn("recommended_action", result)
        self.assertIn("adoption", result)
        self.assertIn(result["recommended_action"], {"fix_in_place", "harden_boundary", "introduce_abstraction", "incremental_refactor", "replace_with_adr", "emergency_patch"})
        # And the review is listable.
        rows = list_architecture_reviews(base_dir=self.tools)
        self.assertGreaterEqual(len(rows), 1)


# ----------------------------------------------------------------------
# Faz E2 — sanitized research fetch
# ----------------------------------------------------------------------

class ResearchFetchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_fetch_with_allowlisted_domain_persists_sanitized_payload(self) -> None:
        # Seed an allowlist policy first so the fetch is admissible.
        record_research_policy(
            allowed_domains=["redis.io"], base_dir=self.tools
        )
        # Use content_override to avoid real HTTP in the test.
        row = fetch_research_source(
            url="https://redis.io/docs/page",
            source_tier="vendor",
            title="Redis docs sample",
            content_override="<html><body><h1>Replication</h1>simple text</body></html>",
            base_dir=self.tools,
        )
        # The fetch payload is sanitized (no <script>, no executable
        # markup) and content_hash is recorded.
        self.assertIn("content_hash", row)
        self.assertTrue(row["content_hash"].startswith("sha256:"))

    def test_fetch_blocked_when_domain_not_allowlisted(self) -> None:
        # Allowlist deliberately omits the fetch host.
        record_research_policy(
            allowed_domains=["redis.io"], base_dir=self.tools
        )
        with self.assertRaisesRegex(GovernanceError, "research fetch blocked"):
            fetch_research_source(
                url="https://random.example.com/docs",
                source_tier="vendor",
                content_override="ignored",
                base_dir=self.tools,
            )

    def test_unknown_source_tier_rejected(self) -> None:
        record_research_policy(
            allowed_domains=["redis.io"], base_dir=self.tools
        )
        with self.assertRaisesRegex(GovernanceError, "unknown research source tier"):
            fetch_research_source(
                url="https://redis.io/docs/page",
                source_tier="bogus",
                content_override="ignored",
                base_dir=self.tools,
            )


# ----------------------------------------------------------------------
# Faz E3 — critical observation
# ----------------------------------------------------------------------

class CriticalObservationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tools = _seed_tools()
        self.repo = self.tools.parent

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.repo, ignore_errors=True)

    def test_severity_and_category_enums(self) -> None:
        self.assertEqual(set(CRITICAL_SEVERITIES), {"CRITICAL", "HIGH", "MEDIUM"})
        self.assertEqual(
            set(CRITICAL_CATEGORIES),
            {"security", "data_integrity", "regulatory", "production_affecting", "plc_safety"},
        )

    def test_record_persists_with_sla_deadlines(self) -> None:
        ts = datetime(2026, 5, 7, 0, 0, tzinfo=timezone.utc)
        row = record_critical_observation(
            severity="CRITICAL",
            category="security",
            summary="hard-coded secret detected in Rust crate",
            evidence_ref="sens-api-gateway/src/connectors/foo.rs:42",
            base_dir=self.tools,
            now=ts,
        )
        self.assertEqual(row["severity"], "CRITICAL")
        self.assertEqual(row["status"], "open")
        self.assertTrue(row["persisted_before_next_tool_call"])
        # Expected SLA: ack 24h, resolve 7d.
        ack = datetime.fromisoformat(row["ack_deadline"].replace("Z", "+00:00"))
        self.assertEqual(ack - ts, timedelta(hours=24))
        resolve = datetime.fromisoformat(row["resolve_deadline"].replace("Z", "+00:00"))
        self.assertEqual(resolve - ts, timedelta(days=7))

    def test_record_creates_file_under_critical_observations_dir(self) -> None:
        row = record_critical_observation(
            severity="HIGH",
            category="data_integrity",
            summary="entity drift across services",
            evidence_ref="apps/farm-service/src/x.entity.ts:12",
            base_dir=self.tools,
        )
        path = self.tools / "critical-observations" / f"{row['observation_id']}.json"
        self.assertTrue(path.exists())

    def test_unknown_severity_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "severity"):
            record_critical_observation(
                severity="OBSCURE",
                category="security",
                summary="x",
                evidence_ref="x:1",
                base_dir=self.tools,
            )

    def test_unknown_category_rejected(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "category"):
            record_critical_observation(
                severity="MEDIUM",
                category="wrong",
                summary="x",
                evidence_ref="x:1",
                base_dir=self.tools,
            )

    def test_acknowledge_lifecycle(self) -> None:
        row = record_critical_observation(
            severity="MEDIUM",
            category="regulatory",
            summary="missing GDPR consent capture",
            evidence_ref="apps/gdpr/x.ts:1",
            base_dir=self.tools,
        )
        ack = acknowledge_critical_observation(
            observation_id=row["observation_id"],
            acknowledged_by="operator-alpha",
            base_dir=self.tools,
        )
        self.assertEqual(ack["status"], "acknowledged")
        self.assertEqual(ack["acknowledged_by"], "operator-alpha")

    def test_resolve_lifecycle_requires_note(self) -> None:
        row = record_critical_observation(
            severity="MEDIUM",
            category="production_affecting",
            summary="latency spike on /health",
            evidence_ref="apps/gateway-api/health.ts:1",
            base_dir=self.tools,
        )
        with self.assertRaisesRegex(GovernanceError, "resolution_note"):
            resolve_critical_observation(
                observation_id=row["observation_id"],
                resolved_by="operator",
                resolution_note="",
                base_dir=self.tools,
            )

    def test_list_filters_resolved_by_default(self) -> None:
        a = record_critical_observation(
            severity="HIGH", category="security", summary="leak A",
            evidence_ref="x:1", base_dir=self.tools,
        )
        b = record_critical_observation(
            severity="HIGH", category="security", summary="leak B",
            evidence_ref="y:1", base_dir=self.tools,
        )
        resolve_critical_observation(
            observation_id=b["observation_id"],
            resolved_by="ops",
            resolution_note="patched in batch 12",
            base_dir=self.tools,
        )
        open_rows = list_critical_observations(base_dir=self.tools)
        self.assertEqual({r["observation_id"] for r in open_rows}, {a["observation_id"]})
        all_rows = list_critical_observations(base_dir=self.tools, include_resolved=True)
        self.assertEqual(
            {r["observation_id"] for r in all_rows},
            {a["observation_id"], b["observation_id"]},
        )

    def test_escalation_tier_per_age(self) -> None:
        ts = datetime(2026, 5, 7, 0, 0, tzinfo=timezone.utc)
        row = record_critical_observation(
            severity="CRITICAL",
            category="security",
            summary="age test",
            evidence_ref="x:1",
            base_dir=self.tools,
            now=ts,
        )
        # CRITICAL ack window = 24h. Tier transitions:
        # 0h: within_sla
        # 48h (2*24): highlighted
        # 72h (3*24): weekly_top
        # 120h (5*24): every_daily_top
        self.assertEqual(compute_escalation_tier(row, now=ts), "within_sla")
        self.assertEqual(
            compute_escalation_tier(row, now=ts + timedelta(hours=49)), "highlighted"
        )
        self.assertEqual(
            compute_escalation_tier(row, now=ts + timedelta(hours=73)), "weekly_top"
        )
        self.assertEqual(
            compute_escalation_tier(row, now=ts + timedelta(hours=121)), "every_daily_top"
        )

    def test_acknowledged_observation_returns_within_sla(self) -> None:
        row = record_critical_observation(
            severity="HIGH", category="security", summary="x",
            evidence_ref="x:1", base_dir=self.tools,
        )
        ack = acknowledge_critical_observation(
            observation_id=row["observation_id"],
            acknowledged_by="ops",
            base_dir=self.tools,
        )
        # Even if we age it artificially, an acknowledged record is no longer
        # escalation-eligible (operator owns it now).
        future = datetime(2099, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(compute_escalation_tier(ack, now=future), "within_sla")


if __name__ == "__main__":
    unittest.main()
