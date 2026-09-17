"""The executor says out loud when it is running on its standalone fallbacks.

`ci_executor` binds a dozen kernel seams in ONE `try` block — the prompt
renderer, envelope fusion, governance appends, the sandbox probe, the
rejection-code set, the liveness bounds — and on any import failure falls
back to standalone stand-ins for all of them at once. That block used to
swallow the exception: a single missing kernel name (executor/kernel version
skew) silently turned every rejected submit into `submit_rejected`, every
governance append into a no-op, and left nothing in the run log to explain
it. The fallback branch now writes one marked stderr line naming the
failed import.

Pinned in a subprocess, because the fallback is an IMPORT-time decision:
the kernel is imported and one name the executor binds is removed from it
(the version-skew shape: a kernel without that symbol), the executor is
imported, and the marker line — naming the missing symbol — must be on
stderr; a clean import must not print it. The same subprocess proves the
standalone mirrors of the kernel bounds are the kernel's numbers, so the
derived submit wall clock is identical with or without the kernel.
"""
from __future__ import annotations

import json
import subprocess
import sys
import unittest
from pathlib import Path

from aria_kernel.evidence_probe import (
    EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
    GIT_PROBE_WORST_CASE_SECONDS,
)
from aria_kernel.human_required import HUMAN_REQUIRED_RECORD_WAIT_SECONDS
from aria_kernel.implementation_delivery import IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS
from aria_kernel.ledger import STATE_LOCK_LIVENESS_SECONDS
from aria_kernel.state_store import (
    GIT_TIMEOUT_SECONDS,
    STATE_STORE_CHECKOUT_ARC_SECONDS,
    STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]
_POC_DIR = _REPO_ROOT / "tools" / "aria-poc"
if str(_POC_DIR) not in sys.path:
    sys.path.insert(0, str(_POC_DIR))

import ci_executor  # noqa: E402

_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
_MISSING_SYMBOL = "aria_kernel.evidence_validator.EVIDENCE_VERIFICATION_UNAVAILABLE_CODES"

_IMPORT_PROBE = r"""
import importlib, json, sys
missing = sys.argv[1]
sys.path.insert(0, sys.argv[3])
if missing:
    module_name, _, symbol = missing.rpartition(".")
    delattr(importlib.import_module(module_name), symbol)
sys.path.insert(0, sys.argv[2])
import ci_executor
print(json.dumps({
    "codes": sorted(ci_executor._EVIDENCE_VERIFICATION_UNAVAILABLE_CODES),
    "submit_timeout": ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS,
    "lock_bound": ci_executor._STATE_LOCK_LIVENESS_SECONDS,
    "probe_bound": ci_executor._EVIDENCE_VERIFICATION_LIVENESS_SECONDS,
    "probe_worst_case": ci_executor._GIT_PROBE_WORST_CASE_SECONDS,
    "git_timeout": ci_executor._GIT_TIMEOUT_SECONDS,
    "lifecycle_bound": ci_executor._STATE_STORE_LIFECYCLE_LIVENESS_SECONDS,
    "checkout_arc": ci_executor._STATE_STORE_CHECKOUT_ARC_SECONDS,
    "record_wait": ci_executor._HUMAN_REQUIRED_RECORD_WAIT_SECONDS,
    "record_worst_case": ci_executor.HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS,
    "delivery_worst_case": ci_executor.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
    "child_worst_case": ci_executor.child_worst_case_seconds(1800),
    "child_worst_case_with_worktree": ci_executor.child_worst_case_seconds(1800, worktree_per_request=True),
    "implementation_child_worst_case": ci_executor.child_worst_case_seconds(
        1800, worktree_per_request=True,
        implementation_delivery_seconds=ci_executor.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS,
    ),
}))
"""


def _import_executor(missing_symbol: str) -> tuple[dict, str]:
    proc = subprocess.run(
        [sys.executable, "-c", _IMPORT_PROBE, missing_symbol, str(_POC_DIR), str(_KERNEL_DIR)],
        capture_output=True,
        text=True,
        check=True,
        cwd=str(_REPO_ROOT),
        timeout=120,
    )
    return json.loads(proc.stdout.strip().splitlines()[-1]), proc.stderr


