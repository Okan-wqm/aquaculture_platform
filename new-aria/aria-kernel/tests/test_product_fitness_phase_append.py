"""ORPHAN-HIGH-796 — the product-fitness phase must append through the
declared writer.

The nightly's first fully-alive run (2026-08-22, run 32578768498 — every
phase executed, state published, normal exit) reached the product_fitness
phase for the FIRST time: ORPHAN-776's NameError had killed every prior
night before it. The phase then failed on
`raw_jsonl_declared_surface_rejected` — it wrote product-fitness.jsonl
via the raw append while the surface is declared (G-1, observation-class)
and the discipline correctly refused. The fix is the declared writer.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel.product_fitness import FitnessVerdict
from aria_kernel.tool_registry import ensure_tools_dir


class ProductFitnessDeclaredAppend(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = Path(tempfile.mkdtemp(prefix="aria-796-"))
        self.tools = self._tmp / "aria-tools"
        ensure_tools_dir(self.tools)

    def tearDown(self) -> None:
        shutil.rmtree(self._tmp, ignore_errors=True)

    def test_phase_appends_via_declared_writer(self) -> None:
        verdict = FitnessVerdict(
            status="green",
            dimensions=[],
            statement="test charter met",
        )
        charter = {
            "consecutive_green_nights_required": 7,
            "stages": {},
        }
        calls: list[tuple[str, str]] = []

        import aria_kernel.ledger as ledger_mod

        original = ledger_mod.append_declared_jsonl

        def spy(path, payload, **kwargs):
            calls.append((str(path), str(kwargs.get("expected_surface"))))
            return original(path, payload, **kwargs)

        import aria_kernel.product_fitness as pf_mod
        import aria_kernel.convergence_drainer as cd_mod
        import aria_kernel.github_adapters as gh_mod

        with patch.object(pf_mod, "load_charter", return_value=charter), \
             patch.object(pf_mod, "evaluate_fitness", return_value=verdict), \
             patch.object(pf_mod, "streak_from_history", return_value={"consecutive_green_nights": 1}), \
             patch.object(gh_mod, "select_checks_reader", return_value=None), \
             patch.object(cd_mod, "_resolve_workspace_head_sha", return_value="a" * 40), \
             patch("aria_kernel.ledger.append_declared_jsonl", side_effect=spy):
            context = type("Ctx", (), {
                "base_dir": self.tools,
                "workspace_root": self._tmp,
                "cycle_id": "cyc-796",
            })()
            result = cycle_mod._phase_product_fitness(context)

        self.assertEqual(result["status"], "green")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][1], "product_fitness")
        ledger = self.tools / "product-fitness.jsonl"
        self.assertTrue(ledger.exists())
        rows = [json.loads(line) for line in ledger.read_text(encoding="utf-8").splitlines() if line.strip()]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["cycle_id"], "cyc-796")


if __name__ == "__main__":
    unittest.main()
