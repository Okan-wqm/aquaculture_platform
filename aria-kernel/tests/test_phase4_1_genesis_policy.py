from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.genesis_policy import (
    DEFAULT_FILENAME,
    OVERRIDE_RELPATH,
    POLICY_KEYS,
    SOURCE_QUALIFICATION_DEFAULTS,
    SOURCE_QUALIFICATION_MAX_DEADLINE_SECONDS,
    default_policy,
    genesis_lifecycle_policy,
    load_policy,
    merge_with_override,
    source_qualification_policy,
)
from aria_kernel.tool_registry import GovernanceError


class GenesisPolicyTests(unittest.TestCase):
    def test_default_policy_returns_all_known_keys(self):
        policy = default_policy()
        self.assertIn("enable_request_generation", policy)
        self.assertEqual(policy["enable_request_generation"], True)
        self.assertEqual(policy["max_requests_per_cycle"], 5)
        self.assertEqual(policy["materialization_requires_acknowledge"], True)
        self.assertEqual(policy["fitness_staleness_threshold_days"], 7)
        self.assertIn("genesis_lifecycle", policy)
        # E15-c — the default JSON must carry the key, else the targeting
        # trigger's policy read KeyErrors on a pristine deployment.
        self.assertEqual(policy["service_auditor_threshold"], 25)

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
        # explicit code review. Extended over the V3-V7 arc:
        #   * V3 §B0 — cost_caps_usd (cost circuit breaker)
        #   * V3 §B2 — circuit_breaker (failure breaker, primitive
        #     added so override-merge stays forward-compatible)
        #   * V6 §2d — convergent_authoring (loop config block:
        #     max_authoring_rounds + sandbox_min_fixtures + recall_floor)
        #   * V6 §2e — auto_promote (narrow auto-promotion exception
        #     under autonomous-profile-only safe conditions)
        #   * V7 §2h — skill_genesis_drainer (V7.4 drainer config:
        #     enabled + max_authorings_per_cycle + max_tokens_per_cycle +
        #     estimated_tokens_per_authoring). Closes V6 CONCERN #19.
        #   * Plan S4 (ORPHAN-MEDIUM-298) — drift_class_weights
        #     (operator targeting lever: per-class pressure score
        #     multipliers consumed by pressure.run_pressure).
        #   * E11/C8 (ORPHAN-HIGH-671) — superiority (Z3d promotion
        #     proof block; was readable by superiority_policy but
        #     silently dropped by merge_with_override — dead operator
        #     configuration until this key joined the contract).
        #   * E15-c — service_auditor_threshold (open-finding count at
        #     which one service earns an aria-svc-<service>-auditor
        #     genesis request; consumed by
        #     service_agent_targeting.propose_service_auditor_requests).
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
                # ORPHAN-MEDIUM-492 — agent_request_anchor.max_age_seconds:
                # how long a minted agent-invocation request stays claimable
                # before its target_sha stops describing the tree it would
                # run against. Policy rather than a constant because the
                # right window follows the cycle cadence.
                "agent_request_anchor",
                "convergent_authoring",
                "auto_promote",
                "skill_genesis_drainer",
                "genesis_lifecycle",
                "drift_class_weights",
                "superiority",
                "service_auditor_threshold",
                # Y2 (ORPHAN-704) — judgment_pipeline (sample size +
                # per-role pending ceiling consumed by
                # cycle._phase_judgment_pipeline via
                # judgment_pipeline_policy).
                "judgment_pipeline",
                # Y8 (ORPHAN-709) — genesis panel lane ceiling, consumed
                # by agent_genesis.sweep_candidate_gaps_for_adjudication.
                "genesis_panel",
                # E25-a (ORPHAN-710) — rhythm.backlog_cap, consumed by
                # cycle._backlog_below_cap via rhythm_policy.
                "rhythm",
                "executor",  # Plan 032 Faz 032h — drain concurrency block
                # E24-a (ORPHAN-711) — watchdog_pull: runtime telemetry
                # feed + detector thresholds, consumed by
                # aria_watchdog.run_watchdog_sweep.
                "watchdog_pull",
                # ARIA-MEDIUM-082 — source_qualification.deadline_seconds:
                # the scoped-source qualification allowance (twin projection,
                # per-mint twin re-observation, pinned excerpt reads),
                # consumed via source_qualification_policy. Was a literal
                # in snapshot._ScopedSourceBudget.
                "source_qualification",
                # Operator decision 2026-09-12 —
                # implementer_turn_budget.budgeted_turns: the implementer
                # turn cap (cycle_and_turn_budget_cap), consumed via
                # turn_budget_policy.implementer_turn_budget_for_store by
                # the spawn settings and the pre-merge capture. Was the
                # literal 10 in turn_budget.IMPLEMENTER_TURN_BUDGET.
                "implementer_turn_budget",
            },
        )

    def test_genesis_lifecycle_policy_defaults(self):
        policy = genesis_lifecycle_policy()
        self.assertEqual(policy["pressure_min_score"], 70)
        self.assertEqual(policy["shadow_min_clean_cycles"], 5)
        self.assertEqual(policy["max_critical_false_positives"], 0)
        # Y8 (ORPHAN-709) — DELIBERATE REWRITE: the per-gap operator gate is
        # panel-approved by default (operator directive 2026-08-17); the old
        # boolean was ALSO dead configuration (the validator hardcoded the
        # check and read no policy). "operator" remains a valid override.
        self.assertEqual(policy["request_approval_mode"], "panel")
        self.assertNotIn("request_requires_signed_operator_feedback", policy)




