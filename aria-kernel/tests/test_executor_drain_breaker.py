"""ARIA-HIGH-003 — executor drain breaker tests (Task 5).

The baseline drain requeued the same work under repeated environment
failures: a non-retryable provider condition (expired session, missing
CLI, unauthorised redirect, quota wall) priced itself as N per-request
failures while the queue burned its requeue budget on a lane that could
never succeed that night. These tests pin the keyed same-run circuit,
the no-claim skip, the refusal exemption, the schema-v2 governance
aggregate, the reconciling provider/model/role breakdown, and the
persistent breaker mapping before the drain is rewired.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
for _path in (str(_POC_DIR), str(_REPO_ROOT / "aria-kernel")):
    if _path not in sys.path:
        sys.path.insert(0, _path)

import ci_executor_drain  # noqa: E402
from aria_kernel.agent_runtime_profile import (  # noqa: E402
    resolve_claude_model,
)

# The circuit keys join the CHILD SUMMARY route with the PRE-DISPATCH
# resolved route; both derive from the same frontmatter SSoT, so the
# fixtures must too — a hardcoded model here would pass while production
# skipped nothing.
_IMPL_MODEL = resolve_claude_model("aria-implementer")
_JUDGE_MODEL = resolve_claude_model("aria-evidence-judge")
# A genuinely DIFFERENT route (zai/glm-5.3): the skip matches provider+model,
# so an anthropic/opus circuit must not touch work on another vendor.
_ADV_MODEL = resolve_claude_model("aria-adversarial-judge")


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _summary(
    *,
    request_id: str,
    outcome: str,
    failure_class: str | None = None,
    retryable: bool = False,
    detail_code: str | None = None,
    provider: str = "anthropic",
    model: str = _IMPL_MODEL,
    role: str = "implementation",
    target_agent: str = "aria-implementer",
    exit_code: int | None = None,
) -> dict:
    return {
        "$schema": "aria/dispatch-result/v1",
        "schema_version": 1,
        "request_id": request_id,
        "role": role,
        "target_agent": target_agent,
        "provider": provider,
        "model": model,
        "outcome": outcome,
        "failure_class": failure_class,
        "retryable": retryable,
        "failure_detail_code": detail_code,
        "exit_code": exit_code,
    }


class _DrainHarness:
    """Fake next-pending + child dispatch, with per-child v1 summaries."""

    def __init__(
        self,
        queue: list[dict],
        summaries: dict[str, dict],
        child_returncodes: dict[str, int] | None = None,
    ) -> None:
        self.queue = queue
        self.summaries = summaries
        self.child_returncodes = child_returncodes or {}
        self.dispatched: list[tuple[str, str]] = []
        self.child_envs: dict[str, dict[str, str]] = {}
        self.exclude_sets: list[set[str]] = []
        self.governance_rows: list[tuple[str, dict]] = []
        self.breaker_records: list[dict] = []
        self.breaker_state = "ok"
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)

    def _fake_run(self, argv, **kwargs):  # noqa: ANN001, ANN003 — mock signature
        if "next-pending" in argv:
            excluded = {
                argv[i + 1] for i, a in enumerate(argv) if a == "--exclude"
            }
            self.exclude_sets.append(excluded)
            for row in self.queue:
                rid = row.get("request_id")
                if rid and rid not in excluded:
                    return _FakeProc(stdout=json.dumps(row))
            return _FakeProc(stdout="null")
        # Child dispatch: [python3, <ci_executor.py>, request_id, (target)]
        request_id = argv[2]
        target = argv[3] if len(argv) > 3 else ""
        self.dispatched.append((request_id, target))
        self.child_envs[request_id] = dict(kwargs["env"])
        summary = self.summaries.get(request_id)
        child_output = Path(kwargs["env"]["GITHUB_OUTPUT"])
        rc = self.child_returncodes.get(request_id, 0 if summary and summary["outcome"] == "succeeded" else 1)
        if summary is not None:
            summary_path = self.tmp / f"dispatch-result-{request_id}.json"
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            child_output.write_text(
                f"dispatch_summary_path={summary_path}\n", encoding="utf-8",
            )
        return _FakeProc(returncode=rc)

    def run_drain(self) -> int:
        tools_dir = self.tmp / "aria-tools"
        tools_dir.mkdir(parents=True, exist_ok=True)
        gov = self.governance_rows.append
        with patch.object(
            ci_executor_drain.subprocess, "run", side_effect=self._fake_run,
        ), patch.object(
            ci_executor_drain, "_record_breaker_failure",
            side_effect=lambda *args, **kw: self.breaker_records.append(kw),
        ), patch.object(
            ci_executor_drain, "_breaker_state",
            side_effect=lambda tools: self.breaker_state,
        ), patch.object(
            ci_executor_drain._engine, "_append_tools_governance",
            side_effect=lambda _tools, event, payload: gov((event, payload)),
        ), patch.object(
            # The classification under test is independent of the operator's
            # live executor block (aria-config/genesis_policy.json turns
            # worktree_per_request on since B8); the serial shared-checkout
            # lane keeps every subprocess a next-pending or a child, and the
            # worktree provisioning has its own tests
            # (test_executor_request_worktree.py).
            ci_executor_drain, "_executor_policy",
            return_value={"max_concurrent": 1, "worktree_per_request": False},
        ):
            return ci_executor_drain.drain_pending(
                tools_dir=tools_dir, repo_root=_REPO_ROOT,
            )

    def payload(self) -> dict:
        events = [p for e, p in self.governance_rows if e == "executor_drain_completed"]
        assert events, "drain must append executor_drain_completed"
        return events[-1]

    def close(self) -> None:
        self._tmp.cleanup()


def _row(
    rid: str,
    target: str = "aria-implementer",
    role: str = "implementation",
    target_sha: str = "",
) -> dict:
    return {
        "request_id": rid,
        "target_agent": target,
        "role": role,
        "target_sha": target_sha,
    }


_SHA_A = "a" * 40
_SHA_B = "b" * 40


class SameRunCircuitTests(unittest.TestCase):
    def test_non_retryable_provider_failure_opens_same_run_circuit(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1"), _row("AIR-2")],
            summaries={
                "AIR-1": _summary(
                    request_id="AIR-1", outcome="failed",
                    failure_class="auth_failed", retryable=False,
                    detail_code="session_expired",
                ),
                "AIR-2": _summary(request_id="AIR-2", outcome="succeeded"),
            },
        )
        try:
            rc = h.run_drain()
            self.assertEqual([r for r, _ in h.dispatched], ["AIR-1"])
            self.assertEqual(
                h.payload()["circuit_breakers"],
                [f"anthropic/{_IMPL_MODEL}/auth_failed"],
            )
            self.assertEqual(rc, 1)
        finally:
            h.close()

    def test_open_circuit_skips_without_claiming_or_attempting(self) -> None:
        h = _DrainHarness(
            queue=[
                _row("AIR-1"), _row("AIR-2"),
                _row("AIR-3", target="aria-adversarial-judge", role="adversarial_judgment"),
            ],
            summaries={
                "AIR-1": _summary(
                    request_id="AIR-1", outcome="failed",
                    failure_class="credit_exhausted", retryable=False,
                ),
                # Different vendor route: must still dispatch.
                "AIR-3": _summary(
                    request_id="AIR-3", outcome="succeeded", model=_ADV_MODEL,
                    provider="zai",
                    target_agent="aria-adversarial-judge",
                    role="adversarial_judgment",
                ),
            },
        )
        try:
            h.run_drain()
            self.assertEqual(
                [r for r, _ in h.dispatched], ["AIR-1", "AIR-3"],
            )
            payload = h.payload()
            # AIR-2 was never dispatched and never counted attempted.
            self.assertEqual(payload["attempted"], 2)
            # The skip reached the kernel through --exclude, not by claiming.
            self.assertTrue(any("AIR-2" in ex for ex in h.exclude_sets))
        finally:
            h.close()

    def test_refusal_never_counts_as_breaker_failure(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1"), _row("AIR-2")],
            summaries={
                "AIR-1": _summary(request_id="AIR-1", outcome="refused", exit_code=1),
                "AIR-2": _summary(request_id="AIR-2", outcome="succeeded"),
            },
        )
        try:
            h.run_drain()
            payload = h.payload()
            self.assertEqual(payload["circuit_breakers"], [])
            counts = payload["failure_counts"]
            self.assertNotIn("auth_failed", counts)
            self.assertEqual([r for r, _ in h.dispatched], ["AIR-1", "AIR-2"])
        finally:
            h.close()


class GovernanceAggregateTests(unittest.TestCase):
    def test_governance_event_contains_failure_counts_and_details(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1")],
            summaries={
                "AIR-1": _summary(
                    request_id="AIR-1", outcome="failed",
                    failure_class="policy_violation", retryable=False,
                    detail_code="model_not_served_by_claude_runtime",
                ),
            },
        )
        try:
            h.run_drain()
            payload = h.payload()
            self.assertEqual(payload["schema_version"], 2)
            self.assertEqual(payload["failure_counts"], {"policy_violation": 1})
            self.assertEqual(payload["stop_reason"], "queue_empty")
            self.assertEqual(payload["breaker_state"], "ok")
            self.assertEqual(len(payload["failure_details"]), 1)
            detail = payload["failure_details"][0]
            self.assertEqual(detail["request_id"], "AIR-1")
            self.assertEqual(detail["failure_class"], "policy_violation")
            self.assertEqual(detail["provider"], "anthropic")
            self.assertEqual(detail["model"], _IMPL_MODEL)
        finally:
            h.close()

    def test_provider_model_role_breakdown_reconciles_to_attempted(self) -> None:
        h = _DrainHarness(
            queue=[
                _row("AIR-1"),
                _row("AIR-2"),
                _row("AIR-3", target="aria-evidence-judge", role="evidence_judgment"),
            ],
            summaries={
                "AIR-1": _summary(request_id="AIR-1", outcome="succeeded"),
                "AIR-2": _summary(
                    request_id="AIR-2", outcome="failed",
                    failure_class="timeout", retryable=True, detail_code="subprocess_timeout",
                ),
                "AIR-3": _summary(
                    request_id="AIR-3", outcome="succeeded", model=_JUDGE_MODEL,
                    target_agent="aria-evidence-judge", role="evidence_judgment",
                ),
            },
        )
        try:
            h.run_drain()
            payload = h.payload()
            breakdown = payload["by_provider_model_role"]
            attempted = sum(b["attempted"] for b in breakdown.values())
            self.assertEqual(attempted, payload["attempted"])
            key = f"anthropic/{_IMPL_MODEL}/implementation"
            self.assertEqual(breakdown[key]["attempted"], 2)
            self.assertEqual(breakdown[key]["succeeded"], 1)
            self.assertEqual(breakdown[key]["failed"], 1)
            self.assertEqual(breakdown[key]["failure_classes"], {"timeout": 1})
        finally:
            h.close()


class PersistentBreakerTests(unittest.TestCase):
    def test_repeated_environment_failures_trip_persistent_breaker(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1"), _row("AIR-2")],
            summaries={
                "AIR-1": _summary(
                    request_id="AIR-1", outcome="failed",
                    failure_class="auth_failed", retryable=False,
                ),
            },
        )
        try:
            h.run_drain()
            kinds = [r["kind"] for r in h.breaker_records]
            self.assertIn("executor_environment_failure", kinds)
            env = h.breaker_records[0]
            self.assertEqual(env["extra"]["failure_class"], "auth_failed")
            self.assertEqual(env["extra"]["provider"], "anthropic")
        finally:
            h.close()

    def test_failure_to_persistent_kind_mapping_is_closed(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1"), _row("AIR-9")],
            summaries={
                "AIR-1": _summary(
                    request_id="AIR-1", outcome="failed",
                    failure_class="timeout", retryable=True,
                ),
            },
        )
        try:
            h.run_drain()
            kinds = sorted({r["kind"] for r in h.breaker_records})
            self.assertEqual(kinds, ["subprocess_timeout"])
        finally:
            h.close()


class SummaryIsTheOnlyEvidenceOfSuccess(unittest.TestCase):
    """B8 (2026-09-12) — a child that exited 0 WITHOUT a dispatch summary was
    counted as succeeded and drained. Under managed_subscription the native
    admission's target_revision_mismatch refusal exits 0 with no summary
    whenever main has moved past a request's target_sha — a routine outcome
    — so a night of orphaned requests read as a green drain (verified:
    child (0, no output) -> succeeded=1, drained=1, rc 0). The child now
    NAMES that refusal in its summary; the drain counts nothing but a
    ``succeeded`` summary as drained and names a summary-less child."""

    def test_an_exit_zero_child_without_a_summary_is_a_named_failure_not_a_success(self) -> None:
        h = _DrainHarness(queue=[_row("AIR-1")], summaries={}, child_returncodes={"AIR-1": 0})
        try:
            rc = h.run_drain()
            payload = h.payload()
            self.assertEqual((payload["attempted"], payload["succeeded"], payload["failed"]), (1, 0, 1))
            self.assertEqual(payload["failure_counts"], {ci_executor_drain.CHILD_WITHOUT_SUMMARY_FAILURE_CLASS: 1})
            detail = payload["failure_details"][0]
            self.assertEqual(detail["failure_class"], "child_without_summary")
            self.assertEqual(detail["detail_code"], "exit_0")
            self.assertEqual(rc, 1, "silence is not success; the drain is red and says why")
            # Not an environment condition: no circuit, no persistent breaker row.
            self.assertEqual(payload["circuit_breakers"], [])
            self.assertEqual(h.breaker_records, [])
        finally:
            h.close()

    def test_a_target_mismatch_refusal_is_neither_drained_nor_red(self) -> None:
        # The child's own summary for the routine managed_subscription
        # outcome: refused, policy_violation, detail target_revision_mismatch,
        # exit 0 (a refusal is a legitimate terminal, not a build failure).
        h = _DrainHarness(
            queue=[_row("AIR-1"), _row("AIR-2")],
            summaries={
                "AIR-1": _summary(request_id="AIR-1", outcome="refused", failure_class="policy_violation",
                                  detail_code="target_revision_mismatch", exit_code=0),
                "AIR-2": _summary(request_id="AIR-2", outcome="succeeded"),
            },
            child_returncodes={"AIR-1": 0},
        )
        try:
            rc = h.run_drain()
            payload = h.payload()
            self.assertEqual((payload["attempted"], payload["succeeded"], payload["failed"]), (2, 1, 0))
            self.assertEqual(rc, 0)
            bucket = payload["by_provider_model_role"][f"anthropic/{_IMPL_MODEL}/implementation"]
            self.assertEqual((bucket["attempted"], bucket["succeeded"], bucket["failed"]), (2, 1, 0))
            self.assertEqual(payload["circuit_breakers"], [])
            self.assertEqual(h.breaker_records, [])
        finally:
            h.close()

    def test_the_drain_hands_the_child_the_summary_channel(self) -> None:
        # RUNNER_TEMP is where the child writes its summary; the drain passes
        # the same base it reads the child's GITHUB_OUTPUT from, so a local
        # drain (no RUNNER_TEMP in the environment) cannot make every child
        # summary-less by construction.
        h = _DrainHarness(queue=[_row("AIR-1")], summaries={"AIR-1": _summary(request_id="AIR-1", outcome="succeeded")})
        try:
            with patch.dict(os.environ, {"RUNNER_TEMP": str(h.tmp)}):
                h.run_drain()
            env = h.child_envs["AIR-1"]
            self.assertEqual(env["RUNNER_TEMP"], str(h.tmp))
            self.assertEqual(Path(env["GITHUB_OUTPUT"]).parent, h.tmp)
            # ... and the store: a worktree child's `<cwd>/aria-tools` would be
            # the tracked skeleton at target_sha, not the drain's store.
            self.assertEqual(env["ARIA_TOOLS_DIR"], str(h.tmp / "aria-tools"))
        finally:
            h.close()

    def test_a_summary_less_child_with_a_nonzero_exit_names_the_same_class(self) -> None:
        h = _DrainHarness(queue=[_row("AIR-1")], summaries={}, child_returncodes={"AIR-1": 3})
        try:
            rc = h.run_drain()
            self.assertEqual(rc, 1)
            detail = h.payload()["failure_details"][0]
            self.assertEqual((detail["failure_class"], detail["detail_code"]), ("child_without_summary", "exit_3"))
        finally:
            h.close()

    def test_the_drain_source_never_reads_an_exit_code_as_success(self) -> None:
        # The pre-fix expression, pinned absent: `outcome is None and
        # child.returncode == 0` was the false green.
        source = Path(ci_executor_drain.__file__).read_text(encoding="utf-8")
        self.assertNotIn("child.returncode == 0", source)
        self.assertIn('elif outcome == "succeeded":', source)


class TargetShaJoinTests(unittest.TestCase):
    def test_uniform_target_sha_joins_into_the_drain_row(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1", target_sha=_SHA_A), _row("AIR-2", target_sha=_SHA_A)],
            summaries={
                "AIR-1": _summary(request_id="AIR-1", outcome="succeeded"),
                "AIR-2": _summary(request_id="AIR-2", outcome="succeeded"),
            },
        )
        try:
            h.run_drain()
            self.assertEqual(h.payload()["target_sha"], _SHA_A)
        finally:
            h.close()

    def test_mixed_target_shas_join_as_empty_not_fabricated(self) -> None:
        h = _DrainHarness(
            queue=[_row("AIR-1", target_sha=_SHA_A), _row("AIR-2", target_sha=_SHA_B)],
            summaries={
                "AIR-1": _summary(request_id="AIR-1", outcome="succeeded"),
                "AIR-2": _summary(request_id="AIR-2", outcome="succeeded"),
            },
        )
        try:
            h.run_drain()
            self.assertEqual(h.payload()["target_sha"], "")
        finally:
            h.close()


if __name__ == "__main__":
    unittest.main()


class AnOpenRouteEndsTheDrainByName(unittest.TestCase):
    """ARIA-HIGH-158 — an open circuit skipped every remaining request one
    selection at a time (~30 s each on the live store): the first production
    drain walked the 800-row backlog for hours after two failures. A streak
    of skips ends the drain by name; the queue stays pending."""

    def test_a_streak_of_circuit_skips_stops_instead_of_walking_the_queue(self) -> None:
        from ci_executor_drain import CIRCUIT_SKIP_STREAK_STOP

        queue = [_row("AIR-0")] + [_row(f"AIR-{i}") for i in range(1, CIRCUIT_SKIP_STREAK_STOP + 4)]
        h = _DrainHarness(
            queue=queue,
            summaries={
                "AIR-0": _summary(
                    request_id="AIR-0", outcome="failed",
                    failure_class="credit_exhausted", retryable=False,
                ),
            },
        )
        try:
            h.run_drain()
            self.assertEqual([r for r, _ in h.dispatched], ["AIR-0"])
            payload = h.payload()
            self.assertEqual(payload["stop_reason"], "circuit_open_streak")
            self.assertEqual(payload["attempted"], 1)
            # The drain asked the kernel for work once per skip and no more:
            # the queue beyond the streak was never walked.
            self.assertLessEqual(len(h.exclude_sets), CIRCUIT_SKIP_STREAK_STOP + 2)
        finally:
            h.close()

    def test_a_dispatch_between_skips_resets_the_streak(self) -> None:
        from ci_executor_drain import CIRCUIT_SKIP_STREAK_STOP

        # Two open-route requests, then a request on another route, repeated:
        # the streak never reaches the stop and every other-route request runs.
        queue, summaries = [_row("AIR-0")], {
            "AIR-0": _summary(request_id="AIR-0", outcome="failed",
                              failure_class="credit_exhausted", retryable=False),
        }
        for i in range(1, 7):
            queue.append(_row(f"AIR-{i}"))
            if i % 3 == 0:
                queue[-1] = _row(f"AIR-{i}", target="aria-adversarial-judge", role="adversarial_judgment")
                summaries[f"AIR-{i}"] = _summary(
                    request_id=f"AIR-{i}", outcome="succeeded", model=_ADV_MODEL, provider="zai",
                    target_agent="aria-adversarial-judge", role="adversarial_judgment",
                )
        h = _DrainHarness(queue=queue, summaries=summaries)
        try:
            h.run_drain()
            self.assertEqual([r for r, _ in h.dispatched], ["AIR-0", "AIR-3", "AIR-6"])
            self.assertNotEqual(h.payload()["stop_reason"], "circuit_open_streak")
        finally:
            h.close()


class AFleetWideRefusalEndsTheDrainByName(unittest.TestCase):
    """ARIA-HIGH-159 — `no_eligible_provider` is a fact about the fleet, not
    the request: on 2026-09-19 (run 35429400706, login retired, Z.ai not yet
    in the job's env) every child was refused that way at ~35 s each and the
    drain would have walked the whole queue. A streak of fleet refusals ends
    the drain by name; per-request refusals never count."""

    def test_a_streak_of_fleet_refusals_stops_the_drain(self) -> None:
        from ci_executor_drain import CIRCUIT_SKIP_STREAK_STOP

        queue = [_row(f"AIR-{i}") for i in range(CIRCUIT_SKIP_STREAK_STOP + 4)]
        summaries = {
            f"AIR-{i}": _summary(request_id=f"AIR-{i}", outcome="refused",
                                 failure_class="policy_violation", detail_code="no_eligible_provider")
            for i in range(CIRCUIT_SKIP_STREAK_STOP + 4)
        }
        h = _DrainHarness(queue=queue, summaries=summaries)
        try:
            h.run_drain()
            payload = h.payload()
            self.assertEqual(payload["attempted"], CIRCUIT_SKIP_STREAK_STOP)
            self.assertEqual(payload["stop_reason"], "fleet_refusal_streak:no_eligible_provider")
            self.assertEqual(payload["failed"], 0, "a refusal is never a failure")
            self.assertEqual(payload["circuit_breakers"], [], "a refusal never opens a circuit")
        finally:
            h.close()

    def test_a_per_request_refusal_never_counts_toward_the_streak(self) -> None:
        from ci_executor_drain import CIRCUIT_SKIP_STREAK_STOP

        n = CIRCUIT_SKIP_STREAK_STOP + 3
        queue = [_row(f"AIR-{i}") for i in range(n)]
        summaries = {
            f"AIR-{i}": _summary(request_id=f"AIR-{i}", outcome="refused",
                                 failure_class="policy_violation", detail_code="target_revision_mismatch")
            for i in range(n)
        }
        h = _DrainHarness(queue=queue, summaries=summaries)
        try:
            h.run_drain()
            payload = h.payload()
            self.assertEqual(payload["attempted"], n)
            self.assertNotEqual(payload["stop_reason"], "fleet_refusal_streak:target_revision_mismatch")
        finally:
            h.close()

    def test_a_success_between_fleet_refusals_resets_the_streak(self) -> None:
        from ci_executor_drain import CIRCUIT_SKIP_STREAK_STOP

        queue, summaries = [], {}
        for i in range(2 * CIRCUIT_SKIP_STREAK_STOP):
            rid = f"AIR-{i}"
            queue.append(_row(rid))
            if i % 3 == 2:
                summaries[rid] = _summary(request_id=rid, outcome="succeeded")
            else:
                summaries[rid] = _summary(request_id=rid, outcome="refused",
                                          failure_class="policy_violation", detail_code="no_eligible_provider")
        h = _DrainHarness(queue=queue, summaries=summaries)
        try:
            h.run_drain()
            payload = h.payload()
            self.assertEqual(payload["attempted"], 2 * CIRCUIT_SKIP_STREAK_STOP)
            self.assertNotEqual(payload["stop_reason"], "fleet_refusal_streak:no_eligible_provider")
        finally:
            h.close()
