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

import ast
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from typing import Any

from aria_kernel.sandbox_pin_skip import is_sandbox_pin_skip
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


class SuiteLayoutTests(unittest.TestCase):
    def test_no_test_module_sits_at_the_kernel_root(self) -> None:
        # Discovery walks KERNEL_ROOT itself, so a stray root-level module
        # still runs — but outside the ``tests`` package, under a weight key
        # and a module name no other test module shares. Every test module
        # lives under tests/.
        stray = sorted(
            path.name
            for path in shards.KERNEL_ROOT.glob(shards.DISCOVERY_PATTERN)
            if path.is_file()
        )
        self.assertEqual(stray, [])


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
        "partition": shards.HERMETIC,
        "shard": shard,
        "total": total,
        "suite_digest": "d" * 64,
        "suite_modules": 3,
        "suite_tests": 6,
        "live": {},
        "modules": {name: {"tests": tests, "seconds": 1.0} for name, tests in modules.items()},
        "tests_run": sum(modules.values()),
        "successful": True,
        "sandbox_skips": [],
    }
    report.update(overrides)
    return report


def _live_report(modules: dict[str, int], **overrides: Any) -> dict[str, Any]:
    report = _report(0, 0, modules)
    report.update(partition=shards.LIVE, shard=shards.LIVE, total=None)
    report.update(overrides)
    return report


def _verify(reports: list[dict[str, Any]]) -> list[str]:
    """Verify hermetic shards beside an empty live partition (no module declares it)."""
    return shards.verify_reports([*reports, _live_report({})])


class VerifyTests(unittest.TestCase):
    def _complete(self) -> list[dict[str, Any]]:
        return [_report(1, 2, {"m.a": 1, "m.b": 2}), _report(2, 2, {"m.c": 3})]

    def test_reports_that_cover_the_suite_once_verify(self) -> None:
        self.assertEqual(_verify(self._complete()), [])

    def test_no_report_at_all_is_a_problem(self) -> None:
        self.assertEqual(shards.verify_reports([]), ["no shard report was produced"])

    def test_a_missing_shard_is_named(self) -> None:
        problems = _verify(self._complete()[:1])
        self.assertIn("shard indices [1] are not exactly 1..2", problems)

    def test_a_duplicated_shard_index_is_named(self) -> None:
        first = self._complete()[0]
        problems = _verify([first, _report(1, 2, {"m.c": 3})])
        self.assertIn("shard indices [1, 1] are not exactly 1..2", problems)

    def test_shards_that_discovered_different_suites_are_refused(self) -> None:
        reports = self._complete()
        reports[1]["suite_digest"] = "e" * 64
        problems = _verify(reports)
        self.assertEqual(len(problems), 1)
        self.assertTrue(problems[0].startswith("shards disagree on suite_digest"))

    def test_a_module_run_by_two_shards_is_named(self) -> None:
        reports = [_report(1, 2, {"m.a": 1, "m.b": 2}), _report(2, 2, {"m.b": 2, "m.c": 3})]
        self.assertIn("module m.b ran in shard 1 and shard 2", _verify(reports))

    def test_a_module_no_shard_ran_is_named(self) -> None:
        reports = [_report(1, 2, {"m.a": 1}), _report(2, 2, {"m.c": 3})]
        problems = _verify(reports)
        self.assertIn("shards ran 2 modules; discovery found 3", problems)
        self.assertIn("shards own 4 tests; discovery found 6", problems)

    def test_an_unsuccessful_shard_is_named(self) -> None:
        reports = self._complete()
        reports[0]["successful"] = False
        self.assertEqual(_verify(reports), ["shard 1 was not successful"])

    def test_a_shard_that_skipped_a_sandbox_pin_is_refused(self) -> None:
        # ARIA-MEDIUM-130 — the lane verified the backend before the suite ran
        # (ensure-sandbox-backend), so a real-sandbox pin that skipped is a
        # containment proof that did not run, and the run is not green.
        reports = self._complete()
        reports[1]["sandbox_skips"] = ["tests.test_git_containment.RealBwrap.test_commit"]
        problems = _verify(reports)
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("shard 2 skipped 1 real-sandbox pin", problems[0])
        self.assertIn("tests.test_git_containment.RealBwrap.test_commit", problems[0])

    def test_a_report_that_does_not_account_for_sandbox_skips_is_refused(self) -> None:
        reports = self._complete()
        del reports[0]["sandbox_skips"]
        self.assertEqual(_verify(reports), ["shard 1 does not account for its sandbox-pin skips"])


