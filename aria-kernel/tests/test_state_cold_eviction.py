"""ARIA-HIGH-274 — a publish evicts old cycles to the cold store; nothing is lost.

THE GROWTH. ``aria/state`` was 554 MiB on 2026-10-02 and grew ~45-70 MiB a
day: every cycle adds a ``run-artifacts/hot/cyc-*`` (+36.85 MiB) and a
``discovery/cyc-*`` (+4 MiB). The hot cycles were pruned only by
``state compact`` on a 7-day wall-clock window, and only when the
maintenance lane succeeded; the discovery FATES were aged by mtime, which on
a fresh worktree is checkout time, so they were effectively never pruned.
At that rate the 1,280 MiB snapshot input budget refuses every publish
around 2026-10-12..17.

THE CONTRACT these tests pin. Every publish (``publish_with_contention_replay``):

* before the lifecycle lock, writes every file of every cycle outside the
  newest three of its family (ordered by the stamp IN the cycle id) to the
  content-addressed ``<branch>-cold`` store — ``sha256/<aa>/<hex>``, byte
  exact — committed on the cold tip and pushed by exact sha, never forced;
  a rejection refetches and rebuilds the union; a cold failure blocks nothing;
* under the lock, appends one ``cold/pointers`` row per file BEFORE it
  unlinks it, and a governance ``state_cold_evicted`` row;
* the continuity gate accepts a lost surface only for an ARTIFACT claim
  whose pointer names the claimed sha256 and whose blob is present;
* the readers count an absent, pointer-backed artifact as ``evicted``,
  resolve and restore it from cold, and the index is never rewritten.

Every publish here runs WITHOUT the operator acknowledgment: the eviction is
vouched for by its own pointers or it is refused.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import subprocess
import time
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from aria_kernel import state_compact, state_store
from aria_kernel.ledger import append_declared_jsonl, load_declared_jsonl, load_jsonl
from aria_kernel.runtime_artifacts import (
    cold_pointers,
    resolve_artifact_payload,
    restore_artifact,
    verify_runtime_artifacts,
)
from aria_kernel.state_continuity_gate import vouched_continuity
from aria_kernel.state_snapshot import SnapshotError, snapshot_continuity
from aria_kernel.state_store import (
    BOOTSTRAP_ACK_ENV,
    StateStoreRefusal,
    build_publishable_snapshot,
    checkout_state_store,
    publish_with_contention_replay,
    read_published_snapshot,
    tools_root,
)
from aria_kernel.tool_health import record_run
from aria_kernel.tool_registry import register_tool
from tests.test_runtime_artifacts import _run, _tool
from tests.test_state_store import REPO_HASH, StateStoreTestCase, _EnvPatch, _git

COLD_BRANCH = "aria/state-cold"
DISCOVERY_FILES = ("COMPLETION_PROOF.json", "FATES.json", "REPO_FINGERPRINT.json", "SERVICE_MAP.json", "SNAPSHOT.json")


def _cycle(day: int, hour: int = 0) -> str:
    return f"cyc-202608{day:02d}T{hour:02d}0000Z-auto"


class ColdEvictionTestCase(StateStoreTestCase):
    """A bound store fed by the real run writer, publishing with NO ack."""

    def setUp(self) -> None:
        super().setUp()
        self._format = mock.patch.dict(os.environ, {})
        self._format.start()
        self.addCleanup(self._format.stop)
        os.environ.pop("ARIA_RUN_LEDGER_FORMAT", None)
        self.store = self._bound_store(self.repo, self.repo.parent / "store", bootstrap=True)
        self.tools = tools_root(self.store)
        register_tool(_tool(), base_dir=self.tools)

    def _bound_store(self, repo: Path, store_dir: Path, *, bootstrap: bool = False):
        from aria_kernel.tools_binding import bind_tools_root

        store = self._bootstrap() if bootstrap else checkout_state_store(repo, store_dir=store_dir)
        with _EnvPatch(state_store.store_environment(store, REPO_HASH)):
            bind_tools_root(
                tools_dir=str(tools_root(store)),
                workspace_root=str(repo),
                reason="bind the restored aria/state store to this checkout",
            )
        if bootstrap:
            no_ack = _EnvPatch({BOOTSTRAP_ACK_ENV: None})
            no_ack.start()
            self.addCleanup(no_ack.stop)
        return store

    def _seed(self, cycle_id: str, *, tools: Path | None = None, stdout: str = "{}",
              discovery: bool = True) -> dict:
        """One cycle as the night writes it: a run with its hot artifact and
        raw-finding pointer, and the cycle's five discovery artifacts."""
        tools = tools or self.tools
        run = _run(run_id=f"run-{cycle_id}", cycle_id=cycle_id)
        run["_runtime_artifact_payload"]["stdout"] = stdout
        record_run(run, base_dir=tools)
        if discovery:
            directory = tools / "discovery" / cycle_id
            directory.mkdir(parents=True, exist_ok=True)
            for name in DISCOVERY_FILES:
                body = {"files": [{"path": "README.md", "content_hash": cycle_id}]} if name == "FATES.json" else {"cycle": cycle_id, "name": name}
                (directory / name).write_text(json.dumps(body), encoding="utf-8")
        rows = load_declared_jsonl(tools / "runs.jsonl", expected_surface="runs")
        return next(row for row in rows if row["run_id"] == f"run-{cycle_id}")

    def _publish(self, snapshot_id: str, store=None) -> dict:
        return publish_with_contention_replay(
            store or self.store, snapshot_id=snapshot_id, cycle_id=snapshot_id, lane="test", repo_hash=REPO_HASH,
        )

    def _hot(self, tools: Path | None = None) -> list[str]:
        return sorted(p.name for p in ((tools or self.tools) / "run-artifacts" / "hot").iterdir())

    def _discovery(self, tools: Path | None = None) -> list[str]:
        return sorted(p.name for p in ((tools or self.tools) / "discovery").iterdir())

    def _cold_tip(self) -> str | None:
        listing = _git(self.remote, "ls-remote", "--heads", ".", f"refs/heads/{COLD_BRANCH}").split()
        return listing[0] if listing else None

    def _cold_bytes(self, cold_path: str) -> bytes:
        return subprocess.run(
            ["git", "--git-dir", str(self.remote), "cat-file", "blob", f"{COLD_BRANCH}:{cold_path}"],
            check=True, capture_output=True,
        ).stdout

    def _pointer_rows(self, tools: Path | None = None) -> list[dict]:
        rows: list[dict] = []
        for path in sorted(((tools or self.tools) / "cold" / "pointers").glob("*.jsonl")):
            rows.extend(load_declared_jsonl(path, expected_surface="cold_pointers"))
        return rows

    def _three_then_five(self) -> tuple[list[str], dict[str, bytes]]:
        """Publish three cycles (nothing to evict), add two newer ones, and
        return the evictable cycles with the bytes of every file in them."""
        cycles = [_cycle(day) for day in (1, 2, 3, 4, 5)]
        for cycle_id in cycles[:3]:
            self._seed(cycle_id)
        first = self._publish("snap-1")
        self.assertTrue(first["published"], first)
        self.assertEqual(first["cold_eviction"]["status"], "nothing_to_evict")
        for cycle_id in cycles[3:]:
            self._seed(cycle_id)
        evictable = cycles[:2]
        originals = {
            path.relative_to(self.tools).as_posix(): path.read_bytes()
            for family in ("run-artifacts/hot", "discovery")
            for cycle_id in evictable
            for path in sorted((self.tools / family / cycle_id).rglob("*")) if path.is_file()
        }
        return evictable, originals


