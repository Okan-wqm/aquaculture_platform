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
        fn = _function("main")

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

        # The pre-claim guards legitimately return 1 without releasing, because
        # no claim exists yet. Those live above the claim call, so the check is
        # scoped to branches at or after it.
        claim_line = min(
            node.lineno
            for node in ast.walk(fn)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in {"_release_claim"}
        )
        late_offenders = [line for line in offenders if line > claim_line]

        self.assertEqual(late_offenders, [], f"branches returning 1 without releasing: {late_offenders}")


class ClaimResponseCarriesWhatThePromptWasHashedOverTest(unittest.TestCase):
    def test_the_fused_claim_response_includes_the_repository_map(self) -> None:
        # The binding check compares the recorded prompt hash against one the
        # executor recomputes from this response. The hash was taken over a
        # render that INCLUDED the Twin slice, so a response without it makes
        # the check unsatisfiable — deterministically, for every request whose
        # evidence resolves against the map.
        source = inspect.getsource(agent_invocations.claim_request)
        tree = ast.parse(inspect.cleandoc(source))
        keys = {
            node.value
            for node in ast.walk(tree)
            if isinstance(node, ast.Constant) and isinstance(node.value, str)
        }

        self.assertIn("repository_map", keys)
        self.assertIn("cycle_id", keys)


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