class LivePartitionVerifyTests(unittest.TestCase):
    """ARIA-HIGH-602 — the suite is two partitions, and verify proves both together are the suite once.

    A module that reads the live checkout (product code, the whole tree)
    declares ``READS_LIVE_CHECKOUT``; the shards of the skippable ``suite`` job
    run every other module, and the always-run ``workspace`` job runs the
    declared ones (``run --live``). Verify refuses every way the two can stop
    adding up to one run of the discovered suite.
    """

    _LIVE = {"m.c": "reads apps/** through the real adapter"}

    def _complete(self) -> list[dict[str, Any]]:
        return [
            _report(1, 2, {"m.a": 1}, live=self._LIVE),
            _report(2, 2, {"m.b": 2}, live=self._LIVE),
            _live_report({"m.c": 3}, live=self._LIVE),
        ]

    def test_hermetic_shards_and_the_live_report_cover_the_suite_once(self) -> None:
        self.assertEqual(shards.verify_reports(self._complete()), [])

    def test_a_missing_live_report_is_named(self) -> None:
        problems = shards.verify_reports(self._complete()[:2])
        self.assertIn("no live-partition report was produced", problems)

    def test_a_live_module_run_by_a_hermetic_shard_is_named(self) -> None:
        reports = [
            _report(1, 2, {"m.a": 1, "m.c": 3}, live=self._LIVE),
            _report(2, 2, {"m.b": 2}, live=self._LIVE),
            _live_report({}, live=self._LIVE),
        ]
        problems = shards.verify_reports(reports)
        self.assertIn("live module m.c ran in hermetic shard 1", problems)
        self.assertIn("the live report ran [] but the declared live set is ['m.c']", problems)

    def test_a_live_report_that_ran_an_undeclared_module_is_named(self) -> None:
        reports = [
            _report(1, 1, {"m.a": 1}, live=self._LIVE),
            _live_report({"m.b": 2, "m.c": 3}, live=self._LIVE),
        ]
        problems = shards.verify_reports(reports)
        self.assertIn("the live report ran ['m.b', 'm.c'] but the declared live set is ['m.c']", problems)

    def test_partitions_that_disagree_on_the_declared_live_set_are_refused(self) -> None:
        reports = self._complete()
        reports[2]["live"] = {}
        problems = shards.verify_reports(reports)
        self.assertTrue(any(problem.startswith("shards disagree on live") for problem in problems), problems)

    def test_a_declaration_without_a_reason_is_refused(self) -> None:
        live = {"m.c": "  "}
        reports = [_report(1, 1, {"m.a": 1, "m.b": 2}, live=live), _live_report({"m.c": 3}, live=live)]
        self.assertIn(
            "m.c declares READS_LIVE_CHECKOUT without naming the live property it asserts",
            shards.verify_reports(reports),
        )

    def test_an_unsuccessful_live_report_is_named(self) -> None:
        reports = self._complete()
        reports[2]["successful"] = False
        self.assertEqual(shards.verify_reports(reports), ["the live report was not successful"])

    def test_the_live_partition_alone_verifies_when_the_shards_were_skipped(self) -> None:
        # A PR off the kernel surface skips the shards; the workspace job still
        # runs the live partition, and verify proves that run on its own.
        live_only = self._complete()[2:]
        self.assertEqual(shards.verify_reports(live_only, partitions=(shards.LIVE,)), [])
        self.assertEqual(shards.verify_reports([], partitions=(shards.LIVE,)), ["no shard report was produced"])
        self.assertIn(
            "no live-partition report was produced",
            shards.verify_reports([_report(1, 1, {"m.a": 1})], partitions=(shards.LIVE,)),
        )

    def test_a_hermetic_report_where_only_the_live_partition_ran_is_refused(self) -> None:
        problems = shards.verify_reports(self._complete(), partitions=(shards.LIVE,))
        self.assertIn("a hermetic shard report is present, but only the live partition was expected", problems)

    def test_a_rerun_live_report_supersedes_its_earlier_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            complete = self._complete()
            for index, report in enumerate(complete[:2], start=1):
                (directory / f"shard-{index}.json").write_text(json.dumps(report), encoding="utf-8")
            failed = _live_report({"m.c": 3}, live=self._LIVE, run_attempt=1, successful=False)
            passed = _live_report({"m.c": 3}, live=self._LIVE, run_attempt=2)
            (directory / "live.attempt-1.json").write_text(json.dumps(failed), encoding="utf-8")
            (directory / "live.attempt-2.json").write_text(json.dumps(passed), encoding="utf-8")
            self.assertEqual(shards.verify_reports(shards.read_reports(directory)), [])


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
        (directory / "live.attempt-1.json").write_text(json.dumps(_live_report({}, run_attempt=1)), encoding="utf-8")

    def test_the_latest_attempt_of_each_shard_is_the_one_verified(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            reports = Path(tmp)
            self._write(reports, "shard-1.attempt-1.json", _report(1, 2, {"m.a": 1, "m.b": 2}, run_attempt=1))
            self._write(reports, "shard-2.attempt-1.json",
                        _report(2, 2, {"m.c": 3}, run_attempt=1, successful=False))
            self._write(reports, "shard-2.attempt-2.json", _report(2, 2, {"m.c": 3}, run_attempt=2))
            current = shards.read_reports(reports)
        self.assertEqual(sorted((str(r["shard"]), r["run_attempt"]) for r in current),
                         [("1", 1), ("2", 2), (shards.LIVE, 1)])
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
            current = [report for report in shards.read_reports(reports) if report["partition"] == shards.HERMETIC]
        self.assertEqual(len(current), 2)
        self.assertIn("shard indices [1, 1] are not exactly 1..1", _verify(current))


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
        self.assertEqual(self._run_live().returncode, 0)
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
        self.assertEqual(self._run_live().returncode, 0)
        verify = self._cli("verify", "--reports-dir", str(self.reports))
        self.assertEqual(verify.returncode, 1)
        self.assertIn("was not successful", verify.stderr)

    def test_a_module_that_fails_to_import_is_assigned_and_fails_by_name(self) -> None:
        self._module("test_broken.py", "raise ImportError('broken fixture module')\n")
        results = [self._run(spec).returncode for spec in ("1/2", "2/2")]
        self.assertIn(1, results)
        owners = [self._report(index) for index in (1, 2)]
        self.assertTrue(any("shardfixture.test_broken" in report["modules"] for report in owners))

    def test_a_sandbox_pin_that_skips_is_reported_and_refused_by_verify(self) -> None:
        # The fixture skips through the one helper every real-sandbox pin uses.
        self._module(
            "test_pin.py",
            "import unittest\nfrom tests._helpers.sandbox_pins import skip_sandbox_pin\n\n"
            "class Pin(unittest.TestCase):\n    def test_pin(self):\n        skip_sandbox_pin('fixture host')\n"
            "    def test_other_skip(self):\n        self.skipTest('not a sandbox pin')\n",
        )
        results = [self._run(spec).returncode for spec in ("1/2", "2/2")]
        self.assertEqual(results, [0, 0], "a skip is green inside its shard; verify is the gate")
        self.assertEqual(self._run_live().returncode, 0)
        skips = [skip for index in (1, 2) for skip in self._report(index)["sandbox_skips"]]
        self.assertEqual(skips, ["shardfixture.test_pin.Pin.test_pin"])
        verify = self._cli("verify", "--reports-dir", str(self.reports))
        self.assertEqual(verify.returncode, 1)
        self.assertIn("skipped 1 real-sandbox pin", verify.stderr)

    def _run_live(self) -> subprocess.CompletedProcess[str]:
        return self._cli(
            "run", "--live", "--report", str(self.reports / "live.json"), "--kernel-root", str(self.root),
        )

    def test_the_shards_never_run_a_live_module_and_run_live_runs_only_it(self) -> None:
        # ARIA-HIGH-602 — the live module runs in the always-run workspace job,
        # never in a shard of the job a PR off the kernel surface skips.
        self._module(
            "test_live.py",
            "import unittest\nREADS_LIVE_CHECKOUT = 'reads the fixture checkout'\n\n"
            "class Live(unittest.TestCase):\n    def test_live(self):\n        pass\n",
        )
        for spec in ("1/2", "2/2"):
            proc = self._run(spec)
            self.assertEqual(proc.returncode, 0, proc.stderr)
        shard_modules = sorted(name for index in (1, 2) for name in self._report(index)["modules"])
        self.assertNotIn("shardfixture.test_live", shard_modules)
        self.assertEqual(len(shard_modules), 3)
        verify = self._cli("verify", "--reports-dir", str(self.reports))
        self.assertEqual(verify.returncode, 1, "the live partition has not run yet")
        self.assertIn("no live-partition report was produced", verify.stderr)

        live = self._run_live()
        self.assertEqual(live.returncode, 0, live.stderr)
        report = json.loads((self.reports / "live.json").read_text(encoding="utf-8"))
        self.assertEqual((report["partition"], report["tests_run"]), (shards.LIVE, 1))
        self.assertEqual(list(report["modules"]), ["shardfixture.test_live"])
        self.assertEqual(report["live"], {"shardfixture.test_live": "reads the fixture checkout"})
        verify = self._cli("verify", "--reports-dir", str(self.reports))
        self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_a_suite_without_live_modules_writes_an_empty_live_report(self) -> None:
        live = self._run_live()
        self.assertEqual(live.returncode, 0, live.stderr)
        report = json.loads((self.reports / "live.json").read_text(encoding="utf-8"))
        self.assertEqual((report["modules"], report["tests_run"], report["successful"]), ({}, 0, True))
        verify = self._cli("verify", "--reports-dir", str(self.reports), "--partitions", shards.LIVE)
        self.assertEqual(verify.returncode, 0, verify.stderr)

    def test_a_red_live_module_fails_the_live_run(self) -> None:
        self._module(
            "test_live.py",
            "import unittest\nREADS_LIVE_CHECKOUT = 'reads the fixture checkout'\n\n"
            "class Live(unittest.TestCase):\n    def test_live(self):\n        self.fail('red')\n",
        )
        self.assertEqual(self._run_live().returncode, 1)

    def test_an_empty_live_declaration_is_refused_by_name(self) -> None:
        self._module("test_live.py", "import unittest\nREADS_LIVE_CHECKOUT = ''\n\nclass Live(unittest.TestCase):\n    def test_live(self):\n        pass\n")
        for proc in (self._run("1/2"), self._run_live()):
            self.assertNotEqual(proc.returncode, 0)
            self.assertIn("shardfixture.test_live", proc.stderr)
            self.assertIn("READS_LIVE_CHECKOUT", proc.stderr)

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


class PytestNativeLivePartitionTests(unittest.TestCase):
    """The pytest-owned half follows the same partition (aria_kernel.pytest_native_only)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="aria-pytest-live-")
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        (self.tmp / "test_hermetic_native.py").write_text("def test_hermetic():\n    pass\n", encoding="utf-8")
        (self.tmp / "test_live_native.py").write_text(
            "READS_LIVE_CHECKOUT = 'reads the fixture checkout'\n\ndef test_live():\n    pass\n", encoding="utf-8",
        )

    def _pytest(self, *extra: str) -> subprocess.CompletedProcess[str]:
        env = {key: value for key, value in os.environ.items() if not key.startswith("PYTEST_")}
        env["PYTHONPATH"] = str(shards.KERNEL_ROOT)
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        return subprocess.run(
            [sys.executable, "-m", "pytest", "-q", "-p", "no:cacheprovider", "-p", "aria_kernel.pytest_native_only",
             "--collect-only", *extra, str(self.tmp)],
            cwd=self.tmp, env=env, capture_output=True, text=True, timeout=120, check=False,
        )

    def test_the_default_run_deselects_a_live_module(self) -> None:
        proc = self._pytest()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("test_hermetic_native.py::test_hermetic", proc.stdout)
        self.assertNotIn("test_live_native.py::test_live", proc.stdout)

    def test_live_only_selects_only_the_live_module(self) -> None:
        proc = self._pytest("--aria-live-only")
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("test_live_native.py::test_live", proc.stdout)
        self.assertNotIn("test_hermetic_native.py::test_hermetic", proc.stdout)

    def test_an_empty_declaration_is_a_usage_error(self) -> None:
        (self.tmp / "test_live_native.py").write_text("READS_LIVE_CHECKOUT = ''\n\ndef test_live():\n    pass\n", encoding="utf-8")
        proc = self._pytest()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("READS_LIVE_CHECKOUT", proc.stdout + proc.stderr)


class LiveDeclarationsInTheSuiteTests(unittest.TestCase):
    def test_the_typeorm_adapter_integration_reads_the_live_checkout_by_declaration(self) -> None:
        # It runs the real adapter over apps/farm-service/src and asserts what
        # it read there: product code, which is no kernel surface (ARIA-HIGH-602).
        from aria_kernel.live_partition import live_declaration
        from tests import test_typeorm_adapter_integration as module

        reason = live_declaration(module)
        self.assertIsNotNone(reason)
        self.assertIn("apps/farm-service", str(reason))


_SKIP_CALLS = frozenset({"skipTest", "SkipTest", "skip", "skipIf", "skipUnless"})
_SANDBOX_WORDS = ("bwrap", "sandbox")


def _skip_call_texts(tree: ast.AST) -> list[tuple[int, str]]:
    """``(line, literal text)`` of every skip call whose reason is written out."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        name = node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", None)
        if name not in _SKIP_CALLS:
            continue
        for argument in node.args:
            for part in ast.walk(argument):
                if isinstance(part, ast.Constant) and isinstance(part.value, str):
                    found.append((node.lineno, part.value))
    return found