class APublishKeepsTheNewestThreeAndMovesTheRestToCold(ColdEvictionTestCase):
    def test_the_oldest_cycles_land_byte_identical_in_cold_and_leave_the_tree(self) -> None:
        evictable, originals = self._three_then_five()

        result = self._publish("snap-2")

        self.assertTrue(result["published"], result)
        self.assertEqual(self._hot(), [_cycle(day) for day in (3, 4, 5)])
        self.assertEqual(self._discovery(), [_cycle(day) for day in (3, 4, 5)])
        pointers = {row["uri"]: row for row in self._pointer_rows()}
        self.assertEqual(set(pointers), set(originals))
        for uri, content in originals.items():
            with self.subTest(uri=uri):
                self.assertEqual(self._cold_bytes(pointers[uri]["cold_path"]), content)
        # The publish was vouched for by the pointers, not by an operator.
        self.assertEqual(result["accepted_losses_recorded"], [])
        self.assertEqual(sorted(result["continuity"]["cold_evicted_surfaces"]),
                         sorted(result["continuity"]["lost_surfaces"]))
        governance = [row for row in load_jsonl(self.tools / "governance.jsonl")
                      if row.get("kind") == state_compact.COLD_EVICTED_EVENT]
        self.assertEqual(governance[-1]["details"], {
            "cold_commit": self._cold_tip(), "count": len(originals), "bytes": sum(map(len, originals.values())),
        })
        # The pointers and the eviction row are inside the published commit.
        committed = _git(self.store.root, "ls-tree", "-r", "--name-only", f"origin/{state_store.STATE_BRANCH}")
        self.assertIn("tools/cold/pointers/2026-08.jsonl", committed.split())
        self.assertNotIn(f"tools/discovery/{evictable[0]}/FATES.json", committed.split())


