"""Shared modules consumed by both the ARIA Phase-1 PoC and the ARIA kernel.

Single source of truth for cross-tool invariants. Re-exports the
canonical ``BASE_EXCLUDED_DIRS`` frozenset and the runtime helper
``augmented_excluded_paths`` so consumers can import either symbol
via this short alias.
"""

from tools.shared.excluded_paths import (
    BASE_EXCLUDED_DIRS,
    augmented_excluded_paths,
)

__all__ = [
    "BASE_EXCLUDED_DIRS",
    "augmented_excluded_paths",
]
