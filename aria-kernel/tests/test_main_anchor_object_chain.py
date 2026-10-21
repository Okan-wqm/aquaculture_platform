"""ARIA-LOW-269 — content at a named commit is integrity-bound from the commit id down.

``main_anchor.committed_blob`` used to resolve ``<commit>:<path>`` with
``rev-parse`` and re-hash only the final blob. git serves a rewritten loose
object without checking its hash on those paths (measured on git 2.43.0:
``git rev-parse <commit>:<path>`` walks a root tree whose loose file was
rewritten under its genuine id and happily returns the attacker's blob oid,
while ``git ls-tree`` alone refuses with `hash mismatch`), so an object-store
writer steered the anchor's content by rewriting the tree — or the commit —
that names the blob. These pins forge REAL loose objects under genuine ids in
a throwaway repository and drive the REAL readers:

* a rewritten root tree (naming an attacker blob) and a rewritten commit
  (its ``tree`` line swapped, the attacker tree written under its own true
  id) are both refused by ``committed_blob``;
* ``tracked_files_at`` fails closed on the same forgeries and classifies a
  clean tree exactly as ``ls-tree`` did (a symlink is a file, a bare
  directory and a gitlink are not);
* the happy path is byte-identical on a three-level fixture, and one batched
  read per tree depth keeps a 200-path query at ``depth + 2`` git runs;
* a sha256 repository behaves the same (skipped where git cannot make one).

The ref/ancestry half — WHICH commit is trusted — stays ADR-0020's recorded
boundary (the merge lane's fresh hosted clone is its backstop); these pins
are the content half plus that boundary's detectability probes in
``test_git_containment.py``.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import unittest
import zlib
from pathlib import Path
from unittest import mock

from aria_kernel import main_anchor as ma

# A fixture that runs git must never inherit the caller's GIT_* steering
# (HANDOVER §2: an inherited GIT_DIR once rewrote a branch from a hook).
_HERMETIC_ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}

SIGNERS = "signers"
ATTACKER_KEY = b"attacker-key\n"


def _git(repo: Path, *args: str, stdin: str | None = None) -> str:
    done = subprocess.run(["git", *args], cwd=repo, input=stdin, capture_output=True, text=True,
                          check=True, env=_HERMETIC_ENV)
    return done.stdout.strip()


def _write_loose(repo: Path, oid: str, header: str, body: bytes) -> None:
    """Write zlib(header + body) under ``oid``'s loose path, hash unchecked — the forgery."""
    target = repo / ".git" / "objects" / oid[:2] / oid[2:]
    target.parent.mkdir(parents=True, exist_ok=True)
    # git writes loose objects read-only (0444), so truncating one in place is
    # EACCES for every non-root user (the CI runner included); a forger who
    # replaces the object drops it first — the directory is the fixture's own.
    target.unlink(missing_ok=True)
    target.write_bytes(zlib.compress(header.encode("ascii") + body))


def _oid(header: str, body: bytes, oid_length: int) -> str:
    digest = hashlib.sha256 if oid_length == 64 else hashlib.sha1
    return digest(header.encode("ascii") + body).hexdigest()


def _blob_oid_of(repo: Path, content: bytes) -> str:
    return _git(repo, "hash-object", "-w", "--stdin", stdin=content.decode("utf-8"))


class _ForgedRepo(unittest.TestCase):
    """A one-commit repository (all objects loose) with forgery helpers."""

    object_format: str = "sha1"

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory(prefix="aria-269-")
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name) / "repo"
        self.repo.mkdir(parents=True)
        init = ["init", "-q"]
        if self.object_format != "sha1":
            init.append(f"--object-format={self.object_format}")
        try:
            _git(self.repo, *init)
        except subprocess.CalledProcessError:
            self.skipTest(f"this git cannot init a {self.object_format} repository")
        for command in (
            ["config", "user.email", "fixture@aria.test"], ["config", "user.name", "Aria Fixture"],
            ["config", "gc.auto", "0"], ["config", "maintenance.auto", "false"],
        ):
            _git(self.repo, *command)
        (self.repo / SIGNERS).write_bytes(b"legit-key\n")
        (self.repo / "apps").mkdir()
        (self.repo / "apps" / "sample.ts").write_text("export const one = 1;\n", encoding="utf-8")
        (self.repo / "apps" / "link.ts").symlink_to("sample.ts")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-q", "-m", "fixture")
        self.head = _git(self.repo, "rev-parse", "HEAD")
        self.oid_length = len(self.head)
        self.root_tree = _git(self.repo, "rev-parse", "HEAD^{tree}")
        self.attacker_blob = _blob_oid_of(self.repo, ATTACKER_KEY)
        # The checkout is "on main", as a cycle's is.
        _git(self.repo, "update-ref", "refs/remotes/origin/main", self.head)

    def _attacker_tree_oid(self) -> str:
        """The attacker's one-entry tree, written under its own TRUE id."""
        body = f"100644 {SIGNERS}\0".encode("ascii") + bytes.fromhex(self.attacker_blob)
        header = f"tree {len(body)}\0"
        oid = _oid(header, body, self.oid_length)
        _write_loose(self.repo, oid, header, body)
        return oid

    def _rewrite_root_tree_to_name_the_attacker_blob(self) -> None:
        """The loose-root-tree forgery: attacker bytes under the GENUINE tree id."""
        body = f"100644 {SIGNERS}\0".encode("ascii") + bytes.fromhex(self.attacker_blob)
        _write_loose(self.repo, self.root_tree, f"tree {len(body)}\0", body)

    def _rewrite_commit_to_name_the_attacker_tree(self) -> None:
        """The loose-commit forgery: same-length tree swap under the GENUINE commit id."""
        raw = zlib.decompress((self.repo / ".git" / "objects" / self.head[:2] / self.head[2:]).read_bytes())
        _header, body = raw.split(b"\0", 1)
        attacker_tree = self._attacker_tree_oid()
        new_body = body.replace(self.root_tree.encode("ascii"), attacker_tree.encode("ascii"))
        _write_loose(self.repo, self.head, f"commit {len(new_body)}\0", new_body)


