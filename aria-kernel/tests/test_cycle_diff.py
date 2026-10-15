"""Direct tests for ``cycle_diff.run_cycle_diff`` path deltas.

``test_enterprise_cycle`` drives ``run_cycle_diff`` through real discovery
runs for the baseline, changed-path and legacy-artifact shapes, but nothing
asserted the added and removed branches (``added_paths`` / ``removed_paths``)
or the persisted baseline row. These cases run the real function over a
minimal two-cycle discovery tree: a baseline cycle with no predecessor, then
a follow-up cycle with one added, one removed and one changed path.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.cycle_diff import run_cycle_diff


def _write_cycle(root: Path, cycle_id: str, files: dict[str, str]) -> None:
    cycle_dir = root / "discovery" / cycle_id
    cycle_dir.mkdir(parents=True, exist_ok=True)
    (cycle_dir / "FATES.json").write_text(
        json.dumps(
            {
                "files": [
                    {"path": path, "content_hash": digest}
                    for path, digest in files.items()
                ],
            },
        ),
        encoding="utf-8",
    )
    (cycle_dir / "REPO_FINGERPRINT.json").write_text("{}", encoding="utf-8")


class RunCycleDiffBehavior(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-cycle-diff-")
        self.root = Path(self._tmp.name) / "aria-tools"
        self.root.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_first_cycle_is_baseline_with_empty_delta(self) -> None:
        _write_cycle(self.root, "cyc-a", {"a.py": "h-a0", "c.py": "h-c0"})
        payload = run_cycle_diff(cycle_id="cyc-a", base_dir=self.root)
        self.assertTrue(payload["baseline"])
        self.assertIsNone(payload["previous_cycle_id"])
        self.assertEqual(payload["summary"]["added_count"], 0)
        self.assertEqual(payload["summary"]["removed_count"], 0)
        self.assertEqual(payload["summary"]["changed_count"], 0)
        self.assertEqual(payload["added_paths"], [])
        self.assertEqual(payload["removed_paths"], [])
        self.assertEqual(payload["changed_paths"], [])
        # The run persists its row: real write + read-back.
        persisted = json.loads(
            (self.root / "cycle-diff" / "cyc-a.json").read_text(encoding="utf-8"),
        )
        self.assertEqual(persisted["cycle_id"], "cyc-a")

    def test_followup_cycle_computes_add_remove_change(self) -> None:
        _write_cycle(self.root, "cyc-a", {"a.py": "h-a0", "c.py": "h-c0"})
        _write_cycle(self.root, "cyc-b", {"a.py": "h-a1", "b.py": "h-b0"})
        payload = run_cycle_diff(cycle_id="cyc-b", base_dir=self.root)
        self.assertFalse(payload["baseline"])
        self.assertEqual(payload["previous_cycle_id"], "cyc-a")
        self.assertEqual(payload["summary"]["added_count"], 1)
        self.assertEqual(payload["summary"]["removed_count"], 1)
        self.assertEqual(payload["summary"]["changed_count"], 1)
        self.assertEqual(payload["added_paths"], ["b.py"])
        self.assertEqual(payload["removed_paths"], ["c.py"])
        self.assertEqual(payload["changed_paths"], ["a.py"])
        self.assertEqual(payload["summary"]["tracked_file_count"], 2)


if __name__ == "__main__":
    unittest.main()
