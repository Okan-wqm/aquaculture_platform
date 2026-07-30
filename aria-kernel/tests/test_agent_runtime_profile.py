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
    def test_scout_tier_agent_reads_opus(self) -> None:
        # K5 tier flip — the judge/validator layer moved sonnet -> opus.
        prof = read_agent_runtime_profile("aria-evidence-judge")
        self.assertEqual(prof.model, "opus")
        self.assertEqual(prof.effort, "max")
        self.assertEqual(prof.source, "frontmatter")

    def test_decider_tier_agent_reads_fable_xhigh(self) -> None:
        # K5 tier flip — decision nodes moved opus -> fable.
        prof = read_agent_runtime_profile("aria-consensus-arbiter")
        self.assertEqual(prof.model, "fable")
        self.assertEqual(prof.effort, "max")

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
        # CLI --model alias), not the reasoning effort. Judge tier → opus;
        # write tier → fable (fail-safe most-capable).
        self.assertEqual(resolve_claude_model("aria-evidence-judge"), "opus")
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
        # Writers (Edit/Write/Bash) and governance-artifact authors run the
        # IMPLEMENTATION tier (operator decision): opus, with sonnet as its
        # credit fallback. The invariant's purpose is unchanged — a frontmatter
        # edit must never quietly drop a writer below its assigned tier — only
        # the tier it names has moved. Planning agents keep fable.
        for name in WRITE_TIER_AGENTS:
            prof = read_agent_runtime_profile(name)
            self.assertEqual(
                prof.model, "opus",
                f"write-tier agent {name} must run on opus, got {prof.model}",
            )
            self.assertEqual(
                prof.effort, "max",
                f"write-tier agent {name} must run at max, got {prof.effort}",
            )


if __name__ == "__main__":
    unittest.main()


class FableTierValidityTests(unittest.TestCase):
    """K1 — fable/max become valid frontmatter values (ORPHAN-HIGH-283)."""

    def test_fable_and_max_are_valid(self) -> None:
        from aria_kernel.agent_runtime_profile import VALID_EFFORTS, VALID_MODELS
        self.assertIn("fable", VALID_MODELS)
        self.assertIn("max", VALID_EFFORTS)

    def test_resolve_claude_effort_fail_safe(self) -> None:
        from aria_kernel.agent_runtime_profile import (
            DEFAULT_EFFORT,
            resolve_claude_effort,
        )
        self.assertEqual(resolve_claude_effort("no-such-agent-xyz"), DEFAULT_EFFORT)


class WhitelistOrphanResolutionTests(unittest.TestCase):
    """K3 — the two kernel-dispatched agents resolve from real frontmatter,
    never the silent default_missing_file fallback (ORPHAN-HIGH-285)."""

    def test_aria_worker_resolves_from_frontmatter(self) -> None:
        profile = read_agent_runtime_profile("aria-worker")
        self.assertEqual(profile.source, "frontmatter")
        self.assertIn("aria-worker", WRITE_TIER_AGENTS)

    def test_aria_autonomy_planner_resolves_from_frontmatter(self) -> None:
        profile = read_agent_runtime_profile("aria-autonomy-planner")
        self.assertEqual(profile.source, "frontmatter")
