"""The executor must not maintain its own copy of the prompt projection.

The prompt-hash binding died twice in the same way, one layer apart. First the
kernel's fused claim response invented empty lists for absent keys
(ORPHAN-CRITICAL-600). That was fixed — and executor run 31330288849 failed
with the SAME mismatch, because `ci_executor.main` then rebuilt the envelope
by hand from the fused response: `claim.get("forbidden_scope") or []`, and no
`repository_map` at all, so the re-render lost the map section and the digest
could never match. The kernel was faithful; the copy above it was not.

Two projections of "which fields make the prompt" cannot stay in sync by
memory. There is now exactly one, `fuse_prompt_envelope`, owned by the kernel
beside the renderer it mirrors — and these tests make a second one a failure
rather than a latent queue wedge.
"""
from __future__ import annotations

import ast
import unittest
from pathlib import Path

from aria_kernel.agent_invocations import (
    _sha256_text,
    fuse_prompt_envelope,
    render_invocation_prompt,
)

EXECUTOR = Path(__file__).resolve().parents[2] / "tools" / "aria-poc" / "ci_executor.py"


def _main_function() -> ast.FunctionDef:
    tree = ast.parse(EXECUTOR.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "main":
            return node
    raise AssertionError("ci_executor.main not found")


class ExecutorUsesTheKernelProjectionTest(unittest.TestCase):
    def test_the_envelope_comes_from_the_kernel_fusion(self) -> None:
        fn = _main_function()

        fusion_calls = [
            node
            for node in ast.walk(fn)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "_fuse_prompt_envelope"
        ]
        self.assertTrue(fusion_calls, "main must build the envelope via the kernel fusion")

    def test_no_hand_built_projection_of_render_fields(self) -> None:
        """No dict literal in `main` may re-project a render-relevant field
        out of the claim with a defaulting `or`.

        That construct — `"forbidden_scope": claim.get(...) or []` — is the
        exact shape that broke the binding, and it is asserted on the AST so a
        commented-out copy cannot satisfy it. Fields the renderer never reads
        (ledger anchors) are legitimately copied by hand and stay allowed.
        """
        render_fields = {
            "role", "target_agent", "suggested_prompt", "must_satisfy",
            "allowed_scope", "forbidden_scope", "evidence_refs",
            "impact_graph_refs", "validation_commands", "repository_map",
            "convergence_id", "expected_output_path", "prompt_hash",
        }
        offenders: list[str] = []
        for node in ast.walk(_main_function()):
            if not isinstance(node, ast.Dict):
                continue
            for key in node.keys:
                if (
                    isinstance(key, ast.Constant)
                    and isinstance(key.value, str)
                    and key.value in render_fields
                ):
                    offenders.append(key.value)

        self.assertEqual(
            offenders,
            [],
            f"main re-projects render fields by hand: {offenders} — "
            "use fuse_prompt_envelope; a second copy is how the binding died twice",
        )

    def test_the_projection_round_trips_a_production_shaped_row(self) -> None:
        # End to end in miniature: mint a row the way the orchestrator does
        # (map present, optional lists absent), hash it, project it the way
        # the executor now does, re-render, compare. This is the exact
        # comparison ci_executor performs at claim time.
        row: dict[str, object] = {
            "request_id": "AIR-executor-roundtrip-0001",
            "role": "maintenance_utility",
            "target_agent": "aria-autonomy-planner",
            "expected_output_path": "aria-tools/out/x.json",
            "suggested_prompt": "close the loop",
            "must_satisfy": [{"id": "M1", "criterion": "hash reproduces"}],
            "allowed_scope": ["aria-kernel/**"],
            "evidence_refs": ["docs/x.md:1"],
            "repository_map": {"projects": ["aria-kernel"]},
            "cycle_id": "cyc-1",
        }
        row["prompt_hash"] = _sha256_text(render_invocation_prompt(row))

        claim_response = {**row, "lease_token": "raw", "claim_id": "c1", "event": "claimed"}
        envelope = fuse_prompt_envelope(claim_response)

        self.assertEqual(
            _sha256_text(render_invocation_prompt(envelope)), row["prompt_hash"]
        )
        self.assertNotIn("lease_token", envelope, "the raw lease must not ride along")


if __name__ == "__main__":
    unittest.main()
