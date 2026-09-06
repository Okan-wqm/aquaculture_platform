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
        "$schema": "aria/dispatch-result/v2",
        "schema_version": 2,
        "phase": "submit",
        "disposition": "result_accepted" if outcome == "succeeded" else "released",
        "process_exit_code": 0 if outcome == "succeeded" else exit_code,
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
        self.exclude_sets: list[set[str]] = []
        self.governance_rows: list[tuple[str, dict]] = []
        self.breaker_records: list[dict] = []
        self.breaker_state = "ok"
        self.receipt_mutation = lambda receipt: receipt
        self.duplicate_receipt = False
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
        summary = self.summaries.get(request_id)
        child_output = Path(kwargs["env"]["GITHUB_OUTPUT"])
        rc = self.child_returncodes.get(request_id, 0 if summary and summary["outcome"] == "succeeded" else 1)
        if summary is not None:
            summary = dict(summary, attempt_id=kwargs["env"].get("ARIA_DISPATCH_ATTEMPT_ID", "attempt-before-fix"),
                           claim_id=f"claim-{request_id}",
                           exit_code=summary["exit_code"] if summary["exit_code"] is not None else rc)
            summary = self.receipt_mutation(summary)
            summary_path = self.tmp / f"dispatch-result-{request_id}.json"
            summary_path.write_text(json.dumps(summary), encoding="utf-8")
            child_output.write_text(
                f"dispatch_claim_id=claim-{request_id}\n"
                + f"dispatch_summary_path={summary_path}\n" * (2 if self.duplicate_receipt else 1), encoding="utf-8",
            )
        return _FakeProc(returncode=rc)

    def run_drain(self) -> int:
        tools_dir = self.tmp / "aria-tools"
        tools_dir.mkdir(parents=True, exist_ok=True)
        gov = self.governance_rows.append
        with patch.dict(os.environ, {"RUNNER_TEMP": str(self.tmp)}), patch.object(
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
    def test_process_success_cannot_override_child_submit_failure(self) -> None:
        h = _DrainHarness(queue=[_row("AIR-1")], summaries={"AIR-1": _summary(request_id="AIR-1", outcome="succeeded")}, child_returncodes={"AIR-1": 1})
        try:
            self.assertEqual(h.run_drain(), 1)
            self.assertEqual(h.payload()["succeeded"], 0)
        finally:
            h.close()

    def test_missing_summary_with_zero_exit_is_not_success(self) -> None:
        h = _DrainHarness(queue=[_row("AIR-1")], summaries={}, child_returncodes={"AIR-1": 0})
        try:
            self.assertEqual(h.run_drain(), 1)
            self.assertEqual(h.payload()["succeeded"], 0)
        finally:
            h.close()

    def test_refusal_requires_confirmed_release(self) -> None:
        for disposition in ("unresolved", "release_failed"):
            h = _DrainHarness(queue=[_row("AIR-1")], summaries={"AIR-1": _summary(request_id="AIR-1", outcome="refused")})
            h.receipt_mutation = lambda receipt: {**receipt, "disposition": disposition}
            try:
                self.assertEqual(h.run_drain(), 1)
                self.assertEqual(h.payload()["failed"], 1)
            finally:
                h.close()

    def test_malformed_stale_and_duplicate_receipts_are_not_admitted(self) -> None:
        mutations = [
            lambda r: [], lambda r: {**r, "$schema": "aria/dispatch-result/v1"},
            lambda r: {**r, "attempt_id": "old-attempt"},
            lambda r: {**r, "request_id": "AIR-other"},
            lambda r: {**r, "claim_id": "old-claim"},
            lambda r: {**r, "exit_code": 1},
            lambda r: {**r, "disposition": "released"},
            lambda r: {k: v for k, v in r.items() if k != "failure_detail_code"},
            lambda r: {**r, "process_exit_code": False},
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                h = _DrainHarness(queue=[_row("AIR-1")], summaries={"AIR-1": _summary(request_id="AIR-1", outcome="succeeded")})
                h.receipt_mutation = mutate
                try:
                    self.assertEqual(h.run_drain(), 1)
                    self.assertEqual(h.payload()["succeeded"], 0)
                finally:
                    h.close()
        h = _DrainHarness(queue=[_row("AIR-1")], summaries={"AIR-1": _summary(request_id="AIR-1", outcome="succeeded")})
        h.duplicate_receipt = True
        try:
            self.assertEqual(h.run_drain(), 1)
            self.assertEqual(h.payload()["succeeded"], 0)
        finally:
            h.close()

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
                    failure_class="provider_redirect_unavailable", retryable=False,
                    detail_code="provider_redirect_token_missing",
                ),
            },
        )
        try:
            h.run_drain()
            payload = h.payload()
            self.assertEqual(payload["schema_version"], 2)
            self.assertEqual(payload["failure_counts"], {"provider_redirect_unavailable": 1})
            self.assertEqual(payload["stop_reason"], "queue_empty")
            self.assertEqual(payload["breaker_state"], "ok")
            self.assertEqual(len(payload["failure_details"]), 1)
            detail = payload["failure_details"][0]
            self.assertEqual(detail["request_id"], "AIR-1")
            self.assertEqual(detail["failure_class"], "provider_redirect_unavailable")
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
