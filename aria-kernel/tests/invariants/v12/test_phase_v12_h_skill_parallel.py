"""Plan 032 Faz 032h — skill lifecycle (proposals only), rollback, shadow compare, bounded drain parallelism, parity table.

Invariants:
  I-V12-SKILL-01  the curator never touches a skill file: it writes PROPOSE_ARCHIVE /
                  PROPOSE_MERGE rows with evidence (agent references, journal reads,
                  token cosine), deduplicated by signature, and a decision needs an
                  operator approval ref; skills referenced by an agent or opened in the
                  journal window are never proposed for archive.
  I-V12-SKILL-02  rollback restores a tracked skill from HEAD or deletes an untracked
                  one, refuses without an approval ref / without a materialization /
                  twice, and records status=rolled_back + governance.
  I-V12-SKILL-03  shadow comparison derives its verdict from sandbox rows and the
                  incumbent's fixture blocks only (closed SHADOW_VERDICTS).
  I-V12-PAR-01    executor policy defaults to max_concurrent=1 / no worktrees and is
                  clamped to [1, 8]; the drain launches through `_launch`, settles
                  through `_settle`, bounds in-flight children by the policy, drains
                  in-flight children before `drain_done`, and a per-request worktree
                  is created detached at target_sha and removed afterwards; the
                  executor honours ARIA_WORKSPACE_ROOT.
  I-V12-PAR-02    the harness-parity table verifies every row (import, symbol, CLI,
                  test) and the generated report is checked in and current.

NOT RUN at authoring time (operator instruction 2026-09-03).
"""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from tests.invariants.v12 import _helpers  # noqa: F401 — sys.path

from aria_kernel import harness_parity as hp
from aria_kernel import hooks
from aria_kernel import skill_curator as sc
from aria_kernel.genesis_policy import EXECUTOR_DEFAULTS, executor_policy
from aria_kernel.tool_registry import GovernanceError, ensure_tools_dir

_REPO_ROOT = Path(__file__).resolve().parents[4]
_POC = _REPO_ROOT / "tools" / "aria-poc"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=True).stdout.strip()


