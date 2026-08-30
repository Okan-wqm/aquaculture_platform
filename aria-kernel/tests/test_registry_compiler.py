from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from aria_kernel.registry_compiler import compile_registry
from aria_kernel.tool_registry import (
    DEFAULT_FRESHNESS_WINDOW_HOURS,
    GovernanceError,
    parse_window_signature,
)


def _manifest(tool_id: str, argv: list[str] | None = None) -> dict[str, object]:
    return {
        "tool_id": tool_id,
        "kind": "adapter",
        "version": "1.0.0",
        "status": "SHADOW",
        "declared_scope": ["apps/**/*.ts"],
        "output_schema": {
            "type": "object",
            "required": ["observations", "findings", "read_paths", "evidence_sources"],
        },
        "fixture_set": f"tools/aria-adapters/fixtures/{tool_id}",
        "health_thresholds": {"max_cost_units": 100},
        "allowed_read_globs": ["apps/**/*.ts"],
        "forbidden_read_globs": [".git/**", "node_modules/**"],
        "claim_types": ["test_claim"],
        "owner": "platform",
        "runner": {
            "type": "subprocess",
            "argv": argv or ["python3", "real_adapter.py"],
            "cwd": "tools/aria-poc",
            "timeout_ms": 1000,
            "stdin_json": True,
        },
        "schema_version": 1,
    }


class RegistryCompilerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-registry-compiler-"))
        self.adapters = self.tmp / "tools" / "aria-adapters"
        self.adapters.mkdir(parents=True)
        self.output = self.tmp / "aria-tools" / "registry.json"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_manifest(self, tool_id: str, argv: list[str] | None = None) -> None:
        (self.adapters / f"{tool_id}.tool.json").write_text(
            json.dumps(_manifest(tool_id, argv), indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def test_compiles_manifests_deterministically(self) -> None:
        self._write_manifest("b-adapter")
        self._write_manifest("a-adapter")
        registry = compile_registry(self.adapters, self.output)
        self.assertEqual([tool["tool_id"] for tool in registry["tools"]], ["a-adapter", "b-adapter"])
        self.assertEqual(json.loads(self.output.read_text(encoding="utf-8")), registry)
        checked = compile_registry(self.adapters, self.output, check=True)
        self.assertEqual(checked, registry)

    def test_normalizes_ts_node_runner(self) -> None:
        self._write_manifest(
            "ts-adapter",
            ["npx", "ts-node", "--project", "tools/gates/tsconfig.json", "tools/aria-adapters/x.ts"],
        )
        registry = compile_registry(self.adapters, self.output)
        argv = registry["tools"][0]["runner"]["argv"]
        self.assertEqual(argv[:2], ["node", "./node_modules/ts-node/dist/bin.js"])

    def test_check_detects_registry_drift(self) -> None:
        self._write_manifest("real-adapter")
        compile_registry(self.adapters, self.output)
        payload = json.loads(self.output.read_text(encoding="utf-8"))
        payload["tools"][0]["owner"] = "drifted"
        self.output.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        with self.assertRaisesRegex(GovernanceError, "registry_drift"):
            compile_registry(self.adapters, self.output, check=True)

    def test_stub_runner_rejected(self) -> None:
        self._write_manifest("stub-adapter", ["python3", "shadow_runner.py", "stub-adapter"])
        with self.assertRaisesRegex(GovernanceError, "stub_runner_rejected"):
            compile_registry(self.adapters, self.output)


class FreshnessMetadataCompileTests(unittest.TestCase):
    """E13-C11 — freshness fields are manifest-owned and survive recompiles.

    The original defect: parse_window_signature + freshness_window_hours
    were patched onto registry rows at RUNTIME and every compile_registry
    run rebuilt the registry from the manifests, deleting them. These are
    the deliberate-break pins for that defect: compile is now the
    PRODUCER of the fields (validator defaults/derives them), so the
    deleting path no longer exists.
    """

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-registry-freshness-"))
        self.adapters = self.tmp / "tools" / "aria-adapters"
        self.adapters.mkdir(parents=True)
        self.output = self.tmp / "aria-tools" / "registry.json"

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, manifest: dict[str, object]) -> None:
        (self.adapters / f"{manifest['tool_id']}.tool.json").write_text(
            json.dumps(manifest, indent=2, sort_keys=True),
            encoding="utf-8",
        )

    def test_explicit_manifest_fields_survive_compile_and_recompile(self) -> None:
        manifest = _manifest("fresh-adapter")
        manifest["freshness_window_hours"] = 24
        manifest["parse_window_signature"] = parse_window_signature(manifest)
        self._write(manifest)
        first = compile_registry(self.adapters, self.output)
        # Recompile from the same manifests — the original defect deleted
        # runtime-patched fields exactly here.
        second = compile_registry(self.adapters, self.output)
        for registry in (first, second):
            row = registry["tools"][0]
            self.assertEqual(row["freshness_window_hours"], 24)
            self.assertEqual(row["parse_window_signature"], manifest["parse_window_signature"])
        # check-mode agrees: the on-disk registry matches the manifests.
        compile_registry(self.adapters, self.output, check=True)

    def test_defaults_applied_when_manifest_lacks_fields(self) -> None:
        manifest = _manifest("default-adapter")
        self._write(manifest)
        registry = compile_registry(self.adapters, self.output)
        row = registry["tools"][0]
        self.assertEqual(row["freshness_window_hours"], DEFAULT_FRESHNESS_WINDOW_HOURS)
        self.assertEqual(row["parse_window_signature"], parse_window_signature(manifest))

    def test_wrong_type_freshness_window_rejected(self) -> None:
        for bad in ("168", 0, -5, True):
            with self.subTest(bad=bad):
                manifest = _manifest("bad-freshness-adapter")
                manifest["freshness_window_hours"] = bad
                self._write(manifest)
                with self.assertRaisesRegex(GovernanceError, "freshness_window_hours"):
                    compile_registry(self.adapters, self.output)

    def test_stale_parse_window_signature_rejected(self) -> None:
        manifest = _manifest("stale-sig-adapter")
        # Signature computed over a DIFFERENT parse window: the manifest's
        # declaration drifted after the signature was recorded.
        manifest["parse_window_signature"] = parse_window_signature(
            {"declared_scope": ["some/other/**/*.ts"], "claim_types": ["other"]}
        )
        self._write(manifest)
        with self.assertRaisesRegex(GovernanceError, "parse_window_signature_mismatch"):
            compile_registry(self.adapters, self.output)

    def test_empty_parse_window_signature_rejected(self) -> None:
        manifest = _manifest("empty-sig-adapter")
        manifest["parse_window_signature"] = "  "
        self._write(manifest)
        with self.assertRaisesRegex(GovernanceError, "parse_window_signature must be a non-empty string"):
            compile_registry(self.adapters, self.output)


if __name__ == "__main__":
    unittest.main()