class AnElevenMebibyteArtifactStillResolves(ColdEvictionTestCase):
    def test_resolve_artifact_payload_reads_an_evicted_artifact_from_cold(self) -> None:
        big = self._seed(_cycle(1), stdout="x" * (11 * 1024 * 1024))
        for day in (2, 3, 4):
            self._seed(_cycle(day))
        ref = big["artifact_ref"]
        hot = self.tools / ref["uri"]
        expected = json.loads(hot.read_bytes())
        self.assertGreater(hot.stat().st_size, 11 * 1024 * 1024)

        self.assertTrue(self._publish("snap-1")["published"])

        self.assertFalse(hot.exists())
        self.assertEqual(resolve_artifact_payload(ref, base_dir=self.tools), expected)


class RestoreArtifactFetchesTheColdStore(ColdEvictionTestCase):
    def test_a_fresh_clone_restores_an_evicted_artifact_from_cold(self) -> None:
        old = self._seed(_cycle(1))
        content = (self.tools / old["artifact_ref"]["uri"]).read_bytes()
        for day in (2, 3, 4):
            self._seed(_cycle(day))
        self.assertTrue(self._publish("snap-1")["published"])
        pointer = cold_pointers(self.tools).evicted(old["artifact_ref"]["uri"], old["artifact_ref"]["sha256"])
        self.assertIsNotNone(pointer)

        clone = self.repo.parent / "clone-b"
        # `--no-local`: a path clone hardlinks the remote's whole object store,
        # cold blobs included; the transport carries only what main reaches.
        _git(self.repo.parent, "clone", "--quiet", "--no-local", "--single-branch", "--branch", "main",
             str(self.remote), str(clone))
        store_b = self._bound_store(clone, clone.parent / "store-b")
        tools_b = tools_root(store_b)
        missing = subprocess.run(["git", "-C", str(clone), "cat-file", "-e", pointer["git_blob"]], capture_output=True)
        self.assertNotEqual(missing.returncode, 0, "the fresh clone must not carry the cold blob yet")
        self.assertFalse((tools_b / old["artifact_ref"]["uri"]).exists())

        result = restore_artifact(
            base_dir=tools_b, artifact_ref=old["artifact_ref"]["artifact_id"],
            reason="inspect an evicted cycle", operator_approval_ref="gov:operator-approval",
        )

        self.assertEqual(result["status"], "restored")
        self.assertEqual((tools_b / old["artifact_ref"]["uri"]).read_bytes(), content)
        event = load_declared_jsonl(tools_b / "retention" / "events.jsonl", expected_surface="retention_events")[-1]
        self.assertIs(event["restored_from_cold"], True)


