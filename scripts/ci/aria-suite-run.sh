#!/usr/bin/env bash
# Single definition of "run the whole aria-kernel test suite".
#
# WHY THIS EXISTS. unittest discovery collects TestCase tests but not native
# pytest functions or classes. Pytest collects both, so running both collectors
# unchanged duplicates every TestCase and exceeds the fixed lane budget. The
# native-only plugin partitions pytest's full collection by class ancestry:
# unittest owns every TestCase descendant, while pytest owns every other item.
# No source-text selection or hand-maintained module list participates.
# aria-kernel/pyproject.toml deliberately preserves the former `*test*.py`
# filename contract for pytest's side of the partition.
#
# Consumers: aria-kernel.yml, aria-kernel-fast.yml, `npm run aria:test:unit`,
# and scripts/ci/aria-suite-changed.mjs (pre-push). Change the suite HERE,
# never in a copy.

set -euo pipefail
cd "$(dirname "$0")/../.."

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="aria-kernel:.${PYTHONPATH:+:$PYTHONPATH}"

python3 -m unittest discover aria-kernel -p '*test*.py'
python3 -m pytest -q -p aria_kernel.pytest_native_only aria-kernel
