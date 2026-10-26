"""PV R9 — the aria/state plan-ledger replay fixture: its derivation, its header, its regeneration.

``tests/test_plan_verdict_replay.py`` replays the 18 plans that CONVERGED on
``origin/aria/state`` @ 8e39b2eeb through the plan-verdict law. Those 18 plans
are rows of ARIA's own plan ledger (``tools/plans/events.jsonl``, 367 events,
42 plans, 32 evaluations); this module is the one place that turns that ledger
into the committed fixture, so the fixture has an owner, a recipe and a check
instead of being a blob nobody can re-derive.

WHAT IS KEPT. For every plan whose ledger holds a ``plan_evaluated`` event with
``terminal_state == "CONVERGED"``: the events up to and including that
evaluation (what the old kernel folded when it judged the round; the events
after it — implementation delivery, merges — are not read by any verdict law).
Each event is projected to the fields the replay reads (``_PROJECTIONS``): the
fold ``plan_convergence._apply_event`` and the cross-review gate
``_evaluate_cross_review_state`` read the ids, severities, directions,
verdicts, task statuses, claims and coverage verdicts; the replay's old-law
reference also reads a risk's summary (it asks whether a masked risk was a NEW
objection). Everything else — plan bodies, challenger plans, recommendations,
evidence refs, hashes of the ledger chain, timestamps, agents — is cut. A
revision's body is reduced to the ``key_changes`` that prescribe imports,
because the prescribed-imports gate reads exactly that.

WHAT PROVES THE CUT IS LOSSLESS FOR THE REPLAY. :func:`assert_projection_is_lossless`
folds the RAW events and the PROJECTED events of every plan with the kernel's
own fold and judges the round with the kernel's own gate; the two must agree
on every risk row's id and severity, the claims, the dispositions and the
whole decision. It runs in every derivation, so a ledger or a law that makes
the cut lossy stops the regeneration instead of producing a fixture that
replays something else.

WHAT KEEPS PERSONAL DATA, SECRETS AND TENANT DATA OUT. :func:`scan_for_sensitive_data`
runs on the fixture text in every derivation (the write is refused on a hit)
and again in the replay test on the committed bytes. ARIA's own redaction
marker (``<secret-redacted>``) is the one token it passes: the value behind it
was withheld by the ledger's writer and is not in the fixture.

REGENERATE (read-only against the state branch; writes only the two files named
below) or CHECK that the committed files are what the state sha derives::

    cd aria-kernel && python3 -m tests._helpers.plan_verdict_replay_fixture --write
    cd aria-kernel && python3 -m tests._helpers.plan_verdict_replay_fixture --check

The fixture directory is byte-pinned by the format-scope law
(``aria-kernel-fixture-capture``): a changed state sha is a NEW pair of files
named by that sha, never an edit of these.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable

_REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES_DIR = Path(__file__).resolve().parents[1] / "fixtures"

STATE_BRANCH = "aria/state"
STATE_SHA = "8e39b2eebd8ef97a00aebd14675cdbb27a9f72cd"
LEDGER_PATH = "tools/plans/events.jsonl"
FIXTURE_NAME = f"plan-verdict-replay-aria-state-{STATE_SHA[:9]}.json"
HEADER_NAME = f"plan-verdict-replay-aria-state-{STATE_SHA[:9]}.header.json"
GENERATOR = "aria-kernel/tests/_helpers/plan_verdict_replay_fixture.py"

# The old law's own cap: the 2026-10-16 evaluations recorded ``max_rounds: 2``.
RECORDED_CAP_GATE = "max_rounds"
REDACTION_MARKER = "<secret-redacted>"

Event = dict[str, Any]


def _risk(risk: dict[str, Any]) -> dict[str, Any]:
    return {key: risk[key] for key in ("risk_id", "severity", "summary") if key in risk}


def _gate_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [row for row in rows if row.get("gate") in {"material_cross_review_zero", RECORDED_CAP_GATE}]


def _revision_body(content: Any) -> str:
    """The revision body the prescribed-imports gate reads: key changes that prescribe imports."""
    body = json.loads(content) if isinstance(content, str) else content
    changes = (body or {}).get("key_changes") or []
    kept = [
        {"id": change.get("id"), "imports": [
            {"specifier": entry.get("specifier"), "from_path": entry.get("from_path")}
            for entry in change["imports"] if isinstance(entry, dict)
        ]}
        for change in changes if isinstance(change, dict) and isinstance(change.get("imports"), list)
    ]
    return json.dumps({"key_changes": kept}, sort_keys=True, separators=(",", ":"))


def _import_resolution(block: dict[str, Any]) -> dict[str, Any]:
    kept = {key: block[key] for key in ("verdict", "target_revision_id", "target_plan_content_hash") if key in block}
    return {**kept, "synthetic_risks": [_risk(risk) for risk in block.get("synthetic_risks", [])]}


# event_type -> payload projection: the fields the replay reads, nothing else.
_PROJECTIONS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "plan_started": lambda p: {
        "initial_revision_id": p["initial_revision_id"], "content_hash": p["content_hash"],
        "plan_content": {"schema_version": (p.get("plan_content") or {}).get("schema_version")},
    },
    "challenger_plan_drafted": lambda p: {
        key: p[key] for key in
        ("challenger_revision_id", "content_hash", "source_revision_id", "source_plan_content_hash")
    },
    "cross_review_tasks_requested": lambda p: {
        "round_number": p["round_number"], "target_revision_id": p["target_revision_id"],
        "target_plan_content_hash": p["target_plan_content_hash"],
        "replaces_task_ids": list(p.get("replaces_task_ids", [])),
        "tasks": [
            {key: task[key] for key in ("task_id", "task_packet_hash", "review_direction", "status_after")}
            for task in p["tasks"]
        ],
    },
    "cross_review_recorded": lambda p: {
        **{key: p[key] for key in (
            "target_revision_id", "target_plan_content_hash", "task_packet_hash", "status_after",
            "review_direction", "verdict",
        )},
        "risks": [_risk(risk) for risk in p["risks"]],
    },
    "coverage_computed": lambda p: {
        "round_number": p["round_number"], "target_revision_id": p["target_revision_id"],
        "verdict": p["verdict"], "synthetic_risks": [_risk(risk) for risk in p.get("synthetic_risks", [])],
        **({"import_resolution": _import_resolution(p["import_resolution"])} if "import_resolution" in p else {}),
    },
    "revision_recorded": lambda p: {
        "revision_id": p["revision_id"], "content_hash": p["content_hash"], "round": p["round"],
        "addresses_review_risk_ids": list(p.get("addresses_review_risk_ids", [])),
        "content": _revision_body(p["content"]),
    },
    "plan_evaluated": lambda p: {
        "round_number": p["round_number"], "terminal_state": p["terminal_state"],
        "reason_codes": list(p["reason_codes"]), "risks_rollup_summary": p["risks_rollup_summary"],
        "gate_decisions": _gate_rows(p["gate_decisions"]),
    },
}

def read_ledger(ref: str = STATE_SHA, *, repo_root: Path = _REPO_ROOT) -> str:
    """The plan ledger as ``ref`` holds it (``git show``: read-only, nothing is fetched or written)."""
    return subprocess.run(
        ["git", "-C", str(repo_root), "show", f"{ref}:{LEDGER_PATH}"],
        check=True, capture_output=True, text=True,
    ).stdout


def parse_ledger(ledger_text: str) -> list[Event]:
    return [json.loads(line) for line in ledger_text.splitlines() if line.strip()]


def converged_plans(rows: list[Event]) -> list[tuple[str, list[tuple[int, Event]]]]:
    """(plan id, [(ledger line, event)] up to and including the plan's CONVERGED evaluation), in ledger order."""
    by_plan: dict[str, list[tuple[int, Event]]] = {}
    for line, row in enumerate(rows, start=1):
        by_plan.setdefault(row["plan_id"], []).append((line, row))
    selected = []
    for plan_id, events in by_plan.items():
        cut = next(
            (index for index, (_, row) in enumerate(events)
             if row["event_type"] == "plan_evaluated" and row["payload"]["terminal_state"] == "CONVERGED"),
            None,
        )
        if cut is not None:
            selected.append((plan_id, events[: cut + 1]))
    return selected


def project_event(line: int, row: Event) -> Event:
    project = _PROJECTIONS.get(row["event_type"])
    if project is None:
        raise ValueError(
            f"ledger line {line}: no projection for event type {row['event_type']!r}; the replay folds only "
            f"{sorted(_PROJECTIONS)} before a CONVERGED evaluation"
        )
    return {"ledger_line": line, "event_type": row["event_type"], "plan_id": row["plan_id"],
            "payload": project(row["payload"])}


def derive_plans(rows: list[Event]) -> list[dict[str, Any]]:
    return [
        {"plan_id": plan_id, "events": [project_event(line, row) for line, row in events]}
        for plan_id, events in converged_plans(rows)
    ]


def _fold(plan_id: str, events: list[Event]) -> dict[str, Any]:
    from aria_kernel import plan_convergence as pc

    state = pc._initial_state(plan_id)
    for event in copy.deepcopy(events):
        pc._apply_event(state, event)
    pc._derive_state(state)
    return state


def _judged(state: dict[str, Any], round_number: int, cap: int) -> dict[str, Any]:
    from aria_kernel import plan_convergence as pc

    return pc._evaluate_cross_review_state(state, round_number, max_rounds=cap)


def _replay_view(state: dict[str, Any]) -> dict[str, Any]:
    """What the replay reads of a fold: risk ids and severities per round, claims, answers, state."""
    return {
        "state": state["state"], "current_round": state["current_round"],
        "risks": {
            round_number: [(risk.get("risk_id"), risk.get("severity")) for risk in risks]
            for round_number, risks in sorted(state["cross_review_risks_by_round"].items())
        },
        "claims": state["review_risk_claims"], "dispositions": state["review_risk_dispositions"],
        "resolved": state["resolved_review_risk_ids"],
    }


def assert_projection_is_lossless(rows: list[Event], plans: list[dict[str, Any]]) -> None:
    """The kernel's fold and gate judge the projected events exactly as they judge the raw ones.

    The raw side is the recorded ledger; the projected side is what the fixture
    holds. Any difference means a field the replay reads was cut.
    """
    from aria_kernel import plan_convergence as pc

    raw_by_plan = dict(converged_plans(rows))
    for plan in plans:
        plan_id = plan["plan_id"]
        raw_events = [row for _, row in raw_by_plan[plan_id]]
        evaluated = raw_events[-1]["payload"]
        caps = {
            next(row["max_rounds"] for row in evaluated["gate_decisions"] if row["gate"] == RECORDED_CAP_GATE),
            pc.MAX_CROSS_REVIEW_ROUNDS,
        }
        raw, cut = _fold(plan_id, raw_events[:-1]), _fold(plan_id, plan["events"][:-1])
        if _replay_view(raw) != _replay_view(cut):
            raise AssertionError(f"{plan_id}: the projection changed the fold the replay reads")
        for cap in sorted(caps):
            if _judged(raw, evaluated["round_number"], cap) != _judged(cut, evaluated["round_number"], cap):
                raise AssertionError(f"{plan_id}: the projection changed the verdict at max_rounds={cap}")


_SENSITIVE: dict[str, re.Pattern[str]] = {
    "email address": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"),
    "uuid (tenant or user id)": re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I),
    "tenant schema": re.compile(r"\btenant_[0-9a-f]{8}", re.I),
    "ipv4 address": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    "github token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "api key": re.compile(r"\b(?:sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})"),
    "jwt": re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\."),
    "private key": re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "bearer credential": re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}"),
    "credential assignment": re.compile(r"\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*[\"']?[A-Za-z0-9/+_.-]{6,}", re.I),
    "operator or maintainer name": re.compile(r"\b(?:okan|ozturk|öztürk|rekdal|suderra)\b", re.I),
}


