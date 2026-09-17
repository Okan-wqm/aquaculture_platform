"""ARIA-HIGH-117 — compaction attests what it strips, and the verifier reads it.

THE LIVE FAILURE (main, 2026-09-13). ``aria-agent-executor`` runs
34745606502 and 34762798856 failed at "Verify ARIA state integrity" with
``state_valid=false``: 3,898 issues — 3,825 ``raw_pointer_corrupt`` (every
``raw-findings.jsonl`` row, all thin pointers into artifacts), 36
``artifact_ref_missing``, 36 ``artifact_index_ref_missing`` and one
``artifact_index_empty_with_run_refs`` — on a tree whose 93 ledgers all
verified. ``run-artifacts/artifact-index.jsonl`` had 0 rows, ``hot/`` was
gone, ``retention/events.jsonl`` never existed, and three
``archives/artifact_index-compact-*.jsonl.gz`` carried the 176 dropped index
rows: the daily ``state compact --retain-days 7`` had stripped the 09-04
cycles' artifacts once they aged past the window (ORPHAN-CRITICAL-805
drops the index rows with the files) while the runs and raw findings kept
naming them — by design. The kernel's own maintenance produced a store the
kernel's own verifier called corrupt, the executor lane failed closed on
that verdict every run, and ``aria/state`` could not be published.

THE CONTRACT these tests pin (``docs/aria/CONTRACTS.md`` §12.5):
compaction writes ``run-artifacts/compacted.jsonl`` — one row per artifact
the retention policy stripped — inside the index compaction's transaction,
and backfills it from the compact archives so a store stripped before the
ledger existed heals on its next compaction; every archive is judged by
the retention window of the compaction that WROTE it (read from that
run's ``state_compacted`` governance row), never by the current input, and
an archive no row vouches for is attested from not at all;
``verify_runtime_artifacts`` classifies a ref or pointer into an attested
artifact as ``compacted`` (valid, counted per reference), verifies a raw
pointer into one structurally, and still refuses an absent artifact no row
attests; ``verify_artifacts`` reports ``compacted_artifact_count`` beside
its (already valid) zero-row verdict; and the ONE publish path refuses a
store whose runtime pointers do not verify, so the maintenance lane cannot
push what the executor lane will refuse.

Every fixture here is driven through the real writers — ``record_run``
with the v2-shadow artifact format, ``compact_state``, ``publish_state`` —
never a hand-written ledger row.
"""
from __future__ import annotations

import argparse
import gzip
import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

import yaml

from aria_kernel.cycle_runtime_status import RUNTIME_OK, runtime_status
from aria_kernel.integrity import verify_integrity
from aria_kernel.ledger import load_declared_jsonl, verify_jsonl
from aria_kernel.runtime_artifacts import (
    compacted_artifacts,
    resolve_finding_from_artifact,
    verify_artifacts,
    verify_runtime_artifacts,
)
from aria_kernel.state_compact import (
    ARCHIVE_KEY,
    ATTESTED_ARTIFACTS_KEY,
    ATTESTED_BY_BACKFILL,
    ATTESTED_BY_COMPACTION,
    COMPACTED_EVENT,
    compact_state,
)
from aria_kernel.tool_health import record_run
from aria_kernel.tool_registry import ensure_tools_binding, register_tool
from tests.test_runtime_artifacts import _run, _tool

WORKFLOWS = Path(__file__).resolve().parents[2] / ".github" / "workflows"
MAINTENANCE = WORKFLOWS / "aria-state-maintenance.yml"
EXECUTOR = WORKFLOWS / "aria-agent-executor.yml"

COMPACTED_LEDGER = "run-artifacts/compacted.jsonl"
OLD_CYCLE_A = "cyc-20200101T000000Z-auto"
OLD_CYCLE_B = "cyc-20200102T000000Z-auto"


def _fresh_cycle(*, days_ago: int = 0) -> str:
    stamp = datetime.now(timezone.utc) - timedelta(days=days_ago)
    return f"cyc-{stamp:%Y%m%dT%H%M%SZ}-auto"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(cwd), *args], check=True, capture_output=True, text=True,
    ).stdout.strip()


def _issue_codes(verdict: dict) -> dict[str, int]:
    codes: dict[str, int] = {}
    for issue in verdict["issues"]:
        codes[issue["code"]] = codes.get(issue["code"], 0) + 1
    return codes


