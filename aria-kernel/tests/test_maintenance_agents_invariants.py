"""Tests asserting the ARIA opus-tier agent files match the kernel contract.

Plan 016 Faz C3 originally shipped three agents under
`.claude/agents/_maintenance/` (`aria-prompt-writer`,
`aria-primary-planner`, `aria-challenger-planner`). Plan ARIA-V8.1
promoted the two planner agents to runtime (`.claude/agents/`)
because the V8 P+C+CR convergent gate dispatches them per cycle —
they are no longer maintenance-bound; the V8.1 invariants at
`tests/invariants/v8/test_phase_v8_1_canonical_envelope.py`
(I-V8.1-01) pin the new runtime locations.

This test asserts the SHARED contract across all three opus-tier
agents (regardless of physical location):

- the three files exist at their post-V8.1 canonical locations;
- each frontmatter declares `model: opus` and `tools: Read, Grep, Glob`;
- each `name` field matches the ARIA whitelist in agent_contract.py;
- the body cites the kernel-issued envelope as the only invocation path;
- the body forbids self-modification outside the Plan 009 PR lane.
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.agent_contract import DEFAULT_TARGET_AGENT_WHITELIST


REPO_ROOT = Path(__file__).resolve().parents[2]
AGENTS_DIR = REPO_ROOT / ".claude" / "agents"
MAINTENANCE_DIR = AGENTS_DIR / "_maintenance"

# V8.1 promoted the two planner agents to runtime; aria-prompt-writer
# stays maintenance-bound. Map each opus-tier ARIA agent to its
# canonical post-V8.1 file path so this invariant test reflects the
# architecture truth.
EXPECTED_LOCATIONS: tuple[tuple[str, Path], ...] = (
    ("aria-prompt-writer.md", MAINTENANCE_DIR / "aria-prompt-writer.md"),
    ("aria-primary-planner.md", AGENTS_DIR / "aria-primary-planner.md"),
    ("aria-challenger-planner.md", AGENTS_DIR / "aria-challenger-planner.md"),
)

# Plan 023 §A — model/effort tiering. All three stay on the opus model, but the
# planners are dispatched per cycle and run at `high` effort under the
# scout-and-verify split, while the maintenance prompt-writer (which authors
# judge prompts — quality-critical) stays at `xhigh`. SSoT:
# aria-kernel/aria_kernel/agent_runtime_profile.py.
EXPECTED_EFFORT: dict[str, str] = {
    "aria-prompt-writer.md": "xhigh",
    "aria-primary-planner.md": "high",
    "aria-challenger-planner.md": "high",
}
FRONTMATTER_RE = re.compile(
    r"\A---\n(.*?)\n---\n",
    re.DOTALL,
)


def _parse_frontmatter(text: str) -> dict[str, str]:
    match = FRONTMATTER_RE.search(text)
    if not match:
        return {}
    fields: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if ":" not in line:
            continue
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields


class MaintenanceAgentInvariantTests(unittest.TestCase):
    def setUp(self) -> None:
        self.files = {name: path for name, path in EXPECTED_LOCATIONS}

    def test_all_three_files_exist(self) -> None:
        for name, path in self.files.items():
            self.assertTrue(path.exists(), f"missing {name} at {path}")

    def test_frontmatter_has_required_fields(self) -> None:
        for name, path in self.files.items():
            text = path.read_text(encoding="utf-8")
            front = _parse_frontmatter(text)
            self.assertEqual(front.get("model"), "opus", f"{name}: model not opus")
            self.assertEqual(
                front.get("effort"), EXPECTED_EFFORT[name],
                f"{name}: effort not {EXPECTED_EFFORT[name]} "
                "(Plan 023 §A scout-and-verify tiering)",
            )
            tools = front.get("tools", "")
            self.assertEqual(
                set(t.strip() for t in tools.split(",")),
                {"Read", "Grep", "Glob"},
                f"{name}: tools not Read/Grep/Glob",
            )

    def test_frontmatter_name_matches_filename_and_whitelist(self) -> None:
        for filename, path in self.files.items():
            text = path.read_text(encoding="utf-8")
            front = _parse_frontmatter(text)
            declared = front.get("name", "")
            stem = filename.removesuffix(".md")
            self.assertEqual(declared, stem, f"{filename}: name mismatch")
            self.assertIn(
                declared,
                DEFAULT_TARGET_AGENT_WHITELIST,
                f"{declared}: not in DEFAULT_TARGET_AGENT_WHITELIST",
            )

    def test_body_advertises_kernel_envelope_only(self) -> None:
        for name, path in self.files.items():
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                "aria/agent-request/v1",
                text,
                f"{name}: body must reference the kernel-issued envelope schema",
            )
            self.assertIn(
                "satisfaction matrix",
                text.lower(),
                f"{name}: body must require a satisfaction matrix",
            )

    def test_body_forbids_self_modification(self) -> None:
        for name, path in self.files.items():
            text = path.read_text(encoding="utf-8")
            # Each agent must explicitly forbid modifying its own prompt
            # outside the Plan 009 kernel-self-change PR lane.
            self.assertIn(
                "Plan 009",
                text,
                f"{name}: body must reference Plan 009 kernel-self-change PR lane",
            )


if __name__ == "__main__":
    unittest.main()
