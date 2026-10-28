"""ARIA-HIGH-125 — ARIA's own precision and recall, measured against a gold corpus.

WHY. The judges and the adapters are promoted on numbers they produce
themselves: an adapter's precision is the judges' verdicts on its findings,
and a judge's calibration is scored against agreement it may have helped
form. The goldset (``goldset``: operator verdicts and three-judge anchors,
promoted by a named curator) is the one corpus whose answers nobody in the
loop wrote, and the judge replay (``judge_replay``) already sits the judges
in front of it. Nothing scored either against it, so a promotion of ARIA's
own machinery had no measured "better" to rest on.

WHAT. :func:`measure_role_fitness` (pure, read-only) scores, per adapter with
an active goldset:

* the adapter: its version in force (``tool_health.current_emission_scope``,
  the latest ok run's fingerprints) against the goldset's labelled items —
  precision over the labelled findings it emits, and its
  adapter retention rate (stored under ``recall``): the share of the goldset's
  true positives it still emits. That is one adapter's memory of its own gold
  findings, not the stage-2 discovery recall, which the discovery block below
  measures;
* each judge: its verdicts on that tool's replay groups
  (``judge_calibration.score_judges`` over ``replay:<tool>:``) — precision,
  recall and expected calibration error;
* ARIA's own discovery (WP-D9, ``measure_discovery_recall``): over DEV cases
  and the subject-keyed reports any mechanism made on them, the share of known
  defects reported (a hit is a report on the same change in the same file whose
  lines overlap the gold hunk window and that names the defect's class, however
  it was found) and the share of clean control commits that drew any report,
  each with ``n`` and the Wilson interval of ``judge_calibration.wilson_interval``.
  The zoo scorer (``score_zoo_discovery``, WP-D3) is the same measurement over the
  defect zoo's labels and the change review's claims: both are callers of ONE fold
  (``_score_known_defects``) and ONE matcher (``_defect_is_hit``), differing only in
  the window around a defect's lines (``GOLD_LINE_WINDOW`` | ``ZOO_LINE_WINDOW``).
  The DEV-train misses are fed to memory as ``missed_signal`` rows
  (``feed_dev_misses``); a DEV-check case never writes memory.

A role with nothing to be scored against is ``unmeasured:<why>``, never a
score: no active goldset, no ok run, no labelled emission, no replay verdict,
no discovery cases.

The nightly fitness report (``fitness.generate_fitness_report``) records the
measurement, named by the goldset it read (``goldset_hash``), after the judge
replay that minted that night's replay verdicts.

:func:`adapter_fitness_blocker` is the read side: the autonomous promotion
lanes (the auto-promote token and the panel lane, ``promotion_veto``) refuse
an adapter whose newest fitness report does not measure its current version
against its current goldset at or above its precision floor. The operator's
GitHub act is not gated here: a person promoting a tool is the judgment this
measurement exists to stand in for when no person is asked.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, NamedTuple, Sequence

from .digest import sha256_hex

if TYPE_CHECKING:
    from .workspace import WorkspacePaths

ROLE_FITNESS_SCHEMA = "aria/role-fitness/v1"
MEASURED = "measured"
UNMEASURED_NO_GOLDSET = "unmeasured:no_active_goldset"
UNMEASURED_NO_OK_RUN = "unmeasured:no_ok_run"
UNMEASURED_NO_LABELLED_EMISSION = "unmeasured:no_labelled_emission"
UNMEASURED_NO_REPLAY_VERDICT = "unmeasured:no_replay_verdict"
# WP-J D-2 — the mutation-canary block's own unmeasured reasons: the corpus
# is registered through the goldset lane, so its absence is distinct from
# an organic tool's no-goldset, and a registered corpus with no landed
# panel verdicts yet is a canary lane that has not drained, not a finding.
UNMEASURED_NO_CANARY_CORPUS = "unmeasured:no_registered_canary_corpus"
UNMEASURED_NO_CANARY_VERDICTS = "unmeasured:no_canary_verdicts"
# WP-D9 — the discovery block is scored on DEV cases handed to it; without any
# it is unmeasured, never a zero recall.
UNMEASURED_NO_DISCOVERY_CASES = "unmeasured:no_discovery_cases"

# WP-D9 — the two sides of the DEV split. DEV-train feeds memory; DEV-check only
# gates what memory produced and never writes it.
DEV_TRAIN = "dev_train"
DEV_CHECK = "dev_check"

# The blockers the read side names; each is the reason an autonomous lane
# refuses (``adapter_fitness_blocker``).
FITNESS_UNMEASURED = "fitness_unmeasured"
FITNESS_STALE = "fitness_stale"
FITNESS_BELOW_THRESHOLD = "fitness_below_threshold"

# The window around a known defect's lines inside which a report still hits it: the caller's choice, one matcher.
# The gold corpus's hunks are exact (WP-D9: a report hits only by overlapping the hunk); the zoo's labels are
# approximate (WP-D3, ZOO-REPORT: a claim hits when it names the labelled file and its lines come within this many
# lines of the labelled ones).
GOLD_LINE_WINDOW = 0
ZOO_LINE_WINDOW = 10


def goldset_hash(goldset: dict[str, Any]) -> str:
    """The identity of one promoted gold corpus: the digest of its record."""
    from .ledger import sha256_digest_of_canonical_json

    return sha256_digest_of_canonical_json(goldset)


def _gold_fingerprints(items: Iterable[Any]) -> frozenset[str]:
    return frozenset(
        str(item["finding_fingerprint"])
        for item in items
        if isinstance(item, dict) and item.get("finding_fingerprint")
    )


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


def _adapter_row(
    tool: dict[str, Any],
    goldset: dict[str, Any],
    runs: list[dict[str, Any]],
    root: Path,
) -> dict[str, Any]:
    from .fixture_runner import tool_manifest_hash
    from .tool_health import current_emission_scope

    tool_id = str(tool["tool_id"])
    true_positives = _gold_fingerprints(goldset.get("true_positive_items") or [])
    false_positives = _gold_fingerprints(goldset.get("known_false_positive_items") or [])
    scope = current_emission_scope(tool_id, [run for run in runs if run.get("tool_id") == tool_id], base_dir=root)
    emitted = scope.fingerprints
    hits = len(emitted & true_positives)
    labelled = len(emitted & (true_positives | false_positives))
    precision = _ratio(hits, labelled)
    # The adapter retention rate (stored under ``recall``): this adapter's own
    # gold true positives it still emits, not ARIA's discovery recall.
    recall = _ratio(hits, len(true_positives))
    status = (
        UNMEASURED_NO_OK_RUN if scope.run_id is None
        else UNMEASURED_NO_LABELLED_EMISSION if precision is None or recall is None
        else MEASURED
    )
    return {
        "status": status,
        "tool_version": tool.get("version"),
        "tool_manifest_hash": tool_manifest_hash(tool),
        "goldset_hash": goldset_hash(goldset),
        "run_id": scope.run_id,
        "gold_true_positives": len(true_positives),
        "gold_known_false_positives": len(false_positives),
        "emitted": len(emitted),
        "emitted_labelled": labelled,
        "emitted_true_positives": hits,
        "precision": precision,
        "recall": recall,
    }


def _judge_rows(tool_id: str, goldset: dict[str, Any], root: Path) -> dict[str, Any]:
    from .judge_calibration import score_judges
    from .judge_replay import REPLAY_GROUP_PREFIX

    scored = score_judges(base_dir=root, judgment_group_prefix=f"{REPLAY_GROUP_PREFIX}{tool_id}:", min_samples=1)
    judges = [
        {
            "judge_id": judge["judge_id"],
            "status": MEASURED,
            "samples": judge["samples"],
            "precision": judge["precision"],
            "recall": judge["recall"],
            "ece": judge["ece_top"],
        }
        for judge in scored["judges"]
        if judge.get("samples")
    ]
    return {
        "status": MEASURED if judges else UNMEASURED_NO_REPLAY_VERDICT,
        "goldset_hash": goldset_hash(goldset),
        "judges": judges,
    }


def _canary_row(root: Path) -> dict[str, Any]:
    """WP-J D-2 — the panel's self-exam against the mutation-canary corpus.

    One corpus, registered through the goldset lane, read here: planted
    mutants the panel must find (true positives by construction) and
    planted false claims it must refute (false positives by construction).
    The bars are the operator's (WP-J §4: ≥ 90 % / ≥ 90 %); an item counts
    as found/refuted when a strict majority of the panel's landed votes on
    it say so — one noisy seat can neither pass nor fail a corpus item
    alone. Named by the digest of the active corpus record, the same law
    the adapter rows are named by (``goldset_hash``).
    """
    from .feedback_store import load_feedback
    from .goldset import load_active_goldset
    from .mutation_canary import (
        CANARY_GROUP_PREFIX,
        CANARY_MIN_FALSE_CLAIM_REFUTATION,
        CANARY_MIN_MUTANT_DETECTION,
        CANARY_SOURCE_TYPE,
        CANARY_TOOL_ID,
    )

    active = load_active_goldset(tool_id=CANARY_TOOL_ID, base_dir=root)
    if not active:
        return {"status": UNMEASURED_NO_CANARY_CORPUS}
    labels: dict[str, dict[str, Any]] = {}
    votes: dict[str, list[str]] = {}
    for row in load_feedback(base_dir=root):
        group = str(row.get("judgment_group_id") or "")
        if not group.startswith(CANARY_GROUP_PREFIX):
            continue
        if row.get("source_type") == CANARY_SOURCE_TYPE:
            labels.setdefault(group, row)
        elif row.get("source_type") == "ai_judge":
            votes.setdefault(group, []).append(str(row.get("verdict") or ""))
    if not votes:
        return {
            "status": UNMEASURED_NO_CANARY_VERDICTS,
            "corpus_hash": goldset_hash(active),
            "mutant_count": len(active.get("true_positive_items") or []),
            "false_claim_count": len(active.get("known_false_positive_items") or []),
        }

    def _majority(group: str, want: str) -> bool:
        group_votes = votes.get(group) or []
        return len(group_votes) > 0 and sum(1 for v in group_votes if v == want) * 2 > len(group_votes)

    mutants = [str(item.get("finding_id") or "") for item in active.get("true_positive_items") or []]
    false_claims = [str(item.get("finding_id") or "") for item in active.get("known_false_positive_items") or []]
    group_of_item = {
        group: str(label.get("finding_id") or "")
        for group, label in labels.items()
    }
    by_item: dict[str, str] = {item: group for group, item in group_of_item.items()}
    # A corpus item whose label row has not landed yet is not measured —
    # an unlabelled item is neither found nor missed, and must not dilute
    # either rate.
    measured_mutants = [item for item in mutants if item in by_item]
    measured_claims = [item for item in false_claims if item in by_item]
    found = sum(1 for item in measured_mutants if _majority(by_item[item], "true_positive"))
    refuted = sum(1 for item in measured_claims if _majority(by_item[item], "false_positive"))
    detection = round(found / len(measured_mutants), 4) if measured_mutants else None
    refutation = round(refuted / len(measured_claims), 4) if measured_claims else None
    bars_met = (
        detection is not None and refutation is not None
        and detection >= CANARY_MIN_MUTANT_DETECTION
        and refutation >= CANARY_MIN_FALSE_CLAIM_REFUTATION
    )
    return {
        "status": MEASURED,
        "corpus_hash": goldset_hash(active),
        "mutant_count": len(mutants),
        "false_claim_count": len(false_claims),
        "measured_mutant_count": len(measured_mutants),
        "measured_false_claim_count": len(measured_claims),
        "mutants_found": found,
        "false_claims_refuted": refuted,
        "mutant_detection_rate": detection,
        "false_claim_refutation_rate": refutation,
        "bars": {
            "min_mutant_detection": CANARY_MIN_MUTANT_DETECTION,
            "min_false_claim_refutation": CANARY_MIN_FALSE_CLAIM_REFUTATION,
        },
        "bars_met": bars_met,
    }


def measure_role_fitness(
    *,
    base_dir: str | Path | None = None,
    runs: list[dict[str, Any]] | None = None,
    discovery_cases: Sequence[dict[str, Any]] = (),
    discovery_reports: Sequence[dict[str, Any]] = (),
) -> dict[str, Any]:
    """Per adapter and per judge, precision and recall against the gold corpus,
    and ARIA's own discovery recall over the DEV cases handed in.

    ``runs`` is the run ledger the caller already read (the fitness report
    reads it once for every dimension); without it the ledger is read here.
    ``discovery_cases`` and ``discovery_reports`` are :func:`measure_discovery_recall`'s
    inputs; without cases the discovery block is unmeasured.
    """
    from .goldset import load_active_goldset
    from .runs_reader import read_runs_rows
    from .tool_health import runs_path
    from .tool_registry import ensure_tools_dir, list_tools

    root = ensure_tools_dir(base_dir)
    if runs is None:
        runs = list(read_runs_rows(runs_path(root), base_dir=root))
    adapters: dict[str, dict[str, Any]] = {}
    judges: dict[str, dict[str, Any]] = {}
    for tool in list_tools(base_dir=root):
        tool_id = str(tool.get("tool_id") or "")
        if not tool_id or tool.get("kind") != "adapter":
            continue
        goldset = load_active_goldset(tool_id=tool_id, base_dir=root)
        if not goldset:
            adapters[tool_id] = {"status": UNMEASURED_NO_GOLDSET, "tool_version": tool.get("version")}
            judges[tool_id] = {"status": UNMEASURED_NO_GOLDSET, "judges": []}
            continue
        adapters[tool_id] = _adapter_row(tool, goldset, runs, root)
        judges[tool_id] = _judge_rows(tool_id, goldset, root)
    return {
        "$schema": ROLE_FITNESS_SCHEMA,
        "adapters": adapters,
        "judges": judges,
        # WP-J D-2 — the panel's canary self-exam, beside the per-adapter
        # rows: precision/recall against a corpus whose labels nobody judged.
        "mutation_canary": _canary_row(root),
        # WP-D9 — ARIA's own discovery, subject-keyed and mechanism-independent.
        "discovery_recall": measure_discovery_recall(discovery_cases, discovery_reports),
    }


def _proportion(count: int, n: int) -> dict[str, Any]:
    """``count`` of ``n`` with its Wilson interval: the one spelling of the interval in this module.

    The interval is ``judge_calibration.wilson_interval``, the one owner (None without trials). The rate is the
    plain quotient: a scorer that rounds its rate rounds it beside this, the interval is never re-derived.
    """
    from .judge_calibration import wilson_interval

    return {"rate": count / n if n else None, "wilson": wilson_interval(count, n)}


def _reports_by_subject(reports: Iterable[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    by_subject: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        by_subject.setdefault(str(report["subject_ref"]), []).append(report)
    return by_subject


def _defect_is_hit(defect: dict[str, Any], reports_on_change: Iterable[dict[str, Any]], window: int) -> bool:
    """The one matcher: does a report on the defect's change hit the defect?

    A report hits a known defect when it is on the same file and its lines overlap the defect's lines widened by
    ``window`` on each side (both ends inclusive), and, when the defect names a ``defect_class`` (gold defects
    always do, the zoo's labels carry none), the report names that class. Which mechanism reported (an adapter, a
    model claim, a drift seeder) is not read: the block scores ARIA, not its parts. The window is the caller's:
    ``GOLD_LINE_WINDOW`` for the gold corpus, ``ZOO_LINE_WINDOW`` for the zoo.
    """
    defect_class = defect.get("defect_class")
    return any(
        report["path"] == defect["path"]
        and (defect_class is None or report["defect_class"] == defect_class)
        and report["start_line"] <= defect["end_line"] + window
        and defect["start_line"] - window <= report["end_line"]
        for report in reports_on_change
    )


class _KnownDefectScore(NamedTuple):
    """What the one fold says about (cases, reports): the hits, the misses and the clean commits with their reports."""

    hits: list[tuple[dict[str, Any], dict[str, Any]]]
    misses: list[tuple[dict[str, Any], dict[str, Any]]]
    clean: list[tuple[dict[str, Any], list[dict[str, Any]]]]

    @property
    def alarmed(self) -> list[dict[str, Any]]:
        """The clean commits on which any report was made (a report on a commit with a known defect is never one)."""
        return [case for case, on_change in self.clean if on_change]


def _score_known_defects(
    cases: Sequence[dict[str, Any]], reports: Iterable[dict[str, Any]], window: int,
) -> _KnownDefectScore:
    """The one fold over (cases, reports): which known defects are hit, which are missed, which clean commits drew a report.

    ``cases`` are ``{"subject_ref", "defects": [{"path", "start_line", "end_line"[, "defect_class"]}, ...]}``; a case
    with no defects is a clean control commit. ``reports`` are ``{"subject_ref", "path", "start_line", "end_line"[,
    "defect_class"]}`` keyed by the change they were made on; a report on a change with no case is ignored, and
    many reports on one defect are one hit. Both public scorers, the DEV miss feed and every later reader of "was
    this known defect found" take it from here, so they cannot disagree about a miss.
    """
    by_subject = _reports_by_subject(reports)
    hits: list[tuple[dict[str, Any], dict[str, Any]]] = []
    misses: list[tuple[dict[str, Any], dict[str, Any]]] = []
    clean: list[tuple[dict[str, Any], list[dict[str, Any]]]] = []
    for case in cases:
        on_change = by_subject.get(case["subject_ref"], [])
        if not case["defects"]:
            clean.append((case, on_change))
        for defect in case["defects"]:
            (hits if _defect_is_hit(defect, on_change, window) else misses).append((case, defect))
    return _KnownDefectScore(hits, misses, clean)


def _bounds(count: int, n: int) -> tuple[float | None, float | None]:
    """The lower and upper end of ``_proportion``'s interval; (None, None) over no trials."""
    interval = _proportion(count, n)["wilson"]
    return (None, None) if interval is None else interval


