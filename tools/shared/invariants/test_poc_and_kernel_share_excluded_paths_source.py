"""Plan ARIA-V2 §3.6 + I-22 — Python ``is``-identity invariant.

The ARIA Phase-1 PoC (``tools/aria-poc/poc.py``) and the ARIA kernel
discovery engine (``aria-kernel/aria_kernel/discovery.py``) MUST both
reference the same ``BASE_EXCLUDED_DIRS`` frozenset *object*. If a
future maintainer copies the set inline on one side, walk-time
exclusion will silently drift between the two engines — the bug
class that prompted Plan ARIA-V2 §3.6.

Asserting Python ``is`` identity is Tier-1 (impossible to drift the
contents without drifting the binding) and Tier-3 (any future
maintainer who breaks the import is caught by CI).
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[3]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

_ARIA_KERNEL_PATH = _REPO_ROOT / "aria-kernel"
if str(_ARIA_KERNEL_PATH) not in sys.path:
    sys.path.insert(0, str(_ARIA_KERNEL_PATH))


class PocAndKernelShareExcludedPathsSource(unittest.TestCase):
    def test_poc_excluded_dirs_is_shared_frozenset(self) -> None:
        from tools.shared.excluded_paths import BASE_EXCLUDED_DIRS as shared_base

        poc_path = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
        spec = importlib.util.spec_from_file_location("aria_poc_for_test_i22", poc_path)
        assert spec and spec.loader
        poc_module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = poc_module
        spec.loader.exec_module(poc_module)

        self.assertIs(
            poc_module.EXCLUDED_DIRS,
            shared_base,
            msg=(
                "tools/aria-poc/poc.py:EXCLUDED_DIRS must be the same "
                "frozenset object as tools.shared.excluded_paths."
                "BASE_EXCLUDED_DIRS (Python `is` identity)."
            ),
        )

    def test_kernel_excluded_dirs_is_shared_frozenset(self) -> None:
        from tools.shared.excluded_paths import BASE_EXCLUDED_DIRS as shared_base
        from aria_kernel import discovery as kernel_discovery

        self.assertIs(
            kernel_discovery.EXCLUDED_DIRS,
            shared_base,
            msg=(
                "aria-kernel/aria_kernel/discovery.py:EXCLUDED_DIRS must be "
                "the same frozenset object as tools.shared.excluded_paths."
                "BASE_EXCLUDED_DIRS (Python `is` identity)."
            ),
        )

    def test_poc_and_kernel_excluded_dirs_are_identical(self) -> None:
        poc_path = _REPO_ROOT / "tools" / "aria-poc" / "poc.py"
        spec = importlib.util.spec_from_file_location("aria_poc_for_test_i22_pair", poc_path)
        assert spec and spec.loader
        poc_module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = poc_module
        spec.loader.exec_module(poc_module)

        from aria_kernel import discovery as kernel_discovery

        self.assertIs(
            poc_module.EXCLUDED_DIRS,
            kernel_discovery.EXCLUDED_DIRS,
            msg="PoC and kernel walk-time exclusion must share one source.",
        )


if __name__ == "__main__":
    unittest.main()
