"""Plan ARIA-V3 Phase B2 — autonomous profile + failure breaker + L3 audit + cross-host lease.

Closes:
  * HIGH-V3-007 (failure breaker taxonomy)
  * CRIT-V3-002 (lane forgery — kernel-derived only)
  * INFRA-HIGH-004 (cross-host race)
  * AUDITTRAIL-CRITICAL-005 (breaker atomic increment)
  * AUDITTRAIL-HIGH-007 (L3 classifier audit row)

Locked invariants (13 cases, I-V3-24..29c):

  * I-V3-24  — autonomous profile has no live auto-ack lane
  * I-V3-25  — circuit breaker trips on N failures (parametrized over
    all 6 failure kinds)
  * I-V3-25a — breaker atomic-with-event: failure row + governance
    event written in one call
  * I-V3-25b — breaker state survives kernel restart (importlib.reload
    simulates cold-start)
  * I-V3-25c — breaker threshold configurable via genesis_policy
  * I-V3-26  — tripped breaker emits ``circuit_breaker_tripped``
    governance row; operator may then auto-downgrade profile
  * I-V3-27  — autonomous profile set requires operator_approval_ref
  * I-V3-27a — ACTION_PERMISSIONS lists autonomous EXPLICITLY (no
    inherit-from-strict)
  * I-V3-28  — gate refuses non-L3 lane under autonomous profile
  * I-V3-29  — diff classifier path-evasion rejected under autonomous
    (kernel + auth + tenant + migrations + infra + secrets + billing
    + production)
  * I-V3-29a — ``l3_lane_classification_decided`` audit row carries
    all 6 required fields
  * I-V3-29b — CLI rejects ``--lane`` operator override (lane is
    kernel-derived only)
  * I-V3-29c — cross-host lease lock blocks concurrent autonomous
    loops (INFRA-HIGH-004)
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))


def _write_threshold_policy(base_dir: Path, threshold: int) -> None:
    policy_path = base_dir.parent / "aria-config" / "genesis_policy.json"
    policy_path.parent.mkdir(parents=True, exist_ok=True)
    policy_path.write_text(
        json.dumps(
            {
                "enable_request_generation": True,
                "max_requests_per_cycle": 5,
                "materialization_requires_acknowledge": True,
                "fitness_staleness_threshold_days": 14,
                "circuit_breaker": {
                    "threshold_24h": threshold,
                    "auto_downgrade_to": "strict",
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _read_governance_kinds(base: Path) -> list[str]:
    gov = base / "governance.jsonl"
    if not gov.exists():
        return []
    return [
        json.loads(line).get("kind")
        for line in gov.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


class PhaseB2AutonomousProfileBreaker(unittest.TestCase):
    # I-V3-24 — no current lane auto-mints ack tokens.
    def test_i_v3_24_autonomous_profile_requires_ack_on_all_current_lanes(self) -> None:
        from aria_kernel.auto_action_gate import gate_from_test_fixture

        for lane in ("L3-snowball", "L0-main", None):
            gate = gate_from_test_fixture(
                profile="autonomous", lane=lane,
                classifier_passed=True, policy_requires_acknowledge=False,
            )
            self.assertTrue(gate.human_ack_required, msg=f"lane={lane!r}")

    # I-V3-25 — breaker trips on N failures across all 6 kinds.
    def test_i_v3_25_circuit_breaker_trips_after_n_failures_across_taxonomy(
        self,
    ) -> None:
        from aria_kernel.circuit_breaker import (
            FAILURE_KINDS,
            current_state,
            record_failure,
        )

        for kind in sorted(FAILURE_KINDS):
            with tempfile.TemporaryDirectory(prefix=f"aria-i-v3-25-{kind}-") as tmp:
                base = Path(tmp) / "aria-tools"
                _write_threshold_policy(base, threshold=3)
                self.assertEqual(current_state(base), "ok")
                for n in range(3):
                    record_failure(
                        base_dir=base,
                        kind=kind,
                        materialize_event_id=f"evt-{kind}-{n}",
                    )
                self.assertEqual(
                    current_state(base),
                    "tripped",
                    msg=f"breaker did not trip after 3 {kind!r} failures",
                )

    # I-V3-25a — failure row + governance event in one atomic call.
    def test_i_v3_25a_breaker_atomic_with_event(self) -> None:
        from aria_kernel.circuit_breaker import record_failure

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25a-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_threshold_policy(base, threshold=10)
            record_failure(
                base_dir=base,
                kind="validator_rejection",
                materialize_event_id="evt-atomic-1",
            )
            failures_path = base / "breakers" / "autonomous-failures.jsonl"
            self.assertTrue(failures_path.exists())
            failure_lines = [
                json.loads(line)
                for line in failures_path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(failure_lines), 1)
            self.assertEqual(failure_lines[0]["kind"], "validator_rejection")
            self.assertIn(
                "circuit_breaker_failure_recorded",
                _read_governance_kinds(base),
            )

    # I-V3-25b — breaker state survives simulated cold-start.
    def test_i_v3_25b_breaker_state_survives_kernel_restart(self) -> None:
        from aria_kernel.circuit_breaker import (
            current_state,
            record_failure,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25b-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_threshold_policy(base, threshold=2)
            record_failure(
                base_dir=base, kind="ci_red",
                materialize_event_id="evt-r-1",
            )
            record_failure(
                base_dir=base, kind="ci_red",
                materialize_event_id="evt-r-2",
            )
            self.assertEqual(current_state(base), "tripped")
            # Simulate cold-start.
            import importlib
            import aria_kernel.circuit_breaker as cb
            importlib.reload(cb)
            self.assertEqual(cb.current_state(base), "tripped")

    # I-V3-25c — threshold configurable via policy.
    def test_i_v3_25c_breaker_threshold_configurable(self) -> None:
        from aria_kernel.circuit_breaker import (
            current_state,
            record_failure,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25c-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_threshold_policy(base, threshold=5)
            # 4 failures < threshold 5 → ok.
            for n in range(4):
                record_failure(
                    base_dir=base, kind="gh_api_failure",
                    materialize_event_id=f"evt-{n}",
                )
            self.assertEqual(current_state(base), "ok")
            # 5th failure → tripped.
            record_failure(
                base_dir=base, kind="gh_api_failure",
                materialize_event_id="evt-5",
            )
            self.assertEqual(current_state(base), "tripped")

    # I-V3-26 — tripped breaker emits the trip event.
    def test_i_v3_26_tripped_breaker_emits_audit_row(self) -> None:
        from aria_kernel.circuit_breaker import record_failure

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-26-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_threshold_policy(base, threshold=1)
            record_failure(
                base_dir=base, kind="subprocess_timeout",
                materialize_event_id="evt-t-1",
            )
            kinds = _read_governance_kinds(base)
            self.assertIn("circuit_breaker_tripped", kinds)
            self.assertIn("circuit_breaker_failure_recorded", kinds)

    # I-V3-27 — profile set autonomous requires approval ref.
    def test_i_v3_27_autonomous_profile_set_requires_operator_approval_ref(
        self,
    ) -> None:
        from aria_kernel.runtime_profile import set_profile
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-27-") as tmp:
            base = Path(tmp)
            with self.assertRaises(GovernanceError) as ctx:
                set_profile("autonomous", operator_approval_ref="", base_dir=base)
            self.assertIn(
                "runtime_profile_change_requires_approval",
                str(ctx.exception),
            )

    # I-V3-27a — ACTION_PERMISSIONS lists autonomous explicitly.
    def test_i_v3_27a_action_permissions_explicit_for_autonomous(self) -> None:
        from aria_kernel.runtime_profile import (
            ACTION_PERMISSIONS,
            PROFILES,
        )

        self.assertIn(
            "autonomous", PROFILES,
            msg="`autonomous` missing from PROFILES tuple",
        )
        # Every action_kind that "strict" can perform, autonomous
        # must also list explicitly (no inherit-from-strict).
        strict_actions = {
            kind for kind, profiles in ACTION_PERMISSIONS.items()
            if "strict" in profiles
        }
        autonomous_actions = {
            kind for kind, profiles in ACTION_PERMISSIONS.items()
            if "autonomous" in profiles
        }
        missing = strict_actions - autonomous_actions
        self.assertEqual(
            missing, set(),
            msg=(
                f"autonomous missing from ACTION_PERMISSIONS for: "
                f"{sorted(missing)} — must list explicitly per Plan "
                f"ARIA-V3 §2a (no inherit-from-strict)"
            ),
        )

    # I-V3-28 — gate refuses every current lane under autonomous.
    def test_i_v3_28_gate_requires_ack_for_every_current_lane(self) -> None:
        from aria_kernel.auto_action_gate import gate_from_test_fixture

        for lane in ("L3-snowball", "L0-main", "L1-feature", "L2-other", None):
            gate = gate_from_test_fixture(
                profile="autonomous", lane=lane,
                classifier_passed=True,
                policy_requires_acknowledge=False,
            )
            self.assertTrue(
                gate.human_ack_required,
                msg=f"autonomous + lane={lane!r} must require human ack",
            )

    # I-V3-29 — diff classifier rejects L3 exclusion list under autonomous.
    def test_i_v3_29_diff_classifier_rejects_l3_exclusion_paths(self) -> None:
        import json as _json

        policy_path = (
            _KERNEL_ROOT / "aria_kernel" / "data" / "auto_action_policy.json"
        )
        self.assertTrue(policy_path.exists(), msg=f"{policy_path} missing")
        policy = _json.loads(policy_path.read_text(encoding="utf-8"))
        # Plan ARIA-V3 §A0 ships the policy file as
        # `l3_lane_exclusion_globs` (glob patterns) plus a parallel
        # `l3_lane_exclusion_reason_codes` map. The invariant
        # asserts every required protected-surface prefix is
        # represented in the globs list.
        excluded = (
            policy.get("l3_lane_exclusion_globs")
            or policy.get("l3_excluded_paths")
            or policy.get("l4_excluded_paths")
            or []
        )
        # The 8 protected path prefixes are required to be excluded
        # under L3-autonomous (Plan ARIA-V3 §A0 + §2a).
        required_prefixes = {
            "aria-kernel",
            "auth",
            "tenant",
            "migrations",
            "infra",
            "secrets",
            "billing",
            "production",
        }
        # Glob patterns map to prefixes via substring match — e.g.
        # ``**/auth/**`` represents ``auth``; ``apps/billing-service/**``
        # represents ``billing``; ``infrastructure/**`` represents
        # ``infra``.
        prefix_aliases: dict[str, tuple[str, ...]] = {
            "aria-kernel": ("aria-kernel",),
            "auth": ("auth",),
            "tenant": ("tenant",),
            "migrations": ("migration",),
            "infra": ("infrastructure", "infra/", "/infra/"),
            "secrets": ("secret", "credential", ".env"),
            "billing": ("billing",),
            "production": ("production",),
        }
        seen_prefixes: set[str] = set()
        for entry in excluded:
            if not isinstance(entry, str):
                continue
            for prefix, aliases in prefix_aliases.items():
                if any(alias in entry.lower() for alias in aliases):
                    seen_prefixes.add(prefix)
        missing = required_prefixes - seen_prefixes
        self.assertEqual(
            missing, set(),
            msg=(
                f"auto_action_policy.json missing required L3-exclusion "
                f"prefixes: {sorted(missing)}"
            ),
        )

    # I-V3-29a — lane classification audit row carries all required fields.
    def test_i_v3_29a_lane_classification_audit_row_fields(self) -> None:
        from aria_kernel.lane_classifier import (
            derive_lane_from_base_branch,
            emit_lane_classification_audit_row,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-29a-") as tmp:
            base = Path(tmp) / "aria-tools"
            decision = derive_lane_from_base_branch("snowball")
            details = emit_lane_classification_audit_row(
                base_dir=base,
                decision=decision,
                classifier_inputs={"baseRefName": "snowball"},
                allowed_paths=["apps/farm-service/foo.ts"],
                rejected_paths=[],
                linked_materialize_event_id="evt-link-1",
            )
            for key in (
                "classifier_inputs",
                "decision",
                "allowed_paths",
                "rejected_paths",
                "classifier_version",
                "linked_materialize_event_id",
            ):
                self.assertIn(key, details, msg=f"missing audit field {key!r}")
            kinds = _read_governance_kinds(base)
            self.assertIn("l3_lane_classification_decided", kinds)

    # I-V3-29b — CLI rejects --lane operator override.
    def test_i_v3_29b_cli_rejects_lane_operator_override(self) -> None:
        import inspect

        from aria_kernel import cli

        src = inspect.getsource(cli)
        # The CLI must not declare any add_argument("--lane", ...)
        # call. Lane is kernel-derived only (Plan ARIA-V3 §2c).
        self.assertNotIn(
            '"--lane"', src,
            msg=(
                "CLI declares --lane argument; lane is kernel-derived "
                "only per Plan ARIA-V3 §2c (CRIT-V3-002)"
            ),
        )

    # I-V3-29c — cross-host lease blocks concurrent loops.
    def test_i_v3_29c_cross_host_lease_blocks_concurrent_loops(self) -> None:
        from aria_kernel.autonomous_host_lease import (
            acquire_lease,
            lease_state,
        )
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-29c-") as tmp:
            base = Path(tmp) / "aria-tools"
            # Host A acquires.
            lease_a = acquire_lease(
                base_dir=base, host_id="local:host-a", pid=1001,
            )
            self.assertEqual(lease_a.host_id, "local:host-a")
            self.assertEqual(lease_state(base)["state"], "fresh")
            # Host B attempts — blocked.
            with self.assertRaises(GovernanceError) as ctx:
                acquire_lease(
                    base_dir=base, host_id="local:host-b", pid=2002,
                )
            self.assertIn("autonomous_host_lease_blocked", str(ctx.exception))
            # Audit row recorded.
            self.assertIn(
                "autonomous_host_lease_blocked",
                _read_governance_kinds(base),
            )
            # Host A refresh path still works.
            lease_a_refreshed = acquire_lease(
                base_dir=base, host_id="local:host-a", pid=1001,
            )
            self.assertEqual(lease_a_refreshed.host_id, "local:host-a")


if __name__ == "__main__":
    unittest.main()
