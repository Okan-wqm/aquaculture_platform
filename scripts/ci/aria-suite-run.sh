#!/usr/bin/env bash
# Single definition of "run the whole aria-kernel test suite".
#
# WHY THIS EXISTS. The suite used to be `python3 -m unittest discover
# aria-kernel -p '*test*.py'`, hand-copied into every lane (kernel, kernel-fast,
# package.json, the pre-push gate). unittest discovery collects ONLY TestCase
# classes: pytest-style modules (plain test functions, parametrize, MonkeyPatch)
# import cleanly and contribute ZERO tests. Three such modules — 34 tests — sat
# invisible in CI for weeks; the gap surfaced only when their module-scope
# `import pytest` started failing hosted discovery (run 33056211686), and even
# after pytest was declared the 34 tests still never RAN anywhere. A green
# unittest pass was therefore not evidence about them.
#
# This script is the one place that runs BOTH halves:
#   1. unittest discovery over the whole tree (TestCase modules);
#   2. pytest over exactly the modules that import pytest at module scope —
#      discovered by grep, not a hand-kept list, so the next pytest-style
#      module joins the run automatically.
#
# Consumers: aria-kernel.yml, aria-kernel-fast.yml, `npm run aria:test:unit`,
# and scripts/ci/aria-suite-changed.mjs (pre-push). Change the suite HERE,
# never in a copy.

set -euo pipefail
cd "$(dirname "$0")/../.."

export PYTHONDONTWRITEBYTECODE=1
export PYTHONPATH="aria-kernel:.${PYTHONPATH:+:$PYTHONPATH}"

python3 -m unittest discover aria-kernel -p '*test*.py'

mapfile -t PYTEST_STYLE_MODULES < <(grep -lE '^import pytest|^from pytest' aria-kernel/tests/test_*.py)
if ((${#PYTEST_STYLE_MODULES[@]} > 0)); then
  echo "aria-suite-run: ${#PYTEST_STYLE_MODULES[@]} pytest-style module(s); running pytest on them"
  python3 -m pytest -q "${PYTEST_STYLE_MODULES[@]}"
else
  echo "aria-suite-run: no pytest-style modules discovered"
fi