class _Repo(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.ws = self.root / "repo"
        (self.ws / ".claude" / "skills").mkdir(parents=True)
        (self.ws / ".claude" / "agents").mkdir(parents=True)
        _git(self.ws, "init", "-q")
        _git(self.ws, "config", "user.email", "t@t")
        _git(self.ws, "config", "user.name", "t")
        self.tools = ensure_tools_dir(self.root / "aria-tools")

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def skill(self, name: str, text: str) -> Path:
        path = self.ws / ".claude" / "skills" / f"{name}.md"
        path.write_text(text, encoding="utf-8")
        return path

    def governance(self) -> str:
        path = self.tools / "governance.jsonl"
        return path.read_text(encoding="utf-8") if path.exists() else ""


class CuratorProposesOnly(_Repo):
    def test_I_V12_SKILL_01_proposals_evidence_dedup_decisions(self) -> None:
        base = "# Add a database migration\n\nCreate the migration file, run prisma migrate, verify the schema, write the rollback test.\n" * 3
        self.skill("add-migration", base)
        self.skill("add-migration-copy", base + "\nAlso check the tenant column.\n")
        self.skill("orphan-skill", "# Orphan\n\nnobody references this; provisioning notes for the legacy tenant importer.\n")
        self.skill("used-skill", "# Used\n\nreferenced by an agent file; deploy checklist for the sensor gateway.\n")
        self.skill("README", "# Skills index\n")
        (self.ws / ".claude" / "agents" / "aria-x.md").write_text("---\nname: aria-x\n---\nSee @.claude/skills/used-skill.md\n", encoding="utf-8")
        hooks.record_journal({"tool_name": "Read", "tool_input": {"file_path": str(self.ws / ".claude/skills/add-migration.md")}},
                             base_dir=self.tools, request_id="AIR-1", session_id="s", tool_use_id="t")
        before = {p.name: p.read_bytes() for p in (self.ws / ".claude" / "skills").glob("*.md")}
        rows = sc.propose_curation(self.ws, base_dir=self.tools)
        after = {p.name: p.read_bytes() for p in (self.ws / ".claude" / "skills").glob("*.md")}
        self.assertEqual(before, after, "the curator never edits a skill")
        kinds = {(r["kind"], tuple(r["subjects"])) for r in rows}
        self.assertIn(("PROPOSE_ARCHIVE", (".claude/skills/orphan-skill.md",)), kinds)
        self.assertIn(("PROPOSE_ARCHIVE", (".claude/skills/add-migration-copy.md",)), kinds)
        self.assertIn(("PROPOSE_MERGE", (".claude/skills/add-migration-copy.md", ".claude/skills/add-migration.md")), kinds)
        self.assertNotIn(("PROPOSE_ARCHIVE", (".claude/skills/used-skill.md",)), kinds, "an agent references it")
        self.assertNotIn(("PROPOSE_ARCHIVE", (".claude/skills/add-migration.md",)), kinds, "the journal saw it opened")
        self.assertNotIn(("PROPOSE_ARCHIVE", (".claude/skills/README.md",)), kinds)
        for row in rows:
            self.assertIn(row["kind"], sc.CURATION_KINDS)
        merge = next(r for r in rows if r["kind"] == "PROPOSE_MERGE")
        self.assertGreaterEqual(merge["evidence"]["token_cosine"], sc.DEFAULT_SIMILARITY)
        self.assertEqual(sc.propose_curation(self.ws, base_dir=self.tools), [], "same evidence, no second proposal")
        self.assertEqual(len(sc.list_curation_proposals(base_dir=self.tools, open_only=True)), len(rows))
        with self.assertRaises(ValueError):
            sc.decide_curation(merge["proposal_id"], decision="accepted", operator_approval_ref="", base_dir=self.tools)
        with self.assertRaises(ValueError):
            sc.decide_curation(merge["proposal_id"], decision="maybe", operator_approval_ref="op", base_dir=self.tools)
        sc.decide_curation(merge["proposal_id"], decision="rejected", operator_approval_ref="op-1", base_dir=self.tools, note="keep both")
        self.assertNotIn(merge["proposal_id"], {p["proposal_id"] for p in sc.list_curation_proposals(base_dir=self.tools, open_only=True)})
        with self.assertRaises(ValueError):
            sc.decide_curation(merge["proposal_id"], decision="accepted", operator_approval_ref="op-1", base_dir=self.tools)
        self.assertIn("skill_curation_proposed", self.governance())
        self.assertIn("skill_curation_decided", self.governance())
        self.assertEqual({p.name: p.read_bytes() for p in (self.ws / ".claude" / "skills").glob("*.md")}, before)


class RollbackAndShadow(_Repo):
    def _materialize_row(self, draft_id: str, target: str) -> None:
        from aria_kernel.skill_genesis import append_jsonl

        append_jsonl(self.tools / "skill-genesis" / "materializations.jsonl", {
            "schema_version": 1, "recorded_at": "2026-09-03T00:00:00+00:00", "draft_id": draft_id, "assignment_id": "asg-1",
            "worktree_path": self.ws.as_posix(), "target_path": target, "status": "ok", "materialize_event_id": "me-1",
        })

    def test_I_V12_SKILL_02_rollback_tracked_untracked_refusals(self) -> None:
        tracked = self.skill("tracked", "original\n")
        _git(self.ws, "add", "-A")
        _git(self.ws, "commit", "-q", "-m", "init")
        tracked.write_text("materialized body\n", encoding="utf-8")
        self._materialize_row("draft-1", ".claude/skills/tracked.md")
        with self.assertRaises(GovernanceError):
            sc.rollback_skill_materialization(draft_id="draft-1", base_dir=self.tools, operator_approval_ref="")
        with self.assertRaises(GovernanceError):
            sc.rollback_skill_materialization(draft_id="draft-nope", base_dir=self.tools, operator_approval_ref="op")
        row = sc.rollback_skill_materialization(draft_id="draft-1", base_dir=self.tools, operator_approval_ref="op-1")
        self.assertEqual((row["status"], row["rollback_action"]), ("rolled_back", "restored_from_head"))
        self.assertEqual(tracked.read_text(encoding="utf-8"), "original\n")
        with self.assertRaises(GovernanceError):
            sc.rollback_skill_materialization(draft_id="draft-1", base_dir=self.tools, operator_approval_ref="op-1")
        fresh = self.skill("fresh", "new skill\n")
        self._materialize_row("draft-2", ".claude/skills/fresh.md")
        row = sc.rollback_skill_materialization(draft_id="draft-2", base_dir=self.tools, operator_approval_ref="op-1")
        self.assertEqual(row["rollback_action"], "deleted_untracked")
        self.assertFalse(fresh.exists())
        self._materialize_row("draft-3", "apps/not-a-skill.md")
        with self.assertRaises(GovernanceError):
            sc.rollback_skill_materialization(draft_id="draft-3", base_dir=self.tools, operator_approval_ref="op-1")
        self.assertEqual(self.governance().count("skill_materialization_rolled_back"), 2)

    def test_I_V12_SKILL_03_shadow_verdicts_from_rows(self) -> None:
        from aria_kernel.skill_genesis import append_jsonl

        append_jsonl(self.tools / "skill-genesis" / "drafts.jsonl", {"draft_id": "d-1", "target_path": ".claude/skills/thing.md", "recorded_at": "t"})
        with self.assertRaises(GovernanceError):
            sc.shadow_compare(draft_id="d-none", workspace_root=self.ws, base_dir=self.tools)
        self.assertEqual(sc.shadow_compare(draft_id="d-1", workspace_root=self.ws, base_dir=self.tools)["verdict"], "candidate_unsandboxed")
        append_jsonl(self.tools / "skill-genesis" / "sandbox.jsonl", {"draft_id": "d-1", "decision": "pass", "fixture_count": 3, "recorded_at": "t"})
        self.assertEqual(sc.shadow_compare(draft_id="d-1", workspace_root=self.ws, base_dir=self.tools)["verdict"], "no_incumbent")
        self.skill("thing", "# Thing\n\n## Fixture: a\nx\n\n## Fixture: b\ny\n\n## Fixture: c\nz\n\n## Fixture: d\nw\n")
        self.assertEqual(sc.shadow_compare(draft_id="d-1", workspace_root=self.ws, base_dir=self.tools)["verdict"], "candidate_worse")
        append_jsonl(self.tools / "skill-genesis" / "sandbox.jsonl", {"draft_id": "d-1", "decision": "pass", "fixture_count": 5, "recorded_at": "t2"})
        result = sc.shadow_compare(draft_id="d-1", workspace_root=self.ws, base_dir=self.tools)
        self.assertEqual(result["verdict"], "candidate_not_worse")
        self.assertIn(result["verdict"], sc.SHADOW_VERDICTS)
        self.assertIn("skill_shadow_compared", self.governance())


class DrainParallelism(_Repo):
    def test_I_V12_PAR_01_policy_launch_settle_worktrees(self) -> None:
        self.assertEqual(EXECUTOR_DEFAULTS, {"max_concurrent": 1, "worktree_per_request": False})
        self.assertEqual(executor_policy(), {"max_concurrent": 1, "worktree_per_request": False})
        cfg = self.root / "cfg"
        (cfg / "aria-config").mkdir(parents=True)
        (cfg / "aria-config" / "genesis_policy.json").write_text(json.dumps({"executor": {"max_concurrent": 99, "worktree_per_request": 1}}), encoding="utf-8")
        self.assertEqual(executor_policy(cfg), {"max_concurrent": 8, "worktree_per_request": True})
        drain = (_POC / "ci_executor_drain.py").read_text(encoding="utf-8")
        self.assertLess(drain.index("def _launch("), drain.index("def _settle("))
        self.assertIn("if len(inflight) >= max_concurrent:\n            _settle(inflight.pop(0))", drain)
        self.assertLess(drain.index("    while inflight:\n        _settle(inflight.pop(0))"), drain.index('f"drain_done attempted='))
        self.assertIn('child_env["ARIA_WORKSPACE_ROOT"] = str(worktree)', drain)
        self.assertIn('"worktree", "add", "--detach"', drain)
        self.assertIn('"worktree", "remove", "--force"', drain)
        executor = (_POC / "ci_executor.py").read_text(encoding="utf-8")
        self.assertIn('os.environ.get("ARIA_WORKSPACE_ROOT")', executor)
        import sys

        if str(_POC) not in sys.path:
            sys.path.insert(0, str(_POC))
        import ci_executor_drain as d

        self.skill("s", "x\n")
        _git(self.ws, "add", "-A")
        _git(self.ws, "commit", "-q", "-m", "init")
        sha = _git(self.ws, "rev-parse", "HEAD")
        path = d._add_request_worktree(self.ws, "AIR-1/x", sha)
        assert path is not None
        self.assertTrue((path / ".claude" / "skills" / "s.md").exists())
        self.assertEqual(_git(path, "rev-parse", "HEAD"), sha)
        d._remove_request_worktree(self.ws, path)
        self.assertFalse(path.exists())
        self.assertIsNone(d._add_request_worktree(self.ws, "AIR-2", "0" * 40), "an unknown sha falls back to the shared checkout")


class ParityTable(unittest.TestCase):
    def test_I_V12_PAR_02_every_row_verified_and_report_current(self) -> None:
        records = hp.check_parity(repo_root=_REPO_ROOT)
        self.assertEqual([r["capability"] for r in records if r["problems"]], [], [r for r in records if r["problems"]])
        self.assertGreaterEqual(len(records), 24)
        for row in hp.PARITY_TABLE:
            self.assertIn(row.status, hp.PARITY_STATUSES)
        generated = _REPO_ROOT / "docs" / "aria" / "generated" / "harness-parity.md"
        self.assertEqual(generated.read_text(encoding="utf-8"), hp.render_parity_report(repo_root=_REPO_ROOT), "regenerate with `aria-kernel parity generate`")


if __name__ == "__main__":
    unittest.main()
