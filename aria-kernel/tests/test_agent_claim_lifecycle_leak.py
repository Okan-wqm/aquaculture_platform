"""A claim nobody hands back is a request nobody can ever run again.

Measured on production state 2026-08-09: **ten of twelve** agent-invocation
requests had `claimed` as their latest event and no release. Nine requests
carrying a freshly-threaded `target_sha` sat behind them, untried.

The leak is permanent, not slow. `derive_request_state` reaches `PENDING` from
`CLAIMED` only through an explicit released/requeued event; once the 30-minute
lease expires the state derives `STALE`, and `next_pending_request` skips
`STALE` while `claim_request` refuses it. Both exits are closed.

Three independent holes fed it, and all three are closed here:

1. The submit-failure path was the ONE exit in `ci_executor.main` that did not
   release. A rejected result therefore held its claim forever.
2. `_release_claim` never read the subprocess return code, so a release that
   FAILED was indistinguishable from one that happened.
3. `reap_stale_claims` existed and was reachable only from the operator CLI —
   no cycle phase, no workflow. Its sibling `dispatch_lease_reap` runs every
   cycle but reaps a different ledger.
"""
from __future__ import annotations

import ast
import inspect
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import agent_invocations, cycle as cycle_mod

EXECUTOR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"


def _function(name: str) -> ast.FunctionDef:
    tree = ast.parse(EXECUTOR.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == name:
            return node
    raise AssertionError(f"{name} not found in ci_executor.py")


class ReleaseIsNeverSilentTest(unittest.TestCase):
    def test_the_release_helper_reads_its_own_return_code(self) -> None:
        # Node shape, not source text: Plan 026R §H.1 forbids asserting on
        # source markers, and a string match would pass on a commented-out
        # check. What matters is that the subprocess result is BOUND and its
        # returncode is read — an unbound `subprocess.run(...)` is the defect.
        fn = _function("_release_claim")

        assigned_runs = [
            node
            for node in ast.walk(fn)
            if isinstance(node, ast.Assign)
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and node.value.func.attr == "run"
        ]
        self.assertTrue(assigned_runs, "the release subprocess result must be captured")

        reads_returncode = any(
            isinstance(node, ast.Attribute) and node.attr == "returncode"
            for node in ast.walk(fn)
        )
        self.assertTrue(reads_returncode, "a failed release must not pass for a release")


class EveryFailureExitReleasesTest(unittest.TestCase):
    def test_no_early_return_abandons_a_held_claim(self) -> None:
        """Every `return 1` after the claim is taken must sit in a branch that
        releases it. This is the invariant the submit path broke."""
        # The lifecycle lives in `_main`; `main` is the exit-stack wrapper
        # around it (the split that made native runtime contexts owned).
        fn = _function("_main")

        # Statements that contain a `_release_claim(...)` call anywhere inside.
        def releases(node: ast.AST) -> bool:
            return any(
                isinstance(sub, ast.Call)
                and isinstance(sub.func, ast.Name)
                and sub.func.id == "_release_claim"
                for sub in ast.walk(node)
            )

        offenders: list[int] = []
        for node in ast.walk(fn):
            if not isinstance(node, (ast.If, ast.ExceptHandler)):
                continue
            body_returns_one = any(
                isinstance(sub, ast.Return)
                and isinstance(sub.value, ast.Constant)
                and sub.value.value == 1
                for sub in ast.walk(node)
            )
            if body_returns_one and not releases(node):
                offenders.append(node.lineno)

        # A claim is HELD from the guard that proves the lease exists
        # (`if not lease_token or not claim_id`) to the last release the
        # function can perform — after that the submit has appended the
        # result row and the claim is terminal by the kernel's own rule
        # (`_assert_lifecycle_mutation_allowed`), so the native
        # reconciliation exits behind it legitimately return without a
        # release. Guards before the lease exists have nothing to hand back.
        held_from = min(
            node.lineno
            for node in ast.walk(fn)
            if isinstance(node, ast.If)
            and "lease_token" in ast.dump(node.test)
            and "claim_id" in ast.dump(node.test)
        )
        held_until = max(
            node.lineno
            for node in ast.walk(fn)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_release_claim"
        )
        late_offenders = [line for line in offenders if held_from < line <= held_until]

        self.assertEqual(late_offenders, [], f"branches returning 1 without releasing: {late_offenders}")


class ARejectedResultIsTheClaimsTerminalEffect(unittest.TestCase):
    """ARIA-HIGH-078 — the kernel's REJECTED result row ends the claim; the
    executor must not try to hand back what the kernel already closed.

    Measured on the first live managed-Claude cross-review (2026-09-11): the
    submit refused `satisfaction_matrix[0].note required`, the kernel appended
    the rejected result row, and the executor's unconditional release then
    failed with `result already terminal` while reporting a CLAIMED leak
    that did not exist — the request derived REJECTED, as designed."""

    _LIVE_REJECTION = (
        '{\n  "reasons": ["response_schema: satisfaction_matrix[0].note required when verdict=\'contradicted\'"],\n'
        '  "row": {"$schema": "aria/agent-claim-result/v1", "claim_id": "claim_f7acce6ca4be2ad1",\n'
        '          "row_type": "result", "status": "rejected", "submission_effect": "result"},\n'
        '  "status": "rejected"\n}\n'
    )

    def test_the_kernels_rejected_row_is_recognised_and_a_pre_row_refusal_is_not(self) -> None:
        import sys

        if str(EXECUTOR.parent) not in sys.path:
            sys.path.insert(0, str(EXECUTOR.parent))
        import ci_executor as module

        self.assertTrue(module._rejected_result_recorded(self._LIVE_REJECTION))
        self.assertTrue(module._rejected_result_recorded("::warning:: something first\n" + self._LIVE_REJECTION))
        self.assertFalse(module._rejected_result_recorded('{"status": "rejected", "reason": "lease_token_invalid"}'))
        self.assertFalse(module._rejected_result_recorded("usage: aria_kernel agent submit-result [-h]"))
        self.assertFalse(module._rejected_result_recorded(""))

    def test_the_release_after_a_rejected_submit_is_conditional_on_the_row(self) -> None:
        fn = _function("_main")
        rejected_releases = [
            node for node in ast.walk(fn)
            if isinstance(node, ast.If) and "_rejected_result_recorded" in ast.dump(node.test)
        ]
        self.assertEqual(len(rejected_releases), 1)
        branch = rejected_releases[0]
        self.assertFalse(any(isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                             and sub.func.id == "_release_claim" for sub in ast.walk(ast.Module(body=branch.body, type_ignores=[]))),
                         "a recorded rejection releases nothing")
        self.assertTrue(any(isinstance(sub, ast.Call) and isinstance(sub.func, ast.Name)
                            and sub.func.id == "_release_claim" for sub in ast.walk(ast.Module(body=branch.orelse, type_ignores=[]))),
                        "a refusal before the row still releases")


class ClaimResponseCarriesWhatThePromptWasHashedOverTest(unittest.TestCase):
    def test_the_fused_claim_response_carries_the_repository_map(self) -> None:
        # The binding check compares the recorded prompt hash against one the
        # executor recomputes from this response. The hash was taken over a
        # render that INCLUDED the Twin slice, so a response without it makes
        # the check unsatisfiable — deterministically, for every request whose
        # evidence resolves against the map.
        #
        # This asserted a string literal inside claim_request until the fusion
        # moved into _fuse_prompt_envelope, and it went red on a change that
        # made the property STRONGER. A test that pins where a value is written
        # fails on refactors and passes on regressions; what matters is that
        # the response carries it, so that is what is asserted now.
        row = {
            "request_id": "AIR-fusion-carries-map",
            "repository_map": {"projects": ["aria-kernel"]},
            "cycle_id": "cyc-1",
        }

        fused = agent_invocations._fuse_prompt_envelope(row)

        self.assertEqual(fused["repository_map"], {"projects": ["aria-kernel"]})
        self.assertEqual(fused["cycle_id"], "cyc-1")


class ReaperRunsWithoutAHumanTest(unittest.TestCase):
    def test_the_agent_claim_reaper_is_a_cycle_phase(self) -> None:
        names = [phase.name for phase in cycle_mod.CYCLE_PHASES]

        self.assertIn("agent_claim_reap", names)

    def test_it_cannot_fail_the_cycle_and_records_its_result(self) -> None:
        phase = next(p for p in cycle_mod.CYCLE_PHASES if p.name == "agent_claim_reap")

        self.assertEqual(phase.on_error, "record_and_continue")
        self.assertEqual(phase.state_key, "agent_claim_reap")
        self.assertEqual(phase.precondition, cycle_mod.WRITES_PERMITTED)

    def test_it_reaps_the_agent_invocation_ledger_not_the_dispatch_one(self) -> None:
        # The sibling phase reaps `dispatch/claims.jsonl`. Reaping the wrong
        # ledger is exactly the mistake that let this one go unreaped while
        # looking covered.
        source = inspect.getsource(cycle_mod._phase_agent_claim_reap)

        self.assertIn("reap_stale_claims", source)


class _Fakes:
    """A release transport and a state reader the guard tests can script."""

    def __init__(self, state: str | None, *, accept: bool = True) -> None:
        self.state = state
        self.accept = accept
        self.releases: list[dict] = []
        self.stage_lines: list[str] = []

    def release(self, **kwargs) -> bool:
        self.releases.append(kwargs)
        return self.accept

    def derive(self, request_id: str, tools_dir: Path) -> str:
        if self.state is None:
            raise OSError("ledger unreadable")
        return self.state


def _held(fakes: _Fakes):
    import sys

    if str(EXECUTOR.parent) not in sys.path:
        sys.path.insert(0, str(EXECUTOR.parent))
    from ci_executor_lease import HeldClaim

    return HeldClaim(
        tools_dir=Path("/tools"), repo=Path("/repo"), request_id="AIR-guard", claim_id="claim_guard",
        agent_id="ci-executor:gha-guard", lease_token="lease-guard", release=fakes.release,
        derive_state=fakes.derive, log=fakes.stage_lines.append,
    )


class TheLeaseIsHandedBackOnEveryExit(unittest.TestCase):
    """The seven claims of 2026-09-04 (`ci-executor:gha-33920896040`) stayed
    CLAIMED because the refusal path raised before any release site. The
    guard is the floor beneath every site: the kernel's own derivation says
    whether the request is still held, and if it is, the exit releases it."""

    def test_an_uncaught_exception_releases_a_held_claim_naming_the_exception(self) -> None:
        fakes = _Fakes("CLAIMED")
        guard = _held(fakes)
        with self.assertRaises(RuntimeError):
            with guard:
                raise RuntimeError("the refusal path crashed")
        self.assertEqual([r["reason"] for r in fakes.releases], ["executor_uncaught_exit:RuntimeError"])
        self.assertEqual(fakes.releases[0]["claim_id"], "claim_guard")
        self.assertEqual(fakes.releases[0]["lease_token"], "lease-guard")
        self.assertEqual(guard.outcome, "released:executor_uncaught_exit:RuntimeError")
        # The run log shows the hand-back: the body's stack has unwound, so
        # the guard is the only thing that can say it happened.
        self.assertEqual(fakes.stage_lines, [
            "held_claim_released request_id=AIR-guard claim_id=claim_guard state=CLAIMED "
            "outcome=released:executor_uncaught_exit:RuntimeError",
        ])

    def test_a_return_that_forgot_to_release_is_released_and_named(self) -> None:
        fakes = _Fakes("RUNNING")  # a heartbeat was seen; the lease is still live
        guard = _held(fakes)
        with guard:
            pass
        self.assertEqual([r["reason"] for r in fakes.releases], ["executor_uncaught_exit:return_without_release"])

    def test_a_settled_claim_is_left_alone(self) -> None:
        for state in ("PENDING", "REQUEUED", "ACCEPTED", "REJECTED", "HUMAN_REQUIRED", "STALE", "CANCELLED_BY_OPERATOR"):
            with self.subTest(state=state):
                fakes = _Fakes(state)
                guard = _held(fakes)
                with guard:
                    pass
                self.assertEqual(fakes.releases, [])
                self.assertEqual(guard.outcome, f"settled:{state}")
                self.assertEqual(fakes.stage_lines, [], "nothing was held; nothing to report")

    def test_a_request_the_kernel_never_minted_holds_nothing(self) -> None:
        # The mocked executor fixtures claim a request that does not exist in
        # the ledger; the kernel's "no such request" is definitive, not
        # unreadable, so the guard adds no release hop there.
        fakes = _Fakes("unused")
        fakes.derive = lambda request_id, tools_dir: None
        guard = _held(fakes)
        with guard:
            pass
        self.assertEqual(fakes.releases, [])
        self.assertEqual(guard.outcome, "settled:no_such_request")

    def test_an_unreadable_ledger_still_hands_the_lease_back(self) -> None:
        # The kernel refuses a release with nothing to release; keeping a
        # lease because the answer could not be read is the leak again.
        fakes = _Fakes(None, accept=False)
        guard = _held(fakes)
        with self.assertRaises(ValueError):
            with guard:
                raise ValueError("body failed")
        self.assertEqual(len(fakes.releases), 1)
        self.assertEqual(guard.outcome, "release_failed:executor_uncaught_exit:ValueError")
        self.assertEqual(fakes.stage_lines, [
            "held_claim_released request_id=AIR-guard claim_id=claim_guard state=unreadable "
            "outcome=release_failed:executor_uncaught_exit:ValueError",
        ])

    def test_the_reason_is_owned_by_the_kernel_as_a_harness_fault(self) -> None:
        # A crash in the wrapper says nothing about the request: its requeue
        # budget must not burn (the same rule as `claude_cli_exit_<n>`).
        from aria_kernel.release_reason import RELEASE_REASON_CODES, parse_release_reason
        from ci_executor_lease import UNCAUGHT_EXIT_RELEASE_PREFIX

        reason = UNCAUGHT_EXIT_RELEASE_PREFIX + "AttributeError"
        self.assertEqual(agent_invocations.classify_release_reason(reason), "harness")
        parsed = parse_release_reason(reason)
        self.assertEqual((parsed.reason_code, parsed.fault_domain, parsed.reason_detail),
                         ("EXECUTOR_UNCAUGHT_EXIT", "harness", "AttributeError"))
        self.assertIn("EXECUTOR_UNCAUGHT_EXIT", RELEASE_REASON_CODES)

    def test_main_registers_the_guard_the_moment_the_lease_exists(self) -> None:
        """Positional, like the sibling invariant above: the guard enters the
        runtime stack after the lease guard and before the first release
        site, so no statement in between can exit unguarded."""
        fn = _function("_main")
        held_from = min(
            node.lineno for node in ast.walk(fn)
            if isinstance(node, ast.If) and "lease_token" in ast.dump(node.test) and "claim_id" in ast.dump(node.test)
        )
        first_release = min(
            node.lineno for node in ast.walk(fn)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "_release_claim" and node.lineno > held_from
        )
        registrations = [
            node for node in ast.walk(fn)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
            and node.func.attr == "enter_context" and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "_runtime_stack"
            and any(isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name) and arg.func.id == "HeldClaim"
                    for arg in node.args)
        ]
        self.assertEqual(len(registrations), 1, "exactly one lease guard on the runtime stack")
        self.assertLess(held_from, registrations[0].lineno)
        self.assertLess(registrations[0].lineno, first_release)
        held_claim = next(arg for arg in registrations[0].args
                          if isinstance(arg, ast.Call) and isinstance(arg.func, ast.Name) and arg.func.id == "HeldClaim")
        log = next(kw.value for kw in held_claim.keywords if kw.arg == "log")
        self.assertEqual(getattr(log, "id", None), "_stage", "the guard reports through the executor's stage logger")


