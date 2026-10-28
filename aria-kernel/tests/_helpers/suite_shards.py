"""Deterministic, measured shards of the aria-kernel unittest suite (ARIA-HIGH-136).

WHY THIS EXISTS. The kernel suite ran in ONE interpreter: 6,484 tests in 48
minutes on 2026-09-14, 7,387 tests past the lane's 110-minute cap by
2026-09-27 (run 36386654289 cancelled at 6,416 passing tests, zero failures;
main's own run 36358071953 the same). A lane that times out green is not a
gate, and every kernel change paid a day for it. This module splits the SAME
suite across the ``suite`` matrix of ``.github/workflows/aria-kernel.yml``.

WHAT A SHARD DOES. Every shard discovers the WHOLE suite exactly as
``python3 -m unittest discover aria-kernel -p '*test*.py'`` does, weighs each
test module, and runs only the modules a longest-processing-time partition
gives it — in its own interpreter, sequentially, so a module sees the same
process shape it saw in the single-interpreter lane.

WHY COVERAGE CANNOT SILENTLY SHRINK (tier 1 + tier 3):
  * the partition is a total function over the discovered module set, and
    every shard derives it from its own discovery;
  * the shard index and count come from the matrix (``strategy.job-index`` /
    ``strategy.job-total``), so the count can never disagree with the number
    of shard jobs that exist;
  * each shard writes a report carrying a digest of what it discovered, and
    ``verify`` (the ``aria-kernel`` aggregation job) proves that every index
    1..N reported, all N saw the same suite, and the modules they ran are
    disjoint and cover it — test counts included.

WHY A SKIPPED SANDBOX PIN FAILS THE RUN (ARIA-MEDIUM-130). The real-bwrap
pins skip on a host that cannot confine, and a skip is green. The lane proves
the backend before the suite (``ensure-sandbox-backend``), so there a skipped
pin is a containment proof that did not run, and nothing but step order said
so. Every such skip goes through ``tests/_helpers/sandbox_pins.py`` and starts
with ``aria_kernel.sandbox_pin_skip.SANDBOX_SKIP_MARKER``; each report lists
them, and ``verify`` refuses a report that has any, or that does not account
for them at all. The pytest half refuses the same skips by the same predicate
(``aria_kernel.pytest_native_only --refuse-sandbox-skips``, ARIA-LOW-599).

WHY WEIGHTS CANNOT COST COVERAGE. Weights only decide balance. A module the
weights file does not name weighs its test count times the measured median
seconds-per-test, so a stale file costs wall-clock, never a test. Refresh it
from CI runs' shard reports with ``weights`` (the aggregation job prints the
per-shard seconds so an imbalance is visible in the log). Pass the reports of
several runs (``--reports-dir`` repeated): a module weighs its SLOWEST
measurement, because module seconds swing up to 2x between runners and the
30-minute job cap is overrun by the run that draws badly, not by the average
one (run 40641014171: shard 3 took 1782 s of 1800 s under weights refreshed
from a single run).

TWO PARTITIONS (ARIA-HIGH-602). The ``suite`` job runs only when a PR touches
the kernel surface (.github/manifests/aria-kernel-surface.json); a test that
reads the LIVE checkout outside it (product code, the whole tree) would let a
PR changing what it reads skip it and pass the required check. Such a module
declares the module constant ``READS_LIVE_CHECKOUT = "<the live property it
asserts>"``. The shards run every other module (the hermetic partition); the
always-run ``workspace`` job runs the declared ones (``run --live``). Every
report carries the declared set, and ``verify`` proves the hermetic shards and
the live report together ran the discovered suite exactly once.

THE COLLECTED IDS (PLAN-v2 B1). ``list`` prints the leaf id of every test
the unittest half runs, from the same discovery (``load_tests`` and package
``__init__`` files decide, as in CI), and names on stderr every module that
failed to import, exiting 1 for it. ``scripts/ci/aria-suite-run.sh
--collect`` prints these with the pytest half's ids, and
``self_improvement.invariants_only_grow`` compares two trees through it.

SPAWN SAFETY. Tests in this suite start ``multiprocessing`` children with the
``spawn`` method, which re-imports ``__main__``. Everything below is a
definition; the only statement with an effect is behind the ``__main__``
guard, so a spawned child never re-runs a shard.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import statistics
import sys
import time
import unittest
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, TextIO

# The live-partition declaration (READS_LIVE_CHECKOUT) has one owner, shared
# with the pytest plugin: aria_kernel.live_partition. It is imported inside the
# functions that read it, like every aria_kernel name here: run as a script,
# this module puts the kernel root on sys.path only in its __main__ guard.

# v3 (ARIA-HIGH-602): every report names its partition and the declared live set.
REPORT_SCHEMA = "aria-suite-shard-report/v3"
HERMETIC = "hermetic"
LIVE = "live"
PARTITIONS = (HERMETIC, LIVE)
KERNEL_ROOT = Path(__file__).resolve().parents[2]
WEIGHTS_PATH = Path(__file__).with_name("suite_shard_weights.json")
DISCOVERY_PATTERN = "*test*.py"
# unittest wraps a module that fails to import in a test of this class; the
# failing module's dotted name is the test's method name. Keyed by that name
# the import failure is assigned, run and reported like any other module.
_FAILED_IMPORT_CLASS = "_FailedTest"


def _leaves(suite: unittest.TestSuite) -> Iterator[unittest.TestCase]:
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _leaves(item)
        else:
            yield item


def _module_key(suite: unittest.TestSuite) -> str | None:
    for test in _leaves(suite):
        if type(test).__name__ == _FAILED_IMPORT_CLASS:
            return test._testMethodName
        return type(test).__module__
    return None


def discover_modules(kernel_root: Path = KERNEL_ROOT) -> dict[str, unittest.TestSuite]:
    """The suite, grouped by test module, as ``unittest discover`` builds it.

    ``python3 -m unittest discover aria-kernel`` makes the start directory the
    top-level directory and puts it first on ``sys.path``; the loader does the
    same here. A module with no tests (the pattern also matches kernel
    modules such as ``attestation.py``) contributes nothing and is dropped.
    """
    root = unittest.defaultTestLoader.discover(
        str(kernel_root), pattern=DISCOVERY_PATTERN, top_level_dir=str(kernel_root)
    )
    modules: dict[str, unittest.TestSuite] = {}
    for module_suite in root:
        key = _module_key(module_suite)
        if key is not None:
            modules.setdefault(key, unittest.TestSuite()).addTest(module_suite)
    return modules


def collected_ids(kernel_root: Path = KERNEL_ROOT) -> tuple[list[str], list[str]]:
    """``(ids, failed)``: the id of every test the unittest half runs, and the
    modules that failed to import (unittest stands a ``_FailedTest`` in for
    each; it is not a test of the suite)."""
    ids: list[str] = []
    failed: list[str] = []
    for name, suite in sorted(discover_modules(kernel_root).items()):
        for test in _leaves(suite):
            if type(test).__name__ == _FAILED_IMPORT_CLASS:
                failed.append(name)
            else:
                ids.append(test.id())
    return ids, sorted(set(failed))


def live_declarations(modules: Mapping[str, unittest.TestSuite]) -> dict[str, str]:
    """``{module: live property}`` for every discovered module that declares it.

    Discovery imported each module under its dotted name; a module that failed
    to import declares nothing and stays hermetic, where its shard fails it.
    """
    from aria_kernel.live_partition import live_declaration

    declared: dict[str, str] = {}
    for name in sorted(modules):
        module = sys.modules.get(name)
        if module is None:
            continue
        reason = live_declaration(module)
        if reason is not None:
            declared[name] = reason
    return declared


def suite_digest(counts: Mapping[str, int]) -> str:
    """Digest of the discovered suite: every module name with its test count."""
    lines = "".join(f"{name}\t{counts[name]}\n" for name in sorted(counts))
    return hashlib.sha256(lines.encode("utf-8")).hexdigest()


def load_weights(path: Path = WEIGHTS_PATH) -> dict[str, float]:
    """Measured seconds per module; an absent file is an empty measurement."""
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {str(name): float(seconds) for name, seconds in raw["seconds"].items()}


def weigh(counts: Mapping[str, int], measured: Mapping[str, float]) -> dict[str, float]:
    """Weight per discovered module: its measurement, else count x median rate."""
    rates = [measured[name] / counts[name] for name in counts if name in measured and counts[name] > 0]
    rate = statistics.median(rates) if rates else 1.0
    return {name: measured[name] if name in measured else counts[name] * rate for name in counts}


def partition(weights: Mapping[str, float], total: int) -> dict[str, int]:
    """Longest-processing-time assignment of modules to shards ``1..total``.

    Heaviest module first onto the least-loaded shard; ties break on the
    module name and the lower shard index, so the result depends only on the
    weights, never on mapping order. Total and disjoint by construction.
    """
    if total < 1:
        raise ValueError(f"shard count must be >= 1, got {total}")
    loads = [0.0] * total
    assignment: dict[str, int] = {}
    for name in sorted(weights, key=lambda item: (-weights[item], item)):
        shard = min(range(total), key=lambda index: (loads[index], index))
        loads[shard] += weights[name]
        assignment[name] = shard + 1
    return assignment


def parse_shard(spec: str) -> tuple[int, int]:
    """``"K/N"`` with ``1 <= K <= N``."""
    index_text, sep, total_text = spec.partition("/")
    if not sep or not index_text.isdigit() or not total_text.isdigit():
        raise ValueError(f"shard must be K/N, got {spec!r}")
    index, total = int(index_text), int(total_text)
    if not 1 <= index <= total:
        raise ValueError(f"shard index must be within 1..{total}, got {index}")
    return index, total


class _TimedModule(unittest.TestSuite):
    """A module's suite that records how long it ran (fixtures included)."""

    def __init__(self, name: str, suite: unittest.TestSuite, seconds: dict[str, float]) -> None:
        super().__init__([suite])
        self._name = name
        self._seconds = seconds

    def run(self, result: unittest.TestResult, debug: bool = False) -> unittest.TestResult:
        started = time.monotonic()
        try:
            return super().run(result, debug)
        finally:
            self._seconds[self._name] = round(time.monotonic() - started, 3)


