"""Plan ARIA-V2 §3.6 + I-19 — ``walk_repo`` must skip ``.worktrees/``.

Before this invariant existed, ``tools/aria-poc/poc.py`` walked into
``.worktrees/<branch>/`` and double-counted every TS enum / SQL enum /
UI option group present in the sibling worktree. Running the PoC from
a repo with an active worktree (e.g. ``snowball``) inflated
MECHANICAL_DRIFTS from ~10 to 126 (ARIA-V-003 reproduction).

The architectural fix landed ``.worktrees`` in
``tools.shared.excluded_paths.BASE_EXCLUDED_DIRS``; this test locks
that fact so a future maintainer cannot silently delete the entry.
"""

from __future__ import annotations

import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_POC_PATH = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
_SPEC = importlib.util.spec_from_file_location("aria_poc_for_test_i19", _POC_PATH)
assert _SPEC and _SPEC.loader
aria_poc = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = aria_poc
_SPEC.loader.exec_module(aria_poc)


class WalkRepoExcludesWorktrees(unittest.TestCase):
    def test_walk_repo_skips_dotworktrees_subtree(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)

            tracked = root / "apps" / "farm-service" / "src" / "thing.ts"
            tracked.parent.mkdir(parents=True)
            tracked.write_text("// tracked\n", encoding="utf-8")

            worktree_file = root / ".worktrees" / "snowball" / "apps" / "farm-service" / "src" / "thing.ts"
            worktree_file.parent.mkdir(parents=True)
            worktree_file.write_text("// in worktree — must be skipped\n", encoding="utf-8")

            rels = {str(p.relative_to(root)) for p in aria_poc.walk_repo(root)}

        self.assertIn("apps/farm-service/src/thing.ts", rels)
        self.assertNotIn(".worktrees/snowball/apps/farm-service/src/thing.ts", rels)
        worktree_descendants = [r for r in rels if r.startswith(".worktrees/")]
        self.assertEqual(
            worktree_descendants,
            [],
            msg=f"walk_repo leaked .worktrees descendants: {worktree_descendants}",
        )

    def test_excluded_dirs_contains_worktrees_token(self) -> None:
        self.assertIn(".worktrees", aria_poc.EXCLUDED_DIRS)


if __name__ == "__main__":
    unittest.main()