class CompactionStoreTestCase(unittest.TestCase):
    """A bound tools root fed by the real run writer, under the default
    (v2-shadow) format: every run writes a hot artifact, an index row, a
    manifest row, an inventory row and thin raw-finding pointers."""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="aria-compaction-attest-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.source = self.tmp / "source"
        self.source.mkdir()
        _git(self.source, "init", "--initial-branch=main", ".")
        _git(self.source, "config", "user.name", "ARIA Compaction Fixture")
        _git(self.source, "config", "user.email", "aria-compaction@example.invalid")
        _git(self.source, "config", "commit.gpgsign", "false")
        target = self.source / "apps/farm-service/src/app.module.ts"
        target.parent.mkdir(parents=True)
        target.write_text("export const fixtureValue = 1;\n", encoding="utf-8")
        _git(self.source, "add", "apps/farm-service/src/app.module.ts")
        _git(self.source, "commit", "--no-gpg-sign", "-m", "compaction fixture")
        self.tools = self.tmp / "store" / "tools"
        self._env = mock.patch.dict(os.environ, {
            "ARIA_TOOLS_DIR": str(self.tools),
            "ARIA_STATE_STORE_ROOT": str(self.tools.parent),
            "ARIA_REPO_STATE_ROOT": str(self.tmp / "repo-state"),
            "ARIA_WORKSPACE_BASE": str(self.tmp / "workspaces"),
        })
        self._env.start()
        self.addCleanup(self._env.stop)
        os.environ.pop("ARIA_RUN_LEDGER_FORMAT", None)
        ensure_tools_binding(self.tools, workspace_root=self.source)
        register_tool(_tool(), base_dir=self.tools)

    def _record(self, cycle_id: str, run_id: str, *, findings: int = 2) -> dict:
        base = _run(run_id=run_id, cycle_id=cycle_id)
        raw = [
            {**base["raw_findings"][0], "id": f"{run_id}-finding-{index}"}
            for index in range(findings)
        ]
        base["raw_findings"] = raw
        base["runner"] = {"raw_findings_count": findings, "raw_findings_sample": raw[:1]}
        base["_runtime_artifact_payload"]["raw_findings"] = raw
        record_run(base, base_dir=self.tools)
        runs = load_declared_jsonl(self.tools / "runs.jsonl", expected_surface="runs")
        return next(row for row in runs if row["run_id"] == run_id)

    def _seed_two_old_cycles(self) -> list[dict]:
        """Six runs across two cycles that are years past any window."""
        return [
            self._record(OLD_CYCLE_A, f"run-a{index}") for index in range(3)
        ] + [
            self._record(OLD_CYCLE_B, f"run-b{index}") for index in range(3)
        ]

    def _verify(self) -> dict:
        return verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.source)

    def _ledger_rows(self) -> list[dict]:
        return list(compacted_artifacts(self.tools).rows)

    def _attestation(self, ref: dict) -> dict | None:
        return compacted_artifacts(self.tools).attesting(ref)

    def _compaction_rows(self) -> list[dict]:
        from aria_kernel.ledger import load_jsonl

        return [row for row in load_jsonl(self.tools / "governance.jsonl") if row.get("kind") == COMPACTED_EVENT]

    def _the_archive(self) -> Path:
        archives = sorted((self.tools / "archives").glob("artifact_index-compact-*.jsonl.gz"))
        self.assertEqual(len(archives), 1, archives)
        return archives[0]

    def _rename_the_archive_to(self, stamp: str) -> Path:
        """Give the one compact archive a stamp of the fixture's choosing."""
        archive = self._the_archive()
        renamed = archive.with_name(f"artifact_index-compact-{stamp}.jsonl.gz")
        archive.rename(renamed)
        return renamed

    def _make_the_compaction_rows_predate_the_archive_name(self) -> None:
        """Reproduce the shape of the nine ``state_compacted`` rows on the
        live store when the ledger was introduced: ``retain_days`` and a
        ``ts``, no ``artifact_index_archive``. The rows are the real
        compactions' own; only the key that did not exist yet is removed."""
        from aria_kernel.ledger import load_jsonl, rewrite_declared_jsonl

        path = self.tools / "governance.jsonl"
        rows = load_jsonl(path)
        for row in rows:
            if row.get("kind") == COMPACTED_EVENT:
                row["details"].pop(ARCHIVE_KEY, None)
        rewrite_declared_jsonl(
            path, rows, expected_surface="tools_governance", migration_id="test_pre_archive_name_rows",
        )

    def _strip_without_the_ledger(self) -> None:
        """Reproduce the live store's shape: compacted before the ledger
        existed. The compaction is real; only its attestation is removed,
        which is exactly what every compaction before 2026-09-13 left."""
        result = compact_state(base_dir=self.tools, retain_days=7)
        self.assertGreater(result["hot_artifacts_removed"], 0)
        (self.tools / COMPACTED_LEDGER).unlink()


