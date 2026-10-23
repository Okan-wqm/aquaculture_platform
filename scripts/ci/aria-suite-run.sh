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
# SCOPED MODE (operator decision 2026-08-28): with test-module arguments
# (repo paths under aria-kernel/, e.g. aria-kernel/tests/invariants/v12/
# test_x.py), only those modules run — the pre-push gate passes one module
# per invocation so it can time each and stop at its budget. Scoped runs
# include the native-pytest partition for the SAME paths, so a scoped run
# never silently drops the pytest-owned half of a selected module. Without
# arguments the full suite runs (release pushes, the operational proof).
#
# SHARDED MODE (ARIA-HIGH-136): the single interpreter outgrew the kernel
# lane's 110-minute cap (7,387 tests; runs 36386654289 and 36358071953 were
# cancelled green). `--shard K/N REPORT` runs the unittest half's shard K of N
# (aria-kernel/tests/_helpers/suite_shards.py — measured, deterministic, and
# proven complete by that module's `verify`), and `--pytest-native` runs the
# pytest half whole. aria-kernel.yml runs every shard plus the pytest half
# once, which is the two-collector partition above, split across runners.
#
# LIVE MODE (ARIA-HIGH-602): `--live REPORT` runs the suite's live partition —
# the modules that declare READS_LIVE_CHECKOUT and so read the live checkout
# outside the kernel surface — through the same two collectors. The always-run
# `workspace` job runs it on every PR, so a PR that changes what those modules
# read cannot skip them and pass the required check.
#
# COLLECT MODE (PLAN-v2 B1, invariants_only_grow): `--collect` prints the
# ids this suite runs, one per line on stdout and nothing else — the unittest
# half's leaf ids (`suite_shards.py list`: unittest discovery as the shards
# run it, so `load_tests` and package `__init__` files decide, exactly as in
# CI) and the pytest half's node ids in both partitions (the plugin's own
# selection, hermetic and live). Every collection report goes to stderr. It
# exits non-zero when a collector could not collect cleanly.
# `self_improvement.invariants_only_grow` runs this mode in each tree it
# compares, in the validation sandbox, so it measures what CI runs.
#
# Consumers: aria-kernel.yml, `npm run aria:test:unit`,
# scripts/ci/aria-suite-changed.mjs (pre-push) and
# self_improvement.invariants_only_grow (`--collect`). Change the suite HERE,
# never in a copy.

set -euo pipefail
cd "$(dirname "$0")/../.."

export PYTHONDONTWRITEBYTECODE=1
# The import roots have one declaration, aria_kernel/suite_import_roots.py,
# which the authority set reads too (B1); it is run isolated (-I), so nothing
# at those roots runs before it answers.
suite_roots="$(python3 -I aria-kernel/aria_kernel/suite_import_roots.py)"
export PYTHONPATH="${suite_roots}${PYTHONPATH:+:$PYTHONPATH}"

# The pytest-owned half of the partition, whole — one definition for the full
# run and for the sharded lane. Arguments are plugin options placed before the
# test root.
pytest_native() {
  python3 -m pytest -q -p aria_kernel.pytest_native_only "$@" aria-kernel
}

# The pytest half's node ids, for the collect mode. `-q --collect-only`
# prints the selected node ids first, then one empty line, then its report:
# the ids go to stdout and everything from the empty line on to stderr.
# Under pipefail the status is pytest's.
pytest_native_ids() {
  pytest_native --collect-only -p no:cacheprovider --continue-on-collection-errors "$@" \
    | awk 'reported || NF == 0 { reported = 1; print > "/dev/stderr"; next } { print }'
}

if [ "${1:-}" = "--collect" ]; then
  if [ "$#" -ne 1 ]; then
    echo "usage: $0 --collect" >&2
    exit 2
  fi
  set +e
  python3 aria-kernel/tests/_helpers/suite_shards.py list
  unittest_status=$?
  pytest_native_ids
  hermetic_status=$?
  pytest_native_ids --aria-live-only
  live_status=$?
  set -e
  if [ "$unittest_status" -ne 0 ]; then
    exit "$unittest_status"
  fi
  # Exit 5 is pytest's "nothing collected": a partition may own nothing.
  for status in "$hermetic_status" "$live_status"; do
    if [ "$status" -ne 0 ] && [ "$status" -ne 5 ]; then
      exit "$status"
    fi
  done
