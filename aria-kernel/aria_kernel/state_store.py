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
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import canonical_json
from .state_snapshot import build_snapshot, snapshot_continuity, verify_manifest_root

STATE_BRANCH = "aria/state"
STORE_DIRNAME = ".aria-state-store"
SNAPSHOT_FILENAME = "snapshot.json"
GENESIS_FILENAME = "GENESIS"
BOOTSTRAP_ACK_ENV = "ARIA_STATE_BOOTSTRAP_ACK"

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
    if fetch:
        # '+' on the refspec. Without it git applies the fast-forward rule
        # to the REMOTE-TRACKING ref too, so a state branch that was
        # legitimately replaced (a bootstrap after a deletion, a rewrite by
        # an operator) leaves the local tracking ref pointing at history
        # the server no longer has — and the checkout below would then
        # establish the store on a tip that does not exist upstream.
        _git(repo_root, "fetch", "--force", remote, f"{branch}:{tracking_ref}", check=False)

    remote_ref = f"refs/heads/{branch}"
    listing = _git(repo_root, "ls-remote", "--heads", remote, remote_ref)
    branch_exists = bool(listing.strip())

    if root.exists():
        _clear_existing_store(repo_root, root, remote=remote, branch=branch)

    if branch_exists:
        # The fetch's outcome is load-bearing, so it is CHECKED rather than
        # discarded — but positively, against the SHA ls-remote just
        # reported, not by trusting an exit code. A large state branch is
        # exactly what fails transiently in CI (RPC error, ETIMEDOUT
        # mid-pack) while the tiny ls-remote moments later succeeds, and on
        # a persistent runner the stale tracking ref from the previous run
        # is right there to be checked out instead. Silently building on
        # last night's tip is how a publish overwrites a day of state.
        remote_head = listing.split()[0] if listing.split() else ""
        local_head = _git(repo_root, "rev-parse", "--verify", "--quiet", tracking_ref, check=False).strip()
        if not remote_head or local_head != remote_head:
            raise StateStoreError(
                f"state_store_fetch_stale: {tracking_ref} is at {local_head or '<absent>'} "
                f"but {remote}/{branch} is at {remote_head or '<unknown>'}; refusing to "
                "establish the store on a tip the server does not have"
            )
        # DETACHED, never a local branch. Checking the state branch out as
        # a branch means every store in this repository shares one ref, so
        # two lanes racing on the same runner would CHAIN — the second
        # committing on top of the first and fast-forwarding cleanly —
        # instead of colliding. That is the compare-and-swap silently not
        # happening, which is worse than the race it was meant to catch.
        # Detached, each store's HEAD moves alone and the only shared ref
        # is the remote's, where the server arbitrates.
        _git(repo_root, "worktree", "add", "--detach", "--force", str(root), f"{remote}/{branch}")
        return StateStore(
            root=root,
            branch=branch,
            repo_root=repo_root,
            remote=remote,
            bootstrapped=False,
        )

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
    return StateStore(
        root=root,
        branch=branch,
        repo_root=repo_root,
        remote=remote,
        bootstrapped=True,
    )


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
    anchor = _publication_anchor(store)
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

    # `--force`: the store commits exactly the surface set the snapshot
    # attests, and no ignore rule gets a vote on that. The two ignore
    # sources that can reach a worktree from outside its own tree —
    # `$GIT_COMMON_DIR/info/exclude` and `core.excludesFile` — are shared
    # with the main checkout, so a pattern added there for the main tree
    # (`aria-findings/`, say, which matches at any depth) would silently
    # subtract a subtree here. A surface the snapshot pins and the branch
    # does not carry is loss that verifies clean.
    #
    # NOT because the main checkout's `.gitignore` applies: it does not.
    # Git reads no `.gitignore` above a worktree's top level, and this
    # store's top level is `store_dir`, whose tree is the orphan branch's
    # content with no `.gitignore` in it at all. An earlier version of
    # this comment claimed otherwise and was wrong.
    _git(store.root, "add", "--all", "--force", ".")

    if not _git(store.root, "status", "--porcelain", "--ignored").strip():
        return {
            "published": False,
            "reason": "no_changes",
            "snapshot_id": snapshot.get("snapshot_id"),
            "manifest_root": snapshot.get("manifest_root"),
            "continuity": continuity,
        }

    # The commit that the push must either carry or undo. Captured before
    # committing so the rollback below targets a SHA rather than counting
    # backwards from a HEAD that may have moved.
    pre_commit_head = _git(store.root, "rev-parse", "--verify", "--quiet", "HEAD", check=False).strip()
    _git_commit(
        store.root,
        f"chore(aria-state): {cycle_id} {snapshot.get('snapshot_id', '')}".strip(),
    )

    # Plain push. A non-fast-forward update is rejected by the server,
    # which is the compare-and-swap this design relies on.
    proc = _run_git(store.root, ("push", store.remote, f"HEAD:refs/heads/{store.branch}"))
    if proc.returncode != 0:
        detail = proc.stderr.strip()[:300]
        remote_now = _remote_tip(store)

        # UNDO THE COMMIT. Committing happens before pushing because git
        # requires it, and that window is what previously stranded the
        # loser of every contended cycle: a commit reachable from nothing
        # but this worktree, with a CLEAN status, which the next checkout
        # then deleted along with its reflog. `--soft` keeps index and
        # working tree, so the rows land back in the uncommitted state the
        # store already refuses to discard — the failure returns the store
        # to where it was before publish rather than to a state no guard
        # was watching.
        if pre_commit_head:
            _git(store.root, "reset", "--soft", pre_commit_head, check=False)

        if remote_now is None:
            raise StateStoreError(
                f"state_publish_transport_failed: {detail} (the commit was rolled back; "
                "the rows are staged and still here)"
            )
        # A readable remote does not prove a WRITE was allowed. Compare the
        # tip against what this publish was based on: if it MOVED, another
        # lane won; if it did not, the push was denied for a reason
        # retrying cannot fix — a branch ruleset, a protected branch, or a
        # read-scoped token. Reporting the second as a lost race sends an
        # operator hunting a lane that never ran.
        based_on = (published or {}).get("manifest_root")
        tip_moved = remote_now != _commit_of_publication(store, based_on)
        if not tip_moved:
            raise StateStoreError(
                f"state_publish_write_denied: the remote is readable and its tip did not "
                f"move, so this was not a lost race — the push itself was refused. {detail}"
            )
        raise StateStoreRefusal(
            "state_publish_push_rejected: another lane published first. The commit was "
            f"rolled back and the rows are staged and intact; fetch and rebuild against "
            f"the new tip. ({detail})"
        )

    # Keep the tracking ref honest: it is the ancestry anchor, and a
    # publish that moved the server without moving it would make the next
    # cycle chain to a tip that is no longer current.
    _git(store.root, "update-ref", f"refs/remotes/{store.remote}/{store.branch}", "HEAD", check=False)

    return {
        "published": True,
        "pushed": True,
        "snapshot_id": snapshot.get("snapshot_id"),
        "manifest_root": snapshot.get("manifest_root"),
        "continuity": continuity,
    }