class TheVerifierCountsEvictedArtifacts(ColdEvictionTestCase):
    def test_refs_and_pointers_into_evicted_artifacts_verify_and_the_index_is_untouched(self) -> None:
        self._three_then_five()
        index = self.tools / "run-artifacts" / "artifact-index.jsonl"
        index_before = index.read_bytes()

        result = self._publish("snap-2")

        self.assertTrue(result["published"], result)
        self.assertEqual(index.read_bytes(), index_before)
        verdict = verify_runtime_artifacts(base_dir=self.tools, workspace_root=self.repo)
        self.assertTrue(verdict["valid"], verdict["issues"])
        # Counted per reference, as `compacted` is: each of the two evicted
        # runs names its artifact twice (`artifact_ref`, `artifact_refs`) and
        # has one raw-finding pointer into it.
        self.assertEqual(verdict["evicted_artifact_count"], 6)
        self.assertEqual(result["runtime_artifacts"]["evicted_artifact_count"], 6)
        # A compaction keeps every pointer-backed index row.
        state_compact.compact_state(base_dir=self.tools, retain_days=7)
        self.assertEqual(index.read_bytes(), index_before)


class ASecondPublishMovesNothing(ColdEvictionTestCase):
    def test_no_cold_commit_and_no_pointer_row_when_nothing_is_evictable(self) -> None:
        self._three_then_five()
        self.assertTrue(self._publish("snap-2")["published"])
        cold_tip = self._cold_tip()
        pointers = self.tools / "cold" / "pointers" / "2026-08.jsonl"
        pointer_bytes = pointers.read_bytes()
        memory = self.tools / "memory" / "beliefs.jsonl"
        memory.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(memory, {"belief_id": "b-2", "claim": "a row change"}, expected_surface="memory_beliefs")

        result = self._publish("snap-3")

        self.assertTrue(result["published"], result)
        self.assertEqual(result["cold_eviction"], {"status": "nothing_to_evict", "evictions": [{}]})
        self.assertEqual(self._cold_tip(), cold_tip)
        self.assertEqual(len(_git(self.remote, "rev-list", COLD_BRANCH).split()), 1)
        self.assertEqual(pointers.read_bytes(), pointer_bytes)


class RacingPublishersKeepTheColdHistoryLinear(ColdEvictionTestCase):
    def _clone(self) -> Path:
        clone = self.repo.parent / "clone-b"
        _git(self.repo.parent, "clone", "--quiet", str(self.remote), str(clone))
        for key, value in (("user.email", "b@example.invalid"), ("user.name", "ARIA B"), ("commit.gpgsign", "false")):
            _git(clone, "config", key, value)
        return clone

    def test_two_publishers_both_land_and_the_cold_branch_never_forks(self) -> None:
        for day in (2, 3, 4):
            self._seed(_cycle(day))
        self.assertTrue(self._publish("snap-1")["published"])
        clone = self._clone()
        store_b = self._bound_store(clone, clone.parent / "store-b")
        tools_b = tools_root(store_b)
        self._seed(_cycle(5))            # A evicts day 2
        self._seed(_cycle(1), tools=tools_b)  # B evicts days 1 and 2

        result_a = self._publish("snap-a")
        result_b = self._publish("snap-b", store=store_b)

        self.assertTrue(result_a["published"], result_a)
        self.assertTrue(result_b["published"], result_b)
        self.assertEqual(result_b["attempts"], 2)
        commits = _git(self.remote, "rev-list", "--parents", COLD_BRANCH).splitlines()
        self.assertEqual(len(commits), 2)
        self.assertTrue(all(len(line.split()) <= 2 for line in commits), commits)
        self.assertEqual(commits[0].split()[1], result_a["cold_eviction"]["cold_commit"])
        cold_paths = set(_git(self.remote, "ls-tree", "-r", "--name-only", COLD_BRANCH).split())
        final = self._bound_store(self.repo, self.repo.parent / "store-c")
        rows = self._pointer_rows(tools_root(final))
        self.assertEqual({row["cycle_id"] for row in rows}, {_cycle(1), _cycle(2)})
        self.assertEqual({row["cold_path"] for row in rows}, cold_paths)
        self.assertEqual(self._hot(tools_root(final)), [_cycle(day) for day in (3, 4, 5)])