class TheGuardIsProvenOnTheRealKernel(unittest.TestCase):
    """The actual entry, a real request, a real claim through the kernel CLI,
    the real summary writer — and the one substitute is the spawn."""

    def setUp(self) -> None:
        import sys

        from tests import test_ci_executor_live_path_smoke as smoke

        smoke.NativeAdaptiveAdmissionTests.setUp(self)
        self.executor = smoke.ci_executor
        (self.binary_dir / "python3").symlink_to(sys.executable)
        self.runner_temp = self.root / "runner-temp"
        self.runner_temp.mkdir()
        # No adaptive block: the fixture workspace is the metered default the
        # live lanes ran under until B8 declared the subscription policy.
        # The pre-claim ENVIRONMENT gate (claude binary, sandbox, node_modules)
        # is not what is under test; the lease lifecycle after the claim is.
        for name, value in (("_pre_claim_environment_gate", lambda **_: None), ("_REPO_ROOT", self.repo)):
            patcher = patch.object(self.executor, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _run_entry(self) -> int:
        import os
        from contextlib import chdir

        environment = {"PATH": str(self.binary_dir) + os.pathsep + os.defpath,
                       "RUNNER_TEMP": str(self.runner_temp), "MAX_TIMEOUT_SECONDS": "60"}
        with patch.dict(os.environ, environment), chdir(self.repo):
            return self.executor.main([self.request["request_id"], "aria-evidence-judge"])

    def _claim_rows(self) -> list[dict]:
        from aria_kernel.ledger import load_declared_jsonl

        return load_declared_jsonl(self.tools / "agent-invocations" / "claims.jsonl",
                                   expected_surface="agent_invocation_claims")

    def test_an_injected_exception_after_the_claim_leaves_a_released_row(self) -> None:
        with patch.object(self.executor, "invoke_claude_cli", side_effect=RuntimeError("injected after the claim")):
            with self.assertRaises(RuntimeError):
                self._run_entry()
        rows = self._claim_rows()
        self.assertEqual([row["event"] for row in rows if row["event"] == "claimed"], ["claimed"])
        released = [row for row in rows if row["event"] == "released"]
        self.assertEqual([row["reason"] for row in released], ["executor_uncaught_exit:RuntimeError"])
        self.assertEqual(released[0]["fault_domain"], "harness")
        self._assert_claimable_again(rows)

    def _assert_claimable_again(self, rows: list[dict]) -> None:
        # Back on the queue (a harness release derives REQUEUED with the
        # request-fault counter untouched), never CLAIMED, never STALE.
        state = self.ai.derive_request_state(request_id=self.request["request_id"], base_dir=self.tools)
        self.assertIn(state, ("PENDING", "REQUEUED"), state)
        self.assertEqual(agent_invocations._request_fault_requeue_count(rows, self.request["request_id"]), 0,
                         "a harness fault must not cost the request its requeue budget")

    def test_the_spawn_gates_refusal_runs_the_summary_writer_and_releases(self) -> None:
        import json

        # opus reserves 3.6 against the default per_run 0.5 of this metered
        # workspace: refused inside invoke_claude_cli, where the 2026-09-04
        # refusal crashed before its release.
        exit_code = self._run_entry()
        self.assertEqual(exit_code, 1)
        summary = json.loads((self.runner_temp / f"dispatch-result-{self.request['request_id']}.json")
                             .read_text(encoding="utf-8"))
        self.assertEqual((summary["outcome"], summary["failure_detail_code"]), ("failed", "cost_reservation_refused"))
        rows = self._claim_rows()
        released = [row for row in rows if row["event"] == "released"]
        self.assertEqual([row["reason"] for row in released], ["claude_cli_exit_1"])
        self._assert_claimable_again(rows)


if __name__ == "__main__":
    unittest.main()
