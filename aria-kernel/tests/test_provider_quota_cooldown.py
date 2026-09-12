"""The provider cooldown: the ledger row, its reader, and the fleet that obeys it.

Operator decision 2026-09-12: a credit exhaustion is a PROVIDER-level fact.
`genesis_policy._AdaptiveRuntimePolicy.provider_cooldown_seconds` had been
declared (900 s) with no reader — the "cooling" the fleet was said to do did
not exist in code, so an exhausted provider was re-admitted, re-spawned and
re-exhausted on every drain tick (`claude auth status` reports quota as
`unknown`). What this module pins, one property per test:

* `record_provider_cooldown` writes one `provider_quota_cooldown` governance
  row naming the provider, the model, `quota_unavailable`, the policy's
  seconds and the resulting `until`; `active_provider_cooldowns` returns it
  while `until` is ahead and drops it after, newest row per provider winning.
* The row is read through ONE contract: a row missing or mistyping any
  field a reader indexes is refused by name (`provider_cooldown_row_malformed:
  <field>`), never skipped — a skipped cooldown would re-admit the exhausted
  provider silently. `provider_cooldown_for_claim` finds the row a claim
  wrote (the worker hook's crash-vs-quota discriminator), and
  `provider_cooldown_seconds` is the one accessor for the policy's duration.
* `_native_runtime_admission` refuses a cooled provider WITHOUT probing it
  (`provider_quota_cooldown`, `quota_observation` unavailable, the cooldown's
  `until` on the row) and still admits the next vendor for a read-only role.
* A write-capable profile is refused on every read-only runtime by name
  (`provider_readonly_runtime`, from `Provider.admits_writes`), also without
  a probe, so a cooled anthropic leaves a writer with NO route — it waits,
  it is never handed to a runtime that cannot write.
"""
from __future__ import annotations