elif [ "${1:-}" = "--shard" ]; then
  if [ "$#" -ne 3 ]; then
    echo "usage: $0 --shard K/N REPORT_PATH" >&2
    exit 2
  fi
  python3 aria-kernel/tests/_helpers/suite_shards.py run --shard "$2" --report "$3"
elif [ "${1:-}" = "--pytest-native" ]; then
  if [ "$#" -ne 1 ]; then
    echo "usage: $0 --pytest-native" >&2
    exit 2
  fi
  # ARIA-LOW-599 — this mode is the kernel lane's, and the lane provisions the
  # sandbox backend before it, so a real-sandbox pin that skipped is a
  # containment proof that did not run: the run is refused, as `suite_shards
  # verify` refuses one in the unittest half. The whole-suite run below is a
  # laptop's, where the pin's skip is the sandbox's own fail-closed contract.
  pytest_native --refuse-sandbox-skips
elif [ "${1:-}" = "--live" ]; then
  # ARIA-HIGH-602 — the live partition of the suite: the modules that declare
  # READS_LIVE_CHECKOUT read the live checkout outside the kernel surface, so
  # the always-run `workspace` job of aria-kernel.yml runs this mode on every
  # PR and the skippable lanes never do. The unittest half writes the live
  # report `suite_shards verify` proves complete beside the shard reports. The
  # pytest half may own nothing (every declared module is a TestCase module
  # today): exit 5, "nothing to run", is the empty partition, not a failure —
  # unlike the scoped mode, an empty live set is a valid, reported outcome.
  # This lane provisions the sandbox backend before the suite, so its pytest
  # half refuses a skipped real-sandbox pin like the kernel lane's (the
  # unittest half's skips are refused by verify in either partition).
  if [ "$#" -ne 2 ]; then
    echo "usage: $0 --live REPORT_PATH" >&2
    exit 2
  fi
  set +e
  python3 aria-kernel/tests/_helpers/suite_shards.py run --live --report "$2"
  unittest_status=$?
  pytest_native --aria-live-only --refuse-sandbox-skips
  pytest_status=$?
  set -e
  if [ "$unittest_status" -ne 0 ]; then
    exit "$unittest_status"
  fi
  if [ "$pytest_status" -ne 0 ] && [ "$pytest_status" -ne 5 ]; then
    exit "$pytest_status"
  fi
elif [ "$#" -gt 0 ]; then
  # Dots for unittest module names, slashes for pytest paths — both derive
  # from the same argument list, so the two collectors cannot disagree about
  # what was selected. unittest resolves `tests.*` from aria-kernel/ (the
  # repo root's tests/ is the JEST tree — the first cut of this ran from the
  # root and selected zero tests, silently). The full repo path, not a bare
  # file name, so a module under tests/invariants/ keeps its package.
  modules=()
  pytest_paths=()
  for path in "$@"; do
    case "$path" in
      aria-kernel/*.py) ;;
      *)
        echo "usage: $0 [aria-kernel/<test module>.py ...]; got '$path'" >&2
        exit 2
        ;;
    esac
    relative="${path#aria-kernel/}"
    relative="${relative%.py}"
    modules+=("${relative//\//.}")
    pytest_paths+=("$path")
  done
  # Exit 5 is each collector's "nothing to run". Either half may own nothing
  # in a scoped selection, and that is CORRECT: a TestCase-only module gives
  # pytest's native half nothing, and a module of plain pytest functions gives
  # unittest nothing (Python 3.12+ exits 5, "NO TESTS RAN" — the pre-push gate
  # passes one module per call, so a pytest-only module meets this alone).
  # Both halves running nothing is not a pass: no selected test ran at all.
  # Any other non-zero exit is a real failure; both halves always run, so one
  # push reports every failure of the selection.
  set +e
  (cd aria-kernel && python3 -m unittest "${modules[@]}")
  unittest_status=$?
  python3 -m pytest -q -p aria_kernel.pytest_native_only -- "${pytest_paths[@]}"
  pytest_status=$?
  set -e
  for status in "$unittest_status" "$pytest_status"; do
    if [ "$status" -ne 0 ] && [ "$status" -ne 5 ]; then
      exit "$status"
    fi
  done
  if [ "$unittest_status" -eq 5 ] && [ "$pytest_status" -eq 5 ]; then
    echo "$0: neither collector ran a test from: $*" >&2
    exit 5
  fi
else
  python3 -m unittest discover aria-kernel -p '*test*.py'
  pytest_native
fi