def scan_for_sensitive_data(text: str) -> list[str]:
    """One finding per sensitive pattern the text matches (empty: clean)."""
    scrubbed = text.replace(REDACTION_MARKER, "")
    return [
        f"{label}: {match.group(0)[:40]!r}"
        for label, pattern in _SENSITIVE.items() for match in pattern.finditer(scrubbed)
    ]


def render_fixture(plans: list[dict[str, Any]]) -> str:
    """The fixture text: one compact event per line, so a diff and a grep read one event at a time."""
    def compact(value: Any) -> str:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)

    blocks = []
    for plan in plans:
        events = ",\n".join(f"    {compact(event)}" for event in plan["events"])
        blocks.append(f'  {{"plan_id": {compact(plan["plan_id"])}, "events": [\n{events}\n  ]}}')
    return '{\n "header": ' + compact(HEADER_NAME) + ',\n "plans": [\n' + ",\n".join(blocks) + "\n ]\n}\n"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def build_header(ledger_text: str, rows: list[Event], plans: list[dict[str, Any]], fixture_text: str) -> dict[str, Any]:
    evaluations = [row for row in rows if row["event_type"] == "plan_evaluated"]
    return {
        "fixture": FIXTURE_NAME,
        "fixture_sha256": _sha256(fixture_text),
        "fixture_bytes": len(fixture_text.encode("utf-8")),
        "purpose": (
            "PV R9: replay the plans CONVERGED on aria/state through the plan-verdict law "
            "(finding ARIA-HIGH-779): under the old law each hid a new material risk behind the plan "
            "author's claim; under PV's law none converges."
        ),
        "source": {
            "branch": STATE_BRANCH, "sha": STATE_SHA, "path": LEDGER_PATH,
            "ledger_sha256": _sha256(ledger_text), "ledger_bytes": len(ledger_text.encode("utf-8")),
            "ledger_events": len(rows), "ledger_plans": len({row["plan_id"] for row in rows}),
            "ledger_evaluations": len(evaluations),
            "ledger_converged_evaluations": sum(1 for row in evaluations if row["payload"]["terminal_state"] == "CONVERGED"),
        },
        "selection": (
            "every plan whose ledger holds a plan_evaluated event with terminal_state CONVERGED; "
            "its events up to and including that evaluation, in ledger order, each tagged with its 1-based "
            "line in the source ledger (ledger_line)"
        ),
        "plans": len(plans),
        "events": sum(len(plan["events"]) for plan in plans),
        "projection": (
            "per event type, only the payload fields the replay reads; the generator's _PROJECTIONS table is the "
            "list. Cut everywhere: ledger hash chain, idempotency keys, schema versions, timestamps, agent names, "
            "plan and challenger bodies, risk recommendations, affected files and evidence refs, coverage "
            "manifests and witnesses, implementation-phase events."
        ),
        "checks_run_at_derivation": [
            "assert_projection_is_lossless: the kernel's fold and cross-review gate judge the raw and the "
            "projected events of every plan identically (risk ids and severities, claims, dispositions, "
            "decision) at the recorded cap and at the kernel default",
            "scan_for_sensitive_data: no email, uuid, tenant schema, ip address, token, key, credential "
            "assignment or operator name in the fixture text",
        ],
        "data": (
            "ARIA plan and risk records only: reviewer risk ids, severities and one-line summaries about "
            "repository code. No tenant data, no secrets, no personal data. ARIA's own redaction marker "
            f"{REDACTION_MARKER} appears where the ledger's writer already withheld a value."
        ),
        "generator": GENERATOR,
        "regenerate": "cd aria-kernel && python3 -m tests._helpers.plan_verdict_replay_fixture --write",
        "check": "cd aria-kernel && python3 -m tests._helpers.plan_verdict_replay_fixture --check",
        "replayed_by": "aria-kernel/tests/test_plan_verdict_replay.py",
        "committed_on": (
            "the operator's 2026-10-25 decision to commit the replay fixture as a test "
            "(ARIA quality and learning program v2)"
        ),
    }


