"""ARIA-HIGH-136 — the sharded kernel lane runs the whole suite exactly once.

The lane splits the unittest half of the suite across a matrix of runners
(`tests/_helpers/suite_shards.py`). Splitting is only safe if no module can
fall between shards, so these tests pin the three things that guarantee it:
the partition is total and deterministic, `verify` rejects every way a set of
shard reports can differ from one run of the whole suite, and the real CLI —
driven over a fixture suite in child interpreters, the way the lane drives it
— produces reports that `verify` accepts and fails the shard that holds a red
or unimportable module.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any

from tests._helpers import suite_shards as shards

_SCRIPT = Path(shards.__file__)
_WEIGHTS = {f"tests.test_m{i:03d}": float((i * 37) % 11 + 1) for i in range(50)}


def _loads(assignment: dict[str, int], weights: dict[str, float], total: int) -> list[float]:
    loads = [0.0] * total
    for name, shard in assignment.items():
        loads[shard - 1] += weights[name]
    return loads


class PartitionTests(unittest.TestCase):
    def test_every_module_lands_in_exactly_one_shard_for_every_count(self) -> None:
        for total in (1, 2, 3, 8, 50):
            assignment = shards.partition(_WEIGHTS, total)
            self.assertEqual(set(assignment), set(_WEIGHTS))
            self.assertEqual(set(assignment.values()), set(range(1, total + 1)))

    def test_the_partition_depends_on_the_weights_not_the_mapping_order(self) -> None:
        reordered = dict(reversed(list(_WEIGHTS.items())))
        self.assertEqual(shards.partition(_WEIGHTS, 8), shards.partition(reordered, 8))

    def test_longest_first_keeps_the_heaviest_module_from_stacking(self) -> None:
        weights = {"heavy": 100.0, **{f"light{i:02d}": 10.0 for i in range(20)}}
        loads = _loads(shards.partition(weights, 3), weights, 3)
        self.assertEqual(max(loads), 100.0)

    def test_a_shard_count_below_one_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            shards.partition({"tests.test_a": 1.0}, 0)


class WeightTests(unittest.TestCase):
    def test_a_measured_module_weighs_its_measurement(self) -> None:
        self.assertEqual(shards.weigh({"a": 10}, {"a": 42.0}), {"a": 42.0})

    def test_an_unmeasured_module_weighs_its_count_at_the_median_rate(self) -> None:
        # rates 2.0 and 1.0 -> median 1.5; six tests -> 9.0
        weights = shards.weigh({"a": 10, "b": 4, "c": 6}, {"a": 20.0, "b": 4.0})
        self.assertEqual(weights["c"], 9.0)

    def test_without_any_measurement_modules_weigh_their_test_count(self) -> None:
        self.assertEqual(shards.weigh({"a": 3, "b": 7}, {}), {"a": 3.0, "b": 7.0})

    def test_a_measurement_of_a_module_the_suite_no_longer_has_is_ignored(self) -> None:
        self.assertEqual(shards.weigh({"a": 2}, {"a": 1.0, "gone": 99.0}), {"a": 1.0})

    def test_the_committed_weights_file_is_a_measurement(self) -> None:
        weights = shards.load_weights()
        self.assertTrue(weights, "suite_shard_weights.json is empty or absent")
        self.assertTrue(all(seconds >= 0 for seconds in weights.values()))


class ShardSpecTests(unittest.TestCase):
    def test_k_of_n_parses(self) -> None:
        self.assertEqual(shards.parse_shard("3/8"), (3, 8))

    def test_malformed_or_out_of_range_specs_are_refused(self) -> None:
        for spec in ("0/8", "9/8", "3", "a/b", "-1/2", "1/"):
            with self.subTest(spec=spec), self.assertRaises(ValueError):
                shards.parse_shard(spec)


def _report(shard: int, total: int, modules: dict[str, int], **overrides: Any) -> dict[str, Any]:
    report: dict[str, Any] = {
        "schema": shards.REPORT_SCHEMA,
        "shard": shard,
        "total": total,
        "suite_digest": "d" * 64,
        "suite_modules": 3,
        "suite_tests": 6,
        "modules": {name: {"tests": tests, "seconds": 1.0} for name, tests in modules.items()},
        "tests_run": sum(modules.values()),
        "successful": True,
    }
    report.update(overrides)
    return report


class VerifyTests(unittest.TestCase):
    def _complete(self) -> list[dict[str, Any]]:
        return [_report(1, 2, {"m.a": 1, "m.b": 2}), _report(2, 2, {"m.c": 3})]

    def test_reports_that_cover_the_suite_once_verify(self) -> None:
        self.assertEqual(shards.verify_reports(self._complete()), [])

    def test_no_report_at_all_is_a_problem(self) -> None:
        self.assertEqual(shards.verify_reports([]), ["no shard report was produced"])

    def test_a_missing_shard_is_named(self) -> None:
        problems = shards.verify_reports(self._complete()[:1])
        self.assertIn("shard indices [1] are not exactly 1..2", problems)

    def test_a_duplicated_shard_index_is_named(self) -> None:
        first = self._complete()[0]
        problems = shards.verify_reports([first, _report(1, 2, {"m.c": 3})])
        self.assertIn("shard indices [1, 1] are not exactly 1..2", problems)

    def test_shards_that_discovered_different_suites_are_refused(self) -> None:
        reports = self._complete()
        reports[1]["suite_digest"] = "e" * 64
        problems = shards.verify_reports(reports)
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("shards disagree on suite_digest"))

    def test_a_module_run_by_two_shards_is_named(self) -> None:
        reports = [_report(1, 2, {"m.a": 1, "m.b": 2}), _report(2, 2, {"m.b": 2, "m.c": 3})]
        self.assertIn("module m.b ran in shard 1 and shard 2", shards.verify_reports(reports))

    def test_a_module_no_shard_ran_is_named(self) -> None:
        reports = [_report(1, 2, {"m.a": 1}), _report(2, 2, {"m.c": 3})]
        problems = shards.verify_reports(reports)
        self.assertIn("shards ran 2 modules; discovery found 3", problems)
        self.assertIn("shards own 4 tests; discovery found 6", problems)

    def test_an_unsuccessful_shard_is_named(self) -> None:
        reports = self._complete()
        reports[0]["successful"] = False
        self.assertEqual(shards.verify_reports(reports), ["shard 1 was not successful"])


_PASSING = """
import unittest

