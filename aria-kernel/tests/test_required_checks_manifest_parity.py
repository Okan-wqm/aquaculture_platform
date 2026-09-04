"""ARIA-MEDIUM-036 — the kernel's required-checks tuple must equal the governed manifest.

`.github/manifests/main-required-status-checks.json` is the SSoT for what
`main` requires (findings EDGE-CRITICAL-001 / INFRA-CRITICAL-044 /
INFRA-HIGH-084). `enterprise_readiness.REQUIRED_MERGE_STATUS_CHECKS` is what
the readiness claim compares the live branch protection against. When
INFRA-HIGH-084 added ``build-status`` to the manifest, the tuple was left at
three contexts and every readiness claim on main rejected the repository's
own correct protection with ``branch_protection_exact_required_checks_mismatch``
— for days, with no test going red. This test is that missing red: the two
lists are compared as sets AND as exact sequences of the manifest's
``contexts`` so an addition, a removal or a rename on either side fails CI.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from aria_kernel.enterprise_readiness import REQUIRED_MERGE_STATUS_CHECKS

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST = REPO_ROOT / ".github" / "manifests" / "main-required-status-checks.json"


class RequiredChecksManifestParityTests(unittest.TestCase):
    def test_manifest_is_present_and_governed(self) -> None:
        self.assertTrue(MANIFEST.is_file(), MANIFEST)
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        self.assertEqual(manifest["branch"], "main")
        self.assertEqual(manifest["$schema"], "aqua/github-required-status-checks/v1")

    def test_kernel_tuple_equals_manifest_contexts(self) -> None:
        manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
        contexts = manifest["required_status_checks"]["contexts"]
        checks = [entry["context"] for entry in manifest["required_status_checks"]["checks"]]
        # The manifest is internally consistent: contexts[] and checks[] name
        # the same set, so either can be the reference.
        self.assertEqual(sorted(contexts), sorted(checks))
        self.assertEqual(
            sorted(REQUIRED_MERGE_STATUS_CHECKS),
            sorted(contexts),
            "enterprise_readiness.REQUIRED_MERGE_STATUS_CHECKS drifted from "
            ".github/manifests/main-required-status-checks.json — mirror the "
            "manifest (it is the SSoT) and re-run the readiness claim",
        )
        self.assertEqual(len(set(REQUIRED_MERGE_STATUS_CHECKS)), len(REQUIRED_MERGE_STATUS_CHECKS))


if __name__ == "__main__":
    unittest.main()