def measure_discovery_recall(
    cases: Sequence[dict[str, Any]], reports: Sequence[dict[str, Any]],
) -> dict[str, Any]:
    """ARIA's own discovery over DEV cases: defects found, clean commits alarmed.

    ``cases`` are ``{"subject_ref", "x_sha", "defects": [{"defect_id", "path",
    "start_line", "end_line", "defect_class"}, ...]}``; a case with no defects is
    a clean control commit. ``reports`` are ``{"subject_ref", "path",
    "start_line", "end_line", "defect_class"}`` rows from any mechanism, keyed
    by the change they were made on (a report on a change with no case is
    ignored). Per known defect: a hit or a miss (many reports on one defect are
    one hit; the matcher is ``_defect_is_hit`` at ``GOLD_LINE_WINDOW``). Per clean
    commit: a false alarm when any report was made on it (a report on a bug commit
    is never a false alarm). Each part carries ``n``, its rate and a Wilson
    interval; a part with nothing to score has no rate and no interval.
    """
    if not cases:
        return {"status": UNMEASURED_NO_DISCOVERY_CASES}
    score = _score_known_defects(cases, reports, GOLD_LINE_WINDOW)
    defects, hits = len(score.hits) + len(score.misses), len(score.hits)
    clean, alarmed = len(score.clean), len(score.alarmed)
    recall_lower, recall_upper = _bounds(hits, defects)
    alarm_lower, alarm_upper = _bounds(alarmed, clean)
    return {
        "status": MEASURED,
        "defects": {
            "n": defects,
            "hits": hits,
            "misses": len(score.misses),
            "recall": _ratio(hits, defects),
            "wilson_lower": recall_lower,
            "wilson_upper": recall_upper,
        },
        "clean_commits": {
            "n": clean,
            "false_alarms": alarmed,
            "false_alarm_rate": _ratio(alarmed, clean),
            "reports": sum(len(on_change) for _, on_change in score.clean),
            "wilson_lower": alarm_lower,
            "wilson_upper": alarm_upper,
        },
    }


