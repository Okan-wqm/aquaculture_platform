"""Plan 023 §A — per-agent model/effort tiering invariants.

Guards the "scout-and-verify" tier split: read-only scorers/scanners run on
the cheap tier, while writers/deciders stay on the expensive tier. The tests
fail closed — a frontmatter edit that downgrades a writer, or an invalid
model/effort value, is caught here rather than silently shipping.
"""
from __future__ import annotations

import unittest
import json
import tempfile
from pathlib import Path
from unittest import mock

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
    def _runtime_profile_fixture(self, selection: dict[str, str]) -> tuple[Path, Path]:
        from aria_kernel import agent_runtime_profile, runtime_profiles

        fixture_directory = tempfile.TemporaryDirectory(prefix="aria-s4-profile-")
        self.addCleanup(fixture_directory.cleanup)
        self.addCleanup(agent_runtime_profile._read_profile_cached.cache_clear)
        self.addCleanup(runtime_profiles._load_cached.cache_clear)
        root = Path(fixture_directory.name)
        agents = root / ".claude" / "agents"
        agents.mkdir(parents=True)
        # The copied role remains an unchanged mirror. The real kernel-profile
        # reader must select its authority even when that mirror differs.
        role = _AGENTS_DIR / "aria-evidence-judge.md"
        (agents / role.name).write_bytes(role.read_bytes())
        source = _REPO_ROOT / "aria-kernel" / "aria_kernel" / "data" / "runtime_profiles.json"
        payload = json.loads(source.read_text(encoding="utf-8"))
        payload["profiles"]["judge_opus"].update(selection)
        profile_path = root / "runtime_profiles.json"
        profile_path.write_text(json.dumps(payload), encoding="utf-8")
        return root, profile_path

    def test_selected_codex_profile_resolves_astra_ultra_without_grant_changes(self) -> None:
        from aria_kernel import runtime_profiles

        root, path = self._runtime_profile_fixture({
            "runtime": "codex", "model": "gpt-6-astra", "effort": "ultra",
        })
        with mock.patch.object(runtime_profiles, "profiles_path", return_value=path):
            kernel = runtime_profiles.profile_by_id("judge_opus")
            profile = read_agent_runtime_profile("aria-evidence-judge", repo_root=root)
        for resolved in (kernel, profile):
            self.assertEqual((resolved.runtime, resolved.model, resolved.effort),
                             ("codex", "gpt-6-astra", "ultra"))
            self.assertEqual(resolved.profile_id, "judge_opus")
            self.assertEqual(resolved.tools, ("Read", "Grep", "Glob"))
            self.assertEqual(resolved.write_scope, ())
            self.assertEqual(resolved.env_passthrough, ())
            self.assertFalse(resolved.external_writes)
            self.assertFalse(resolved.write_capable)
            self.assertEqual(resolved.budget_usd_per_run, 0.5)
            self.assertEqual(resolved.max_concurrent, 3)
        self.assertEqual(kernel.mcp_servers, ())
        self.assertEqual(profile.source, "kernel_profile_mirror_drift")
        self.assertEqual((root / ".claude/agents/aria-evidence-judge.md").read_bytes(),
                         (_AGENTS_DIR / "aria-evidence-judge.md").read_bytes())

    def test_omitted_and_explicit_claude_runtime_preserve_existing_profile(self) -> None:
        from aria_kernel import runtime_profiles

        for selection in ({}, {"runtime": "claude"}):
            with self.subTest(selection=selection):
                root, path = self._runtime_profile_fixture(selection)
                with mock.patch.object(runtime_profiles, "profiles_path", return_value=path):
                    kernel = runtime_profiles.profile_by_id("judge_opus")
                    profile = read_agent_runtime_profile("aria-evidence-judge", repo_root=root)
                for resolved in (kernel, profile):
                    self.assertEqual(getattr(resolved, "runtime", None), "claude")
                    self.assertEqual((resolved.model, resolved.effort), ("opus", "max"))
                    self.assertEqual(resolved.tools, ("Read", "Grep", "Glob"))
                    self.assertEqual(resolved.write_scope, ())
                    self.assertEqual(resolved.env_passthrough, ())
                    self.assertFalse(resolved.external_writes)
                    self.assertEqual(resolved.budget_usd_per_run, 0.5)
                    self.assertEqual(resolved.max_concurrent, 3)
                self.assertEqual(kernel.mcp_servers, ())
                self.assertEqual(profile.source, "kernel_profile")

    def test_frontmatter_only_astra_preserves_legacy_default_runtime(self) -> None:
        root, _ = self._runtime_profile_fixture({})
        path = root / ".claude" / "agents" / "aria-frontmatter-only.md"
        path.write_text("---\nmodel: gpt-6-astra\neffort: ultra\n---\nRead-only fixture.\n",
                        encoding="utf-8")
        profile = read_agent_runtime_profile("aria-frontmatter-only", repo_root=root)
        self.assertEqual((profile.model, profile.effort, profile.source),
                         ("fable", "max", "default_invalid"))
        self.assertEqual(getattr(profile, "runtime", None), "claude")
        self.assertEqual(profile.tools, ())
        self.assertEqual(profile.write_scope, ())
        self.assertFalse(profile.external_writes)
        self.assertNotIn("gpt-6-astra", VALID_MODELS)
        self.assertNotIn("ultra", VALID_EFFORTS)

    def test_unsupported_runtime_pair_is_refused_without_profile_fallback(self) -> None:
        from aria_kernel import runtime_profiles
        from aria_kernel.tool_registry import GovernanceError

        selections = (
            {"runtime": "codex", "model": "opus", "effort": "ultra"},
            {"runtime": "codex", "model": "gpt-6-astra", "effort": "max"},
            {"runtime": "claude", "model": "gpt-6-astra", "effort": "ultra"},
            {"model": "gpt-6-astra", "effort": "ultra"},
            {"runtime": "unlisted", "model": "opus", "effort": "max"},
        )
        for selection in selections:
            with self.subTest(selection=selection):
                root, path = self._runtime_profile_fixture(selection)
                with mock.patch.object(runtime_profiles, "profiles_path", return_value=path):
                    with self.assertRaises(GovernanceError):
                        read_agent_runtime_profile("aria-evidence-judge", repo_root=root)

    def test_scout_tier_agent_reads_opus(self) -> None:
        # K5 tier flip — the judge/validator layer moved sonnet -> opus.
        prof = read_agent_runtime_profile("aria-evidence-judge")
        self.assertEqual(prof.model, "opus")
        self.assertEqual(prof.effort, "max")
        # Plan 032 Faz 032b — roster agents resolve through their kernel
        # runtime profile; the frontmatter is a mirror, not the source.
        self.assertIn(prof.source, {"frontmatter", "kernel_profile"})

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
        # Plan 032 Faz 032b — roster agents resolve through their kernel
        # runtime profile; the frontmatter is a mirror, not the source.
        self.assertIn(profile.source, {"frontmatter", "kernel_profile"})
        self.assertIn("aria-worker", WRITE_TIER_AGENTS)

    def test_aria_autonomy_planner_resolves_from_frontmatter(self) -> None:
        profile = read_agent_runtime_profile("aria-autonomy-planner")
        # Plan 032 Faz 032b — roster agents resolve through their kernel
        # runtime profile; the frontmatter is a mirror, not the source.
        self.assertIn(profile.source, {"frontmatter", "kernel_profile"})
