"""WP-D9 — the discovery-recall block and the DEV miss feed.

DESIGN-discovery row D9, PLAN-v2 §2 'Keşif recall'u' and 'Kaçırma sınıfı',
ARIA-HIGH-758. Nothing scores ARIA's own discovery today: ``_adapter_row``'s
recall is one adapter's retention of its own gold findings, ``judge_replay``'s
is judge recall, and ``missed_signal`` has no producer for ARIA's own misses on
a replayed change. The instrument every later discovery package is measured
with is one subject-keyed block in ``role_fitness`` and one feed from the DEV
cases ARIA missed into ``feedback``.

What is pinned, on synthetic fixtures only (no corpus, no split file, no
held-out id is read; the DEV split is a function of its inputs):

  * the block: per known defect a hit or a miss, per clean commit a false alarm
    or not, each with ``n`` and a Wilson interval from the one Wilson owner
    (``judge_calibration.wilson_lower``). The matcher is the gold hunk window
    plus the defect class, per change subject, whatever mechanism reported;
  * ``measure_role_fitness`` carries the block as ``discovery_recall`` and the
    adapter's own recall is worded "adapter retention rate";
  * the DEV split rule ``dev_split(x_sha, seed)`` -> train / check;
  * the DEV-train miss feed: exactly one ``missed_signal`` (source
    ``replay_dev``) per known miss, carrying its ``miss_class`` (minted once,
    ``no_coverage`` owned by ``observation_coverage``) and its hunk refs;
  * the invariant: a DEV-check case never produces a memory row;
  * the deterministic agreement check: the block and the feed equal an
    external scorer written here as a test helper (plain loops, PREREG
    §Scoring's overlap part) on the same randomised DEV fixtures.

New API pinned here (red at the base because it does not exist yet; each test
reaches it through ``getattr`` after an assertion, so the red is an assertion
failure, never an import or collection error):

  ``role_fitness.measure_discovery_recall(cases, reports)``,
  ``role_fitness.measure_role_fitness(discovery_cases=, discovery_reports=)``
  and its ``discovery_recall`` key, ``role_fitness.dev_split(x_sha, seed)``
  with ``DEV_TRAIN`` / ``DEV_CHECK``, ``role_fitness.feed_dev_misses(paths,
  cases, reports, *, seed, tools)``, the ``replay_dev`` member of
  ``feedback.FEEDBACK_SOURCES`` and the ``no_coverage`` class owned by
  ``observation_coverage``.

Fixture shapes (plain dicts):
  case    {"subject_ref": "change:<base>..<head>", "x_sha": <head>,
           "defects": [defect, ...]}   no defects = a clean control commit
  defect  {"defect_id", "path", "start_line", "end_line", "defect_class"}
  report  {"subject_ref", "path", "start_line", "end_line", "defect_class"}
          plus any mechanism fields (tool_id, mechanism, ...), which the
          matcher ignores
"""

from __future__ import annotations

import builtins
import inspect
import io
import random
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest import mock

from aria_kernel import role_fitness
from aria_kernel.evidence_validator import agent_ref_shape_refusal
from aria_kernel.feedback import FEEDBACK_SOURCES, list_feedback
from aria_kernel.judge_calibration import wilson_lower
from aria_kernel.ledger import read_jsonl
from aria_kernel.tool_registry import ensure_tools_dir
from aria_kernel.workspace import ensure_workspace, workspace_paths

SEED = "d9-fixture-seed"
OTHER_SEED = "d9-other-seed"
FARM = "apps/farm-service/src/pond.ts"
HR = "apps/hr-service/src/leave.ts"
GATEWAY = "sens-api-gateway/src/modbus.rs"
TENANT = "tenant_scope"
AUTHZ = "authz"
RACE = "race_condition"

# A registry row that observes the farm-service TypeScript tree and nothing
# else: the gateway's Rust sources are blind to every adapter (no_coverage).
FARM_ADAPTER: dict[str, Any] = {
    "tool_id": "farm-adapter", "kind": "adapter", "status": "SHADOW",
    "declared_scope": ["apps/farm-service/src/**/*.ts"],
}
GATEWAY_ADAPTER: dict[str, Any] = {
    "tool_id": "gateway-adapter", "kind": "adapter", "status": "SHADOW",
    "declared_scope": ["sens-api-gateway/**/*.rs"],
}


