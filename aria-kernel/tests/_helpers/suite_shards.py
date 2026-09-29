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

WHY WEIGHTS CANNOT COST COVERAGE. Weights only decide balance. A module the
weights file does not name weighs its test count times the measured median
seconds-per-test, so a stale file costs wall-clock, never a test. Refresh it
from a CI run's shard reports with ``weights`` (the aggregation job prints
the per-shard seconds so an imbalance is visible in the log).

SPAWN SAFETY. Tests in this suite start ``multiprocessing`` children with the
``spawn`` method, which re-imports ``__main__``. Everything below is a
definition; the only statement with an effect is behind the ``__main__``
guard, so a spawned child never re-runs a shard.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import statistics
import sys
import time
import unittest
from collections.abc import Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, TextIO

REPORT_SCHEMA = "aria-suite-shard-report/v1"
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


def run_shard(
    index: int,
    total: int,
    report_path: Path,
    *,
    kernel_root: Path = KERNEL_ROOT,
    weights_path: Path = WEIGHTS_PATH,
    stream: TextIO | None = None,
) -> bool:
    """Run shard ``index`` of ``total`` and write its report. True when green."""
    modules = discover_modules(kernel_root)
    counts = {name: suite.countTestCases() for name, suite in modules.items()}
    assignment = partition(weigh(counts, load_weights(weights_path)), total)
    mine = sorted(name for name, shard in assignment.items() if shard == index)
    if not mine:
        raise SystemExit(
            f"shard {index}/{total} was assigned no module out of {len(modules)}: "
            "the shard count exceeds the suite's module count"
        )
    seconds: dict[str, float] = {}
    suite = unittest.TestSuite(_TimedModule(name, modules[name], seconds) for name in mine)
    # `python3 -m unittest` turns warnings on when the interpreter was given no
    # -W option; the shard keeps the single-interpreter lane's behaviour.
    runner = unittest.TextTestRunner(stream=stream, warnings=None if sys.warnoptions else "default")
    result = runner.run(suite)
    report = {
        "schema": REPORT_SCHEMA,
        "shard": index,
        "total": total,
        "suite_digest": suite_digest(counts),
        "suite_modules": len(counts),
        "suite_tests": sum(counts.values()),
        "modules": {name: {"tests": counts[name], "seconds": seconds.get(name)} for name in mine},
        "tests_run": result.testsRun,
        "successful": result.wasSuccessful(),
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return result.wasSuccessful()


def verify_reports(reports: Sequence[Mapping[str, Any]]) -> list[str]:
    """Problems that make the shard set NOT equal to one run of the whole suite."""
    if not reports:
        return ["no shard report was produced"]
    problems: list[str] = []
    for key in ("schema", "total", "suite_digest", "suite_modules", "suite_tests"):
        values = sorted({json.dumps(report.get(key)) for report in reports})
        if len(values) != 1:
            problems.append(f"shards disagree on {key}: {', '.join(values)}")
    if problems:
        return problems
    total = int(reports[0]["total"])
    indices = sorted(int(report["shard"]) for report in reports)
    if indices != list(range(1, total + 1)):
        problems.append(f"shard indices {indices} are not exactly 1..{total}")
    owner: dict[str, int] = {}
    tests = 0
    for report in reports:
        for name, row in report["modules"].items():
            if name in owner:
                problems.append(f"module {name} ran in shard {owner[name]} and shard {report['shard']}")
            owner[name] = int(report["shard"])
            tests += int(row["tests"])
        if report.get("successful") is not True:
            problems.append(f"shard {report['shard']} was not successful")
    if len(owner) != reports[0]["suite_modules"]:
        problems.append(f"shards ran {len(owner)} modules; discovery found {reports[0]['suite_modules']}")
    if tests != reports[0]["suite_tests"]:
        problems.append(f"shards own {tests} tests; discovery found {reports[0]['suite_tests']}")
    return problems


def read_reports(reports_dir: Path) -> list[dict[str, Any]]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(reports_dir.glob("*.json"))]


def measured_seconds(reports: Sequence[Mapping[str, Any]]) -> dict[str, float]:
    """Per-module seconds from shard reports, for refreshing the weights file."""
    seconds: dict[str, float] = {}
    for report in reports:
        for name, row in report["modules"].items():
            if row.get("seconds") is not None:
                seconds[name] = round(float(row["seconds"]), 1)
    return seconds


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="suite_shards", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    run = commands.add_parser("run", help="run one shard and write its report")
    run.add_argument("--shard", required=True, help="K/N")
    run.add_argument("--report", required=True, type=Path)
    run.add_argument("--kernel-root", type=Path, default=KERNEL_ROOT)
    run.add_argument("--weights", type=Path, default=WEIGHTS_PATH)
    verify = commands.add_parser("verify", help="prove the shard reports cover the suite once")
    verify.add_argument("--reports-dir", required=True, type=Path)
    weights = commands.add_parser("weights", help="write measured seconds from shard reports")
    weights.add_argument("--reports-dir", required=True, type=Path)
    weights.add_argument("--out", type=Path, default=WEIGHTS_PATH)
    args = parser.parse_args(argv)

    if args.command == "run":
        index, total = parse_shard(args.shard)
        green = run_shard(index, total, args.report, kernel_root=args.kernel_root.resolve(), weights_path=args.weights)
        return 0 if green else 1
    reports = read_reports(args.reports_dir)
    if args.command == "verify":
        for report in sorted(reports, key=lambda item: int(item["shard"])):
            ran = sum(row["seconds"] or 0 for row in report["modules"].values())
            print(f"shard {report['shard']}/{report['total']}: {len(report['modules'])} modules, "
                  f"{report['tests_run']} tests, {ran / 60:.1f} min, successful={report['successful']}")
        problems = verify_reports(reports)
        for problem in problems:
            print(f"suite shard coverage: {problem}", file=sys.stderr)
        return 1 if problems else 0
    payload = {"seconds": dict(sorted(measured_seconds(reports).items()))}
    args.out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    # Resolve imports the way `python3 -m unittest discover aria-kernel` does:
    # the kernel root first on sys.path, not this script's own directory.
    sys.path[0] = str(KERNEL_ROOT)
    sys.exit(main())
