from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel import (
    generate_architecture_options,
    list_architecture_reviews,
    review_architecture_decision,
    verify_integrity,
)
from aria_kernel.tool_registry import GovernanceError


class ArchitectureFirstIntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.tools_dir = Path(self.tmp.name) / "aria-tools"

    def tearDown(self):
        self.tmp.cleanup()

    def test_high_adoption_redis_replacement_is_blocked_without_hard_evidence(self):
        review = review_architecture_decision(
            technology="Redis",
            proposed_action="replace_with_adr",
            evidence_refs=[
                "apps/ai-service/src/cost/rate-limit.service.ts",
                "apps/ai-service/src/cost/token-budget.service.ts",
                "apps/config-service/src/configuration/services/configuration.service.ts",
                "apps/gateway-api/src/app.module.ts",
                "apps/auth-service/src/app.module.ts",
                "apps/billing-service/src/app.module.ts",
                "libs/backend-common/src/redis/redis.service.ts",
                "libs/backend-common/src/redis/redis.module.ts",
                "libs/backend-common/src/redis/tenant-redis.service.ts",
                "docker-compose.yml",
            ],
            root_cause="Distributed cache and rate-limit semantics are inconsistently owned.",
            authoritative_refs=["https://redis.io/docs/latest/develop/use/patterns/"],
            repo_prior_refs=["docs/adr/011-schema-per-tenant.md"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(review["adoption"]["level"], "high")
        self.assertEqual(review["recommended_action"], "introduce_abstraction")
        self.assertEqual(review["status"], "blocked")
        self.assertIn("adoption_aware_replacement_blocked", review["blocked_by"])
        self.assertIn("replacement_requires_hard_evidence", review["blocked_by"])

    def test_high_adoption_redis_hardening_requires_boundary_and_can_pass(self):
        review = review_architecture_decision(
            technology="Redis",
            proposed_action="introduce_abstraction",
            evidence_refs=[
                "apps/ai-service/src/cost/rate-limit.service.ts",
                "apps/ai-service/src/cost/token-budget.service.ts",
                "apps/config-service/src/configuration/services/configuration.service.ts",
                "libs/backend-common/src/redis/redis.service.ts",
                "libs/backend-common/src/redis/tenant-redis.service.ts",
            ],
            root_cause="Callers use Redis directly for different fail modes and tenant key policies.",
            authoritative_refs=["https://redis.io/docs/latest/develop/use/patterns/"],
            repo_prior_refs=["docs/aria/SPEC.md"],
            abstraction_boundary="Create repo-owned cache/rate-limit contracts with tenant key namespace, TTL, timeout, fail mode, and metrics policy.",
            validation_commands=["PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(review["status"], "ready_for_architecture_review")
        self.assertEqual(review["recommended_action"], "introduce_abstraction")
        self.assertEqual(review["blocked_by"], [])

    def test_repeated_pattern_fix_in_place_is_blocked_as_architecture_incomplete(self):
        review = review_architecture_decision(
            technology="Redis",
            proposed_action="fix_in_place",
            evidence_refs=[
                "apps/ai-service/src/cost/rate-limit.service.ts",
                "apps/ai-service/src/cost/token-budget.service.ts",
                "apps/config-service/src/configuration/services/configuration.service.ts",
            ],
            root_cause="Repeated Redis key policy drift appears across services.",
            authoritative_refs=["https://redis.io/docs/latest/develop/use/patterns/"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(review["status"], "blocked")
        self.assertIn("architecture_incomplete", review["blocked_by"])

    def test_low_adoption_replacement_with_hard_evidence_and_rollback_can_pass(self):
        review = review_architecture_decision(
            technology="abandoned-cache-package",
            proposed_action="replace_with_adr",
            evidence_refs=["libs/legacy-cache/src/index.ts"],
            root_cause="Package is unsupported and blocks security fixes.",
            authoritative_refs=["https://github.com/vendor/package/security/advisories/GHSA-test"],
            replacement_grounds=["eol_or_unsupported"],
            migration_plan="Replace the single wrapper implementation while keeping its public interface stable.",
            rollback_plan="Revert the wrapper implementation commit.",
            validation_commands=["PYTHONPATH=aria-kernel python3 -m unittest discover aria-kernel -p '*test*.py'"],
            base_dir=self.tools_dir,
        )
        self.assertEqual(review["adoption"]["level"], "low")
        self.assertEqual(review["status"], "ready_for_architecture_review")
        self.assertEqual(review["recommended_action"], "replace_with_adr")

    def test_architecture_options_never_include_patch_as_a_normal_option(self):
        options = generate_architecture_options(
            technology="Redis",
            evidence_refs=[
                "apps/ai-service/src/cost/rate-limit.service.ts",
                "apps/config-service/src/configuration/services/configuration.service.ts",
                "libs/backend-common/src/redis/redis.service.ts",
            ],
            root_cause="Redis usage needs shared ownership.",
            authoritative_refs=["https://redis.io/docs/latest/develop/use/patterns/"],
            base_dir=self.tools_dir,
        )
        actions = [option["action"] for option in options["options"]]
        self.assertNotIn("fix_in_place", actions)
        self.assertNotIn("emergency_patch", actions)
        self.assertEqual(options["recommended_action"], "harden_boundary")

    def test_unknown_replacement_ground_is_rejected(self):
        with self.assertRaises(GovernanceError):
            review_architecture_decision(
                technology="Redis",
                proposed_action="replace_with_adr",
                evidence_refs=["libs/backend-common/src/redis/redis.service.ts"],
                root_cause="Newer alternative exists.",
                replacement_grounds=["newer_technology_exists"],
                base_dir=self.tools_dir,
            )

    def test_reviews_are_hash_chained(self):
        review_architecture_decision(
            technology="Redis",
            proposed_action="harden_boundary",
            evidence_refs=["libs/backend-common/src/redis/redis.service.ts"],
            root_cause="Boundary needs explicit policy.",
            authoritative_refs=["https://redis.io/docs/latest/develop/use/patterns/"],
            abstraction_boundary="Centralize key policy and timeout behavior.",
            base_dir=self.tools_dir,
        )
        self.assertEqual(len(list_architecture_reviews(base_dir=self.tools_dir)), 1)
        self.assertTrue(verify_integrity(base_dir=self.tools_dir)["valid"])


if __name__ == "__main__":
    unittest.main()