def _remote_tip(store: StateStore) -> str | None:
    """The remote branch's SHA, or ``None`` when the remote cannot be read."""
    proc = _run_git(
        store.root, ("ls-remote", "--heads", store.remote, f"refs/heads/{store.branch}")
    )
    if proc.returncode != 0:
        return None
    parts = proc.stdout.split()
    return parts[0] if parts else None


def _commit_of_publication(store: StateStore, manifest_root: str | None) -> str | None:
    """The local SHA this publish was based on, for the moved-tip comparison."""
    if manifest_root is None:
        return None
    tracking = f"refs/remotes/{store.remote}/{store.branch}"
    sha = _git(store.root, "rev-parse", "--verify", "--quiet", tracking, check=False).strip()
    return sha or None


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
    return build_snapshot(
        snapshot_id=snapshot_id,
        cycle_id=cycle_id,
        lane=lane,
        roots=store_roots(store, repo_hash),
        parent_commit=parent_commit,
        previous=previous,
    )


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

    # `--ignored` because `publish_state` stages with `git add --all
    # --force`: without it the probe and the add disagree about what the
    # store contains, and anything ignore-shadowed would be invisible here
    # and committed there.
    dirty = [
        line
        for line in _git(root, "status", "--porcelain", "--ignored").splitlines()
        if line.strip()
    ]
    if dirty:
        raise StateStoreRefusal(
            f"state_store_uncommitted_writes: {root.as_posix()} holds {len(dirty)} "
            "uncommitted path(s). Re-checking out would discard state that exists "
            "nowhere else; publish or discard them deliberately first."
        )
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
        snapshot = json.loads(blob)
    except ValueError as exc:
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


def _run_git(cwd: Path, args: tuple[str, ...]) -> subprocess.CompletedProcess[str]:
    """Every git invocation in this module, bounded and non-interactive.

    ``stdin`` is closed so a credential or overwrite prompt fails fast
    instead of wedging a scheduled run against a terminal that is not
    there, and the timeout bounds the case where the remote accepts the
    connection and then says nothing.
    """
    try:
        return subprocess.run(
            ["git", "-C", str(cwd), *args],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as exc:
        raise StateStoreError(f"state_store_git_timeout: git {' '.join(args)}") from exc


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
    "build_publishable_snapshot",
    "checkout_state_store",
    "findings_root",
    "publish_state",
    "read_published_snapshot",
    "snapshot_path",
    "store_roots",
    "tools_root",
    "verify_state_store",
    "workspace_root",
]
