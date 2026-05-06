from __future__ import annotations

import argparse
import tempfile
import unittest
from pathlib import Path

from aria_kernel.feedback import (
    SURFACE_PREFIXES,
    SURFACE_ROOT_FILE_GLOBS,
    add_feedback,
    build_feedback_event,
    capability_gap_key,
    infer_surface,
    list_feedback,
)
from aria_kernel.ledger import LedgerIntegrityError, read_jsonl
from aria_kernel.workspace import ensure_workspace, workspace_paths


def args(**overrides):
    base = {
        "kind": "missed_signal",
        "summary": "dynamic options were not traced",
        "ref": "web/modules/hr-module/src/pages/example.tsx:10",
        "concept": "LeaveRequestStatus",
        "source": "operator",
        "surface": "frontend",
        "failure_mode": "dynamic_option_provider",
        "parser_kind": "typescript",
        "capability_gap_key": None,
    }
    base.update(overrides)
    return argparse.Namespace(**base)


class FeedbackLoopTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.workspace_base = self.base / "workspaces"
        self.paths = workspace_paths(self.repo, self.workspace_base)
        ensure_workspace(self.paths)

    def tearDown(self):
        self.tmp.cleanup()

    def test_capability_gap_key_is_stable_slug(self):
        self.assertEqual(
            capability_gap_key("Frontend UI", "Dynamic Option Provider", "TypeScript/JSX"),
            "frontend_ui:dynamic_option_provider:typescript_jsx",
        )

    def test_missed_signal_is_untrusted_and_recorded(self):
        event = build_feedback_event(args())
        emitted = add_feedback(self.paths, event)

        self.assertEqual(emitted, [])
        records = read_jsonl(self.paths.ledgers["missed_signals"])
        self.assertEqual(len(records), 1)
        self.assertFalse(records[0]["trusted"])
        self.assertEqual(records[0]["kind"], "missed_signal")

    def test_one_missed_signal_does_not_create_pressure(self):
        add_feedback(self.paths, build_feedback_event(args(ref="web/modules/hr-module/src/a.tsx:1")))

        self.assertEqual(read_jsonl(self.paths.ledgers["pressure"]), [])

    def test_three_independent_missed_signals_create_repetition_pressure(self):
        for ref in ["web/modules/hr-module/src/a.tsx:1", "web/modules/hr-module/src/b.tsx:2", "web/apps/aquamobil/src/c.ts:3"]:
            add_feedback(self.paths, build_feedback_event(args(ref=ref)))

        pressure = read_jsonl(self.paths.ledgers["pressure"])
        self.assertEqual(len(pressure), 1)
        self.assertEqual(pressure[0]["primitive"], "REPETITION")
        self.assertEqual(pressure[0]["drives"], ["skill_birth"])

    def test_three_unknown_capabilities_create_unknown_pressure(self):
        for ref in ["web/modules/hr-module/src/a.tsx:1", "web/modules/hr-module/src/b.tsx:2", "web/apps/aquamobil/src/c.ts:3"]:
            add_feedback(self.paths, build_feedback_event(args(kind="unknown_capability", ref=ref)))

        pressure = read_jsonl(self.paths.ledgers["pressure"])
        self.assertEqual(len(pressure), 1)
        self.assertEqual(pressure[0]["primitive"], "UNKNOWN")
        self.assertEqual(pressure[0]["drives"], ["adapter_birth"])

    def test_external_contradiction_creates_investigation_pressure(self):
        event = build_feedback_event(
            args(
                kind="external_contradiction",
                source="external_scanner",
                summary="external scan found a drift ARIA suppressed",
            )
        )
        emitted = add_feedback(self.paths, event)

        self.assertEqual(len(emitted), 1)
        self.assertEqual(emitted[0]["primitive"], "CONTRADICTION")
        self.assertEqual(emitted[0]["drives"], ["investigation_task"])

    def test_false_positive_feedback_drives_calibration_not_skill_birth(self):
        for ref in ["apps/a.ts:1", "apps/b.ts:2", "apps/c.ts:3"]:
            add_feedback(
                self.paths,
                build_feedback_event(
                    args(
                        kind="false_positive",
                        summary="framework convention, not drift",
                        ref=ref,
                        surface="backend",
                        failure_mode="framework_convention_false_positive",
                    )
                ),
            )

        pressure = read_jsonl(self.paths.ledgers["pressure"])
        self.assertEqual(len(pressure), 1)
        self.assertEqual(pressure[0]["drives"], ["calibration"])
        self.assertNotIn("skill_birth", pressure[0]["drives"])

    def test_external_feedback_is_listed_by_kind(self):
        add_feedback(self.paths, build_feedback_event(args(kind="confirmed_signal", source="external_scanner")))

        listed = list_feedback(self.paths, "confirmed_signal")
        self.assertEqual(len(listed), 1)
        self.assertFalse(listed[0]["trusted"])

    def test_ledger_mutation_is_detected(self):
        add_feedback(self.paths, build_feedback_event(args()))
        self.paths.ledgers["missed_signals"].write_text("", encoding="utf-8")

        with self.assertRaises(LedgerIntegrityError):
            list_feedback(self.paths)


class CliShapeTests(unittest.TestCase):
    def test_feedback_event_schema_contains_required_fields(self):
        event = build_feedback_event(args())
        self.assertEqual(event["$schema"], "aria/feedback-event/v2")
        self.assertIn("capability_gap_key", event)
        self.assertIn("evidence_refs", event)
        self.assertEqual(event["schema_version"], 2)