class KernelImportFallbackIsAnnounced(unittest.TestCase):
    def test_a_missing_kernel_symbol_is_named_on_stderr(self) -> None:
        payload, stderr = _import_executor(_MISSING_SYMBOL)
        marker_lines = [
            line for line in stderr.splitlines()
            if line.startswith(ci_executor.KERNEL_IMPORT_FALLBACK_MARKER)
        ]
        self.assertEqual(len(marker_lines), 1, stderr)
        module_name, _, symbol = _MISSING_SYMBOL.rpartition(".")
        self.assertIn(symbol, marker_lines[0])
        self.assertIn(module_name, marker_lines[0])
        self.assertIn("ImportError", marker_lines[0])
        # The behavioural consequence the line explains: no code can be
        # classified as the kernel's own gap.
        self.assertEqual(payload["codes"], [])

    def test_a_clean_import_prints_no_marker(self) -> None:
        payload, stderr = _import_executor("")
        self.assertNotIn(ci_executor.KERNEL_IMPORT_FALLBACK_MARKER, stderr)
        self.assertTrue(payload["codes"])

    def test_the_standalone_bounds_mirror_the_kernels(self) -> None:
        with_kernel, _ = _import_executor("")
        without_kernel, _ = _import_executor(_MISSING_SYMBOL)
        self.assertEqual(without_kernel["lock_bound"], STATE_LOCK_LIVENESS_SECONDS)
        self.assertEqual(without_kernel["probe_bound"], EVIDENCE_VERIFICATION_LIVENESS_SECONDS)
        self.assertEqual(without_kernel["probe_worst_case"], GIT_PROBE_WORST_CASE_SECONDS)
        self.assertEqual(without_kernel["git_timeout"], GIT_TIMEOUT_SECONDS)
        self.assertEqual(without_kernel["lifecycle_bound"], STATE_STORE_LIFECYCLE_LIVENESS_SECONDS)
        self.assertEqual(without_kernel["checkout_arc"], STATE_STORE_CHECKOUT_ARC_SECONDS)
        self.assertEqual(without_kernel["record_wait"], HUMAN_REQUIRED_RECORD_WAIT_SECONDS)
        self.assertEqual(without_kernel["record_worst_case"], with_kernel["record_worst_case"])
        self.assertEqual(with_kernel["record_worst_case"], ci_executor.HUMAN_REQUIRED_RECORD_WORST_CASE_SECONDS)
        # ARIA-HIGH-124 (round 3) — the implementation child's delivery term
        # (the publication, the contained gate at the canonical ceiling, the
        # push, the PR) is the kernel's derivation, mirrored standalone.
        self.assertEqual(without_kernel["delivery_worst_case"], IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS)
        self.assertEqual(with_kernel["delivery_worst_case"], IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS)
        self.assertEqual(without_kernel["implementation_child_worst_case"], with_kernel["implementation_child_worst_case"])
        self.assertEqual(
            without_kernel["child_worst_case_with_worktree"], with_kernel["child_worst_case_with_worktree"],
        )
        self.assertEqual(without_kernel["submit_timeout"], with_kernel["submit_timeout"])
        self.assertEqual(with_kernel["submit_timeout"], ci_executor.SUBMIT_RESULT_TIMEOUT_SECONDS)
        # The whole-child derivation — the number the drain loop checks — is
        # the same with and without the kernel.
        self.assertEqual(without_kernel["child_worst_case"], with_kernel["child_worst_case"])
        self.assertEqual(with_kernel["child_worst_case"], ci_executor.child_worst_case_seconds(1800))

    def test_the_marker_is_a_workflow_annotation(self) -> None:
        # `::warning::` so GitHub surfaces it on the run summary, not only
        # in the raw log.
        self.assertTrue(ci_executor.KERNEL_IMPORT_FALLBACK_MARKER.startswith("::warning::"))


if __name__ == "__main__":
    unittest.main()
