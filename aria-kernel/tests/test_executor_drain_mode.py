"""Drain-mode tests for the scheduled executor lane.

WHY this file exists: the nightly executor claimed exactly ONE request per
run while the producer mints many per cycle, so the queue only ever grew
(162 pending judge requests by 2026-08-11). `MAX_REQUESTS_PER_RUN` was
exported by the workflow and read by nothing — the "tunable that gates
nothing" class ci_executor.py itself condemns at ORPHAN-HIGH-472.
`drain_pending` makes the cap real; these tests pin its contract:

* each request runs through the LOCKED single-request argv as a subprocess
  (invariant I-V3-21), with `target_agent` passed through from the row;
* a request that comes back pending after being attempted stops the loop
  (an environment fault must not be priced as N request failures);
* the cap and the aggregate GITHUB_OUTPUT contract hold;
* any child failure turns the run red WITHOUT discarding the successes.
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
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402
import ci_executor_drain  # noqa: E402


class _FakeProc:
    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = ""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def _succeeded_summary(request_id: str, target: str | None) -> dict:
    """The `aria/dispatch-result/v1` row a completed child publishes."""
    return {
        "$schema": "aria/dispatch-result/v1", "schema_version": 1, "request_id": request_id,
        "role": "evidence_judgment", "target_agent": target or "aria-evidence-judge",
        "provider": "anthropic", "model": "opus", "outcome": "succeeded",
        "failure_class": None, "retryable": False, "failure_detail_code": None, "exit_code": 0,
    }


def _drain(queue, child_results, env=None, tmp=None):
    """Run drain_pending against a scripted queue.

    ``queue`` is consumed one row per next-pending call (None → "null").
    ``child_results`` maps request_id → (exit_code, publish_paths_bool).
    Returns (exit_code, calls, github_output_text).
    """
    calls = {"next_pending": 0, "dispatch": []}
    out_dir = Path(tmp)
    parent_output = out_dir / "github-output.txt"
    parent_output.write_text("", encoding="utf-8")

    def fake_run(argv, **kwargs):
        if "next-pending" in argv:
            calls["next_pending"] += 1
            excluded = {argv[i + 1] for i, tok in enumerate(argv) if tok == "--exclude"}
            role = next((argv[i + 1] for i, tok in enumerate(argv) if tok == "--role"), None)
            row = None
            for candidate in queue:
                if candidate is None:
                    continue
                if candidate.get("request_id") in excluded:
                    continue
                if role is not None and candidate.get("role", "evidence_judgment") != role:
                    continue
                row = candidate
                break
            if row is not None:
                queue.remove(row)
            return _FakeProc(stdout=json.dumps(row) if row else "null")
        # Child dispatch: argv is [python3, <script>, request_id, (target)].
        request_id = argv[2]
        target = argv[3] if len(argv) > 3 else None
        calls["dispatch"].append((request_id, target))
        exit_code, publishes = child_results[request_id]
        child_output = Path(kwargs["env"]["GITHUB_OUTPUT"])
        lines = []
        if publishes:
            lines += [f"envelope_path=outputs/{request_id}.md",
                      f"transcript_path=outputs/{request_id}.transcript.jsonl"]
        if exit_code == 0 and publishes:
            # What a real child that ran to completion writes: its v1 summary
            # (B8 — the summary, never the exit code, is the drain's evidence
            # of success). A child scripted as (0, False) is one that exited 0
            # and said nothing, which the drain must NOT count as drained.
            summary_path = Path(kwargs["env"]["RUNNER_TEMP"]) / f"dispatch-result-{request_id}.json"
            summary_path.write_text(json.dumps(_succeeded_summary(request_id, target)), encoding="utf-8")
            lines.append(f"dispatch_summary_path={summary_path}")
        if lines:
            child_output.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
        return _FakeProc(returncode=exit_code)

    env_vars = {
        "GITHUB_OUTPUT": str(parent_output),
        "RUNNER_TEMP": str(out_dir),
        **(env or {}),
    }
    with patch.dict(os.environ, env_vars), patch.object(
        ci_executor_drain.subprocess, "run", side_effect=fake_run
    ), patch.object(
        # The loop contract under test is independent of the operator's live
        # executor block (worktree_per_request is on since B8); the serial
        # shared-checkout lane keeps every subprocess a next-pending or a
        # child. Worktree provisioning: test_executor_request_worktree.py.
        ci_executor_drain, "_executor_policy",
        return_value={"max_concurrent": 1, "worktree_per_request": False},
    ):
        rc = ci_executor_drain.drain_pending(
            tools_dir=out_dir / "aria-tools", repo_root=_REPO_ROOT
        )
    return rc, calls, parent_output.read_text(encoding="utf-8")


class DrainPendingTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_drains_queue_to_empty_and_aggregates_outputs(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-cross-reviewer"},
            None,
        ]
        rc, calls, output = _drain(
            queue,
            {"AIR-1": (0, True), "AIR-2": (0, True)},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        # target_agent flows through — the single-shot workflow path dropped
        # it, running every request under the evidence-judge default profile.
        self.assertEqual(
            calls["dispatch"],
            [("AIR-1", "aria-evidence-judge"), ("AIR-2", "aria-cross-reviewer")],
        )
        self.assertIn("outputs/AIR-1.md", output)
        self.assertIn("outputs/AIR-2.md", output)
        self.assertIn("drained=2\n", output)
        self.assertIn("drain_failed=0\n", output)

    def test_an_exit_zero_child_that_published_no_summary_is_not_drained(self) -> None:
        # B8 — the false green: a child that exits 0 without its dispatch
        # summary (the native admission's target_revision_mismatch refusal
        # before this fix) used to count as drained=1 with rc 0. The
        # summary, not the exit code, is the evidence of success; silence
        # is a named failure and the run is red.
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-evidence-judge"},
        ]
        rc, calls, output = _drain(
            queue, {"AIR-1": (0, False), "AIR-2": (0, True)}, tmp=self._tmp.name
        )
        self.assertEqual(rc, 1)
        self.assertEqual([rid for rid, _ in calls["dispatch"]], ["AIR-1", "AIR-2"])
        self.assertIn("drained=1\n", output)
        self.assertIn("drain_failed=1\n", output)

    def test_poison_request_is_skipped_not_fatal(self) -> None:
        # E3/F10 — AIR-1 fails and releases its claim; the kernel-side
        # exclusion steps past it and the night CONTINUES with AIR-2.
        # Pre-fix, "repeat_request" ended the entire drain here.
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-evidence-judge"},
        ]
        rc, calls, output = _drain(
            queue, {"AIR-1": (1, False), "AIR-2": (0, True)}, tmp=self._tmp.name
        )
        self.assertEqual(rc, 1)  # the failure is still reported
        self.assertEqual(
            [rid for rid, _ in calls["dispatch"]], ["AIR-1", "AIR-2"]
        )
        self.assertIn("drained=1\n", output)
        self.assertIn("drain_failed=1\n", output)

    def test_priority_roles_run_before_judges(self) -> None:
        # D10b — an older judge request must NOT starve a younger
        # lane-unlocking request.
        queue = [
            {"request_id": "AIR-judge", "target_agent": "aria-evidence-judge", "role": "evidence_judgment"},
            {"request_id": "AIR-impl", "target_agent": "aria-implementer", "role": "implementation"},
        ]
        rc, calls, _ = _drain(
            queue,
            {"AIR-judge": (0, True), "AIR-impl": (0, True)},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(
            [rid for rid, _ in calls["dispatch"]], ["AIR-impl", "AIR-judge"]
        )

    def test_quota_round_reaches_roles_behind_judge_volume(self) -> None:
        # Y4 (ORPHAN-705) — the measured starvation: maintenance_utility and
        # adjudication envelopes queued behind 64 judges at ~9 drains/night.
        # The quota round must hand every WAITING role one slot before any
        # role gets a second — so the younger maintenance envelope outranks
        # the older judges' second slot, and judges still drain afterwards.
        # ORPHAN-HIGH-786 moved the judge roles earlier in the arc (they
        # were LAST, and the fallback budget died before reaching them),
        # so the quota round now serves the judge lane first — but the
        # PROPERTY this test pins is unchanged: the second judge envelope
        # (a surplus slot) still drains only AFTER adjudication and
        # maintenance have each received their guaranteed one.
        queue = [
            {"request_id": "AIR-judge-old-1", "target_agent": "aria-evidence-judge", "role": "evidence_judgment"},
            {"request_id": "AIR-judge-old-2", "target_agent": "aria-evidence-judge", "role": "evidence_judgment"},
            {"request_id": "AIR-mu", "target_agent": "aria-autonomy-planner", "role": "maintenance_utility"},
            {"request_id": "AIR-adj", "target_agent": "aria-consensus-arbiter", "role": "human_required_adjudication"},
        ]
        rc, calls, _ = _drain(
            queue,
            {
                "AIR-judge-old-1": (0, True), "AIR-judge-old-2": (0, True),
                "AIR-mu": (0, True), "AIR-adj": (0, True),
            },
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        order = [rid for rid, _ in calls["dispatch"]]
        # Quota round (arc order): ONE judge (judges lead the arc since
        # ORPHAN-HIGH-786), then adjudication, then maintenance; the second
        # judge is a surplus slot and only drains in the fallback.
        self.assertEqual(
            order,
            ["AIR-judge-old-1", "AIR-adj", "AIR-mu", "AIR-judge-old-2"],
        )
        self.assertLess(order.index("AIR-adj"), order.index("AIR-judge-old-2"))
        self.assertLess(order.index("AIR-mu"), order.index("AIR-judge-old-2"))

    def test_max_requests_cap_is_real(self) -> None:
        queue = [
            {"request_id": f"AIR-{i}", "target_agent": "aria-evidence-judge"}
            for i in range(5)
        ]
        rc, calls, _ = _drain(
            queue,
            {f"AIR-{i}": (0, True) for i in range(5)},
            env={"MAX_REQUESTS_PER_RUN": "2"},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls["dispatch"]), 2)

    def test_one_failure_makes_the_run_red_but_finishes_the_queue(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            {"request_id": "AIR-2", "target_agent": "aria-evidence-judge"},
            None,
        ]
        rc, calls, output = _drain(
            queue,
            {"AIR-1": (1, False), "AIR-2": (0, True)},
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 1)
        self.assertEqual(len(calls["dispatch"]), 2)
        self.assertIn("drained=1\n", output)
        self.assertIn("drain_failed=1\n", output)

    def test_main_routes_drain_flag(self) -> None:
        with patch.object(ci_executor_drain, "drain_pending", return_value=0) as dp:
            rc = ci_executor.main(["--drain"])
        self.assertEqual(rc, 0)
        dp.assert_called_once()


if __name__ == "__main__":
    unittest.main()


class DrainBudgetWorstCaseTests(unittest.TestCase):
    """Run 31542485896 — the budget must price the NEXT child's worst case.

    Elapsed-only accounting started a request at t=1987s of a 2100s budget;
    that child could legally run 1800s more, sailed past the job reaper, and
    the run was cancelled before the state publish — two submitted results
    died with the runner. The loop now starts a child only when
    elapsed + the child's WHOLE worst case (`ci_executor.child_worst_case_seconds`:
    claim, pre-claim probe, CLI run at MAX_TIMEOUT_SECONDS, submit, release)
    still fits inside the budget.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_no_child_starts_when_worst_case_overflows_budget(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
        ]
        # Budget 100s, child worst case 1800s: even at elapsed=0 the worst
        # case cannot fit, so NOTHING is dispatched and the loop reports a
        # clean budget stop instead of gambling on a fast child.
        rc, calls, output = _drain(
            queue,
            {"AIR-1": (0, True)},
            env={
                "ARIA_DRAIN_BUDGET_SECONDS": "100",
                "MAX_TIMEOUT_SECONDS": "1800",
            },
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(calls["dispatch"], [])
        self.assertIn("drained=0\n", output)

    def test_child_starts_when_worst_case_fits(self) -> None:
        queue = [
            {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
            None,
        ]
        # A window that holds one whole child at its worst case, with room
        # for the loop's own setup — derived, so a retune of any bound the
        # worst case is built from cannot silently turn this into the
        # overflow case above.
        window = ci_executor.child_worst_case_seconds(1800) + 600
        rc, calls, _ = _drain(
            queue,
            {"AIR-1": (0, True)},
            env={
                "ARIA_DRAIN_BUDGET_SECONDS": str(window),
                "MAX_TIMEOUT_SECONDS": "1800",
            },
            tmp=self._tmp.name,
        )
        self.assertEqual(rc, 0)
        self.assertEqual(len(calls["dispatch"]), 1)

    def test_the_default_window_holds_one_child_at_its_worst_case(self) -> None:
        # The env-less default (a local drain, these tests) is derived from
        # the engine's own bounds, so it cannot again fall below one child's
        # worst case and dispatch nothing.
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MAX_TIMEOUT_SECONDS", None)
            os.environ.pop("ARIA_DRAIN_BUDGET_SECONDS", None)
            self.assertGreaterEqual(
                ci_executor_drain._drain_budget_seconds(),
                ci_executor._child_worst_case_seconds() + ci_executor_drain.DRAIN_WINDOW_MARGIN_SECONDS,
            )

    def test_a_request_whose_own_worst_case_exceeds_the_window_is_skipped_without_a_claim(self) -> None:
        # ARIA-HIGH-124 (round 3) — an implementation child runs its
        # delivery (the publication, the contained gate at the staged
        # ceiling per command, the push, the PR) after the CLI, priced off
        # the request's STAGED action once the request is known. A window
        # that holds a judge child but not this implementation's own worst
        # case skips the implementation by name — no claim, PENDING for a
        # drain with the room, a governance row — and keeps draining the
        # roles that fit; before this the delivery term was unpriced, and
        # the implementation was started into the window's edge.
        from aria_kernel.ledger import load_declared_jsonl

        judge_child = ci_executor.child_worst_case_seconds(1800)
        implementation_delivery = 4 * 2700
        queue = [
            {"request_id": "AIR-IMPL", "target_agent": "aria-implementer", "role": "implementation"},
            {"request_id": "AIR-JUDGE", "target_agent": "aria-evidence-judge", "role": "evidence_judgment"},
            None,
        ]
        with patch.object(
            ci_executor, "_request_delivery_seconds",
            side_effect=lambda *, tools_dir, request_id: implementation_delivery if request_id == "AIR-IMPL" else 0,
        ):
            rc, calls, output = _drain(
                queue,
                {"AIR-IMPL": (0, True), "AIR-JUDGE": (0, True)},
                env={
                    # Holds the judge child with room, not the implementation's.
                    "ARIA_DRAIN_BUDGET_SECONDS": str(judge_child + implementation_delivery - 1),
                    "MAX_TIMEOUT_SECONDS": "1800",
                },
                tmp=self._tmp.name,
            )
        self.assertEqual(rc, 0)
        self.assertEqual(calls["dispatch"], [("AIR-JUDGE", "aria-evidence-judge")])
        self.assertIn("drained=1\n", output)
        rows = [row for row in load_declared_jsonl(Path(self._tmp.name) / "aria-tools" / "governance.jsonl",
                                                    expected_surface="tools_governance")
                if row.get("kind") == "executor_drain_window_skip"]
        self.assertEqual([row["details"]["request_id"] for row in rows], ["AIR-IMPL"])
        self.assertEqual(rows[0]["details"]["worst_case_seconds"], judge_child + implementation_delivery)
        # With the room, the implementation is started first (the quota
        # round's first role) and priced at its whole worst case.
        queue = [
            {"request_id": "AIR-IMPL", "target_agent": "aria-implementer", "role": "implementation"},
            None,
        ]
        with patch.object(
            ci_executor, "_request_delivery_seconds",
            side_effect=lambda *, tools_dir, request_id: implementation_delivery,
        ):
            rc, calls, _ = _drain(
                queue, {"AIR-IMPL": (0, True)},
                env={"ARIA_DRAIN_BUDGET_SECONDS": str(judge_child + implementation_delivery + 60), "MAX_TIMEOUT_SECONDS": "1800"},
                tmp=self._tmp.name,
            )
        self.assertEqual((rc, calls["dispatch"]), (0, [("AIR-IMPL", "aria-implementer")]))

    def test_the_worst_case_is_the_whole_child(self) -> None:
        # A child's legal worst case is the claim child and its pre-claim
        # probe, the Claude CLI at MAX_TIMEOUT_SECONDS, the kernel submit at
        # SUBMIT_RESULT_TIMEOUT_SECONDS and the release child — the ONE
        # derivation `ci_executor.child_worst_case_seconds`. Pricing the CLI
        # cap alone let a submit that waited its full lock bound run past
        # the drain window into the publish reserve; pricing the CLI cap and
        # the submit alone left two lock waits and the probe to do the same.
        # One second short of the sum: nothing starts; the sum plus the
        # loop's own setup time (well under a minute): the child starts.
        worst_case = ci_executor.child_worst_case_seconds(1800)
        self.assertGreater(worst_case, 1800 + ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS)
        for budget, dispatched in ((worst_case - 1, 0), (worst_case + 60, 1)):
            with self.subTest(budget=budget):
                queue = [
                    {"request_id": "AIR-1", "target_agent": "aria-evidence-judge"},
                    None,
                ]
                rc, calls, _ = _drain(
                    queue,
                    {"AIR-1": (0, True)},
                    env={
                        "ARIA_DRAIN_BUDGET_SECONDS": str(budget),
                        "MAX_TIMEOUT_SECONDS": "1800",
                    },
                    tmp=self._tmp.name,
                )
                self.assertEqual(rc, 0)
                self.assertEqual(len(calls["dispatch"]), dispatched)


class DrainJudgeBatchTests(unittest.TestCase):
    """Typed-judgment plan Phase 4b — the drain fills a batch of judge
    siblings, launches ONE `--judge-batch` child for them, prices it as a
    batch, and accounts every member from its own summary."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _drain_batch(self, queue, *, batch_size, summaries_for, child_rc=0):
        """Like `_drain`, with the batch policy on and a child that writes
        one summary per member it was launched with (from `summaries_for`)."""
        from dispatch_failure import DispatchRoute

        calls = {"next_pending": [], "dispatch": []}
        out_dir = Path(self._tmp.name)
        parent_output = out_dir / "github-output.txt"
        parent_output.write_text("", encoding="utf-8")

        def fake_run(argv, **kwargs):
            if "next-pending" in argv:
                excluded = {argv[i + 1] for i, tok in enumerate(argv) if tok == "--exclude"}
                role = next((argv[i + 1] for i, tok in enumerate(argv) if tok == "--role"), None)
                agent = next((argv[i + 1] for i, tok in enumerate(argv) if tok == "--target-agent"), None)
                calls["next_pending"].append((role, agent, tuple(sorted(excluded))))
                row = None
                for candidate in queue:
                    if candidate is None or candidate.get("request_id") in excluded:
                        continue
                    if role is not None and candidate.get("role", "adversarial_judgment") != role:
                        continue
                    if agent is not None and candidate.get("target_agent") != agent:
                        continue
                    row = candidate
                    break
                return _FakeProc(stdout=json.dumps(row) if row else "null")
            if argv[2] == "--judge-batch":
                members = list(argv[5:])
                calls["dispatch"].append(("batch", argv[3], argv[4], tuple(members)))
            else:
                members = [argv[2]]
                calls["dispatch"].append(("single", argv[2], argv[3] if len(argv) > 3 else None, tuple(members)))
            child_output = Path(kwargs["env"]["GITHUB_OUTPUT"])
            lines = []
            for member in members:
                summary = summaries_for.get(member)
                if summary is None:
                    continue
                path = Path(kwargs["env"]["RUNNER_TEMP"]) / f"dispatch-result-{member}.json"
                path.write_text(json.dumps(summary), encoding="utf-8")
                lines.append(f"dispatch_summary_path={path}")
            if lines:
                child_output.write_text("".join(f"{line}\n" for line in lines), encoding="utf-8")
            return _FakeProc(returncode=child_rc)

        def fake_route(*, request, repo_root):
            return DispatchRoute(provider="zai", model="glm-5.3", role=str(request.get("role") or ""),
                                 target_agent=str(request.get("target_agent") or ""))

        env_vars = {"GITHUB_OUTPUT": str(parent_output), "RUNNER_TEMP": str(out_dir)}
        with patch.dict(os.environ, env_vars), patch.object(
            ci_executor_drain.subprocess, "run", side_effect=fake_run,
        ), patch.object(
            ci_executor_drain, "_executor_policy", return_value={"max_concurrent": 1, "worktree_per_request": False},
        ), patch.object(
            ci_executor_drain, "_judge_batch_policy", return_value=(batch_size, ("zai",)),
        ), patch.object(
            ci_executor_drain._dispatch_failure, "resolve_dispatch_route", side_effect=fake_route,
        ):
            rc = ci_executor_drain.drain_pending(tools_dir=out_dir / "aria-tools", repo_root=_REPO_ROOT)
        return rc, calls, parent_output.read_text(encoding="utf-8")

    @staticmethod
    def _judge(request_id: str, *, sha: str = "aaa", agent: str = "aria-adversarial-judge") -> dict:
        return {"request_id": request_id, "role": "adversarial_judgment", "target_agent": agent, "target_sha": sha}

    @staticmethod
    def _summary(request_id: str, outcome: str, *, failure_class=None, detail=None) -> dict:
        return {"$schema": "aria/dispatch-result/v1", "schema_version": 1, "request_id": request_id,
                "role": "adversarial_judgment", "target_agent": "aria-adversarial-judge", "provider": "zai",
                "model": "glm-5.3", "outcome": outcome, "failure_class": failure_class, "retryable": False,
                "failure_detail_code": detail, "exit_code": 0}

    def test_siblings_are_batched_and_accounted_per_request(self) -> None:
        queue = [self._judge("J-1"), self._judge("J-2"), self._judge("J-3"), None]
        rc, calls, output = self._drain_batch(
            queue, batch_size=3,
            summaries_for={"J-1": self._summary("J-1", "succeeded"), "J-2": self._summary("J-2", "succeeded"),
                           "J-3": self._summary("J-3", "refused", failure_class="response_schema_rejected",
                                                detail="judge_batch_item_unanswered")},
        )
        self.assertEqual(rc, 0)
        self.assertEqual(calls["dispatch"], [("batch", "adversarial_judgment", "aria-adversarial-judge", ("J-1", "J-2", "J-3"))])
        # The fill asked for siblings of the agent it holds.
        self.assertTrue(any(agent == "aria-adversarial-judge" for _role, agent, _ex in calls["next_pending"]))
        self.assertIn("drained=2\n", output)
        self.assertIn("drain_failed=0\n", output)

    def test_the_fill_stops_at_the_first_key_mismatch_without_excluding_it(self) -> None:
        queue = [self._judge("J-1"), self._judge("J-2", sha="bbb"), self._judge("J-3"), None]
        rc, calls, output = self._drain_batch(
            queue, batch_size=3,
            summaries_for={rid: self._summary(rid, "succeeded") for rid in ("J-1", "J-2", "J-3")},
        )
        self.assertEqual(rc, 0)
        # J-1 alone (J-2 is another anchor: the fill stopped), then J-2 alone
        # (J-3 differs from J-2), then J-3 — nothing was excluded for good.
        self.assertEqual([d[3] for d in calls["dispatch"]], [("J-1",), ("J-2",), ("J-3",)])
        self.assertIn("drained=3\n", output)

    def test_a_member_without_a_summary_is_a_named_failure_and_the_breaker_hears_the_child_once(self) -> None:
        queue = [self._judge("J-1"), self._judge("J-2"), None]
        recorded: list[dict] = []
        with patch.object(ci_executor_drain, "_record_breaker_failure", side_effect=lambda *a, **k: recorded.append(k)):
            rc, calls, output = self._drain_batch(
                queue, batch_size=2,
                summaries_for={"J-1": self._summary("J-1", "failed", failure_class="harness_unavailable", detail="x")},
                child_rc=1,
            )
        self.assertEqual([d[3] for d in calls["dispatch"]], [("J-1", "J-2")])
        self.assertIn("drain_failed=2\n", output)
        kinds = [k.get("kind") for k in recorded]
        self.assertEqual(len([k for k in kinds if k is not None]), len(set(kinds)),
                         "one breaker failure per kind per child, however many members")

    def test_batch_size_one_keeps_the_single_child(self) -> None:
        queue = [self._judge("J-1"), self._judge("J-2"), None]
        rc, calls, output = self._drain_batch(
            queue, batch_size=1, summaries_for={rid: self._summary(rid, "succeeded") for rid in ("J-1", "J-2")},
        )
        self.assertEqual([d[0] for d in calls["dispatch"]], ["single", "single"])
        self.assertIn("drained=2\n", output)
