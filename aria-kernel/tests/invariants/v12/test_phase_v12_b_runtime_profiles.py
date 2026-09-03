"""Plan 032 Faz 032b — the agent envelope is kernel-owned and mirrored, never prose.

Invariants:
  I-V12-PROFILE-01  `data/runtime_profiles.json` loads, every profile is closed-shape
                    (unknown key/tool/model/effort refuses), and the file sits under
                    READONLY_PATHS so a write-capable agent cannot reach it.
  I-V12-PROFILE-02  every `aria-*` agent markdown names a kernel profile and MIRRORS
                    its model/effort/tools exactly (`verify_agent_mirrors` is empty).
  I-V12-PROFILE-03  `read_agent_runtime_profile` resolves the envelope from the
                    kernel profile; a mirror that drifts is recorded and the kernel
                    value wins; an unknown profile id fails safe to the read-only tier.
  I-V12-PROFILE-04  `disallowed_tools_for` removes every ungranted tool, always denies
                    the never-granted set, and closes the external-write channels
                    while `external_writes` is false.
  I-V12-PROFILE-05  the write-tier roster (`WRITE_TIER_AGENTS`) and the profiles that
                    grant write tools describe the same agents.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import agent_runtime_profile as arp
from aria_kernel.implementation_safety import READONLY_PATHS
from aria_kernel.runtime_profiles import (
    ALWAYS_DENIED_TOOLS,
    CLAUDE_TOOL_UNIVERSE,
    EXTERNAL_WRITE_DENY_RULES,
    RUNTIME_PROFILE_FRONTMATTER_KEY,
    WRITE_TOOLS,
    disallowed_tools_for,
    load_runtime_profiles,
    profile_by_id,
    profiles_path,
    verify_agent_mirrors,
)
from aria_kernel.tool_registry import GovernanceError

_REPO_ROOT = Path(__file__).resolve().parents[4]


def _write_profiles(tmp: Path, profiles: dict) -> Path:
    path = tmp / "runtime_profiles.json"
    path.write_text(json.dumps({
        "$schema": "aria/runtime-profiles/v1", "schema_version": 1, "profiles": profiles,
    }), encoding="utf-8")
    return path


_GOOD = {
    "model": "opus", "effort": "max", "tools": ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
    "write_scope": ["**"], "env_passthrough": ["ARIA_TOOLS_DIR"], "external_writes": False,
    "budget_usd_per_run": 0.5, "max_concurrent": 1,
}


class ProfilesAreClosedAndKernelOwned(unittest.TestCase):
    def test_I_V12_PROFILE_01_the_shipped_file_loads_and_lives_under_readonly_paths(self) -> None:
        profiles = load_runtime_profiles()
        self.assertTrue(profiles)
        rel = profiles_path().relative_to(_REPO_ROOT).as_posix()
        self.assertTrue(any(rel.startswith(ro) for ro in READONLY_PATHS), rel)
        for profile in profiles.values():
            self.assertNotIn("WebFetch", profile.tools)
            self.assertFalse(profile.external_writes, "032b keeps external writes closed")

    def test_I_V12_PROFILE_01_unknown_keys_tools_models_refuse(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cases = {
                "unknown_key": {**_GOOD, "surprise": 1},
                "bad_tool": {**_GOOD, "tools": ["Read", "Teleport"]},
                "never_granted": {**_GOOD, "tools": ["Read", "WebFetch"]},
                "bad_model": {**_GOOD, "model": "gpt-9"},
                "bad_effort": {**_GOOD, "effort": "turbo"},
                "scope_without_write": {**_GOOD, "tools": ["Read"], "write_scope": ["**"]},
                "edit_without_scope": {**_GOOD, "write_scope": []},
                "bad_env_name": {**_GOOD, "env_passthrough": ["lower case"]},
                "zero_budget": {**_GOOD, "budget_usd_per_run": 0},
                "zero_concurrency": {**_GOOD, "max_concurrent": 0},
            }
            for label, body in cases.items():
                path = _write_profiles(root, {"p": body})
                with self.assertRaises(GovernanceError, msg=label):
                    load_runtime_profiles(path)
                path.unlink()
            good = _write_profiles(root, {"p": _GOOD})
            self.assertEqual(load_runtime_profiles(good)["p"].model, "opus")
            with self.assertRaises(GovernanceError):
                profile_by_id("nope", path=good)


class RosterMirrorsTheKernel(unittest.TestCase):
    def test_I_V12_PROFILE_02_every_aria_agent_names_and_mirrors_a_profile(self) -> None:
        agents = sorted((_REPO_ROOT / ".claude" / "agents").glob("aria-*.md"))
        self.assertGreaterEqual(len(agents), 18)
        for path in agents:
            self.assertIn(f"\n{RUNTIME_PROFILE_FRONTMATTER_KEY}:", path.read_text(encoding="utf-8")[:2000], path.name)
        self.assertEqual(verify_agent_mirrors(repo_root=_REPO_ROOT), [])

    def test_I_V12_PROFILE_02_a_drifting_mirror_is_a_named_defect(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".claude" / "agents").mkdir(parents=True)
            (root / ".claude" / "agents" / "aria-x.md").write_text(
                "---\nname: aria-x\nruntime_profile: judge_opus\nmodel: fable\neffort: max\ntools: Read, Grep, Glob\n---\n# x\n",
                encoding="utf-8",
            )
            (root / ".claude" / "agents" / "aria-y.md").write_text(
                "---\nname: aria-y\nmodel: opus\neffort: max\ntools: Read\n---\n# y\n", encoding="utf-8",
            )
            defects = verify_agent_mirrors(repo_root=root)
        reasons = {(d["ref"], d["reason"]) for d in defects}
        self.assertIn((".claude/agents/aria-x.md", "runtime_profile_mirror_drift"), reasons)
        self.assertIn((".claude/agents/aria-y.md", "runtime_profile_missing"), reasons)


class ResolutionUsesTheKernel(unittest.TestCase):
    def test_I_V12_PROFILE_03_kernel_profile_is_the_authority(self) -> None:
        arp._read_profile_cached.cache_clear()
        implementer = arp.read_agent_runtime_profile("aria-implementer", repo_root=_REPO_ROOT)
        self.assertEqual(implementer.source, "kernel_profile")
        self.assertEqual(implementer.profile_id, "implementer")
        self.assertEqual(implementer.write_scope, ("**",))
        self.assertTrue(implementer.write_capable)
        self.assertFalse(implementer.external_writes)
        judge = arp.read_agent_runtime_profile("aria-adversarial-judge", repo_root=_REPO_ROOT)
        self.assertEqual((judge.model, judge.profile_id, judge.write_capable), ("glm-5.3", "judge_glm", False))

    def test_I_V12_PROFILE_03_drift_and_unknown_profile_fail_toward_the_kernel(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".claude" / "agents").mkdir(parents=True)
            (root / ".claude" / "agents" / "aria-drift.md").write_text(
                "---\nname: aria-drift\nruntime_profile: judge_opus\nmodel: haiku\neffort: low\ntools: Read\n---\n",
                encoding="utf-8",
            )
            (root / ".claude" / "agents" / "aria-unknown.md").write_text(
                "---\nname: aria-unknown\nruntime_profile: nope\nmodel: haiku\neffort: low\ntools: Read, Edit, Write, Bash\n---\n",
                encoding="utf-8",
            )
            arp._read_profile_cached.cache_clear()
            drift = arp.read_agent_runtime_profile("aria-drift", repo_root=root)
            unknown = arp.read_agent_runtime_profile("aria-unknown", repo_root=root)
        self.assertEqual((drift.model, drift.effort, drift.source), ("opus", "max", "kernel_profile_mirror_drift"))
        self.assertEqual((unknown.model, unknown.source, unknown.tools), (arp.DEFAULT_MODEL, "default_invalid", ()))
        self.assertFalse(unknown.write_capable, "an unknown profile must not widen into a writer")


class DenyListIsDerived(unittest.TestCase):
    def test_I_V12_PROFILE_04_ungranted_tools_and_external_writes_are_denied(self) -> None:
        implementer = profile_by_id("implementer")
        denies = disallowed_tools_for(implementer)
        for tool in CLAUDE_TOOL_UNIVERSE:
            self.assertEqual(tool in denies, tool not in implementer.tools, tool)
        for tool in ALWAYS_DENIED_TOOLS:
            self.assertIn(tool, denies)
        for rule in EXTERNAL_WRITE_DENY_RULES:
            self.assertIn(rule, denies)
        judge = profile_by_id("judge_opus")
        judge_denies = disallowed_tools_for(judge)
        self.assertIn("Bash", judge_denies)
        self.assertIn("Edit", judge_denies)
        self.assertFalse(set(EXTERNAL_WRITE_DENY_RULES) & set(judge_denies), "no Bash, no Bash rules")


class WriteTierRosterAgrees(unittest.TestCase):
    def test_I_V12_PROFILE_05_write_tier_agents_are_exactly_the_file_writing_profiles(self) -> None:
        # The roster is about agents that can CHANGE FILES (Edit/Write); a
        # Bash-only validator runs tests and writes nothing, and the jest
        # mirror (ORPHAN-HIGH-285) pins the roster to exactly those agents.
        edit_tools = WRITE_TOOLS - {"Bash"}
        arp._read_profile_cached.cache_clear()
        writers = set()
        for path in (_REPO_ROOT / ".claude" / "agents").glob("aria-*.md"):
            resolved = arp.read_agent_runtime_profile(path.stem, repo_root=_REPO_ROOT)
            if edit_tools & set(resolved.tools):
                writers.add(path.stem)
        roster = set(arp.WRITE_TIER_AGENTS)
        # Maintenance-only names in the roster (no aria-*.md at the root) are
        # allowed to stay; every root agent that can write must be rostered
        # and every rostered root agent must actually be able to write.
        root_roster = {name for name in roster if (_REPO_ROOT / ".claude" / "agents" / f"{name}.md").is_file()}
        self.assertEqual(writers, root_roster, f"writers={sorted(writers)} roster={sorted(root_roster)}")


if __name__ == "__main__":
    unittest.main()
