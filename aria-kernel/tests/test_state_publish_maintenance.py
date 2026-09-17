"""The maintenance lane's commit is a kernel publish — compaction, then the
one publish path — and the attestation it carries is true.

TWO DEFECTS ON ONE TIP (``origin/aria/state`` 84032eda1, 2026-09-11):

* the lane committed with a shell ``git add -A`` after ``state compact``,
  so its snapshot.json was the PREVIOUS publish's: compaction had rewritten
  ``memory/beliefs.jsonl`` and ``runs.jsonl`` and nothing rebuilt the
  attestation. The full verifier refused the tip as
  ``state_snapshot_surface_mismatch:memory_beliefs`` — a commit whose own
  manifest disagreed with its tree;
* routing the lane through ``state publish`` exposes the continuity gate:
  compaction prunes hot-artifact cycles and discovery FATES, every one a
  declared surface the published snapshot claims, so the kernel publish
  sees ``surfaces_lost`` and refuses. The retired escape hatch was the
  operator bootstrap ack, which the bootstrap runbook forbids in a lane.

These tests run the lane's shape end to end against real git: a bound
store, ``compact_state`` on its tools root, then the publish preamble and
``publish_state`` — with NO operator ack in the environment.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone

from aria_kernel import state_store
from aria_kernel.ledger import append_declared_jsonl
from aria_kernel.state_compact import COMPACTED_EVENT, PRUNED_PATHS_KEY, compact_state
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    prepare_publishable_snapshot,
    publish_state,
    tools_root,
    verify_state_store,
)
from tests.test_state_store import REPO_HASH, StateStoreTestCase, _EnvPatch, _git


def _old_stamp(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y%m%dT%H%M%SZ")


class MaintenanceLaneTestCase(StateStoreTestCase):
    """A bound store carrying what compaction prunes and what it slims."""

    def setUp(self) -> None:
        super().setUp()
        # The lane exports no bootstrap ack (the runbook forbids it in a
        # workflow); the base fixture sets one for the bootstrap itself, so
        # it is withdrawn here for everything after the checkout.
        self._no_ack = _EnvPatch({BOOTSTRAP_ACK_ENV: None})

    def _bound_store(self):
        from aria_kernel.tools_binding import bind_tools_root

        store = self._bootstrap()
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=str(tools_root(store)),
                workspace_root=str(self.repo),
                reason="bind the restored aria/state store to this checkout",
            )
        self._no_ack.start()
        self.addCleanup(self._no_ack.stop)
        return store

    def _seed_prunable_and_slimmable_state(self, store) -> dict[str, str]:
        tools = tools_root(store)
        old_cycle = f"cyc-{_old_stamp(30)}-auto"
        fresh_cycle = f"cyc-{_old_stamp(0)}-auto"
        old_artifact = tools / "run-artifacts" / "hot" / old_cycle / "run-old" / "tool_run.json"
        fresh_artifact = tools / "run-artifacts" / "hot" / fresh_cycle / "run-new" / "tool_run.json"
        for artifact in (old_artifact, fresh_artifact):
            artifact.parent.mkdir(parents=True, exist_ok=True)
            artifact.write_text('{"tool_id": "t"}\n', encoding="utf-8")
        old_run = {
            "recorded_at": (datetime.now(timezone.utc) - timedelta(days=30)).isoformat(),
            "run_id": "run-old",
            "tool_id": "t",
            "cycle_id": old_cycle,
            "status": "ok",
            "evidence_validation": {
                "valid": True,
                "evidence_envelopes": [{"canonical_ref": f"src/f{i}.ts"} for i in range(50)],
            },
            "read_paths": [f"src/f{i}.ts" for i in range(50)],
        }
        append_declared_jsonl(tools / "runs.jsonl", old_run, expected_surface="runs")
        return {
            "old_cycle_prefix": f"run-artifacts/hot/{old_cycle}/",
            "old_artifact_key": f"runtime_artifact_hot:run-artifacts/hot/{old_cycle}/run-old/tool_run.json",
            "fresh_artifact_key": f"runtime_artifact_hot:run-artifacts/hot/{fresh_cycle}/run-new/tool_run.json",
        }

    def _publish(self, store, snapshot_id: str, cycle_id: str) -> dict:
        prepared = prepare_publishable_snapshot(
            store,
            snapshot_id=snapshot_id,
            cycle_id=cycle_id,
            lane="test",
            repo_hash=REPO_HASH,
        )
        result = publish_state(
            store,
            snapshot=prepared.snapshot,
            cycle_id=cycle_id,
            repo_hash=REPO_HASH,
            expected_base_head=prepared.base_head,
        )
        result["prepared"] = prepared
        return result

    @staticmethod
    def _committed_governance_rows(store, ref: str = "HEAD") -> list[dict]:
        blob = _git(store.root, "show", f"{ref}:tools/governance.jsonl")
        return [json.loads(line) for line in blob.splitlines() if line.strip()]


class CompactionAttestsWhatItPrunes(MaintenanceLaneTestCase):
    def test_a_compaction_attested_loss_publishes_without_the_operator_ack(self) -> None:
        store = self._bound_store()
        keys = self._seed_prunable_and_slimmable_state(store)
        first = self._publish(store, "snap-1", "cycle-1")
        self.assertTrue(first["published"])
        self.assertIn(keys["old_artifact_key"], first["prepared"].snapshot["surfaces"])
        self.assertNotIn(BOOTSTRAP_ACK_ENV, os.environ)

        compacted = compact_state(base_dir=tools_root(store), retain_days=7)
        self.assertEqual(compacted[PRUNED_PATHS_KEY], [keys["old_cycle_prefix"]])
        self.assertEqual(compacted["hot_artifacts_removed"], 1)

        second = self._publish(store, "snap-2", "cycle-2")

        self.assertTrue(second["published"])
        continuity = second["continuity"]
        self.assertEqual(continuity["status"], "surfaces_lost")
        self.assertEqual(continuity["lost_surfaces"], [keys["old_artifact_key"]])
        self.assertEqual(
            continuity["compaction_attested_surfaces"],
            [keys["old_artifact_key"]],
        )
        # The fresh cycle survived the sweep and is still attested.
        self.assertIn(
            keys["fresh_artifact_key"],
            json.loads(_git(store.root, "show", "HEAD:snapshot.json"))["surfaces"],
        )
        # The attestation the gate consumed is inside the published commit.
        rows = [
            row for row in self._committed_governance_rows(store)
            if row.get("kind") == COMPACTED_EVENT
        ]
        self.assertEqual(rows[-1]["details"][PRUNED_PATHS_KEY], [keys["old_cycle_prefix"]])

    def test_an_unattested_loss_is_still_refused_and_named_alone(self) -> None:
        store = self._bound_store()
        keys = self._seed_prunable_and_slimmable_state(store)
        tools = tools_root(store)
        stray = tools / "pressure" / "hand-removed.json"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("{}\n", encoding="utf-8")
        self._publish(store, "snap-1", "cycle-1")

        compact_state(base_dir=tools, retain_days=7)
        stray.unlink()  # nobody attested this one

        with self.assertRaises(StateStoreRefusal) as caught:
            self._publish(store, "snap-2", "cycle-2")

        message = str(caught.exception)
        self.assertIn("state_publish_continuity_surfaces_lost", message)
        self.assertIn("pressure_artifacts:pressure/hand-removed.json", message)
        # The compaction-attested loss is not what the refusal is about.
        self.assertNotIn(keys["old_artifact_key"], message)

    def test_a_write_driving_ledger_is_never_accepted_on_a_compaction_row(self) -> None:
        """Compaction slims ledgers, it never deletes them. A row that claims
        to have pruned one is not evidence of policy; it is the amnesia the
        gate exists to refuse, whatever wrote the row."""
        from aria_kernel.tool_registry import append_tools_governance

        store = self._bound_store()
        self._seed_prunable_and_slimmable_state(store)
        self._publish(store, "snap-1", "cycle-1")

        tools = tools_root(store)
        append_tools_governance(
            tools,
            COMPACTED_EVENT,
            {"retain_days": 7, "surfaces": {}, PRUNED_PATHS_KEY: ["runs.jsonl"]},
        )
        (tools / "runs.jsonl").unlink()

        with self.assertRaises(StateStoreRefusal) as caught:
            self._publish(store, "snap-2", "cycle-2")
        self.assertIn("state_publish_continuity_surfaces_lost", str(caught.exception))
        self.assertIn("'runs'", str(caught.exception))


class TheMaintenanceCommitAttestsItsTree(MaintenanceLaneTestCase):
    def test_the_published_snapshot_attests_the_compacted_ledgers(self) -> None:
        store = self._bound_store()
        self._seed_prunable_and_slimmable_state(store)
        first = self._publish(store, "snap-1", "cycle-1")
        runs_before = first["prepared"].snapshot["surfaces"]["runs"]["sha256"]

        compacted = compact_state(base_dir=tools_root(store), retain_days=7)
        self.assertGreater(compacted["surfaces"]["runs"]["stripped_rows"], 0)

        second = self._publish(store, "snap-2", "cycle-2")
        self.assertTrue(second["published"])

        head = _git(store.root, "rev-parse", "HEAD").strip()
        committed = json.loads(_git(store.root, "show", f"{head}:snapshot.json"))
        runs_claim = committed["surfaces"]["runs"]
        runs_blob = _git(store.root, "show", f"{head}:tools/runs.jsonl").encode("utf-8")
        self.assertNotEqual(runs_claim["sha256"], runs_before, "the ledger was rewritten")
        self.assertEqual(runs_claim["sha256"], hashlib.sha256(runs_blob).hexdigest())
        self.assertEqual(runs_claim["size_bytes"], len(runs_blob))
        # The archive compaction wrote is a declared surface and is claimed.
        self.assertTrue(any(
            key.startswith("state_archives:archives/runs-compact-")
            for key in committed["surfaces"]
        ))
        # The commit is the kernel's, verified by the immutable verifier
        # inside publish and again here from the outside.
        self.assertTrue(
            _git(store.root, "log", "-1", "--format=%s", head).startswith("chore(aria-state): cycle-2")
        )
        self.assertEqual(_git(store.root, "log", "-1", "--format=%an", head).strip(), state_store.COMMITTER_NAME)
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])
        self.assertEqual(
            _git(self.repo, "ls-remote", "--heads", "origin", "refs/heads/aria/state").split()[0],
            head,
        )

    def test_the_retired_shell_commit_shape_is_refused_by_the_verifier(self) -> None:
        """Negative control: the commit the lane USED to produce — whole-tree
        add on top of the previous publish's snapshot.json — is exactly what
        the immutable verifier refuses. This is why the lane cannot commit
        for itself: nothing but the publish rebuilds the attestation."""
        from aria_kernel.autonomy_evidence import _verify_published_snapshot_commit

        store = self._bound_store()
        self._seed_prunable_and_slimmable_state(store)
        first = self._publish(store, "snap-1", "cycle-1")
        compact_state(base_dir=tools_root(store), retain_days=7)

        _git(store.root, "add", "-A")
        _git(
            store.root,
            "-c", "user.name=aria-state-maintenance",
            "-c", "user.email=aria-state-maintenance@users.noreply.github.com",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "chore(state): automated compaction",
        )
        shell_commit = _git(store.root, "rev-parse", "HEAD").strip()

        with self.assertRaises(RuntimeError) as caught:
            _verify_published_snapshot_commit(
                store=store,
                repo_identity=REPO_HASH,
                state_commit=shell_commit,
                expected_snapshot=first["prepared"].snapshot,
            )
        self.assertTrue(
            str(caught.exception).startswith("state_snapshot_surface_mismatch:")
            or str(caught.exception).startswith("state_snapshot_unclaimed"),
            str(caught.exception),
        )


class TheCliVerbRunsThePreamble(MaintenanceLaneTestCase):
    def test_state_publish_reports_what_it_dropped(self) -> None:
        """`aria_kernel state publish` — the verb the lane runs — heals an
        inherited side-car and says so in its verdict."""
        from aria_kernel.cli import _handle_state_command
        from aria_kernel.file_lock import lock_sidecar_path

        store = self._bound_store()
        self._seed_prunable_and_slimmable_state(store)
        self._publish(store, "snap-1", "cycle-1")
        sidecar = lock_sidecar_path(tools_root(store) / "runs.jsonl")
        sidecar.touch()
        _git(store.root, "add", "-A")
        _git(
            store.root,
            "-c", "user.name=aria-state-maintenance",
            "-c", "user.email=aria-state-maintenance@users.noreply.github.com",
            "-c", "commit.gpgsign=false",
            "commit", "-m", "chore(state): automated compaction",
        )
        _git(store.root, "push", "origin", "HEAD:refs/heads/aria/state")
        _git(store.root, "fetch", "origin")

        args = argparse.Namespace(
            state_command="publish",
            repo_root=str(self.repo),
            repo_hash=REPO_HASH,
            branch="aria/state",
            remote="origin",
            store_dir=str(store.root),
            snapshot_id="state-maintenance-1-1",
            cycle_id="state-maintenance-1",
            parent_commit=None,
        )
        out = io.StringIO()
        with redirect_stdout(out):
            code = _handle_state_command(args)

        self.assertEqual(code, 0, out.getvalue())
        verdict = json.loads(out.getvalue())
        self.assertTrue(verdict["published"])
        self.assertIn(
            sidecar.relative_to(store.root).as_posix(),
            [entry["path"] for entry in verdict["dropped_inherited_entries"]],
        )
        self.assertEqual(verdict["accepted_losses_recorded"], [])
        self.assertNotIn(
            sidecar.relative_to(store.root).as_posix(),
            _git(store.root, "ls-tree", "-r", "--name-only", "HEAD").split(),
        )

    def test_state_publish_records_the_operator_typed_reduction_and_says_so(self) -> None:
        """The `state_reduction_ack` workflow input reaches `state publish`
        as ARIA_STATE_BOOTSTRAP_ACK for one run. The verb accepts the
        unattested loss only because the value names this repository,
        records the acceptance on the governance ledger inside the commit,
        and names what it accepted in its verdict — so the run log is the
        audit trail's pointer, not its substitute."""
        from aria_kernel.cli import _handle_state_command
        from aria_kernel.state_continuity_gate import LOSSES_ACCEPTED_BY_ACK_EVENT

        store = self._bound_store()
        self._seed_prunable_and_slimmable_state(store)
        stray = tools_root(store) / "pressure" / "hand-removed.json"
        stray.parent.mkdir(parents=True, exist_ok=True)
        stray.write_text("{}\n", encoding="utf-8")
        self._publish(store, "snap-1", "cycle-1")
        stray.unlink()  # nobody attested this one

        args = argparse.Namespace(
            state_command="publish",
            repo_root=str(self.repo),
            repo_hash=REPO_HASH,
            branch="aria/state",
            remote="origin",
            store_dir=str(store.root),
            snapshot_id="state-maintenance-2-1",
            cycle_id="state-maintenance-2",
            parent_commit=None,
        )
        out = io.StringIO()
        with _EnvPatch({BOOTSTRAP_ACK_ENV: self.identity}), redirect_stdout(out):
            code = _handle_state_command(args)

        self.assertEqual(code, 0, out.getvalue())
        verdict = json.loads(out.getvalue())
        self.assertTrue(verdict["published"])
        lost = "pressure_artifacts:pressure/hand-removed.json"
        self.assertEqual(verdict["accepted_losses_recorded"], [lost])
        self.assertEqual(verdict["continuity"]["ack_accepted_surfaces"], [lost])
        rows = [
            row for row in self._committed_governance_rows(store)
            if row.get("kind") == LOSSES_ACCEPTED_BY_ACK_EVENT
        ]
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["details"]["lost_surfaces"], [lost])
        self.assertEqual(rows[0]["details"]["ack_ref"], self.identity)
        self.assertTrue(verify_state_store(store, repo_hash=REPO_HASH)["valid"])
