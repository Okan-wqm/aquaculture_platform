"""E15-a/b — findings carry a service dimension (operator direction).

Findings were organised by TOOL; the operator runs a 17-service platform
and needs them organised by SERVICE so per-service audits, service
missions and (later) service-specific genesis agents have an axis to
stand on. These pin the derivation seam, both mint points, both read
filters and the candidate linkage.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.service_dimension import (
    finding_dimension_paths,
    owning_agent_domains_for_paths,
    service_dimension,
    service_for_path,
    services_for_paths,
)


class ServiceForPathTests(unittest.TestCase):
    def test_apps_path_names_the_service(self) -> None:
        self.assertEqual(
            service_for_path("apps/farm-service/src/batch/batch.service.ts"),
            "farm-service",
        )

    def test_line_suffix_is_tolerated(self) -> None:
        self.assertEqual(
            service_for_path("apps/auth-service/src/auth.guard.ts:42-60"),
            "auth-service",
        )

    def test_shared_lib_and_platform_lib(self) -> None:
        self.assertEqual(
            service_for_path("libs/backend-common/src/audit/x.ts"),
            "shared:backend-common",
        )
        self.assertEqual(
            service_for_path("platform/libs/event-bus/src/bus.ts"),
            "shared:event-bus",
        )

    def test_web_surfaces(self) -> None:
        self.assertEqual(
            service_for_path("web/modules/farm-module/src/App.tsx"),
            "web:farm-module",
        )
        self.assertEqual(
            service_for_path("web/apps/aquamobil/src/main.tsx"),
            "web:aquamobil",
        )
        self.assertEqual(service_for_path("web/shell/src/main.tsx"), "web:shell")

    def test_absolute_and_foreign_paths_have_no_dimension(self) -> None:
        self.assertIsNone(service_for_path("/etc/passwd"))
        self.assertIsNone(service_for_path("docs/adr/ADR-011.md"))
        self.assertIsNone(service_for_path(""))
        self.assertIsNone(service_for_path(None))


class DimensionEnvelopeTests(unittest.TestCase):
    def test_single_service_sets_scalar(self) -> None:
        dim = service_dimension(["apps/billing-service/src/a.ts", "apps/billing-service/src/b.ts"])
        self.assertEqual(dim["service"], "billing-service")
        self.assertEqual(dim["services"], ["billing-service"])

    def test_multi_service_keeps_scalar_none(self) -> None:
        # Collapsing a cross-service finding to one service would misfile
        # exactly the defect class the relation work later builds on.
        dim = service_dimension(
            ["apps/billing-service/src/a.ts", "apps/auth-service/src/b.ts"]
        )
        self.assertIsNone(dim["service"])
        self.assertEqual(dim["services"], ["auth-service", "billing-service"])

    def test_dimension_paths_cover_both_finding_shapes(self) -> None:
        committed = {
            "evidences": [{"ref": "apps/hr-service/src/payroll.ts:10"}],
            "scope": {"files": ["apps/hr-service/src/payroll.ts"]},
        }
        tool_shaped = {
            "path": "apps/sensor-service/src/ingest.ts",
            "evidence_refs": ["apps/sensor-service/src/decode.ts"],
        }
        self.assertEqual(
            services_for_paths(finding_dimension_paths(committed)), ["hr-service"]
        )
        self.assertEqual(
            services_for_paths(finding_dimension_paths(tool_shaped)),
            ["sensor-service"],
        )


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
        from aria_kernel.tool_registry import ensure_tools_dir

        with tempfile.TemporaryDirectory() as tmp:
            root = ensure_tools_dir(Path(tmp) / "aria-tools")
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
            # The filter finds it under its service and refuses another.
            self.assertEqual(
                len(list_findings(service="farm-service", base_dir=root)), 1
            )
            self.assertEqual(
                len(list_findings(service="auth-service", base_dir=root)), 0
            )

    def test_legacy_row_derives_dimension_at_read_time(self) -> None:
        from aria_kernel.feedback_store import (
            append_jsonl,
            findings_path,
            list_findings,
        )
        from aria_kernel.tool_registry import ensure_tools_dir

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
                    "finding": {
                        "id": "legacy-1",
                        "path": "apps/messaging-service/src/channel.ts",
                    },
                },
            )
            rows = list_findings(service="messaging-service", base_dir=root)
            self.assertEqual([r["finding_id"] for r in rows], ["legacy-1"])


class CandidateLinkageTests(unittest.TestCase):
    def test_finding_candidate_inherits_the_dimension(self) -> None:
        from aria_kernel.task import _candidate_from_finding

        candidate = _candidate_from_finding(
            "cycle-e15",
            {
                "finding_id": "f-9",
                "tool_id": "t",
                "services": ["alert-engine"],
                "finding": {"message": "m", "path": "apps/alert-engine/src/x.ts"},
            },
        )
        self.assertEqual(candidate["service"], "alert-engine")
        self.assertEqual(candidate["services"], ["alert-engine"])


if __name__ == "__main__":
    unittest.main()
