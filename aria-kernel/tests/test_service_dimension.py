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
mint-without-workspace map) is pinned in ``test_service_key_nx_vocabulary``.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.service_dimension import (
    SERVICE_VOCABULARY,
    finding_dimension_paths,
    finding_service_fields,
    owning_agent_domains_for_paths,
    services_for_finding_row,
)

# A project_roots map in the shape `cached_service_analysis_order`
# publishes. ``event-bus`` is the nx name of platform/libs/event-bus — a
# value the retired string vocabulary (``shared:event-bus``) never produced.
ROOTS = {
    "auth-service": "apps/auth-service",
    "billing-service": "apps/billing-service",
    "hr-service": "apps/hr-service",
    "sensor-service": "apps/sensor-service",
    "backend-common": "libs/backend-common",
    "event-bus": "platform/libs/event-bus",
}


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

    def test_a_store_without_a_map_mints_no_dimension(self) -> None:
        # No map is not "attributed to nothing": the row is left for the
        # reader to derive, instead of being stamped as measured-empty.
        self.assertEqual(finding_service_fields(["apps/hr-service/src/a.ts"], None), {})


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
        row = {
            "services": ["auth-service"],
            "service_vocabulary": SERVICE_VOCABULARY,
            "finding": {"path": "apps/hr-service/src/a.ts"},
        }
        self.assertEqual(services_for_finding_row(row, ROOTS), ["auth-service"])
        self.assertEqual(services_for_finding_row(row, None), ["auth-service"])

    def test_an_unstamped_row_is_re_derived_not_string_mapped(self) -> None:
        row = {
            "services": ["shared:backend-common"],
            "finding": {"path": "libs/backend-common/src/rls.ts"},
        }
        self.assertEqual(services_for_finding_row(row, ROOTS), ["backend-common"])
        self.assertEqual(services_for_finding_row(row, None), [])


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
        from aria_kernel.tool_registry import ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            workspace = _fixture_workspace(
                Path(tmp) / "repo", "apps/farm-service", "apps/auth-service"
            )
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
                base_dir=root,
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

    def test_a_store_with_no_map_defers_attribution_to_the_reader(self) -> None:
        from aria_kernel.feedback_store import list_findings, record_findings_for_run
        from aria_kernel.impact_graph import cached_service_analysis_order
        from aria_kernel.tool_registry import ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
            record_findings_for_run(
                {
                    "tool_id": "t",
                    "run_id": "r",
                    "emitted_findings": [
                        {"id": "f-1", "path": "apps/messaging-service/src/channel.ts", "message": "m"}
                    ],
                },
                base_dir=root,
            )
            (row,) = list_findings(base_dir=root)
            self.assertNotIn("services", row)
            self.assertNotIn("service_vocabulary", row)
            # Once the store holds a map, the reader derives the dimension
            # from the row's own paths.
            workspace = _fixture_workspace(Path(tmp) / "repo", "apps/messaging-service")
            cached_service_analysis_order(workspace_root=workspace, base_dir=root)
            rows = list_findings(service="messaging-service", base_dir=root)
            self.assertEqual([r["finding_id"] for r in rows], ["f-1"])


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
                "finding": {"message": "m", "path": "apps/alert-engine/src/x.ts"},
            },
            None,
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
