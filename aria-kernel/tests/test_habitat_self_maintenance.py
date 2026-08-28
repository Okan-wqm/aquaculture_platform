"""SI-4 — the janitor's blast radius and the probe's honesty.

The defect this closes was measured, not imagined: on 2026-08-19 ARIA's
own litter took the runner from 43 GB to 33 GB free in a night, the
production capacity lane went red three times, and nothing in the kernel
saw it. These pins guard the two ways a self-cleaning habitat goes wrong
— deleting what it does not own, and reporting a comfort it cannot
measure.
"""
from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from aria_kernel.habitat import (
    DEFAULT_MIN_AGE_SECONDS,
    HABITAT_DEGRADED_FREE_GB,
    OWNED_TEMP_PREFIXES,
    probe_habitat,
    sweep_stale_scratch,
)


class JanitorBlastRadius(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="si4-")
        self.root = Path(self._tmp.name)
        self.now = time.time()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def _dir(self, name: str, *, age_seconds: float) -> Path:
        path = self.root / name
        path.mkdir()
        (path / "fixture.json").write_text("{}", encoding="utf-8")
        stamp = self.now - age_seconds
        os.utime(path, (stamp, stamp))
        return path

    def test_only_owned_prefixes_are_removed(self) -> None:
        ours = self._dir("aria-cycle-abc", age_seconds=DEFAULT_MIN_AGE_SECONDS + 60)
        theirs = self._dir("postgres-socket", age_seconds=DEFAULT_MIN_AGE_SECONDS + 60)
        systemd = self._dir("systemd-private-xyz", age_seconds=10 * DEFAULT_MIN_AGE_SECONDS)
        result = sweep_stale_scratch(temp_root=self.root, now=self.now)
        self.assertEqual(result.removed, [str(ours)])
        self.assertTrue(theirs.exists())
        self.assertTrue(systemd.exists())

    def test_a_running_suite_keeps_its_scratch(self) -> None:
        fresh = self._dir("aria-suite-live", age_seconds=60)
        stale = self._dir("aqua-suite-old", age_seconds=DEFAULT_MIN_AGE_SECONDS + 1)
        result = sweep_stale_scratch(temp_root=self.root, now=self.now)
        self.assertTrue(fresh.exists(), "a fixture in use must survive the janitor")
        self.assertFalse(stale.exists())
        self.assertEqual(result.skipped_recent, 1)

    def test_a_symlink_is_never_followed(self) -> None:
        # A symlink named like our litter must not become a delete of its
        # target: the janitor's whole safety argument is that it removes
        # directories IT created, and a link is somebody's pointer.
        target = self._dir("real-data", age_seconds=DEFAULT_MIN_AGE_SECONDS + 60)
        link = self.root / "aria-link"
        link.symlink_to(target)
        sweep_stale_scratch(temp_root=self.root, now=self.now)
        self.assertTrue(target.exists())
        self.assertTrue(link.is_symlink())

    def test_dry_run_removes_nothing_but_reports_the_same_set(self) -> None:
        ours = self._dir("aria-dry", age_seconds=DEFAULT_MIN_AGE_SECONDS + 60)
        result = sweep_stale_scratch(temp_root=self.root, now=self.now, dry_run=True)
        self.assertEqual(result.removed, [str(ours)])
        self.assertTrue(ours.exists())

    def test_a_missing_temp_root_is_not_an_error(self) -> None:
        result = sweep_stale_scratch(temp_root=self.root / "nope", now=self.now)
        self.assertEqual(result.removed, [])
        self.assertEqual(result.failed, [])

    def test_owned_prefixes_are_a_closed_literal(self) -> None:
        # Widening this widens what ARIA may delete on its own host; the
        # literal spelling is what makes that a visible decision.
        self.assertEqual(OWNED_TEMP_PREFIXES, ("aria-", "aqua-"))


class ProbeHonesty(unittest.TestCase):
    def test_an_unprobeable_disk_is_not_reported_as_degraded(self) -> None:
        with patch("aria_kernel.habitat.shutil.disk_usage", side_effect=OSError("exotic mount")):
            probe = probe_habitat(workspace_root="/")
        self.assertIsNone(probe["free_disk_gb"])
        self.assertFalse(
            probe["degraded"],
            "only a MEASURED shortage counts — the preflight's own rule",
        )

    def test_a_measured_shortage_is_degraded(self) -> None:
        class _Usage:
            total = 100 * 1024 ** 3
            used = 90 * 1024 ** 3
            free = 10 * 1024 ** 3

        with patch("aria_kernel.habitat.shutil.disk_usage", return_value=_Usage()):
            probe = probe_habitat(workspace_root="/")
        self.assertTrue(probe["degraded"])
        self.assertEqual(probe["free_disk_gb"], 10.0)

    def test_the_threshold_sits_above_the_deploy_lane_floor(self) -> None:
        # The capacity lane refuses below 35 GiB; a habitat signal that
        # fired at the same point would arrive after the damage. Pinned so
        # a later tuning cannot quietly make ARIA the LAST to know.
        self.assertGreater(HABITAT_DEGRADED_FREE_GB, 35.0)


if __name__ == "__main__":
    unittest.main()
