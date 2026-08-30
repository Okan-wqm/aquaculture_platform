"""Scope discipline — the three contracts that keep agents on-task.

Operator requirements 2026-08-29:
1. Declared route before the work (deviation is detectable)
2. Out-of-scope sightings captured for a separate plan, never lost
3. Network containment pinned explicitly, never trusted to defaults
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_PARENT = Path(__file__).resolve().parents[1]
if str(_PARENT) not in sys.path:
    sys.path.insert(0, str(_PARENT))

from aria_kernel.scope_discipline import (  # noqa: E402
    capture_out_of_scope_observation,
    codex_network_off_config,
    extract_out_of_scope_observations,
    require_declared_route,
    route_covers_evidence,
)


class DeclaredRoute(unittest.TestCase):
    def test_missing_route_is_rejected(self) -> None:
        violation = require_declared_route({})
        self.assertIsNotNone(violation)
        self.assertEqual(violation["code"], "declared_route_missing")

    def test_thin_route_is_rejected(self) -> None:
        violation = require_declared_route({"declared_route": "fix it"})
        self.assertIsNotNone(violation)
        self.assertEqual(violation["code"], "declared_route_too_thin")

    def test_real_route_passes(self) -> None:
        violation = require_declared_route({
            "declared_route": "fix the auth resolver's token validation in the resolver file",
        })
        self.assertIsNone(violation)

    def test_route_covers_matching_evidence(self) -> None:
        route = "fix the authentication resolver token validation path"
        self.assertTrue(route_covers_evidence(route, "apps/auth-service/src/resolvers/auth.resolver.ts:141"))

    def test_route_does_not_cover_foreign_evidence(self) -> None:
        route = "fix the authentication resolver token validation"
        self.assertFalse(route_covers_evidence(route, "apps/farm-service/src/database/migrations/001_add_tenant.py"))


class OutOfScopeCapture(unittest.TestCase):
    def test_rejection_becomes_observation_with_route(self) -> None:
        response = {
            "agent_id": "ci-executor:test",
            "declared_route": "fix the auth resolver's token validation",
            "out_of_scope_routes": {
                "apps/farm-service/src/database/migrations/001_add_tenant.py":
                    "the migration lacks a tenant index; add it in a separate migration",
            },
        }
        obs = capture_out_of_scope_observation(
            ref="apps/farm-service/src/database/migrations/001_add_tenant.py",
            reason="outside allowed_scope",
            response=response,
        )
        self.assertEqual(obs["kind"], "out_of_scope_observation")
        self.assertIn("tenant index", obs["recommended_route"])
        self.assertIn("auth resolver", obs["declared_route"])
        self.assertIn("never acted on", obs["note"])

    def test_extract_from_rejection_list(self) -> None:
        errors = [
            {"code": "agent_evidence_outside_allowed_scope", "path": "other/file.py", "reason": "scope"},
            {"code": "agent_evidence_not_repo_verified", "ref": "x.py", "reason": "trust"},
        ]
        obs = extract_out_of_scope_observations(rejected_errors=errors, response={"agent_id": "a"})
        # Only the scope rejection becomes an observation; the trust
        # rejection is a quality problem, not a sighting.
        self.assertEqual(len(obs), 1)
        self.assertEqual(obs[0]["ref"], "other/file.py")


class NetworkContainment(unittest.TestCase):
    def test_config_pins_network_off_in_both_modes(self) -> None:
        config = codex_network_off_config()
        self.assertIn("sandbox_workspace_write.network_access=false", config)
        self.assertIn("sandbox_read_only.network_access=false", config)

    def test_config_is_dash_c_pairs(self) -> None:
        config = codex_network_off_config()
        for i, item in enumerate(config):
            if i % 2 == 0:
                self.assertEqual(item, "-c")


if __name__ == "__main__":
    unittest.main()