def _sha(n: int) -> str:
    return f"{n:040x}"


def _subject(n: int) -> str:
    return f"change:{_sha(n + 10**6)}..{_sha(n)}"


def _defect(defect_id: str, path: str, start: int, end: int, defect_class: str) -> dict[str, Any]:
    return {"defect_id": defect_id, "path": path, "start_line": start, "end_line": end, "defect_class": defect_class}


def _case(n: int, defects: list[dict[str, Any]]) -> dict[str, Any]:
    return {"subject_ref": _subject(n), "x_sha": _sha(n), "defects": defects}


def _report(n: int, path: str, start: int, end: int, defect_class: str, **mechanism: Any) -> dict[str, Any]:
    return {"subject_ref": _subject(n), "path": path, "start_line": start, "end_line": end,
            "defect_class": defect_class, **mechanism}


def _attr(test: unittest.TestCase, name: str) -> Any:
    value = getattr(role_fitness, name, None)
    test.assertIsNotNone(value, f"aria_kernel.role_fitness.{name} does not exist: D9 has no discovery-recall instrument")
    return value


def _wilson_upper(successes: int, trials: int) -> float | None:
    """The Wilson interval's upper bound through the one lower-bound owner."""
    lower = wilson_lower(trials - successes, trials)
    return None if lower is None else round(1 - lower, 4)


def _tmp_case(prefix: str) -> Path:
    return Path(tempfile.mkdtemp(prefix=prefix))