class AColdRejectionRetriesByUnion(ColdEvictionTestCase):
    def test_a_competing_cold_commit_is_kept_under_ours(self) -> None:
        for day in (1, 2, 3, 4):
            self._seed(_cycle(day))
        competitor_clone = self.repo.parent / "competitor"
        _git(self.repo.parent, "clone", "--quiet", "--single-branch", "--branch", "main",
             str(self.remote), str(competitor_clone))
        for key, value in (("user.email", "c@example.invalid"), ("user.name", "Competitor")):
            _git(competitor_clone, "config", key, value)
        real_run_git = state_store._run_git
        injected: list[str] = []

        def compete_once(cwd, args):
            if args[0] == "push" and args[-1].endswith(f":refs/heads/{COLD_BRANCH}") and not injected:
                blob = subprocess.run(
                    ["git", "-C", str(competitor_clone), "hash-object", "-w", "--stdin"],
                    input=b"another publisher's evidence", capture_output=True, check=True,
                ).stdout.decode().strip()
                env = {**os.environ, "GIT_INDEX_FILE": str(competitor_clone / ".git" / "cold-index")}
                subprocess.run(["git", "-C", str(competitor_clone), "update-index", "--add", "--cacheinfo",
                                f"100644,{blob},sha256/aa/{'a' * 64}"], env=env, check=True)
                tree = subprocess.run(["git", "-C", str(competitor_clone), "write-tree"], env=env,
                                      capture_output=True, check=True).stdout.decode().strip()
                commit = _git(competitor_clone, "commit-tree", tree, "-m", "competitor").strip()
                _git(competitor_clone, "push", "origin", f"{commit}:refs/heads/{COLD_BRANCH}")
                injected.append(commit)
            return real_run_git(cwd, args)

        with mock.patch.object(state_store, "_run_git", side_effect=compete_once):
            result = self._publish("snap-1")

        self.assertTrue(result["published"], result)
        self.assertEqual(len(injected), 1)
        commits = _git(self.remote, "rev-list", "--parents", COLD_BRANCH).splitlines()
        self.assertEqual([line.split() for line in commits][-1], [injected[0]])
        self.assertEqual(commits[0].split()[1:], [injected[0]])
        cold_paths = set(_git(self.remote, "ls-tree", "-r", "--name-only", COLD_BRANCH).split())
        self.assertIn(f"sha256/aa/{'a' * 64}", cold_paths)
        self.assertTrue({row["cold_path"] for row in self._pointer_rows()} <= cold_paths)