def render_header(header: dict[str, Any]) -> str:
    return json.dumps(header, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def derive(ledger_text: str) -> tuple[str, str]:
    """(fixture text, header text) for a ledger; refuses a cut that is lossy or text that is sensitive."""
    rows = parse_ledger(ledger_text)
    plans = derive_plans(rows)
    assert_projection_is_lossless(rows, plans)
    fixture_text = render_fixture(plans)
    findings = scan_for_sensitive_data(fixture_text)
    if findings:
        raise ValueError("the fixture text holds sensitive data and is not written: " + "; ".join(findings))
    return fixture_text, render_header(build_header(ledger_text, rows, plans, fixture_text))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="derive from the state sha and write both files")
    mode.add_argument("--check", action="store_true", help="derive from the state sha and compare with the committed files")
    args = parser.parse_args(argv)
    fixture_text, header_text = derive(read_ledger())
    fixture_path, header_path = FIXTURES_DIR / FIXTURE_NAME, FIXTURES_DIR / HEADER_NAME
    if args.write:
        fixture_path.write_text(fixture_text, encoding="utf-8")
        header_path.write_text(header_text, encoding="utf-8")
        print(f"wrote {fixture_path.name} ({len(fixture_text)} chars) and {header_path.name}")
        return 0
    drifted = [
        path.name for path, text in ((fixture_path, fixture_text), (header_path, header_text))
        if not path.is_file() or path.read_text(encoding="utf-8") != text
    ]
    if drifted:
        print(f"drift from {STATE_BRANCH}@{STATE_SHA[:9]}: {', '.join(drifted)}", file=sys.stderr)
        return 1
    print(f"{FIXTURE_NAME} and {HEADER_NAME} match {STATE_BRANCH}@{STATE_SHA[:9]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
