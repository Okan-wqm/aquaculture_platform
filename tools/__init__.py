"""``tools`` namespace package — operator-side scripts and shared modules.

Plan ARIA-V2 §3.6 promoted ``tools/shared/`` to a discoverable shared
module so the ARIA Phase-1 PoC (`tools/aria-poc/poc.py`) and the ARIA
kernel (`aria-kernel/aria_kernel/`) consume one source of truth for
walk-time directory exclusion. Treating ``tools`` as a regular package
keeps the import path explicit (``from tools.shared.excluded_paths
import BASE_EXCLUDED_DIRS``) and lets test runners that set
``PYTHONPATH=.`` discover it deterministically.
"""
