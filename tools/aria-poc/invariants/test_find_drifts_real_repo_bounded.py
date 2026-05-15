"""Plan ARIA-V2 §3.6 + I-39 — real-repo drift upper bound.

After the dedup architecture lands (I-20) and ``.worktrees`` is
excluded (I-19), the actual snowball repo MUST produce at most 50
drift entries from ``find_drifts``. If the count exceeds 50, either:

  * a legitimate new drift class appeared (operator must triage and
    bump the bound after addressing the underlying drift), OR
  * the dedup logic regressed (Tier-3 detection — this test fails CI
    forcing a fix before merge).

50 is generous — empirically the current repo produces ~5-15.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_POC_PATH = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
_SPEC = importlib.util.spec_from_file_location("aria_poc_for_test_i39", _POC_PATH)
assert _SPEC and _SPEC.loader
aria_poc = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = aria_poc
_SPEC.loader.exec_module(aria_poc)


_DRIFT_UPPER_BOUND = 50


class FindDriftsRealRepoBounded(unittest.TestCase):
    def test_real_repo_drift_count_below_upper_bound(self) -> None:
        repo_root = _REPO_ROOT
        if not (repo_root / ".git").exists() and not (repo_root / ".git").is_dir():
            # Worktree case — ``.git`` is a file. Allow it.
            git_file = repo_root / ".git"
            if not git_file.exists():
                self.skipTest(
                    f"No git repo at {repo_root} — real-repo bound only meaningful in CI/dev"
                )

        # Run the same enum collection the PoC top-level does.
        fates = [
            aria_poc.assign_fate(p, repo_root)
            for p in aria_poc.walk_repo(repo_root)
        ]
        ts_enums = aria_poc.detect_ts_enums(repo_root, fates)
        ts_unions = aria_poc.detect_ts_union_types(repo_root, fates)
        ts_const_arrays = aria_poc.detect_ts_const_arrays(repo_root, fates)
        zod_enums = aria_poc.detect_zod_enums(repo_root, fates)
        sql_enums = aria_poc.detect_sql_enums(repo_root, fates)

        ts_all = ts_enums + ts_unions + ts_const_arrays + zod_enums
        drifts_above, _drifts_filtered = aria_poc.find_drifts(ts_all, sql_enums)

        self.assertLessEqual(
            len(drifts_above),
            _DRIFT_UPPER_BOUND,
            msg=(
                f"Real repo produced {len(drifts_above)} drifts (bound {_DRIFT_UPPER_BOUND}). "
                f"Either dedup regressed or new legitimate drift class appeared; "
                f"triage required."
            ),
        )


if __name__ == "__main__":
    unittest.main()
