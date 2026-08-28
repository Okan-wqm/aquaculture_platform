"""ORPHAN-HIGH-794 — batch derivation loads the ledgers once.

Per-request `derive_request_state` reloads all three ledgers on every
call; the anchor sweep (698-row backlog) and the judge pending-count
churned N×3 full-file loads in a tight loop — gigabytes of allocations
inside the memory window where the OOM killer ended the nightly
(2026-08-22 11:40). The batch form loads once; states must be identical
and the load count is pinned.
"""
from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import agent_invocations as invocations
from aria_kernel.agent_invocations import (
    create_agent_invocation_request,
    derive_request_state,
    derive_request_states,
)
from aria_kernel.tool_registry import ensure_tools_dir


class BatchDerivationTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-794-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)
        self.ids = []
        for role, agent in (("evidence_judgment", "aria-evidence-judge"), ("adversarial_judgment", "aria-adversarial-judge")):
            req = create_agent_invocation_request(
                target_agent=agent,
                role=role,
                suggested_prompt=f"judge {role}",
                must_satisfy=[{"id": "verdict", "criterion": "verdict"}],
                allowed_scope=["**"],
                finding_id=f"F-{role}",
                finding_fingerprint=f"fp-{role}",
                tool_id="tool-a",
                run_id="run-1",
                judgment_group_id=f"judge:tool-a:{role}",
                cycle_id="cyc-1",
                target_sha="a" * 40,
                base_dir=self.tools,
            )
            self.ids.append(str(req["request_id"]))

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_batch_states_equal_single_states(self) -> None:
        batch = derive_request_states(base_dir=self.tools)
        self.assertEqual(set(batch), set(self.ids))
        for request_id in self.ids:
            single = derive_request_state(request_id=request_id, base_dir=self.tools)
            self.assertEqual(
                batch[request_id],
                single,
                msg=f"batch/single divergence for {request_id}",
            )

    def test_batch_is_one_load_per_ledger_not_one_per_request(self) -> None:
        calls = {"n": 0}
        original = invocations.load_declared_jsonl

        def counting(path, *args, **kwargs):
            calls["n"] += 1
            return original(path, *args, **kwargs)

        with patch.object(invocations, "load_declared_jsonl", side_effect=counting):
            batch = derive_request_states(base_dir=self.tools)
        self.assertEqual(len(batch), 2)
        self.assertEqual(
            calls["n"],
            3,
            msg=f"batch derivation must load each ledger exactly once, got {calls['n']} loads",
        )
        # And the shape it replaces: single derivation per request = 3 loads
        # per request — the churn the OOM window measured.
        calls["n"] = 0
        with patch.object(invocations, "load_declared_jsonl", side_effect=counting):
            for request_id in self.ids:
                derive_request_state(request_id=request_id, base_dir=self.tools)
        self.assertEqual(calls["n"], 3 * len(self.ids))


if __name__ == "__main__":
    unittest.main()