class VerifiedChainTests(_ForgedRepo):
    def test_a_rewritten_root_tree_is_refused_by_committed_blob(self) -> None:
        self._rewrite_root_tree_to_name_the_attacker_blob()
        blob = ma.committed_blob(self.repo, commit=self.head, path=SIGNERS)
        self.assertIsNone(
            blob,
            "a tree rewritten under its genuine id must not yield its content: "
            f"got {blob!r} for a file committed as b'legit-key\\n'")

    def test_b_rewritten_commit_object_is_refused_by_committed_blob(self) -> None:
        self._rewrite_commit_to_name_the_attacker_tree()
        blob = ma.committed_blob(self.repo, commit=self.head, path=SIGNERS)
        self.assertIsNone(
            blob,
            "a commit rewritten under its genuine id must not yield content: "
            f"got {blob!r} for a file committed as b'legit-key\\n'")

    def test_c_tracked_files_at_fails_closed_on_the_same_forgeries(self) -> None:
        self.assertEqual(ma.tracked_files_at(self.repo, commit=self.head, paths=[SIGNERS]),
                         {SIGNERS}, "the clean fixture pins the unforged behaviour first")
        self._rewrite_root_tree_to_name_the_attacker_blob()
        self.assertIsNone(ma.tracked_files_at(self.repo, commit=self.head, paths=[SIGNERS]))
        self.assertIsNone(ma.tracked_files_at(self.repo, commit=self.head, paths=["apps/sample.ts"]))

    def test_d_the_happy_path_is_byte_identical_and_classifies_like_ls_tree(self) -> None:
        blob = ma.committed_blob(self.repo, commit=self.head, path=SIGNERS)
        self.assertEqual((blob.content, blob.commit, blob.blob_oid),
                         (b"legit-key\n", self.head, _blob_oid_of(self.repo, b"legit-key\n")))
        deep = ma.committed_blob(self.repo, commit=self.head, path="apps/sample.ts")
        self.assertEqual(deep.content, b"export const one = 1;\n")
        tracked = ma.tracked_files_at(
            self.repo, commit=self.head,
            paths=[SIGNERS, "apps/sample.ts", "apps/link.ts", "apps", "nope", "./apps/sample.ts"])
        # A symlink is a tracked file (its entry is a blob: the link text); a
        # bare directory and a gitlink are not files; a relative component
        # names nothing. `ls-tree -r --name-only` agreed on the first four.
        self.assertEqual(tracked, {SIGNERS, "apps/sample.ts", "apps/link.ts"})
        self.assertEqual(
            ma.tracked_files_at(self.repo, commit=self.head, paths=[SIGNERS, "apps/sample.ts"]),
            set(ma.tracked_files_at(self.repo, commit=self.head, paths=["apps/sample.ts", SIGNERS])),
            "the result does not depend on the order paths are asked in")
        self.assertEqual(ma.tracked_files_at(self.repo, commit=self.head, paths=[]), set())
        self.assertIsNone(ma.tracked_files_at(self.repo, commit="not-an-oid", paths=[SIGNERS]))
        self.assertIsNone(ma.committed_blob(self.repo, commit=self.head, path="nope"))
        self.assertIsNone(ma.committed_blob(self.repo, commit=self.head, path="apps"),
                          "a directory is not a blob")

    def test_e_the_anchor_still_resolves_on_a_clean_checkout(self) -> None:
        self.assertEqual(ma.resolve_main_anchor(self.repo), ma.MainAnchor(self.head, None))
        self.assertEqual(ma.main_tip(self.repo), self.head)

    def test_f_a_wide_tracked_files_query_costs_depth_plus_two_git_runs(self) -> None:
        paths = ["apps/sample.ts", "apps/link.ts", SIGNERS] + [SIGNERS] * 197
        calls: list[tuple[str, ...]] = []
        real = ma._git

        def counting(repo_root, *args, **kwargs):
            calls.append(args)
            return real(repo_root, *args, **kwargs)

        with mock.patch.object(ma, "_git", counting):
            tracked = ma.tracked_files_at(self.repo, commit=self.head, paths=paths)
        self.assertEqual(tracked, {SIGNERS, "apps/sample.ts", "apps/link.ts"})
        # one commit read + one batched tree read per depth + one blob batch;
        # the deepest path here has two components, so depth + 2 = 4
        self.assertLessEqual(len(calls), 2 + 2, calls)


class Sha256ChainTests(_ForgedRepo):
    object_format = "sha256"

    def test_a_sha256_repository_refuses_the_rewritten_tree(self) -> None:
        self._rewrite_root_tree_to_name_the_attacker_blob()
        self.assertIsNone(ma.committed_blob(self.repo, commit=self.head, path=SIGNERS))

    def test_b_a_sha256_happy_path_reads_bytes(self) -> None:
        blob = ma.committed_blob(self.repo, commit=self.head, path=SIGNERS)
        self.assertEqual(blob.content, b"legit-key\n")


if __name__ == "__main__":
    unittest.main()
