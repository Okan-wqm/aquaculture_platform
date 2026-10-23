"""E15-a/b — findings carry a service dimension (operator direction), in the
nx project key (SE-1).

Findings were organised by TOOL; the operator runs a 17-service platform
and needs them organised by SERVICE so per-service audits, service
missions and (later) service-specific genesis agents have an axis to
stand on. Since SE-1 the axis is the nx project name that
`impact_graph.project_for_path` derives from the cached ``project_roots``
map. These pin the mint fields, the row reader, both mint points' use of
the map, the read filter and the candidate linkage. The vocabulary
contract itself (legacy re-derivation, lib vs platform-lib, the
mint-without-workspace map) is pinned in ``test_service_key_nx_vocabulary``;
attribution over the CURRENT map (fingerprint) in
``test_service_key_map_freshness``.

SE-1 round 2 (review-r1 B2): a store that can produce no map is a named
refusal (``service_key_map_unavailable``), never an empty dimension. "Cannot
attribute" and "attributed to nothing" were the same answer: the mint wrote no
dimension, and the filter and the task candidates answered "no services" for
every unstamped row. Fixtures that mint therefore bind their store to the
workspace they publish the map from.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.impact_graph import ProjectMap, project_map
from aria_kernel.service_dimension import (
    SERVICE_MAP_FINGERPRINT,
    SERVICE_VOCABULARY,
    finding_dimension_paths,
    finding_service_fields,
    owning_agent_domains_for_paths,
    services_for_finding_row,
)

# A hand-written map in the SHAPE `cached_service_analysis_order` publishes
# (name -> root), wrapped as the `ProjectMap` every attribution takes. The
# names are fixture names for these unit tests; they are not a claim about the
# name the real writer gives any root (review-r1 B3: that is pinned against
# the writer itself, in
# ``test_service_key_nx_vocabulary.StampNamesTheKeyItCarries``).
ROOTS = ProjectMap(
    {
        "auth-service": "apps/auth-service",
        "billing-service": "apps/billing-service",
        "hr-service": "apps/hr-service",
        "sensor-service": "apps/sensor-service",
        "backend-common": "libs/backend-common",
        "event-bus": "platform/libs/event-bus",
    }
)


def _fixture_workspace(root: Path, *roots: str) -> Path:
    for rel in roots:
        path = root / rel / "src" / "index.ts"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("export const x = 1;\n", encoding="utf-8")
    return root


class MintFieldsTests(unittest.TestCase):
    def test_single_service_sets_scalar_and_stamps_the_vocabulary(self) -> None:
        fields = finding_service_fields(
            ["apps/billing-service/src/a.ts", "apps/billing-service/src/b.ts:42-60"], ROOTS
        )
        self.assertEqual(
            fields,
            {
                "service": "billing-service",
                "services": ["billing-service"],
                "service_vocabulary": SERVICE_VOCABULARY,
                SERVICE_MAP_FINGERPRINT: ROOTS.fingerprint,
            },
        )

    def test_multi_service_keeps_scalar_none(self) -> None:
        # Collapsing a cross-service finding to one service would misfile
        # exactly the defect class the relation work later builds on.
        fields = finding_service_fields(
            ["apps/billing-service/src/a.ts", "platform/libs/event-bus/src/bus.ts"], ROOTS
        )
        self.assertIsNone(fields["service"])
        self.assertEqual(fields["services"], ["billing-service", "event-bus"])

    def test_paths_outside_every_project_contribute_nothing(self) -> None:
        fields = finding_service_fields(["docs/adr/ADR-011.md", "/etc/passwd"], ROOTS)
        self.assertEqual(fields["services"], [])
        self.assertIsNone(fields["service"])


class RowReaderTests(unittest.TestCase):
    def test_dimension_paths_cover_both_finding_shapes(self) -> None:
        committed = {
            "evidences": [{"ref": "apps/hr-service/src/payroll.ts:10"}],
            "scope": {"files": ["apps/hr-service/src/payroll.ts"]},
        }
        ledger_row = {
            "finding": {
                "path": "apps/sensor-service/src/ingest.ts",
                "evidence_refs": ["apps/sensor-service/src/decode.ts"],
            }
        }
        self.assertEqual(
            finding_dimension_paths(committed),
            ["apps/hr-service/src/payroll.ts:10", "apps/hr-service/src/payroll.ts"],
        )
        self.assertEqual(services_for_finding_row(committed, ROOTS), ["hr-service"])
        self.assertEqual(services_for_finding_row(ledger_row, ROOTS), ["sensor-service"])

    def test_a_stamped_row_is_read_as_stored(self) -> None:
        # Stamped against THIS map (same map fingerprint): the stored names are
        # the one owner's answer for this layout and are read as stored.
        row = {
            "services": ["auth-service"],
            "service_vocabulary": SERVICE_VOCABULARY,
            SERVICE_MAP_FINGERPRINT: ROOTS.fingerprint,
            "finding": {"path": "apps/hr-service/src/a.ts"},
        }
        self.assertEqual(services_for_finding_row(row, ROOTS), ["auth-service"])

    def test_a_stamped_row_without_a_map_fingerprint_is_re_derived(self) -> None:
        # SE-1-R2 appellate R1 (a): a stamp that names no map cannot be shown
        # to belong to the current one. It was compared None == None (a plain
        # mapping named no layout either) and read as stored.
        row = {
            "services": ["auth-service"],
            "service_vocabulary": SERVICE_VOCABULARY,
            "finding": {"path": "apps/hr-service/src/a.ts"},
        }
        self.assertEqual(services_for_finding_row(row, ROOTS), ["hr-service"])

    def test_a_row_stamped_against_another_map_is_re_derived(self) -> None:
        row = {
            "services": ["auth-service"],
            "service_vocabulary": SERVICE_VOCABULARY,
            SERVICE_MAP_FINGERPRINT: ProjectMap({"auth-service": "apps/hr-service"}).fingerprint,
            "finding": {"path": "apps/hr-service/src/a.ts"},
        }
        self.assertEqual(services_for_finding_row(row, ROOTS), ["hr-service"])

    def test_an_unstamped_row_is_re_derived_not_string_mapped(self) -> None:
        row = {
            "services": ["shared:backend-common"],
            "finding": {"path": "libs/backend-common/src/rls.ts"},
        }
        self.assertEqual(services_for_finding_row(row, ROOTS), ["backend-common"])


class TheMapIsAProjectMap(unittest.TestCase):
    """SE-1-R2 appellate R1: a stamp is only as good as the identity of the
    map it names, so attribution takes a `ProjectMap` (which fingerprints the
    map it wraps) and nothing else. A plain mapping names no map."""

    def test_a_plain_mapping_is_refused_by_the_mint(self) -> None:
        with self.assertRaisesRegex(TypeError, "ProjectMap"):
            finding_service_fields(["apps/hr-service/src/a.ts"], dict(ROOTS))

    def test_a_plain_mapping_is_refused_by_the_row_reader(self) -> None:
        row = {"finding": {"path": "apps/hr-service/src/a.ts"}}
        with self.assertRaisesRegex(TypeError, "ProjectMap"):
            services_for_finding_row(row, dict(ROOTS))

    def test_the_fingerprint_is_the_identity_of_the_wrapped_map(self) -> None:
        same = ProjectMap(dict(reversed(list(dict(ROOTS).items()))))
        renamed = ProjectMap({**dict(ROOTS), "hr": "apps/hr-service"})
        moved = ProjectMap({**dict(ROOTS), "hr-service": "apps/hr"})
        self.assertEqual(same.fingerprint, ROOTS.fingerprint)
        self.assertNotEqual(renamed.fingerprint, ROOTS.fingerprint)
        self.assertNotEqual(moved.fingerprint, ROOTS.fingerprint)


class OwnershipMapTests(unittest.TestCase):
    def test_owners_come_from_the_touch_map_ssot(self) -> None:
        owners = owning_agent_domains_for_paths(
            ["apps/farm-service/src/batch/batch.service.ts"]
        )
        self.assertIn("farm-expert", owners)

    def test_accessor_returns_a_copy(self) -> None:
        from aria_kernel.specialist_review_runner import domain_touch_map

        snapshot = domain_touch_map()
        snapshot["apps/farm-service/"] = ("tampered",)
        self.assertIn(
            "farm-expert",
            owning_agent_domains_for_paths(["apps/farm-service/src/x.ts"]),
        )


class ToolFindingMintTests(unittest.TestCase):
    def test_record_findings_for_run_mints_the_dimension(self) -> None:
        from aria_kernel.feedback_store import list_findings, record_findings_for_run
        from aria_kernel.impact_graph import cached_service_analysis_order
        from aria_kernel.tool_registry import ensure_tools_binding, ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            workspace = _fixture_workspace(
                Path(tmp) / "repo", "apps/farm-service", "apps/auth-service"
            )
            ensure_tools_binding(root, workspace_root=workspace)
            cached_service_analysis_order(workspace_root=workspace, base_dir=root)
            record_findings_for_run(
                {
                    "tool_id": "tenant-scoping-adapter",
                    "run_id": "run-e15",
                    "emitted_findings": [
                        {
                            "id": "f-1",
                            "path": "apps/farm-service/src/batch/batch.service.ts",
                            "message": "raw query without tenant predicate",
                        }
                    ],
                },
                project_roots=project_map(base_dir=root), base_dir=root,
            )
            rows = list_findings(base_dir=root)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["service"], "farm-service")
            self.assertEqual(rows[0]["services"], ["farm-service"])
            self.assertEqual(rows[0]["service_vocabulary"], SERVICE_VOCABULARY)
            # The filter finds it under its service and refuses another.
            self.assertEqual(
                len(list_findings(service="farm-service", base_dir=root)), 1
            )
            self.assertEqual(
                len(list_findings(service="auth-service", base_dir=root)), 0
            )

    def test_a_store_that_cannot_produce_a_map_refuses_the_mint(self) -> None:
        # Was test_a_store_without_a_map_mints_no_dimension: a mint with no
        # map wrote no dimension and left the row to a reader that, with no
        # map either, answered "no services". The store declares no workspace
        # and holds no publication, so it is refused by name, and nothing is
        # written.
        from aria_kernel.feedback_store import list_findings, record_findings_for_run
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            with self.assertRaisesRegex(GovernanceError, "service_key_map_unavailable"):
                record_findings_for_run(
                    {
                        "tool_id": "t",
                        "run_id": "r",
                        "emitted_findings": [
                            {"id": "f-1", "path": "apps/messaging-service/src/channel.ts",
                             "message": "m"}
                        ],
                    },
                    project_roots=project_map(base_dir=root), base_dir=root,
                )
            self.assertEqual(list_findings(base_dir=root), [])

    def test_a_store_that_cannot_produce_a_map_refuses_the_service_filter(self) -> None:
        # Was test_a_store_with_no_map_defers_attribution_to_the_reader: the
        # filter answered [] for every unstamped row, the same answer as "no
        # finding cites that service".
        from aria_kernel.feedback_store import append_jsonl, findings_path, list_findings
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            append_jsonl(
                findings_path(root),
                {
                    "schema_version": 1,
                    "tool_id": "t",
                    "run_id": "r",
                    "finding_id": "legacy-1",
                    "status": "open",
                    "finding": {"id": "legacy-1", "path": "apps/messaging-service/src/channel.ts"},
                },
            )
            # Reading the ledger needs no attribution; filtering by service does.
            self.assertEqual([r["finding_id"] for r in list_findings(base_dir=root)], ["legacy-1"])
            with self.assertRaisesRegex(GovernanceError, "service_key_map_unavailable"):
                list_findings(service="messaging-service", base_dir=root)

    def test_a_store_that_cannot_produce_a_map_refuses_finding_candidates(self) -> None:
        from aria_kernel.feedback_store import append_jsonl, findings_path
        from aria_kernel.task import generate_task_candidates
        from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            append_jsonl(
                findings_path(root),
                {
                    "schema_version": 1,
                    "tool_id": "t",
                    "run_id": "r",
                    "finding_id": "legacy-1",
                    "status": "open",
                    "finding": {"id": "legacy-1", "message": "m",
                                "path": "apps/messaging-service/src/channel.ts"},
                },
            )
            with self.assertRaisesRegex(GovernanceError, "service_key_map_unavailable"):
                generate_task_candidates(cycle_id="cycle-se1-r2", base_dir=root)


class CandidateLinkageTests(unittest.TestCase):
    def test_finding_candidate_inherits_the_dimension(self) -> None:
        from aria_kernel.task import _candidate_from_finding

        candidate = _candidate_from_finding(
            "cycle-e15",
            {
                "finding_id": "f-9",
                "tool_id": "t",
                "services": ["alert-engine"],
                "service_vocabulary": SERVICE_VOCABULARY,
                SERVICE_MAP_FINGERPRINT: ROOTS.fingerprint,
                "finding": {"message": "m", "path": "apps/alert-engine/src/x.ts"},
            },
            ROOTS,
        )
        self.assertEqual(candidate["service"], "alert-engine")
        self.assertEqual(candidate["services"], ["alert-engine"])

    def test_a_legacy_candidate_is_re_derived_over_the_map(self) -> None:
        from aria_kernel.task import _candidate_from_finding

        candidate = _candidate_from_finding(
            "cycle-e15",
            {
                "finding_id": "f-10",
                "tool_id": "t",
                "services": ["shared:event-bus"],
                "finding": {"message": "m", "path": "platform/libs/event-bus/src/bus.ts"},
            },
            ROOTS,
        )
        self.assertEqual(candidate["services"], ["event-bus"])
        self.assertEqual(candidate["service"], "event-bus")


if __name__ == "__main__":
    unittest.main()