class CompactionAttestsWhatItStrips(CompactionStoreTestCase):
    def test_a_store_compacted_past_its_window_verifies_as_compacted(self) -> None:
        """The core pin: real runs, real raw findings, one compaction past
        the retention window and NO retention_apply — verified, with the
        stripped artifacts counted as compacted and each named on the ledger."""
        runs = self._seed_two_old_cycles()
        self.assertEqual(self._verify()["status"], "ok")

        result = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(result["hot_artifacts_removed"], 2)
        self.assertEqual(result["artifact_index_rows_dropped"], 6)
        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 6)
        verdict = self._verify()
        self.assertEqual(verdict["status"], "ok", verdict["issues"][:5])
        self.assertEqual(verdict["issues"], [])
        # 6 runs × (artifact_ref + artifact_refs[0]) + 6 runs × 2 raw pointers.
        self.assertEqual(verdict["compacted_artifact_count"], 12 + 12)
        rows = self._ledger_rows()
        self.assertEqual(
            sorted(row["artifact_id"] for row in rows),
            sorted(run["artifact_ref"]["artifact_id"] for run in runs),
        )
        archives = sorted((self.tools / "archives").glob("artifact_index-compact-*.jsonl.gz"))
        self.assertEqual(len(archives), 1)
        for row in rows:
            run = next(r for r in runs if r["artifact_ref"]["artifact_id"] == row["artifact_id"])
            self.assertEqual(row["uri"], run["artifact_ref"]["uri"])
            self.assertEqual(row["sha256"], run["artifact_ref"]["sha256"])
            self.assertEqual(row["run_id"], run["run_id"])
            self.assertEqual(row["cycle_id"], run["cycle_id"])
            self.assertEqual(row["kind"], "tool_run")
            self.assertEqual(row["retain_days"], 7)
            self.assertEqual(row["attested_by"], ATTESTED_BY_COMPACTION)
            self.assertEqual(row["archive"], archives[0].relative_to(self.tools).as_posix())
            self.assertFalse((self.tools / row["uri"]).exists())
        # The ledger is a declared, hash-chained surface.
        self.assertTrue(verify_jsonl(self.tools / COMPACTED_LEDGER)["valid"])
        self.assertEqual(
            len(load_declared_jsonl(self.tools / COMPACTED_LEDGER, expected_surface="runtime_artifact_compactions")),
            6,
        )
        # The archive the ledger names holds exactly the dropped index rows.
        with gzip.open(archives[0], "rt", encoding="utf-8") as fh:
            archived = {json.loads(line)["artifact_id"] for line in fh if line.strip()}
        self.assertEqual(archived, {row["artifact_id"] for row in rows})
        # The governance row carries the count beside the pruned paths, and
        # names the archive it wrote: the binding a later run follows to
        # the window that was in force.
        governance = self._compaction_rows()
        self.assertEqual(governance[-1]["details"][ATTESTED_ARTIFACTS_KEY], 6)
        self.assertEqual(governance[-1]["details"][ARCHIVE_KEY], rows[0]["archive"])
        self.assertEqual(result[ARCHIVE_KEY], rows[0]["archive"])

    def test_a_hand_deleted_artifact_inside_the_window_is_still_refused(self) -> None:
        """The negative control the whole design turns on: the ledger
        attests policy, not absence. An artifact of a cycle INSIDE the
        window that goes missing is a lost artifact — compaction drops its
        index row (presence is the index predicate) but does not attest
        it, and the verifier keeps refusing it by name."""
        self._seed_two_old_cycles()
        live = self._record(_fresh_cycle(), "run-live")
        compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(self._verify()["status"], "ok")

        (self.tools / live["artifact_ref"]["uri"]).unlink()
        result = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(result["artifact_index_rows_dropped"], 1)
        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 0)
        self.assertIsNone(self._attestation(live["artifact_ref"]))
        verdict = self._verify()
        self.assertEqual(verdict["status"], "failed")
        # Every way the verifier can name a lost artifact, it names this one
        # and only this one: the run's two refs, its two raw pointers, and
        # the index row the ledger does not stand in for.
        self.assertEqual(_issue_codes(verdict), {
            "artifact_ref_missing": 2,
            "raw_pointer_corrupt": 2,
            "artifact_index_ref_missing": 2,
            "artifact_index_empty_with_run_refs": 1,
        })
        for issue in verdict["issues"]:
            if issue["code"] == "artifact_index_empty_with_run_refs":
                continue
            named = (
                issue.get("run_id")
                or (issue.get("source") or {}).get("run_id")
                or issue.get("artifact_id")
            )
            self.assertIn("run-live", str(named), issue)
        # The lawfully compacted cycles are still counted as such.
        self.assertEqual(verdict["compacted_artifact_count"], 24)

    def test_an_attestation_for_a_different_version_does_not_apply(self) -> None:
        """A ref whose hash is not the hash of the artifact that was
        stripped names a different artifact; the ledger row does not vouch
        for it."""
        self._seed_two_old_cycles()
        compact_state(base_dir=self.tools, retain_days=7)
        row = self._ledger_rows()[0]
        ref = {
            "schema_version": 2, "artifact_id": row["artifact_id"], "uri": row["uri"],
            "sha256": "sha256:" + "f" * 64, "content_type": "application/json",
            "produced_by_workflow_run_id": row["run_id"], "source_surface": "runtime_artifact",
        }
        self.assertIsNone(self._attestation(ref))
        self.assertIsNotNone(self._attestation({**ref, "sha256": row["sha256"]}))

    def test_a_raw_pointer_into_a_compacted_artifact_is_verified_structurally(self) -> None:
        """The pointer cannot be dereferenced — the finding went with the
        artifact — so the ROW is verified: a row that lost its summary or
        its hashes is corrupt, whatever the ledger says about the artifact."""
        from aria_kernel.ledger import rewrite_declared_jsonl

        self._seed_two_old_cycles()
        compact_state(base_dir=self.tools, retain_days=7)
        path = self.tools / "raw-findings.jsonl"
        rows = load_declared_jsonl(path, expected_surface="raw_findings")
        self.assertTrue(all("finding" not in row and row["finding_summary"]["rule"] for row in rows))

        def rewrite(mutate) -> dict:
            mutated = [dict(row) for row in rows]
            mutate(mutated[0])
            rewrite_declared_jsonl(
                path, mutated, expected_surface="raw_findings", migration_id="test_structural_pin",
            )
            return self._verify()

        for label, mutate, reason in (
            ("summary gone", lambda row: row.pop("finding_summary"), "finding_summary_missing"),
            ("summary hollow", lambda row: row.__setitem__("finding_summary", {}), "finding_summary_missing"),
            ("evidence hash gone", lambda row: row.pop("evidence_hash"), "evidence_hash_missing"),
            ("artifact hash gone", lambda row: row.pop("artifact_hash"), "artifact_hash_missing"),
            ("artifact hash foreign", lambda row: row.__setitem__("artifact_hash", "sha256:" + "0" * 64), "artifact_hash_mismatch"),
            ("pointer gone", lambda row: row.pop("json_pointer"), "json_pointer_missing"),
        ):
            with self.subTest(label):
                verdict = rewrite(mutate)
                corrupt = [issue for issue in verdict["issues"] if issue["code"] == "raw_pointer_corrupt"]
                self.assertEqual(len(corrupt), 1, verdict["issues"][:3])
                self.assertEqual(corrupt[0]["artifact"], "compacted")
                self.assertIn(reason, corrupt[0]["reasons"])
                self.assertEqual(corrupt[0]["finding_id"], rows[0]["finding_id"])
        # The untouched rows verify — and the resolver answers "compacted"
        # by name rather than crashing for a reader that asks.
        rewrite_declared_jsonl(path, rows, expected_surface="raw_findings", migration_id="test_structural_pin_restore")
        self.assertEqual(self._verify()["status"], "ok")
        self.assertIsNone(resolve_finding_from_artifact(rows[0], base_dir=self.tools))
        attestation = self._attestation(rows[0]["artifact_ref"])
        self.assertEqual(attestation["artifact_id"], rows[0]["artifact_ref"]["artifact_id"])

    def test_a_ledger_whose_chain_fails_attests_nothing(self) -> None:
        self._seed_two_old_cycles()
        compact_state(base_dir=self.tools, retain_days=7)
        ledger = self.tools / COMPACTED_LEDGER
        lines = ledger.read_text(encoding="utf-8").splitlines()
        forged = json.loads(lines[0])
        forged["artifact_id"] = "forged"
        ledger.write_text("\n".join([json.dumps(forged), *lines[1:]]) + "\n", encoding="utf-8")

        verdict = self._verify()

        self.assertEqual(verdict["status"], "failed")
        codes = _issue_codes(verdict)
        self.assertGreaterEqual(codes.get("ledger_integrity_failed", 0), 1)
        self.assertEqual(codes["artifact_ref_missing"], 12)
        self.assertEqual(codes["raw_pointer_corrupt"], 12)
        self.assertEqual(verdict["compacted_artifact_count"], 0)

    def test_compaction_is_idempotent_and_dry_run_writes_no_attestation(self) -> None:
        self._seed_two_old_cycles()
        dry = compact_state(base_dir=self.tools, retain_days=7, dry_run=True)
        # A dry run projects the real run: the rows the sweep would strip.
        self.assertEqual(dry["hot_artifacts_removed"], 2)
        self.assertEqual(dry["artifact_index_rows_dropped"], 6)
        self.assertEqual(dry[ATTESTED_ARTIFACTS_KEY], 6)
        self.assertFalse((self.tools / COMPACTED_LEDGER).exists())
        self.assertEqual(self._verify()["status"], "ok")

        compact_state(base_dir=self.tools, retain_days=7)
        first = (self.tools / COMPACTED_LEDGER).read_bytes()
        again = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(again[ATTESTED_ARTIFACTS_KEY], 0)
        self.assertEqual((self.tools / COMPACTED_LEDGER).read_bytes(), first)
        self.assertEqual(self._verify()["status"], "ok")
        # A run that dropped nothing wrote no archive, and its row says so
        # rather than borrowing the earlier archive's name.
        self.assertIsNone(again[ARCHIVE_KEY])
        self.assertIsNone(self._compaction_rows()[-1]["details"][ARCHIVE_KEY])


