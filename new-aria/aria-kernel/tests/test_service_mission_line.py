"""The charter's per-service hardening program finally has a producer.

Everything this wires existed and was severed: `cycle_service_examination`
computed per-service targeting nobody consumed (and ran AFTER mission
ingest); `SERVICE_MAP.json` inventoried every service for no reader;
`select_next_mission` had one caller, the operator CLI; the
coverage-gap → mission path was structurally unreachable because gap
detection runs after ingest and ingest filtered to the current cycle id;
and a mission could not even NAME a service except inside free text.
"""
from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from aria_kernel import cycle as cycle_mod
from aria_kernel import mission as mission_module
from aria_kernel.ledger import append_declared_jsonl, load_jsonl
from aria_kernel.mission import (
    MISSION_SCHEMA,
    assert_cycle_closure,
    events_path,
    fold_mission,
    mission_id_for,
    open_mission,
    transition_mission,
)
from aria_kernel.mission_scheduler import SOURCE_RANK
from aria_kernel.tool_registry import ensure_tools_dir, utc_now


def _legacy_service_mission(root: Path, project: str) -> str:
    """A service mission as the live store holds it: `opened`, nothing else.

    `open_mission` cannot produce one since ORPHAN-MEDIUM-730, so the healing
    path has to be proven against a row written the way the pre-rule writers
    wrote every row on the live store (5 of them, measured 2026-08-19 — all
    from the ingest path, none from this phase) — a mission the current mint
    would refuse.
    """
    mission_id = mission_id_for("service_hardening", project, "rh-1")
    # The genesis idempotency key comes from the writer's own derivation, not
    # from a string invented here: a fixture with a different key would make
    # `open_mission` append a SECOND opened event instead of folding into the
    # existing mission, and the test would then prove healing against a shape
    # the live store does not have.
    key = mission_module._idempotency_key(mission_id, "genesis", "", "opened")
    append_declared_jsonl(
        events_path(root),
        {
            "schema_version": 1,
            "schema": MISSION_SCHEMA,
            "event_id": f"legacy-{project}",
            "recorded_at": utc_now(),
            "event": "opened",
            "mission_id": mission_id,
            "idempotency_key": key,
            "source_kind": "service_hardening",
            "source_id": project,
            "repo_hash": "rh-1",
            "title": f"Harden {project}",
            "capability": "service_hardening",
            "priority": 1,
            "target_project": project,
        },
        expected_surface="mission_events",
    )
    return mission_id


# The project layout `impact_graph._discover_projects` reads: a project is a
# directory under apps/ libs/ platform/libs/ web/*, and its nx NAME is what the
# examination puts in `examination_order[].project`. The seeder attributes every
# changed path and every finding through that same map, so a fixture workspace
# with no directories has no projects and can only ever exercise the refusal
# branch — which is exactly how a seeder that could name 17 of this repo's 71
# projects passed a green suite (ORPHAN-MEDIUM-730).
_CORE_ROOTS: tuple[str, ...] = tuple(
    f"apps/{project}" for project in cycle_mod.SERVICE_HARDENING_CORE
)


def _workspace(base: str, *roots: str) -> None:
    for root in roots:
        Path(base, root).mkdir(parents=True, exist_ok=True)


def _context(base: str, exam: dict | None = None, changed_paths: list[str] | None = None):
    ctx = cycle_mod.build_phase_context(
        cycle_id="cyc-svc",
        workspace_root=Path(base),
        base_dir=Path(base) / "aria-tools",
    )
    if exam is not None:
        ctx.results["service_examination"] = exam
    if changed_paths is not None:
        # ORPHAN-MEDIUM-730 — the seeder reads the cycle diff to name the
        # paths a service actually moved. `service_examination` only ever
        # published a COUNT, and a count cannot be a wake key.
        ctx.results["cycle_diff"] = {"changed_paths": changed_paths}
    return ctx


class PhaseOrderTest(unittest.TestCase):
    def test_examination_and_seed_run_before_ingest_selection_after(self) -> None:
        names = [p.name for p in cycle_mod.CYCLE_PHASES]
        sub = [n for n in names if n in (
            "pressure", "service_examination", "service_mission_seed",
            "mission_ingest", "mission_selection",
        )]
        self.assertEqual(sub, [
            "pressure", "service_examination", "service_mission_seed",
            "mission_ingest", "mission_selection",
        ])


