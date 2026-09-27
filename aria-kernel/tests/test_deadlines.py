"""ARIA-MEDIUM-128 — a deadline the kernel enforces is announced seven days ahead.

Eight dormant-surface waivers lapsed on 2026-09-13 and every kernel lane on
main was red the next morning; a HUMAN_REQUIRED record past its SLA and a
registry finding due tomorrow were equally silent in `aria-kernel doctor`.
These pins hold the one reader (`deadlines.read_deadlines`) and its three
consumers — the doctor's `deadlines` organ, the daily report's `## Deadlines`
section and the `deadline_due` self-improvement signal — to one clock: the
clock of the gate that will enforce each deadline.

The kernel enforces THREE dated waiver manifests, not one
(`surface_waivers.WAIVER_MANIFESTS`: surface-reachability, control-
reachability, batch-containment). The first cut of this lane read only the
surface manifest while six control waivers sat dated 2026-09-20 — the lanes
would have gone red on the 21st with the organ silent, the defect this
lane was opened for, wearing another manifest's name. `EveryKernelWaiverManifest`
pins the registry to the source list and every gate to the one reader.

A pin that walks `WAIVER_MANIFESTS` can only open the gates the registry
already names, and the gate that forgot to register is the one it never
opens: a fourth gate with a `json.loads` and a `fromisoformat` of its own
over a fourth manifest passed every pin here (round-3 verifier, M6).
`UnregisteredWaiverManifests` closes that from three sides — the reader
refuses a spec outside the registry at run time, every Python module under
`aria-kernel/tests/` is walked by AST for a dated-waiver gate with a parser
or a clock of its own, and every dated manifest file under `aria-kernel/`
must be one a registered spec names.
"""
from __future__ import annotations

import ast
import dataclasses
import json
import tempfile
import unittest
from datetime import datetime, time, timedelta, timezone
from pathlib import Path
from unittest import mock

from aria_kernel import deadlines, doctor, reflection, surface_waivers
from aria_kernel.deadlines import (
    BATCH_CONTAINMENT_WAIVER,
    CONTROL_WAIVER,
    DEADLINE_SOURCES,
    DEADLINE_WARNING_DAYS,
    HUMAN_REQUIRED_SLA,
    REGISTRY_FINDING,
    SURFACE_WAIVER,
    read_deadlines,
    render_deadlines_markdown,
    signal_priority,
)
from aria_kernel.human_required import record_human_required
from aria_kernel.self_improvement import SIGNAL_KINDS, scan_signals
from aria_kernel.surface_waivers import (
    BATCH_CONTAINMENT_MANIFEST,
    DORMANT_CONTROL_MANIFEST,
    REGISTER_IN_WAIVER_MANIFESTS,
    UNWRITTEN_MANIFEST,
    WAIVER_MANIFESTS,
    ManifestShape,
    WaiverManifest,
)
from aria_kernel.tool_registry import ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL_DIR = _REPO_ROOT / "aria-kernel"
_KERNEL_TESTS = _KERNEL_DIR / "tests"
# The file-name family every registered manifest belongs to
# (`surface_waivers.WAIVER_MANIFESTS[*].relpath`); a string constant that
# ends in one of these is a manifest path, wherever the module keeps it.
_MANIFEST_FILE_SUFFIXES = (".waivers.json", ".dormant.json", ".unwritten.json")


def _registered_gate_files() -> set[Path]:
    """The test modules the registry names as enforcers — the only modules
    that may read a manifest, and they read it through `surface_waivers`."""
    return {(_KERNEL_DIR / manifest.enforced_by.split("::")[0]).resolve() for manifest in WAIVER_MANIFESTS}


def _imported_names(tree: ast.AST, module: str) -> set[str]:
    """Every name a module binds from `from <module> import …`, by its local
    name — the name a call site uses."""
    return {
        alias.asname or alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == module
        for alias in node.names
    }


def _own_parser_and_clock_calls(tree: ast.AST) -> list[str]:
    """Every call by which a module could read a manifest or judge a date
    without `surface_waivers`: `json.load`/`json.loads` (whatever the module
    calls the json module or the function), any `fromisoformat` or
    `strptime`, and `date.today()`/`datetime.today()`. By AST over `Call`
    nodes, never by grep — the gates' docstrings mention json and dates."""
    json_modules = {"json"} | {
        alias.asname or alias.name
        for node in ast.walk(tree) if isinstance(node, ast.Import)
        for alias in node.names if alias.name == "json"
    }
    json_functions = {name for name in _imported_names(tree, "json") if name in {"load", "loads"}}
    clock_classes = {"date", "datetime"} | _imported_names(tree, "datetime")
    found: list[str] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Attribute):
            owner = func.value.id if isinstance(func.value, ast.Name) else None
            if func.attr in {"load", "loads"} and owner in json_modules:
                found.append(f"{owner}.{func.attr} at line {node.lineno}")
            elif func.attr in {"fromisoformat", "strptime"}:
                found.append(f"{func.attr} at line {node.lineno}")
            elif func.attr == "today" and owner in clock_classes:
                found.append(f"{owner}.today at line {node.lineno}")
        elif isinstance(func, ast.Name) and func.id in json_functions:
            found.append(f"json.{func.id} at line {node.lineno}")
    return found