class TheLiveStoreHealsOnItsNextCompaction(CompactionStoreTestCase):
    """The live shape: stripped before the ledger existed."""

    def test_the_pre_ledger_shape_reproduces_the_live_verdict(self) -> None:
        """A control, not a pin: it establishes that the fixture reproduces
        the failing live shape the other tests heal. (On the tree before
        the ledger it fails only because there is no ledger to remove.)"""
        self._seed_two_old_cycles()
        self._strip_without_the_ledger()

        index = load_declared_jsonl(
            self.tools / "run-artifacts" / "artifact-index.jsonl", expected_surface="runtime_artifact_index",
        )
        self.assertEqual(index, [])
        hot = self.tools / "run-artifacts" / "hot"
        self.assertEqual([p.name for p in hot.iterdir()] if hot.exists() else [], [])
        self.assertFalse((self.tools / "retention" / "events.jsonl").exists())
        self.assertEqual(len(list((self.tools / "archives").glob("artifact_index-compact-*.jsonl.gz"))), 1)
        verdict = self._verify()
        self.assertEqual(verdict["status"], "failed")
        # The exact issue classes the executor lane reported on
        # quarantine-evidence-34762798856, in the same proportions.
        self.assertEqual(_issue_codes(verdict), {
            "raw_pointer_corrupt": 12,
            "artifact_ref_missing": 12,
            "artifact_index_ref_missing": 12,
            "artifact_index_empty_with_run_refs": 1,
        })

    def test_one_compaction_pass_backfills_the_ledger_from_the_archives(self) -> None:
        self._seed_two_old_cycles()
        self._strip_without_the_ledger()

        result = compact_state(base_dir=self.tools, retain_days=7)

        # Nothing left to strip; everything already stripped is attested.
        self.assertEqual(result["hot_artifacts_removed"], 0)
        self.assertEqual(result["artifact_index_rows_dropped"], 0)
        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 6)
        rows = self._ledger_rows()
        self.assertEqual(len(rows), 6)
        self.assertEqual({row["attested_by"] for row in rows}, {ATTESTED_BY_BACKFILL})
        archive = next((self.tools / "archives").glob("artifact_index-compact-*.jsonl.gz"))
        self.assertEqual({row["archive"] for row in rows}, {archive.relative_to(self.tools).as_posix()})
        verdict = self._verify()
        self.assertEqual(verdict["status"], "ok", verdict["issues"][:5])
        self.assertEqual(verdict["compacted_artifact_count"], 24)
        # And a second pass changes nothing.
        self.assertEqual(compact_state(base_dir=self.tools, retain_days=7)[ATTESTED_ARTIFACTS_KEY], 0)

    def test_the_backfill_judges_each_archive_by_the_window_in_force_when_it_was_written(self) -> None:
        """An archive row whose cycle was INSIDE the window when its archive
        was written names an artifact that was absent for some other
        reason. A later compaction, however much later, does not re-judge
        it as policy."""
        self._seed_two_old_cycles()
        live = self._record(_fresh_cycle(), "run-live")
        (self.tools / live["artifact_ref"]["uri"]).unlink()
        self._strip_without_the_ledger()
        # The one archive now carries six policy rows and one loss.
        archive = next((self.tools / "archives").glob("artifact_index-compact-*.jsonl.gz"))
        with gzip.open(archive, "rt", encoding="utf-8") as fh:
            self.assertEqual(sum(1 for line in fh if line.strip()), 7)

        result = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 6)
        self.assertIsNone(self._attestation(live["artifact_ref"]))
        verdict = self._verify()
        self.assertEqual(verdict["status"], "failed")
        self.assertEqual(_issue_codes(verdict), {
            "artifact_ref_missing": 2,
            "raw_pointer_corrupt": 2,
            "artifact_index_ref_missing": 2,
            "artifact_index_empty_with_run_refs": 1,
        })
        self.assertEqual(verdict["compacted_artifact_count"], 24)

    def _lost_inside_the_window_verdict(self, lost: dict) -> None:
        """The verifier names exactly the one lost run, and counts the six
        lawfully compacted ones."""
        verdict = self._verify()
        self.assertEqual(verdict["status"], "failed")
        self.assertEqual(_issue_codes(verdict), {
            "artifact_ref_missing": 2,
            "raw_pointer_corrupt": 2,
            "artifact_index_ref_missing": 2,
            "artifact_index_empty_with_run_refs": 1,
        })
        for issue in verdict["issues"]:
            if issue["code"] != "artifact_index_empty_with_run_refs":
                self.assertIn(lost["run_id"], json.dumps(issue), issue)
        self.assertEqual(verdict["compacted_artifact_count"], 24)

    def test_a_later_compaction_with_a_shorter_window_does_not_re_judge_a_loss(self) -> None:
        """The window an archive is judged by is the one in force when it
        was WRITTEN — the ``retain_days`` of that compaction, read from its
        governance row — not the input of whichever run reads it later.
        A supported operator dispatch with ``--retain-days 1`` after the
        daily 7-day strip would otherwise launder a loss the 7-day runs
        had refused: 'a later compaction never re-judges it' (§12.5)."""
        self._seed_two_old_cycles()
        lost = self._record(_fresh_cycle(days_ago=3), "run-lost")
        (self.tools / lost["artifact_ref"]["uri"]).unlink()
        self._strip_without_the_ledger()

        self.assertEqual(compact_state(base_dir=self.tools, retain_days=7)[ATTESTED_ARTIFACTS_KEY], 6)
        self._lost_inside_the_window_verdict(lost)

        shorter = compact_state(base_dir=self.tools, retain_days=1)

        self.assertEqual(shorter[ATTESTED_ARTIFACTS_KEY], 0)
        self.assertIsNone(self._attestation(lost["artifact_ref"]))
        self.assertEqual({row["retain_days"] for row in self._ledger_rows()}, {7})
        self._lost_inside_the_window_verdict(lost)

    def test_a_row_that_predates_the_archive_name_is_paired_by_clock_and_still_rules(self) -> None:
        """The nine ``state_compacted`` rows on the live store carry no
        archive name; each is paired to its archive by clock and its
        ``retain_days`` is the archive's window. An archive stamped
        2020-01-10 under a 7-day window holds a 2020-01-08 row as a LOSS,
        whatever the clock says now and whatever window this run was
        given — the two formulas this pin separates are ``<archive stamp>
        − <that run's retain_days>`` from ``now − retain_days`` and from
        ``<archive stamp> − <this run's retain_days>``."""
        self._seed_two_old_cycles()
        lost = self._record("cyc-20200108T000000Z-auto", "run-lost")
        (self.tools / lost["artifact_ref"]["uri"]).unlink()
        self._strip_without_the_ledger()
        self._rename_the_archive_to("20200110T000000Z")
        self._make_the_compaction_rows_predate_the_archive_name()
        self.assertNotIn(ARCHIVE_KEY, self._compaction_rows()[-1]["details"])

        result = compact_state(base_dir=self.tools, retain_days=1)

        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 6)
        rows = self._ledger_rows()
        self.assertEqual({row["retain_days"] for row in rows}, {7})
        self.assertEqual({row["retention_cutoff"] for row in rows}, {"2020-01-03T00:00:00+00:00"})
        self.assertEqual({row["attested_by"] for row in rows}, {ATTESTED_BY_BACKFILL})
        self.assertIsNone(self._attestation(lost["artifact_ref"]))
        self._lost_inside_the_window_verdict(lost)

    def test_an_archive_no_governance_row_vouches_for_is_attested_from_not_at_all(self) -> None:
        """A run that died between writing its archive and appending its
        governance row leaves an archive whose window nobody recorded. It
        is not judged under a guessed window: nothing in it is attested,
        and the verifier keeps naming every one of its artifacts — the
        visible outcome, not a laundered one. The row that exists names a
        DIFFERENT archive, and a row that names an archive never speaks
        for another."""
        runs = self._seed_two_old_cycles()
        self._strip_without_the_ledger()
        named = self._compaction_rows()[-1]["details"].get(ARCHIVE_KEY)
        orphan = self._rename_the_archive_to("20200110T000000Z")
        self.assertNotEqual(named, orphan.relative_to(self.tools).as_posix())

        result = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 0)
        self.assertEqual(self._ledger_rows(), [])
        verdict = self._verify()
        self.assertEqual(verdict["status"], "failed")
        self.assertEqual(_issue_codes(verdict), {
            "raw_pointer_corrupt": 12,
            "artifact_ref_missing": 12,
            "artifact_index_ref_missing": 12,
            "artifact_index_empty_with_run_refs": 1,
        })
        self.assertEqual(verdict["compacted_artifact_count"], 0)
        for run in runs:
            self.assertIsNone(self._attestation(run["artifact_ref"]))

    def test_a_row_paired_by_clock_must_precede_the_next_archive(self) -> None:
        """Pairing by clock is bounded: a row is appended seconds after the
        archive it describes, so the first row at or after an archive that
        lands PAST the next archive belongs to that later run. Here the
        first compaction really dies between its archive and its
        governance row; the second run's row is the first at or after
        both archives and speaks only for its own."""
        import time

        self._seed_two_old_cycles()
        with mock.patch(
            "aria_kernel.state_compact.append_tools_governance", side_effect=RuntimeError("died"),
        ), self.assertRaises(RuntimeError):
            compact_state(base_dir=self.tools, retain_days=7)
        orphan = self._the_archive()
        self.assertEqual(self._compaction_rows(), [])
        # Archive stamps are second-resolution: the gap keeps the two
        # archives' stamps distinct and ordered, as two real runs' are.
        time.sleep(2)
        later = [self._record("cyc-20200103T000000Z-auto", f"run-c{index}") for index in range(3)]
        compact_state(base_dir=self.tools, retain_days=7)
        (self.tools / COMPACTED_LEDGER).unlink()
        self._make_the_compaction_rows_predate_the_archive_name()
        self.assertEqual(len(self._compaction_rows()), 1)

        result = compact_state(base_dir=self.tools, retain_days=7)

        self.assertEqual(result[ATTESTED_ARTIFACTS_KEY], 3)
        rows = self._ledger_rows()
        self.assertEqual(sorted(row["run_id"] for row in rows), sorted(run["run_id"] for run in later))
        self.assertNotIn(orphan.relative_to(self.tools).as_posix(), {row["archive"] for row in rows})
        verdict = self._verify()
        self.assertEqual(verdict["status"], "failed")
        self.assertEqual(_issue_codes(verdict)["artifact_ref_missing"], 12)
        self.assertEqual(verdict["compacted_artifact_count"], 12)

    def test_the_executor_lanes_integrity_verb_answers_valid_on_the_healed_store(self) -> None:
        """`integrity verify --tools-dir … --workspace-root …` — the exact
        step whose `state_valid=false` blocked every executor publish."""
        from aria_kernel.cli import main

        self._seed_two_old_cycles()
        self._strip_without_the_ledger()
        argv = ["integrity", "verify", "--tools-dir", str(self.tools), "--workspace-root", str(self.source)]

        out = io.StringIO()
        with redirect_stdout(out):
            before = main(argv)
        self.assertEqual(before, 1)
        self.assertFalse(json.loads(out.getvalue())["valid"])

        compact_state(base_dir=self.tools, retain_days=7)

        out = io.StringIO()
        with redirect_stdout(out):
            after = main(argv)
        self.assertEqual(after, 0, out.getvalue()[:2000])
        verdict = json.loads(out.getvalue())
        self.assertTrue(verdict["valid"])
        self.assertEqual(verdict["runtime_artifacts"]["status"], "ok")
        self.assertEqual(verdict["runtime_artifacts"]["compacted_artifact_count"], 24)
        self.assertIn("runtime_artifact_compactions", [ledger["name"] for ledger in verdict["ledgers"]])
        self.assertTrue(verify_integrity(tools_dir=self.tools, workspace_root=self.source)["valid"])