class SurfaceInferenceTests(unittest.TestCase):
    """ARIA v13 Phase-1: 4-tier surface resolution (override→exact→prefix→repo).

    Test invariants per plan v13:
      - every declared prefix maps to its expected surface
      - exact root-file matches (Dockerfile*, docker-compose*.yml) precede prefix iteration
      - longest/most-specific prefix wins (platform/libs/ before libs/)
      - trailing-slash optional on prefix paths
      - unmapped root files fall back to "repo"
      - line-suffix (":42") on refs does not break inference
    """

    def test_every_declared_prefix_maps_to_expected_surface(self):
        cases = {
            # platform layer
            "platform/libs/cqrs/src/bus.ts:1": "platform",
            # shared lib (must NOT be shadowed by platform/libs/)
            "libs/backend-common/src/foo.ts:1": "shared_lib",
            # ARIA itself
            "aria-kernel/aria_kernel/cli.py:1": "aria",
            "aria-tools/runs.jsonl:1": "aria",
            # agent runtime
            "agents/auth-validator.md:1": "agent_runtime",
            "agent-workspace/seed_hints.md:1": "agent_runtime",
            # mcp / edge / tooling / test / infra
            "mcp/aquaculture/src/server.ts:1": "integration",
            "sens-api-gateway/src/main.rs:1": "edge",
            "tools/aria-poc/foo.py:1": "tooling",
            "scripts/deploy.sh:1": "tooling",
            "e2e/tests/foo.spec.ts:1": "test",
            "tests/integration/bar.spec.ts:1": "test",
            "infra/terraform/main.tf:1": "infra",
            "infrastructure/droplet/variables.tf:1": "infra",
            ".github/workflows/ci.yml:1": "infra",
            "deploy/k8s.yaml:1": "infra",
            "nginx/site.conf:1": "infra",
            "database/seed.sql:1": "infra",
            # frontend / backend
            "web/modules/hr-module/src/page.tsx:1": "frontend",
            "apps/farm-service/src/foo.ts:1": "backend",
        }
        for ref, expected in cases.items():
            with self.subTest(ref=ref):
                self.assertEqual(infer_surface(ref), expected)

    def test_exact_root_file_match_runs_before_prefix(self):
        # Dockerfile sits at repo root; prefix list does not contain "Dockerfile",
        # so without exact-match tier this would fall through to "repo".
        for ref in ("Dockerfile", "Dockerfile.dev", "Dockerfile.prod:1"):
            with self.subTest(ref=ref):
                self.assertEqual(infer_surface(ref), "infra")
        for ref in ("docker-compose.yml", "docker-compose.dev.yml", "docker-compose.prod.yaml"):
            with self.subTest(ref=ref):
                self.assertEqual(infer_surface(ref), "infra")

    def test_root_file_glob_does_not_match_nested_path(self):
        # Exact-match tier must only fire for one-segment paths.
        # apps/Dockerfile is inside apps/ and should map to "backend", not "infra".
        self.assertEqual(infer_surface("apps/farm-service/Dockerfile"), "backend")

    def test_longest_prefix_wins(self):
        # platform/libs/ must shadow libs/.
        self.assertEqual(infer_surface("platform/libs/cqrs/src/bus.ts"), "platform")
        self.assertNotEqual(infer_surface("platform/libs/cqrs/src/bus.ts"), "shared_lib")

    def test_trailing_slash_is_optional(self):
        self.assertEqual(infer_surface("apps/farm-service"), "backend")
        self.assertEqual(infer_surface("apps/farm-service/"), "backend")

    def test_unmapped_root_files_fall_back_to_repo(self):
        for ref in ("Cargo.toml", "package.json", "README.md", "LICENSE", "pyproject.toml:1"):
            with self.subTest(ref=ref):
                self.assertEqual(infer_surface(ref), "repo")

    def test_unknown_top_level_directory_falls_back_to_repo(self):
        self.assertEqual(infer_surface("nonexistent-top/inner/foo.ts:1"), "repo")

    def test_line_suffix_does_not_affect_inference(self):
        self.assertEqual(infer_surface("apps/foo.ts"), infer_surface("apps/foo.ts:42"))

    def test_explicit_override_at_caller_wins(self):
        # The override is applied at build_feedback_event, not infer_surface itself.
        # Verify the integration: passing surface=... bypasses inference entirely.
        event = build_feedback_event(args(surface="custom_override", ref="apps/x.ts:1"))
        self.assertTrue(event["capability_gap_key"].startswith("custom_override:"))


class SurfacePrefixOrderingTests(unittest.TestCase):
    """Static invariants on the SURFACE_PREFIXES ordering — protect against accidental reordering."""

    def test_platform_libs_appears_before_libs(self):
        prefixes = [p for p, _ in SURFACE_PREFIXES]
        self.assertLess(prefixes.index("platform/libs/"), prefixes.index("libs/"))

    def test_all_prefixes_have_trailing_slash(self):
        for prefix, _ in SURFACE_PREFIXES:
            with self.subTest(prefix=prefix):
                self.assertTrue(prefix.endswith("/"), f"prefix {prefix!r} must end with '/'")

    def test_root_file_globs_are_one_segment(self):
        for pattern, _ in SURFACE_ROOT_FILE_GLOBS:
            with self.subTest(pattern=pattern):
                self.assertNotIn("/", pattern, f"root-file glob {pattern!r} must be one-segment")


if __name__ == "__main__":
    unittest.main()