def dev_split(x_sha: str, seed: str) -> str:
    """Which side of DEV a case is on: ``DEV_TRAIN`` or ``DEV_CHECK``.

    A pure function of the case's X sha and the seed recorded before the first
    DEV run (DESIGN-discovery §c): no file is read and no case id is listed
    anywhere, so the split cannot drift from the rule or be edited per case.
    Half the shas fall on each side; the seed moves which half.
    """
    return DEV_TRAIN if int(sha256_hex(f"{seed}\x1f{x_sha}".encode("utf-8")), 16) % 2 else DEV_CHECK


def feed_dev_misses(
    paths: WorkspacePaths,
    cases: Sequence[dict[str, Any]],
    reports: Sequence[dict[str, Any]],
    *,
    seed: str,
    tools: Sequence[dict[str, Any]],
) -> int:
    """Mint one ``missed_signal`` (source ``replay_dev``) per known DEV-train miss.

    ``paths`` is the workspace whose memory learns. A DEV-check case is never
    scored into it, so memory cannot hold a lesson the activation gate will
    later be asked to confirm. Each row carries the defect's class, the hunk
    (``refs`` is ``path:start_line``, ``hunk`` the whole window) and its
    ``miss_class``, minted here once against ``tools`` (the live registry rows)
    by ``observation_coverage.miss_class`` and never re-derived. A miss already
    in memory (same change, same defect) is not minted again. Returns the number
    of rows minted.
    """
    from .feedback import add_feedback, list_feedback
    from .observation_coverage import miss_class

    train = [case for case in cases if dev_split(case["x_sha"], seed) == DEV_TRAIN]
    minted = {
        (row.get("subject_ref"), row.get("defect_id"))
        for row in list_feedback(paths, kind="missed_signal")
        if row.get("source") == "replay_dev"
    }
    count = 0
    for case, defect in _score_known_defects(train, reports, GOLD_LINE_WINDOW).misses:
        key = (case["subject_ref"], defect["defect_id"])
        if key in minted:
            continue
        add_feedback(paths, {
            "kind": "missed_signal",
            "source": "replay_dev",
            "refs": [f"{defect['path']}:{defect['start_line']}"],
            "summary": f"{defect['defect_class']} defect at {defect['path']}:{defect['start_line']}-{defect['end_line']} "
                       f"was not reported on {case['subject_ref']}",
            "subject_ref": case["subject_ref"],
            "defect_id": defect["defect_id"],
            "defect_class": defect["defect_class"],
            "miss_class": miss_class(defect["path"], tools),
            "hunk": {"path": defect["path"], "start_line": defect["start_line"], "end_line": defect["end_line"]},
        })
        minted.add(key)
        count += 1
    return count