class AFullyCompactedIndexIsValid(CompactionStoreTestCase):
    def test_cycle_runtime_status_reads_a_compacted_index_as_its_own_verdict(self) -> None:
        """`cycle._runtime_status` reads `verify_artifacts(...)["valid"]`
        for `integrity_failed` (ARIA-HIGH-098). Zero index rows with every
        ref attested is valid, and the count says why."""
        self._seed_two_old_cycles()
        compact_state(base_dir=self.tools, retain_days=7)

        verdict = verify_artifacts(base_dir=self.tools)

        self.assertTrue(verdict["valid"])
        self.assertEqual(verdict["artifact_count"], 0)
        self.assertEqual(verdict["verified_count"], 0)
        self.assertEqual(verdict["compacted_artifact_count"], 6)
        self.assertEqual(
            runtime_status(phase_failed=False, integrity_valid=verdict["valid"], non_ok=[]),
            RUNTIME_OK,
        )


class NoLanePublishesAnUnverifiedStore(unittest.TestCase):
    """The one publish path refuses what the executor lane would refuse."""

    def setUp(self) -> None:
        from tests.test_state_publish_maintenance import MaintenanceLaneTestCase

        class _Lane(MaintenanceLaneTestCase):
            def runTest(self) -> None:  # pragma: no cover - a fixture carrier
                pass

        self.lane = _Lane()
        self.lane.setUp()
        self.addCleanup(self.lane.doCleanups)
        self.store = self.lane._bound_store()
        from aria_kernel.state_store import tools_root

        self.tools = tools_root(self.store)
        os.environ.pop("ARIA_RUN_LEDGER_FORMAT", None)
        register_tool(_tool(), base_dir=self.tools)

    def _record(self, cycle_id: str, run_id: str) -> dict:
        record_run(_run(run_id=run_id, cycle_id=cycle_id), base_dir=self.tools)
        runs = load_declared_jsonl(self.tools / "runs.jsonl", expected_surface="runs")
        return next(row for row in runs if row["run_id"] == run_id)

    def test_a_store_with_a_lost_artifact_is_refused_by_name(self) -> None:
        from aria_kernel.state_store import StateStoreRefusal

        first = self.lane._publish(self.store, "snap-1", "cycle-1")
        self.assertTrue(first["published"])
        live = self._record(_fresh_cycle(), "run-live")
        (self.tools / live["artifact_ref"]["uri"]).unlink()

        with self.assertRaises(StateStoreRefusal) as caught:
            self.lane._publish(self.store, "snap-2", "cycle-2")

        message = str(caught.exception)
        self.assertIn("state_publish_runtime_artifacts_unverified", message)
        self.assertIn("artifact_ref_missing", message)
        self.assertIn(live["artifact_ref"]["uri"], message)
        # Nothing moved: the tip is still the first publish.
        self.assertEqual(
            _git(self.store.root, "log", "-1", "--format=%s"),
            f"chore(aria-state): cycle-1 snap-1",
        )

    def test_the_maintenance_shape_publishes_after_compaction_attests_the_strip(self) -> None:
        """Compaction past the window, then the publish the maintenance lane
        runs: the stripped artifacts are attested, the pointers verify as
        compacted, and the verdict says so."""
        old = self._record(OLD_CYCLE_A, "run-old")
        first = self.lane._publish(self.store, "snap-1", "cycle-1")
        self.assertTrue(first["published"])
        self.assertEqual(first["runtime_artifacts"], {
            "status": "ok", "verified_artifact_count": 3, "compacted_artifact_count": 0,
        })

        compacted = compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(compacted[ATTESTED_ARTIFACTS_KEY], 1)
        second = self.lane._publish(self.store, "snap-2", "cycle-2")

        self.assertTrue(second["published"])
        self.assertEqual(second["runtime_artifacts"]["status"], "ok")
        self.assertEqual(second["runtime_artifacts"]["compacted_artifact_count"], 3)
        committed = json.loads(_git(self.store.root, "show", "HEAD:snapshot.json"))
        self.assertIn("runtime_artifact_compactions", committed["surfaces"])
        ledger = _git(self.store.root, "show", f"HEAD:tools/{COMPACTED_LEDGER}")
        self.assertIn(old["artifact_ref"]["artifact_id"], ledger)

    def test_the_cli_verb_the_lane_runs_reports_the_refusal_as_a_verdict(self) -> None:
        from aria_kernel.cli import _handle_state_command
        from tests.test_state_store import REPO_HASH

        self.lane._publish(self.store, "snap-1", "cycle-1")
        live = self._record(_fresh_cycle(), "run-live")
        (self.tools / live["artifact_ref"]["uri"]).unlink()
        args = argparse.Namespace(
            state_command="publish", repo_root=str(self.lane.repo), repo_hash=REPO_HASH,
            branch="aria/state", remote="origin", store_dir=str(self.store.root),
            snapshot_id="state-maintenance-1-1", cycle_id="state-maintenance-1", parent_commit=None,
        )
        out = io.StringIO()
        with redirect_stdout(out):
            code = _handle_state_command(args)

        self.assertEqual(code, 3, out.getvalue())
        verdict = json.loads(out.getvalue())
        self.assertFalse(verdict["published"])
        self.assertIn("state_publish_runtime_artifacts_unverified", verdict["refusal"])