def _run_modules(
    names: Sequence[str],
    modules: Mapping[str, unittest.TestSuite],
    counts: Mapping[str, int],
    live: Mapping[str, str],
    report_path: Path,
    stream: TextIO | None,
    **identity: Any,
) -> bool:
    """Run ``names`` in this interpreter, in order, and write the report. True when green."""
    # Imported here, not at module top: run as a script, this module puts the
    # kernel root on sys.path only in its __main__ guard (spawn safety, above).
    from aria_kernel.sandbox_pin_skip import is_sandbox_pin_skip

    seconds: dict[str, float] = {}
    suite = unittest.TestSuite(_TimedModule(name, modules[name], seconds) for name in names)
    # `python3 -m unittest` turns warnings on when the interpreter was given no
    # -W option; the shard keeps the single-interpreter lane's behaviour.
    runner = unittest.TextTestRunner(stream=stream, warnings=None if sys.warnoptions else "default")
    result = runner.run(suite)
    report = {
        "schema": REPORT_SCHEMA,
        **identity,
        "suite_digest": suite_digest(counts),
        "suite_modules": len(counts),
        "suite_tests": sum(counts.values()),
        "live": dict(live),
        "modules": {name: {"tests": counts[name], "seconds": seconds.get(name)} for name in names},
        "tests_run": result.testsRun,
        "successful": result.wasSuccessful(),
        "sandbox_skips": sorted(test.id() for test, reason in result.skipped
                                if is_sandbox_pin_skip(reason)),
        # ARIA-MEDIUM-411 — a re-run shard's report supersedes the attempt it
        # re-ran; outside Actions there is one attempt.
        "run_attempt": int(os.environ.get("GITHUB_RUN_ATTEMPT") or 1),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result.wasSuccessful()


def _discover_partitioned(kernel_root: Path) -> tuple[dict[str, unittest.TestSuite], dict[str, int], dict[str, str]]:
    from aria_kernel.live_partition import LiveDeclarationError

    modules = discover_modules(kernel_root)
    counts = {name: suite.countTestCases() for name, suite in modules.items()}
    try:
        live = live_declarations(modules)
    except LiveDeclarationError as error:
        raise SystemExit(str(error)) from error
    return modules, counts, live


def run_shard(
    index: int,
    total: int,
    report_path: Path,
    *,
    kernel_root: Path = KERNEL_ROOT,
    weights_path: Path = WEIGHTS_PATH,
    stream: TextIO | None = None,
) -> bool:
    """Run shard ``index`` of ``total`` of the hermetic partition and write its report. True when green."""
    modules, counts, live = _discover_partitioned(kernel_root)
    hermetic = {name: count for name, count in counts.items() if name not in live}
    assignment = partition(weigh(hermetic, load_weights(weights_path)), total)
    mine = sorted(name for name, shard in assignment.items() if shard == index)
    if not mine:
        raise SystemExit(
            f"shard {index}/{total} was assigned no module out of {len(hermetic)} hermetic modules: "
            "the shard count exceeds the suite's module count"
        )
    return _run_modules(mine, modules, counts, live, report_path, stream,
                        partition=HERMETIC, shard=index, total=total)


def run_live(report_path: Path, *, kernel_root: Path = KERNEL_ROOT, stream: TextIO | None = None) -> bool:
    """Run the live partition (every declared module) and write its report. True when green.

    An empty live set is a valid partition: the report then proves the
    workspace job ran exactly nothing because nothing is declared.
    """
    modules, counts, live = _discover_partitioned(kernel_root)
    return _run_modules(sorted(live), modules, counts, live, report_path, stream,
                        partition=LIVE, shard=LIVE, total=None)


def verify_reports(
    reports: Sequence[Mapping[str, Any]],
    partitions: Sequence[str] = PARTITIONS,
) -> list[str]:
    """Problems that make the reports NOT equal to one run of the expected partitions.

    ``partitions`` is what ran: both on a kernel change (the shards ran the
    hermetic partition, the workspace job the live one), the live partition
    alone when the surface decision skipped the shards.
    """
    expected = set(partitions)
    unknown = sorted(expected - set(PARTITIONS))
    if unknown or not expected:
        return [f"unknown partitions {unknown or list(partitions)}; expected a subset of {list(PARTITIONS)}"]
    hermetic = [report for report in reports if report.get("partition") == HERMETIC]
    live_reports = [report for report in reports if report.get("partition") == LIVE]
    if not reports:
        return ["no shard report was produced"]
    problems: list[str] = []
    stray = [report for report in reports if report.get("partition") not in PARTITIONS]
    if stray:
        problems.append(f"{len(stray)} report(s) name no partition (schema {REPORT_SCHEMA} required)")
    if HERMETIC not in expected and hermetic:
        problems.append("a hermetic shard report is present, but only the live partition was expected")
    if LIVE in expected and not live_reports:
        problems.append("no live-partition report was produced")
    if len(live_reports) > 1:
        problems.append(f"{len(live_reports)} live-partition reports for one attempt")
    if problems:
        return problems
    for key in ("schema", "suite_digest", "suite_modules", "suite_tests", "live"):
        values = sorted({json.dumps(report.get(key), sort_keys=True) for report in reports})
        if len(values) != 1:
            problems.append(f"shards disagree on {key}: {', '.join(values)}")
    if problems:
        return problems
    from aria_kernel.live_partition import LIVE_DECLARATION

    live = reports[0]["live"]
    for name, reason in sorted(live.items()):
        if not isinstance(reason, str) or not reason.strip():
            problems.append(f"{name} declares {LIVE_DECLARATION} without naming the live property it asserts")
    if hermetic:
        totals = sorted({json.dumps(report.get("total")) for report in hermetic})
        if len(totals) != 1:
            problems.append(f"shards disagree on total: {', '.join(totals)}")
            return problems
        total = int(hermetic[0]["total"])
        indices = sorted(int(report["shard"]) for report in hermetic)
        if indices != list(range(1, total + 1)):
            problems.append(f"shard indices {indices} are not exactly 1..{total}")
    owner: dict[str, str] = {}
    tests = 0
    for report in hermetic + live_reports:
        label = f"shard {report['shard']}" if report["partition"] == HERMETIC else "the live report"
        for name, row in report["modules"].items():
            if name in owner:
                problems.append(f"module {name} ran in {owner[name]} and {label}")
            owner[name] = label
            tests += int(row["tests"])
            if report["partition"] == HERMETIC and name in live:
                problems.append(f"live module {name} ran in hermetic shard {report['shard']}")
        if report["partition"] == LIVE and sorted(report["modules"]) != sorted(live):
            problems.append(
                f"the live report ran {sorted(report['modules'])} but the declared live set is {sorted(live)}"
            )
        if report.get("successful") is not True:
            problems.append(f"{label} was not successful")
        sandbox_skips = report.get("sandbox_skips")
        if not isinstance(sandbox_skips, list):
            problems.append(f"{label} does not account for its sandbox-pin skips")
        elif sandbox_skips:
            problems.append(
                f"{label} skipped {len(sandbox_skips)} real-sandbox pin(s) on a lane that "
                f"verified the backend: {', '.join(sandbox_skips[:5])}"
            )
    if HERMETIC in expected:
        if len(owner) != reports[0]["suite_modules"]:
            problems.append(f"shards ran {len(owner)} modules; discovery found {reports[0]['suite_modules']}")
        if tests != reports[0]["suite_tests"]:
            problems.append(f"shards own {tests} tests; discovery found {reports[0]['suite_tests']}")
    return problems


def read_reports(reports_dir: Path) -> list[dict[str, Any]]:
    """The current report of every shard: the one from its latest run attempt.

    ARIA-MEDIUM-411 — the verdict job downloads every attempt's reports. "Re-run
    failed jobs" re-runs only the failed shards, so each shard's latest attempt
    is its result, exactly as the job status GitHub shows for it. Two reports
    for one shard in one attempt are both kept, so verify names the duplicate.
    """
    reports = [json.loads(path.read_text(encoding="utf-8")) for path in sorted(reports_dir.glob("*.json"))]
    latest: dict[Any, int] = {}
    for report in reports:
        attempt = int(report.get("run_attempt") or 1)
        key = (report.get("partition"), report.get("shard"))
        latest[key] = max(latest.get(key, attempt), attempt)
    return [
        report for report in reports
        if int(report.get("run_attempt") or 1) == latest[(report.get("partition"), report.get("shard"))]
    ]


def measured_seconds(reports: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Per-module seconds from shard reports, for refreshing the weights file."""
    seconds: dict[str, float] = {}
    for report in reports:
        for name, row in report["modules"].items():
            if row.get("seconds") is not None:
                seconds[name] = round(float(row["seconds"]), 1)
    return seconds


def slowest_seconds(runs: Sequence[Sequence[Mapping[str, Any]]]) -> dict[str, float]:
    """Each module's slowest measurement across runs: the weight a shard must plan for.

    One run's seconds are one draw from a wide spread (tests.test_enterprise_cycle
    took 293 s, 324 s and 570 s in three runs of one tree), and the 30-minute job
    cap is overrun by the run that draws badly, not by the average one. A module
    one run never ran keeps the seconds of the runs that did.
    """
    slowest: dict[str, float] = {}
    for reports in runs:
        for name, seconds in measured_seconds(reports).items():
            slowest[name] = max(seconds, slowest.get(name, seconds))
    return slowest


def main(argv: Sequence[str] | None = None) -> int:
    from aria_kernel.live_partition import LIVE_DECLARATION

    parser = argparse.ArgumentParser(prog="suite_shards", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run one hermetic shard, or the live partition, and write its report")
    which = run.add_mutually_exclusive_group(required=True)
    which.add_argument("--shard", help="K/N: shard K of N of the hermetic partition")
    which.add_argument("--live", action="store_true", help=f"the modules that declare {LIVE_DECLARATION}")
    run.add_argument("--report", required=True, type=Path)
    run.add_argument("--kernel-root", type=Path, default=KERNEL_ROOT)
    run.add_argument("--weights", type=Path, default=WEIGHTS_PATH)
    verify = commands.add_parser("verify", help="prove the reports cover the suite once")
    verify.add_argument("--reports-dir", required=True, type=Path)
    verify.add_argument(
        "--partitions", default=",".join(PARTITIONS),
        help=f"comma-separated partitions that ran (default: {','.join(PARTITIONS)})",
    )
    listing = commands.add_parser("list", help="print the id of every test the unittest half runs")
    listing.add_argument("--kernel-root", type=Path, default=KERNEL_ROOT)
    weights = commands.add_parser("weights", help="write the slowest measured seconds of each module from shard reports")
    weights.add_argument(
        "--reports-dir", required=True, type=Path, action="append",
        help="one CI run's shard reports; repeat the option to plan for the slowest of several runs",
    )
    weights.add_argument("--out", type=Path, default=WEIGHTS_PATH)
    args = parser.parse_args(argv)

    if args.command == "list":
        # Discovery imports every test module, and a module may print at
        # import: stdout carries the ids alone.
        with contextlib.redirect_stdout(sys.stderr):
            ids, failed = collected_ids(args.kernel_root.resolve())
        for test_id in ids:
            print(test_id)
        for name in failed:
            print(f"suite_shards list: {name} failed to import", file=sys.stderr)
        return 1 if failed else 0
    if args.command == "run":
        if args.live:
            green = run_live(args.report, kernel_root=args.kernel_root.resolve())
        else:
            index, total = parse_shard(args.shard)
            green = run_shard(index, total, args.report, kernel_root=args.kernel_root.resolve(),
                              weights_path=args.weights)
        return 0 if green else 1
    if args.command == "weights":
        payload = {"seconds": dict(sorted(slowest_seconds([read_reports(path) for path in args.reports_dir]).items()))}
        args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return 0
    reports = read_reports(args.reports_dir)
    if args.command == "verify":
        for report in sorted(reports, key=lambda item: (str(item.get("partition")), str(item.get("shard")))):
            ran = sum(row["seconds"] or 0 for row in report["modules"].values())
            label = (f"shard {report['shard']}/{report['total']}" if report.get("partition") == HERMETIC
                     else f"{report.get('partition')} partition")
            print(f"{label}: {len(report['modules'])} modules, "
                  f"{report['tests_run']} tests, {ran / 60:.1f} min, successful={report['successful']}, "
                  f"sandbox pins skipped={len(report.get('sandbox_skips') or [])}")
        partitions = [name.strip() for name in args.partitions.split(",") if name.strip()]
        problems = verify_reports(reports, partitions)
        for problem in problems:
            print(f"suite shard coverage: {problem}", file=sys.stderr)
        return 1 if problems else 0
    raise AssertionError(f"unhandled command {args.command!r}")


if __name__ == "__main__":
    # Resolve imports the way `python3 -m unittest discover aria-kernel` does:
    # the kernel root first on sys.path, not this script's own directory.
    sys.path[0] = str(KERNEL_ROOT)
    sys.exit(main())
