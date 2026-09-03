"""Plan 033 Faz 033b — kernel-owned packs: closed, repo-adaptive, passive, deterministic.

Invariants:
  I-V13-PACK-01  pack names are a closed set; run_pack refuses an unknown name.
  I-V13-PACK-02  selection is driven by the profile — multi_tenant applies only when the
                 isolation strategy is RLS/hybrid; api only when NestJS is present.
  I-V13-PACK-03  the RLS-coverage rule flags a tenant table with no policy and NEVER a
                 table that has RLS, and honours the exception allowlist.
  I-V13-PACK-04  the NestJS public-write rule flags a write endpoint with no guard in
                 scope and never one guarded by @UseGuards/@Roles.
  I-V13-PACK-05  leads are UNVERIFIED external_scanner signals (trust_grade unverified),
                 never canonical findings.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import packs
from aria_kernel.security.profile import compile_profile
from aria_kernel.tool_registry import ensure_tools_dir


def _repo(root: Path, *, nestjs: bool = True, rls: bool = True) -> dict:
    (root / "apps" / "farm-service" / "sql").mkdir(parents=True)
    (root / "apps" / "farm-service" / "src").mkdir(parents=True)
    deps = '"@nestjs/core":"1"' if nestjs else '"express":"1"'
    (root / "package.json").write_text('{"dependencies":{%s}}' % deps, encoding="utf-8")
    (root / "apps" / "farm-service" / "sql" / "bad.sql").write_text(
        "CREATE TABLE ponds (id int, tenant_id uuid, name text);", encoding="utf-8")
    good = "CREATE TABLE readings (id int, tenant_id uuid);\nALTER TABLE readings ENABLE ROW LEVEL SECURITY;\nCREATE POLICY tenant_isolation ON readings USING (true);"
    (root / "apps" / "farm-service" / "sql" / "good.sql").write_text(good if rls else "SELECT 1;", encoding="utf-8")
    (root / "apps" / "farm-service" / "sql" / "exc.sql").write_text(
        "CREATE TABLE users (id int, tenant_id uuid);", encoding="utf-8")
    (root / "apps" / "farm-service" / "src" / "x.controller.ts").write_text(
        "@Post()\ncreate() {}\n\n@UseGuards(A)\n@Put()\nupdate() {}", encoding="utf-8")
    return compile_profile(workspace_root=root, repo_sha="s").to_row()


class Packs(unittest.TestCase):
    def test_I_V13_PACK_01_closed_names(self) -> None:
        self.assertEqual(packs.PACK_NAMES, ("api", "multi_tenant"))
        with self.assertRaises(ValueError):
            packs.run_pack("django-drf", workspace_root=".", profile_row={})

    def test_I_V13_PACK_02_selection_from_profile(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root, nestjs=True, rls=True)
            sel = {m.name: m.applicable for m in packs.select_packs(prof)}
            self.assertEqual(sel, {"api": True, "multi_tenant": True})
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root, nestjs=False, rls=False)
            sel = {m.name: m.applicable for m in packs.select_packs(prof)}
            self.assertFalse(sel["api"], "no NestJS → api not applicable")
            self.assertFalse(sel["multi_tenant"], "no RLS/hybrid → not applicable")

    def test_I_V13_PACK_03_rls_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root, rls=True)
            leads = packs.run_pack("multi_tenant", workspace_root=root, profile_row=prof)
            refs = " ".join(r for lead in leads for r in lead.code_refs)
            self.assertIn("bad.sql", refs)
            self.assertNotIn("good.sql", refs, "a table with RLS is never flagged")
            self.assertNotIn("exc.sql", refs, "users is on the exception allowlist")
            self.assertTrue(all(lead.rule_id.startswith("rls_coverage") for lead in leads))

    def test_I_V13_PACK_04_public_write_guard(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            leads = packs.run_pack("api", workspace_root=root, profile_row=prof)
            summaries = " ".join(lead.summary for lead in leads)
            self.assertIn(":1", summaries, "the unguarded @Post at line 1 is flagged")
            self.assertNotIn(":5", summaries, "the @UseGuards @Put is not flagged")

    def test_I_V13_PACK_05_leads_are_unverified_signals(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            tools = ensure_tools_dir(Path(t) / "tools")
            leads = packs.run_pack("multi_tenant", workspace_root=root, profile_row=prof)
            rows = packs.record_pack_leads("multi_tenant", leads, service="farm-service", base_dir=tools)
            self.assertTrue(rows)
            for row in rows:
                self.assertEqual(row.get("source"), "external_scanner")
                self.assertEqual(row.get("trust_grade"), "runtime_unverified")


if __name__ == "__main__":
    unittest.main()
