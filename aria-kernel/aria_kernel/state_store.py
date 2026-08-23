"""Wave 1 §2.3 — the ``aria/state`` store: where ARIA's memory actually lives.

ARIA's accumulated state travels between runs inside a 30-day GitHub
Actions artifact. Three findings describe what that costs, and all three
are the same defect seen from different angles:

  * ORPHAN-CRITICAL-484 — a lane could publish a bootstrap-empty tree
    under the canonical artifact name, burying the other lane's queue.
  * ORPHAN-CRITICAL-488 — the gate added for 484 made a genuine first
    run impossible: a newborn tree could never publish, permanently.
  * ORPHAN-CRITICAL-513 — the 484/488 fix lived in two hand-copied
    workflow heredocs and only one of them got it, so the producer lane
    kept the hole the consumer lane had closed.

513 was answered by extracting one composite restore action, and that
was right as far as it went. What it could not fix is the KIND of proof
available at that layer. ``restored=true`` is a claim about a STEP: the
download succeeded. It says nothing about the bytes on disk at publish
time, so a tree emptied between restore and publish still satisfies it,
and an empty tree passes ``integrity verify`` because an empty tree is
trivially consistent. The gate can only ever be as strong as its
evidence, and a workflow output is the wrong kind of evidence.

``state_snapshot`` produced the right kind: ``manifest_root``, a hash
over the whole surface map, which cannot be reproduced from a fresher,
emptier tree. This module spends it. ``publish_state`` refuses unless
the snapshot it is publishing names the CURRENT published snapshot as
its parent — ``prev_manifest_root == <remote tip>.manifest_root``. That
is a positive proof of descent over content, and it is checked inside
the function rather than by the caller, so a second lane cannot be
written without it. 513's failure mode is not "someone forgot to copy
the check"; it is that the check was ever copyable.

Bootstrap is the one case with no parent to name, and 488 is what
happens when that case is inferred. Here it is never inferred: the
branch existing IS the proof that bootstrap already happened, and
creating it requires ``ARIA_STATE_BOOTSTRAP_ACK`` naming the repository
out loud. A deleted branch therefore does not silently re-bootstrap —
it refuses, which is the behaviour 484 wanted and the artifact
transport could not express.

FF-only is not enforced by a flag this module sets. It is what a plain
``git push`` already is: the server rejects a non-fast-forward update.
This module's contribution is to never reach for the escape hatch, and
``tests/test_state_store.py::ForceIsNotReachable`` holds the single push
callsite to that over the AST. A server-side ruleset on ``aria/state``
closes the same door against writers that are not this module; that is
operator setup, not a precondition for this path being correct.
"""

from __future__ import annotations

import hashlib
import json
import os
import selectors
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import canonical_json, json_nesting_within_limit
from .file_lock import ExclusiveLockHandle
from .state_manifest import normalize_surface_relative_path
from .state_snapshot import (
    SNAPSHOT_MAX_LEDGER_LINE_BYTES,
    SNAPSHOT_MAX_LEDGER_ROWS,
    SnapshotError,
    _bounded_regular_file_chunks,
    build_snapshot,
    snapshot_continuity,
    validate_snapshot_manifest,
    verify_manifest_root,
)

STATE_BRANCH = "aria/state"
STORE_DIRNAME = ".aria-state-store"
SNAPSHOT_FILENAME = "snapshot.json"
GENESIS_FILENAME = "GENESIS"
BOOTSTRAP_ACK_ENV = "ARIA_STATE_BOOTSTRAP_ACK"
_MAX_HOST_DERIVATIVE_BYTES = 16 * 1024 * 1024
_MAX_REFERENCED_SURFACE_BYTES = 1024 * 1024 * 1024
_MAX_GIT_OUTPUT_BYTES = 1024 * 1024
_MAX_REMOTE_OUTPUT_BYTES = 64 * 1024
_MAX_GIT_STDERR_BYTES = 64 * 1024
_MAX_STATUS_OUTPUT_BYTES = 16 * 1024 * 1024
_MAX_STATUS_ENTRIES = 20_000
_MAX_STATUS_RECORD_BYTES = 64 * 1024

# Subtrees inside the store, one per manifest ``root_kind``. Named here
# rather than assembled at each callsite so "where does the tools root
# live" has one answer; a second layout would put the two lanes back in
# the position 513 describes.
TOOLS_SUBDIR = "tools"
WORKSPACE_SUBDIR = "workspace"
FINDINGS_SUBDIR = "findings"

# Every git call is bounded. An unbounded fetch against an unreachable
# remote hangs the publishing step, and a cycle that cannot finish also
# cannot be recovered by a watchdog waiting for that cycle to report.
GIT_TIMEOUT_SECONDS = 120

# The store commits under its own identity, passed per-invocation rather
# than read from ambient config. A runner without user.name set would
# otherwise fail at the commit — after the snapshot was written and the
# ancestry checked — which turns a missing config line into a lost
# publish. Naming the author also keeps state commits distinguishable
# from a lane's ordinary work in the branch log.
COMMITTER_NAME = "aria-state-store"
COMMITTER_EMAIL = "aria-state-store@users.noreply.github.com"


class StateStoreError(RuntimeError):
    """Raised when the store cannot be reached, read, or written."""


class StateStoreRefusal(StateStoreError):
    """A deliberate refusal to publish, distinct from a failure to try.

    Separated from ``StateStoreError`` because callers must be able to
    tell "the ancestry proof did not hold" (do not retry; something is
    wrong with the state) from "the network was down" (retry is
    reasonable). Collapsing them is how a refusal gets retried into
    success.
    """


class StatePublishOutcomeUnknown(StateStoreError):
    """The server may have accepted a push, so replay would risk duplication."""


class StatePublishContention(StateStoreRefusal):
    """A verified remote winner excludes this publish's exact commit."""

    def __init__(
        self,
        winner_commit: str,
        loser_commit: str,
        base_commit: str,
        detail: str,
    ) -> None:
        self.winner_commit = winner_commit
        self.loser_commit = loser_commit
        self.base_commit = base_commit
        super().__init__(
            "state_publish_push_rejected: another lane published first. "
            "The exact local commit is absent from the verified winner; its "
            f"rows are staged and intact for replay. ({detail})"
        )


@dataclass(frozen=True)
class _RemoteTipProbe:
    status: str
    sha: str | None = None
    detail: str = ""


@dataclass(frozen=True)
class StateStore:
    """A checked-out working tree of the state branch."""

    root: Path
    branch: str
    repo_root: Path
    remote: str
    bootstrapped: bool


def tools_root(store: StateStore) -> Path:
    return store.root / TOOLS_SUBDIR


def workspace_root(store: StateStore, repo_hash: str) -> Path:
    if not repo_hash or "/" in repo_hash or repo_hash in {".", ".."}:
        raise StateStoreError(f"state_store_repo_hash_invalid: {repo_hash!r}")
    return store.root / WORKSPACE_SUBDIR / repo_hash


def findings_root(store: StateStore) -> Path:
    return store.root / FINDINGS_SUBDIR


def snapshot_path(store: StateStore) -> Path:
    return store.root / SNAPSHOT_FILENAME


def store_roots(store: StateStore, repo_hash: str) -> dict[str, Path]:
    """The ``roots`` mapping ``build_snapshot`` expects for this store.

    Derived from the store rather than assembled by each caller: a lane
    that omitted ``workspace`` here would produce a snapshot that simply
    does not mention those surfaces, and the continuity checker would
    read the omission as loss on the next run — a false alarm that looks
    exactly like the real one.
    """
    return {
        "tools": tools_root(store),
        "workspace": workspace_root(store, repo_hash),
        "repo": findings_root(store),
    }


def store_environment(store: StateStore, repo_hash: str) -> dict[str, str]:
    """The exact environment a lane must run with to write into the store.

    ONE definition of the binding, because three roots have to agree and
    a lane that got two of them right would look like it was working
    while a third of ARIA's memory kept dying with the runner. Each
    variable is the existing seam for its root:

      * ``ARIA_WORKSPACE_BASE`` — ``workspace_paths`` appends the repo
        hash itself, so this is the PARENT of the per-repo directory.
        (Point it at the per-repo directory and every surface silently
        lands one level too deep, which reads as total loss on the next
        continuity check.)
      * ``ARIA_REPO_STATE_ROOT`` — ``aria-findings/`` and ``aria-debts/``
        hang off this. Its absence is what reset finding IDs to F-001.
      * ``ARIA_TOOLS_DIR`` — the 144 tools-root surfaces.

    Returned rather than exported: a function that mutated ``os.environ``
    would be invisible at the callsite and impossible to test without
    leaking into the rest of the process.
    """
    return {
        "ARIA_WORKSPACE_BASE": (store.root / WORKSPACE_SUBDIR).as_posix(),
        "ARIA_REPO_STATE_ROOT": findings_root(store).as_posix(),
        "ARIA_TOOLS_DIR": tools_root(store).as_posix(),
        # Named so a reader of `env` output can tell which store produced
        # it without having to reconstruct the path convention.
        "ARIA_STATE_STORE_ROOT": store.root.as_posix(),
    }


def _attest_state_writer(store: "StateStore", *, action: str) -> None:
    """ORPHAN-MEDIUM-767 — attribute every LOCAL state-tree materialization.

    The local mirror's ledgers were batch-touched twice on 2026-08-20 with
    nanosecond-identical mtimes and no content change; the ledgers are
    gitignored, so no VCS signal exists, and the writer could not be named.

    The attestation is a HOST-LOCAL sibling of the store directory, never a
    write into the store worktree itself: the store's clean-tree and
    snapshot-continuity invariants must not see it, and the branch side is
    already attributed by git (every publish is a commit). What git cannot
    name is the local materialization — this file names it: action, pid,
    command, timestamp. Best-effort: checkout must never fail because the
    attestation could not be written.
    """
    try:
        import json as _json
        from datetime import datetime, timezone

        ledger = store.root.parent / f"{store.root.name}.writers.jsonl"
        row = {
            "recorded_at": datetime.now(timezone.utc).isoformat(),
            "action": action,
            "pid": os.getpid(),
            "command": " ".join(sys.argv[:8]),
        }
        with ledger.open("a", encoding="utf-8") as handle:
            handle.write(_json.dumps(row, sort_keys=True) + "\n")
    except Exception:  # noqa: BLE001 — best-effort, see docstring
        pass