class _Case(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = _tmp_case("aria-d9-")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def assert_part(self, part: dict[str, Any], expected: dict[str, Any]) -> None:
        for key, value in expected.items():
            if isinstance(value, float):
                self.assertAlmostEqual(part[key], value, places=4, msg=key)
            else:
                self.assertEqual(part[key], value, key)


class DiscoveryRecallBlockTests(_Case):
    def _measure(self, cases: list[dict[str, Any]], reports: list[dict[str, Any]]) -> dict[str, Any]:
        return _attr(self, "measure_discovery_recall")(cases, reports)

    def _hits(self, defect: dict[str, Any], report: dict[str, Any]) -> int:
        block = self._measure([_case(1, [defect])], [report])
        return block["defects"]["hits"]

    def test_the_block_counts_hits_misses_and_clean_false_alarms_with_n_and_wilson(self) -> None:
        cases = [
            _case(1, [_defect("a", FARM, 40, 52, TENANT), _defect("b", HR, 10, 20, AUTHZ)]),
            _case(2, [_defect("c", FARM, 100, 110, TENANT), _defect("d", GATEWAY, 5, 9, RACE)]),
            *[_case(n, []) for n in (3, 4, 5, 6, 7)],
        ]
        reports = [
            _report(1, FARM, 44, 44, TENANT, tool_id="tenant-scoping-adapter"),        # hit a
            _report(1, HR, 20, 25, AUTHZ, mechanism="llm_claim"),                      # hit b (shares line 20)
            _report(2, FARM, 100, 110, AUTHZ),                                         # wrong class: c stays a miss
            _report(2, FARM, 300, 300, TENANT),                                        # on a bug commit: not a false alarm
            _report(3, FARM, 1, 1, TENANT), _report(3, HR, 3, 3, AUTHZ),               # clean commit, two reports
            _report(4, FARM, 9, 9, TENANT),                                            # clean commit, one report
            _report(99, FARM, 44, 44, TENANT),                                         # a change with no case: ignored
        ]
        block = self._measure(cases, reports)
        self.assertEqual(block["status"], role_fitness.MEASURED)
        self.assert_part(block["defects"], {
            "n": 4, "hits": 2, "misses": 2, "recall": 0.5,
            "wilson_lower": wilson_lower(2, 4), "wilson_upper": _wilson_upper(2, 4),
        })
        self.assert_part(block["clean_commits"], {
            "n": 5, "false_alarms": 2, "false_alarm_rate": 0.4, "reports": 3,
            "wilson_lower": wilson_lower(2, 5), "wilson_upper": _wilson_upper(2, 5),
        })

    def test_the_matcher_is_the_hunk_window_plus_the_defect_class(self) -> None:
        defect = _defect("a", FARM, 40, 52, TENANT)
        for label, path, start, end, defect_class, expected in (
            ("inside the window", FARM, 44, 44, TENANT, 1),
            ("starts on the window's last line", FARM, 52, 60, TENANT, 1),
            ("ends on the window's first line", FARM, 30, 40, TENANT, 1),
            ("wraps the window", FARM, 1, 500, TENANT, 1),
            ("ends one line before the window", FARM, 30, 39, TENANT, 0),
            ("starts one line after the window", FARM, 53, 60, TENANT, 0),
            ("another defect class", FARM, 44, 44, AUTHZ, 0),
            ("another file", HR, 44, 44, TENANT, 0),
        ):
            with self.subTest(label):
                self.assertEqual(self._hits(defect, _report(1, path, start, end, defect_class)), expected)

    def test_a_report_is_credited_to_its_own_change_only(self) -> None:
        cases = [_case(1, [_defect("a", FARM, 40, 52, TENANT)]), _case(2, [])]
        block = self._measure(cases, [_report(2, FARM, 44, 44, TENANT)])
        self.assertEqual(block["defects"]["hits"], 0, "a report on another change must not hit this change's defect")
        self.assertEqual(block["clean_commits"]["false_alarms"], 1)

    def test_the_mechanism_that_reported_does_not_change_the_block(self) -> None:
        cases = [_case(1, [_defect("a", FARM, 40, 52, TENANT)]), _case(2, [])]
        outcomes = []
        for mechanism in ({}, {"tool_id": "workflow-shell-safety"}, {"mechanism": "llm_claim", "claim_type": "wrong_code"}):
            reports = [_report(1, FARM, 41, 41, TENANT, **mechanism), _report(2, HR, 7, 7, AUTHZ, **mechanism)]
            outcomes.append(self._measure(cases, reports))
        self.assertEqual(outcomes[0]["defects"]["hits"], 1)
        self.assertEqual(outcomes[0]["clean_commits"]["false_alarms"], 1)
        self.assertEqual(outcomes[0], outcomes[1])
        self.assertEqual(outcomes[0], outcomes[2])

    def test_many_reports_on_one_defect_are_one_hit(self) -> None:
        block = self._measure(
            [_case(1, [_defect("a", FARM, 40, 52, TENANT)])],
            [_report(1, FARM, 41, 41, TENANT), _report(1, FARM, 42, 45, TENANT), _report(1, FARM, 52, 52, TENANT)],
        )
        self.assert_part(block["defects"], {"n": 1, "hits": 1, "misses": 0, "recall": 1.0})

    def test_a_part_with_nothing_to_score_has_no_rate_and_no_interval(self) -> None:
        only_clean = self._measure([_case(1, []), _case(2, [])], [_report(1, FARM, 1, 1, TENANT)])
        self.assert_part(only_clean["defects"], {
            "n": 0, "hits": 0, "misses": 0, "recall": None, "wilson_lower": None, "wilson_upper": None})
        only_bugs = self._measure([_case(1, [_defect("a", FARM, 1, 2, TENANT)])], [])
        self.assert_part(only_bugs["clean_commits"], {
            "n": 0, "false_alarms": 0, "false_alarm_rate": None, "wilson_lower": None, "wilson_upper": None})

    def test_measure_role_fitness_carries_the_block_and_unmeasured_without_cases(self) -> None:
        parameters = inspect.signature(role_fitness.measure_role_fitness).parameters
        self.assertIn("discovery_cases", parameters, "measure_role_fitness has no discovery inputs")
        self.assertIn("discovery_reports", parameters, "measure_role_fitness has no discovery inputs")
        tools = ensure_tools_dir(self.tmp / "tools")
        cases = [_case(1, [_defect("a", FARM, 40, 52, TENANT)]), _case(2, [])]
        reports = [_report(1, FARM, 44, 44, TENANT), _report(2, HR, 7, 7, AUTHZ)]
        measured = role_fitness.measure_role_fitness(base_dir=tools, discovery_cases=cases, discovery_reports=reports)
        self.assertEqual(measured["discovery_recall"], self._measure(cases, reports),
                         "one owner: the fitness block is the function's block")
        empty = role_fitness.measure_role_fitness(base_dir=tools)
        status = (empty.get("discovery_recall") or {}).get("status")
        self.assertTrue(str(status).startswith("unmeasured:"), f"no DEV cases is unmeasured, never a score: {status!r}")

    def test_the_adapter_recall_is_worded_as_a_retention_rate_not_the_stage_2_metric(self) -> None:
        self.assertIn("adapter retention rate", (role_fitness.__doc__ or "").lower())


class DevSplitTests(unittest.TestCase):
    def test_the_split_is_a_seeded_pure_function_of_the_x_sha(self) -> None:
        dev_split, train, check = _attr(self, "dev_split"), _attr(self, "DEV_TRAIN"), _attr(self, "DEV_CHECK")
        self.assertNotEqual(train, check)
        shas = [_sha(n) for n in range(1, 401)]
        first = [dev_split(sha, SEED) for sha in shas]
        self.assertEqual(first, [dev_split(sha, SEED) for sha in shas], "the same inputs must give the same side")
        self.assertEqual(set(first), {train, check})
        for side in (train, check):
            self.assertGreater(first.count(side), 60, f"{side} is a rare side of the split")
        other = [dev_split(sha, OTHER_SEED) for sha in shas]
        self.assertNotEqual(first, other, "the seed must matter")
        self.assertEqual(set(other), {train, check})

    def test_the_split_reads_no_file(self) -> None:
        dev_split = _attr(self, "dev_split")
        dev_split(_sha(1), SEED)  # imports settled before the readers are closed
        refuse = AssertionError("dev_split read a file: the split is a function of its inputs")
        with mock.patch.object(builtins, "open", side_effect=refuse), \
                mock.patch.object(io, "open", side_effect=refuse), \
                mock.patch.object(Path, "open", side_effect=refuse), \
                mock.patch.object(Path, "read_text", side_effect=refuse), \
                mock.patch.object(Path, "read_bytes", side_effect=refuse):
            self.assertIn(dev_split(_sha(2), SEED), {_attr(self, "DEV_TRAIN"), _attr(self, "DEV_CHECK")})


class _FeedCase(_Case):
    def setUp(self) -> None:
        super().setUp()
        repo = self.tmp / "repo"
        repo.mkdir()
        self.paths = workspace_paths(repo, self.tmp / "ws")
        ensure_workspace(self.paths)

    def ns(self, side_name: str, seed: str, count: int, *, skip: tuple[int, ...] = ()) -> list[int]:
        """Change numbers whose X sha the rule puts on ``side_name`` under ``seed``."""
        dev_split, side = _attr(self, "dev_split"), _attr(self, side_name)
        found = [n for n in range(1, 2000) if n not in skip and dev_split(_sha(n), seed) == side]
        self.assertGreaterEqual(len(found), count)
        return found[:count]

    def feed(self, cases: list[dict[str, Any]], reports: list[dict[str, Any]], *,
             seed: str = SEED, tools: list[dict[str, Any]] | None = None) -> None:
        _attr(self, "feed_dev_misses")(
            self.paths, cases, reports, seed=seed, tools=[FARM_ADAPTER] if tools is None else tools)

    def missed(self) -> list[dict[str, Any]]:
        return list(read_jsonl(self.paths.ledgers["missed_signals"]))

    def memory_bytes(self) -> dict[str, bytes]:
        """Every memory ledger and the integrity index, byte for byte."""
        files = [*sorted(self.paths.memory_dir.glob("*.jsonl")), self.paths.feedback_index]
        return {path.name: path.read_bytes() for path in files}


class DevMissFeedTests(_FeedCase):
    def test_replay_dev_is_a_feedback_source(self) -> None:
        self.assertIn("replay_dev", FEEDBACK_SOURCES)

    def test_a_dev_train_fixture_with_a_known_miss_gives_exactly_one_missed_signal_with_class_and_hunk_refs(self) -> None:
        (n,) = self.ns("DEV_TRAIN", SEED, 1)
        case = _case(n, [_defect("hit", FARM, 40, 52, TENANT), _defect("miss", GATEWAY, 5, 9, AUTHZ)])
        self.feed([case], [_report(n, FARM, 44, 44, TENANT)])
        rows = self.missed()
        self.assertEqual(len(rows), 1, "one known miss, one missed_signal; the hit mints none")
        row = rows[0]
        self.assertEqual((row["kind"], row["source"]), ("missed_signal", "replay_dev"))
        self.assertEqual(row["miss_class"], "no_coverage", "no adapter declares the gateway's Rust sources")
        self.assertEqual(row["defect_class"], AUTHZ)
        self.assertEqual(row["subject_ref"], case["subject_ref"])
        self.assertEqual(row["refs"], [f"{GATEWAY}:5"])
        self.assertEqual(row["hunk"], {"path": GATEWAY, "start_line": 5, "end_line": 9})
        self.assertIsNone(agent_ref_shape_refusal(row["refs"][0]), "a hunk ref must satisfy the agent evidence law")

    def test_each_known_miss_is_one_row_and_a_second_feed_adds_none(self) -> None:
        first, second = self.ns("DEV_TRAIN", SEED, 2)
        cases = [
            _case(first, [_defect("a", FARM, 10, 20, TENANT), _defect("b", HR, 30, 40, AUTHZ)]),
            _case(second, [_defect("c", GATEWAY, 1, 3, RACE)]),
        ]
        self.feed(cases, [])
        self.assertEqual(len(self.missed()), 3)
        self.assertEqual(len({tuple(row["refs"]) for row in self.missed()}), 3)
        self.feed(cases, [])
        self.assertEqual(len(self.missed()), 3, "a re-run must not mint a second missed_signal for the same miss")

    def test_hits_and_clean_false_alarms_mint_no_missed_signal(self) -> None:
        bug, clean = self.ns("DEV_TRAIN", SEED, 2)
        cases = [_case(bug, [_defect("a", FARM, 40, 52, TENANT)]), _case(clean, [])]
        self.feed(cases, [_report(bug, FARM, 41, 41, TENANT), _report(clean, HR, 3, 3, AUTHZ)])
        self.assertEqual(self.missed(), [])

    def test_the_miss_class_is_no_coverage_only_where_no_adapter_observes(self) -> None:
        (n,) = self.ns("DEV_TRAIN", SEED, 1)
        self.feed([_case(n, [_defect("seen", FARM, 40, 52, TENANT), _defect("blind", GATEWAY, 5, 9, TENANT)])], [])
        by_ref = {row["refs"][0]: row["miss_class"] for row in self.missed()}
        self.assertEqual(by_ref[f"{GATEWAY}:5"], "no_coverage")
        observed = by_ref[f"{FARM}:40"]
        self.assertTrue(isinstance(observed, str) and observed and observed != "no_coverage",
                        f"a miss inside an observed scope has another class: {observed!r}")

    def test_the_miss_class_is_minted_once(self) -> None:
        (n,) = self.ns("DEV_TRAIN", SEED, 1)
        cases = [_case(n, [_defect("blind", GATEWAY, 5, 9, TENANT)])]
        self.feed(cases, [], tools=[FARM_ADAPTER])
        self.feed(cases, [], tools=[FARM_ADAPTER, GATEWAY_ADAPTER])  # the gateway is observed by now
        rows = self.missed()
        self.assertEqual([row["miss_class"] for row in rows], ["no_coverage"], "minted at mint time, once, never re-derived")

    def test_no_coverage_has_one_owner_observation_coverage(self) -> None:
        kernel = Path(role_fitness.__file__).resolve().parent
        owners = sorted(path.name for path in kernel.glob("*.py")
                        if re.search(r"""["']no_coverage["']""", path.read_text(encoding="utf-8")))
        self.assertEqual(owners, ["observation_coverage.py"])


class DevCheckNeverWritesMemoryTests(_FeedCase):
    def test_a_dev_check_case_never_produces_a_memory_row(self) -> None:
        miss, clean = self.ns("DEV_CHECK", SEED, 2)
        cases = [_case(miss, [_defect("a", GATEWAY, 5, 9, AUTHZ), _defect("b", FARM, 40, 52, TENANT)]), _case(clean, [])]
        before = self.memory_bytes()
        self.feed(cases, [_report(clean, HR, 3, 3, AUTHZ)])
        self.assertEqual(self.memory_bytes(), before, "DEV-check scoring wrote to memory")
        self.assertEqual(list_feedback(self.paths), [])

    def test_a_mixed_run_writes_only_the_train_miss(self) -> None:
        (train,) = self.ns("DEV_TRAIN", SEED, 1)
        (check,) = self.ns("DEV_CHECK", SEED, 1)
        cases = [_case(check, [_defect("c", HR, 30, 40, AUTHZ)]), _case(train, [_defect("t", GATEWAY, 5, 9, RACE)])]
        self.feed(cases, [])
        rows = self.missed()
        self.assertEqual([row["subject_ref"] for row in rows], [_subject(train)])
        self.assertNotIn(_sha(check), repr(rows), "a DEV-check case left a trace in memory")

    def test_the_side_follows_the_seeded_rule_not_a_fixed_assignment(self) -> None:
        dev_split, train, check = _attr(self, "dev_split"), _attr(self, "DEV_TRAIN"), _attr(self, "DEV_CHECK")
        n = next(n for n in range(1, 2000)
                 if dev_split(_sha(n), SEED) == train and dev_split(_sha(n), OTHER_SEED) == check)
        cases = [_case(n, [_defect("a", GATEWAY, 5, 9, AUTHZ)])]
        self.feed(cases, [], seed=SEED)
        self.assertEqual(len(self.missed()), 1, "train under SEED feeds memory")
        other = _FeedCase("run")
        other.setUp()
        try:
            other.feed(cases, [], seed=OTHER_SEED)
            self.assertEqual(other.missed(), [], "the same case is DEV-check under OTHER_SEED and must write nothing")
        finally:
            other.tearDown()


def _random_world(rng: random.Random, count: int) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    paths = [FARM, HR, GATEWAY, "libs/backend-common/src/guard.ts", "web/shell/src/app.tsx", "platform/libs/outbox/src/relay.ts"]
    classes = [TENANT, AUTHZ, RACE, "sql_injection"]
    cases: list[dict[str, Any]] = []
    reports: list[dict[str, Any]] = []
    for n in range(1, count + 1):
        defects: list[dict[str, Any]] = []
        if rng.random() < 0.6:
            for index, path in enumerate(rng.sample(paths, rng.randint(1, 3))):
                start = rng.randint(1, 200)
                defects.append(_defect(f"{n}-{index}", path, start, start + rng.randint(0, 15), rng.choice(classes)))
        cases.append(_case(n, defects))
        for defect in defects:
            roll = rng.random()
            if roll < 0.45:    # inside the window
                line = rng.randint(defect["start_line"], defect["end_line"])
                reports.append(_report(n, defect["path"], line, line, defect["defect_class"], mechanism="x"))
            elif roll < 0.60:  # just outside the window, one line either side
                line = defect["start_line"] - 1 if rng.random() < 0.5 else defect["end_line"] + 1
                reports.append(_report(n, defect["path"], line, line, defect["defect_class"], tool_id="y"))
            elif roll < 0.75:  # right place, another class
                other = rng.choice([c for c in classes if c != defect["defect_class"]])
                reports.append(_report(n, defect["path"], defect["start_line"], defect["end_line"], other))
            elif roll < 0.85:  # a wide report that overlaps the window
                reports.append(_report(n, defect["path"], max(1, defect["start_line"] - 30), defect["end_line"] + 30,
                                       defect["defect_class"], claim_type="wrong_code"))
        for _ in range(rng.choice((0, 0, 1, 2))):  # noise on any change, bug or clean
            line = rng.randint(1, 400)
            reports.append(_report(n, rng.choice(paths), line, line + rng.randint(0, 3), rng.choice(classes)))
    reports.append(_report(count + 50, FARM, 1, 1, TENANT))  # a change with no case
    return cases, reports


class _ExternalScorer:
    """The deterministic overlap part of the decision-test scorer (PREREG §Scoring).

    A report hits a defect iff it is on the same change, in the same file, its
    lines overlap the fix's hunk window and it names the same defect class. Plain
    loops over the fixtures; it shares nothing with role_fitness (the Wilson
    owner is applied by the test, not here).
    """

    def __init__(self, cases: list[dict[str, Any]], reports: list[dict[str, Any]]) -> None:
        self.defects = self.hits = self.clean = self.false_alarms = self.clean_reports = 0
        self.missed: list[tuple[str, str, int]] = []
        for case in cases:
            mine = [r for r in reports if r["subject_ref"] == case["subject_ref"]]
            if not case["defects"]:
                self.clean += 1
                self.clean_reports += len(mine)
                self.false_alarms += 1 if mine else 0
                continue
            for d in case["defects"]:
                self.defects += 1
                found = any(
                    r["path"] == d["path"] and r["defect_class"] == d["defect_class"]
                    and r["start_line"] <= d["end_line"] and d["start_line"] <= r["end_line"]
                    for r in mine
                )
                if found:
                    self.hits += 1
                else:
                    self.missed.append((case["subject_ref"], d["path"], d["start_line"]))


class AgreementWithTheExternalScorerTests(_FeedCase):
    def test_the_block_and_the_feed_equal_the_external_scorer_on_the_same_dev_runs(self) -> None:
        cases, reports = _random_world(random.Random(20261025), 60)
        dev_split, train = _attr(self, "dev_split"), _attr(self, "DEV_TRAIN")
        external = _ExternalScorer(cases, reports)
        # The fixture must exercise every outcome, or agreement would be vacuous.
        self.assertGreater(external.hits, 10)
        self.assertGreater(len(external.missed), 10)
        self.assertGreater(external.false_alarms, 5)
        train_cases = [c for c in cases if dev_split(c["x_sha"], SEED) == train]
        check_subjects = {c["subject_ref"] for c in cases if dev_split(c["x_sha"], SEED) != train}
        train_missed = set(_ExternalScorer(train_cases, reports).missed)
        self.assertGreater(len(train_missed), 3)
        self.assertGreater(sum(1 for m in external.missed if m[0] in check_subjects), 3,
                           "too few DEV-check misses to prove they stay out of memory")

        block = _attr(self, "measure_discovery_recall")(cases, reports)
        self.assert_part(block["defects"], {
            "n": external.defects, "hits": external.hits, "misses": len(external.missed),
            "recall": round(external.hits / external.defects, 4),
            "wilson_lower": wilson_lower(external.hits, external.defects),
            "wilson_upper": _wilson_upper(external.hits, external.defects),
        })
        self.assert_part(block["clean_commits"], {
            "n": external.clean, "false_alarms": external.false_alarms, "reports": external.clean_reports,
            "false_alarm_rate": round(external.false_alarms / external.clean, 4),
            "wilson_lower": wilson_lower(external.false_alarms, external.clean),
            "wilson_upper": _wilson_upper(external.false_alarms, external.clean),
        })

        self.feed(cases, reports)
        rows = self.missed()
        fed = {(row["subject_ref"], row["hunk"]["path"], row["hunk"]["start_line"]) for row in rows}
        self.assertEqual(len(rows), len(fed), "one missed_signal per known miss")
        self.assertEqual(fed, train_missed, "the feed is the external scorer's DEV-train misses, and only those")


if __name__ == "__main__":
    unittest.main()