import json
import stat
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aria_kernel.agent_runtime_profile import AgentRuntimeProfile
from aria_kernel.genesis_policy import _adaptive_runtime_policy
from aria_kernel.ledger import load_declared_jsonl
from aria_kernel.model_fleet import (
    _FLEET,
    COOLDOWN_STATUS_REASON,
    READONLY_RUNTIME_STATUS_REASON,
    Provider,
    _RuntimeStatusObservation,
    _native_runtime_admission,
    provider_admits_writes,
)
from aria_kernel.provider_cooldown import (
    PROVIDER_COOLDOWN_GOVERNANCE_KIND,
    active_provider_cooldowns,
    provider_cooldown_for_claim,
    provider_cooldown_seconds,
    record_provider_cooldown,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir

_T0 = datetime(2026, 9, 12, 3, 0, 0, tzinfo=timezone.utc)


class _ToolsFixture(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="aria-provider-cooldown-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.root, ignore_errors=True))
        self.tools = ensure_tools_dir(self.root / "aria-tools")


class TheRowAndItsReader(_ToolsFixture):
    def test_the_row_names_the_provider_the_reason_and_the_window(self) -> None:
        detection = {"matched_marker": "usage-credits", "source": "cli_usage_limit_message"}
        row = record_provider_cooldown(
            self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
            request_id="AIR-1", claim_id="CL-1", detection=detection, now=_T0,
        )
        governance = load_declared_jsonl(self.tools / "governance.jsonl", expected_surface="tools_governance")
        rows = [entry for entry in governance if entry["kind"] == PROVIDER_COOLDOWN_GOVERNANCE_KIND]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["ledger_hash"], row["ledger_hash"])
        details = rows[0]["details"]
        self.assertEqual(details["provider"], "anthropic")
        self.assertEqual(details["model"], "opus")
        self.assertEqual(details["reason"], "quota_unavailable")
        self.assertEqual(details["cooldown_seconds"], 900)
        self.assertEqual(details["recorded_at"], "2026-09-12T03:00:00Z")
        self.assertEqual(details["until"], "2026-09-12T03:15:00Z")
        self.assertEqual((details["request_id"], details["claim_id"]), ("AIR-1", "CL-1"))
        self.assertEqual(details["detection"], detection)

    def test_a_non_positive_window_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=0,
                                     request_id="AIR-1", claim_id="CL-1", detection={})

    def test_the_reader_cools_until_the_window_ends_and_not_after(self) -> None:
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)
        inside = active_provider_cooldowns(self.tools, now=_T0 + timedelta(seconds=899))
        self.assertEqual(set(inside), {"anthropic"})
        self.assertEqual(inside["anthropic"]["until"], "2026-09-12T03:15:00Z")
        # The boundary is exclusive: at `until` the provider is back.
        self.assertEqual(active_provider_cooldowns(self.tools, now=_T0 + timedelta(seconds=900)), {})
        self.assertEqual(active_provider_cooldowns(self.tools, now=_T0 + timedelta(days=1)), {})

    def test_the_newest_row_per_provider_decides(self) -> None:
        # An older, longer cooldown must not outlive a newer, shorter one —
        # the ledger's newest word on a provider is its current state.
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=3600,
                                 request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=60,
                                 request_id="AIR-2", claim_id="CL-2", detection={}, now=_T0 + timedelta(seconds=10))
        self.assertEqual(active_provider_cooldowns(self.tools, now=_T0 + timedelta(seconds=120)), {})
        current = active_provider_cooldowns(self.tools, now=_T0 + timedelta(seconds=30))
        self.assertEqual(current["anthropic"]["request_id"], "AIR-2")

    def test_one_provider_cooling_does_not_cool_another(self) -> None:
        record_provider_cooldown(self.tools, provider="zai", model="glm-5.3", cooldown_seconds=900,
                                 request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)
        self.assertEqual(set(active_provider_cooldowns(self.tools, now=_T0)), {"zai"})

    def test_an_absent_ledger_cools_nothing(self) -> None:
        self.assertEqual(active_provider_cooldowns(self.root / "nowhere" / "aria-tools", now=_T0), {})

    def test_the_row_a_claim_wrote_is_found_by_that_claim(self) -> None:
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="A-W-1", claim_id="DC-7", detection={"matched_marker": "billing"},
                                 now=_T0 + timedelta(seconds=5))
        found = provider_cooldown_for_claim(self.tools, claim_id="DC-7")
        self.assertIsNotNone(found)
        self.assertEqual((found["request_id"], found["detection"]), ("A-W-1", {"matched_marker": "billing"}))
        self.assertIsNone(provider_cooldown_for_claim(self.tools, claim_id="DC-never"))
        self.assertIsNone(provider_cooldown_for_claim(self.root / "nowhere" / "aria-tools", claim_id="DC-7"))


class TheDurationHasOneAccessor(_ToolsFixture):
    def test_without_an_adaptive_block_the_policy_default_applies(self) -> None:
        # No aria-config override in the fixture root: `_adaptive_runtime_policy`
        # is None and the duration is the one the policy dataclass declares.
        from aria_kernel.genesis_policy import _AdaptiveRuntimePolicy

        self.assertIsNone(_adaptive_runtime_policy(self.root))
        self.assertEqual(provider_cooldown_seconds(self.root), _AdaptiveRuntimePolicy.provider_cooldown_seconds)
        self.assertEqual(provider_cooldown_seconds(self.root), 900)

    def test_an_enabled_adaptive_block_supplies_the_same_number(self) -> None:
        policy = self.root / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        policy.write_text(json.dumps({"executor": {"adaptive_runtime": {
            "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
            "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
            "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
        }}}) + "\n", encoding="utf-8")
        self.assertIsNotNone(_adaptive_runtime_policy(self.root))
        self.assertEqual(provider_cooldown_seconds(self.root), 900)


