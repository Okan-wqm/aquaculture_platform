"""ARIA-HIGH-205 — merge authority is an operator grant the cycle cannot write.

`pr_merge` lived only in the `autonomous` profile, and the nightly cycle
rewrites the saved profile to at most `strict`, so every ARIA merge ran dry.
The grant lives in the same control plane as the profile and its ceiling
(`runtime-profile.json`, its history ledger, one governance event), is scoped
to a lane, expires, needs a recorded operator act to be given, and is carried
forward untouched by every ordinary profile transition.
"""

from __future__ import annotations

import inspect
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import auto_merge_runners, cli, merge_authority
from aria_kernel.runtime_profile import (
    MERGE_LANE_GRANT_STATE_KEY,
    assert_merge_authorized,
    get_merge_lane_grant,
    list_profile_history,
    merge_authority_available,
    revoke_merge_lane_grant,
    set_merge_lane_grant,
    set_profile,
)
from aria_kernel.tool_registry import GovernanceError, append_tools_governance, ensure_tools_dir


def _in(days: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")


class MergeLaneGrantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.tools = Path(self.tmp.name) / "aria-tools"
        ensure_tools_dir(self.tools)
        set_profile("strict", operator_approval_ref="op:strict", base_dir=self.tools, scheduler_ceiling="strict")

    def _gov(self) -> str:
        event = append_tools_governance(self.tools, "operator_merge_lane_decision", {"by": "operator"})
        return f"gov:{event['event_id']}"

    def _grant(self, *, days: float = 7) -> dict:
        return set_merge_lane_grant(
            lane="L1", expires_at=_in(days), operator_approval_ref=self._gov(), base_dir=self.tools,
        )

    def test_strict_without_a_grant_holds_no_merge_authority(self) -> None:
        self.assertFalse(merge_authority_available(base_dir=self.tools))
        with self.assertRaisesRegex(GovernanceError, "merge_lane_not_granted"):
            assert_merge_authorized(lane="L1", base_dir=self.tools)

    def test_an_l1_grant_authorizes_l1_and_nothing_wider(self) -> None:
        self._grant()
        self.assertTrue(merge_authority_available(base_dir=self.tools))
        assert_merge_authorized(lane="L1", base_dir=self.tools)
        for lane in ("L2", "L3"):
            with self.assertRaisesRegex(GovernanceError, "merge_lane_not_granted"):
                assert_merge_authorized(lane=lane, base_dir=self.tools)

    def test_only_l1_can_be_granted(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "merge_lane_grant_lane_not_grantable"):
            set_merge_lane_grant(
                lane="L2", expires_at=_in(7), operator_approval_ref=self._gov(), base_dir=self.tools,
            )

    def test_an_expired_grant_authorizes_nothing(self) -> None:
        self._grant()
        later = datetime.now(timezone.utc) + timedelta(days=8)
        self.assertFalse(merge_authority_available(base_dir=self.tools, now=later))
        with self.assertRaisesRegex(GovernanceError, "merge_lane_not_granted"):
            assert_merge_authorized(lane="L1", base_dir=self.tools, now=later)

    def test_a_grant_must_expire_and_within_the_bound(self) -> None:
        for bad in (_in(-1), _in(400), "not-a-date"):
            with self.assertRaisesRegex(GovernanceError, "merge_lane_grant_expiry"):
                set_merge_lane_grant(
                    lane="L1", expires_at=bad, operator_approval_ref=self._gov(), base_dir=self.tools,
                )

    def test_the_grant_needs_a_recorded_operator_act(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "merge_lane_grant_approval_unrecorded"):
            set_merge_lane_grant(
                lane="L1", expires_at=_in(7), operator_approval_ref="gov:never-recorded",
                base_dir=self.tools,
            )
        with mock.patch.dict("os.environ", {"ARIA_MERGE_ACK": "yes"}):
            with self.assertRaisesRegex(GovernanceError, "requires_recorded_operator_act:ack-env"):
                set_merge_lane_grant(
                    lane="L1", expires_at=_in(7), operator_approval_ref="ack-env:ARIA_MERGE_ACK",
                    base_dir=self.tools,
                )

    def test_a_machine_cannot_grant(self) -> None:
        with self.assertRaisesRegex(GovernanceError, "merge_lane_grant_requires_operator"):
            set_merge_lane_grant(
                lane="L1", expires_at=_in(7), operator_approval_ref=self._gov(),
                base_dir=self.tools, set_by="autonomy-cli",
            )

    def test_the_cycles_profile_rewrite_carries_the_grant_forward(self) -> None:
        grant = self._grant()[MERGE_LANE_GRANT_STATE_KEY]
        set_profile("strict", operator_approval_ref="cycle", base_dir=self.tools, set_by="autonomy-cli")
        set_profile("standard", operator_approval_ref="cycle", base_dir=self.tools, set_by="autonomy-cli")
        self.assertEqual(get_merge_lane_grant(base_dir=self.tools), grant)

    def test_a_grant_never_outranks_a_profile_that_holds_no_authority(self) -> None:
        self._grant()
        for profile in ("frozen", "observe"):
            set_profile(profile, operator_approval_ref="op:stop", base_dir=self.tools)
            self.assertFalse(merge_authority_available(base_dir=self.tools))
            with self.assertRaisesRegex(GovernanceError, "merge_lane_profile_holds_no_authority"):
                assert_merge_authorized(lane="L1", base_dir=self.tools)

    def test_revocation_is_immediate_and_audited(self) -> None:
        self._grant()
        revoke_merge_lane_grant(operator_approval_ref="op:stop", base_dir=self.tools)
        self.assertIsNone(get_merge_lane_grant(base_dir=self.tools))
        self.assertFalse(merge_authority_available(base_dir=self.tools))
        events = [row.get(MERGE_LANE_GRANT_STATE_KEY) for row in list_profile_history(base_dir=self.tools)]
        self.assertIsNone(events[-1])
        self.assertTrue(any(isinstance(event, dict) for event in events))

    def test_autonomous_keeps_its_standing_authority(self) -> None:
        set_profile("autonomous", operator_approval_ref="op:auto", base_dir=self.tools)
        self.assertTrue(merge_authority_available(base_dir=self.tools))
        assert_merge_authorized(lane="L3", base_dir=self.tools)

    def test_the_operator_cli_grants_and_revokes(self) -> None:
        base = ["--tools-dir", str(self.tools), "merge-lane"]
        with mock.patch("sys.stdout"):
            self.assertEqual(cli.main(base + [
                "grant", "--lane", "L1", "--expires-at", _in(7), "--operator-approval-ref", self._gov(),
            ]), 0)
            self.assertTrue(merge_authority_available(base_dir=self.tools))
            self.assertEqual(cli.main(base + ["revoke", "--operator-approval-ref", "op:stop"]), 0)
        self.assertFalse(merge_authority_available(base_dir=self.tools))


    def test_a_strict_run_with_a_grant_runs_live_and_without_it_observes(self) -> None:
        observed: list[str] = []

        def _record_authority(*, adapter, pr_number, base_dir, readiness_claim_id, workspace_root=None):
            observed.append("live")
            return {"decision": "blocked", "eligible": False, "pr_number": pr_number, "reasons": []}

        def _record_evaluation(*, adapter, pr_number, base_dir, dry_run):
            observed.append("dry" if dry_run else "evaluate-live")
            return {"decision": "blocked", "eligible": False, "pr_number": pr_number, "reasons": []}

        runner = auto_merge_runners.select_auto_merge_runner(
            profile="strict",
            executes_merges=True,
            adapter_factory=lambda: object(),
            pr_enumerator=lambda adapter: [7],
            readiness_claim_resolver=lambda adapter, pr, base: "claim-1",
        )
        with mock.patch(
            "aria_kernel.watchdog_freeze.open_watchdog_incidents",
            return_value={"readable": True, "incidents": [], "reason": "clear"},
        ), mock.patch("aria_kernel.auto_merge.merge_if_green", _record_evaluation), mock.patch(
            "aria_kernel.merge_authority.merge_pr_if_ready", _record_authority,
        ):
            self.assertTrue(runner(base_dir=self.tools, workspace_root=self.tmp.name)["dry_run"])
            self._grant()
            self.assertFalse(runner(base_dir=self.tools, workspace_root=self.tmp.name)["dry_run"])
            revoke_merge_lane_grant(operator_approval_ref="op:stop", base_dir=self.tools)
            self.assertTrue(runner(base_dir=self.tools, workspace_root=self.tmp.name)["dry_run"])
        self.assertEqual(observed, ["dry", "live", "dry"])


    def test_the_cycle_runner_never_executes_a_merge_even_when_authority_exists(self) -> None:
        self._grant()
        set_profile("autonomous", operator_approval_ref="op:auto", base_dir=self.tools)

        def _must_not_reach_authority(**kwargs):  # pragma: no cover - must not run
            raise AssertionError("the cycle runner reached the real merge authority")

        runner = auto_merge_runners.select_auto_merge_runner(
            profile="autonomous",
            executes_merges=False,
            adapter_factory=lambda: object(),
            pr_enumerator=lambda adapter: [7],
            readiness_claim_resolver=lambda adapter, pr, base: "claim-1",
        )
        with mock.patch(
            "aria_kernel.auto_merge.merge_if_green",
            lambda **kwargs: {"decision": "blocked", "eligible": False, "pr_number": 7, "reasons": []},
        ), mock.patch("aria_kernel.merge_authority.merge_pr_if_ready", _must_not_reach_authority):
            result = runner(base_dir=self.tools, workspace_root=self.tmp.name)
        self.assertTrue(result["dry_run"])
        self.assertFalse(result["executes_merges"])


class MergeSeamsReadTheGrantTests(unittest.TestCase):
    def test_only_the_merge_lane_cli_constructs_an_executing_runner(self) -> None:
        import ast

        tree = ast.parse(Path(cli.__file__).read_text(encoding="utf-8"))
        flags = sorted(
            keyword.value.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", None) == "select_auto_merge_runner"
            for keyword in node.keywords
            if keyword.arg == "executes_merges" and isinstance(keyword.value, ast.Constant)
        )
        # One evaluating construction (the nightly cycle) and one executing
        # construction (`merge-lane run`), both spelled as literals.
        self.assertEqual(flags, [False, True])

    def test_merge_authority_checks_the_grant_against_the_measured_lane(self) -> None:
        source = inspect.getsource(merge_authority.merge_pr_if_ready)
        self.assertNotIn('enforce_profile_for_action("pr_merge"', source)
        self.assertIn("assert_merge_authority_available(", source)
        self.assertLess(
            source.index("lane = str(risk.get(\"lane\")"),
            source.index("assert_merge_authorized(lane=lane"),
        )

    def test_no_cycle_code_path_writes_the_grant(self) -> None:
        import aria_kernel

        package = Path(aria_kernel.__file__).parent
        writers = sorted(
            path.name
            for path in package.glob("*.py")
            if "set_merge_lane_grant(" in path.read_text(encoding="utf-8")
            and path.name not in {"runtime_profile.py", "cli.py"}
        )
        self.assertEqual(writers, [])


if __name__ == "__main__":
    unittest.main()
