"""ARIA-HIGH-138 — a seam is proven by a real process, not by a mock of it.

Every seam the live chain touched failed under a test that mocked exactly the
process that failed live: HIGH-117 (the maintenance lane's compaction),
HIGH-123 (git inside the sandbox), HIGH-124 (kernel authority and the package
import inside the sandbox), MEDIUM-134 (the suite on a host other than the
droplet). The class is ORPHAN-694's, made structural: a mechanism was added
and pinned, and nothing asked whether the production path reaches it through
a real process.

``tests/invariants/seam_registry.py`` is the one owner of the classification.
It maps each seam module to the real-process test that proves it (the process
each one exercises is named in the entry), plus a reviewed
``SPAWN_ONLY_NOT_SEAM`` set — spawn sites that are read-only probes or
plumbing, each with its one-line reason. This invariant holds the registry to
three promises:

* every seam entry names at least one real-process test file that exists,
  declares itself with a module-level ``REAL_PROCESS_SEAMS`` naming the seam,
  and never ``mock.patch``es the process layer (``subprocess``, ``socket``,
  ``os`` spawn/exec/system, ``asyncio``'s subprocess/connect/listen calls) —
  patching limits or argv builders is declared fault injection and keeps the
  real process running; patching the process layer is the defect class this
  file exists to refuse;
* every module under ``aria_kernel/`` with a spawn site (subprocess, ``os``
  spawn/exec/system, ``asyncio`` subprocess/connect/listen, an outbound
  ``socket.create_connection``, a listener bind — direct or through a
  ``socketserver`` listener class) is classified: either a registry seam or a
  reviewed SPAWN_ONLY_NOT_SEAM row. An unlisted new spawn site fails by name,
  so a seam cannot appear outside the registry unnoticed;
* the registry is closed: an entry whose module has no spawn site fails, so
  the registry cannot grow decorative rows, and SPAWN_ONLY_NOT_SEAM rows keep
  naming real spawn sites.

The lane half of the contract lives in the marked tests themselves: with
``ARIA_REQUIRE_REAL_SEAMS=1`` (set on the kernel CI jobs) a host-capability
skip in a marked test is a failure, not a green — see
``tests/_helpers/real_process_seams.py``. Sandbox-backend skips have their own
owner (``tests/_helpers/sandbox_pins.py``, refused by the suite runner) and
are not re-owned here.
"""
from __future__ import annotations

import unittest

from tests.invariants.seam_registry import (
    REPO_ROOT,
    SEAM_REGISTRY,
    SPAWN_ONLY_NOT_SEAM,
    WALK_ROOT,
    iter_spawn_sites,
    process_layer_patches,
    real_process_seam_markers,
)


class SeamRegistryTests(unittest.TestCase):
    def test_every_seam_has_a_real_process_test_that_proves_it(self) -> None:
        for module, entry in sorted(SEAM_REGISTRY.items()):
            with self.subTest(seam=module):
                module_path = REPO_ROOT / module
                self.assertTrue(
                    module_path.is_file(),
                    f"{module}: the seam module does not exist at the registered path",
                )
                self.assertTrue(
                    entry.tests,
                    f"{module}: the registry entry names no real-process test",
                )
                self.assertTrue(
                    entry.process.strip(),
                    f"{module}: the registry entry does not name the real process it exercises",
                )
                markers = real_process_seam_markers()
                for test_file in entry.tests:
                    test_path = REPO_ROOT / test_file
                    self.assertTrue(
                        test_path.is_file(),
                        f"{module}: the declared real-process test {test_file} does not exist",
                    )
                    declared = markers.get(test_file, ())
                    self.assertIn(
                        module,
                        declared,
                        f"{module}: {test_file} does not declare itself its real-process test "
                        "(a module-level REAL_PROCESS_SEAMS naming the seam)",
                    )
                    patched = process_layer_patches(test_path)
                    self.assertEqual(
                        patched,
                        [],
                        f"{module}: {test_file} mock.patches the process layer {patched}; a seam "
                        "is proven by a real process, not by a mock of it",
                    )

    def test_a_marker_may_only_name_a_registered_seam(self) -> None:
        markers = real_process_seam_markers()
        self.assertTrue(markers, "no test declares REAL_PROCESS_SEAMS; the markers are the lane half of the contract")
        for test_file, seams in sorted(markers.items()):
            for seam in seams:
                self.assertIn(
                    seam,
                    SEAM_REGISTRY,
                    f"{test_file}: REAL_PROCESS_SEAMS names {seam}, which is not a registered seam",
                )

    def test_every_spawn_site_under_aria_kernel_is_classified(self) -> None:
        unlisted = []
        for path in sorted((REPO_ROOT / WALK_ROOT).rglob("*.py")):
            module = path.relative_to(REPO_ROOT).as_posix()
            if not iter_spawn_sites(path):
                continue
            if module in SEAM_REGISTRY or module in SPAWN_ONLY_NOT_SEAM:
                continue
            unlisted.append(module)
        self.assertEqual(
            unlisted,
            [],
            "spawn sites outside the seam registry (add the seam with a real-process test, or a "
            "reviewed SPAWN_ONLY_NOT_SEAM row with its reason): " + ", ".join(unlisted),
        )

    def test_the_spawn_site_walk_root_exists(self) -> None:
        self.assertTrue(
            (REPO_ROOT / WALK_ROOT).is_dir(),
            f"the walk root {WALK_ROOT} does not exist; the registry would classify nothing",
        )

    def test_the_reviewed_set_names_real_spawn_sites_and_no_seam_twice(self) -> None:
        for module, reason in sorted(SPAWN_ONLY_NOT_SEAM.items()):
            with self.subTest(module=module):
                self.assertTrue(
                    reason.strip(),
                    f"{module}: the SPAWN_ONLY_NOT_SEAM row carries no one-line reason",
                )
                self.assertNotIn(
                    module,
                    SEAM_REGISTRY,
                    f"{module}: classified both a seam and SPAWN_ONLY_NOT_SEAM; a module is one or the other",
                )
                self.assertTrue(
                    (REPO_ROOT / module).is_file(),
                    f"{module}: the SPAWN_ONLY_NOT_SEAM row names a module that does not exist",
                )

    def test_the_registry_is_closed_every_entry_has_a_spawn_site(self) -> None:
        decorative = [
            module
            for module, _ in sorted(SEAM_REGISTRY.items())
            if not iter_spawn_sites(REPO_ROOT / module)
        ]
        self.assertEqual(
            decorative,
            [],
            "registry entries whose module has no spawn site (a decorative row proves nothing): "
            + ", ".join(decorative),
        )


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