class AMalformedRowIsRefusedByName(_ToolsFixture):
    """The reader used to validate only provider/until and skip the rest,
    while the fleet admission indexed recorded_at/request_id/model unguarded
    (KeyError before the claim). One contract now: every indexed field is
    checked here, and a row that fails it is a named refusal, not a skipped
    row that quietly re-admits an exhausted provider."""

    def _valid_details(self) -> dict:
        return {
            "schema_version": 1, "provider": "anthropic", "model": "opus", "reason": "quota_unavailable",
            "cooldown_seconds": 900, "recorded_at": "2026-09-12T03:00:00Z", "until": "2026-09-12T03:15:00Z",
            "request_id": "AIR-1", "claim_id": "CL-1", "detection": {},
        }

    def _seed(self, details: dict) -> dict:
        return append_tools_governance(self.tools, PROVIDER_COOLDOWN_GOVERNANCE_KIND, details)

    def test_the_hand_built_valid_row_is_what_the_writer_writes(self) -> None:
        # The fixture row must match the writer's shape byte for byte, or the
        # refusals below would be testing a shape nothing produces.
        written = record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                           request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)["details"]
        self.assertEqual(written, self._valid_details())

    def test_every_indexed_field_is_refused_by_name_when_broken(self) -> None:
        breakages = {
            "provider": {"provider": ""},
            "model": {"model": None},
            "reason": {"reason": "rate_limited"},
            "recorded_at": {"recorded_at": "yesterday"},
            "until": {"until": 12},
            "request_id": {"request_id": ""},
            "claim_id": {"claim_id": 7},
            "cooldown_seconds": {"cooldown_seconds": "900"},
            "detection": {"detection": "usage-credits"},
            "schema_version": {"schema_version": 2},
        }
        for field, breakage in breakages.items():
            with self.subTest(field=field):
                root = ensure_tools_dir(self.root / f"tools-{field}")
                append_tools_governance(root, PROVIDER_COOLDOWN_GOVERNANCE_KIND, {**self._valid_details(), **breakage})
                for reader in (lambda: active_provider_cooldowns(root, now=_T0),
                               lambda: provider_cooldown_for_claim(root, claim_id="CL-1")):
                    with self.assertRaises(GovernanceError) as refused:
                        reader()
                    self.assertIn(f"provider_cooldown_row_malformed:{field}", str(refused.exception))

    def test_a_missing_field_is_refused_not_skipped(self) -> None:
        details = self._valid_details()
        del details["recorded_at"]
        row = self._seed(details)
        with self.assertRaises(GovernanceError) as refused:
            active_provider_cooldowns(self.tools, now=_T0)
        self.assertIn("provider_cooldown_row_malformed:recorded_at", str(refused.exception))
        self.assertIn(row["ledger_hash"], str(refused.exception), "the refusal locates the row")

    def test_a_malformed_row_cannot_hide_behind_a_valid_one(self) -> None:
        # Even an EXPIRED malformed row is refused: the contract is on the
        # row, not on whether it would have cooled anything today.
        record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                 request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)
        self._seed({**self._valid_details(), "until": "2020-01-01T00:00:00Z", "model": ""})
        with self.assertRaises(GovernanceError):
            active_provider_cooldowns(self.tools, now=_T0)

    def test_rows_of_other_kinds_are_not_read_through_this_contract(self) -> None:
        append_tools_governance(self.tools, "model_credit_exhausted", {"model": "opus"})
        self.assertEqual(active_provider_cooldowns(self.tools, now=_T0), {})


class _AdmissionFixture(_ToolsFixture):
    """Every fleet member discoverable; the status transport is a fake."""

    def setUp(self) -> None:
        super().setUp()
        policy = self.root / "aria-config/genesis_policy.json"
        policy.parent.mkdir()
        policy.write_text(json.dumps({"executor": {"adaptive_runtime": {
            "schema_version": 1, "enabled": True, "policy_id": "aria/adaptive-runtime/v1",
            "provider_cooldown_seconds": 900, "recheck_timeout_seconds": 20,
            "max_attempts_per_dispatch": 2, "scarcity_judgment_mode": "independent_sessions",
            "monetary_admission": "managed_subscription",
        }}}) + "\n", encoding="utf-8")
        self.policy = _adaptive_runtime_policy(self.root)
        binaries = self.root / "bin"
        binaries.mkdir()
        for name in ("claude", "codex"):
            executable = binaries / name
            executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        self.environ = {"PATH": str(binaries), "ARIA_ZAI_API_KEY_FILE": str(self.root / "zai.key")}
        self.probed: list[str] = []

    def _observe(self, provider: Provider, timeout_seconds: float) -> _RuntimeStatusObservation:
        self.probed.append(provider.key)
        auth_method = {"anthropic": "subscription", "zai": "subscription_api_key", "openai": "chatgpt"}[provider.key]
        return _RuntimeStatusObservation("available", reason="fixture_available", auth_method=auth_method,
                                         control_status="available", control_reason="fixture_prepared")

    def _admit(self, profile: AgentRuntimeProfile, cooled: dict):
        return _native_runtime_admission(
            repo_root=self.root, profile=profile, policy=self.policy, environ=self.environ,
            observe_status=self._observe, cooled_providers=cooled,
        )