class TheGateAcceptsOnlyAVerifiedArtifactEviction(ColdEvictionTestCase):
    def _lost(self, mutate) -> dict:
        mutate()
        snapshot = build_publishable_snapshot(
            self.store, snapshot_id="probe", cycle_id="probe", lane="test", repo_hash=REPO_HASH,
            previous=read_published_snapshot(self.store),
        )
        published = read_published_snapshot(self.store)
        return vouched_continuity(
            self.store, snapshot=snapshot, published=published,
            continuity=snapshot_continuity(snapshot, published),
        )

    def _pointer(self, uri: str, *, sha256: str | None = None, blob: str | None = None) -> None:
        """A pointer row for ``uri`` whose sha256 is, unless overridden, the
        very sha256 the published tip claims for it, and whose blob holds
        the file's bytes — so only the case under test can refuse it."""
        content = (self.tools / uri).read_bytes()
        written = subprocess.run(["git", "-C", str(self.store.root), "hash-object", "-w", "--stdin"],
                                 input=content, capture_output=True, check=True).stdout.decode().strip()
        claims = read_published_snapshot(self.store)["surfaces"]
        claimed = next(entry["sha256"] for entry in claims.values() if entry["path"] == uri)
        digest = sha256 or f"sha256:{claimed}"
        path = self.tools / "cold" / "pointers" / "2026-08.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(path, {
            "uri": uri, "surface": "probe", "cycle_id": _cycle(1), "sha256": digest, "size": len(content),
            "git_blob": blob or written, "cold_path": f"sha256/{digest[7:9]}/{digest[7:]}",
        }, expected_surface="cold_pointers")

    def test_a_loss_without_a_true_pointer_to_present_bytes_is_refused(self) -> None:
        self._seed(_cycle(1))
        memory = self.tools / "memory" / "beliefs.jsonl"
        memory.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(memory, {"belief_id": "b-1", "claim": "kept"}, expected_surface="memory_beliefs")
        self.assertTrue(self._publish("snap-1")["published"])
        fates = f"discovery/{_cycle(1)}/FATES.json"
        by_cycle = f"runs/by-cycle/{_cycle(1)}.jsonl"
        self.assertTrue((self.tools / by_cycle).is_file())
        cases = {
            "no pointer": (fates, lambda: None),
            "pointer sha mismatch": (fates, lambda: self._pointer(fates, sha256="sha256:" + "0" * 64)),
            "blob missing": (fates, lambda: self._pointer(fates, blob="1" * 40)),
            "ledger: memory/beliefs": ("memory/beliefs.jsonl", lambda: self._pointer("memory/beliefs.jsonl")),
            "ledger: runs/by-cycle": (by_cycle, lambda: self._pointer(by_cycle)),
        }
        claims = read_published_snapshot(self.store)["surfaces"]
        for name, (uri, write_pointer) in cases.items():
            key = next(key for key, entry in claims.items() if entry["path"] == uri)
            with self.subTest(case=name):
                kept = (self.tools / uri).read_bytes()
                pointers = self.tools / "cold" / "pointers" / "2026-08.jsonl"
                saved = pointers.read_bytes() if pointers.exists() else None
                try:
                    if uri.startswith("memory/"):
                        # A memory surface never reaches the continuity gate: the snapshot build refuses
                        # it first, because memory is append-only and a pointer never vouches for it
                        # (ARIA-HIGH-263). Either refusal stops the publish; this one names the surface.
                        with self.assertRaises(SnapshotError) as memory_refusal:
                            self._lost(lambda: (write_pointer(), (self.tools / uri).unlink()))
                        self.assertIn("snapshot_memory_surface_rewrite:memory_beliefs", str(memory_refusal.exception))
                        continue
                    with self.assertRaises(StateStoreRefusal) as caught:
                        self._lost(lambda: (write_pointer(), (self.tools / uri).unlink()))
                    self.assertIn("state_publish_continuity_surfaces_lost", str(caught.exception))
                    self.assertIn(repr(key), str(caught.exception))
                finally:
                    (self.tools / uri).write_bytes(kept)
                    if saved is None:
                        pointers.unlink(missing_ok=True)
                    else:
                        pointers.write_bytes(saved)
        # The control: the same artifact, with a true pointer to present bytes.
        verdict = self._lost(lambda: (self._pointer(fates), (self.tools / fates).unlink()))
        self.assertEqual(verdict["cold_evicted_surfaces"], [f"discovery_artifacts:{fates}"])


class LedgersAndMemoryAreUntouched(ColdEvictionTestCase):
    def test_every_ledger_only_grows_and_memory_is_byte_identical(self) -> None:
        memory = self.tools / "memory" / "beliefs.jsonl"
        memory.parent.mkdir(parents=True, exist_ok=True)
        append_declared_jsonl(memory, {"belief_id": "b-1", "claim": "kept"}, expected_surface="memory_beliefs")
        self._three_then_five()
        ledgers = {path: path.read_bytes() for path in self.tools.rglob("*.jsonl")}

        self.assertTrue(self._publish("snap-2")["published"])

        self.assertEqual(memory.read_bytes(), ledgers[memory])
        for path, before in ledgers.items():
            with self.subTest(ledger=path.relative_to(self.tools).as_posix()):
                self.assertTrue(path.read_bytes().startswith(before))
        self.assertTrue(self._pointer_rows())


class EightCyclesInOneDayKeepThree(ColdEvictionTestCase):
    def test_the_count_not_the_clock_decides(self) -> None:
        cycles = [_cycle(9, hour) for hour in range(8)]
        for cycle_id in cycles:
            self._seed(cycle_id, discovery=False)

        self.assertTrue(self._publish("snap-1")["published"])

        self.assertEqual(self._hot(), cycles[-3:])
        self.assertEqual({row["cycle_id"] for row in self._pointer_rows()}, set(cycles[:5]))