def checkout_state_store(
    repo_root: str | Path,
    *,
    branch: str = STATE_BRANCH,
    remote: str = "origin",
    store_dir: str | Path | None = None,
    fetch: bool = True,
) -> StateStore:
    """Materialise the state branch as a worktree beside the checkout.

    When the branch exists remotely it is fetched and checked out. When
    it does not, this REFUSES unless ``ARIA_STATE_BOOTSTRAP_ACK`` names
    the repository — see the module docstring for why bootstrap is
    acknowledged rather than inferred.
    """
    repo_root = Path(repo_root).resolve()
    if not (repo_root / ".git").exists():
        raise StateStoreError(f"state_store_not_a_repo: {repo_root.as_posix()}")
    root = Path(store_dir).resolve() if store_dir else repo_root / STORE_DIRNAME

    tracking_ref = f"refs/remotes/{remote}/{branch}"
    remote_ref = f"refs/heads/{branch}"
    probe = _probe_remote_tip_at(
        repo_root,
        remote=remote,
        branch=branch,
    )
    if probe.status == "unavailable":
        raise StateStoreError(
            "state_store_remote_tip_unavailable: the exact state branch could "
            f"not be read ({probe.detail})"
        )
    if probe.status == "malformed":
        raise StateStoreError(
            "state_store_remote_tip_malformed: the state branch listing was "
            f"not one canonical record ({probe.detail})"
        )
    branch_exists = probe.status == "present"
    remote_head: str | None = None
    if branch_exists:
        if probe.sha is None:  # pragma: no cover - parser invariant
            raise StateStoreError("state_store_remote_tip_malformed")
        if fetch:
            remote_head = _fetch_remote_branch_tip_at(
                repo_root,
                remote=remote,
                branch=branch,
                error_prefix="state_store_fetch_failed",
            )
            fresh = _probe_remote_tip_at(
                repo_root,
                remote=remote,
                branch=branch,
            )
            if fresh.status != "present" or fresh.sha != remote_head:
                raise StateStoreError(
                    "state_store_remote_tip_changed: the state branch did not "
                    "remain exactly equal to the uniquely fetched commit"
                )
        else:
            remote_head = _read_commit_ref(repo_root, tracking_ref)
            if remote_head != probe.sha:
                raise StateStoreError(
                    f"state_store_fetch_stale: {tracking_ref} is at "
                    f"{remote_head or '<absent>'} but {remote}/{branch} is at "
                    f"{probe.sha}; fetch was disabled"
                )
        _advance_checkout_tracking_ref(
            repo_root,
            tracking_ref=tracking_ref,
            target=remote_head,
        )

    # Z1 (ORPHAN-712) — a DELETED store bypasses every protection below:
    # `_clear_existing_store`'s unpublished-work refusal only fires when the
    # directory exists, so anything written since the last publish vanishes
    # and the next run silently re-materialises the remote tip as if nothing
    # happened. Measured live 2026-08-17: the hourly dataflow watchdog's
    # `git clean -ffdx` swept the store between runs. The deletion cannot be
    # prevented here (the sweeper is another process), but it can never
    # again be SILENT: a registered-but-missing worktree is disclosed as a
    # governance event on the freshly restored store.
    vanished_while_registered = (not root.exists()) and _worktree_registered(repo_root, root)

    if root.exists():
        _clear_existing_store(repo_root, root, remote=remote, branch=branch)

    if branch_exists:
        if remote_head is None:  # pragma: no cover - branch_exists invariant
            raise StateStoreError("state_store_remote_tip_unavailable")
        # DETACHED, never a local branch. Checking the state branch out as
        # a branch means every store in this repository shares one ref, so
        # two lanes racing on the same runner would CHAIN — the second
        # committing on top of the first and fast-forwarding cleanly —
        # instead of colliding. That is the compare-and-swap silently not
        # happening, which is worse than the race it was meant to catch.
        # Detached, each store's HEAD moves alone and the only shared ref
        # is the remote's, where the server arbitrates.
        _git(
            repo_root,
            "worktree",
            "add",
            "--detach",
            "--force",
            str(root),
            remote_head,
        )
        if vanished_while_registered:
            _disclose_rematerialized_after_missing(root, branch=branch)
        store = StateStore(
            root=root,
            branch=branch,
            repo_root=repo_root,
            remote=remote,
            bootstrapped=False,
        )
        _attest_state_writer(store, action="checkout")
        return store

    _require_bootstrap_ack(repo_root, branch)
    _git(repo_root, "worktree", "add", "--detach", "--force", str(root), "HEAD")

    # An orphan needs a branch name to be created under; it does not need
    # to keep one. The name is store-local and deleted as soon as the
    # genesis commit exists, so bootstrap does not reintroduce the shared
    # ref the restored path just avoided.
    orphan_ref = f"aria-state-bootstrap-{hashlib.sha256(str(root).encode()).hexdigest()[:12]}"
    _git(root, "checkout", "--orphan", orphan_ref)
    _git(root, "rm", "-rf", "--quiet", "--ignore-unmatch", ".")
    for subdir in (TOOLS_SUBDIR, WORKSPACE_SUBDIR, FINDINGS_SUBDIR):
        (root / subdir).mkdir(parents=True, exist_ok=True)
        (root / subdir / ".gitkeep").write_text("", encoding="utf-8")
    (root / GENESIS_FILENAME).write_text(
        canonical_json(
            {
                "$schema": "aria/state-genesis/v1",
                "branch": branch,
                "repository": _repository_identity(repo_root),
                "acknowledged_by": os.environ.get(BOOTSTRAP_ACK_ENV, ""),
            }
        )
        + "\n",
        encoding="utf-8",
    )
    _git(root, "add", "--all", ".")
    _git_commit(root, f"chore(aria-state): genesis for {branch}")
    _git(root, "checkout", "--detach", "HEAD")
    _git(root, "branch", "--delete", "--force", orphan_ref)
    store = StateStore(
        root=root,
        branch=branch,
        repo_root=repo_root,
        remote=remote,
        bootstrapped=True,
    )
    _attest_state_writer(store, action="bootstrap")
    return store



def _worktree_registered(repo_root: Path, root: Path) -> bool:
    """Is ``root`` a registered git worktree of ``repo_root``?"""
    listing = _git(repo_root, "worktree", "list", "--porcelain", check=False)
    needle = f"worktree {root.as_posix()}"
    return any(line.strip() == needle for line in listing.splitlines())


def _disclose_rematerialized_after_missing(root: Path, *, branch: str) -> None:
    """Z1 (ORPHAN-712) — the store vanished between runs; say so, durably.

    Written onto the FRESHLY RESTORED store so the disclosure itself is
    published with the next state push. Best-effort by design: the restore
    must never fail because the disclosure could not be written.
    """
    try:
        from .tool_registry import append_tools_governance

        append_tools_governance(
            root / "tools",
            "state_store_rematerialized_after_missing",
            {
                "branch": branch,
                "store_root": root.as_posix(),
                "note": (
                    "store directory was deleted while its worktree stayed "
                    "registered; anything unpublished at deletion time is gone"
                ),
            },
        )
    except Exception:
        pass

def read_published_snapshot(store: StateStore) -> dict[str, Any] | None:
    """The snapshot at the store's HEAD COMMIT, or ``None`` before the first publish.

    Read from the commit, never from the working tree. The published
    snapshot is the thing the next snapshot must prove descent from, so
    an uncommitted local edit to ``snapshot.json`` must not be able to
    move the anchor — a caller that could rewrite the file it is about
    to be checked against is not being checked.

    Reading the commit also makes "newborn" derivable instead of
    remembered: HEAD carrying ``GENESIS`` but no snapshot IS a branch
    that has never published, and HEAD carrying neither is a damaged
    store. ORPHAN-CRITICAL-488 is what happens when those two are
    inferred from one absent file.
    """
    return _read_snapshot_at(store, _publication_anchor(store))


def read_snapshot_at_worktree_head(
    store: StateStore,
    *,
    expected_head: str | None = None,
) -> dict[str, Any] | None:
    """The snapshot THIS WORKTREE was built on, which is a different question.

    `read_published_snapshot` answers "what does the remote say is published",
    and anchors on the remote-tracking ref for the reason `_publication_anchor`
    gives: nothing local may vote on what is published.

    A REPLAY BASE is the other question entirely — "what did these rows get
    appended to" — and only the worktree's own HEAD answers it. Passing the
    remote tip instead looks right and is not: when the store is BEHIND the
    tip, the local rows were never appended to that tree, so
    `append_only_suffix` correctly refuses with `replay_prefix_diverged`. That
    refusal is the guard working; this function is what stops it being asked
    the wrong question. Found by running the recovery, not by reading it.
    """
    head = _read_commit_ref(store.root, "HEAD")
    if head is None:
        raise StateStoreError(
            "state_store_worktree_head_unavailable: replay base HEAD is not an "
            "exact commit"
        )
    if expected_head is not None and head != expected_head:
        raise StateStoreRefusal(
            "state_publish_base_head_moved: replay base HEAD changed before its "
            "snapshot could be read"
        )
    return _read_snapshot_at(store, head)


def _read_snapshot_at(store: StateStore, anchor: str) -> dict[str, Any] | None:
    # Presence comes from git's EXIT STATUS, never from output emptiness.
    # `git show` returns the empty string for three different facts — the
    # path is absent from the commit, the command failed, and the path is
    # present but is a zero-length blob — and collapsing them makes a
    # truncated snapshot.json read as "newborn", which switches the
    # ancestry check off entirely and lets any tree publish over the
    # accumulated state.
    if _git_succeeds(store.root, "cat-file", "-e", f"{anchor}:{SNAPSHOT_FILENAME}"):
        blob = _git(store.root, "cat-file", "blob", f"{anchor}:{SNAPSHOT_FILENAME}")
        if not blob.strip():
            raise StateStoreError(
                f"state_store_snapshot_empty: {anchor}:{SNAPSHOT_FILENAME} exists but is "
                "empty; a truncated snapshot is a damaged store, not a first run"
            )
        return _parse_snapshot(blob, f"{anchor}:{SNAPSHOT_FILENAME}")
    if _git_succeeds(store.root, "cat-file", "-e", f"{anchor}:{GENESIS_FILENAME}"):
        return None
    raise StateStoreError(
        f"state_store_snapshot_missing: {anchor} carries neither "
        f"{SNAPSHOT_FILENAME} nor {GENESIS_FILENAME}; this is a damaged store, "
        "not a first run"
    )


def _publication_anchor(store: StateStore) -> str:
    """The commit whose snapshot counts as PUBLISHED.

    The remote-tracking ref when there is one, HEAD only on a store that
    has never had a remote tip (bootstrap, before the first push).

    Anchoring on HEAD alone was a livelock: ``publish_state`` commits
    before it pushes, so the loser of a compare-and-swap ends up with its
    OWN rejected commit as HEAD. Every retry then read that commit as
    "what is published", chained the next snapshot to itself, passed the
    ancestry check, and was rejected again — permanently unpushable, with
    the only escape being the re-checkout that deletes the work. Published
    means the remote has it; nothing local can vote on that.
    """
    tracking = f"refs/remotes/{store.remote}/{store.branch}"
    if _git_succeeds(store.root, "rev-parse", "--verify", "--quiet", tracking):
        return tracking
    return "HEAD"


def open_state_store(
    repo_root: str | Path,
    *,
    branch: str = STATE_BRANCH,
    remote: str = "origin",
    store_dir: str | Path | None = None,
) -> StateStore:
    """Attach to an existing store WITHOUT touching its working tree.

    Split from ``checkout_state_store`` because the two have opposite
    obligations. Checkout establishes the store at the remote tip and so
    must refuse to run over uncommitted writes; opening happens at the
    END of a run, when those uncommitted writes are the entire point.
    Collapsing them into one function gave a ``publish`` that could never
    publish anything a cycle had written — it re-checked-out first and
    refused on the very rows it was called to persist.
    """
    repo_root = Path(repo_root).resolve()
    root = Path(store_dir).resolve() if store_dir else repo_root / STORE_DIRNAME
    if not _is_worktree_of(repo_root, root):
        raise StateStoreError(
            f"state_store_not_open: {root.as_posix()} is not a checked-out store of "
            "this repository; run `state checkout` before writing state into it"
        )
    return StateStore(
        root=root,
        branch=branch,
        repo_root=repo_root,
        remote=remote,
        bootstrapped=False,
    )