_READ_ONLY = AgentRuntimeProfile(agent_name="judge", model="opus", effort="max", source="frontmatter",
                                 tools=("Read", "Grep", "Glob"))
_WRITER = AgentRuntimeProfile(agent_name="implementer", model="opus", effort="max", source="frontmatter",
                              tools=("Read", "Edit", "Write", "Bash"), write_scope=("apps/**",))


class TheFleetObeysTheCooldown(_AdmissionFixture):
    def test_a_cooled_provider_is_refused_without_a_probe_and_the_next_vendor_is_admitted(self) -> None:
        cooldown = record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                            request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)["details"]
        admission = self._admit(_READ_ONLY, {"anthropic": cooldown})
        self.assertEqual(self.probed, ["zai", "openai"], "the cooled provider is never asked")
        rows = {row["provider"]: row for row in admission.candidate_observations}
        anthropic = rows["anthropic"]
        self.assertEqual(anthropic["status_reason"], COOLDOWN_STATUS_REASON)
        self.assertEqual(anthropic["quota_observation"], "unavailable")
        self.assertEqual(anthropic["quota_cooldown"]["until"], "2026-09-12T03:15:00Z")
        self.assertEqual(anthropic["quota_cooldown"]["request_id"], "AIR-1")
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["zai", "openai"])

    def test_no_cooldown_admits_the_fleet_in_order(self) -> None:
        admission = self._admit(_READ_ONLY, {})
        self.assertEqual(self.probed, [provider.key for provider in _FLEET])
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic", "zai", "openai"])
        self.assertNotIn("quota_cooldown", admission.candidate_observations[0])


class TheFleetKnowsWhoCanWrite(_AdmissionFixture):
    def test_the_rows_state_write_admission_as_data(self) -> None:
        self.assertEqual({provider.key: provider.admits_writes for provider in _FLEET},
                         {"anthropic": True, "zai": False, "openai": False})
        self.assertTrue(provider_admits_writes("anthropic"))
        self.assertFalse(provider_admits_writes("zai"))
        self.assertFalse(provider_admits_writes("nobody"))

    def test_a_writer_is_refused_on_read_only_runtimes_without_a_probe(self) -> None:
        admission = self._admit(_WRITER, {})
        self.assertEqual(self.probed, ["anthropic"])
        rows = {row["provider"]: row for row in admission.candidate_observations}
        for provider in ("zai", "openai"):
            with self.subTest(provider=provider):
                self.assertEqual(rows[provider]["status_reason"], READONLY_RUNTIME_STATUS_REASON)
                self.assertEqual(rows[provider]["controls"],
                                 {"status": "unavailable", "reason": READONLY_RUNTIME_STATUS_REASON})
        self.assertEqual([route["provider"] for route in admission.eligible_routes], ["anthropic"])

    def test_a_writer_whose_provider_is_cooled_has_no_route_and_waits(self) -> None:
        cooldown = record_provider_cooldown(self.tools, provider="anthropic", model="opus", cooldown_seconds=900,
                                            request_id="AIR-1", claim_id="CL-1", detection={}, now=_T0)["details"]
        admission = self._admit(_WRITER, {"anthropic": cooldown})
        self.assertEqual(self.probed, [], "nothing to ask: one provider is cooled, the others cannot write")
        self.assertEqual(admission.eligible_routes, ())
        reasons = {row["provider"]: row["status_reason"] for row in admission.candidate_observations}
        self.assertEqual(reasons, {"anthropic": COOLDOWN_STATUS_REASON, "zai": READONLY_RUNTIME_STATUS_REASON,
                                   "openai": READONLY_RUNTIME_STATUS_REASON})


if __name__ == "__main__":
    unittest.main()