class Case(unittest.TestCase):
{methods}
"""


class RerunAttemptTests(unittest.TestCase):
    """A re-run shard's report supersedes the attempt it re-ran (ARIA-MEDIUM-411).

    Every attempt of a run uploaded its report under one artifact name and file
    name, and the verdict job downloads all attempts into one directory, so which
    attempt's report survived was arbitrary. A shard that failed once and passed
    on "re-run failed jobs" was still read as failed (PR 1932, run 38031162176).
    """

    def _write(self, directory: Path, name: str, report: dict[str, Any]) -> None:
        (directory / name).write_text(json.dumps(report), encoding="utf-8")

    def test_the_latest_attempt_of_each_shard_is_the_one_verified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reports = Path(tmp)
            self._write(reports, "shard-1.attempt-1.json", _report(1, 2, {"m.a": 1, "m.b": 2}, run_attempt=1))
            self._write(reports, "shard-2.attempt-1.json",
                        _report(2, 2, {"m.c": 3}, run_attempt=1, successful=False))
            self._write(reports, "shard-2.attempt-2.json", _report(2, 2, {"m.c": 3}, run_attempt=2))
            current = shards.read_reports(reports)
        self.assertEqual(sorted((r["shard"], r["run_attempt"]) for r in current), [(1, 1), (2, 2)])
        self.assertEqual(shards.verify_reports(current), [])

    def test_a_later_failed_attempt_is_not_hidden_by_an_earlier_pass(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reports = Path(tmp)
            self._write(reports, "shard-1.attempt-1.json", _report(1, 1, {"m.a": 1, "m.b": 2, "m.c": 3}, run_attempt=1))
            self._write(reports, "shard-1.attempt-2.json",
                        _report(1, 1, {"m.a": 1, "m.b": 2, "m.c": 3}, run_attempt=2, successful=False))
            current = shards.read_reports(reports)
        self.assertEqual(shards.verify_reports(current), ["shard 1 was not successful"])

    def test_two_reports_for_one_shard_and_attempt_are_both_kept_and_named(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reports = Path(tmp)
            self._write(reports, "a.json", _report(1, 1, {"m.a": 1, "m.b": 2, "m.c": 3}, run_attempt=1))
            self._write(reports, "b.json", _report(1, 1, {"m.a": 1, "m.b": 2, "m.c": 3}, run_attempt=1))
            current = shards.read_reports(reports)
        self.assertEqual(len(current), 2)
        self.assertIn("shard indices [1, 1] are not exactly 1..1", shards.verify_reports(current))


class ShardCliTests(unittest.TestCase):
    """The CLI the lane invokes, over a fixture suite, in child interpreters."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-suite-shards-")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.root = self.tmp / "kernel"
        self.package = self.root / "shardfixture"
        self.package.mkdir(parents=True)
        (self.package / "__init__.py").write_text("", encoding="utf-8")
        for index, count in enumerate((1, 2, 3)):
            methods = "".join(f"    def test_{number}(self):\n        pass\n" for number in range(count))
            self._module(f"test_mod{index}.py", _PASSING.format(methods=methods))
        self.reports = self.tmp / "reports"

    def _module(self, filename: str, source: str) -> None:
        (self.package / filename).write_text(textwrap.dedent(source), encoding="utf-8")

    def _cli(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(_SCRIPT), *args],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def _run(self, spec: str) -> subprocess.CompletedProcess[str]:
        index = spec.split("/")[0]
        return self._cli(
            "run",
            "--shard",
            spec,
            "--report",
            str(self.reports / f"shard-{index}.json"),
            "--kernel-root",
            str(self.root),
            "--weights",
            str(self.tmp / "no-weights.json"),
        )

    def _report(self, index: int) -> dict[str, Any]:
        return json.loads((self.reports / f"shard-{index}.json").read_text(encoding="utf-8"))

    def test_two_shards_cover_the_fixture_suite_and_verify_proves_it(self) -> None:
        for spec in ("1/2", "2/2"):
            proc = self._run(spec)
            self.assertEqual(proc.returncode, 0, proc.stderr)
        verify = self._cli("verify", "--reports-dir", str(self.reports))
        self.assertEqual(verify.returncode, 0, verify.stderr)
        reports = [self._report(1), self._report(2)]
        self.assertEqual(sum(report["tests_run"] for report in reports), 6)
        self.assertEqual(
            sorted(name for report in reports for name in report["modules"]),
            ["shardfixture.test_mod0", "shardfixture.test_mod1", "shardfixture.test_mod2"],
        )

    def test_a_red_module_fails_its_shard_and_verify_names_it(self) -> None:
        self._module("test_red.py", "import unittest\n\nclass Red(unittest.TestCase):\n    def test_red(self):\n        self.fail('red')\n")
        results = {spec: self._run(spec).returncode for spec in ("1/2", "2/2")}
        self.assertEqual(sorted(results.values()), [0, 1])
        verify = self._cli("verify", "--reports-dir", str(self.reports))
        self.assertEqual(verify.returncode, 1)
        self.assertIn("was not successful", verify.stderr)

    def test_a_module_that_fails_to_import_is_assigned_and_fails_by_name(self) -> None:
        self._module("test_broken.py", "raise ImportError('broken fixture module')\n")
        results = [self._run(spec).returncode for spec in ("1/2", "2/2")]
        self.assertIn(1, results)
        owners = [self._report(index) for index in (1, 2)]
        self.assertTrue(any("shardfixture.test_broken" in report["modules"] for report in owners))

    def test_more_shards_than_modules_is_refused_rather_than_run_empty(self) -> None:
        proc = self._run("4/4")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("was assigned no module", proc.stderr)

    def test_a_spawned_child_reimporting_the_script_runs_nothing(self) -> None:
        # multiprocessing's spawn start method imports __main__ again as
        # __mp_main__; a shard runner without its guard re-ran the whole shard
        # inside the child (measured 2026-09-28 while timing this suite).
        probe = f"import runpy; runpy.run_path({str(_SCRIPT)!r}, run_name='__mp_main__'); print('imported')"
        proc = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True, timeout=60, check=False)
        self.assertEqual((proc.returncode, proc.stdout.strip()), (0, "imported"), proc.stderr)


if __name__ == "__main__":
    unittest.main()