def publish_state(
    store: StateStore,
    *,
    snapshot: dict[str, Any],
    cycle_id: str,
    repo_hash: str,
    expected_base_head: str | None = None,
) -> dict[str, Any]:
    """Commit and push a snapshot — refusing unless it descends from the tip.

    THE ANCESTRY PROOF LIVES HERE, not at the callsite. Every lane
    reaches the store through this one function, so "the producer lane
    was missing the check" (ORPHAN-CRITICAL-513) is not a state this
    codebase can be in: there is no second path to be missing it from.

    The proof is content-addressed. ``prev_manifest_root`` sits inside
    the hashed payload of the snapshot being published, so it cannot be
    edited to name a different parent without changing the snapshot's
    own root. Matching it against the tip's ``manifest_root`` is
    therefore a statement about the bytes, not about whether a download
    step exited zero.
    """
    entry_head = _read_commit_ref(store.root, "HEAD")
    if entry_head is None:
        raise StateStoreRefusal(
            "state_publish_base_head_unavailable: HEAD is not an exact commit; "
            "refusing before mutating the store"
        )
    bound_base_head = expected_base_head or entry_head
    if entry_head != bound_base_head:
        raise StateStoreRefusal(
            "state_publish_base_head_moved: HEAD no longer matches the exact "
            "commit whose snapshot was used; refusing before mutation"
        )

    # ORPHAN-MEDIUM-767 note: publish is attributed BY GIT (the commit it
    # creates); the anonymous touches were LOCAL tree materializations, and
    # those attest in checkout_state_store. Attesting here would mutate the
    # tree AFTER the snapshot was built and break manifest continuity.
    if not verify_manifest_root(snapshot):
        raise StateStoreRefusal(
            "state_publish_manifest_root_mismatch: the snapshot's recorded root does "
            "not match its content; refusing to publish an unverifiable claim"
        )

    published = read_published_snapshot(store)
    continuity = snapshot_continuity(snapshot, published)

    if published is None:
        # No predecessor is legitimate exactly once, on a branch whose
        # HEAD is the genesis commit — `read_published_snapshot` already
        # refused anything else, so reaching here IS the newborn case
        # ORPHAN-CRITICAL-488 says must stay publishable.
        if snapshot.get("prev_manifest_root") is not None:
            raise StateStoreRefusal(
                "state_publish_genesis_claims_parent: a bootstrap snapshot names a "
                f"predecessor ({snapshot.get('prev_snapshot_id')!r}) the store does "
                "not have"
            )
    else:
        expected = published.get("manifest_root")
        actual = snapshot.get("prev_manifest_root")
        if actual != expected:
            # The absorbing failure 484 names: this tree does not descend
            # from what is published, so writing it would bury state that
            # nothing else holds. Refuse rather than overwrite — a lost
            # publish is recoverable, an overwritten history is not.
            raise StateStoreRefusal(
                "state_publish_ancestry_unproven: snapshot.prev_manifest_root="
                f"{actual!r} does not match the published tip's manifest_root="
                f"{expected!r}; refusing to overwrite state this tree does not descend from"
            )
        if continuity["status"] != "ok":
            raise StateStoreRefusal(
                f"state_publish_continuity_{continuity['status']}: "
                f"lost_surfaces={continuity['lost_surfaces']}"
            )

    snapshot_file = snapshot_path(store)
    snapshot_file.parent.mkdir(parents=True, exist_ok=True)
    snapshot_file.write_text(canonical_json(snapshot) + "\n", encoding="utf-8")

    # STAGE EXACTLY THE ATTESTED SURFACES — never the whole tree.
    #
    # `git add --all .` would commit whatever happens to be sitting in the
    # store, and the roots a lane binds here are shared with directories
    # that hold SECRETS: `gh_token_factory` writes per-cycle ed25519
    # private keys and scoped installation tokens to `aria-debts/keys/`,
    # right beside the declared `aria-debts/` ledgers. The main checkout's
    # `.gitignore` covers that path, but it does not reach inside a
    # worktree whose top level is `store_dir` — and `--force` would
    # override it even if it did. A whole-tree add is therefore one
    # redirected root away from pushing private keys to a branch.
    #
    # Listing the snapshot's own paths removes the class rather than the
    # instance: an undeclared file cannot be committed because nothing
    # names it, so no new ignore rule is needed for each new secret. It
    # also binds the commit to the attestation by construction — the tree
    # IS the surface set the manifest walked, not merely consistent with
    # it — and it makes ignore configuration irrelevant, which is why the
    # `--force` is gone.
    #
    # `--all` on the pathspec so a surface that DISAPPEARED stages as a
    # deletion; without it a removed ledger would silently stay in the
    # branch while the snapshot stopped mentioning it.
    #
    # `--force` is safe HERE, and only here, precisely because the
    # pathspec is bounded: it overrides ignore rules for the declared
    # surfaces without giving anything undeclared a way in. A shared
    # `info/exclude` pattern must not be able to subtract a surface the
    # snapshot attests — that would be the branch carrying less than its
    # own manifest claims. The danger was never `--force`; it was
    # `--force` over the whole tree.
    staged = _staged_pathspecs(store, snapshot, published, repo_hash)
    _git(store.root, "add", "--all", "--force", "--", *staged)

    pre_commit_head = _read_commit_ref(store.root, "HEAD")
    if pre_commit_head != bound_base_head:
        raise StateStoreRefusal(
            "state_publish_base_head_moved: HEAD changed after snapshot binding; "
            "refusing before commit, reset, or push"
        )

    if not _git(store.root, "diff", "--cached", "--name-only").strip():
        return {
            "published": False,
            "reason": "no_changes",
            "snapshot_id": snapshot.get("snapshot_id"),
            "manifest_root": snapshot.get("manifest_root"),
            "continuity": continuity,
        }

    # The commit that the push must either carry or undo is the same immutable
    # SHA whose snapshot the replay orchestrator read.  A second independent
    # HEAD capture here would silently rebase the claim onto a racing writer.
    _git_commit(
        store.root,
        f"chore(aria-state): {cycle_id} {snapshot.get('snapshot_id', '')}".strip(),
    )

    # Verify the exact immutable tree Git is about to publish. A declared
    # surface can change after snapshot construction but before ``git add``;
    # bounded staging alone cannot prove the staged bytes still match the
    # caller's snapshot. Reuse autonomy evidence's canonical commit verifier
    # so publishing and later admission cannot drift into weaker definitions.
    committed_head = ""
    try:
        from .autonomy_evidence import _verify_published_snapshot_commit

        committed_head = _git(
            store.root,
            "rev-parse",
            "--verify",
            "HEAD^{commit}",
        ).strip()
        _verify_published_snapshot_commit(
            store=store,
            repo_identity=repo_hash,
            state_commit=committed_head,
            expected_snapshot=snapshot,
        )
    except Exception as exc:  # noqa: BLE001 - any unverifiable commit refuses
        if not committed_head:
            raise StateStoreRefusal(
                "state_publish_commit_identity_unavailable: the just-created "
                "commit's exact SHA could not be read, so ownership cannot be "
                "proved; refusing without reset or push and leaving the commit "
                "recoverable at HEAD"
            ) from exc
        if not pre_commit_head:
            raise StateStoreRefusal(
                "state_publish_rollback_target_unavailable: the pre-commit "
                "HEAD could not be identified; refusing without resetting "
                "the recoverable commit"
            ) from exc
        try:
            _soft_reset_owned_commit(
                store,
                committed_head=committed_head,
                base_head=pre_commit_head,
            )
        except StateStoreError as rollback_error:
            raise rollback_error from exc
        detail = str(exc)[:200]
        raise StateStoreRefusal(
            "state_publish_commit_snapshot_mismatch: the just-created commit "
            "does not exactly satisfy its immutable snapshot; the commit was "
            f"rolled back and staged bytes remain recoverable ({detail})"
        ) from exc

    current_head = _git(
        store.root,
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
        check=False,
    ).strip()
    if current_head != committed_head:
        raise StateStoreRefusal(
            "state_publish_head_moved_after_verification: HEAD changed after "
            "the immutable commit verifier completed; refusing without "
            "resetting or pushing another writer's commit"
        )

    # Push the exact verified object id, never the moving ``HEAD`` symbolic
    # ref. A non-fast-forward update is rejected by the server, which is the
    # compare-and-swap this design relies on.
    proc = _run_git(
        store.root,
        (
            "push",
            store.remote,
            f"{committed_head}:refs/heads/{store.branch}",
        ),
    )
    push_outcome = "accepted"
    remote_tip = committed_head
    if proc.returncode != 0:
        detail = proc.stderr.strip()[:300]
        remote_tip = _reconcile_nonzero_push(
            store,
            committed_head=committed_head,
            base_head=pre_commit_head,
            detail=detail,
        )
        push_outcome = "reconciled"

    # Keep the tracking ref honest: it is the ancestry anchor, and a
    # publish that moved the server without moving it would make the next
    # cycle chain to a tip that is no longer current.
    _advance_tracking_ref_cas(store, remote_tip)

    return {
        "published": True,
        "pushed": True,
        "snapshot_id": snapshot.get("snapshot_id"),
        "manifest_root": snapshot.get("manifest_root"),
        "continuity": continuity,
        "push_outcome": push_outcome,
        "remote_tip": remote_tip,
    }


def _staged_pathspecs(
    store: StateStore,
    snapshot: dict[str, Any],
    published: dict[str, Any] | None,
    repo_hash: str,
) -> list[str]:
    """Store-relative paths for everything this publish may commit.

    The snapshot's markers, plus one entry per surface attested NOW,
    plus one per surface the PUBLISHED snapshot attested — translated
    from root-relative (what ``build_snapshot`` records) to store-relative
    (what ``git add`` needs) through the same ``store_roots`` mapping that
    produced them.

    The predecessor's paths are what let a surface that VANISHED stage as
    a deletion: ``build_snapshot`` only records files that exist, so the
    current snapshot cannot name what is gone. Without them a removed
    ledger would linger in the branch while the manifest stopped
    mentioning it — the tree and its attestation quietly disagreeing.

    Deliberately NOT the subtree prefixes. ``git add --all -- tools``
    would re-admit every undeclared file under it, which is the whole
    thing this list exists to prevent.
    """
    roots = store_roots(store, repo_hash)
    specs = {SNAPSHOT_FILENAME, GENESIS_FILENAME}
    for source in (snapshot, published or {}):
        for entry in (source.get("surfaces") or {}).values():
            root = roots.get(entry.get("root_kind"))
            if root is None:
                continue
            try:
                prefix = root.relative_to(store.root).as_posix()
            except ValueError:  # pragma: no cover - store_roots is store-relative
                raise StateStoreError(
                    f"state_store_root_outside_store: {root.as_posix()} is not inside "
                    f"{store.root.as_posix()}"
                ) from None
            specs.add(f"{prefix}/{entry['path']}")
    return sorted(specs)


def _full_git_sha(value: str) -> bool:
    return (
        value != "0" * 40
        and len(value) == 40
        and all(character in "0123456789abcdef" for character in value)
    )


def _parse_remote_tip_listing(listing: str, *, ref: str) -> _RemoteTipProbe:
    """Parse exactly one ``ls-remote`` branch record without token guessing."""
    if not listing:
        return _RemoteTipProbe("absent")
    record = listing.removesuffix("\n")
    if not record or "\n" in record or "\r" in record:
        return _RemoteTipProbe("malformed", detail="invalid ref record count")
    sha, separator, listed_ref = record.partition("\t")
    if separator != "\t" or listed_ref != ref or not _full_git_sha(sha):
        return _RemoteTipProbe("malformed", detail="invalid ref record")
    return _RemoteTipProbe("present", sha=sha)


def _probe_remote_tip(store: StateStore) -> _RemoteTipProbe:
    """Read one exact branch ref without conflating absence and uncertainty."""
    return _probe_remote_tip_at(
        store.root,
        remote=store.remote,
        branch=store.branch,
    )


def _probe_remote_tip_at(
    root: Path,
    *,
    remote: str,
    branch: str,
) -> _RemoteTipProbe:
    ref = f"refs/heads/{branch}"
    try:
        proc = _run_git(
            root,
            ("ls-remote", "--heads", remote, ref),
        )
    except StateStoreError as exc:
        return _RemoteTipProbe("unavailable", detail=str(exc)[:300])
    if proc.returncode != 0:
        return _RemoteTipProbe("unavailable", detail=proc.stderr.strip()[:300])
    return _parse_remote_tip_listing(proc.stdout, ref=ref)


def _remote_tip(store: StateStore) -> str | None:
    """Compatibility reader for callers where non-present means unavailable."""
    probe = _probe_remote_tip(store)
    return probe.sha if probe.status == "present" else None


def _read_commit_ref(root: Path, ref: str) -> str | None:
    proc = _run_git(root, ("rev-parse", "--verify", f"{ref}^{{commit}}"))
    if proc.returncode != 0:
        return None
    value = proc.stdout.strip()
    return value if _full_git_sha(value) else None


def _strict_is_ancestor(root: Path, ancestor: str, descendant: str) -> bool:
    proc = _run_git(
        root,
        ("merge-base", "--is-ancestor", ancestor, descendant),
    )
    if proc.returncode == 0:
        return True
    if proc.returncode == 1:
        return False
    raise StatePublishOutcomeUnknown(
        "state_publish_outcome_unknown: git ancestry could not be verified "
        f"({proc.stderr.strip()[:300]})"
    )


def _fetch_remote_branch_tip(store: StateStore) -> str:
    try:
        return _fetch_remote_branch_tip_at(
            store.root,
            remote=store.remote,
            branch=store.branch,
            error_prefix="state_publish_reconciliation_fetch_failed",
        )
    except StateStoreError as exc:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: reconciliation fetch unavailable "
            f"({exc})"
        ) from exc


def _fetch_remote_branch_tip_at(
    root: Path,
    *,
    remote: str,
    branch: str,
    error_prefix: str,
) -> str:
    remote_ref = f"refs/heads/{branch}"
    fetched_ref = f"refs/aria/tmp/state-fetch-{os.getpid()}-{uuid.uuid4().hex}"
    try:
        try:
            proc = _run_git(
                root,
                (
                    "fetch",
                    "--no-tags",
                    "--refmap=",
                    remote,
                    f"{remote_ref}:{fetched_ref}",
                ),
            )
        except StateStoreError as exc:
            raise StateStoreError(f"{error_prefix}: fetch unavailable ({exc})") from exc
        if proc.returncode != 0:
            raise StateStoreError(
                f"{error_prefix}: fetch rejected "
                f"({proc.stderr.strip()[:300]})"
            )
        tip = _read_commit_ref(root, fetched_ref)
        if tip is None:
            raise StateStoreError(
                f"{error_prefix}: fetched branch tip is not an exact commit"
            )
        return tip
    finally:
        try:
            cleanup = _run_git(root, ("update-ref", "-d", fetched_ref))
        except StateStoreError as exc:
            raise StateStoreError(
                f"{error_prefix}: temporary fetch ref cleanup failed"
            ) from exc
        if cleanup.returncode != 0:
            raise StateStoreError(
                f"{error_prefix}: temporary fetch ref cleanup failed"
            )


def _advance_checkout_tracking_ref(
    root: Path,
    *,
    tracking_ref: str,
    target: str,
) -> None:
    """Move checkout's publication anchor by non-rewinding CAS only."""
    for _attempt in range(2):
        current = _read_commit_ref(root, tracking_ref)
        if current == target:
            return
        if current is not None:
            try:
                target_behind = _strict_is_ancestor(root, target, current)
                current_behind = _strict_is_ancestor(root, current, target)
            except StateStoreError as exc:
                raise StateStoreError(
                    "state_store_remote_history_unavailable: checkout ancestry "
                    "could not be verified"
                ) from exc
            if target_behind:
                raise StateStoreError(
                    "state_store_remote_history_rewind: the validated remote tip "
                    "is behind local tracking; refusing to rewrite the anchor"
                )
            if not current_behind:
                raise StateStoreError(
                    "state_store_remote_history_unrelated: the validated remote tip "
                    "does not descend from local tracking"
                )
        proc = _run_git(
            root,
            (
                "update-ref",
                tracking_ref,
                target,
                current or ("0" * 40),
            ),
        )
        if proc.returncode == 0:
            return
    raise StateStoreError(
        "state_store_tracking_cas_failed: the publication anchor moved during checkout"
    )


