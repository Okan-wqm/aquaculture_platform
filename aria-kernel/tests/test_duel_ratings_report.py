"""Z6 — the duel ledger's operator surface: read-time BT scores.

The ledger stores outcomes; the report recomputes scores at render time
(pressure-source-effectiveness pattern). Silent until a decided duel
exists, so an empty substrate never renders a confident-looking zero.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.knowledge_graph import _append_row
from aria_kernel.reflection import _render_duel_ratings_section
from aria_kernel.tool_registry import ensure_tools_dir


class DuelRatingsSectionTests(unittest.TestCase):
    def test_silent_without_decided_duels(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            self.assertEqual(_render_duel_ratings_section(root), [])

    def test_renders_read_time_scores(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            for _ in range(2):
                _append_row(
                    root / "knowledge-graph" / "duel-ratings.jsonl",
                    {
                        "schema_version": 1,
                        "plan_id": "p",
                        "round": 1,
                        "primary_agent": "aria-primary-planner",
                        "challenger_agent": "aria-challenger-planner",
                        "verdicts_by_direction": {
                            "primary_to_challenger": "material_risks_present",
                            "challenger_to_primary": "agreed",
                        },
                        "material_risk_count": 1,
                        "resolved_risk_count": 0,
                        "terminal_state": "CONVERGED",
                    },
                )
            lines = _render_duel_ratings_section(root)
            text = "\n".join(lines)
            self.assertIn("## Duel Ratings", text)
            self.assertIn("Decided duels: 2", text)
            self.assertIn("aria-primary-planner", text)
            # Primary won both decided directions — it must outrank.
            primary = next(l for l in lines if "aria-primary-planner" in l)
            challenger = next(l for l in lines if "aria-challenger-planner" in l)
            self.assertLess(lines.index(primary), lines.index(challenger))


if __name__ == "__main__":
    unittest.main()