class SandboxPinSkipSpellingTests(unittest.TestCase):
    """ARIA-MEDIUM-130 — every real-sandbox skip carries the name verify counts.

    ``verify`` can refuse a skipped sandbox pin only if the skip says it is
    one. A pin that skips with its own reason text is green and uncounted, so
    every skip whose reason names bwrap or the sandbox goes through
    ``tests/_helpers/sandbox_pins.py``.
    """

    def test_no_test_module_spells_its_own_sandbox_skip(self) -> None:
        helper = shards.KERNEL_ROOT / "tests" / "_helpers" / "sandbox_pins.py"
        offenders: list[str] = []
        for path in sorted((shards.KERNEL_ROOT / "tests").rglob("*.py")):
            if path == helper:
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for line, text in _skip_call_texts(tree):
                if any(word in text.lower() for word in _SANDBOX_WORDS):
                    offenders.append(f"{path.relative_to(shards.KERNEL_ROOT).as_posix()}:{line}")
        self.assertEqual(offenders, [], "skip through tests._helpers.sandbox_pins so verify counts it")

    def test_the_helper_skips_with_the_marker_verify_counts(self) -> None:
        from tests._helpers import sandbox_pins

        with self.assertRaises(unittest.SkipTest) as raised:
            sandbox_pins.skip_sandbox_pin("detail")
        self.assertTrue(is_sandbox_pin_skip(str(raised.exception)))


if __name__ == "__main__":
    unittest.main()
