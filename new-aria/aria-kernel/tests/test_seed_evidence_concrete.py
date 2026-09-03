"""ARIA seeded-evidence concreteness invariant (ORPHAN-MEDIUM-255).

ARIA's own L1 Grounded-Evidence law requires evidence_refs to be concrete,
repo-verifiable paths. A glob (``apps/*/src/database/migrations/*.ts``) resolves
to ``missing`` and fails the memory phase, which failed every full cycle on the
real repo. These invariants make the whole glob-evidence class impossible:

* discovery surfaces a bounded list of CONCRETE migration paths
  (``migration_evidence_paths``), exactly like ``web_modules_missing_project_json``;
* memory.py + pressure.py seed the migration belief/pressure from those paths;
* NO kernel seed site may embed a ``*`` glob in an ``evidence``/``evidence_refs``
  literal (static regression guard).
"""
from __future__ import annotations

import re
import sys
import tempfile
import unittest
from pathlib import Path


_REPO_ROOT = Path(__file__).resolve().parents[2]
_KERNEL = _REPO_ROOT / "aria-kernel"
if str(_KERNEL) not in sys.path:
    sys.path.insert(0, str(_KERNEL))

from aria_kernel import discovery  # noqa: E402
from aria_kernel.evidence_trust import classify_evidence_ref  # noqa: E402

_RESOLVABLE = ("repo_verified", "worktree_candidate")


class SeedEvidenceConcreteTests(unittest.TestCase):
    def test_fingerprint_surfaces_concrete_resolvable_migration_paths(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            mig = root / "apps" / "svc" / "src" / "database" / "migrations"
            mig.mkdir(parents=True)
            for i in range(1, 7):
                (mig / f"{i:04d}-x.ts").write_text("export class M {}\n", encoding="utf-8")
            # An ARCHIVED migration must NOT be chosen as live evidence.
            arch = mig / ".archive" / "2026-01-01T00-00-00-000Z"
            arch.mkdir(parents=True)
            (arch / "9999-old.ts").write_text("export class Old {}\n", encoding="utf-8")

            fates = [
                {"path": str(p.relative_to(root)), "suffix": ".ts"}
                for p in sorted(mig.rglob("*.ts"))
            ]
            fp = discovery._repo_fingerprint(root, fates, {"fated": len(fates)})

            paths = fp.get("migration_evidence_paths")
            self.assertIsInstance(paths, list)
            self.assertTrue(paths, "fingerprint surfaced no concrete migration evidence paths")
            self.assertLessEqual(len(paths), 5, "evidence path list must be bounded")
            for p in paths:
                self.assertNotIn("*", p, f"evidence path {p!r} is a glob, not concrete")
                self.assertNotIn("/.archive/", p, f"archived migration {p!r} must not be live evidence")
                self.assertTrue((root / p).is_file(), f"evidence path {p!r} does not exist")
                grade = classify_evidence_ref(p, workspace_root=root, target_sha="HEAD").trust_grade
                self.assertIn(grade, _RESOLVABLE, f"{p!r} not repo-verifiable (grade={grade})")

    def test_glob_evidence_ref_is_unresolvable_documents_the_bug(self) -> None:
        # The exact ref the seed sites used before the fix — proves why it failed.
        grade = classify_evidence_ref(
            "apps/*/src/database/migrations/*.ts", workspace_root=_REPO_ROOT, target_sha="HEAD"
        ).trust_grade
        self.assertNotIn(grade, _RESOLVABLE)

    def test_no_glob_evidence_literal_in_kernel_seed_sites(self) -> None:
        # Static regression guard: a seed site may never embed a ``*`` glob in an
        # evidence literal. Catches ANY new seed belief/pressure, not just migrations.
        pattern = re.compile(r"evidence(?:_refs)?\s*=\s*\[[^\]]*\*[^\]]*\]")
        for rel in ("aria_kernel/memory.py", "aria_kernel/pressure.py"):
            src = (_KERNEL / rel).read_text(encoding="utf-8")
            hit = pattern.search(src)
            self.assertIsNone(
                hit, f"{rel} embeds a glob evidence literal: {hit.group(0) if hit else ''!r}"
            )


if __name__ == "__main__":
    unittest.main()
