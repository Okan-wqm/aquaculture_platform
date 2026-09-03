"""Plan 033 Faz 033a — Repository Security Profile: deterministic, provenance-tagged, inert.

Invariants:
  I-V13-SECPROF-01  the compiler is deterministic (same repo SHA + tree → same digest)
                    and content-addressed.
  I-V13-SECPROF-02  every claim carries a closed provenance; the profile carries NO
                    attack authorization / never_touch field (it answers "what exists").
  I-V13-SECPROF-03  isolation_strategy is inferred from the tree (schema+RLS → hybrid);
                    Django absence is recorded so a django pack is never selected here.
  I-V13-SECPROF-04  a bounded compile does not read the whole monorepo (glob caps).
  I-V13-SECPROF-05  record → declared surface; latest_profile returns it.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import profile as sp
from aria_kernel.tool_registry import ensure_tools_dir


def _fixture(root: Path) -> None:
    (root / "apps" / "auth-service").mkdir(parents=True)
    (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1","@apollo/subgraph":"1","typeorm":"1","react-dom":"1"}}', encoding="utf-8")
    (root / "apps" / "auth-service" / "schema.sql").write_text("CREATE SCHEMA tenant_a;\nALTER TABLE t ENABLE ROW LEVEL SECURITY;", encoding="utf-8")
    (root / "apps" / "auth-service" / "repo.ts").write_text("export const r = getScopedRepository(X);", encoding="utf-8")
    (root / ".mcp.json").write_text("{}", encoding="utf-8")


class ProfileCompiler(unittest.TestCase):
    def test_I_V13_SECPROF_01_deterministic_content_addressed(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            _fixture(root)
            a = sp.compile_profile(workspace_root=root, repo_sha="sha-1")
            b = sp.compile_profile(workspace_root=root, repo_sha="sha-1")
            self.assertEqual(a.profile_digest, b.profile_digest)
            self.assertTrue(a.profile_digest.startswith("sha256:"))
            c = sp.compile_profile(workspace_root=root, repo_sha="sha-2")
            self.assertNotEqual(a.profile_digest, c.profile_digest, "repo SHA is part of identity")

    def test_I_V13_SECPROF_02_provenance_and_no_authorization(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            _fixture(root)
            snap = sp.compile_profile(workspace_root=root, repo_sha="s")
            for claim in snap.claims:
                self.assertIn(claim.provenance, sp.PROVENANCE)
            blob = json.dumps(snap.to_row())
            for forbidden in ("never_touch", "allowed_pentest", "target", "grant", "authoriz"):
                self.assertNotIn(forbidden, blob.lower(), "the profile grants nothing")

    def test_I_V13_SECPROF_03_isolation_and_django_absence(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            _fixture(root)
            snap = sp.compile_profile(workspace_root=root, repo_sha="s")
            self.assertEqual(snap.isolation_strategy, "hybrid")
            self.assertIn(snap.isolation_strategy, sp.ISOLATION_STRATEGIES)
            self.assertEqual(snap.claim("framework.django").value, False)
            self.assertIn("NestJS", snap.claim("frameworks").value)

    def test_I_V13_SECPROF_04_bounded_scan(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            (root / "apps" / "svc" / "sql").mkdir(parents=True)
            (root / "package.json").write_text("{}", encoding="utf-8")
            # 500 sql files; the compiler must cap its scan, not read them all
            for i in range(500):
                (root / "apps" / "svc" / "sql" / f"m{i}.sql").write_text("SELECT 1;", encoding="utf-8")
            import time

            start = time.monotonic()
            snap = sp.compile_profile(workspace_root=root, repo_sha="s")
            self.assertLess(time.monotonic() - start, 20, "bounded scan")
            self.assertEqual(snap.isolation_strategy, "unknown")

    def test_I_V13_SECPROF_05_record_and_latest(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            _fixture(root)
            tools = ensure_tools_dir(Path(t) / "tools")
            snap = sp.compile_profile(workspace_root=root, repo_sha="s")
            self.assertIsNone(sp.latest_profile(base_dir=tools))
            sp.record_profile(snap, base_dir=tools)
            got = sp.latest_profile(base_dir=tools)
            self.assertEqual(got["profile_digest"], snap.profile_digest)
            self.assertEqual(got["isolation_strategy"], "hybrid")


if __name__ == "__main__":
    unittest.main()
