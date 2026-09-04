"""Plan 032 (V12) shared test helpers.

Mirrors aria-kernel/tests/invariants/v11/_helpers.py exactly: prepends the
aria-kernel package root to sys.path so ``import aria_kernel`` resolves when
pytest discovers this subpackage. parents[4] from
aria-kernel/tests/invariants/v13/_helpers.py is the repo root.
"""
from __future__ import annotations

import sys
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[4]
_KERNEL_ROOT = _REPO_ROOT / "aria-kernel"
if str(_KERNEL_ROOT) not in sys.path:
    sys.path.insert(0, str(_KERNEL_ROOT))