class AnOldFatesOnAFreshCheckoutIsEvicted(ColdEvictionTestCase):
    def test_the_stamp_in_the_cycle_id_ages_the_cycle_not_the_checkout_mtime(self) -> None:
        old = _cycle(5)  # 58 days before the 2026-10-02 review, by its own stamp
        self._seed(old)
        self.assertTrue(self._publish("snap-1")["published"])
        started = time.time()
        fresh = self._bound_store(self.repo, self.repo.parent / "store-fresh")
        fresh_tools = tools_root(fresh)
        fates = fresh_tools / "discovery" / old / "FATES.json"
        self.assertGreaterEqual(fates.stat().st_mtime, started - 1, "checkout stamps the file fresh")
        for day in (6, 7, 8):
            self._seed(_cycle(day), tools=fresh_tools)

        content = fates.read_bytes()

        self.assertTrue(self._publish("snap-2", store=fresh)["published"])

        self.assertFalse(fates.exists())
        pointer = cold_pointers(fresh_tools).evicted(f"discovery/{old}/FATES.json", _sha(content))
        self.assertIsNotNone(pointer)
        self.assertEqual(self._cold_bytes(pointer["cold_path"]), content)


class CycleDiffKeepsABaseline(ColdEvictionTestCase):
    def test_the_next_cycle_diffs_against_the_newest_kept_discovery(self) -> None:
        from aria_kernel.cycle_diff import run_cycle_diff

        self._three_then_five()
        self.assertTrue(self._publish("snap-2")["published"])
        nxt = _cycle(6)
        directory = self.tools / "discovery" / nxt
        directory.mkdir(parents=True)
        (directory / "FATES.json").write_text(json.dumps({"files": [{"path": "README.md", "content_hash": "x"}]}))
        (directory / "REPO_FINGERPRINT.json").write_text("{}")

        diff = run_cycle_diff(cycle_id=nxt, base_dir=self.tools)

        self.assertEqual(self._discovery(), [_cycle(day) for day in (3, 4, 5, 6)])
        self.assertEqual(diff["previous_cycle_id"], _cycle(5))
        self.assertFalse(diff["baseline"])


class TheSizeAlarmWarnsAndNeverRefuses(ColdEvictionTestCase):
    def test_a_snapshot_over_the_alarm_reports_its_largest_surfaces(self) -> None:
        from aria_kernel.cli import _handle_state_command

        self._seed(_cycle(1))
        args = argparse.Namespace(
            state_command="publish", repo_root=str(self.repo), repo_hash=REPO_HASH, branch="aria/state",
            remote="origin", store_dir=str(self.store.root), snapshot_id="snap-1", cycle_id="snap-1",
            parent_commit=None,
        )
        out = io.StringIO()
        with mock.patch.object(state_store, "STATE_SIZE_ALARM_BYTES", 1024), redirect_stdout(out):
            code = _handle_state_command(args)

        self.assertEqual(code, 0, out.getvalue())
        warning, _, body = out.getvalue().partition("\n")
        self.assertTrue(warning.startswith("::warning::aria/state attests "), warning)
        verdict = json.loads(body)
        self.assertTrue(verdict["published"])
        alarm = verdict["size_alarm"]
        self.assertGreater(alarm["total"], 1024)
        self.assertEqual(len(alarm["top5"]), 5)
        self.assertEqual(alarm["top5"], sorted(alarm["top5"], key=lambda item: -item[1]))
        self.assertIsNone(self._publish("snap-2")["size_alarm"])


class ACrashBetweenPointerAndUnlinkHeals(ColdEvictionTestCase):
    def test_the_next_publish_unlinks_without_a_second_pointer(self) -> None:
        evictable, originals = self._three_then_five()
        real_rmtree = state_compact.shutil.rmtree

        def crash(path: Path, *args, **kwargs) -> None:
            if Path(path).name in evictable:
                raise RuntimeError("runner killed between pointer append and unlink")
            return real_rmtree(path, *args, **kwargs)

        with mock.patch.object(state_compact.shutil, "rmtree", side_effect=crash):
            with self.assertRaises(RuntimeError):
                self._publish("snap-2")
        self.assertEqual({row["uri"] for row in self._pointer_rows()}, set(originals))
        self.assertTrue(all((self.tools / uri).exists() for uri in originals))

        result = self._publish("snap-3")

        self.assertTrue(result["published"], result)
        self.assertFalse(any((self.tools / uri).exists() for uri in originals))
        rows = self._pointer_rows()
        self.assertEqual(len(rows), len(originals))
        self.assertEqual(result["cold_eviction"]["evictions"][-1]["pointers_appended"], 0)


def _sha(content: bytes) -> str:
    import hashlib

    return "sha256:" + hashlib.sha256(content).hexdigest()
