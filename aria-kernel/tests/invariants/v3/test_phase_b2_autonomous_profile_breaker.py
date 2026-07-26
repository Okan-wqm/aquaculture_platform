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

ORPHAN-CRITICAL-333 fail-closed cases (I-V3-25d..25i) — each of these
returned ``ok`` before the fix, i.e. damaging the breaker's own ledger
un-tripped the kernel's safety net:

  * I-V3-25d — corrupt rows cannot un-trip the breaker
  * I-V3-25e — an unparseable ``ts`` counts as in-window
  * I-V3-25f — valid-JSON non-object rows are lost evidence
  * I-V3-25g — a clean under-threshold ledger still reads ``ok``
    (the fail-closed rule must not make the breaker useless)
  * I-V3-25h — damaged evidence refuses autonomous entry and names
    ``evidence_incomplete``; the append path refuses to write onto
    corruption at all
  * I-V3-25i — ``auto_action_gate`` never reads an exception as ``ok``
    and an unreadable signal forces an operator ack
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
import unittest.mock
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

    # ------------------------------------------------------------------
    # ORPHAN-CRITICAL-333 — the breaker must not un-trip when its own
    # evidence is damaged. Each case below returned "ok" pre-fix.
    # ------------------------------------------------------------------

    def _tripped_failure_ledger(self, base: Path, threshold: int) -> Path:
        """Record exactly ``threshold`` real failures and assert tripped."""
        from aria_kernel.circuit_breaker import (
            _failures_path,
            current_state,
            record_failure,
        )

        _write_threshold_policy(base, threshold=threshold)
        for n in range(threshold):
            record_failure(
                base_dir=base, kind="ci_red",
                materialize_event_id=f"evt-damage-{n}",
            )
        self.assertEqual(current_state(base), "tripped")
        return _failures_path(base)

    def test_i_v3_25d_corrupt_rows_cannot_untrip_breaker(self) -> None:
        from aria_kernel.circuit_breaker import (
            BREAKER_REASON_EVIDENCE_INCOMPLETE,
            evaluate_breaker,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25d-") as tmp:
            base = Path(tmp) / "aria-tools"
            path = self._tripped_failure_ledger(base, threshold=3)
            # Corrupt 2 of the 3 rows — pre-fix the tolerant reader
            # dropped them and the sliding count fell to 1 < 3 → "ok".
            rows = [
                line for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            path.write_text("\n".join([rows[0], "{not json", "{also not json"]) + "\n")
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.state, "tripped")
            self.assertEqual(verdict.reason, BREAKER_REASON_EVIDENCE_INCOMPLETE)
            self.assertEqual(verdict.evidence.dropped_rows, 2)

    def test_i_v3_25e_unparseable_timestamp_counts_in_window(self) -> None:
        from aria_kernel.circuit_breaker import evaluate_breaker

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25e-") as tmp:
            base = Path(tmp) / "aria-tools"
            path = self._tripped_failure_ledger(base, threshold=3)
            # Blank every timestamp. Pre-fix each row was skipped by the
            # sliding-window counter → count 0 → "ok". A failure whose
            # age cannot be established has not aged out.
            blanked = [
                json.dumps({**json.loads(line), "ts": "NOT-A-DATE"})
                for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            path.write_text("\n".join(blanked) + "\n")
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.state, "tripped")
            self.assertEqual(verdict.sliding_count, 3)
            self.assertEqual(verdict.evidence.dropped_rows, 0)

    def test_i_v3_25f_valid_json_non_object_row_is_lost_evidence(self) -> None:
        from aria_kernel.circuit_breaker import (
            BREAKER_REASON_EVIDENCE_INCOMPLETE,
            evaluate_breaker,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25f-") as tmp:
            base = Path(tmp) / "aria-tools"
            path = self._tripped_failure_ledger(base, threshold=3)
            rows = [
                line for line in path.read_text(encoding="utf-8").splitlines()
                if line.strip()
            ]
            # `12345` decodes cleanly but carries no failure — the strict
            # reader yields it, so only an isinstance check catches it.
            path.write_text("\n".join([rows[0], rows[1], "12345"]) + "\n")
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.state, "tripped")
            self.assertEqual(verdict.reason, BREAKER_REASON_EVIDENCE_INCOMPLETE)
            self.assertEqual(verdict.evidence.dropped_rows, 1)

    def test_i_v3_25g_clean_ledger_under_threshold_stays_ok(self) -> None:
        """The fail-closed rule must not make the breaker useless."""
        from aria_kernel.circuit_breaker import (
            BREAKER_REASON_WITHIN_THRESHOLD,
            evaluate_breaker,
            record_failure,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25g-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_threshold_policy(base, threshold=3)
            # Absent ledger.
            self.assertEqual(evaluate_breaker(base).state, "ok")
            for n in range(2):
                record_failure(
                    base_dir=base, kind="ci_red",
                    materialize_event_id=f"evt-clean-{n}",
                )
            verdict = evaluate_breaker(base)
            self.assertEqual(verdict.state, "ok")
            self.assertEqual(verdict.reason, BREAKER_REASON_WITHIN_THRESHOLD)
            self.assertTrue(verdict.evidence.intact)

    def test_i_v3_25h_damaged_evidence_refuses_autonomous_entry(self) -> None:
        """The autonomous entry gate must name evidence damage as the cause.

        A damage-trip is only ever observable on the READ path: the
        append path already fails closed, because ``append_jsonl``
        re-reads the whole ledger and raises ``LedgerIntegrityError``
        rather than appending onto corruption. Both halves are asserted
        here so neither can regress into silence.
        """
        from aria_kernel.circuit_breaker import (
            BREAKER_REASON_EVIDENCE_INCOMPLETE,
            _failures_path,
            assert_within_breaker,
            record_failure,
        )
        from aria_kernel.ledger import LedgerIntegrityError
        from aria_kernel.tool_registry import GovernanceError

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25h-") as tmp:
            base = Path(tmp) / "aria-tools"
            _write_threshold_policy(base, threshold=5)
            record_failure(
                base_dir=base, kind="ci_red",
                materialize_event_id="evt-damage-first",
            )
            # One real failure, threshold 5 → entry is allowed.
            self.assertEqual(assert_within_breaker(base)["state"], "ok")
            # Simulate a crash mid-append / truncated artifact restore.
            path = _failures_path(base)
            path.write_text(path.read_text(encoding="utf-8") + "{truncated\n")
            # Write path: refuses to append onto corruption.
            with self.assertRaises(LedgerIntegrityError):
                record_failure(
                    base_dir=base, kind="ci_red",
                    materialize_event_id="evt-damage-second",
                )
            # Read path: refuses autonomous entry, naming the real cause
            # rather than reporting one failure against a threshold of 5.
            with self.assertRaises(GovernanceError) as ctx:
                assert_within_breaker(base)
            self.assertIn(BREAKER_REASON_EVIDENCE_INCOMPLETE, str(ctx.exception))

    def test_i_v3_25i_unreadable_safety_signal_requires_operator_ack(self) -> None:
        """auto_action_gate must not read an exception as ``ok``."""
        from aria_kernel import auto_action_gate
        from aria_kernel.auto_action_gate import (
            SAFETY_STATE_UNREADABLE,
            _load_breaker_state,
            _load_cost_state,
            gate_from_test_fixture,
        )

        with tempfile.TemporaryDirectory(prefix="aria-i-v3-25i-") as tmp:
            base = Path(tmp) / "aria-tools"

            def _boom(**_kwargs: object) -> str:
                raise RuntimeError("ledger unreadable")

            for module_name, loader in (
                ("aria_kernel.circuit_breaker", _load_breaker_state),
                ("aria_kernel.cost_budget", _load_cost_state),
            ):
                with unittest.mock.patch(
                    f"{module_name}.current_state", side_effect=_boom,
                ):
                    self.assertEqual(loader(base), SAFETY_STATE_UNREADABLE)

            self.assertNotEqual(SAFETY_STATE_UNREADABLE, "ok")
            # An unreadable signal must force an operator ack.
            for kwargs in (
                {"breaker_state": SAFETY_STATE_UNREADABLE},
                {"cost_state": SAFETY_STATE_UNREADABLE},
            ):
                gate = gate_from_test_fixture(
                    profile="autonomous", lane="L3",
                    classifier_passed=True,
                    policy_requires_acknowledge=False,
                    **kwargs,
                )
                self.assertTrue(gate.human_ack_required, msg=f"{kwargs!r}")
            self.assertIn("SAFETY_STATE_UNREADABLE", auto_action_gate.__all__)


if __name__ == "__main__":
    unittest.main()