def _dated_waiver_evidence(tree: ast.AST) -> list[str]:
    """Why a module is taken to handle dated waivers: it names the
    `expires_on` field, a manifest path of the registered family, or binds
    the shared field tuple (the two registered gates that never spell the
    field name reach it through `REQUIRED_WAIVER_FIELDS`)."""
    evidence: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if node.value == "expires_on":
                evidence.add("'expires_on'")
            elif node.value.endswith(_MANIFEST_FILE_SUFFIXES):
                evidence.add(repr(node.value))
    if "REQUIRED_WAIVER_FIELDS" in _imported_names(tree, "aria_kernel.surface_waivers"):
        evidence.add("REQUIRED_WAIVER_FIELDS")
    return sorted(evidence)


def _manifest_spec_constructions(tree: ast.AST) -> list[str]:
    """`WaiverManifest(...)` calls: a spec built outside the registry."""
    return [
        f"WaiverManifest(...) at line {node.lineno}"
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and (
            (isinstance(node.func, ast.Name) and node.func.id == "WaiverManifest")
            or (isinstance(node.func, ast.Attribute) and node.func.attr == "WaiverManifest")
        )
    ]


def _carries_dated_entries(loaded: object) -> bool:
    """Whether a parsed JSON document is a dated waiver manifest in either
    registered shape: FLAT name → entry or NESTED surface → member → entry,
    an entry being an object that carries `expires_on`."""
    if not isinstance(loaded, dict):
        return False
    for value in loaded.values():
        if not isinstance(value, dict):
            continue
        if "expires_on" in value:
            return True
        if any(isinstance(entry, dict) and "expires_on" in entry for entry in value.values()):
            return True
    return False


def _day(offset: int, now: datetime) -> str:
    return (now + timedelta(days=offset)).date().isoformat()


