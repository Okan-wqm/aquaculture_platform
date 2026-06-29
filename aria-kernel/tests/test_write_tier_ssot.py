"""Plan 031-R R6 (B8) — write-tier SSoT cross-language parity.

The write-capable ARIA agents are declared in two places: the Python runtime
reader (agent_runtime_profile.WRITE_TIER_AGENTS) and the TS frontmatter invariant
(tests/invariants/agent-frontmatter-schema.spec.ts ARIA_WRITE_TIER). They MUST
agree — a writer pinned to opus/xhigh in one but not the other lets a frontmatter
edit quietly downgrade a writer on the path the other side does not guard. This
test pins them to the same set.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.agent_runtime_profile import WRITE_TIER_AGENTS

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TS_INVARIANT = _REPO_ROOT / "tests" / "invariants" / "agent-frontmatter-schema.spec.ts"


def _ts_write_tier() -> set[str]:
    content = _TS_INVARIANT.read_text(encoding="utf-8")
    block = re.search(
        r"ARIA_WRITE_TIER\s*=\s*new Set<string>\(\[(.*?)\]\)",
        content, re.DOTALL,
    )
    assert block is not None, "ARIA_WRITE_TIER set not found in the TS invariant"
    # Strip // line comments first — they may contain apostrophes (e.g. "lane's")
    # that would otherwise be mis-parsed as quoted agent names.
    body = re.sub(r"//[^\n]*", "", block.group(1))
    return set(re.findall(r"'([^']+)'", body))


class WriteTierSsotParityTests(unittest.TestCase):
    def test_ts_invariant_file_exists(self) -> None:
        self.assertTrue(_TS_INVARIANT.exists(), _TS_INVARIANT)

    def test_python_and_ts_write_tier_agree(self) -> None:
        ts = _ts_write_tier()
        py = set(WRITE_TIER_AGENTS)
        self.assertEqual(
            py, ts,
            msg=(f"write-tier SSoT drift: python-only={sorted(py - ts)} "
                 f"ts-only={sorted(ts - py)}"),
        )

    def test_gap_fixer_is_write_tier(self) -> None:
        # Plan 030 acceptance fixer holds Edit/Write/Bash → must be write-tier.
        self.assertIn("aria-acceptance-gap-fixer", WRITE_TIER_AGENTS)


if __name__ == "__main__":
    unittest.main()
