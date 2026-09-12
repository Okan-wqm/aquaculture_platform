"""Operator decision 2026-09-12 — the fable tier is selected by nothing.

Decision nodes ran on fable since the K5 tier flip; the operator moved every
selection to opus ("fable'ı kullanmasın, sadece opus"). The tier NAME stays:
`MODEL_TIER_ORDER` orders it for the write-protection rule, the pricing table
prices its old rows, and the fallback ladder still knows where a fable run
would land. What must never come back is a SELECTION: a kernel profile, an
agent frontmatter mirror, a code default or the dispatcher configuration
naming fable as the model to run.
"""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[3]
_POC = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC) not in sys.path:
    sys.path.insert(0, str(_POC))

_FRONTMATTER_MODEL = re.compile(r"^model:\s*(\S+)\s*$", re.M)


class FableIsSelectedByNothing(unittest.TestCase):
    def test_no_kernel_profile_runs_on_fable(self) -> None:
        from aria_kernel.runtime_profiles import profile_by_id

        table = json.loads((_REPO_ROOT / "aria-kernel/aria_kernel/data/runtime_profiles.json").read_text(encoding="utf-8"))
        offenders = {name: row["model"] for name, row in table["profiles"].items() if row.get("model") == "fable"}
        self.assertEqual(offenders, {})
        self.assertEqual(profile_by_id("planner").model, "opus")

    def test_no_agent_frontmatter_mirrors_fable(self) -> None:
        offenders = []
        for path in sorted((_REPO_ROOT / ".claude/agents").rglob("*.md")):
            text = path.read_text(encoding="utf-8")
            if not text.startswith("---"):
                continue
            frontmatter = text.split("---", 2)[1]
            match = _FRONTMATTER_MODEL.search(frontmatter)
            if match and match.group(1) == "fable":
                offenders.append(str(path.relative_to(_REPO_ROOT)))
        self.assertEqual(offenders, [])

    def test_no_default_resolves_to_fable(self) -> None:
        import claude_runtime
        from aria_kernel import agent_runtime_profile, dispatcher_factory

        self.assertEqual(agent_runtime_profile.DEFAULT_MODEL, "opus")
        self.assertEqual(claude_runtime.CLAUDE_DEFAULT_MODEL, "opus")
        self.assertEqual(agent_runtime_profile.read_agent_runtime_profile("aria-does-not-exist").model, "opus")
        self.assertIn('"claude_model": "opus"', (_REPO_ROOT / "aria-kernel/aria_kernel/dispatcher_factory.py").read_text(encoding="utf-8"))
        self.assertIn("fable", agent_runtime_profile.MODEL_TIER_ORDER, "the tier name stays ordered; only its selection is gone")


if __name__ == "__main__":
    unittest.main()
