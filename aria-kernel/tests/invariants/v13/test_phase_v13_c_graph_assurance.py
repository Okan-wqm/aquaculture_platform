"""Plan 033 Faz 033c — attack graph (versioned) + assurance coverage (honest).

Invariants:
  I-V13-GRAPH-01  the graph is deterministic and content-addressed; nodes/edges use
                  closed kinds; edges carry a closed epistemic status.
  I-V13-GRAPH-02  the full graph is a content-addressed artifact; the ledger holds
                  digest + counts + the input digests (repo SHA, profile, packs).
  I-V13-STALE-01  a graph past its staleness horizon reads STALE.
  I-V13-ASSURE-01  status vocabulary is closed; coverage denominator is the applicable
                  cell set, not a Cartesian product.
  I-V13-ASSURE-02  empty ledger → not_tested>0, not ready; both clean → ready; a stale
                  clean cell becomes unknown (never silently clean); a confirmed
                  vulnerability is never ready.
"""
from __future__ import annotations

import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from tests.invariants.v13 import _helpers  # noqa: F401 — sys.path

from aria_kernel.security import assurance as A
from aria_kernel.security import attack_graph as G
from aria_kernel.security import packs
from aria_kernel.security.profile import compile_profile
from aria_kernel.tool_registry import ensure_tools_dir


def _repo(root: Path, *, rls: bool = True) -> dict:
    (root / "apps" / "farm-service" / "sql").mkdir(parents=True)
    (root / "apps" / "farm-service" / "src").mkdir(parents=True)
    (root / "package.json").write_text('{"dependencies":{"@nestjs/core":"1","redis":"1"}}', encoding="utf-8")
    sql = "CREATE SCHEMA t;\nALTER TABLE x ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON x USING (true);" if rls else "SELECT 1;"
    (root / "apps" / "farm-service" / "sql" / "s.sql").write_text(sql, encoding="utf-8")
    (root / "apps" / "farm-service" / "src" / "x.controller.ts").write_text("@Get()\nlist(){}\n@Post()\ncreate(){}", encoding="utf-8")
    return compile_profile(workspace_root=root, repo_sha="sha1").to_row()


class Graph(unittest.TestCase):
    def test_I_V13_GRAPH_01_deterministic_closed_kinds(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            g1 = G.build_graph(workspace_root=root, profile_row=prof, pack_digests=("sha256:p",))
            g2 = G.build_graph(workspace_root=root, profile_row=prof, pack_digests=("sha256:p",))
            self.assertEqual(g1.graph_digest, g2.graph_digest)
            self.assertTrue(g1.graph_digest.startswith("sha256:"))
            for n in g1.nodes:
                self.assertIn(n.kind, G.NODE_KINDS)
            for e in g1.edges:
                self.assertIn(e.kind, G.EDGE_KINDS)
                self.assertIn(e.epistemic, G.EPISTEMIC)
            self.assertTrue(any(e.epistemic == "OBSERVED" for e in g1.edges))
            self.assertTrue(any(e.epistemic == "INFERRED" for e in g1.edges), "tenant-boundary/datastore edges are inferred")

    def test_I_V13_GRAPH_02_artifact_and_versioned_index(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            tools = ensure_tools_dir(Path(t) / "tools")
            g = G.build_graph(workspace_root=root, profile_row=prof, pack_digests=("sha256:p1",))
            G.record_graph(g, base_dir=tools)
            row = G.latest_graph_row(base_dir=tools)
            self.assertEqual(row["graph_digest"], g.graph_digest)
            self.assertEqual(row["profile_digest"], prof["profile_digest"])
            self.assertEqual(row["pack_digests"], ["sha256:p1"])
            self.assertEqual((row["node_count"], row["edge_count"]), (len(g.nodes), len(g.edges)))
            art = G.load_graph_artifact(g.graph_digest, base_dir=tools)
            self.assertEqual(len(art["nodes"]), len(g.nodes))

    def test_I_V13_STALE_01_staleness_horizon(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            tools = ensure_tools_dir(Path(t) / "tools")
            g = G.build_graph(workspace_root=root, profile_row=prof)
            G.record_graph(g, base_dir=tools)
            row = G.latest_graph_row(base_dir=tools)
            self.assertFalse(G.is_stale(row))
            self.assertTrue(G.is_stale({**row, "built_at": (datetime.now(timezone.utc) - timedelta(days=2)).isoformat()}))


class Assurance(unittest.TestCase):
    def test_I_V13_ASSURE_01_closed_status_applicable_denominator(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            with self.assertRaises(ValueError):
                A.record_assurance(asset_id="a", control_id="c", status="NOPE", profile_digest="d", pack_digest="d",
                                   base_dir=ensure_tools_dir(Path(t) / "tools"))
            cells = A.applicable_cells(profile_row=prof, pack_manifests=packs.select_packs(prof))
            controls = {c.control_id for c in cells}
            self.assertIn("multi_tenant/rls_coverage", controls)
            self.assertIn("api/public_write_guard", controls)

    def test_I_V13_ASSURE_02_honest_coverage(self) -> None:
        with tempfile.TemporaryDirectory() as t:
            root = Path(t) / "repo"
            prof = _repo(root)
            tools = ensure_tools_dir(Path(t) / "tools")
            manifests = packs.select_packs(prof)
            empty = A.compute_coverage(profile_row=prof, pack_manifests=manifests, base_dir=tools)
            self.assertGreater(empty["not_tested"], 0)
            self.assertFalse(empty["ready"])
            for ctrl in ("multi_tenant/rls_coverage", "api/public_write_guard"):
                A.record_assurance(asset_id="service:farm-service", control_id=ctrl, status="TESTED_NO_VIOLATION",
                                   profile_digest=prof["profile_digest"], pack_digest="d", base_dir=tools)
            clean = A.compute_coverage(profile_row=prof, pack_manifests=manifests, base_dir=tools)
            self.assertTrue(clean["ready"])
            self.assertEqual(clean["clean_required_coverage"], 1.0)
            stale = A.compute_coverage(profile_row=prof, pack_manifests=manifests, base_dir=tools,
                                       now=datetime.now(timezone.utc) + timedelta(days=8))
            self.assertGreater(stale["unknown"], 0)
            self.assertFalse(stale["ready"], "a stale clean answer is never clean")
            A.record_assurance(asset_id="service:farm-service", control_id="api/public_write_guard",
                               status="VULNERABILITY_CONFIRMED", profile_digest=prof["profile_digest"], pack_digest="d", base_dir=tools)
            vuln = A.compute_coverage(profile_row=prof, pack_manifests=manifests, base_dir=tools)
            self.assertFalse(vuln["ready"])
            self.assertEqual(vuln["vulnerability_confirmed"], 1)


if __name__ == "__main__":
    unittest.main()
