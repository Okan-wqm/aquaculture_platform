from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.genesis_policy import (
    DEFAULT_FILENAME,
    OVERRIDE_RELPATH,
    POLICY_KEYS,
    default_policy,
    load_policy,
    merge_with_override,
)


class GenesisPolicyTests(unittest.TestCase):
    def test_default_policy_returns_all_known_keys(self):
        policy = default_policy()
        self.assertIn("enable_request_generation", policy)
        self.assertEqual(policy["enable_request_generation"], True)
        self.assertEqual(policy["max_requests_per_cycle"], 5)
        self.assertEqual(policy["materialization_requires_acknowledge"], True)
        self.assertEqual(policy["fitness_staleness_threshold_days"], 7)

    def test_load_policy_returns_defaults_when_override_missing(self):
        with tempfile.TemporaryDirectory() as tmp:
            policy = load_policy(tmp)
            self.assertEqual(policy["enable_request_generation"], True)
            self.assertEqual(policy["max_requests_per_cycle"], 5)

    def test_load_policy_merges_override_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            override_path = Path(tmp) / OVERRIDE_RELPATH
            override_path.parent.mkdir(parents=True)
            override_path.write_text(
                json.dumps({"enable_request_generation": False, "max_requests_per_cycle": 1}),
                encoding="utf-8",
            )
            policy = load_policy(tmp)
            self.assertEqual(policy["enable_request_generation"], False)
            self.assertEqual(policy["max_requests_per_cycle"], 1)
            # Unmodified keys keep defaults.
            self.assertEqual(policy["materialization_requires_acknowledge"], True)
            self.assertEqual(policy["fitness_staleness_threshold_days"], 7)

    def test_load_policy_ignores_unknown_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            override_path = Path(tmp) / OVERRIDE_RELPATH
            override_path.parent.mkdir(parents=True)
            override_path.write_text(
                json.dumps({"unknown_field": 42, "enable_request_generation": False}),
                encoding="utf-8",
            )
            policy = load_policy(tmp)
            self.assertNotIn("unknown_field", policy)
            self.assertEqual(policy["enable_request_generation"], False)

    def test_load_policy_recovers_from_malformed_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            override_path = Path(tmp) / OVERRIDE_RELPATH
            override_path.parent.mkdir(parents=True)
            override_path.write_text("{ malformed", encoding="utf-8")
            policy = load_policy(tmp)
            self.assertEqual(policy, default_policy())

    def test_load_policy_recovers_from_non_object_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            override_path = Path(tmp) / OVERRIDE_RELPATH
            override_path.parent.mkdir(parents=True)
            override_path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
            policy = load_policy(tmp)
            self.assertEqual(policy, default_policy())

    def test_merge_with_override_filters_to_known_keys(self):
        defaults = default_policy()
        override = {"enable_request_generation": False, "_garbage": 1}
        merged = merge_with_override(defaults, override)
        self.assertEqual(merged["enable_request_generation"], False)
        self.assertNotIn("_garbage", merged)

    def test_policy_keys_contract(self):
        # Locked contract — adding/removing a known key requires
        # explicit code review. Plan ARIA-V3 §B0 + §B2 extended the
        # contract with `cost_caps_usd` (cost circuit breaker, B0)
        # and `circuit_breaker` (failure breaker, B2 — primitive
        # added now so override-merge stays forward-compatible).
        self.assertEqual(
            POLICY_KEYS,
            {
                "schema_version",
                "enable_request_generation",
                "max_requests_per_cycle",
                "materialization_requires_acknowledge",
                "fitness_staleness_threshold_days",
                "cost_caps_usd",
                "circuit_breaker",
            },
        )


if __name__ == "__main__":
    unittest.main()