def _advance_tracking_ref_cas(store: StateStore, target: str) -> None:
    """Advance the publication anchor with compare-and-swap, never rewind it."""
    tracking = f"refs/remotes/{store.remote}/{store.branch}"
    for _attempt in range(2):
        current = _read_commit_ref(store.root, tracking)
        if current == target:
            return
        if current is not None:
            if _strict_is_ancestor(store.root, target, current):
                raise StatePublishOutcomeUnknown(
                    "state_publish_outcome_unknown: tracking ref is ahead of the "
                    "observed remote tip; refusing a silent remote rewind"
                )
            if not _strict_is_ancestor(store.root, current, target):
                raise StatePublishOutcomeUnknown(
                    "state_publish_outcome_unknown: tracking ref has unrelated history"
                )
        proc = _run_git(
            store.root,
            (
                "update-ref",
                tracking,
                target,
                current or ("0" * 40),
            ),
        )
        if proc.returncode == 0:
            return
    raise StatePublishOutcomeUnknown(
        "state_publish_outcome_unknown: tracking ref compare-and-swap failed"
    )


def _move_owned_head_cas(
    store: StateStore,
    *,
    expected_head: str,
    target_head: str,
) -> None:
    proc = _run_git(
        store.root,
        ("update-ref", "HEAD", target_head, expected_head),
    )
    if proc.returncode != 0 or _read_commit_ref(store.root, "HEAD") != target_head:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: owned HEAD compare-and-swap could not "
            "be verified"
        )


def _soft_reset_owned_commit(
    store: StateStore,
    *,
    committed_head: str,
    base_head: str,
) -> None:
    # Updating detached HEAD while leaving the index and worktree intact is
    # exactly a soft reset, but ``update-ref`` supplies the missing old-value
    # compare-and-swap. A racing writer therefore wins cleanly instead of
    # being overwritten between an ownership check and ``git reset``.
    _move_owned_head_cas(
        store,
        expected_head=committed_head,
        target_head=base_head,
    )


def _store_refresh_is_clean(store: StateStore) -> bool:
    from .workspace import canonical_identity

    try:
        return not _state_store_uncommitted_paths(
            store.root,
            expected_repo_identity=canonical_identity(store.repo_root),
            expected_repo_root=store.repo_root,
        )
    except StateStoreError as exc:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: store cleanliness could not be verified"
        ) from exc


def _refresh_clean_owned_store(
    store: StateStore,
    *,
    expected_head: str,
    target_head: str,
) -> None:
    """Fast-forward a clean detached store from one exact owned HEAD."""
    if _read_commit_ref(store.root, "HEAD") != expected_head:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: store HEAD moved before refresh"
        )
    if not _strict_is_ancestor(store.root, expected_head, target_head):
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: store refresh target is not a fast-forward"
        )
    if not _store_refresh_is_clean(store):
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: store became dirty before refresh"
        )
    refresh = _run_git(
        store.root,
        ("merge", "--ff-only", "--no-edit", target_head),
    )
    if refresh.returncode == 0:
        try:
            from .tool_registry import update_tools_index

            update_tools_index(tools_root(store))
        except (OSError, StateStoreError) as exc:
            raise StatePublishOutcomeUnknown(
                "state_publish_outcome_unknown: refreshed store index could not "
                "be rebuilt"
            ) from exc
    if (
        refresh.returncode != 0
        or _read_commit_ref(store.root, "HEAD") != target_head
        or not _store_refresh_is_clean(store)
    ):
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: clean store fast-forward could not be "
            "verified"
        )


def _adopt_remote_tip_containing_loser(
    store: StateStore,
    *,
    base_head: str,
    loser_head: str,
    remote_tip: str,
) -> None:
    """Turn the soft-rolled-back loser into a clean accepted commit, then FF."""
    if _read_commit_ref(store.root, "HEAD") != base_head:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: replay base HEAD moved before acceptance"
        )
    index_tree = _git(store.root, "write-tree").strip()
    loser_tree = _git(
        store.root,
        "rev-parse",
        "--verify",
        f"{loser_head}^{{tree}}",
    ).strip()
    unstaged = _run_git(
        store.root,
        ("diff", "--quiet", "--no-ext-diff"),
    )
    if index_tree != loser_tree or unstaged.returncode != 0:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: rolled-back loser bytes changed before "
            "remote acceptance could be adopted"
        )
    _move_owned_head_cas(
        store,
        expected_head=base_head,
        target_head=loser_head,
    )
    _refresh_clean_owned_store(
        store,
        expected_head=loser_head,
        target_head=remote_tip,
    )


def _reconcile_nonzero_push(
    store: StateStore,
    *,
    committed_head: str,
    base_head: str,
    detail: str,
) -> str:
    """Classify an ambiguous non-zero push without duplicating committed rows."""
    if _read_commit_ref(store.root, "HEAD") != committed_head:
        raise StateStoreRefusal(
            "state_publish_head_moved_during_push: HEAD no longer names the "
            "exact verified commit; refusing without reset or replay"
        )
    probe = _probe_remote_tip(store)
    if probe.status == "unavailable":
        raise StatePublishOutcomeUnknown(
            "state_publish_transport_failed: state_publish_outcome_unknown: "
            f"remote tip unavailable; preserving commit at HEAD ({probe.detail or detail})"
        )
    if probe.status != "present" or probe.sha is None:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: remote branch tip is "
            f"{probe.status}; preserving commit at HEAD ({probe.detail or detail})"
        )
    fetched_tip = _fetch_remote_branch_tip(store)
    if fetched_tip != probe.sha and not _strict_is_ancestor(
        store.root,
        probe.sha,
        fetched_tip,
    ):
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: remote history changed during reconciliation"
        )
    if fetched_tip == committed_head:
        return committed_head
    if _strict_is_ancestor(store.root, committed_head, fetched_tip):
        _refresh_clean_owned_store(
            store,
            expected_head=committed_head,
            target_head=fetched_tip,
        )
        return fetched_tip
    if fetched_tip == base_head:
        raise StateStoreError(
            "state_publish_write_denied: the verified remote tip did not move "
            f"and excludes the local commit; preserving commit at HEAD. {detail}"
        )
    if not base_head or not _strict_is_ancestor(store.root, base_head, fetched_tip):
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: remote tip is a rewind or unrelated "
            "history; preserving commit at HEAD"
        )

    _soft_reset_owned_commit(
        store,
        committed_head=committed_head,
        base_head=base_head,
    )
    _advance_tracking_ref_cas(store, fetched_tip)
    raise StatePublishContention(
        fetched_tip,
        committed_head,
        base_head,
        detail,
    )


def build_publishable_snapshot(
    store: StateStore,
    *,
    snapshot_id: str,
    cycle_id: str,
    lane: str,
    repo_hash: str,
    parent_commit: str | None = None,
) -> dict[str, Any]:
    """Build a snapshot already chained to whatever the store publishes.

    Callers do not pass ``previous`` themselves. Reading the tip and
    linking to it is the step that makes the ancestry proof hold, so a
    caller that could supply its own predecessor could supply a
    convenient one — and ``publish_state`` would then be checking a
    number the caller chose against a number the caller chose.
    """
    previous = read_published_snapshot(store)
    # ARIA-HIGH-017 — rows already published at the tip are inherited
    # history: the per-line cap binds only rows appended after it. An
    # append-only hash chain cannot be retroactively shrunk, so a cap
    # that rejects inherited lines turns the repository's own published
    # ledger into a permanent publication outage.
    grandfather: dict[str, int] = {}
    if isinstance(previous, dict):
        for key, entry in (previous.get("surfaces") or {}).items():
            if isinstance(entry, dict) and isinstance(entry.get("row_count"), int):
                grandfather[key] = entry["row_count"]
    return build_snapshot(
        snapshot_id=snapshot_id,
        cycle_id=cycle_id,
        lane=lane,
        roots=store_roots(store, repo_hash),
        parent_commit=parent_commit,
        previous=previous,
        grandfather_row_counts=grandfather,
    )


def publish_with_contention_replay(
    store: StateStore,
    *,
    snapshot_id: str,
    cycle_id: str,
    lane: str,
    repo_hash: str,
    max_attempts: int = 3,
) -> dict[str, Any]:
    """Publish, and on a lost race rebuild onto the winner and try again.

    WHY THIS IS A LAYER ABOVE `publish_state` RATHER THAN INSIDE IT.
    `publish_state` has exactly one job — prove this snapshot descends from the
    published tip, then commit and push or refuse. Retrying requires a NEW
    snapshot (the surfaces changed, and the predecessor is now the winner's),
    so folding the loop inward would make the ancestry proof and the thing it
    checks share a function. The proof stays non-omittable regardless: this
    orchestrator has no path to the branch that does not go through
    `publish_state`.

    THE ORDER IS THE SAFETY PROPERTY. The loser's rows are copied out BEFORE
    the worktree is reset to the winner's tree, so there is no moment where
    they exist only in memory. `git reset --hard` then makes the tree exactly
    the winner's — not "mostly the winner's" — and the replay adds this lane's
    suffix back on top through the normal appender, which re-chains every row
    and refreshes the adjacent index.

    ONLY LEDGER SURFACES ARE REPLAYED. A rewrite-class surface has no suffix to
    speak of: its content is a whole-file projection, so the winner's version
    wins and the fact is recorded rather than silently applied. Index surfaces
    are derived and are rebuilt by the appender anyway.
    """
    if max_attempts < 1:
        raise ValueError(f"publish_max_attempts_must_be_positive: {max_attempts}")

    last_refusal: StateStoreRefusal | None = None
    for attempt in range(1, max_attempts + 1):
        base_head = _read_commit_ref(store.root, "HEAD")
        if base_head is None:
            raise StatePublishOutcomeUnknown(
                "state_publish_outcome_unknown: replay base HEAD is unavailable"
            )
        base = read_snapshot_at_worktree_head(store, expected_head=base_head)
        snapshot = build_publishable_snapshot(
            store,
            # Distinct per attempt: two attempts are two different trees, and
            # reusing one id would make the ledger claim they were the same.
            snapshot_id=snapshot_id if attempt == 1 else f"{snapshot_id}-r{attempt}",
            cycle_id=cycle_id,
            lane=lane,
            repo_hash=repo_hash,
        )
        try:
            result = publish_state(
                store,
                snapshot=snapshot,
                cycle_id=cycle_id,
                repo_hash=repo_hash,
                expected_base_head=base_head,
            )
        except StatePublishContention as refusal:
            last_refusal = refusal
            rebase_store_onto_remote(
                store,
                base=base,
                local=snapshot,
                repo_hash=repo_hash,
                expected_winner=refusal.winner_commit,
                expected_loser=refusal.loser_commit,
                expected_base=refusal.base_commit,
            )
            resolved_head = _read_commit_ref(store.root, "HEAD")
            if resolved_head is None:
                raise StatePublishOutcomeUnknown(
                    "state_publish_outcome_unknown: replay resolution HEAD is "
                    "unavailable"
                )
            if _strict_is_ancestor(
                store.root,
                refusal.loser_commit,
                resolved_head,
            ):
                return {
                    "published": True,
                    "pushed": True,
                    "snapshot_id": snapshot.get("snapshot_id"),
                    "manifest_root": snapshot.get("manifest_root"),
                    "continuity": snapshot_continuity(snapshot, base),
                    "push_outcome": "reconciled",
                    "remote_tip": resolved_head,
                    "attempts": attempt,
                }
            if attempt == max_attempts:
                break
            continue
        return {**result, "attempts": attempt}

    raise StateStoreRefusal(
        f"state_publish_contention_unresolved: {max_attempts} attempts all lost the "
        f"race; the rows are intact in the store. ({last_refusal})"
    )


def _remove_replay_staging(staging: Path) -> None:
    try:
        shutil.rmtree(staging)
    except OSError as exc:
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: replay staging cleanup failed"
        ) from exc
    if staging.exists():
        raise StatePublishOutcomeUnknown(
            "state_publish_outcome_unknown: replay staging cleanup could not be "
            "verified"
        )


@dataclass(frozen=True)
class _PreservedReplaySurface:
    staged: Path
    root: Path
    relative: str
    expected_size: int
    expected_sha256: str

    @property
    def destination(self) -> Path:
        return self.root / self.relative


def _replay_source_error(exc: SnapshotError) -> StateStoreRefusal:
    detail = str(exc)
    if "not_regular" in detail or "ancestry_not_directory" in detail:
        reason = "replay_source_not_regular"
    elif "too_large" in detail:
        reason = "replay_source_too_large"
    elif "changed" in detail:
        reason = "replay_source_changed"
    else:
        reason = "replay_source_unavailable"
    return StateStoreRefusal(f"{reason}: secure source copy refused ({detail})")


