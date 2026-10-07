"""ARIA-MEDIUM-378 — every committed adapter compiles into the registry and runs its own code.

Four Plan 016 adapters (outbox, cqrs, banned-phrase, dual-alias) were
declared only as rows inside ``adapter_portfolio``. Those rows ran the no-op
``shadow_runner.py``, were written by a CLI command no workflow ran, and were
absent from every registry the cycle builds, because the manifest sync and
``registry_compiler`` read only ``tools/aria-adapters/*.tool.json``. Three of
the parsers existed and never ran outside tests; the fourth was never written.
A declared adapter that runs nothing looks exactly like one that runs and
finds nothing, so nothing noticed.

The pins, all against this checkout:

1. every manifest compiles (``registry_compiler.compile_registry``) and the
   compiled registry holds every manifest — nothing is dropped;
2. every manifest's runner resolves to an entrypoint file that exists and is
   never a stub (``registry_compiler.STUB_RUNNER_TOKENS``); the only
   exception is an adapter quarantined by name in its manifest;
3. every adapter implementation (``tools/aria-poc/*_adapter.py``,
   ``tools/aria-adapters/*-adapter.ts``) is the entrypoint of a manifest — an
   implementation with no declaration is the dead-adapter shape itself;
4. a named quarantine cites a finding the review registry holds;
5. the production door (``cycle._phase_tool_manifest_sync``) registers every
   manifest, holds the named quarantines QUARANTINED with their finding in
   the reason, leaves the rest SHADOW, and does it idempotently.
"""
from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from aria_kernel import cycle as cycle_mod
from aria_kernel.adapter_quarantine import MANIFEST_QUARANTINE_PREFIX, validate_manifest_quarantine
from aria_kernel.registry_compiler import STUB_RUNNER_TOKENS, compile_registry
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir, list_tools

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_DIR = REPO_ROOT / "tools" / "aria-adapters"
REGISTRY = REPO_ROOT / "docs" / "reviews" / "_registry" / "findings.jsonl"


def _manifests() -> list[dict]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(MANIFEST_DIR.glob("*.tool.json"))]


def _entrypoints(manifest: dict) -> list[Path]:
    runner = manifest.get("runner") or {}
    cwd = REPO_ROOT / str(runner.get("cwd") or ".")
    return [
        (cwd / arg).resolve()
        for arg in runner.get("argv") or []
        if isinstance(arg, str) and arg.endswith((".py", ".ts"))
    ]


def _implementations() -> list[Path]:
    python = sorted((REPO_ROOT / "tools" / "aria-poc").glob("*_adapter.py"))
    typescript = sorted(
        path for path in MANIFEST_DIR.glob("*-adapter.ts") if not path.name.endswith(".test.ts")
    )
    return [path.resolve() for path in python + typescript]


class CommittedAdaptersCompileAndRunTheirOwnCode(unittest.TestCase):
    def setUp(self) -> None:
        self.manifests = _manifests()

    def test_the_four_portfolio_adapters_have_manifests(self) -> None:
        ids = {manifest["tool_id"] for manifest in self.manifests}
        for tool_id in ("outbox-adapter", "cqrs-adapter", "banned-phrase-adapter", "dual-alias-adapter"):
            self.assertIn(tool_id, ids)

    def test_every_manifest_compiles_into_the_registry(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="aria-378-compile-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        compiled = compile_registry(MANIFEST_DIR, tmp / "registry.json")
        self.assertEqual(
            sorted(tool["tool_id"] for tool in compiled["tools"]),
            sorted(manifest["tool_id"] for manifest in self.manifests),
        )

    def test_every_adapter_resolves_to_a_real_entrypoint_never_the_shim(self) -> None:
        for manifest in self.manifests:
            with self.subTest(tool=manifest["tool_id"]):
                argv = [str(arg) for arg in (manifest.get("runner") or {}).get("argv") or []]
                stubbed = any(Path(arg).name in STUB_RUNNER_TOKENS for arg in argv)
                if stubbed:
                    self.assertIn("quarantine", manifest, "a stub runner is allowed only under a named quarantine")
                    continue
                entrypoints = _entrypoints(manifest)
                self.assertTrue(entrypoints, f"runner argv names no adapter source: {argv}")
                for entry in entrypoints:
                    self.assertTrue(entry.is_file(), f"{entry} does not exist")

    def test_every_adapter_implementation_is_declared_by_a_manifest(self) -> None:
        declared = {entry for manifest in self.manifests for entry in _entrypoints(manifest)}
        undeclared = [
            path.relative_to(REPO_ROOT).as_posix() for path in _implementations() if path not in declared
        ]
        self.assertEqual(undeclared, [])

    def test_a_named_quarantine_cites_a_registered_finding(self) -> None:
        registered = {
            json.loads(line)["id"]
            for line in REGISTRY.read_text(encoding="utf-8").splitlines()
            if line.strip()
        }
        for manifest in self.manifests:
            if "quarantine" not in manifest:
                continue
            with self.subTest(tool=manifest["tool_id"]):
                block = validate_manifest_quarantine(manifest["quarantine"], tool_id=manifest["tool_id"])
                self.assertIn(block["finding"], registered)

    def test_a_quarantine_without_a_finding_is_refused_at_the_gate(self) -> None:
        with self.assertRaises(GovernanceError):
            validate_manifest_quarantine({"reason": "no finding"}, tool_id="tool-x")
        with self.assertRaises(GovernanceError):
            validate_manifest_quarantine({"finding": "not-an-id", "reason": "r"}, tool_id="tool-x")


class ManifestSyncRegistersEveryAdapter(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-378-sync-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.tools = ensure_tools_dir(self.tmp / "aria-tools")

    def _sync(self, cycle_id: str) -> dict:
        context = cycle_mod.build_phase_context(
            cycle_id=cycle_id, workspace_root=REPO_ROOT, base_dir=self.tools,
        )
        return cycle_mod._phase_tool_manifest_sync(context)

    def test_every_manifest_is_registered_and_named_quarantines_hold(self) -> None:
        manifests = {manifest["tool_id"]: manifest for manifest in _manifests()}
        first = self._sync("cyc-378-a")
        self.assertEqual(first["refused"], [])
        registered = {tool["tool_id"]: tool for tool in list_tools(base_dir=self.tools)}
        self.assertEqual(sorted(registered), sorted(manifests))
        named = sorted(tool_id for tool_id, manifest in manifests.items() if "quarantine" in manifest)
        self.assertEqual(sorted(row["tool_id"] for row in first["quarantined_by_manifest"]), named)
        for tool_id, tool in registered.items():
            with self.subTest(tool=tool_id):
                if tool_id in named:
                    self.assertEqual(tool["status"], "QUARANTINED")
                    reason = tool["last_transition"]["reason"]
                    self.assertTrue(reason.startswith(MANIFEST_QUARANTINE_PREFIX))
                    self.assertIn(manifests[tool_id]["quarantine"]["finding"], reason)
                else:
                    self.assertEqual(tool["status"], "SHADOW")
        second = self._sync("cyc-378-b")
        self.assertEqual(second["quarantined_by_manifest"], [])
        self.assertEqual(
            {tool["tool_id"]: tool["status"] for tool in list_tools(base_dir=self.tools)},
            {tool_id: tool["status"] for tool_id, tool in registered.items()},
        )


if __name__ == "__main__":
    unittest.main()
