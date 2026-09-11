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


if __name__ == "__main__":
    unittest.main()