class SourceQualificationPolicyTests(unittest.TestCase):
    """ARIA-MEDIUM-082 — the qualification allowance is policy, not a literal."""

    @staticmethod
    def _override(tmp: str, block: object) -> None:
        path = Path(tmp) / OVERRIDE_RELPATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"source_qualification": block}), encoding="utf-8")

    def test_default_is_the_former_literal_two_seconds_and_ships_in_the_default_file(self) -> None:
        self.assertEqual(SOURCE_QUALIFICATION_DEFAULTS, {"deadline_seconds": 2.0})
        # The default file is the operator-visible authority: a key absent
        # there is a value the operator cannot see and a KeyError on a
        # pristine deployment.
        shipped = json.loads(
            (Path(__file__).resolve().parents[1] / "aria_kernel" / "data" / DEFAULT_FILENAME).read_text(encoding="utf-8")
        )
        self.assertEqual(shipped["source_qualification"]["deadline_seconds"], 2.0)
        self.assertIn("source_qualification", POLICY_KEYS)
        block = source_qualification_policy()
        self.assertEqual(block, {"deadline_seconds": 2.0})
        self.assertIs(type(block["deadline_seconds"]), float)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(source_qualification_policy(tmp), {"deadline_seconds": 2.0})

    def test_override_widens_the_allowance_through_the_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self._override(tmp, {"deadline_seconds": 120})
            self.assertEqual(source_qualification_policy(tmp), {"deadline_seconds": 120.0})
            # A shallow merge replaces the block; an empty block keeps the default.
            self._override(tmp, {})
            self.assertEqual(source_qualification_policy(tmp), {"deadline_seconds": 2.0})

    def test_zero_and_the_ceiling_are_the_honest_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            self._override(tmp, {"deadline_seconds": 0})
            self.assertEqual(source_qualification_policy(tmp)["deadline_seconds"], 0.0)
            self._override(tmp, {"deadline_seconds": SOURCE_QUALIFICATION_MAX_DEADLINE_SECONDS})
            self.assertEqual(source_qualification_policy(tmp)["deadline_seconds"],
                             SOURCE_QUALIFICATION_MAX_DEADLINE_SECONDS)

    def test_out_of_contract_values_are_refused_with_the_bound_named(self) -> None:
        cases = (
            (-1, "genesis_policy_source_qualification_deadline_negative"),
            (SOURCE_QUALIFICATION_MAX_DEADLINE_SECONDS + 1, "genesis_policy_source_qualification_deadline_above_ceiling"),
            (True, "genesis_policy_source_qualification_deadline_not_a_number"),
            ("2", "genesis_policy_source_qualification_deadline_not_a_number"),
            (None, "genesis_policy_source_qualification_deadline_not_a_number"),
            (float("nan"), "genesis_policy_source_qualification_deadline_not_a_number"),
            (float("inf"), "genesis_policy_source_qualification_deadline_not_a_number"),
        )
        for raw, reason in cases:
            with self.subTest(raw=raw), tempfile.TemporaryDirectory() as tmp:
                # json.dumps writes NaN/Infinity literals; the loader's parser
                # accepts them, which is exactly why the accessor must not.
                self._override(tmp, {"deadline_seconds": raw})
                with self.assertRaises(GovernanceError) as caught:
                    source_qualification_policy(tmp)
                message = str(caught.exception)
                self.assertTrue(message.startswith(reason), message)
                # RC-4 discipline: the refusal names the bound, so the
                # operator learns the contract from the error itself.
                self.assertIn(f"{SOURCE_QUALIFICATION_MAX_DEADLINE_SECONDS:g}", message)


if __name__ == "__main__":
    unittest.main()
