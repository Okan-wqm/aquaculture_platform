#!/usr/bin/env bash
# Single definition of "run the aria-kernel test suite" — whole or scoped.
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
# SCOPED MODE (operator decision 2026-08-28): with test-file arguments
# (paths under aria-kernel/tests/), only those modules run — the pre-push
# gate passes its mechanically-selected affected set here. Scoped runs
# include the native-pytest partition for the SAME paths, so a scoped run
# never silently drops the pytest-owned half of a selected module. Without
# arguments the full suite runs (CI lanes, release pushes).
#
# Consumers: aria-kernel.yml, aria-kernel-fast.yml, `npm run aria:test:unit`,
# and scripts/ci/aria-suite-changed.mjs (pre-push). Change the suite HERE,
# never in a copy.

set -euo pipefail
cd "$(dirname "$0")/../.."

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="aria-kernel:.${PYTHONPATH:+:$PYTHONPATH}"

if [ "$#" -gt 0 ]; then
  # Dots for unittest module names, slashes for pytest paths — both derive
  # from the same argument list, so the two collectors cannot disagree about
  # what was selected. unittest resolves `tests.*` from aria-kernel/ (the
  # repo root's tests/ is the JEST tree — the first cut of this ran from the
  # root and selected zero tests, silently).
  modules=()
  for path in "$@"; do
    modules+=("tests.$(basename "${path%.py}")")
  done
  (cd aria-kernel && python3 -m unittest "${modules[@]}")
  pytest_paths=()
  for path in "$@"; do
    pytest_paths+=("aria-kernel/tests/$(basename "$path")")
  done
  # Exit 5 is pytest's "nothing was collected": a scoped selection whose
  # modules are all unittest-owned is CORRECT, not a failure — the unittest
  # half above already ran exactly those tests. Any other exit is real.
  set +e
  python3 -m pytest -q -p aria_kernel.pytest_native_only -- "${pytest_paths[@]}"
  pytest_status=$?
  set -e
  if [ "$pytest_status" -ne 0 ] && [ "$pytest_status" -ne 5 ]; then
    exit "$pytest_status"
  fi
else
  python3 -m unittest discover aria-kernel -p '*test*.py'
  python3 -m pytest -q -p aria_kernel.pytest_native_only aria-kernel
fi
