"""Tests asserting the ARIA maintenance agent files match Plan 016 contract.

Plan 016 Faz C3 ships three maintenance agents under
`.claude/agents/_maintenance/`. They are dispatchable only via the kernel
async queue; the runtime domain dispatcher must never resolve them. This
test asserts:

- the three files exist;
- each frontmatter declares `model: opus`, `effort: high`, and
  `tools: Read, Grep, Glob`;
- each `name` field matches the ARIA whitelist in agent_contract.py;
- the body cites the kernel-issued envelope as the only invocation path;
- existing TS maintenance-isolation invariant covers their absence from
  orchestrator.md's Runtime Review Roster (this Python test does not
  duplicate that logic).
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from aria_kernel.agent_contract import DEFAULT_TARGET_AGENT_WHITELIST


REPO_ROOT = Path(__file__).resolve().parents[2]
MAINTENANCE_DIR = REPO_ROOT / ".claude" / "agents" / "_maintenance"
EXPECTED_FILES = (
    "aria-prompt-writer.md",
    "aria-primary-planner.md",
    "aria-challenger-planner.md",
)
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
        self.files = {name: MAINTENANCE_DIR / name for name in EXPECTED_FILES}

    def test_all_three_files_exist(self) -> None:
        for name, path in self.files.items():
            self.assertTrue(path.exists(), f"missing {name} at {path}")

    def test_frontmatter_has_required_fields(self) -> None:
        for name, path in self.files.items():
            text = path.read_text(encoding="utf-8")
            front = _parse_frontmatter(text)
            self.assertEqual(front.get("model"), "opus", f"{name}: model not opus")
            self.assertEqual(front.get("effort"), "high", f"{name}: effort not high")
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