class TheMaintenanceLaneAppliesTheConsumersVerdict(unittest.TestCase):
    """The workflow shape, pinned on the parsed graph like the executor's."""

    @staticmethod
    def _steps(path: Path) -> list[dict]:
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        return [step for job in doc["jobs"].values() for step in job.get("steps", [])]

    def _step(self, path: Path, fragment: str) -> dict:
        for step in self._steps(path):
            if fragment in (step.get("name") or ""):
                return step
        raise AssertionError(f"{path.name}: no step whose name contains {fragment!r}")

    def test_the_lane_verifies_after_compaction_and_before_the_publish(self) -> None:
        names = [step.get("name") or "" for step in self._steps(MAINTENANCE)]
        compact = next(i for i, name in enumerate(names) if "Compact surfaces" in name)
        verify = next(i for i, name in enumerate(names) if name == "Verify ARIA state integrity")
        publish = next(i for i, name in enumerate(names) if "Publish the compacted state" in name)
        self.assertLess(compact, verify)
        self.assertLess(verify, publish)

    def test_the_verify_step_is_the_executor_lanes_verb_with_the_same_roots(self) -> None:
        ours = self._step(MAINTENANCE, "Verify ARIA state integrity")
        theirs = self._step(EXECUTOR, "Verify ARIA state integrity")
        self.assertEqual(ours["id"], "integrity")
        for line in (
            "python3 -m aria_kernel integrity verify",
            '--tools-dir "$ARIA_TOOLS_DIR"',
            '--workspace-root "$GITHUB_WORKSPACE"',
            'echo "state_valid=true" >> "$GITHUB_OUTPUT"',
            'echo "state_valid=false" >> "$GITHUB_OUTPUT"',
        ):
            self.assertIn(line, ours["run"])
            self.assertIn(line, theirs["run"])

    def test_the_publish_and_the_credential_are_gated_on_the_verdict(self) -> None:
        for fragment in ("Publish the compacted state", "Mint the aria/state push credential"):
            self.assertIn(
                "steps.integrity.outputs.state_valid == 'true'",
                self._step(MAINTENANCE, fragment)["if"],
                fragment,
            )

    def test_an_unverified_compaction_cannot_report_green(self) -> None:
        fail = self._step(MAINTENANCE, "Fail when the compacted state was not published")
        self.assertIn("steps.integrity.outputs.state_valid != 'true'", fail["if"])
        self.assertIn("exit 1", fail["run"])


if __name__ == "__main__":
    unittest.main()
