"""Plan ARIA-V4 Phase A — pedagogy contract + tier registry.

The 6-agent narrative-pedagogy audit identified that the ARIA corpus
(9 agent files) was ~80% pure imperative — "DO NOT" / "MUST NOT" /
"FORBIDDEN" with no causal scaffolding. Plan ARIA-V4 lands a tiered
pedagogy where each agent declares ITS tier via a frontmatter field,
and a central registry records the SSoT mapping:

  * Tier-1 (imperative) — machine-parsed contracts, consensus-gate
    math, safety/identity rules. Bare imperative; grep-stable.
  * Tier-2 (hybrid) — architectural rules. Imperative headline +
    narrative body (Temptation / Why-looks-correct / Downstream-
    consequence / Correct-path-with-invariant).
  * Tier-3 (full narrative) — style + extrapolation-heavy rules.
    Full 4-section narrative; ends on invariant, never consequence.

I-V4-01..03 invariants:

  * I-V4-01 — every aria-*.md agent file declares ``pedagogy-tier:``.
  * I-V4-02 — frontmatter ``pedagogy-tier:`` matches the entry in
    ``.claude/agents/_pedagogy-registry.json``.
  * I-V4-03 — ``pedagogy-tier:`` value is in {1, 2, 3}.
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
_AGENTS_DIR = _REPO_ROOT / ".claude" / "agents"
_PEDAGOGY_REGISTRY = _AGENTS_DIR / "_pedagogy-registry.json"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))

from aria_kernel.pedagogy_lint import is_agent_markdown_file

_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---\n", re.DOTALL)
_PEDAGOGY_TIER_RE = re.compile(r"^pedagogy-tier:\s*(\d+)\s*$", re.MULTILINE)
_NAME_RE = re.compile(r"^name:\s*(\S+)\s*$", re.MULTILINE)


def _aria_agent_files() -> list[Path]:
    """Plan ARIA-V4 §2a + V5.3 §3e v2 R1 — loosen scope to every
    agent file under ``.claude/agents/**/*.md`` (V5.3 universalizes
    V4's pedagogy-tier discipline to all 81 agents). READMEs skipped.

    Pre-V5.3 the V4 invariant scanned only the 9 ``aria-*.md``
    agents — V5.3 §3e R1 explicitly loosens the glob via this
    helper. The downstream tests (I-V4-01..03) continue to assert
    pedagogy-tier presence + registry co-equality, now over the
    full 81-agent corpus.
    """
    return sorted(
        p for p in _AGENTS_DIR.rglob("*.md")
        if is_agent_markdown_file(p, _AGENTS_DIR)
    )


def _parse_frontmatter(path: Path) -> tuple[str | None, int | None]:
    """Return (agent_name, pedagogy_tier_int) from the YAML
    frontmatter block. None values indicate missing fields.
    """
    text = path.read_text(encoding="utf-8")
    match = _FRONTMATTER_RE.match(text)
    if not match:
        return (None, None)
    fm = match.group(1)
    name_match = _NAME_RE.search(fm)
    tier_match = _PEDAGOGY_TIER_RE.search(fm)
    name = name_match.group(1) if name_match else None
    tier = int(tier_match.group(1)) if tier_match else None
    return (name, tier)


class PhaseV4APedagogyRegistry(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.agent_files = _aria_agent_files()
        cls.registry = json.loads(_PEDAGOGY_REGISTRY.read_text(encoding="utf-8"))

    def test_aria_corpus_non_empty(self) -> None:
        # Sanity — the audit identified 9 ARIA agents; baseline guard.
        self.assertGreaterEqual(
            len(self.agent_files),
            9,
            msg="ARIA agent corpus shrunk below 9 — schema baseline broken",
        )

    # I-V4-01 — every aria-*.md declares pedagogy-tier.
    def test_i_v4_01_every_aria_agent_declares_pedagogy_tier(self) -> None:
        missing: list[str] = []
        for path in self.agent_files:
            _, tier = _parse_frontmatter(path)
            if tier is None:
                missing.append(str(path.relative_to(_REPO_ROOT)))
        self.assertEqual(
            missing,
            [],
            msg=(
                "Plan ARIA-V4 §2a requires every aria-*.md file to "
                "declare a `pedagogy-tier:` frontmatter field. "
                "Missing in:\n" + "\n".join(missing)
            ),
        )

    # I-V4-02 — frontmatter tier matches registry.
    def test_i_v4_02_pedagogy_registry_matches_per_agent_frontmatter(
        self,
    ) -> None:
        assignments = self.registry.get("tier_assignments", {})
        violations: list[str] = []
        for path in self.agent_files:
            name, tier = _parse_frontmatter(path)
            if name is None:
                violations.append(
                    f"{path.relative_to(_REPO_ROOT)}: missing `name:` in frontmatter"
                )
                continue
            registry_entry = assignments.get(name)
            if registry_entry is None:
                violations.append(
                    f"{path.relative_to(_REPO_ROOT)}: agent {name!r} "
                    f"not present in _pedagogy-registry.json "
                    f"tier_assignments"
                )
                continue
            expected = registry_entry.get("pedagogy_tier")
            if expected != tier:
                violations.append(
                    f"{path.relative_to(_REPO_ROOT)}: frontmatter "
                    f"pedagogy-tier={tier} != registry={expected} for "
                    f"agent {name!r}"
                )
        self.assertEqual(violations, [], msg="\n".join(violations))

    # I-V4-03 — pedagogy-tier value in {1, 2, 3}.
    def test_i_v4_03_pedagogy_tier_in_known_enum(self) -> None:
        invalid: list[str] = []
        for path in self.agent_files:
            _, tier = _parse_frontmatter(path)
            if tier is None:
                continue
            if tier not in {1, 2, 3}:
                invalid.append(
                    f"{path.relative_to(_REPO_ROOT)}: pedagogy-tier="
                    f"{tier} not in {{1, 2, 3}}"
                )
        self.assertEqual(invalid, [], msg="\n".join(invalid))

    # Extra: registry tier_assignments cover every aria-*.md.
    def test_registry_covers_every_aria_agent(self) -> None:
        assignments = self.registry.get("tier_assignments", {})
        on_disk = set()
        for path in self.agent_files:
            name, _ = _parse_frontmatter(path)
            if name:
                on_disk.add(name)
        registry_names = set(assignments.keys())
        missing_from_registry = on_disk - registry_names
        orphan_in_registry = registry_names - on_disk
        self.assertEqual(
            missing_from_registry,
            set(),
            msg=(
                f"Registry missing entries for on-disk agents: "
                f"{sorted(missing_from_registry)}"
            ),
        )
        self.assertEqual(
            orphan_in_registry,
            set(),
            msg=(
                f"Registry has orphan entries (no matching on-disk "
                f"agent): {sorted(orphan_in_registry)}"
            ),
        )


if __name__ == "__main__":
    unittest.main()