class _Fixture(unittest.TestCase):
    """A store and a checkout with the two committed sources present and empty."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.tools = self.root / "store" / "tools"
        ensure_tools_dir(self.tools)
        self.ws = self.root / "checkout"
        self.now = datetime(2026, 9, 14, 12, 0, tzinfo=timezone.utc)
        self.write_waivers({})
        self.write_registry([])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def write_manifest(self, manifest: WaiverManifest, payload: dict | str) -> None:
        """One registered manifest, at the path the one reader resolves it to."""
        path = surface_waivers.waiver_manifest_path(self.ws, manifest)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(payload if isinstance(payload, str) else json.dumps(payload), encoding="utf-8")

    def write_waivers(self, manifest: dict | str) -> None:
        self.write_manifest(UNWRITTEN_MANIFEST, manifest)

    def write_registry(self, findings: list[dict]) -> None:
        path = self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(row) + "\n" for row in findings), encoding="utf-8")

    def waiver(self, expires_on: str) -> dict:
        return {"tool_registry_status": {"ARCHIVED": {
            "owner": "okan", "reason": "r", "expires_on": expires_on, "finding_id": "ORPHAN-MEDIUM-691",
        }}}

    def organ(self) -> doctor.DoctorCheck:
        with mock.patch.object(deadlines, "datetime", _FrozenClock(self.now)):
            return doctor._check_deadlines(self.tools, self.ws)


class _FrozenClock:
    """`deadlines.datetime` with `now()` pinned; everything else is the real class."""

    def __init__(self, moment: datetime) -> None:
        self._moment = moment

    def now(self, tz: timezone | None = None) -> datetime:
        return self._moment if tz is None else self._moment.astimezone(tz)

    def __getattr__(self, name: str):
        return getattr(datetime, name)


class WaiverDeadlines(_Fixture):
    def test_a_waiver_due_in_five_days_is_a_warn_naming_it_and_the_days(self) -> None:
        self.write_waivers(self.waiver(_day(5, self.now)))
        check = self.organ()
        self.assertEqual(check.status, "warn")
        self.assertEqual(check.reason, "deadlines_due:1:tool_registry_status.ARCHIVED(+5d)")
        self.assertEqual(check.detail["due_soon"][0]["kind"], SURFACE_WAIVER)

    def test_a_lapsed_waiver_is_a_fail_naming_it(self) -> None:
        self.write_waivers(self.waiver(_day(-1, self.now)))
        check = self.organ()
        self.assertEqual(check.status, "fail")
        self.assertEqual(check.reason, "deadlines_lapsed:1:tool_registry_status.ARCHIVED(-1d)")

    def test_a_waiver_is_honoured_through_its_own_day_like_the_gate(self) -> None:
        """The gate's predicate is `expires_on < today`: on the day itself the
        waiver holds. The organ says due today (+0d), not lapsed."""
        self.write_waivers(self.waiver(_day(0, self.now)))
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("warn", "deadlines_due:1:tool_registry_status.ARCHIVED(+0d)"))
        manifest = surface_waivers.load_waiver_manifest(self.ws)
        self.assertEqual(surface_waivers.lapsed_waivers(manifest, today=self.now.date()), [])
        self.write_waivers(self.waiver(_day(-1, self.now)))
        manifest = surface_waivers.load_waiver_manifest(self.ws)
        self.assertEqual(
            surface_waivers.lapsed_waivers(manifest, today=self.now.date()),
            [f"tool_registry_status.ARCHIVED (expired {_day(-1, self.now)}, ORPHAN-MEDIUM-691)"],
        )
        self.assertEqual(self.organ().status, "fail")

    def test_the_organ_reads_the_manifest_through_the_gates_reader(self) -> None:
        """The organ resolves the manifest through `surface_waivers.
        load_waiver_manifest` — the function every gate imports (pinned by
        AST in `EveryKernelWaiverManifest`) — so a reader that went around it
        would not see the date this patch plants."""
        self.write_waivers(self.waiver(_day(30, self.now)))
        self.assertEqual(self.organ().status, "ok")

        def only_the_surface_manifest(repo_root: Path, manifest: WaiverManifest = UNWRITTEN_MANIFEST) -> dict:
            return self.waiver(_day(-2, self.now)) if manifest is UNWRITTEN_MANIFEST else {}

        with mock.patch.object(surface_waivers, "load_waiver_manifest", side_effect=only_the_surface_manifest):
            self.assertEqual(self.organ().reason, "deadlines_lapsed:1:tool_registry_status.ARCHIVED(-2d)")

    def test_a_malformed_manifest_is_undecided_by_name_never_ok(self) -> None:
        self.write_waivers("{not json")
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("fail", "deadlines_undecided:surface_waiver:JSONDecodeError"))
        self.write_waivers('{"surface": "not-an-object"}')
        self.assertEqual(self.organ().reason, "deadlines_undecided:surface_waiver:TypeError")
        with self.assertRaises(TypeError):
            surface_waivers.load_waiver_manifest(self.ws)


class HumanRequiredDeadlines(_Fixture):
    def test_a_record_past_its_sla_is_a_fail_by_id(self) -> None:
        record_human_required(request_id="AIR-late", severity="HIGH", reason="late", base_dir=self.tools,
                              now=self.now - timedelta(hours=72 + 30))
        check = self.organ()
        self.assertEqual(check.status, "fail")
        self.assertEqual(check.reason, "deadlines_lapsed:1:AIR-late(-2d)")
        self.assertEqual(check.detail["lapsed"][0]["kind"], HUMAN_REQUIRED_SLA)

    def test_a_record_inside_the_window_is_a_warn_and_outside_it_is_ok(self) -> None:
        record_human_required(request_id="AIR-soon", severity="MEDIUM", reason="r", base_dir=self.tools, now=self.now)
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("warn", "deadlines_due:1:AIR-soon(+7d)"))
        record_human_required(request_id="AIR-later", severity="LOW", reason="r", base_dir=self.tools, now=self.now)
        check = self.organ()
        self.assertEqual(check.reason, "deadlines_due:1:AIR-soon(+7d)", "a 14-day SLA is outside the window")
        self.assertEqual(check.detail["tracked"], 2)

    def test_a_resolved_record_carries_no_deadline(self) -> None:
        from aria_kernel.human_required import resolve_human_required

        record_human_required(request_id="AIR-done", severity="HIGH", reason="r", base_dir=self.tools,
                              now=self.now - timedelta(days=10))
        resolve_human_required(request_id="AIR-done", resolution_note="done", base_dir=self.tools)
        self.assertEqual(self.organ().status, "ok")


class RegistryDeadlines(_Fixture):
    def test_an_open_finding_due_within_seven_days_is_a_warn_by_id(self) -> None:
        self.write_registry([
            {"id": "SENSOR-CRITICAL-108", "state": "OPEN", "severity": "CRITICAL", "deadline": _day(3, self.now)},
            {"id": "ARIA-HIGH-064", "state": "IN-PROGRESS", "severity": "HIGH", "deadline": _day(20, self.now)},
        ])
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("warn", "deadlines_due:1:SENSOR-CRITICAL-108(+2d)"))
        self.assertEqual(check.detail["due_soon"][0]["kind"], REGISTRY_FINDING)
        self.assertEqual(check.detail["tracked"], 2)

    def test_a_lapsed_finding_is_named_as_swept_information_not_a_fault(self) -> None:
        """The daily sweep (`finding-registry.ts planSweep`) plans a lapsed
        finding to BLOCKED in a sweep PR that lands only when merged; the
        doctor names the row and stays out of FAIL — 132 registry deadlines
        had lapsed the day this organ was written, and an organ red for a
        quarter is the always-burning class."""
        self.write_registry([{"id": "INFRA-CRITICAL-029", "state": "OPEN", "severity": "CRITICAL", "deadline": _day(-100, self.now)}])
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("warn", "deadlines_lapsed_swept:1:INFRA-CRITICAL-029(-101d)"))
        self.assertFalse(check.detail["lapsed"][0]["lapse_is_fault"])

    def test_a_finding_lapses_at_the_start_of_its_day_like_the_sweep(self) -> None:
        # planSweep: `new Date("YYYY-MM-DD") < now` — UTC midnight of that day.
        self.write_registry([{"id": "X-LOW-001", "state": "OPEN", "deadline": _day(0, self.now)}])
        self.assertEqual(self.organ().reason, "deadlines_lapsed_swept:1:X-LOW-001(-1d)")

    def test_resolved_and_blocked_findings_carry_no_pending_deadline(self) -> None:
        self.write_registry([
            {"id": "A-LOW-001", "state": "RESOLVED", "deadline": _day(-5, self.now)},
            {"id": "B-LOW-002", "state": "BLOCKED", "deadline": _day(-5, self.now)},
            {"id": "C-LOW-003", "state": "OPEN"},
        ])
        check = self.organ()
        self.assertEqual((check.status, check.detail["tracked"]), ("ok", 0))

    def test_an_absent_or_malformed_registry_is_undecided_by_name(self) -> None:
        self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH).unlink()
        self.assertEqual(self.organ().reason, "deadlines_undecided:registry_finding:FileNotFoundError")
        self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH).write_text('{"id": "x"\n', encoding="utf-8")
        self.assertEqual(self.organ().reason, "deadlines_undecided:registry_finding:JSONDecodeError")

    def test_an_undecided_source_does_not_hide_the_others(self) -> None:
        self.ws.joinpath(*deadlines.REGISTRY_FINDINGS_RELPATH).unlink()
        self.write_waivers(self.waiver(_day(-1, self.now)))
        check = self.organ()
        self.assertEqual(
            check.reason,
            "deadlines_undecided:registry_finding:FileNotFoundError;deadlines_lapsed:1:tool_registry_status.ARCHIVED(-1d)",
        )

    def test_the_live_registry_is_readable_by_the_organ(self) -> None:
        rows = deadlines.read_registry_deadlines(self.tools, _REPO_ROOT)
        self.assertTrue(rows, "the committed registry carries OPEN findings with deadlines")
        self.assertTrue(all(row.kind == REGISTRY_FINDING and row.due_at.tzinfo for row in rows))


class ReadoutAndConsumers(_Fixture):
    def _seed_all_three(self) -> None:
        self.write_waivers(self.waiver(_day(5, self.now)))
        self.write_registry([{"id": "SENSOR-CRITICAL-108", "state": "OPEN", "deadline": _day(1, self.now)}])
        record_human_required(request_id="AIR-late", severity="HIGH", reason="late", base_dir=self.tools,
                              now=self.now - timedelta(days=5))

    def test_no_checkout_leaves_the_committed_sources_undecided_by_name(self) -> None:
        readout = read_deadlines(tools_dir=self.tools, workspace_root=None, now=self.now)
        self.assertEqual(readout.undecided, (
            "surface_waiver:checkout_unbound",
            "control_waiver:checkout_unbound",
            "batch_containment_waiver:checkout_unbound",
            "registry_finding:checkout_unbound",
        ))
        self.assertEqual(
            [source.kind for source in DEADLINE_SOURCES],
            [SURFACE_WAIVER, CONTROL_WAIVER, BATCH_CONTAINMENT_WAIVER, HUMAN_REQUIRED_SLA, REGISTRY_FINDING],
        )

    def test_rows_come_soonest_first_and_carry_the_enforcer(self) -> None:
        self._seed_all_three()
        readout = read_deadlines(tools_dir=self.tools, workspace_root=self.ws, now=self.now)
        self.assertEqual([row.key for row in readout.rows], ["AIR-late", "SENSOR-CRITICAL-108", "tool_registry_status.ARCHIVED"])
        self.assertEqual([row.key for row in readout.lapsed], ["AIR-late"])
        self.assertEqual([row.key for row in readout.due_soon], ["SENSOR-CRITICAL-108", "tool_registry_status.ARCHIVED"])
        self.assertEqual(readout.warning_days, DEADLINE_WARNING_DAYS)
        self.assertIn("planSweep", readout.rows[1].enforced_by)
        self.assertIn("sweep PR that lands only when merged", readout.rows[1].consequence,
                      "the consequence text must not claim a state change the workflow never pushes")
        self.assertIn("test_a_waiver_expires_against_the_clock", readout.rows[2].enforced_by)

    def test_the_organ_is_registered_in_the_doctor(self) -> None:
        self._seed_all_three()
        with mock.patch.object(deadlines, "datetime", _FrozenClock(self.now)):
            report = doctor.run_doctor(base_dir=self.tools, workspace_root=self.ws)
        organs = {check.name: check for check in report.checks}
        self.assertEqual(organs["deadlines"].status, "fail")
        self.assertEqual(
            organs["deadlines"].reason,
            "deadlines_lapsed:1:AIR-late(-2d);deadlines_due:2:SENSOR-CRITICAL-108(+0d),tool_registry_status.ARCHIVED(+5d)",
        )
        self.assertEqual(report.exit_code, doctor.DOCTOR_EXIT_UNHEALTHY)

    def test_the_daily_report_carries_the_rows(self) -> None:
        """The report ON DISK carries the section — `run_reflection` with the
        checkout bound, the file it writes read back — so a writer that
        rendered the section and dropped it would fail here, not only a
        render helper checked in isolation."""
        self._seed_all_three()
        with mock.patch.object(deadlines, "datetime", _FrozenClock(self.now)):
            reflection.run_reflection(cycle_id="cycle-deadlines", base_dir=self.tools, repo_root=self.ws)
        reports = sorted((self.tools / "reports" / "daily").glob("*.md"))
        self.assertEqual(len(reports), 1, reports)
        lines = reports[0].read_text(encoding="utf-8").splitlines()
        self.assertIn("## Deadlines", lines)
        self.assertIn("- Lapsed: 1", lines)
        self.assertIn("- Due within window: 2", lines)
        self.assertTrue(any(line.startswith("- **LAPSED** human_required_sla AIR-late (-2d") for line in lines), lines)
        self.assertTrue(any(line.startswith("- DUE registry_finding SENSOR-CRITICAL-108 (+0d") for line in lines), lines)
        self.assertTrue(any(line.startswith("- DUE surface_waiver tool_registry_status.ARCHIVED (+5d") for line in lines), lines)
        self.assertLess(lines.index("## HUMAN_REQUIRED"), lines.index("## Deadlines"), "beside HUMAN_REQUIRED, before Coverage")
        self.assertLess(lines.index("## Deadlines"), lines.index("## Coverage"))
        without_checkout = reflection._render_deadlines_section(self.tools, None)
        self.assertTrue(any("UNDECIDED**: surface_waiver:checkout_unbound" in line for line in without_checkout), without_checkout)

    def test_a_report_without_a_readout_still_renders_the_section(self) -> None:
        readout = read_deadlines(tools_dir=self.tools, workspace_root=self.ws, now=self.now)
        self.assertEqual(render_deadlines_markdown(readout)[:6], [
            "## Deadlines", "", "- Warning window: 7 days", "- Tracked: 0", "- Lapsed: 0", "- Due within window: 0",
        ])

    def test_scan_signals_carries_one_deadline_due_signal_per_row(self) -> None:
        self._seed_all_three()
        self.assertIn("deadline_due", SIGNAL_KINDS)
        with mock.patch.object(deadlines, "datetime", _FrozenClock(self.now)):
            signals = {(s.kind, s.key): s for s in scan_signals(base_dir=self.tools, workspace_root=self.ws)}
        late = signals[("deadline_due", "human_required_sla:AIR-late")]
        soon = signals[("deadline_due", "registry_finding:SENSOR-CRITICAL-108")]
        later = signals[("deadline_due", "surface_waiver:tool_registry_status.ARCHIVED")]
        self.assertEqual((late.priority, soon.priority, later.priority), (2, 2, 3))
        self.assertTrue(late.title.startswith("Deadline AIR-late (human_required_sla) lapsed -2d"), late.title)
        self.assertEqual(later.evidence["days_left"], 5)
        self.assertIn(("doctor_fail", "deadlines"), signals, "the lapsed fault also rides the organ's FAIL at priority 1")
        self.assertEqual(signals[("doctor_fail", "deadlines")].priority, 1)

    def test_an_announcement_never_outranks_a_fault(self) -> None:
        row = deadlines.DeadlineRow("k", "x", self.now - timedelta(days=40), "e", "c", True)
        self.assertEqual(signal_priority(row, self.now), 2)
        row = deadlines.DeadlineRow("k", "x", self.now + timedelta(days=6), "e", "c", True)
        self.assertEqual(signal_priority(row, self.now), 3)


class EveryKernelWaiverManifest(_Fixture):
    """Round-2 verifier: the kernel enforced THREE dated waiver manifests and
    the organ read one. `control-reachability.dormant.json` carried six
    waivers dated 2026-09-20 — every kernel lane on main red on the 21st,
    and the organ, the daily report and `scan_signals` silent — because the
    control gate and the batch gate each kept a `json.loads` and a
    `fromisoformat` of their own. These pins hold
    `surface_waivers.WAIVER_MANIFESTS` as the closed registry the source
    list is built from, and every gate it names to the one reader."""

    def test_every_kernel_waiver_manifest_is_a_deadline_source(self) -> None:
        self.assertEqual(
            [source.kind for source in DEADLINE_SOURCES],
            [manifest.kind for manifest in WAIVER_MANIFESTS] + [HUMAN_REQUIRED_SLA, REGISTRY_FINDING],
        )
        self.assertEqual(
            {manifest.kind for manifest in WAIVER_MANIFESTS},
            {"surface_waiver", "control_waiver", "batch_containment_waiver"},
        )
        self.assertEqual(
            (SURFACE_WAIVER, CONTROL_WAIVER, BATCH_CONTAINMENT_WAIVER),
            ("surface_waiver", "control_waiver", "batch_containment_waiver"),
        )
        self.assertTrue(all(source.needs_workspace for source in DEADLINE_SOURCES if source.kind in {m.kind for m in WAIVER_MANIFESTS}))

    def test_a_dormant_control_waiver_is_announced_and_lapses_like_its_gate(self) -> None:
        expires_on = _day(6, self.now)
        self.write_manifest(DORMANT_CONTROL_MANIFEST, {"verify_branch_tip": {
            "owner": "okan", "reason": "r", "expires_on": expires_on, "finding_id": "ORPHAN-HIGH-573",
        }})
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("warn", "deadlines_due:1:verify_branch_tip(+6d)"))
        self.assertEqual(check.detail["due_soon"][0]["kind"], CONTROL_WAIVER)
        self.assertEqual(check.detail["due_soon"][0]["enforced_by"], DORMANT_CONTROL_MANIFEST.enforced_by)
        self.assertIn("ORPHAN-HIGH-573", check.detail["due_soon"][0]["consequence"])
        # The day after `expires_on`: the gate refuses the waiver and the
        # organ names the same waiver lapsed, with the same report line.
        self.now += timedelta(days=7)
        check = self.organ()
        self.assertEqual((check.status, check.reason), ("fail", "deadlines_lapsed:1:verify_branch_tip(-1d)"))
        self.assertTrue(check.detail["lapsed"][0]["lapse_is_fault"])
        loaded = surface_waivers.load_waiver_manifest(self.ws, DORMANT_CONTROL_MANIFEST)
        self.assertEqual(
            surface_waivers.lapsed_waivers(loaded, DORMANT_CONTROL_MANIFEST, today=self.now.date()),
            [f"verify_branch_tip (expired {expires_on}, ORPHAN-HIGH-573)"],
        )
        self.assertEqual(
            surface_waivers.lapsed_waivers(loaded, DORMANT_CONTROL_MANIFEST, today=self.now.date() - timedelta(days=1)),
            [],
            "honoured through its own day, like the gate",
        )

    def test_the_control_and_batch_gates_keep_no_parser_and_no_clock_of_their_own(self) -> None:
        """By AST, not by grep — the gates' docstrings mention json and dates.
        Walks every gate `WAIVER_MANIFESTS` names (the surface gate too), so
        a manifest registered tomorrow binds its gate the day it is added.
        What this cannot see is a gate that never registered — it opens only
        the files the registry names; `UnregisteredWaiverManifests` walks
        every test module for that one."""
        for manifest in WAIVER_MANIFESTS:
            gate = _KERNEL_DIR / manifest.enforced_by.split("::")[0]
            with self.subTest(gate=gate.name):
                tree = ast.parse(gate.read_text(encoding="utf-8"), filename=str(gate))
                imported = _imported_names(tree, "aria_kernel.surface_waivers")
                self.assertIn("load_waiver_manifest", imported, f"{gate.name} does not read through the one reader")
                self.assertTrue(
                    {"lapsed_waivers", "waiver_has_lapsed"} & imported,
                    f"{gate.name} does not lapse through the one predicate: {sorted(imported)}",
                )
                self.assertEqual(
                    _own_parser_and_clock_calls(tree), [],
                    f"{gate.name} keeps a parser or a clock of its own beside the one reader",
                )

    def test_a_malformed_control_manifest_is_undecided_by_its_own_name_and_the_others_are_still_read(self) -> None:
        self.write_manifest(DORMANT_CONTROL_MANIFEST, "{not json")
        self.write_waivers(self.waiver(_day(5, self.now)))
        check = self.organ()
        self.assertEqual(check.status, "fail")
        self.assertTrue(check.reason.startswith("deadlines_undecided:control_waiver:JSONDecodeError"), check.reason)
        self.assertEqual(
            [(row["kind"], row["key"]) for row in check.detail["due_soon"]],
            [(SURFACE_WAIVER, "tool_registry_status.ARCHIVED")],
        )
        # A FLAT manifest whose entry is not an object: the batch gate used
        # to read that as `{}` — zero waivers — and the organ now names it.
        self.write_manifest(DORMANT_CONTROL_MANIFEST, '{"verify_branch_tip": "not-an-object"}')
        self.write_manifest(BATCH_CONTAINMENT_MANIFEST, '["not-an-object"]')
        check = self.organ()
        self.assertTrue(
            check.reason.startswith("deadlines_undecided:control_waiver:TypeError,batch_containment_waiver:TypeError"),
            check.reason,
        )
        self.assertEqual(check.detail["due_soon"][0]["key"], "tool_registry_status.ARCHIVED")
        for manifest in (DORMANT_CONTROL_MANIFEST, BATCH_CONTAINMENT_MANIFEST):
            with self.assertRaises(TypeError):
                surface_waivers.load_waiver_manifest(self.ws, manifest)

    def test_the_live_checkout_control_waivers_are_rows(self) -> None:
        """The verifier's reproduction, pinned: over the real checkout the
        control manifest's waivers (ORPHAN-HIGH-573 — six dated 2026-09-20
        when this was written, due 2026-09-21T00:00Z) are `control_waiver`
        rows, each due at the start of the day after its `expires_on`.
        Compared against the manifest read through the one reader — count,
        keys, instants — so the pin survives the operator re-dating them."""
        loaded = surface_waivers.load_waiver_manifest(_REPO_ROOT, DORMANT_CONTROL_MANIFEST)
        self.assertTrue(loaded, "the live checkout declares control waivers; when the last one is wired away, re-point this pin at a synthetic manifest")
        readout = read_deadlines(tools_dir=self.tools, workspace_root=_REPO_ROOT, now=self.now)
        self.assertNotIn(f"{CONTROL_WAIVER}:", ";".join(readout.undecided), readout.undecided)
        rows = {row.key: row for row in readout.rows if row.kind == CONTROL_WAIVER}
        self.assertEqual(sorted(rows), sorted(loaded))
        for name, entry in surface_waivers.iter_waivers(loaded, DORMANT_CONTROL_MANIFEST):
            with self.subTest(control=name):
                expected_due = datetime.combine(
                    surface_waivers.waiver_expires_on(entry) + timedelta(days=1), time.min, tzinfo=timezone.utc,
                )
                self.assertEqual(rows[name].due_at, expected_due)
                self.assertEqual(rows[name].enforced_by, DORMANT_CONTROL_MANIFEST.enforced_by)
                self.assertTrue(rows[name].lapse_is_fault)
                self.assertIn(str(entry["finding_id"]), rows[name].consequence)


class UnregisteredWaiverManifests(_Fixture):
    """Round-3 verifier, M6: `tests/test_closure_waivers_gate.py` with a
    `json.loads` of `aria-kernel/closure.waivers.json` and a
    `date.fromisoformat(entry['expires_on']) < date.today()` of its own,
    beside a manifest carrying one waiver dated 2026-09-20 — 28 passed, 0
    failed, and the organ announced nothing for it. `EveryKernelWaiverManifest`
    walks `WAIVER_MANIFESTS`, and the gate that forgot to register is the
    one gate that walk never opens. A gate reaches an unregistered manifest
    through one of two doors, and each is closed where it is passed: the
    reader refuses a spec outside the registry (run time, the gate's own
    first run), and a parser or clock of the gate's own is found by walking
    EVERY test module (below). The manifest file itself is the third witness."""

    def test_the_one_reader_refuses_a_spec_outside_the_registry(self) -> None:
        """A gate that borrows `surface_waivers` with a `WaiverManifest` it
        built itself would read a manifest the organ never announces. Every
        reader refuses the spec by name, before touching the disk, and says
        where to register it — so that gate is red the first time it runs,
        not the morning its waiver lapses. A spec equal field-for-field to
        a registered one IS that manifest (value equality, frozen)."""
        stray = WaiverManifest(
            kind="closure_waiver",
            relpath=("aria-kernel", "closure.waivers.json"),
            shape=ManifestShape.FLAT,
            enforced_by="tests/test_closure_waivers_gate.py::test_a_waiver_expires",
            consequence="the closure gate refuses the lapsed waiver",
        )
        readers = {
            "waiver_manifest_path": lambda: surface_waivers.waiver_manifest_path(self.ws, stray),
            "load_waiver_manifest": lambda: surface_waivers.load_waiver_manifest(self.ws, stray),
            "iter_waivers": lambda: list(surface_waivers.iter_waivers({}, stray)),
            "lapsed_waivers": lambda: surface_waivers.lapsed_waivers({}, stray, today=self.now.date()),
        }
        for name, reader in readers.items():
            with self.subTest(reader=name), self.assertRaises(LookupError) as caught:
                reader()
            self.assertIn("closure_waiver", str(caught.exception))
            self.assertIn(REGISTER_IN_WAIVER_MANIFESTS, str(caught.exception))
        twin = dataclasses.replace(DORMANT_CONTROL_MANIFEST)
        self.assertIsNot(twin, DORMANT_CONTROL_MANIFEST)
        self.assertEqual(
            surface_waivers.waiver_manifest_path(self.ws, twin),
            surface_waivers.waiver_manifest_path(self.ws, DORMANT_CONTROL_MANIFEST),
        )

    def test_no_kernel_test_module_reads_a_dated_waiver_manifest_the_registry_does_not_know(self) -> None:
        """Every Python module under `aria-kernel/tests/` — helpers and
        invariants included, a parser can hide in either — except the gates
        the registry names (pinned above) and this file. A module that
        handles dated waivers (`_dated_waiver_evidence`: the `expires_on`
        field, a manifest path of the registered family, the shared field
        tuple) and keeps a parser or a clock of its own
        (`_own_parser_and_clock_calls`) is a gate the organ does not know;
        a module that builds a `WaiverManifest` is a spec the registry does
        not know. Both are refused with the registry named."""
        exempt = _registered_gate_files() | {Path(__file__).resolve()}
        walked: set[Path] = set()
        offenders: list[str] = []
        for module in sorted(_KERNEL_TESTS.rglob("*.py")):
            walked.add(module.resolve())
            if module.resolve() in exempt:
                continue
            tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
            name = module.relative_to(_KERNEL_TESTS).as_posix()
            specs = _manifest_spec_constructions(tree)
            if specs:
                offenders.append(f"{name}: builds a manifest spec outside the registry ({', '.join(specs)})")
            evidence = _dated_waiver_evidence(tree)
            own = _own_parser_and_clock_calls(tree) if evidence else []
            if own:
                offenders.append(
                    f"{name}: handles dated waivers ({', '.join(evidence)}) "
                    f"with a parser or clock of its own ({', '.join(own)})"
                )
        self.assertTrue(exempt <= walked, f"the walk did not reach the registered gates: {sorted(exempt - walked)}")
        self.assertGreater(len(walked), 100, "the walk collapsed — it would prove nothing over an empty tree")
        self.assertEqual(
            offenders, [],
            "a kernel test reads a dated waiver manifest the deadlines organ does not know — "
            f"{REGISTER_IN_WAIVER_MANIFESTS}:\n" + "\n".join(offenders),
        )

    def test_the_walk_can_see_the_gate_it_exists_to_refuse(self) -> None:
        """Positive control, so the walk above cannot go blind and stay
        green: the verifier's M6 gate, byte-shaped, is an offender on every
        count — by `json.loads`, by `fromisoformat`, by `date.today`, and by
        a spec of its own — and a module that only mentions the words in
        prose is not."""
        m6 = ast.parse(
            "import json\n"
            "from datetime import date\n"
            "from pathlib import Path\n"
            "from aria_kernel.surface_waivers import WaiverManifest\n"
            "MANIFEST = Path('aria-kernel') / 'closure.waivers.json'\n"
            "SPEC = WaiverManifest('closure_waiver', ('aria-kernel', 'closure.waivers.json'), 'flat', 'g', 'c')\n"
            "def lapsed():\n"
            "    entries = json.loads(MANIFEST.read_text())\n"
            "    return [k for k, e in entries.items() if date.fromisoformat(e['expires_on']) < date.today()]\n"
        )
        self.assertEqual(_dated_waiver_evidence(m6), ["'closure.waivers.json'", "'expires_on'"])
        self.assertEqual(
            _own_parser_and_clock_calls(m6),
            ["json.loads at line 8", "fromisoformat at line 9", "date.today at line 9"],
        )
        self.assertEqual(_manifest_spec_constructions(m6), ["WaiverManifest(...) at line 6"])
        aliased = ast.parse(
            "import json as j\n"
            "from json import loads\n"
            "from datetime import datetime as dt\n"
            "REQUIRED = ('expires_on',)\n"
            "def read(p):\n"
            "    return j.load(p), loads(p), dt.strptime(p, '%Y-%m-%d'), dt.today()\n"
        )
        self.assertEqual(
            _own_parser_and_clock_calls(aliased),
            ["j.load at line 6", "json.loads at line 6", "strptime at line 6", "dt.today at line 6"],
        )
        innocent = ast.parse(
            "'Mentions json.loads, fromisoformat and closure.waivers.json in prose only.'\n"
            "from aria_kernel.surface_waivers import utc_today\n"
            "def today():\n"
            "    return utc_today()\n"
        )
        self.assertEqual(_dated_waiver_evidence(innocent), [])
        self.assertEqual(_own_parser_and_clock_calls(innocent), [])
        self.assertEqual(_manifest_spec_constructions(innocent), [])

    def test_every_dated_waiver_manifest_file_in_the_kernel_is_registered(self) -> None:
        """The manifest side of M6: `aria-kernel/closure.waivers.json` was a
        dated manifest no spec named, and a manifest nobody registered is a
        manifest nobody announces whatever its gate looks like. Every JSON
        file under `aria-kernel/` outside `tests/` (fixtures are test
        inputs) whose entries carry `expires_on`, in either registered
        shape, must be the path of a registered spec."""
        registered = {surface_waivers.waiver_manifest_path(_REPO_ROOT, manifest).resolve() for manifest in WAIVER_MANIFESTS}
        strays: list[str] = []
        seen: set[Path] = set()
        for path in sorted(_KERNEL_DIR.rglob("*.json")):
            if _KERNEL_TESTS in path.parents:
                continue
            # A kernel JSON file that does not parse is a defect in its own
            # right; this pin does not step around it to count the rest.
            loaded = json.loads(path.read_text(encoding="utf-8"))
            if not _carries_dated_entries(loaded):
                continue
            if path.resolve() in registered:
                seen.add(path.resolve())
            else:
                strays.append(path.relative_to(_REPO_ROOT).as_posix())
        self.assertEqual(
            strays, [],
            f"a dated waiver manifest no registered spec names — {REGISTER_IN_WAIVER_MANIFESTS}: {strays}",
        )
        self.assertTrue(seen, "the walk found no registered dated manifest — the detector is blind, not the tree clean")
        self.assertTrue(_carries_dated_entries({"verify_branch_tip": {"expires_on": "2026-09-20"}}))
        self.assertTrue(_carries_dated_entries({"tool_registry_status": {"ARCHIVED": {"expires_on": "2026-09-20"}}}))
        self.assertFalse(_carries_dated_entries({"baseline": {"count": 3}}))
        self.assertFalse(_carries_dated_entries(["expires_on"]))


if __name__ == "__main__":
    unittest.main()