def _is_line_number(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _zoo_cases(labels: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The zoo's labels as cases: a defect label is a case with one classless defect, a control is a clean commit."""
    return [
        {
            "subject_ref": str(label["id"]),
            "defects": [] if label["kind"] == "control" else [
                {"path": label["file"], "start_line": label["line_start"], "end_line": label["line_end"]},
            ],
        }
        for label in sorted(labels, key=lambda record: str(record["id"]))
    ]


def _zoo_reports(responses: dict[str, Any]) -> list[dict[str, Any]]:
    """The change review's defect claims as reports, keyed by the label they were made on.

    A claim whose lines are not line numbers (a float, a bool, a string, a missing key, a claim that is no object)
    is no report.
    """
    return [
        {"subject_ref": label_id, "path": claim.get("file"), "start_line": claim["start_line"], "end_line": claim["end_line"]}
        for label_id, response in responses.items()
        for claim in (response.get("details") or {}).get("defect_claims") or []
        if isinstance(claim, dict) and _is_line_number(claim.get("start_line")) and _is_line_number(claim.get("end_line"))
    ]


def score_zoo_discovery(responses: dict[str, Any], labels: list[dict[str, Any]]) -> dict[str, Any]:
    """WP-D3 — the deterministic scorer of the change review's claims on the defect zoo.

    ``labels`` are the zoo's records (``id``, ``kind`` ``defect`` | ``control``, ``file``, ``line_start``,
    ``line_end``); ``responses`` maps a label id to the change-intelligence answer given for that change, whose
    ``details.defect_claims`` are the claims (an answer without any holds none). It is the gold corpus's
    measurement (``_score_known_defects``) over the zoo's cases and the claims as reports, at ``ZOO_LINE_WINDOW``:
    a defect with a claim that hits it is a hit, otherwise a miss; a control that draws any claim is a false alarm.
    Each proportion carries its n and the 95% Wilson interval of ``judge_calibration.wilson_interval``, the one
    owner. A label without an answer, or an answer for no label, is refused by name: a change nobody asked about
    is neither a miss nor a clean control. Reads nothing but its arguments and calls no model; the exit metric
    (recall against the plain-model arm) is measured later on DEV with this hook.
    """
    from .tool_registry import GovernanceError

    known = {str(label["id"]) for label in labels}
    unanswered, unknown = sorted(known - set(responses)), sorted(set(responses) - known)
    if unanswered or unknown:
        raise GovernanceError(f"zoo_scoring_ids_disagree: no answer for {unanswered}; answers for no label {unknown}")
    score = _score_known_defects(_zoo_cases(labels), _zoo_reports(responses), ZOO_LINE_WINDOW)
    hits, misses = [case["subject_ref"] for case, _ in score.hits], [case["subject_ref"] for case, _ in score.misses]
    false_alarms = [case["subject_ref"] for case in score.alarmed]
    recall = _proportion(len(hits), len(hits) + len(misses))
    false_alarm = _proportion(len(false_alarms), len(score.clean))
    return {
        "defects": {"n": len(hits) + len(misses), "hits": hits, "misses": misses, "recall": recall["rate"], "wilson": recall["wilson"]},
        "controls": {"n": len(score.clean), "false_alarms": false_alarms, "rate": false_alarm["rate"], "wilson": false_alarm["wilson"]},
    }


def _parse_stamp(value: Any) -> datetime | None:
    try:
        moment = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=timezone.utc)


def adapter_fitness_blocker(
    tool_id: str,
    *,
    base_dir: str | Path | None = None,
    now: datetime | None = None,
) -> str | None:
    """Why an autonomous lane may not promote ``tool_id`` on its measured
    fitness, or None when it may.

    The newest fitness report must measure the tool (``fitness_unmeasured``
    otherwise), be no older than the tool's freshness window and describe
    its current version, manifest and active goldset (``fitness_stale``),
    and put its precision at or above its ``precision_min``
    (``fitness_below_threshold``). The retention rate (``recall``) is reported
    beside it and not gated: no retention floor has been set for any adapter.
    """
    from .fitness import list_fitness_reports
    from .fixture_runner import tool_manifest_hash
    from .goldset import load_active_goldset
    from .tool_registry import DEFAULT_HEALTH_THRESHOLDS, effective_freshness_window_hours, get_tool

    tool = get_tool(tool_id, base_dir)
    reports = list_fitness_reports(base_dir=base_dir)
    if not reports:
        return f"{FITNESS_UNMEASURED}:no_fitness_report"
    latest = reports[-1]
    row = ((latest.get("role_fitness") or {}).get("adapters") or {}).get(tool_id) or {}
    if row.get("status") != MEASURED:
        return f"{FITNESS_UNMEASURED}:{row.get('status') or 'tool_not_in_report'}"
    recorded = _parse_stamp(latest.get("recorded_at"))
    current = now or datetime.now(timezone.utc)
    goldset = load_active_goldset(tool_id=tool_id, base_dir=base_dir)
    if (
        recorded is None
        or current - recorded > timedelta(hours=effective_freshness_window_hours(tool))
        or row.get("tool_version") != tool.get("version")
        or row.get("tool_manifest_hash") != tool_manifest_hash(tool)
        or not goldset
        or row.get("goldset_hash") != goldset_hash(goldset)
    ):
        return FITNESS_STALE
    floor = float((tool.get("health_thresholds") or {}).get("precision_min", DEFAULT_HEALTH_THRESHOLDS["precision_min"]))
    if float(row["precision"]) < floor:
        return f"{FITNESS_BELOW_THRESHOLD}:precision={row['precision']}<{floor}"
    return None


__all__ = [
    "DEV_CHECK",
    "DEV_TRAIN",
    "FITNESS_BELOW_THRESHOLD",
    "FITNESS_STALE",
    "FITNESS_UNMEASURED",
    "GOLD_LINE_WINDOW",
    "MEASURED",
    "ROLE_FITNESS_SCHEMA",
    "UNMEASURED_NO_CANARY_CORPUS",
    "UNMEASURED_NO_CANARY_VERDICTS",
    "UNMEASURED_NO_DISCOVERY_CASES",
    "UNMEASURED_NO_GOLDSET",
    "UNMEASURED_NO_LABELLED_EMISSION",
    "UNMEASURED_NO_OK_RUN",
    "UNMEASURED_NO_REPLAY_VERDICT",
    "ZOO_LINE_WINDOW",
    "adapter_fitness_blocker",
    "dev_split",
    "feed_dev_misses",
    "goldset_hash",
    "measure_discovery_recall",
    "measure_role_fitness",
    "score_zoo_discovery",
]