class ServiceMissionSeedTest(unittest.TestCase):
    def _seed(self, exam: dict, changed_paths: list[str] | None = None,
              roots: tuple[str, ...] = ()):
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _workspace(tmp, *_CORE_ROOTS, *roots)
            ctx = _context(tmp, exam, changed_paths)
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            missions = {
                s["project"]: fold_mission(mission_id=s["mission_id"], base_dir=root)
                for s in result["seeded"]
            }
            governance = [
                row for row in load_jsonl(root / "governance.jsonl")
                if row.get("kind") == "service_mission_refused"
            ]
            return result, missions, governance

    def test_a_service_with_no_evidence_is_disclosed_not_minted(self) -> None:
        """SUPERSEDES `test_core_services_are_seeded_even_on_a_quiet_night`.

        Membership in the core list used to mean "minted every night no
        matter what": with no findings, no pressures and no diff there is
        nothing to name as a next action and nothing to name as a wake, so the
        mint produced exactly the row the closure gate exists to report. (The
        5 paralysed rows measured on the live store came from the ingest path,
        not from this phase — the rule stands regardless of which producer
        proved it.) The old assertion is now false ON PURPOSE: a service ARIA
        cannot drive gets a disclosed refusal instead of a paralysed mission.
        What the charter still demands is held by
        `test_core_services_are_considered_and_disclosed_on_a_quiet_night`.
        """
        result, missions, governance = self._seed({})

        self.assertEqual(missions, {})
        self.assertEqual(
            {row["project"] for row in result["refused"]},
            set(cycle_mod.SERVICE_HARDENING_CORE),
        )
        self.assertEqual(
            {row["details"]["reason"] for row in governance},
            {"no_derivable_closure_contract"},
        )
        self.assertTrue(all(row["details"]["core"] for row in governance))

    def test_core_services_are_considered_and_disclosed_on_a_quiet_night(self) -> None:
        """SUCCESSOR to `test_core_services_are_seeded_even_on_a_quiet_night`.

        That pin encoded charter M-5.1 — the four core services get attention
        every night, not only when something happens to move. ORPHAN-MEDIUM-730
        falsified HOW (a mint with no evidence produces a mission nothing can
        advance) and the pin was deleted rather than rewritten, which quietly
        dropped the charter obligation along with the broken mechanism.

        The obligation survives in its successor form: on a quiet night every
        core service is still NAMED — as a disclosed refusal carrying
        ``core: true`` — so "ARIA declined to harden auth-service tonight"
        stays distinguishable from "ARIA never looked at auth-service". The
        second half of membership (considered first, priced lowest) is pinned
        below by the priority a core service gets when it does have evidence.
        """
        result, missions, governance = self._seed({})

        self.assertEqual(missions, {}, "a mission with no evidence cannot move")
        self.assertEqual(
            [row["project"] for row in result["refused"]],
            list(cycle_mod.SERVICE_HARDENING_CORE),
            "the core list sets the ORDER in which services are considered",
        )
        self.assertEqual(
            {row["details"]["project"] for row in governance if row["details"]["core"]},
            set(cycle_mod.SERVICE_HARDENING_CORE),
            "charter M-5.1: a core service is never SILENTLY skipped",
        )

    def test_core_membership_still_buys_the_lowest_price(self) -> None:
        """The other half of what membership means: a core service with
        evidence is priced under the whole evidence-backed band (10+), so it
        wins the WIP slot against a more-central non-core service."""
        exam = {
            "examination_order": [
                {"project": "messaging-service", "changed_files": 1},
            ],
            "per_service_pressures": [],
        }
        result, _, _ = self._seed(
            exam,
            changed_paths=[
                "apps/auth-service/src/token.service.ts",
                "apps/messaging-service/src/channel.service.ts",
            ],
            roots=("apps/messaging-service",),
        )

        priced = {row["project"]: row["priority"] for row in result["seeded"]}
        self.assertLess(priced["auth-service"], 10)
        self.assertGreaterEqual(priced["messaging-service"], 10)

    def test_an_unchanged_refusal_is_disclosed_once_not_every_night(self) -> None:
        """A disclosure that repeats identically every night is noise.

        Reproduced before the fix: four identical evidence-free cycles wrote
        16 `service_mission_refused` rows — 4 per cycle, byte-identical apart
        from the cycle id — and with an empty findings ledger that is what the
        nightly does forever. The class this whole train exists to end is a
        gate reporting the same weather every night; a refusal doing it in a
        second ledger is the same defect in the other ledger.
        """
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _workspace(tmp, *_CORE_ROOTS)
            results = []
            for cycle in range(4):
                ctx = cycle_mod.build_phase_context(
                    cycle_id=f"cyc-{cycle}",
                    workspace_root=Path(tmp),
                    base_dir=root,
                )
                ctx.results["service_examination"] = {}
                ctx.results["cycle_diff"] = {"changed_paths": []}
                with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                    results.append(cycle_mod._phase_service_mission_seed(ctx))
            governance = [
                row for row in load_jsonl(root / "governance.jsonl")
                if row.get("kind") == "service_mission_refused"
            ]

        self.assertEqual(len(governance), len(cycle_mod.SERVICE_HARDENING_CORE))
        # Every cycle still REPORTS every refusal; only the ledger stays quiet.
        for result in results:
            self.assertEqual(
                {row["project"] for row in result["refused"]},
                set(cycle_mod.SERVICE_HARDENING_CORE),
            )
        self.assertTrue(all(row["newly_disclosed"] for row in results[0]["refused"]))
        self.assertFalse(any(row["newly_disclosed"] for row in results[-1]["refused"]))

    def test_a_changed_refusal_is_a_new_fact_and_a_new_row(self) -> None:
        """Silence is only correct while the fact is unchanged: a service that
        gained a scoped pressure but still cannot name a contract is a
        DIFFERENT refusal, and burying it would be the dedupe hiding news."""
        quiet = {}
        # A pressure with no id: it scopes onto the service (so the census
        # changes) but cannot become a wake key, so the refusal stands.
        noisier = {
            "examination_order": [],
            "per_service_pressures": [
                {"service": "auth-service", "layer": 0, "pressures": [{"reason": "x"}]},
            ],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _workspace(tmp, *_CORE_ROOTS)
            for exam in (quiet, noisier):
                ctx = cycle_mod.build_phase_context(
                    cycle_id="cyc-x", workspace_root=Path(tmp), base_dir=root,
                )
                ctx.results["service_examination"] = exam
                ctx.results["cycle_diff"] = {"changed_paths": []}
                with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                    result = cycle_mod._phase_service_mission_seed(ctx)
            governance = [
                row["details"] for row in load_jsonl(root / "governance.jsonl")
                if row.get("kind") == "service_mission_refused"
            ]

        auth_rows = [row for row in governance if row["project"] == "auth-service"]
        self.assertEqual([row["scoped_pressures"] for row in auth_rows], [0, 1])

    def test_the_nightly_seed_never_writes_over_an_operator_parked_mission(self) -> None:
        """AUTHORITY. The heal must stop where a human took the work over.

        Reproduced before the guard existed: an operator parked a service
        mission in HUMAN_REQUIRED, a later contract-clearing transition
        emptied its forward pointer, and the UNATTENDED nightly seed phase
        then installed a machine-composed "Review the 1 path(s) changed in
        farm-service this cycle…" in its place. The machine cannot move such
        a mission (the scheduler skips every waiting state), so this was never
        a merge-authority breach — it was a machine overwriting an operator.
        """
        exam = {
            "examination_order": [{"project": "farm-service", "changed_files": 1}],
            "per_service_pressures": [],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _workspace(tmp, *_CORE_ROOTS)
            mission_id = _legacy_service_mission(root, "farm-service")
            # A pre-rule park: state moved, contract never stated. Written
            # straight to the ledger because `transition_mission` refuses this
            # shape now — which is the other half of the same fix.
            append_declared_jsonl(
                events_path(root),
                {
                    "schema_version": 1,
                    "schema": MISSION_SCHEMA,
                    "event_id": "legacy-park-farm",
                    "recorded_at": utc_now(),
                    "event": "transition",
                    "mission_id": mission_id,
                    "idempotency_key": "legacy-park-farm",
                    "from_state": "DISCOVERED",
                    "to_state": "HUMAN_REQUIRED",
                    "reason_code": "coarse_observation",
                    "retry_rung": None,
                    "next_action": None,
                    "wake_condition": None,
                    "evidence_refs": [],
                },
                expected_surface="mission_events",
            )
            ctx = _context(tmp, exam, ["apps/farm-service/src/pond.service.ts"])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            row = next(r for r in result["seeded"] if r["project"] == "farm-service")
            state = fold_mission(mission_id=mission_id, base_dir=root)

        self.assertFalse(row["contract_healed"])
        self.assertEqual(row["heal_declined"], "operator_held")
        self.assertEqual(state["state"], "HUMAN_REQUIRED")
        self.assertIsNone(state["next_action"])

    def test_evidence_backed_services_join_the_core(self) -> None:
        # The fixture carries the PRODUCER's real shape: per_service_pressures
        # is a LIST of {service, layer, pressures} groups
        # (impact_graph.cycle_service_examination), not a dict. The original
        # fixture invented a dict and the first live cycle failed with
        # "'list' object has no attribute 'get'" — the test had validated the
        # seeder against a shape the producer never emits (ORPHAN-HIGH-622).
        exam = {
            "examination_order": [
                {"project": "messaging-service", "changed_files": 3},
                {"project": "untouched-lib", "changed_files": 0},
            ],
            "per_service_pressures": [],
        }
        result, missions, _ = self._seed(
            exam, changed_paths=["apps/messaging-service/src/channel.service.ts"],
            roots=("apps/messaging-service",),
        )

        self.assertIn("messaging-service", missions)
        self.assertNotIn("untouched-lib", missions)
        row = next(r for r in result["seeded"] if r["project"] == "messaging-service")
        self.assertEqual(row["contract_source"], "changed_path")

    def test_a_library_projects_own_diff_is_attributed_to_it(self) -> None:
        """The 54-of-71 defect: two path -> project vocabularies, one mission.

        `targets` are nx project names — `impact_graph._project_for_path` over
        the graph's `project_roots` produced them. The evidence behind them
        was then attributed with `service_dimension.service_for_path`, which
        emits `shared:<lib>` / `web:<app>` / None and can therefore never
        return `backend-common`. Measured against this repository, 54 of 71
        projects had an nx name that vocabulary cannot produce, so the seeder
        wrote a governance row claiming "no derivable evidence" about the very
        path that had put the project in `targets`.

        This pin bites on the vocabulary, not on the string: revert the
        attribution and `backend-common` moves from `seeded` to `refused`.
        """
        from aria_kernel.service_dimension import service_for_path

        exam = {
            "examination_order": [{"project": "backend-common", "changed_files": 1}],
            "per_service_pressures": [],
        }
        changed = "libs/backend-common/src/rls.service.ts"
        result, missions, _ = self._seed(
            exam, changed_paths=[changed], roots=("libs/backend-common",),
        )

        self.assertNotIn(
            "backend-common", {row["project"] for row in result["refused"]}
        )
        row = next(r for r in result["seeded"] if r["project"] == "backend-common")
        self.assertEqual(row["contract_source"], "changed_path")
        self.assertEqual(
            missions["backend-common"]["wake_condition"],
            {"kind": "evidence", "key": f"changed_path:{changed}"},
        )
        # WHY the pin bites: the vocabulary this replaced answers a different
        # question and gives a different answer for this exact path.
        self.assertNotEqual(service_for_path(changed), "backend-common")

    def test_a_finding_on_a_library_project_is_attributed_to_it(self) -> None:
        """Findings went through the same broken vocabulary as paths.

        `services_for_finding_row` answers "which service DIMENSION does this
        finding belong to" — the axis the findings list and agent routing use
        — and for a library it answers `shared:backend-common`. The seeder was
        asking a different question ("which nx project owns it") of that
        answer. The paths still come from `finding_dimension_paths`, the E15-c
        collector; only the attribution on top of them changed.
        """
        from aria_kernel.feedback_store import record_findings_for_run
        from aria_kernel.service_dimension import services_for_finding_row

        # The pressure is what puts a non-core project in `targets` at all;
        # the finding is what the contract must come from, because
        # `mission_scheduler.SOURCE_RANK` ranks a confirmed finding above a
        # pressure and this function reads that table rather than restating it.
        exam = {
            "examination_order": [{"project": "backend-common", "changed_files": 0}],
            "per_service_pressures": [
                {"service": "backend-common", "layer": 0,
                 "pressures": [{"pressure_id": "p-bc-1"}]},
            ],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _workspace(tmp, *_CORE_ROOTS, "libs/backend-common")
            run = {
                "tool_id": "backend-auditor",
                "run_id": "run-1",
                "emitted_findings": [{
                    "id": "F-bc-1",
                    "severity": "high",
                    "message": "the scoped repository helper swallows a tenant mismatch",
                    "path": "libs/backend-common/src/rls.service.ts",
                }],
            }
            record_findings_for_run(run, base_dir=root)
            stored = load_jsonl(root / "findings.jsonl")[0]
            ctx = _context(tmp, exam, [])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            missions = {
                s["project"]: fold_mission(mission_id=s["mission_id"], base_dir=root)
                for s in result["seeded"]
            }

        self.assertIn("backend-common", missions)
        self.assertEqual(result["seeded"][0]["contract_source"], "open_finding")
        self.assertEqual(
            missions["backend-common"]["wake_condition"],
            {"kind": "evidence", "key": "finding:F-bc-1"},
        )
        # The dimension the old reader would have handed the seeder — a name
        # no `examination_order` entry can ever carry.
        self.assertEqual(services_for_finding_row(stored), ["shared:backend-common"])

    def test_a_refusal_never_claims_evidence_it_did_not_attribute(self) -> None:
        """"No derivable evidence" is a measurement, so it needs a measurement.

        When the project graph is unreadable there is no map to attribute
        against, and a refusal saying "no derivable closure contract" would be
        stating a result this phase never computed — about a diff it is
        holding in its hand. That is the same class of false disclosure the
        vocabulary mismatch produced, and it gets its own reason.
        """
        def _no_graph(**_kwargs):
            raise OSError("no project graph on this machine")

        exam = {
            "examination_order": [{"project": "farm-service", "changed_files": 1}],
            "per_service_pressures": [],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            _workspace(tmp, *_CORE_ROOTS)
            ctx = _context(tmp, exam, ["apps/farm-service/src/pond.service.ts"])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"), \
                 patch("aria_kernel.impact_graph.cached_service_analysis_order",
                       _no_graph):
                result = cycle_mod._phase_service_mission_seed(ctx)
            governance = [
                row for row in load_jsonl(root / "governance.jsonl")
                if row.get("kind") == "service_mission_refused"
            ]

        self.assertEqual(result["seeded"], [])
        self.assertEqual(
            {row["details"]["reason"] for row in governance},
            {"project_attribution_unavailable"},
        )
        # And the census. Reporting "changed_paths: 0" here would state an
        # absence this phase never measured, while it is holding the diff
        # unattributed: with no project map, zero is what the attribution
        # produced, not what the repository did. It reports the totals it
        # actually holds and omits the per-project census it could not take.
        for row in governance:
            self.assertNotIn("changed_paths", row["details"])
            self.assertNotIn("open_findings", row["details"])
            self.assertEqual(row["details"]["unattributed_changed_paths"], 1)
            self.assertEqual(row["details"]["unattributed_open_findings"], 0)

    def test_the_wake_key_names_the_services_own_evidence(self) -> None:
        """Never a placeholder: the key has to be an identifier this cycle saw.

        A wake key like "next_cycle" or "service:<name>" would validate and
        still tell the scheduler nothing about WHAT changed — every seeded
        mission would share one handle and none of them would ever be woken
        by the arrival of the evidence they are actually about.
        """
        exam = {
            "examination_order": [{"project": "sensor-service", "changed_files": 1}],
            "per_service_pressures": [
                {"service": "sensor-service", "layer": 2,
                 "pressures": [{"pressure_id": "p-77"}]},
            ],
        }
        _, missions, _ = self._seed(
            exam, changed_paths=["apps/sensor-service/src/reading.ts"],
        )

        self.assertEqual(
            missions["sensor-service"]["wake_condition"],
            {"kind": "evidence", "key": "pressure:p-77"},
        )
        self.assertIn("p-77", missions["sensor-service"]["next_action"])

    def test_an_open_finding_drives_a_core_service_with_no_diff(self) -> None:
        """The path that keeps the core four alive once the quiet-night mint
        is gone: a service with no changes and no pressures still has real
        work when it owns an open finding, and that finding is a legal wake.

        The fixture goes through `record_findings_for_run` rather than writing
        a row by hand, so the service axis is derived by the same E15-a mint
        the seeder reads back through — a hand-written row could carry a
        dimension the real pipeline would never produce.
        """
        from aria_kernel.feedback_store import record_findings_for_run

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            record_findings_for_run(
                {
                    "tool_id": "auth-auditor",
                    "run_id": "run-1",
                    "emitted_findings": [
                        {
                            "id": "F-auth-1",
                            "severity": "high",
                            "message": "refresh token rotation is not atomic",
                            "path": "apps/auth-service/src/token.service.ts",
                        }
                    ],
                },
                base_dir=root,
            )
            _workspace(tmp, *_CORE_ROOTS)
            ctx = _context(tmp, {}, [])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            missions = {
                s["project"]: fold_mission(mission_id=s["mission_id"], base_dir=root)
                for s in result["seeded"]
            }

        self.assertEqual([s["project"] for s in result["seeded"]], ["auth-service"])
        self.assertEqual(result["seeded"][0]["contract_source"], "open_finding")
        self.assertEqual(
            missions["auth-service"]["wake_condition"],
            {"kind": "evidence", "key": "finding:F-auth-1"},
        )
        # The other three core services owned nothing this cycle and are
        # disclosed rather than minted.
        self.assertEqual(
            {row["project"] for row in result["refused"]},
            set(cycle_mod.SERVICE_HARDENING_CORE) - {"auth-service"},
        )

    def test_a_seeded_mission_carries_the_contract_and_advances_one_step(self) -> None:
        """The whole point of the contract: the mission can actually MOVE.

        Every one of the 5 live missions sits in DISCOVERED because nothing
        said what to do next; folding a contract at the mint is only worth
        anything if the mission it produces is clean to the closure gate and
        accepted by the transition table on its first step.
        """
        exam = {
            "examination_order": [{"project": "farm-service", "changed_files": 1}],
            "per_service_pressures": [
                {"service": "farm-service", "layer": 1,
                 "pressures": [{"pressure_id": "p-farm-1"}]},
            ],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            ctx = _context(tmp, exam, ["apps/farm-service/src/pond.service.ts"])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            row = next(r for r in result["seeded"] if r["project"] == "farm-service")
            self.assertEqual(assert_cycle_closure(base_dir=root)["violations"], [])

            transition_mission(
                mission_id=row["mission_id"],
                to_state="CONTRACTING",
                reason_code="service_hardening_contracting",
                step_id="s1",
                next_action="draft the hardening contract for farm-service",
                wake_condition={"kind": "evidence", "key": "pressure:p-farm-1"},
                base_dir=root,
            )
            state = fold_mission(mission_id=row["mission_id"], base_dir=root)

        self.assertEqual(state["state"], "CONTRACTING")
        self.assertEqual(assert_cycle_closure(base_dir=root)["violations"], [])

    def test_reseeding_heals_a_mission_opened_before_the_contract_existed(self) -> None:
        """Mission identity ignores the cycle, so a stuck mission stays stuck.

        The rows on the live store were opened when the mint required no
        contract. Re-seeding them is idempotent by design, so without the
        `wake` event they would never gain a forward pointer — the refusal
        would have healed only the future and left the present paralysed.
        """
        exam = {
            "examination_order": [{"project": "billing-service", "changed_files": 1}],
            "per_service_pressures": [
                {"service": "billing-service", "layer": 1,
                 "pressures": [{"pressure_id": "p-bill-9"}]},
            ],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            mission_id = _legacy_service_mission(root, "billing-service")
            self.assertTrue(assert_cycle_closure(base_dir=root)["violations"])

            ctx = _context(tmp, exam, [])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                result = cycle_mod._phase_service_mission_seed(ctx)
            row = next(r for r in result["seeded"] if r["project"] == "billing-service")
            state = fold_mission(mission_id=mission_id, base_dir=root)
            violations = assert_cycle_closure(base_dir=root)["violations"]

        self.assertEqual(row["mission_id"], mission_id)
        self.assertTrue(row["idempotent"])
        self.assertTrue(row["contract_healed"])
        self.assertEqual(
            state["wake_condition"], {"kind": "evidence", "key": "pressure:p-bill-9"}
        )
        self.assertEqual(violations, [])

    def test_the_centrality_band_is_actually_computed(self) -> None:
        """Z4b's PageRank band was dead: the call passed a keyword-only
        parameter positionally, so every cycle raised TypeError into the
        "graph absent" handler and every evidence-backed mission silently
        fell back to enumeration order. TypeError is out of that handler now,
        so a mis-called graph reader fails loudly instead of degrading.
        """
        exam = {
            "examination_order": [{"project": "hr-service", "changed_files": 1}],
            "per_service_pressures": [
                {"service": "hr-service", "layer": 3,
                 "pressures": [{"pressure_id": "p-hr-1"}]},
            ],
        }
        # The fixture carries `project_roots` because the real reader does:
        # the seeder takes BOTH the centrality scores and the path -> project
        # map out of this one payload, so a stand-in that omits the map is a
        # stand-in for a reader that does not exist.
        graph = {
            "dependencies": {"hr-service": ["shared-lib"], "farm-service": ["shared-lib"]},
            "project_roots": {"hr-service": "apps/hr-service", "shared-lib": "libs/shared-lib"},
        }

        def _keyword_only_reader(*, workspace_root, base_dir=None, nx_graph_file=None):
            return graph

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            ctx = _context(tmp, exam, [])
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"), \
                 patch("aria_kernel.impact_graph.cached_service_analysis_order",
                       _keyword_only_reader):
                result = cycle_mod._phase_service_mission_seed(ctx)

        row = next(r for r in result["seeded"] if r["project"] == "hr-service")
        self.assertIsNotNone(row["centrality"])
        self.assertGreaterEqual(row["priority"], 10)

    def test_the_producers_real_list_shape_scopes_pressures(self) -> None:
        # Content-pin against the live defect: a non-empty producer-shaped
        # LIST must both survive and scope pressures onto the right service.
        exam = {
            "examination_order": [
                {"project": "sensor-service", "changed_files": 1},
            ],
            "per_service_pressures": [
                {
                    "service": "sensor-service",
                    "layer": 2,
                    "pressures": [{"pressure_id": "p-1"}, {"pressure_id": "p-2"}],
                },
            ],
        }
        result, _, _ = self._seed(exam)

        row = next(r for r in result["seeded"] if r["project"] == "sensor-service")
        self.assertEqual(row["scoped_pressures"], 2)

    def test_missions_carry_a_queryable_target_project(self) -> None:
        exam = {
            "examination_order": [{"project": "auth-service", "changed_files": 2}],
            "per_service_pressures": [],
        }
        _, missions, _ = self._seed(
            exam, changed_paths=["apps/auth-service/src/token.service.ts"],
        )
        row = missions["auth-service"]

        self.assertEqual(row["target_project"], "auth-service")

    def test_reseeding_is_idempotent(self) -> None:
        # The fixture carries evidence now. With the empty exam this test used
        # to pass, `seeded` is EMPTY after ORPHAN-MEDIUM-730 and both
        # `all(...)` assertions succeed over nothing — the pin would have
        # survived as a tautology proving idempotency of an empty list.
        exam = {
            "examination_order": [{"project": "alert-engine", "changed_files": 1}],
            "per_service_pressures": [
                {"service": "alert-engine", "layer": 2,
                 "pressures": [{"pressure_id": "p-alert-1"}]},
            ],
        }
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            with patch.object(cycle_mod, "repo_hash", return_value="rh-1"):
                first = cycle_mod._phase_service_mission_seed(_context(tmp, exam, []))
                second = cycle_mod._phase_service_mission_seed(_context(tmp, exam, []))

        self.assertEqual([s["project"] for s in first["seeded"]], ["alert-engine"])
        self.assertTrue(all(not s["idempotent"] for s in first["seeded"]))
        self.assertTrue(all(s["idempotent"] for s in second["seeded"]))
        self.assertTrue(all(not s["contract_healed"] for s in second["seeded"]))


class ClosureContractTierOrderTest(unittest.TestCase):
    def test_the_tier_order_is_read_off_the_schedulers_rank_table(self) -> None:
        """The comment said the order came from `SOURCE_RANK`; the code said
        it came from the order the `if` branches were typed in. `changed_path`
        is not even a member of that table, so reordering the table moved
        nothing and nothing could detect the drift — a Tier-4 claim wearing a
        Tier-2 label. Flipping the table now flips the contract.
        """
        from aria_kernel import mission_scheduler

        evidence = dict(
            pressures=[{"pressure_id": "p-1"}],
            changed_paths=["apps/auth-service/src/token.service.ts"],
            finding_ids=["F-1"],
        )
        default = cycle_mod._service_closure_contract("auth-service", **evidence)
        with patch.dict(mission_scheduler.SOURCE_RANK,
                        {"finding": 9, "pressure": 1}, clear=False):
            flipped = cycle_mod._service_closure_contract("auth-service", **evidence)

        self.assertEqual(default[2], "open_finding")
        self.assertEqual(flipped[2], "scoped_pressure")

    def test_a_changed_path_never_outranks_a_declared_source(self) -> None:
        """It is the only tier with no seat at the table, so it takes the
        last one by derivation rather than by a literal.
        """
        from aria_kernel import mission_scheduler

        self.assertNotIn("changed_path", mission_scheduler.SOURCE_RANK)
        with patch.dict(mission_scheduler.SOURCE_RANK,
                        {"pressure": 999}, clear=False):
            contract = cycle_mod._service_closure_contract(
                "auth-service",
                pressures=[{"pressure_id": "p-1"}],
                changed_paths=["apps/auth-service/src/token.service.ts"],
                finding_ids=[],
            )

        self.assertEqual(contract[2], "scoped_pressure")


class SchedulerIntegrationTest(unittest.TestCase):
    def test_service_hardening_is_a_ranked_source(self) -> None:
        self.assertIn("service_hardening", SOURCE_RANK)
        self.assertGreater(SOURCE_RANK["service_hardening"], SOURCE_RANK["finding"])

    def test_selection_hands_the_winner_to_the_queue(self) -> None:
        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            opened = open_mission(
                source_kind="service_hardening", source_id="auth-service",
                repo_hash="rh-1", title="Harden auth-service",
                next_action="Harden auth-service against finding F-1",
                wake_condition={"kind": "evidence", "key": "finding:F-1"},
                target_project="auth-service", base_dir=root,
            )
            ctx = _context(tmp)
            result = cycle_mod._phase_mission_selection(ctx)

        self.assertEqual(result["selected_mission"], opened["mission_id"])
        self.assertEqual(result["selected_project"], "auth-service")
        self.assertTrue(result["queue_item_id"], "the winner must reach the queue")

    def test_an_empty_ledger_selects_nothing_and_queues_nothing(self) -> None:
        with TemporaryDirectory() as tmp:
            ensure_tools_dir(Path(tmp) / "aria-tools")
            result = cycle_mod._phase_mission_selection(_context(tmp))

        self.assertIsNone(result["selected_mission"])
        self.assertIsNone(result["queue_item_id"])


class CoverageGapPathTest(unittest.TestCase):
    def test_ingest_no_longer_filters_the_latest_gap_batch_by_cycle_id(self) -> None:
        # The structural-unreachability fix: gap detection runs AFTER ingest,
        # so at ingest time the newest batch always carries the previous
        # cycle's id and the old equality filter dropped it, every cycle.
        import ast
        import inspect
        import textwrap

        from aria_kernel import task as task_mod

        src = textwrap.dedent(inspect.getsource(task_mod.generate_task_candidates))
        self.assertNotIn('gap.get("cycle_id") == cycle_id', src)
        self.assertIn("latest_capability_gaps", src)


class DrainResolvesMissionMarkersTest(unittest.TestCase):
    def test_a_mission_item_mints_with_the_missions_evidence(self) -> None:
        from aria_kernel import autonomy_orchestrator as ao

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "aria-tools"
            ensure_tools_dir(root)
            opened = open_mission(
                source_kind="service_hardening", source_id="auth-service",
                repo_hash="rh-1", title="Harden auth-service",
                next_action="Harden auth-service against finding F-1",
                wake_condition={"kind": "evidence", "key": "finding:F-1"},
                target_project="auth-service", base_dir=root,
            )
            captured: dict = {}

            def fake_create(**kw):
                captured.update(kw)
                return {"request_id": "AIR-x"}

            item = {
                "queue_item_id": "qi-m1",
                "pressure_id": f"mission:{opened['mission_id']}",
                "source_cycle_id": "cyc-svc",
                "recommended_action": "advance the mission",
                "candidate_tools": [],
            }
            with patch.object(ao, "read_pending", return_value=[item]), \
                 patch.object(ao, "mark_consumed"), \
                 patch.object(ao, "_find_projected_queue_request", return_value=None), \
                 patch("aria_kernel.agent_invocations.create_agent_invocation_request", fake_create), \
                 patch("aria_kernel.tool_registry.append_tools_governance"):
                ao._drain_next_cycle_queue(
                    base_dir=root, daemon_agent_id="t", limit=1, workspace_root=root,
                )

        # The mission has no accumulated evidence yet, so the fallback marker
        # applies — the important pin is that the MARKER never leaks into the
        # evidence channel as if it were a path.
        self.assertEqual(captured.get("evidence_refs"), ["qi-m1"])
        self.assertEqual(captured.get("pressure_event_id"), f"mission:{opened['mission_id']}")


if __name__ == "__main__":
    unittest.main()
