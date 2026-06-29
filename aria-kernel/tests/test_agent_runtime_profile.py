"""Plan 023 §A — per-agent model/effort tiering invariants.

Guards the "scout-and-verify" tier split: read-only scorers/scanners run on
the cheap tier, while writers/deciders stay on the expensive tier. The tests
fail closed — a frontmatter edit that downgrades a writer, or an invalid
model/effort value, is caught here rather than silently shipping.
"""
from __future__ import annotations

import unittest
from pathlib import Path

from aria_kernel.agent_runtime_profile import (
    DEFAULT_EFFORT,
    DEFAULT_MODEL,
    VALID_EFFORTS,
    VALID_MODELS,
    WRITE_TIER_AGENTS,
    read_agent_runtime_profile,
    resolve_claude_model,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_AGENTS_DIR = _REPO_ROOT / ".claude" / "agents"


def _all_aria_agent_names() -> list[str]:
    # ``_shared/`` holds contract docs (e.g. aria-implementer-safety-contract),
    # not dispatchable agents — they carry no model/effort frontmatter.
    names: list[str] = []
    for path in _AGENTS_DIR.glob("**/aria-*.md"):
        if "_shared" in path.parts:
            continue
        names.append(path.stem)
    return sorted(set(names))


class AgentRuntimeProfileReaderTests(unittest.TestCase):
    def test_scout_tier_agent_reads_sonnet(self) -> None:
        prof = read_agent_runtime_profile("aria-evidence-judge")
        self.assertEqual(prof.model, "sonnet")
        self.assertEqual(prof.effort, "medium")
        self.assertEqual(prof.source, "frontmatter")

    def test_decider_tier_agent_reads_opus_xhigh(self) -> None:
        prof = read_agent_runtime_profile("aria-consensus-arbiter")
        self.assertEqual(prof.model, "opus")
        self.assertEqual(prof.effort, "xhigh")

    def test_unknown_agent_fails_safe_to_most_expensive(self) -> None:
        prof = read_agent_runtime_profile("aria-does-not-exist")
        self.assertEqual(prof.model, DEFAULT_MODEL)
        self.assertEqual(prof.effort, DEFAULT_EFFORT)
        self.assertEqual(prof.source, "default_missing_file")

    def test_blank_agent_name_fails_safe(self) -> None:
        prof = read_agent_runtime_profile("")
        self.assertEqual(prof.model, DEFAULT_MODEL)
        self.assertEqual(prof.effort, DEFAULT_EFFORT)

    def test_resolve_claude_model_matches_frontmatter(self) -> None:
        # resolve_claude_model returns the agent's MODEL tier (the Claude Code
        # CLI --model alias), not the reasoning effort. Scout tier → sonnet;
        # write tier → opus (fail-safe most-capable).
        self.assertEqual(resolve_claude_model("aria-evidence-judge"), "sonnet")
        self.assertEqual(resolve_claude_model("aria-implementer"), "opus")


class ModelTierInvariantTests(unittest.TestCase):
    def test_every_aria_agent_frontmatter_is_valid(self) -> None:
        names = _all_aria_agent_names()
        self.assertGreaterEqual(len(names), 10, "ARIA agent roster unexpectedly small")
        for name in names:
            prof = read_agent_runtime_profile(name)
            self.assertIn(prof.model, VALID_MODELS, f"{name} invalid model {prof.model}")
            self.assertIn(prof.effort, VALID_EFFORTS, f"{name} invalid effort {prof.effort}")
            self.assertNotEqual(
                prof.source, "default_invalid",
                f"{name} frontmatter model/effort failed to parse — fix the frontmatter",
            )

    def test_write_tier_agents_never_downgraded_below_opus(self) -> None:
        # Writers (Edit/Write/Bash) and governance-artifact authors must stay on
        # the expensive tier — the cheap scout tier is read-only judgment only.
        for name in WRITE_TIER_AGENTS:
            prof = read_agent_runtime_profile(name)
            self.assertEqual(
                prof.model, "opus",
                f"write-tier agent {name} must run on opus, got {prof.model}",
            )
            self.assertEqual(
                prof.effort, "xhigh",
                f"write-tier agent {name} must run at xhigh, got {prof.effort}",
            )


if __name__ == "__main__":
    unittest.main()