def _write_all(descriptor: int, chunk: bytes) -> None:
    view = memoryview(chunk)
    while view:
        written = os.write(descriptor, view)
        if written <= 0:
            raise OSError("replay_staging_short_write")
        view = view[written:]


def _stage_replay_surface(
    *,
    root: Path,
    relative: str,
    entry: dict[str, Any],
    staging: Path,
    staging_fd: int,
    staged_name: str,
) -> _PreservedReplaySurface:
    try:
        relative = normalize_surface_relative_path(relative)
    except ValueError as exc:
        raise StateStoreRefusal(
            "replay_source_path_invalid: declared recovery path is not canonical"
        ) from exc
    expected_size = entry.get("size_bytes")
    expected_sha256 = entry.get("sha256")
    if (
        not isinstance(expected_size, int)
        or isinstance(expected_size, bool)
        or expected_size < 0
        or not isinstance(expected_sha256, str)
        or len(expected_sha256) != 64
        or any(char not in "0123456789abcdef" for char in expected_sha256)
    ):
        raise StateStoreRefusal(
            "replay_source_declaration_invalid: recovery requires exact size and hash"
        )
    if expected_size > _MAX_REFERENCED_SURFACE_BYTES:
        raise StateStoreRefusal(
            "replay_source_too_large: declared recovery surface exceeds the bound"
        )

    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise StateStoreError(
            "replay_staging_nofollow_unavailable: secure staging is unsupported"
        )
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow
    flags |= int(getattr(os, "O_CLOEXEC", 0))
    descriptor: int | None = None
    staged = staging / staged_name
    try:
        with _bounded_regular_file_chunks(
            root,
            relative,
            max_bytes=_MAX_REFERENCED_SURFACE_BYTES,
        ) as (source_size, chunks):
            if source_size > _MAX_REFERENCED_SURFACE_BYTES:
                raise StateStoreRefusal(
                    "replay_source_too_large: recovery source exceeds the bound"
                )
            if source_size != expected_size:
                raise StateStoreRefusal(
                    "replay_source_size_mismatch: recovery source no longer matches "
                    "the local snapshot"
                )
            descriptor = os.open(staged_name, flags, 0o600, dir_fd=staging_fd)
            os.fchmod(descriptor, 0o600)
            digest = hashlib.sha256()
            observed = 0
            for chunk in chunks:
                observed += len(chunk)
                if observed > expected_size or observed > _MAX_REFERENCED_SURFACE_BYTES:
                    raise StateStoreRefusal(
                        "replay_source_changed: recovery source grew during copy"
                    )
                _write_all(descriptor, chunk)
                digest.update(chunk)
            if observed != expected_size:
                raise StateStoreRefusal(
                    "replay_source_size_mismatch: recovery copy is incomplete"
                )
            if digest.hexdigest() != expected_sha256:
                raise StateStoreRefusal(
                    "replay_source_hash_mismatch: recovery source no longer matches "
                    "the local snapshot"
                )
            os.fsync(descriptor)
            staged_stat = os.fstat(descriptor)
            if not stat.S_ISREG(staged_stat.st_mode) or staged_stat.st_size != expected_size:
                raise StateStoreError(
                    "replay_staging_verification_failed: staged recovery bytes are "
                    "not one exact regular file"
                )
    except SnapshotError as exc:
        raise _replay_source_error(exc) from exc
    except OSError as exc:
        raise StateStoreError(
            "replay_staging_write_failed: secure recovery staging failed"
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return _PreservedReplaySurface(
        staged=staged,
        root=root,
        relative=relative,
        expected_size=expected_size,
        expected_sha256=expected_sha256,
    )


def _replay_file_identity(value: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_size,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _replay_directory_flags() -> int:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    directory = getattr(os, "O_DIRECTORY", None)
    if nofollow is None or directory is None:
        raise StateStoreError(
            "replay_restore_nofollow_unavailable: secure restore is unsupported"
        )
    return os.O_RDONLY | nofollow | directory | int(getattr(os, "O_CLOEXEC", 0))


@contextmanager
def _open_replay_destination_parent(
    surface: _PreservedReplaySurface,
):
    parts = tuple(surface.relative.split("/"))
    descriptors: list[int] = []
    root_before: os.stat_result | None = None
    try:
        root_before = os.stat(surface.root, follow_symlinks=False)
        root_fd = os.open(surface.root, _replay_directory_flags())
        descriptors.append(root_fd)
        root_opened = os.fstat(root_fd)
        if (
            not stat.S_ISDIR(root_before.st_mode)
            or not stat.S_ISDIR(root_opened.st_mode)
            or (root_before.st_dev, root_before.st_ino, root_before.st_mode)
            != (root_opened.st_dev, root_opened.st_ino, root_opened.st_mode)
        ):
            raise StateStoreError("replay_restore_root_changed")
        parent_fd = root_fd
        for component in parts[:-1]:
            try:
                before = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                os.mkdir(component, 0o700, dir_fd=parent_fd)
                os.fsync(parent_fd)
                before = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode):
                raise StateStoreError("replay_restore_ancestry_not_directory")
            child_fd = os.open(component, _replay_directory_flags(), dir_fd=parent_fd)
            descriptors.append(child_fd)
            opened = os.fstat(child_fd)
            if (
                not stat.S_ISDIR(opened.st_mode)
                or (before.st_dev, before.st_ino, before.st_mode)
                != (opened.st_dev, opened.st_ino, opened.st_mode)
            ):
                raise StateStoreError("replay_restore_ancestry_changed")
            parent_fd = child_fd
        yield parent_fd, parts[-1]
        root_after = os.stat(surface.root, follow_symlinks=False)
        if root_before is None or (
            root_after.st_dev,
            root_after.st_ino,
            root_after.st_mode,
        ) != (
            root_before.st_dev,
            root_before.st_ino,
            root_before.st_mode,
        ):
            raise StateStoreError("replay_restore_root_changed")
    except OSError as exc:
        raise StateStoreError("replay_restore_destination_unavailable") from exc
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def _verify_replay_file(
    root: Path,
    relative: str,
    *,
    expected_size: int,
    expected_sha256: str,
) -> None:
    try:
        with _bounded_regular_file_chunks(
            root,
            relative,
            max_bytes=_MAX_REFERENCED_SURFACE_BYTES,
        ) as (size, chunks):
            digest = hashlib.sha256()
            observed = 0
            for chunk in chunks:
                observed += len(chunk)
                digest.update(chunk)
    except SnapshotError as exc:
        raise StateStoreError("replay_recovery_verification_failed") from exc
    if (
        size != expected_size
        or observed != expected_size
        or digest.hexdigest() != expected_sha256
    ):
        raise StateStoreError("replay_recovery_verification_failed")


def _atomic_restore_replay_surface(surface: _PreservedReplaySurface) -> None:
    nofollow = getattr(os, "O_NOFOLLOW", None)
    if nofollow is None:
        raise StateStoreError("replay_restore_nofollow_unavailable")
    temp_name = f".aria-replay-restore-{os.getpid()}-{uuid.uuid4().hex}.tmp"
    temp_created = False
    with _open_replay_destination_parent(surface) as (parent_fd, leaf):
        try:
            try:
                before = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                before = None
            if before is not None and not stat.S_ISREG(before.st_mode):
                raise StateStoreError("replay_restore_destination_not_regular")
            expected_destination = (
                None if before is None else _replay_file_identity(before)
            )
            flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow
            flags |= int(getattr(os, "O_CLOEXEC", 0))
            descriptor: int | None = None
            try:
                descriptor = os.open(temp_name, flags, 0o600, dir_fd=parent_fd)
                temp_created = True
                os.fchmod(descriptor, 0o600)
                with _bounded_regular_file_chunks(
                    surface.staged.parent,
                    surface.staged.name,
                    max_bytes=_MAX_REFERENCED_SURFACE_BYTES,
                ) as (source_size, chunks):
                    if source_size != surface.expected_size:
                        raise StateStoreError("replay_staging_verification_failed")
                    digest = hashlib.sha256()
                    observed = 0
                    for chunk in chunks:
                        observed += len(chunk)
                        if observed > surface.expected_size:
                            raise StateStoreError("replay_staging_verification_failed")
                        _write_all(descriptor, chunk)
                        digest.update(chunk)
                    if (
                        observed != surface.expected_size
                        or digest.hexdigest() != surface.expected_sha256
                    ):
                        raise StateStoreError("replay_staging_verification_failed")
                os.fsync(descriptor)
                restored = os.fstat(descriptor)
                if (
                    not stat.S_ISREG(restored.st_mode)
                    or restored.st_size != surface.expected_size
                ):
                    raise StateStoreError("replay_restore_temp_verification_failed")
            except SnapshotError as exc:
                raise StateStoreError("replay_staging_verification_failed") from exc
            except OSError as exc:
                raise StateStoreError("replay_restore_write_failed") from exc
            finally:
                if descriptor is not None:
                    os.close(descriptor)

            try:
                current = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
            except FileNotFoundError:
                current = None
            if current is not None and not stat.S_ISREG(current.st_mode):
                raise StateStoreError("replay_restore_destination_not_regular")
            current_identity = (
                None if current is None else _replay_file_identity(current)
            )
            if current_identity != expected_destination:
                raise StateStoreError("replay_restore_destination_changed")
            try:
                os.replace(
                    temp_name,
                    leaf,
                    src_dir_fd=parent_fd,
                    dst_dir_fd=parent_fd,
                )
                temp_created = False
                os.fsync(parent_fd)
            except OSError as exc:
                raise StateStoreError("replay_restore_replace_failed") from exc
            _verify_replay_file(
                surface.root,
                surface.relative,
                expected_size=surface.expected_size,
                expected_sha256=surface.expected_sha256,
            )
        finally:
            if temp_created:
                try:
                    os.unlink(temp_name, dir_fd=parent_fd)
                except FileNotFoundError:
                    pass


def _restore_preserved_replay_surfaces(
    preserved: dict[str, _PreservedReplaySurface],
) -> None:
    for surface in preserved.values():
        _atomic_restore_replay_surface(surface)


def _verify_replay_index_groups(
    store: StateStore,
    preserved: dict[str, _PreservedReplaySurface],
) -> None:
    from .ledger import (
        _lock_requirements_for_path,
        tools_index_group_ledgers,
        verify_index_hashes,
    )

    tools = tools_root(store)
    tools_index = tools / "integrity_index.json"
    verify_index_hashes(tools_index, tools_index_group_ledgers(tools))
    checked: set[Path] = {tools_index}
    for surface in preserved.values():
        requirements = _lock_requirements_for_path(surface.destination)
        index_path = requirements.index_group_lock_path
        if index_path is None or requirements.ledgers is None or index_path in checked:
            continue
        verify_index_hashes(index_path, requirements.ledgers)
        checked.add(index_path)


def _rebuild_recovery_derivatives(store: StateStore) -> None:
    from .tool_registry import update_tools_index

    try:
        update_tools_index(tools_root(store))
    except Exception as exc:
        raise StateStoreError("replay_restore_derivative_rebuild_failed") from exc


def _build_replay_verification_snapshot(
    store: StateStore,
    *,
    repo_hash: str,
) -> dict[str, Any]:
    return build_snapshot(
        snapshot_id="replay-verification",
        cycle_id="replay-verification",
        lane="state-store",
        roots=store_roots(store, repo_hash),
        previous=None,
    )


def _verify_restored_replay_surfaces(
    store: StateStore,
    *,
    preserved: dict[str, _PreservedReplaySurface],
    repo_hash: str,
) -> None:
    try:
        observed = _build_replay_verification_snapshot(store, repo_hash=repo_hash)
        observed_surfaces = observed.get("surfaces") or {}
        for name, surface in preserved.items():
            entry = observed_surfaces.get(name) or {}
            if (
                entry.get("size_bytes") != surface.expected_size
                or entry.get("sha256") != surface.expected_sha256
            ):
                raise StateStoreError("replay_restore_surface_mismatch")
        _verify_replay_index_groups(store, preserved)
    except Exception as exc:
        raise StateStoreError("replay_restore_verification_failed") from exc


def _replay_payload_summary(
    root: Path,
    relative: str,
    *,
    start_row: int,
) -> tuple[int, str, str | None]:
    from .ledger import verify_jsonl_chunks

    digest = hashlib.sha256()
    selected = 0
    row_index = 0
    boundary_hash: str | None = None

    def on_row(row: dict[str, Any]) -> None:
        nonlocal row_index, selected, boundary_hash
        if row_index == start_row - 1:
            candidate = row.get("ledger_hash")
            boundary_hash = candidate if isinstance(candidate, str) else None
        if row_index >= start_row:
            payload = {
                key: value
                for key, value in row.items()
                if key not in {"ledger_hash", "previous_ledger_hash"}
            }
            digest.update(canonical_json(payload).encode("utf-8") + b"\n")
            selected += 1
        row_index += 1

    with _bounded_regular_file_chunks(
        root,
        relative,
        max_bytes=_MAX_REFERENCED_SURFACE_BYTES,
    ) as (size, chunks):
        verify_jsonl_chunks(
            chunks,
            source=root / relative,
            expected_size=size,
            max_line_bytes=SNAPSHOT_MAX_LEDGER_LINE_BYTES,
            max_rows=SNAPSHOT_MAX_LEDGER_ROWS,
            on_row=on_row,
        )
    if start_row > row_index:
        raise StateStoreError("replay_verification_base_row_count_invalid")
    return selected, digest.hexdigest(), boundary_hash


def _verify_completed_replay(
    store: StateStore,
    *,
    carried: dict[str, dict[str, Any]],
    preserved: dict[str, _PreservedReplaySurface],
    local_surfaces: dict[str, Any],
    winner_snapshot: dict[str, Any] | None,
    replayed: dict[str, int],
    repo_hash: str,
) -> None:
    try:
        if any(
            name not in carried
            or not isinstance(count, int)
            or isinstance(count, bool)
            or count <= 0
            for name, count in replayed.items()
        ):
            raise StateStoreError("replay_verification_count_invalid")
        observed = _build_replay_verification_snapshot(store, repo_hash=repo_hash)
        observed_surfaces = observed.get("surfaces") or {}
        winner_surfaces = (winner_snapshot or {}).get("surfaces") or {}
        for name, spec in carried.items():
            local_entry = local_surfaces.get(name) or {}
            winner_entry = winner_surfaces.get(name) or {}
            observed_entry = observed_surfaces.get(name) or {}
            base_count = int(spec["base_row_count"])
            local_count = int(local_entry.get("row_count") or 0)
            winner_count = int(winner_entry.get("row_count") or 0)
            replay_count = replayed.get(name, 0)
            local_suffix_count = local_count - base_count
            if local_suffix_count < 0 or replay_count not in {0, local_suffix_count}:
                raise StateStoreError("replay_verification_count_mismatch")
            if int(observed_entry.get("row_count") or 0) != winner_count + replay_count:
                raise StateStoreError("replay_verification_count_mismatch")
            if replay_count == 0:
                if observed_entry.get("sha256") != winner_entry.get("sha256"):
                    raise StateStoreError("replay_verification_hash_mismatch")
                if local_suffix_count:
                    if winner_count < local_suffix_count:
                        raise StateStoreError("replay_verification_content_mismatch")
                    preserved_surface = preserved[name]
                    expected_count, expected_payload_hash, _expected_boundary = (
                        _replay_payload_summary(
                            preserved_surface.staged.parent,
                            preserved_surface.staged.name,
                            start_row=base_count,
                        )
                    )
                    winner_tail_count, winner_tail_hash, _winner_boundary = (
                        _replay_payload_summary(
                            preserved_surface.root,
                            preserved_surface.relative,
                            start_row=winner_count - local_suffix_count,
                        )
                    )
                    if (
                        expected_count != local_suffix_count
                        or winner_tail_count != local_suffix_count
                        or winner_tail_hash != expected_payload_hash
                    ):
                        raise StateStoreError("replay_verification_content_mismatch")
                continue
            preserved_surface = preserved[name]
            expected_count, expected_payload_hash, _expected_boundary = _replay_payload_summary(
                preserved_surface.staged.parent,
                preserved_surface.staged.name,
                start_row=base_count,
            )
            actual_count, actual_payload_hash, actual_boundary = _replay_payload_summary(
                preserved_surface.root,
                preserved_surface.relative,
                start_row=winner_count,
            )
            if (
                expected_count != replay_count
                or actual_count != replay_count
                or actual_payload_hash != expected_payload_hash
                or actual_boundary != winner_entry.get("tail_ledger_hash")
            ):
                raise StateStoreError("replay_verification_content_mismatch")
        _verify_replay_index_groups(store, preserved)
    except Exception as exc:
        raise StatePublishOutcomeUnknown("replay_verification_failed") from exc


def rebase_store_onto_remote(
    store: StateStore,
    *,
    base: dict[str, Any] | None,
    local: dict[str, Any],
    repo_hash: str,
    expected_winner: str | None = None,
    expected_loser: str | None = None,
    expected_base: str | None = None,
) -> dict[str, int]:
    """Make the worktree the remote's tree plus this lane's append-only suffix.

    PUBLIC because it has two callers with two different reasons to need the
    same operation, and one copy is the point. `publish_with_contention_replay`
    calls it after LOSING a race — the remote moved, adopt it and re-apply my
    rows. `memory_gap.restore_and_replay` calls it after DIAGNOSING a
    continuity gap — this tree is not the published one, adopt the published
    one and re-apply my rows. Same three guarantees either way: the rows leave
    disk before the reset, the reset is exact rather than approximate, and the
    replay goes back through the normal appender so every row re-chains.
    """
    from .contention_replay import replay_append_only_suffixes

    roots = store_roots(store, repo_hash)
    try:
        validate_snapshot_manifest(local, expected_root_kinds=roots)
        if base is not None:
            validate_snapshot_manifest(base, expected_root_kinds=roots)
    except SnapshotError as exc:
        raise StateStoreRefusal(
            "replay_snapshot_invalid: recovery requires canonical base/local claims"
        ) from exc
    base_surfaces = (base or {}).get("surfaces") or {}
    local_surfaces = local.get("surfaces") or {}

    # Copy the loser's ledgers and their derived indexes out first. Doing this
    # before the reset is what keeps the rows on disk continuously rather than
    # in memory across a destructive git operation. Indexes are not replayed,
    # but retaining their local bytes lets a failed replay restore a coherent
    # recoverable tree before the only transient copy is removed.
    staging = Path(tempfile.mkdtemp(prefix="aria-replay-"))
    carried: dict[str, dict[str, Any]] = {}
    preserved: dict[str, _PreservedReplaySurface] = {}
    reset_started = False
    verification_failed = False
    try:
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            raise StateStoreError(
                "replay_staging_nofollow_unavailable: secure staging is unsupported"
            )
        staging_flags = os.O_RDONLY | os.O_DIRECTORY | nofollow
        staging_flags |= int(getattr(os, "O_CLOEXEC", 0))
        staging_fd = os.open(staging, staging_flags)
        try:
            if not stat.S_ISDIR(os.fstat(staging_fd).st_mode):
                raise StateStoreError("replay_staging_not_directory")
            for index, (name, entry) in enumerate(sorted(local_surfaces.items())):
                if entry.get("state_class") not in {"ledger", "index"}:
                    continue
                root = roots.get(entry.get("root_kind"))
                relative = entry.get("path")
                if root is None or not isinstance(relative, str):
                    raise StateStoreRefusal(
                        "replay_source_declaration_invalid: recovery root/path is invalid"
                    )
                # The staged NAME is an ordinal, never the surface key: glob keys
                # are `name:relative/path` (ORPHAN-HIGH-555), and a key used as a
                # filename is a path traversal into a directory that does not exist.
                preserved_surface = _stage_replay_surface(
                    root=root,
                    relative=relative,
                    entry=entry,
                    staging=staging,
                    staging_fd=staging_fd,
                    staged_name=f"surface-{index:04d}.bin",
                )
                preserved[name] = preserved_surface
                if entry.get("state_class") != "ledger":
                    continue
                base_entry = base_surfaces.get(name) or {}
                carried[name] = {
                    "loser_path": preserved_surface.staged,
                    "winner_path": preserved_surface.destination,
                    # A surface the base did not carry has no prefix to prove, so
                    # all of it is suffix — the same rule append_only_suffix uses.
                    "base_row_count": int(base_entry.get("row_count") or 0),
                    "base_tail_hash": base_entry.get("tail_ledger_hash"),
                }
            # Every durable source copy must reach storage before the first
            # destructive operation.  The directory barrier makes the staged
            # filenames themselves durable, not only their contents.
            os.fsync(staging_fd)
        finally:
            os.close(staging_fd)

        # This is deliberately a NEW fetch after the contention was first
        # classified. The server may have accepted the loser meanwhile; both
        # the verified winner and the exact loser therefore participate in the
        # decision immediately before any reset or replay.
        tip = _fetch_remote_branch_tip(store)
        winner_snapshot = _read_snapshot_at(store, tip)
        try:
            if winner_snapshot is None:
                raise SnapshotError("replay_target_snapshot_missing")
            validate_snapshot_manifest(winner_snapshot, expected_root_kinds=roots)
            from .autonomy_evidence import _verify_published_snapshot_commit

            _verify_published_snapshot_commit(
                store=store,
                repo_identity=repo_hash,
                state_commit=tip,
                expected_snapshot=winner_snapshot,
            )
        except Exception as exc:
            raise StatePublishOutcomeUnknown(
                "state_publish_outcome_unknown: replay target's immutable snapshot "
                "could not be verified before reset"
            ) from exc
        if expected_winner is not None and not _strict_is_ancestor(
            store.root,
            expected_winner,
            tip,
        ):
            raise StatePublishOutcomeUnknown(
                "state_publish_outcome_unknown: replay target no longer contains "
                "the verified contention winner"
            )
        if expected_loser is not None and _strict_is_ancestor(
            store.root,
            expected_loser,
            tip,
        ):
            if expected_base is None:
                raise StatePublishOutcomeUnknown(
                    "state_publish_outcome_unknown: accepted loser base is unavailable"
                )
            _adopt_remote_tip_containing_loser(
                store,
                base_head=expected_base,
                loser_head=expected_loser,
                remote_tip=tip,
            )
            _advance_tracking_ref_cas(store, tip)
            replayed: dict[str, int] = {}
        else:
            _advance_tracking_ref_cas(store, tip)
            reset_started = True
            reset = _run_git(store.root, ("reset", "--hard", tip))
            if reset.returncode != 0 or _read_commit_ref(store.root, "HEAD") != tip:
                raise StatePublishOutcomeUnknown(
                    "state_publish_outcome_unknown: replay reset could not be verified"
                )
            replayed = replay_append_only_suffixes(surfaces=carried).per_surface
        try:
            _verify_completed_replay(
                store,
                carried=carried,
                preserved=preserved,
                local_surfaces=local_surfaces,
                winner_snapshot=winner_snapshot,
                replayed=replayed,
                repo_hash=repo_hash,
            )
        except Exception:
            verification_failed = True
            raise
    except BaseException as exc:
        if reset_started:
            try:
                _restore_preserved_replay_surfaces(preserved)
                _rebuild_recovery_derivatives(store)
                _verify_restored_replay_surfaces(
                    store,
                    preserved=preserved,
                    repo_hash=repo_hash,
                )
            except BaseException as restore_error:
                raise StatePublishOutcomeUnknown(
                    "state_publish_outcome_unknown: replay failed and the worktree "
                    f"could not be restored; recovery bytes remain at {staging}"
                ) from restore_error
        if verification_failed:
            raise StatePublishOutcomeUnknown(
                "state_publish_outcome_unknown: replay_verification_failed; "
                f"recovery bytes remain at {staging}"
            ) from exc
        try:
            _remove_replay_staging(staging)
        except StateStoreError as cleanup_error:
            raise cleanup_error from exc
        raise

    _remove_replay_staging(staging)
    return replayed


def verify_state_store(store: StateStore, *, repo_hash: str) -> dict[str, Any]:
    """Re-derive the store's state and compare it against what it claims.

    A snapshot is a claim about bytes; this recomputes the claim from
    the bytes now on disk. A mismatch means the tree moved after it was
    attested — which is precisely what the artifact-era ``restored=true``
    gate could not see.
    """
    published = read_published_snapshot(store)
    if published is None:
        return {"valid": True, "status": "genesis", "drifted_surfaces": []}

    observed = build_snapshot(
        snapshot_id=published.get("snapshot_id", "recomputed"),
        cycle_id=published.get("cycle_id", "recomputed"),
        lane=published.get("lane", "recomputed"),
        roots=store_roots(store, repo_hash),
        parent_commit=published.get("parent_commit"),
        previous={
            "snapshot_id": published.get("prev_snapshot_id"),
            "manifest_root": published.get("prev_manifest_root"),
        }
        if published.get("prev_snapshot_id")
        else None,
    )
    claimed_surfaces = published.get("surfaces") or {}
    observed_surfaces = observed.get("surfaces") or {}
    drifted = sorted(
        name
        for name in set(claimed_surfaces) | set(observed_surfaces)
        if (claimed_surfaces.get(name) or {}).get("sha256")
        != (observed_surfaces.get(name) or {}).get("sha256")
    )
    root_matches = observed.get("manifest_root") == published.get("manifest_root")
    return {
        "valid": root_matches and not drifted,
        "status": "ok" if root_matches and not drifted else "drifted",
        "claimed_manifest_root": published.get("manifest_root"),
        "observed_manifest_root": observed.get("manifest_root"),
        "drifted_surfaces": drifted,
    }


def _require_bootstrap_ack(repo_root: Path, branch: str) -> None:
    ack = os.environ.get(BOOTSTRAP_ACK_ENV, "").strip()
    identity = _repository_identity(repo_root)
    if not ack:
        raise StateStoreRefusal(
            f"state_store_bootstrap_unacknowledged: branch {branch!r} does not exist "
            f"and {BOOTSTRAP_ACK_ENV} is unset. Creating it silently is how an "
            "existing history gets replaced by an empty one (ORPHAN-CRITICAL-484); "
            f"set {BOOTSTRAP_ACK_ENV}={identity!r} to authorise a first bootstrap."
        )
    if ack != identity:
        # Naming the repository is what makes the acknowledgement
        # one-shot in practice: an ack left set in a workflow does not
        # travel to a fork or a renamed repo, and it cannot be a bare
        # "1" someone pasted forward without reading.
        raise StateStoreRefusal(
            f"state_store_bootstrap_ack_mismatch: {BOOTSTRAP_ACK_ENV}={ack!r} does not "
            f"name this repository ({identity!r})"
        )


def _repository_identity(repo_root: Path) -> str:
    """``owner/repo`` from the origin URL, falling back to the directory name."""
    url = _git(repo_root, "config", "--get", "remote.origin.url", check=False).strip()
    if not url:
        return repo_root.name
    trimmed = url.removesuffix(".git")
    parts = [segment for segment in trimmed.replace(":", "/").split("/") if segment]
    if len(parts) >= 2:
        return f"{parts[-2]}/{parts[-1]}"
    return trimmed


def _read_json_file(path: Path) -> dict[str, Any]:
    try:
        content, _fingerprint = _read_bounded_regular_file(path)
        text = content.decode("utf-8")
        if not json_nesting_within_limit(text):
            raise ValueError("json_nesting_limit_exceeded")
        value = json.loads(text)
    except (
        OSError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        RecursionError,
        ValueError,
        StateStoreError,
    ):
        return {}
    return value if isinstance(value, dict) else {}


def _json_object_from_bytes(content: bytes) -> dict[str, Any]:
    try:
        text = content.decode("utf-8")
        if not json_nesting_within_limit(text):
            raise ValueError("json_nesting_limit_exceeded")
        value = json.loads(text)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _same_git_common_directory(left: Path, right: Path) -> bool:
    def common(root: Path) -> Path | None:
        try:
            value = _git(
                root,
                "rev-parse",
                "--path-format=absolute",
                "--git-common-dir",
                check=False,
            ).strip()
        except StateStoreError:
            return None
        return Path(value).resolve() if value else None

    left_common = common(left)
    right_common = common(right)
    return left_common is not None and left_common == right_common


def _valid_host_identity(
    tools: Path,
    expected_repo_identity: str | None,
    expected_repo_root: Path | None,
    *,
    identity_payload: bytes | None = None,
    contract_payload: bytes | None = None,
) -> bool:
    identity_path = tools / "repo_identity.json"
    if identity_payload is None:
        try:
            identity_payload = _read_bounded_regular_file(identity_path)[0]
        except StateStoreError:
            return False
    identity = _json_object_from_bytes(identity_payload)
    if contract_payload is None:
        try:
            contract_payload = _read_bounded_regular_file(
                tools / "tools_contract.json",
            )[0]
        except StateStoreError:
            return False
    contract = _json_object_from_bytes(contract_payload)
    return (
        set(identity) == {
            "aria_tools_contract_version",
            "bound_canonical_identity",
            "bound_repo_hash",
            "bound_repo_root",
            "schema_version",
        }
        and identity.get("schema_version") == 3
        and identity.get("aria_tools_contract_version") == 3
        and isinstance(identity.get("bound_canonical_identity"), str)
        and bool(identity["bound_canonical_identity"])
        and (
            expected_repo_identity is None
            or identity["bound_canonical_identity"] == expected_repo_identity
        )
        and identity.get("bound_repo_hash")
        == identity.get("bound_canonical_identity")
        and isinstance(identity.get("bound_repo_root"), str)
        and Path(identity["bound_repo_root"]).is_absolute()
        and (
            expected_repo_root is None
            or _same_git_common_directory(
                Path(identity["bound_repo_root"]),
                expected_repo_root,
            )
        )
        and set(contract) == {
            "aria_tools_contract_version",
            "schema_version",
            "bound_canonical_identity",
        }
        and all(identity.get(key) == value for key, value in contract.items())
        and contract.get("schema_version") == 3
    )


def _reproducible_tools_index(
    tools: Path,
    *,
    index_payload: bytes | None = None,
) -> bool:
    from .ledger import tools_index_group_ledgers

    index_path = tools / "integrity_index.json"
    if index_payload is None:
        try:
            index_payload = _read_bounded_regular_file(index_path)[0]
        except StateStoreError:
            return False
    index = _json_object_from_bytes(index_payload)
    hashes = index.get("ledger_hashes")
    if (
        not {"schema_version", "ledger_hashes"}.issubset(index)
        or not set(index).issubset({
            "schema_version",
            "ledger_hashes",
            "file_hashes",
        })
        or index.get("schema_version") != 2
        or not isinstance(hashes, dict)
    ):
        return False
    try:
        ledgers = tools_index_group_ledgers(tools)
        expected = {
            name: _canonical_referenced_surface_hash(path)
            for name, path in ledgers.items()
        }
    except (OSError, StateStoreError):
        return False
    if hashes != expected:
        return False
    expected_files: dict[str, str] = {}
    try:
        for name, path in {
            "migration_state": tools / "migration_state.json",
            "since_migration_events.jsonl": tools / "since_migration_events.jsonl",
        }.items():
            try:
                os.stat(path, follow_symlinks=False)
            except FileNotFoundError:
                continue
            expected_files[name] = _stable_regular_file_hash(path)
    except (OSError, StateStoreError):
        return False
    if index.get("file_hashes", {}) != expected_files:
        return False
    return True


def _is_disposable_host_artifact(
    root: Path,
    status: str,
    relative: str,
    *,
    lock_stack: ExitStack,
    expected_repo_identity: str | None,
    expected_repo_root: Path | None,
    held_sidecars: dict[str, ExclusiveLockHandle],
) -> tuple[int, int, int, int, str] | None:
    """Classify only exact untracked host derivatives as disposable."""
    if status != "??":
        return None
    tools = root / "tools"
    if relative == "tools/repo_identity.json":
        try:
            payload, fingerprint = _read_bounded_regular_file(root / relative)
        except StateStoreError:
            return None
        return fingerprint if _valid_host_identity(
            tools,
            expected_repo_identity,
            expected_repo_root,
            identity_payload=payload,
        ) else None
    if relative == "tools/integrity_index.json":
        try:
            payload, fingerprint = _read_bounded_regular_file(root / relative)
        except StateStoreError:
            return None
        return fingerprint if _reproducible_tools_index(
            tools,
            index_payload=payload,
        ) else None
    if not relative.startswith("tools/") or not relative.endswith(".lock"):
        return None
    from .state_manifest import surface_for_relative_path

    lock_relative = relative.removeprefix("tools/")
    if surface_for_relative_path(lock_relative) is not None:
        return None
    target_relative = lock_relative.removesuffix(".lock")
    target_surface = surface_for_relative_path(target_relative)
    from .state_manifest import STATE_SURFACES

    group_prefix = "locks/state-groups/"
    group_target = (
        target_relative.startswith(group_prefix)
        and target_relative.endswith(".lock")
        and target_relative.removeprefix(group_prefix).removesuffix(".lock")
        in {
            surface.lock_group
            for surface in STATE_SURFACES
            if surface.root_kind == "tools"
        }
    )
    if (
        (target_surface is None or target_surface.root_kind != "tools")
        and target_relative != "integrity_index.json"
        and not group_target
    ):
        return None
    lock_path = root / relative
    target_path = tools / target_relative
    if (
        not lock_path.is_file()
        or lock_path.is_symlink()
        or target_path.is_symlink()
    ):
        return None
    from .file_lock import lock_sidecar_path, with_exclusive_lock

    if lock_sidecar_path(target_path) != lock_path:
        return None
    if relative in held_sidecars:
        handle = held_sidecars[relative]
        if not handle.matches_path():
            return None
        try:
            fingerprint = _host_derivative_fingerprint(lock_path)
        except StateStoreError:
            return None
        return fingerprint if (
            handle.matches_path()
            and fingerprint[:3]
            == (handle.device, handle.inode, handle.mode)
        ) else None

    try:
        handle = lock_stack.enter_context(
            with_exclusive_lock(
                target_path,
                timeout_seconds=0,
                require_existing=True,
            ),
        )
    except (OSError, TimeoutError):
        return None
    if not handle.matches_path():
        return None
    held_sidecars[relative] = handle
    try:
        fingerprint = _host_derivative_fingerprint(lock_path)
    except StateStoreError:
        return None
    return fingerprint if (
        handle.matches_path()
        and fingerprint[:3] == (handle.device, handle.inode, handle.mode)
    ) else None


def _read_bounded_regular_file(
    path: Path,
) -> tuple[bytes, tuple[int, int, int, int, str]]:
    descriptor: int | None = None
    try:
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            raise OSError("host_derivative_nofollow_unavailable")
        descriptor = os.open(
            path,
            os.O_RDONLY
            | nofollow
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0),
            # O_NONBLOCK prevents a raced FIFO/device replacement from
            # blocking before fstat can reject the non-regular inode.
        )
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_size > _MAX_HOST_DERIVATIVE_BYTES
        ):
            raise OSError("host_derivative_not_bounded_regular_file")
        digest = hashlib.sha256()
        content = bytearray()
        total = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > _MAX_HOST_DERIVATIVE_BYTES:
                raise OSError("host_derivative_too_large_during_read")
            digest.update(chunk)
            content.extend(chunk)
        after = os.fstat(descriptor)
        before_identity = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        after_identity = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if before_identity != after_identity or total != before.st_size:
            raise OSError("host_derivative_changed_during_read")
        fingerprint = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_size,
            digest.hexdigest(),
        )
        return bytes(content), fingerprint
    except OSError as exc:
        raise StateStoreError(
            f"state_store_host_derivative_unavailable: {path.as_posix()}",
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _host_derivative_fingerprint(path: Path) -> tuple[int, int, int, int, str]:
    return _read_bounded_regular_file(path)[1]


def _stable_regular_file_hash(path: Path) -> str:
    """Hash a canonical referenced surface from one stable no-follow fd."""
    descriptor: int | None = None
    try:
        nofollow = getattr(os, "O_NOFOLLOW", None)
        if nofollow is None:
            raise OSError("referenced_surface_nofollow_unavailable")
        descriptor = os.open(
            path,
            os.O_RDONLY
            | nofollow
            | getattr(os, "O_CLOEXEC", 0)
            | getattr(os, "O_NONBLOCK", 0),
        )
        before = os.fstat(descriptor)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_size > _MAX_REFERENCED_SURFACE_BYTES
        ):
            raise OSError("referenced_surface_not_bounded_regular_file")
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > _MAX_REFERENCED_SURFACE_BYTES:
                raise OSError("referenced_surface_too_large_during_read")
            digest.update(chunk)
        after = os.fstat(descriptor)
        before_identity = (
            before.st_dev,
            before.st_ino,
            before.st_mode,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        )
        after_identity = (
            after.st_dev,
            after.st_ino,
            after.st_mode,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if before_identity != after_identity or total != before.st_size:
            raise OSError("referenced_surface_changed_during_read")
        return digest.hexdigest()
    except OSError as exc:
        raise StateStoreError(
            f"state_store_referenced_surface_unavailable: {path.as_posix()}",
        ) from exc
    finally:
        if descriptor is not None:
            os.close(descriptor)


def _canonical_referenced_surface_hash(path: Path) -> str:
    """Match ledger.file_hash: missing is empty; present must be safe/regular."""
    try:
        os.stat(path, follow_symlinks=False)
    except FileNotFoundError:
        return hashlib.sha256(b"").hexdigest()
    return _stable_regular_file_hash(path)


def _state_store_uncommitted_paths(
    root: Path,
    *,
    lock_stack: ExitStack | None = None,
    expected_repo_identity: str | None = None,
    expected_repo_root: Path | None = None,
) -> tuple[str, ...]:
    """Return state that re-checkout/admission cannot safely discard.

    Host binding, derived index, and quiescent undeclared sidecar locks are
    classified at the state-worktree boundary. No shared Git ignore file is
    mutated, and declared lock surfaces remain ordinary state.
    """
    owned_stack = lock_stack is None
    active_stack = lock_stack or ExitStack()
    try:
        def status_entries() -> tuple[tuple[str, str], ...]:
            result = _run_git_bytes_bounded(
                root,
                (
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--ignored=matching",
                ),
                stdout_limit=_MAX_STATUS_OUTPUT_BYTES,
                stderr_limit=_MAX_GIT_STDERR_BYTES,
                budget_error="state_store_status_budget_exceeded",
            )
            if result.returncode != 0:
                raise StateStoreError("state_store_status_unavailable")
            output = result.stdout
            if output and not output.endswith(b"\0"):
                raise StateStoreError("state_store_status_budget_exceeded")
            records = output.removesuffix(b"\0").split(b"\0") if output else []
            if len(records) > _MAX_STATUS_ENTRIES:
                raise StateStoreError("state_store_status_budget_exceeded")
            entries: list[tuple[str, str]] = []
            index = 0
            while index < len(records):
                record = records[index]
                index += 1
                if not record:
                    continue
                if len(record) > _MAX_STATUS_RECORD_BYTES:
                    raise StateStoreError("state_store_status_budget_exceeded")
                try:
                    decoded = record.decode("utf-8")
                except UnicodeDecodeError as exc:
                    raise StateStoreError(
                        "state_store_status_budget_exceeded",
                    ) from exc
                if len(decoded) < 4 or decoded[2] != " ":
                    entries.append(("", decoded))
                    continue
                status = decoded[:2]
                relative = decoded[3:]
                entries.append((status, relative))
                if status[0] in {"R", "C"} or status[1] in {"R", "C"}:
                    if index < len(records) and records[index]:
                        renamed = records[index]
                        if len(renamed) > _MAX_STATUS_RECORD_BYTES:
                            raise StateStoreError(
                                "state_store_status_budget_exceeded",
                            )
                        try:
                            renamed_text = renamed.decode("utf-8")
                        except UnicodeDecodeError as exc:
                            raise StateStoreError(
                                "state_store_status_budget_exceeded",
                            ) from exc
                        entries.append(("", renamed_text))
                        index += 1
            return tuple(entries)

        dirty: set[str] = set()
        allowed: set[str] = set()
        derivative_fingerprints: dict[str, tuple[int, int, int, int, str]] = {}
        held_sidecars: dict[str, ExclusiveLockHandle] = {}
        for status, relative in status_entries():
            fingerprint = _is_disposable_host_artifact(
                root,
                status,
                relative,
                lock_stack=active_stack,
                expected_repo_identity=expected_repo_identity,
                expected_repo_root=expected_repo_root,
                held_sidecars=held_sidecars,
            )
            if fingerprint is not None:
                allowed.add(relative)
                derivative_fingerprints[relative] = fingerprint
            else:
                dirty.add(relative)
        # Locks acquired above are still held. A second complete status scan
        # narrows the appearance race: every path must be identical to the
        # first allowed set; even a newly-created exact sidecar refuses.
        second_seen: set[str] = set()
        for status, relative in status_entries():
            second_seen.add(relative)
            fingerprint = _is_disposable_host_artifact(
                root,
                status,
                relative,
                lock_stack=active_stack,
                expected_repo_identity=expected_repo_identity,
                expected_repo_root=expected_repo_root,
                held_sidecars=held_sidecars,
            )
            if (
                status == "!!"
                or relative not in allowed
                or fingerprint is None
                or fingerprint != derivative_fingerprints.get(relative)
            ):
                dirty.add(relative)
        dirty.update(allowed - second_seen)
        return tuple(sorted(dirty))
    finally:
        if owned_stack:
            active_stack.close()


def _clear_existing_store(repo_root: Path, root: Path, *, remote: str, branch: str) -> None:
    """Make way for a fresh checkout — but never over UNPUBLISHED work.

    ARIA's producer lane runs on a PERSISTENT self-hosted runner, so a
    store directory surviving between calls is ordinary, not anomalous.
    Four cases, and only one is safe to overwrite:

      * a worktree whose HEAD the remote already holds and whose tree is
        clean — every byte is published, so replacing it loses nothing;
      * a worktree holding COMMITS THE REMOTE DOES NOT HAVE. This is the
        one an earlier version got wrong, and it is the module's own
        failure mode turned inward. ``publish_state`` commits before it
        pushes, so a lost compare-and-swap — the DESIGNED outcome for the
        loser of every contended cycle — leaves a commit reachable from
        nothing but this worktree, with a perfectly CLEAN status. Removing
        the worktree then deletes the commit AND its reflog, the next
        snapshot chains cleanly to the rolled-back tip, and
        ``verify_state_store`` answers valid. That is "verifies clean
        while carrying nothing" reached through this module's own
        prescribed recovery. Committed is not published; only the remote
        decides;
      * a worktree with uncommitted paths — the ledger writes a cycle just
        made. Refuses for the same reason;
      * anything else — a directory of unknown provenance. Refuses,
        because publishing from a tree nobody can account for is how an
        unrelated tree gets attested as ARIA's state.
    """
    if not _is_worktree_of(repo_root, root):
        raise StateStoreError(
            f"state_store_worktree_occupied: {root.as_posix()} exists but is not a "
            "worktree of this repository; refusing to publish from a tree of unknown "
            "provenance"
        )

    # Containment first: a clean tree is the case that LOOKS safe, so the
    # question that decides safety has to be asked before cleanliness gets
    # a chance to answer it.
    head = _git(root, "rev-parse", "--verify", "--quiet", "HEAD", check=False).strip()
    tracking = f"refs/remotes/{remote}/{branch}"
    remote_known = _git_succeeds(repo_root, "rev-parse", "--verify", "--quiet", tracking)
    if head and remote_known and not _git_succeeds(
        root, "merge-base", "--is-ancestor", head, tracking
    ):
        unpushed = _git(root, "rev-list", "--count", f"{tracking}..HEAD", check=False).strip() or "?"
        raise StateStoreRefusal(
            f"state_store_unpushed_commits: {root.as_posix()} is {unpushed} commit(s) "
            f"ahead of {remote}/{branch} (HEAD={head[:12]}). Those commits exist "
            "nowhere else — re-checking out would delete them and their reflog with "
            "no error. Push them or discard them deliberately first."
        )

    with ExitStack() as lock_stack:
        from .workspace import canonical_identity

        dirty = _state_store_uncommitted_paths(
            root,
            lock_stack=lock_stack,
            expected_repo_identity=canonical_identity(repo_root),
            expected_repo_root=repo_root,
        )
        if dirty:
            raise StateStoreRefusal(
                f"state_store_uncommitted_writes: {root.as_posix()} holds {len(dirty)} "
                "uncommitted path(s). Re-checking out would discard state that exists "
                "nowhere else; publish or discard them deliberately first."
            )
        # Acquired sidecar locks remain held through removal, narrowing the
        # classification-to-delete race with a cooperating writer.
        _git(repo_root, "worktree", "remove", "--force", str(root), check=False)
    if root.exists():
        raise StateStoreError(
            f"state_store_worktree_removal_failed: {root.as_posix()} could not be removed"
        )
    _git(repo_root, "worktree", "prune", check=False)


def _is_worktree_of(repo_root: Path, root: Path) -> bool:
    """Whether ``root`` is a registered worktree of ``repo_root``."""
    listing = _git(repo_root, "worktree", "list", "--porcelain", check=False)
    target = str(root)
    return any(
        line.startswith("worktree ") and Path(line[len("worktree ") :]).resolve() == Path(target)
        for line in listing.splitlines()
    )


def _parse_snapshot(blob: str, source: str) -> dict[str, Any]:
    try:
        if not json_nesting_within_limit(blob):
            raise ValueError("json_nesting_limit_exceeded")
        snapshot = json.loads(blob)
    except (RecursionError, ValueError) as exc:
        raise StateStoreError(f"state_store_snapshot_unreadable: {source}") from exc
    if not isinstance(snapshot, dict):
        raise StateStoreError(f"state_store_snapshot_malformed: {source}")
    if not verify_manifest_root(snapshot):
        raise StateStoreError(
            "state_store_published_root_mismatch: the published snapshot's recorded "
            f"root does not match its content ({source}); the tip cannot be used as "
            "an ancestry reference"
        )
    return snapshot


def _run_git_bytes_bounded(
    cwd: Path,
    args: tuple[str, ...],
    *,
    stdout_limit: int,
    stderr_limit: int,
    budget_error: str,
) -> subprocess.CompletedProcess[bytes]:
    """Run Git while bounding both output pipes and reaping on every exit."""
    try:
        process = subprocess.Popen(
            ["git", "-C", str(cwd), *args],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={**os.environ, "GIT_OPTIONAL_LOCKS": "0"},
            bufsize=0,
        )
    except OSError as exc:
        raise StateStoreError(
            f"state_store_git_unavailable: git {' '.join(args)}",
        ) from exc
    if process.stdout is None or process.stderr is None:  # pragma: no cover
        process.kill()
        raise StateStoreError(f"state_store_git_unavailable: git {' '.join(args)}")
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ, "stdout")
    selector.register(process.stderr, selectors.EVENT_READ, "stderr")
    output = {"stdout": bytearray(), "stderr": bytearray()}
    limits = {"stdout": stdout_limit, "stderr": stderr_limit}
    deadline = time.monotonic() + GIT_TIMEOUT_SECONDS
    completed = False
    try:
        while selector.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise StateStoreError(
                    f"state_store_git_timeout: git {' '.join(args)}",
                )
            events = selector.select(remaining)
            if not events:
                raise StateStoreError(
                    f"state_store_git_timeout: git {' '.join(args)}",
                )
            for key, _mask in events:
                chunk = os.read(key.fileobj.fileno(), 64 * 1024)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                stream = str(key.data)
                output[stream].extend(chunk)
                if len(output[stream]) > limits[stream]:
                    raise StateStoreError(budget_error)
        try:
            returncode = process.wait(
                timeout=max(0.001, deadline - time.monotonic()),
            )
        except subprocess.TimeoutExpired as exc:
            raise StateStoreError(
                f"state_store_git_timeout: git {' '.join(args)}",
            ) from exc
        completed = True
        return subprocess.CompletedProcess(
            ["git", "-C", str(cwd), *args],
            returncode,
            bytes(output["stdout"]),
            bytes(output["stderr"]),
        )
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()
        if not completed and process.poll() is None:
            process.kill()
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def _run_git(cwd: Path, args: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
    """Every git invocation in this module, bounded and non-interactive.

    ``stdin`` is closed so a credential or overwrite prompt fails fast
    instead of wedging a scheduled run against a terminal that is not
    there, and the timeout bounds the case where the remote accepts the
    connection and then says nothing.
    """
    remote = bool(args and args[0] == "ls-remote")
    raw = _run_git_bytes_bounded(
        cwd,
        args,
        stdout_limit=(
            _MAX_REMOTE_OUTPUT_BYTES if remote else _MAX_GIT_OUTPUT_BYTES
        ),
        stderr_limit=_MAX_GIT_STDERR_BYTES,
        budget_error=(
            "state_remote_output_budget_exceeded"
            if remote
            else "state_store_git_output_budget_exceeded"
        ),
    )
    try:
        return subprocess.CompletedProcess(
            raw.args,
            raw.returncode,
            raw.stdout.decode("utf-8"),
            raw.stderr.decode("utf-8"),
        )
    except UnicodeError as exc:
        raise StateStoreError(
            f"state_store_git_output_encoding: git {' '.join(args)}",
        ) from exc


def _git(cwd: Path, *args: str, check: bool = True) -> str:
    """Run git and return stdout; raise or return '' on a non-zero exit.

    ``check=False`` means "absence is a legitimate answer here" — a
    missing remote URL, a worktree that was already gone. It never means
    "ignore whether this worked": the calls whose success is load-bearing
    (fetch outcome, push acceptance) go through ``_git_succeeds`` so the
    result is a value the caller must handle, not a discarded string.
    """
    proc = _run_git(cwd, args)
    if proc.returncode != 0:
        if check:
            raise StateStoreError(
                f"state_store_git_failed: git {' '.join(args)} -> {proc.stderr.strip()[:300]}"
            )
        return ""
    return proc.stdout


def _git_succeeds(cwd: Path, *args: str) -> bool:
    """Whether git accepted the command — for calls where rejection is data."""
    return _run_git(cwd, args).returncode == 0


def _git_commit(cwd: Path, message: str) -> str:
    """Commit under the store's own identity, never the ambient one."""
    return _git(
        cwd,
        "-c",
        f"user.name={COMMITTER_NAME}",
        "-c",
        f"user.email={COMMITTER_EMAIL}",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--message",
        message,
    )


__all__ = [
    "BOOTSTRAP_ACK_ENV",
    "GENESIS_FILENAME",
    "SNAPSHOT_FILENAME",
    "STATE_BRANCH",
    "STORE_DIRNAME",
    "StateStore",
    "StateStoreError",
    "StateStoreRefusal",
    "StatePublishContention",
    "StatePublishOutcomeUnknown",
    "build_publishable_snapshot",
    "checkout_state_store",
    "findings_root",
    "publish_state",
    "read_published_snapshot",
    "read_snapshot_at_worktree_head",
    "rebase_store_onto_remote",
    "snapshot_path",
    "store_environment",
    "store_roots",
    "tools_root",
    "verify_state_store",
    "workspace_root",
]
