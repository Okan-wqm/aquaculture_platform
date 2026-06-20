"""Plan ARIA-V2 §3.4 + I-23 — tracked-allowlist set-equality invariant.

After Phase 5 the only files Git tracks under ``aria-tools/`` are:

  * ``aria-tools/repo_identity.json``           (v3 schema-stamp)
  * ``aria-tools/agent-evals/fixtures/F*.json`` (eval fixtures)
  * ``aria-tools/reports/daily/YYYY-MM-DD.md``  (daily chain-tip anchors)

Anything else under ``aria-tools/`` is per-clone operator runtime state
and MUST stay gitignored (GDPR Art 4 data-minimization rationale —
ARIA_ACTOR + operator --reason text are PII-adjacent).

The assertion is bidirectional set-equality (not subset):
  - any unallowed tracked path → CI fails (drift caught)
  - any allowlisted path missing on disk → CI fails (no silent removal)

A future maintainer who wants to track a new file under aria-tools/
MUST update the allowlist in this test AND the gitignore block in
``.gitignore`` together — the symmetric check guarantees the two
sources stay in sync.
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]


# Plan ARIA-V2 §3.4 — Set of glob-style patterns that the allowlist
# accepts. Each tracked path is matched against this set; new patterns
# require a deliberate update in this file PLUS a corresponding
# negate-rule in the gitignore block.
_ALLOWLIST_PATTERNS: frozenset[str] = frozenset({
    "aria-tools/repo_identity.json",
    "aria-tools/agent-evals/fixtures/*.json",
    "aria-tools/reports/daily/*.md",
})


def _matches_pattern(path: str, pattern: str) -> bool:
    """``fnmatch``-style match restricted to the patterns above.

    We avoid pulling fnmatch wholesale because the allowlist patterns
    are intentionally narrow — exact path OR ``<dir>/*.<ext>``. A
    targeted matcher prevents accidental over-acceptance.
    """
    if "*" not in pattern:
        return path == pattern
    prefix, _, suffix_pat = pattern.partition("/*")
    # suffix_pat is something like ``.json`` or ``.md`` (with a leading dot).
    if not path.startswith(prefix + "/"):
        return False
    tail = path[len(prefix) + 1:]
    if "/" in tail:
        # ``*`` does NOT cross directory boundaries.
        return False
    return tail.endswith(suffix_pat)


class AriaToolsTrackedAllowlist(unittest.TestCase):
    def test_tracked_files_match_allowlist_set_equality(self) -> None:
        result = subprocess.run(
            ["git", "-C", str(_REPO_ROOT), "ls-files", "aria-tools/"],
            check=True,
            capture_output=True,
            text=True,
        )
        tracked = sorted(line for line in result.stdout.splitlines() if line)

        # 1. No tracked path may fall outside the allowlist.
        violations = [
            p
            for p in tracked
            if not any(_matches_pattern(p, pat) for pat in _ALLOWLIST_PATTERNS)
        ]
        self.assertEqual(
            violations,
            [],
            msg=(
                f"Unallowed tracked aria-tools/ paths: {violations}. "
                f"Either gitignore them (preferred) or update the "
                f"_ALLOWLIST_PATTERNS in this file."
            ),
        )

        # 2. Each pattern must match at least one tracked path (no
        #    dead patterns).
        unused_patterns = []
        for pat in sorted(_ALLOWLIST_PATTERNS):
            if not any(_matches_pattern(p, pat) for p in tracked):
                unused_patterns.append(pat)
        self.assertEqual(
            unused_patterns,
            [],
            msg=(
                f"Allowlist patterns matched no tracked path: {unused_patterns}. "
                f"Either restore the missing file or drop the pattern."
            ),
        )

    def test_no_preflight_capture_files_tracked(self) -> None:
        result = subprocess.run(
            ["git", "-C", str(_REPO_ROOT), "ls-files", "aria-tools/preflight"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.stdout.strip(), "")

    def test_no_runtime_ledger_files_tracked(self) -> None:
        """Defensive: explicit ban-list of ledger names that MUST be
        gitignored. Catches the case where a future maintainer adds a
        new runtime ledger and forgets to gitignore it.
        """
        result = subprocess.run(
            ["git", "-C", str(_REPO_ROOT), "ls-files", "aria-tools/"],
            check=True,
            capture_output=True,
            text=True,
        )
        tracked = result.stdout.splitlines()
        banned_suffixes = (
            ".jsonl",
            ".lock",
        )
        banned_filenames = {
            "integrity_index.json",
            "migration_state.json",
            "registry.json",
            "registry-stub-allowlist.json",
            "problem_clusters.jsonl",
            "dashboard.md",
            "active-plans-cache.json",
        }
        leaks: list[str] = []
        for path in tracked:
            name = path.rsplit("/", 1)[-1]
            if name in banned_filenames:
                leaks.append(path)
            elif any(name.endswith(suf) for suf in banned_suffixes):
                leaks.append(path)
        self.assertEqual(
            leaks,
            [],
            msg=f"Runtime ledger files leaked into tracked set: {leaks}",
        )


if __name__ == "__main__":
    unittest.main()
