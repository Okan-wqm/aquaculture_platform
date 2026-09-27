"""Typed-judgment plan Phase 4a — the executor's per-request seams and the
batch pricing, before the batch child exists.

* `batch_worst_case_seconds(K, T)` is `child_worst_case_seconds(T)` at K = 1
  with no delivery term, grows by exactly the per-request terms (two state
  writes and the terminal writer) per extra request, charges the git probe,
  the model call and the worktree bracket once, and refuses K < 1.
* The four blocks `_main` ran inline — claim, prompt binding, submit,
  native reconcile — are module-level helpers `_main` calls by name, so a
  batch child can reuse them without a second spelling of any kernel CLI
  argv (the AST pin: `submit-result` and `agent claim` are spelled in
  exactly one function each).
"""
from __future__ import annotations

import ast
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402


class TheBatchPricing(unittest.TestCase):
    def test_one_request_prices_like_one_child(self) -> None:
        for timeout in (600, 1800, 3600):
            for worktree in (False, True):
                with self.subTest(timeout=timeout, worktree=worktree):
                    self.assertEqual(
                        ci_executor.batch_worst_case_seconds(1, timeout, worktree_per_request=worktree),
                        ci_executor.child_worst_case_seconds(timeout, worktree_per_request=worktree),
                    )

    def test_each_extra_request_adds_exactly_its_own_terms(self) -> None:
        per_request = (ci_executor.STATE_WRITE_CHILD_WORST_CASE_SECONDS
                       + ci_executor.TERMINAL_WRITER_TIMEOUT_SECONDS
                       + ci_executor.STATE_WRITE_CHILD_WORST_CASE_SECONDS)
        one = ci_executor.batch_worst_case_seconds(1, 1800)
        for k in (2, 3, 4, 8):
            with self.subTest(k=k):
                self.assertEqual(ci_executor.batch_worst_case_seconds(k, 1800), one + (k - 1) * per_request)
        # The model call, the probe and the worktree bracket are charged once.
        self.assertEqual(
            ci_executor.batch_worst_case_seconds(3, 1800, worktree_per_request=True)
            - ci_executor.batch_worst_case_seconds(3, 1800),
            ci_executor.REQUEST_WORKTREE_WORST_CASE_SECONDS,
        )
        self.assertEqual(ci_executor.batch_worst_case_seconds(3, 1900) - ci_executor.batch_worst_case_seconds(3, 1800), 100)

    def test_an_empty_batch_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            ci_executor.batch_worst_case_seconds(0, 1800)


class TheSeamsAreNamedOnce(unittest.TestCase):
    def setUp(self) -> None:
        self.tree = ast.parse((_POC_DIR / "ci_executor.py").read_text(encoding="utf-8"))
        self.functions = {node.name: node for node in ast.walk(self.tree) if isinstance(node, ast.FunctionDef)}

    def _functions_spelling(self, *literals: str) -> list[str]:
        owners: list[str] = []
        for name, node in self.functions.items():
            constants = {c.value for c in ast.walk(node) if isinstance(c, ast.Constant) and isinstance(c.value, str)}
            if all(literal in constants for literal in literals):
                owners.append(name)
        return sorted(owners)

    def test_the_kernel_claim_and_submit_argv_are_spelled_in_one_helper_each(self) -> None:
        self.assertEqual(self._functions_spelling("agent", "claim", "--lease-seconds"), ["_claim_request_via_cli"])
        self.assertEqual(self._functions_spelling("agent", "submit-result", "--lease-token-from-env"), ["_submit_via_cli"])

    def test_main_calls_the_four_helpers(self) -> None:
        main = self.functions["_main"]
        called = {node.func.id for node in ast.walk(main) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        for helper in ("_claim_request_via_cli", "_render_and_bind_prompt", "_submit_via_cli", "_reconcile_native_result"):
            self.assertIn(helper, called, helper)
        for helper in ("_claim_request_via_cli", "_render_and_bind_prompt", "_submit_via_cli", "_reconcile_native_result"):
            self.assertIn(helper, self.functions)


if __name__ == "__main__":
    unittest.main()


class TheAdmissionIsSplitIntoAProbeAndABinding(unittest.TestCase):
    """`_adaptive_pre_claim_admission` = policy → request binding →
    `_admit_native_route` (the fleet probe, once per profile) →
    `_bind_request_to_route` (per request). The single-request path calls
    both by name; the batch child calls the probe once."""

    def test_the_single_request_path_calls_both_seams(self) -> None:
        tree = ast.parse((_POC_DIR / "ci_executor.py").read_text(encoding="utf-8"))
        functions = {node.name: node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef)}
        for name in ("_admit_native_route", "_bind_request_to_route", "_adaptive_pre_claim_admission"):
            self.assertIn(name, functions)
        called = {node.func.id for node in ast.walk(functions["_adaptive_pre_claim_admission"])
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertIn("_admit_native_route", called)
        self.assertIn("_bind_request_to_route", called)
        probe_calls = {node.func.id for node in ast.walk(functions["_admit_native_route"])
                       if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertIn("_native_runtime_admission", probe_calls, "the fleet probe lives in the probe seam")
        binding_calls = {node.func.id for node in ast.walk(functions["_bind_request_to_route"])
                         if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
        self.assertNotIn("_native_runtime_admission", binding_calls, "the binding never probes")
        self.assertIn("_refuse_native_admission", binding_calls)


class TheBatchChildSpellsNoKernelArgvItself(unittest.TestCase):
    """Phase 4b — `ci_executor_judge_batch` reaches the kernel CLI only
    through the engine's helpers: no second spelling of `agent claim` or
    `agent submit-result` exists anywhere in the module."""

    def test_no_kernel_cli_literal_in_the_batch_module(self) -> None:
        tree = ast.parse((_POC_DIR / "ci_executor_judge_batch.py").read_text(encoding="utf-8"))
        constants = {c.value for c in ast.walk(tree) if isinstance(c, ast.Constant) and isinstance(c.value, str)}
        for literal in ("submit-result", "next-pending", "--lease-seconds", "--lease-token-from-env"):
            self.assertNotIn(literal, constants, literal)
        calls = {node.func.attr for node in ast.walk(tree)
                 if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                 and isinstance(node.func.value, ast.Name) and node.func.value.id == "_engine"}
        for helper in ("_claim_request_via_cli", "_render_and_bind_prompt", "_submit_via_cli", "_reconcile_native_result",
                       "_admit_native_route", "_bind_request_to_route", "_batch_worst_case_seconds"):
            self.assertIn(helper, calls, helper)
