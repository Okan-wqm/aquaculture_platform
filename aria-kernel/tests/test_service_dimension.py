"""E15-a/b — findings carry a service dimension (operator direction).

Findings were organised by TOOL; the operator runs a 17-service platform
and needs them organised by SERVICE so per-service audits, service
missions and (later) service-specific genesis agents have an axis to
stand on. These pin the derivation seam, both mint points, both read
filters and the candidate linkage.

H-2 — the repository had TWO path vocabularies. This module recognised
``apps``/``libs``/``platform/libs``/``web`` and dropped everything else,
while a complete, CI-pinned path -> owner map already existed in
``.claude/shared/orchestrator-routing-table.md``. The classes below pin
the merge: the product half byte-identical (its names are ledger filter
values and experiment targets), every routing-named surface no longer
None, the residue measured, and the kernel surface structurally
unreachable from the product implementation lane.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from aria_kernel.service_dimension import (
    _SURFACE_PREFIX_RE,
    finding_dimension_paths,
    is_product_service,
    owning_agent_domains_for_paths,
    service_dimension,
    service_for_path,
    services_for_paths,
    unmapped_surfaces,
)

_REPO_ROOT = Path(__file__).resolve().parents[2]


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

    def test_absolute_and_unnamed_paths_have_no_dimension(self) -> None:
        self.assertIsNone(service_for_path("/etc/passwd"))
        self.assertIsNone(service_for_path(""))
        self.assertIsNone(service_for_path(None))
        # ``crates/`` is the live routing-coverage gap: 153 tracked files,
        # no row in the routing table. It stays None because NO SSoT names
        # it — the fix is a routing row, not a second vocabulary here.
        self.assertIsNone(service_for_path("crates/alarm-core/src/lib.rs"))
        # ``docs/adr/`` used to sit in this list. It is not foreign at all:
        # the routing table has owned it (architectural-arbiter) the whole
        # time, and the old vocabulary simply could not read that map.
        self.assertEqual(service_for_path("docs/adr/ADR-011.md"), "architectural:adr")


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

    def test_one_pass_over_a_generator(self) -> None:
        # ``paths`` is typed Iterable; walking it twice (once for the named
        # dimensions, once for the residue) would hand the second walk an
        # exhausted generator and report an empty residue as if every path
        # had been named.
        dim = service_dimension(
            iter(["apps/hr-service/src/a.ts", "crates/alarm-core/src/lib.rs"])
        )
        self.assertEqual(dim["services"], ["hr-service"])
        self.assertEqual(dim["unmapped_surfaces"], ["crates"])

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


class ProductNameRegressionTests(unittest.TestCase):
    """The product half of the vocabulary is byte-identical across H-2.

    These strings are not cosmetic: ``feedback_store`` stores them as the
    ledger's ``service``/``services`` tag AND filters on them,
    ``experiment_author`` interpolates one into ``nx run-many --projects=``,
    and ``finding.py`` writes them into every committed finding. A rename
    here silently unfiles every finding minted before it.
    """

    CASES = (
        ("apps/farm-service/src/batch/batch.service.ts", "farm-service"),
        ("apps/auth-service/src/auth.guard.ts:42-60", "auth-service"),
        ("./apps/billing-service/src/stripe.ts", "billing-service"),
        ("apps/db-migrate/src/main.ts", "db-migrate"),
        ("libs/backend-common/src/audit/x.ts", "shared:backend-common"),
        ("libs/event-contracts/src/index.ts", "shared:event-contracts"),
        ("platform/libs/event-bus/src/bus.ts", "shared:event-bus"),
        ("platform/libs/outbox/src/o.ts", "shared:outbox"),
        ("web/modules/farm-module/src/App.tsx", "web:farm-module"),
        ("web/modules/tenant-admin/src/A.tsx", "web:tenant-admin"),
        ("web/apps/aquamobil/src/main.tsx", "web:aquamobil"),
        ("web/shell/src/main.tsx", "web:shell"),
        ("web/shared-ui/src/Modal.tsx", "web:shared-ui"),
    )

    def test_existing_names_are_unchanged(self) -> None:
        for path, expected in self.CASES:
            with self.subTest(path=path):
                self.assertEqual(service_for_path(path), expected)

    def test_only_a_product_service_is_colon_free(self) -> None:
        # The whole safety property in one line: an implementation lane asks
        # ``is_product_service`` and can never be handed a non-product
        # surface, however many surface kinds appear later.
        for path, expected in self.CASES:
            with self.subTest(path=path):
                self.assertEqual(
                    is_product_service(expected),
                    expected.startswith("apps") or ":" not in expected,
                )
        self.assertTrue(is_product_service("farm-service"))
        self.assertFalse(is_product_service("shared:backend-common"))
        self.assertFalse(is_product_service("edge:sens-api-gateway"))
        self.assertFalse(is_product_service(None))


class RoutingDerivedSurfaceTests(unittest.TestCase):
    """Every surface the routing SSoT names now HAS a dimension."""

    def test_no_surface_the_routing_table_owns_returns_none(self) -> None:
        from aria_kernel.agent_routing import load_routing_table, pattern_surface

        rows = load_routing_table(_REPO_ROOT)
        self.assertTrue(rows, "routing table unreadable — the SSoT moved")
        probed = 0
        for row in rows:
            if not row["primary"]:
                continue
            for glob in row["globs"]:
                literal, mode = pattern_surface(glob)
                if not literal or not _SURFACE_PREFIX_RE.match(literal):
                    continue
                if mode == "exact":
                    probe = literal
                elif mode == "dir":
                    probe = f"{literal}/probe.ts"
                else:
                    probe = f"{literal}-probe"
                probed += 1
                with self.subTest(glob=glob, probe=probe):
                    self.assertIsNotNone(
                        service_for_path(probe),
                        f"{probe!r} matches the routing table yet has no dimension",
                    )
        self.assertGreater(probed, 50)

    def test_the_surfaces_that_used_to_vanish(self) -> None:
        self.assertEqual(
            service_for_path("sens-api-gateway/src/main.rs"), "edge:sens-api-gateway"
        )
        self.assertEqual(service_for_path("tests/invariants/x.spec.ts"), "test:tests")
        self.assertEqual(service_for_path("e2e/tests/login.spec.ts"), "test:e2e")
        self.assertEqual(service_for_path("mcp/server.ts"), "mcp:mcp")
        self.assertEqual(service_for_path("deploy/render.sh"), "infra:deploy")
        self.assertEqual(service_for_path("database/migrations/001.sql"), "data:migrations")
        self.assertEqual(service_for_path("platform/configs/tsconfig.json"), "platform-kernel:configs")

    def test_longest_literal_wins(self) -> None:
        # The specific owner beats the containing surface — otherwise every
        # monitoring finding files under the infra bucket.
        self.assertEqual(
            service_for_path("infrastructure/monitoring/prometheus.yml"),
            "observability:monitoring",
        )
        self.assertEqual(
            service_for_path("infrastructure/docker/nats/nats.conf"),
            "infra:infrastructure",
        )

    def test_a_literal_never_swallows_a_sibling_tree(self) -> None:
        # ``infra`` is a string prefix of ``infrastructure``; a raw
        # startswith would file every infrastructure finding under infra.
        self.assertEqual(service_for_path("infra/terraform/main.tf"), "infra:infra")
        self.assertEqual(
            service_for_path("infrastructure/nats/services.yaml"), "infra:infrastructure"
        )

    def test_a_stem_glob_matches_its_sibling_files(self) -> None:
        # ``docker-compose*`` / ``.env*`` name a filename stem, not a folder.
        self.assertEqual(service_for_path("docker-compose.droplet.yml"), "infra:docker-compose")
        self.assertEqual(service_for_path("Cargo.toml"), "edge:Cargo.toml")

    def test_the_dimension_is_read_from_the_table_not_copied(self) -> None:
        # Point the derivation at a repo whose table names a surface this
        # one does not have: if the dimension still came from a local list,
        # this returns None.
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            (root / ".claude" / "shared").mkdir(parents=True)
            (root / ".claude" / "shared" / "orchestrator-routing-table.md").write_text(
                "# t\n"
                "| File Pattern | Primary Agent | Also Notify |\n"
                "|---|---|---|\n"
                "| `ghost-surface/**` | edge-expert | |\n"
                "| `ghost-surface/deep/**` | sensor-expert | |\n",
                encoding="utf-8",
            )
            self.assertEqual(
                service_for_path("ghost-surface/a.rs", repo_root=root),
                "edge:ghost-surface",
            )
            self.assertEqual(
                service_for_path("ghost-surface/deep/a.rs", repo_root=root),
                "sensor:deep",
            )
            # the product half is answered before the table is even read
            self.assertEqual(
                service_for_path("apps/farm-service/x.ts", repo_root=root),
                "farm-service",
            )

    def test_the_residue_is_measured_not_silent(self) -> None:
        paths = [
            "apps/farm-service/src/x.ts",
            "crates/alarm-core/src/lib.rs",
            "crates/nats-client/src/lib.rs",
            "agents/superadmin-audit/x.ts",
            "/etc/passwd",
        ]
        self.assertEqual(unmapped_surfaces(paths), ["agents", "crates"])
        self.assertEqual(unmapped_surfaces(["sens-api-gateway/src/main.rs"]), [])
        envelope = service_dimension(paths)
        self.assertEqual(envelope["services"], ["farm-service"])
        self.assertEqual(envelope["unmapped_surfaces"], ["agents", "crates"])


class KernelSurfaceTests(unittest.TestCase):
    """The kernel surface is named — and is unreachable from the product lane."""

    def test_kernel_paths_name_the_kernel_surface(self) -> None:
        self.assertEqual(
            service_for_path("aria-kernel/aria_kernel/cycle.py"), "kernel:aria_kernel"
        )
        self.assertEqual(
            service_for_path("aria-kernel/tests/test_cycle.py"), "kernel:tests"
        )
        self.assertEqual(service_for_path("tools/aria-poc/poc.py"), "kernel:aria-poc")

    def test_no_readonly_path_is_product_routable(self) -> None:
        # READONLY_PATHS is the closed set the product implementer may not
        # mutate. Pinning the dimension against that SSoT means a new entry
        # there cannot open a route to the product lane by accident.
        from aria_kernel.implementation_safety import READONLY_PATHS

        for entry in READONLY_PATHS:
            literal = entry.rstrip("/")
            probe = f"{literal}/probe.py" if entry.endswith("/") else literal
            with self.subTest(readonly=entry):
                dimension = service_for_path(probe)
                self.assertIsNotNone(
                    dimension, f"{probe!r} is a kernel surface with no dimension"
                )
                self.assertFalse(
                    is_product_service(dimension),
                    f"{probe!r} resolved to product service {dimension!r}",
                )


if __name__ == "__main__":
    unittest.main()
