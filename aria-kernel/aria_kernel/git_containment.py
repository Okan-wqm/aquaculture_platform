"""ARIA-HIGH-123 — the implementer's sandbox binds git where the implementer commits.

WHY this module exists
----------------------
The write-containment sandbox (``implementation_safety.wrap_bash_in_sandbox``)
bound the workspace and ro-bound every READONLY_PATHS entry under it,
``.git/`` included, and nothing else. Measured on this host with the real
wrapper (2026-09-14): in a LINKED worktree — the production shape, the
per-request tree ``ci_executor_drain._add_request_worktree`` adds under
``<checkout>/aria-worktrees/`` — ``.git`` is a pointer FILE and both the
worktree's private git dir and the repository's common dir live OUTSIDE the
bound workspace, so every git command died ``fatal: not a git repository:
<checkout>/.git/worktrees/<name>``; in a MAIN checkout the ro-bind of
``.git/`` made ``git add`` die on ``.git/index.lock: Read-only file
system``. The identity chain (ARIA-HIGH-115) wires a plain ``git commit``
to the cycle key and the merge gate verifies that commit — a commit the
sandbox could not make in either lane. The same measurement showed the
private key readable inside the sandbox (``aria-debts/`` is ro-bound, and
ro means readable).

The first cut of this module bound the shared common dir's ``objects/``,
``refs/heads/`` and ``logs/refs/heads/`` WRITABLE and the worktree's private
git dir writable with its control files overlaid. The adversarial reverify
(round 1) showed what a writable shared object store hands the agent:
``rm objects/pack/*.pack`` (every checkout of the repository corrupt),
``git repack`` (the shared pack set rewritten), ``objects/info/alternates``
(every later git run of the kernel reads objects from an agent-chosen
directory), ``refs/heads/main.lock`` and ``objects/maintenance.lock``
(planted, never cleaned by git, wedging the repository until an operator
removes them), ``<private>/locked`` (the reaper's ``git worktree remove
--force`` refuses). Overlaying every existing loose object read-only is not
an option: bwrap refuses more than 9000 argv tokens and a real checkout
carries thousands of loose objects.

WHAT this module does
---------------------
The agent's git never touches the shared repository. It runs against a
SANDBOX GIT DIR — a kernel-made replica of the worktree's private git dir
(``<private>/aria-sandbox/``: ``HEAD``, ``index``, ``logs/HEAD``, the
control files) bound over ``<private>`` inside the sandbox, so ``git
switch``, ``git add`` and ``git commit`` rewrite the REPLICA's ``HEAD`` and
``index`` and the host's stay as the drain left them (``locked`` included:
a ``locked`` the agent writes lands in the replica, and the host's private
dir carries none) — and against a QUARANTINE, git's own receive-pack
shape (``tmp_objdir``): new objects go to ``GIT_OBJECT_DIRECTORY =
<private>/objects`` (the replica's object dir, whose ``info/alternates``
names the shared store for READS), new refs and reflogs go to the replica's
``refs/heads/`` and ``logs/refs/heads/``, which the sandbox binds AT
``<common>/refs/heads`` and ``<common>/logs/refs/heads`` — so a plain
``git add`` + ``git commit`` on the branch the kernel stood the sandbox on
(``stand_on_implementation_branch``, ARIA-HIGH-124; the push is the
executor's, after the run) works unchanged inside, while every SHARED entry
of the common dir is bound READ-ONLY one by one (``config``, ``hooks/``,
``info/``, ``objects/`` with its packs, ``objects/info/alternates`` and
``maintenance.lock``, ``packed-refs``, ``refs/tags``, ``refs/remotes``, the
main checkout's ``HEAD``/``index``/``logs/HEAD``): a write to any of them is
EROFS at the syscall. The common dir ITSELF is a tmpfs at its own path
(ARIA-HIGH-141): a current git (2.55 on the hosted lane) takes
``packed-refs.lock`` beside ``packed-refs`` on every loose-ref update, and
under a read-only bind of the whole dir that lock was ``Read-only file
system`` on every branch creation — an ``error:`` line the ref update
survives, but one that fills the first lines of stderr and masks a refusal
by name. A lock sibling now lands in the tmpfs and dies with the sandbox;
the entry it guards stays EROFS, and a ``packed-refs`` git rewrites inside
(``pack-refs``) is refused at the rename over the mountpoint (EBUSY), so a
branch git packs inside is unadvanced and discarded at publication. The
main checkout's in-progress state (``ORIG_HEAD``, ``MERGE_HEAD``,
``COMMIT_EDITMSG``, a rebase or sequencer dir) and every ``*.lock`` are not
shared entries and are not bound: absent inside, never wedging the agent's
git on a stale host lock.
Existing loose refs under ``refs/heads/`` are bound read-only on top of the
quarantine so the agent SEES ``main`` when it is loose (a packed one it sees
through ``packed-refs``) and cannot rewrite it (a mountpoint cannot be
renamed over — EBUSY — nor unlinked); the count is bounded
(``LOOSE_REF_OVERLAY_BOUND``, refused by name above it — ``git pack-refs
--all`` is the remedy). ``<common>/worktrees/`` is a fresh tmpfs with only
THIS worktree's entry (the replica) bound back in, so sibling worktrees are
not even visible; the main checkout's working tree is never bound;
``<workspace>/aria-debts/keys/`` is a fresh tmpfs with only the held
identity's PUBLIC key bound back in — the private key does not enter the
sandbox. Git signs through the ssh-agent the kernel holds outside
(``signing_agent``, bound in as one socket): measured with git 2.43 and
OpenSSH 9.6, ``ssh-keygen -Y sign -f <private path>`` loads
``<private path>.pub`` when the private file is absent and signs through
``SSH_AUTH_SOCK`` when the agent holds the key; without the agent the
commit fails ``No private key found`` — never silently unsigned.

After the spawn the KERNEL publishes the quarantine (``publish_quarantine``,
outside the sandbox, with the kernel's authority and git's own checks).
Every loose object is inflated and re-hashed before it moves: git reads
loose objects BEFORE packed ones, so an unchecked migration would let a
crafted file under a packed object's name shadow the good object for every
later git run of the kernel — a file whose bytes do not hash to its name is
refused and named in the receipt; a verified object is renamed into the
shared store (same filesystem, content-addressed: one the store already
holds is dropped, never overwritten). A pack the agent's git made (``gc
--auto`` inside the quarantine) is fed to ``git unpack-objects --strict``
against the shared store, which stores each object under the hash of its
inflated bytes and skips the ones already there — never a pack file copied
whole (a ``repack -a`` inside would have folded the entire store into
it). Every ref file under the quarantine's ``refs/heads/`` whose name is an
ARIA implementation branch (``command_policy.ARIA_IMPL_BRANCH_FRAGMENT`` —
the push grammar's own fragment) and whose content is an object the store
now holds is published with ``git update-ref`` (a real reflog row, the
kernel's); everything else in the quarantine — a planted ``main.lock``, a
shadow ``main``, a branch of the agent's own naming — is discarded and
named in the receipt; the worktree's HEAD is then pointed at the published
branch the replica's HEAD names (the branch the kernel stood the sandbox
on, adopted by the kernel on the host), so the executor's evidence check grades the agent's
files against the agent's commit. A crashed executor publishes nothing: the
quarantine dies with its worktree, and the shared repository never carried
a byte of it.

A workspace that is not a linked worktree cannot host a commit-capable
sandbox: a MAIN checkout's ``.git/`` is the repository every worktree
shares. That shape is REFUSED by name (``GitContainmentRefusal``,
``shared_checkout_scope:--local`` — the same spelling
``implementation_identity`` refuses it with, one reading:
``signing_checkout``), never bound writable; read-only git in a main
checkout keeps the READONLY_PATHS ro-bind of ``.git/`` as before.

ARIA-HIGH-124 — the implementation branch is the KERNEL's to make. The
contract used to have the agent run ``git switch -c <branch> <base_sha>``
inside — a command the command policy never admitted (the PreToolUse hook
refused it), so the first git step of every production implementation was
unexecutable. The executor now stands the sandbox on the branch before the
spawn (``stand_on_implementation_branch``): the replica's ``HEAD`` names
``refs/heads/<branch>`` and the quarantine's ref file names ``base_sha`` —
two file writes in the replica, nothing in the shared repository, so the
agent's plain ``git commit`` advances a branch that exists only in the
quarantine until the kernel publishes it. Refused by name when the worktree
is not at ``base_sha`` (``worktree_not_at_base_sha:<head>`` — the drain adds
an implementation request's worktree at the staged base, and a lane that
hands another tree is not silently re-pointed), when the branch name is not
an ARIA implementation branch (``implementation_branch_name_invalid``, the
publication would discard it), or when the shared repository already holds
``refs/heads/<branch>`` (``implementation_branch_exists`` — an earlier
attempt of the same request published it; the loose-ref overlay would make
it read-only inside and the agent's commit would die on it, so it is
refused before a turn is spent and an operator decides).

The seed is the kernel's, not the agent's (round 2). ``stand_on_
implementation_branch`` returns the containment with the seed recorded
(``seeded_refs``: the branch and the object id it was seeded at), and the
publication DISCARDS a quarantine ref whose content still equals its seed
(``branch_unadvanced``, named in the receipt; the worktree's HEAD adopts
nothing). Before this, a spawn that failed before any commit — a timeout, a
provider outage, an operator cancel; the publication runs in the ``finally``
before every one of those arms — published the seed as a real
``refs/heads/aria-impl-*`` in the shared repository, and the harness-class
retry the design promises was then refused pre-turn as
``implementation_branch_exists``: every harness fault of an implementation
spawn ended in a human after one wasted retry. A branch reaches the shared
repository only when the agent advanced it; an agent that commits nothing is
refused by the delivery (``branch_not_published:…branch_unadvanced``) and a
failed spawn leaves no branch, so its retry stands on the branch again.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import zlib
from dataclasses import dataclass, replace
from pathlib import Path

from .command_policy import ARIA_IMPL_BRANCH_FRAGMENT

# Where the kernel-held signing agent's socket appears INSIDE the sandbox:
# under the sandbox's private /tmp tmpfs, so the host path (which may be
# long, or under a directory the sandbox hides) never has to be visible.
SANDBOX_SIGNING_AGENT_SOCKET = "/tmp/aria-signing-agent.sock"
# The environment variable ssh-keygen reads the agent socket from; set by
# bwrap (``--setenv``) after the spawn environment was built, because the
# agent-env builder drops the name as secret-shaped (``_AUTH_``) — so the
# only SSH_AUTH_SOCK a contained spawn can ever see is the kernel's.
SSH_AUTH_SOCK_ENV = "SSH_AUTH_SOCK"
# The variable that points git's WRITES at the quarantine. Set by bwrap for
# the contained spawn; an agent that unsets it points its git at the shared
# store, which is read-only — its own commit then fails EROFS.
GIT_OBJECT_DIRECTORY_ENV = "GIT_OBJECT_DIRECTORY"
# The replica of the private git dir, under the real one on the host.
SANDBOX_GIT_DIR_NAME = "aria-sandbox"
# The private git dir's control files the agent must not rewrite. The
# replica's copies are overlaid read-only inside (only the entries that
# exist: bwrap aborts on a missing bind source); ``config.worktree``, the
# signers file and the snapshots dir exist by the time a commit-capable
# spawn is built, because the identity mint writes them BEFORE the spawn
# (ARIA-HIGH-115). ``locked`` needs no overlay: the agent writes the
# replica's, and the host's private dir is not mounted at all.
PRIVATE_GIT_DIR_CONTROL_ENTRIES: tuple[str, ...] = (
    "commondir",
    "gitdir",
    "config.worktree",
    "aria-allowed-signers",
    "aria-signing-config-snapshots",
)
# The common-dir directories the quarantine stands in for inside the
# sandbox: the replica's own directory of the same relative name is bound
# AT the common path.
COMMON_DIR_QUARANTINED_REF_DIRS: tuple[str, ...] = ("refs/heads", "logs/refs/heads")
COMMON_DIR_OBJECTS = "objects"
COMMON_DIR_WORKTREES = "worktrees"
# ARIA-HIGH-141 — the common dir's entries that are the MAIN checkout's
# in-progress operation state, not the shared repository: not bound into
# the sandbox (git treats their absence as "no operation in progress").
# The two ref directories the quarantine stands in for and ``worktrees``
# (a tmpfs of its own) are handled by name; ``*.lock`` files are skipped
# by suffix.
COMMON_DIR_UNSHARED_ENTRIES: frozenset[str] = frozenset({
    "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD",
    "AUTO_MERGE", "BISECT_LOG", "BISECT_START", "BISECT_EXPECTED_REV", "BISECT_ANCESTORS_OK",
    "BISECT_NAMES", "BISECT_TERMS", "BISECT_RUN", "COMMIT_EDITMSG", "MERGE_MSG", "MERGE_RR",
    "MERGE_MODE", "SQUASH_MSG", "TAG_EDITMSG", "rebase-merge", "rebase-apply", "sequencer",
    "gc.log", "gc.pid", SANDBOX_GIT_DIR_NAME,
})
# The entries descended one level so the quarantined subdirectory can be
# left out and its siblings (`refs/tags`, `refs/remotes`, `logs/HEAD`)
# bound on their own.
_COMMON_DIR_DESCENDED_ENTRIES: tuple[str, ...] = ("refs", "logs", "logs/refs")
# Existing loose refs are overlaid one by one (a mount each); a checkout
# carrying more than this many has not been packed in a long while and is
# refused by name rather than blowing bwrap's argv limit.
LOOSE_REF_OVERLAY_BOUND = 512
_GIT_PATH_TIMEOUT_SECONDS = 10
_GIT_PUBLISH_TIMEOUT_SECONDS = 120
# ARIA-HIGH-124 (round 3) — how long `publish_quarantine` may legitimately
# run, priced into the implementation child by the executor
# (`implementation_delivery.IMPLEMENTATION_DELIVERY_WORST_CASE_SECONDS`).
# The git calls it makes, each at `_GIT_PUBLISH_TIMEOUT_SECONDS`: the object
# format probe, ONE `update-ref` (only the kernel-seeded branch is
# published; every other ref is discarded by name without git), the HEAD
# adoption's `symbolic-ref` and `reset`, and one `unpack-objects` — the
# agent has no admitted `repack`/`gc`, so a pack in the quarantine can only
# be git's own auto-gc of a commit, one per run. The loose-object migration
# is renames on one filesystem, charged to the same allowance.
QUARANTINE_PUBLICATION_GIT_CALLS = 5
QUARANTINE_PUBLICATION_WORST_CASE_SECONDS = QUARANTINE_PUBLICATION_GIT_CALLS * _GIT_PUBLISH_TIMEOUT_SECONDS
# ARIA-HIGH-124 (round 6) — the kernel's OWN git subprocesses (the
# publication's ref writes here, the delivery's push in
# `implementation_delivery`) run with git's hooks off: `core.hooksPath`
# pointed at a path no hook can live under. They run in the request
# worktree, whose hooks resolve through the shared checkout's config; a
# `core.hooksPath=.husky` a runner install could set (`npm run
# hooks:install`, an `npm ci` without `--ignore-scripts`) would otherwise
# run a hook from the AGENT's tree as the executor — with the delivery
# credential in the push's environment. Argv, not environment: the
# credential helper rides `GIT_CONFIG_COUNT`, and git's `-c` is exported
# to the git subprocess alone.
KERNEL_GIT_NO_HOOKS_ARGS: tuple[str, ...] = ("-c", f"core.hooksPath={os.devnull}")
_ARIA_IMPL_BRANCH_RE = re.compile(rf"^{ARIA_IMPL_BRANCH_FRAGMENT}$")
_OBJECT_ID_RE = re.compile(r"^[0-9a-f]{40}([0-9a-f]{24})?$")
_LOOSE_OBJECT_DIR_RE = re.compile(r"^[0-9a-f]{2}$")
# The hash git names objects with, per `git rev-parse --show-object-format`.
_OBJECT_FORMATS: dict[str, str] = {"sha1": "sha1", "sha256": "sha256"}
# Bounded so a crafted loose object cannot make the verifier inflate
# without end; git's own loose-object reader has the same bound in spirit
# (`core.bigFileThreshold` and the unpack limit).
_MAX_LOOSE_OBJECT_BYTES = 512 * 1024 * 1024


class GitContainmentRefusal(Exception):
    """The workspace cannot host the requested git containment; ``reason`` names why.

    Closed vocabulary: ``not_a_checkout``, ``common_dir_unresolvable``,
    ``shared_checkout_scope:--local`` (a main checkout asked for commit
    capability), ``git_dir_overlaps_workspace``,
    ``private_git_dir_outside_worktrees``, ``hooks_dir_unresolvable:<why>``,
    ``git_dir_unwritable:<ErrorClass>``, ``loose_refs_exceed_overlay_bound:<n>``,
    ``signing_public_key_outside_keys_dir``,
    ``signing_keys_dir_outside_workspace``, ``signing_agent_socket_missing``,
    ``signing_without_commit_capability``; and for
    ``stand_on_implementation_branch`` (ARIA-HIGH-124):
    ``branch_without_commit_capability``, ``implementation_branch_name_invalid``,
    ``base_sha_not_an_object_id``, ``worktree_head_unresolvable:<why>``,
    ``worktree_not_at_base_sha:<head>``, ``implementation_branch_exists``,
    ``replica_unwritable:<ErrorClass>``.
    """

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class SandboxSigning:
    """What a commit-capable sandbox is shown of the held identity: the
    keys dir to hide, the one public key to show, the agent socket to bind.

    The private key path is deliberately not a field — nothing here may
    name it, so nothing here can bind it.
    """

    keys_dir: Path
    public_key_path: Path
    agent_socket: Path


@dataclass(frozen=True)
class GitContainment:
    """The derived git binds of one workspace, as bwrap flags on demand.

    ``commit_capable`` False is the read-only shape (git reads work in a
    linked worktree; nothing under either git dir is writable).
    ``hooks_dir`` is the effective hooks directory (commit-capable only;
    None for the read-only shape, where no hook can run).
    ``sandbox_git_dir`` is the replica the sandbox sees as the private git
    dir, holding the quarantine (commit-capable only). ``loose_refs`` are
    the existing loose ref files bound read-only on top of the quarantine.
    """

    workspace_root: Path
    private_git_dir: Path
    common_git_dir: Path
    commit_capable: bool
    hooks_dir: Path | None = None
    signing: SandboxSigning | None = None
    sandbox_git_dir: Path | None = None
    loose_refs: tuple[Path, ...] = ()
    # ARIA-HIGH-141 — the shared entries of the common dir, enumerated at
    # derivation (the spawn follows at once) and bound back read-only one
    # by one into the tmpfs that stands at the common path.
    common_entries: tuple[Path, ...] = ()
    # ARIA-HIGH-124 (round 2) — the branches the KERNEL seeded in the
    # quarantine (`stand_on_implementation_branch`) and the object id each
    # was seeded at: a quarantine ref still equal to its seed is the
    # kernel's own write, never the agent's commit, and the publication
    # discards it (`branch_unadvanced`) instead of adopting it as a branch.
    seeded_refs: tuple[tuple[str, str], ...] = ()

    @property
    def quarantine_objects_dir(self) -> Path | None:
        return None if self.sandbox_git_dir is None else self.sandbox_git_dir / COMMON_DIR_OBJECTS

    def bind_sources(self) -> frozenset[Path]:
        """Every host path this containment mounts (for the probe/wrapper
        invariants that separate system binds from checkout-derived ones)."""
        flags = self.bwrap_flags()
        sources: set[Path] = set()
        for index, token in enumerate(flags):
            if token in ("--bind", "--ro-bind", "--tmpfs"):
                sources.add(Path(flags[index + 1]))
        return frozenset(sources)

    def bwrap_flags(self) -> list[str]:
        """The flags, in mount order — a later mount shadows an earlier one,
        so the quarantine binds come after the read-only common dir they
        stand in for, and the read-only overlays after the writable binds
        they narrow."""
        common = self.common_git_dir
        private = self.private_git_dir
        # ARIA-HIGH-141: a tmpfs AT the common path, each shared entry bound
        # back read-only on top — a lock sibling git creates beside an
        # entry lands in the tmpfs; the entry itself stays EROFS.
        flags: list[str] = ["--tmpfs", str(common)]
        for entry in self.common_entries:
            flags.extend(["--ro-bind", str(entry), str(entry)])
        if self.commit_capable:
            replica = self.sandbox_git_dir
            assert replica is not None
            for relative in COMMON_DIR_QUARANTINED_REF_DIRS:
                # The quarantine stands in for the shared directory: what
                # the agent's git creates there lands in the replica on
                # the host, never in the shared repository.
                flags.extend(["--bind", str(replica / relative), str(common / relative)])
            for loose in self.loose_refs:
                # Visible (a loose `main`), immutable (a mountpoint cannot
                # be renamed over — EBUSY — nor unlinked). The mountpoint
                # is an empty placeholder in the quarantine, which the
                # publication step ignores.
                flags.extend(["--ro-bind", str(loose), str(loose)])
        # Sibling worktrees are hidden, not merely read-only: their entries
        # name other requests' trees, and the agent has no business seeing
        # them. The tmpfs replaces the directory; this worktree's own entry
        # is bound back in on top.
        worktrees = common / COMMON_DIR_WORKTREES
        flags.extend(["--tmpfs", str(worktrees)])
        if self.commit_capable:
            replica = self.sandbox_git_dir
            assert replica is not None
            # The replica IS the private git dir inside: HEAD, index and
            # logs/HEAD rewrite the replica's files; the host's stay as the
            # drain left them.
            flags.extend(["--bind", str(replica), str(private)])
            for name in PRIVATE_GIT_DIR_CONTROL_ENTRIES:
                entry = replica / name
                if entry.exists():
                    flags.extend(["--ro-bind", str(entry), str(private / name)])
            if self.hooks_dir is not None:
                if self.hooks_dir.exists():
                    flags.extend(["--ro-bind", str(self.hooks_dir), str(self.hooks_dir)])
                else:
                    # `core.hooksPath` names a directory that is not there
                    # (a worktree without its `.husky/`): git runs no hooks,
                    # and the agent must not be able to create the directory
                    # inside its writable tree and put hooks in it. An empty,
                    # read-only mount takes the place.
                    flags.extend(["--tmpfs", str(self.hooks_dir), "--remount-ro", str(self.hooks_dir)])
            flags.extend(["--setenv", GIT_OBJECT_DIRECTORY_ENV, str(private / COMMON_DIR_OBJECTS)])
        else:
            flags.extend(["--ro-bind", str(private), str(private)])
        if self.signing is not None:
            keys_dir = self.signing.keys_dir
            public_key = self.signing.public_key_path
            flags.extend(["--tmpfs", str(keys_dir), "--ro-bind", str(public_key), str(public_key)])
            flags.extend([
                "--bind", str(self.signing.agent_socket), SANDBOX_SIGNING_AGENT_SOCKET,
                "--setenv", SSH_AUTH_SOCK_ENV, SANDBOX_SIGNING_AGENT_SOCKET,
            ])
        return flags


@dataclass(frozen=True)
class QuarantinePublication:
    """What ``publish_quarantine`` did: objects moved, packs unpacked, refs
    published — and what was refused, by name. ``refusal`` is set when the
    publication could not run at all (git did not answer)."""

    loose_objects_migrated: int
    packs_unpacked: int
    objects_refused: tuple[tuple[str, str], ...]
    refs_published: tuple[str, ...]
    refs_discarded: tuple[tuple[str, str], ...]
    refusal: str | None = None
    # The published branch the worktree's HEAD now names — the agent's
    # branch the kernel stood the sandbox on in the replica, adopted on the host so the executor's
    # evidence check (`--evidence-target-sha auto`, the worktree's HEAD)
    # grades the agent's files against the agent's commit; None when the
    # replica's HEAD named nothing that was published.
    head_adopted: str | None = None

    def to_row(self) -> dict[str, object]:
        return {
            "loose_objects_migrated": self.loose_objects_migrated,
            "packs_unpacked": self.packs_unpacked,
            "objects_refused": [{"object": name, "reason": reason} for name, reason in self.objects_refused],
            "refs_published": list(self.refs_published),
            "refs_discarded": [{"ref": ref, "reason": reason} for ref, reason in self.refs_discarded],
            "refusal": self.refusal,
            "head_adopted": self.head_adopted,
        }


def _effective_hooks_dir(workspace: Path) -> Path:
    """The directory git will run hooks from in ``workspace`` — honouring
    ``core.hooksPath`` wherever it is set — resolved by git itself."""
    try:
        done = subprocess.run(
            ["git", "-C", str(workspace), "rev-parse", "--path-format=absolute", "--git-path", "hooks"],
            capture_output=True, text=True, check=False, timeout=_GIT_PATH_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise GitContainmentRefusal(f"hooks_dir_unresolvable:{type(exc).__name__}") from exc
    if done.returncode != 0 or not done.stdout.strip():
        first_line = done.stderr.strip().splitlines()[0] if done.stderr.strip() else f"rc={done.returncode}"
        raise GitContainmentRefusal(f"hooks_dir_unresolvable:{first_line[:120]}")
    return Path(done.stdout.strip()).resolve()


def _shared_common_dir_entries(common: Path, *, commit_capable: bool) -> tuple[Path, ...]:
    """The common dir's entries the sandbox sees (ARIA-HIGH-141), in mount
    order: every existing entry that is repository content — not the main
    checkout's in-progress state, not a ``*.lock``, not ``worktrees`` (a
    tmpfs of its own with this worktree's replica bound back in) — with
    ``refs`` and ``logs`` descended so the two directories the quarantine
    stands in for are left out of a commit-capable spawn and their siblings
    are bound on their own. A read-only spawn has no quarantine: it sees
    ``refs/heads`` and ``logs/refs/heads`` read-only like every other entry."""
    quarantined = {common / relative for relative in COMMON_DIR_QUARANTINED_REF_DIRS} if commit_capable else set()
    descended = {common / relative for relative in _COMMON_DIR_DESCENDED_ENTRIES}
    entries: list[Path] = []

    def walk(directory: Path) -> None:
        try:
            children = sorted(directory.iterdir())
        except OSError:
            return
        for child in children:
            if child.name.endswith(".lock") or child.name in COMMON_DIR_UNSHARED_ENTRIES:
                continue
            if child == common / COMMON_DIR_WORKTREES or child in quarantined:
                continue
            if child in descended and child.is_dir():
                walk(child)
                continue
            entries.append(child)

    walk(common)
    return tuple(entries)


def _existing_loose_refs(common: Path) -> tuple[Path, ...]:
    heads = common / "refs" / "heads"
    if not heads.is_dir():
        return ()
    return tuple(sorted(
        path for path in heads.rglob("*") if path.is_file() and not path.name.endswith(".lock")
    ))


def _prepare_sandbox_git_dir(private: Path, common: Path) -> Path:
    """Make the replica the sandbox sees as the private git dir: a fresh
    copy of the private dir's files (HEAD, index, logs/HEAD, the control
    files) with the quarantine directories and the alternates pointer.
    A replica a previous spawn left behind is replaced: it described that
    spawn's HEAD and index, and its unpublished quarantine was discarded
    with that spawn."""
    replica = private / SANDBOX_GIT_DIR_NAME
    try:
        if replica.exists():
            shutil.rmtree(replica)
        shutil.copytree(
            private, replica, symlinks=True,
            ignore=lambda directory, names: [SANDBOX_GIT_DIR_NAME] if Path(directory) == private else [],
        )
        objects = replica / COMMON_DIR_OBJECTS
        (objects / "info").mkdir(parents=True, exist_ok=True)
        (objects / "pack").mkdir(exist_ok=True)
        # Reads fall through to the shared store; writes stay here.
        (objects / "info" / "alternates").write_text(f"{common / COMMON_DIR_OBJECTS}\n", encoding="utf-8")
        for relative in COMMON_DIR_QUARANTINED_REF_DIRS:
            (replica / relative).mkdir(parents=True, exist_ok=True)
            # The mountpoint in the shared dir must exist for the quarantine
            # to be bound over it (a read-only bind cannot grow one).
            (common / relative).mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise GitContainmentRefusal(f"git_dir_unwritable:{type(exc).__name__}") from exc
    return replica


def derive_git_containment(
    workspace_root: str | Path,
    *,
    commit_capable: bool,
    signing: SandboxSigning | None = None,
) -> GitContainment | None:
    """Derive the git binds for a spawn whose cwd is ``workspace_root``.

    Returns ``None`` when there is nothing to derive: the workspace is not
    a checkout, or it is a MAIN checkout asked for read-only git (its
    ``.git/`` directory is inside the workspace and the READONLY_PATHS
    ro-bind already makes git reads work and writes EROFS). Raises
    :class:`GitContainmentRefusal` by name when ``commit_capable`` is asked
    of a shape that cannot host it. A commit-capable derivation PREPARES the
    sandbox git dir (the replica and its quarantine) on the host, so it is
    made right before the spawn. ``signing`` is accepted only with
    ``commit_capable``; it must name a keys dir inside the workspace, a
    public key inside that dir, and an existing agent socket.
    """
    from .gh_token_factory import signing_checkout

    workspace = Path(workspace_root).resolve()
    if signing is not None and not commit_capable:
        raise GitContainmentRefusal("signing_without_commit_capability")
    checkout = signing_checkout(workspace)
    if checkout is None:
        if commit_capable:
            raise GitContainmentRefusal("not_a_checkout")
        return None
    private = checkout.git_dir
    from .checkout_root import resolve_git_common_directory

    common = resolve_git_common_directory(private)
    if common is None:
        if commit_capable:
            raise GitContainmentRefusal("common_dir_unresolvable")
        return None
    if not checkout.linked:
        if commit_capable:
            raise GitContainmentRefusal(f"shared_checkout_scope:{checkout.config_scope}")
        return None
    if common.is_relative_to(workspace) or workspace.is_relative_to(common):
        raise GitContainmentRefusal("git_dir_overlaps_workspace")
    if private.parent != common / COMMON_DIR_WORKTREES:
        raise GitContainmentRefusal("private_git_dir_outside_worktrees")
    hooks_dir: Path | None = None
    replica: Path | None = None
    loose_refs: tuple[Path, ...] = ()
    if commit_capable:
        hooks_dir = _effective_hooks_dir(workspace)
        loose_refs = _existing_loose_refs(common)
        if len(loose_refs) > LOOSE_REF_OVERLAY_BOUND:
            raise GitContainmentRefusal(f"loose_refs_exceed_overlay_bound:{len(loose_refs)}")
        replica = _prepare_sandbox_git_dir(private, common)
    common_entries = _shared_common_dir_entries(common, commit_capable=commit_capable)
    if signing is not None:
        keys_dir = signing.keys_dir.resolve()
        public_key = signing.public_key_path.resolve()
        if not keys_dir.is_relative_to(workspace) or not keys_dir.is_dir():
            raise GitContainmentRefusal("signing_keys_dir_outside_workspace")
        if public_key.parent != keys_dir or not public_key.is_file():
            raise GitContainmentRefusal("signing_public_key_outside_keys_dir")
        if not _is_socket(signing.agent_socket):
            raise GitContainmentRefusal("signing_agent_socket_missing")
        signing = SandboxSigning(keys_dir=keys_dir, public_key_path=public_key,
                                 agent_socket=signing.agent_socket.resolve())
    return GitContainment(
        workspace_root=workspace, private_git_dir=private, common_git_dir=common,
        commit_capable=commit_capable, hooks_dir=hooks_dir, signing=signing,
        sandbox_git_dir=replica, loose_refs=loose_refs, common_entries=common_entries,
    )


def _is_socket(path: Path) -> bool:
    try:
        return path.is_socket()
    except OSError:
        return False


def stand_on_implementation_branch(containment: GitContainment, *, branch: str, base_sha: str) -> GitContainment:
    """Put the sandbox on ``refs/heads/<branch>`` at ``base_sha`` — in the replica only.

    ARIA-HIGH-124 — what the contract's ``git switch -c <branch> <base_sha>``
    was meant to do, done by the kernel before the spawn, in the replica the
    sandbox sees as its private git dir: ``HEAD`` becomes the symbolic ref
    and the quarantine's ``refs/heads/<branch>`` names ``base_sha``. The
    shared repository is not touched, the host worktree's HEAD stays as the
    drain left it (detached at ``base_sha``), and the agent inside starts on
    the branch with a working tree and index already at that commit. Every
    refusal is by name (``GitContainmentRefusal``) and writes nothing.

    Returns the containment WITH the seed recorded (``seeded_refs``): the
    caller publishes with that one, so a ref the agent never advanced past
    the seed is discarded rather than published (round 2).
    """
    replica = containment.sandbox_git_dir
    if not containment.commit_capable or replica is None:
        raise GitContainmentRefusal("branch_without_commit_capability")
    if not _ARIA_IMPL_BRANCH_RE.match(branch):
        raise GitContainmentRefusal("implementation_branch_name_invalid")
    if not _OBJECT_ID_RE.match(base_sha):
        raise GitContainmentRefusal("base_sha_not_an_object_id")
    env = _publish_environment()
    workspace = containment.workspace_root
    try:
        head = _git(["rev-parse", "--verify", "HEAD^{commit}"], cwd=workspace, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        raise GitContainmentRefusal(f"worktree_head_unresolvable:{type(exc).__name__}") from exc
    if head.returncode != 0:
        raise GitContainmentRefusal("worktree_head_unresolvable:rc=" + str(head.returncode))
    if head.stdout.strip() != base_sha:
        # The tree the agent edits must be the tree the baseline was
        # measured on; re-pointing it here would hide a lane that provisions
        # the wrong one.
        raise GitContainmentRefusal(f"worktree_not_at_base_sha:{head.stdout.strip()}")
    existing = _git(["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"], cwd=workspace, env=env)
    if existing.returncode == 0:
        raise GitContainmentRefusal("implementation_branch_exists")
    try:
        ref_file = replica / "refs" / "heads" / branch
        ref_file.parent.mkdir(parents=True, exist_ok=True)
        ref_file.write_text(base_sha + "\n", encoding="utf-8")
        (replica / "HEAD").write_text(f"ref: refs/heads/{branch}\n", encoding="utf-8")
    except OSError as exc:
        raise GitContainmentRefusal(f"replica_unwritable:{type(exc).__name__}") from exc
    return replace(containment, seeded_refs=(*containment.seeded_refs, (branch, base_sha)))


def _publish_environment() -> dict[str, str]:
    env = {name: value for name, value in os.environ.items()
           if name not in (GIT_OBJECT_DIRECTORY_ENV, "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_DIR",
                           "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE")}
    env.update({"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull})
    return env


def _git(args: list[str], *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *KERNEL_GIT_NO_HOOKS_ARGS, *args], cwd=str(cwd), env=env, capture_output=True, text=True,
        check=False, timeout=_GIT_PUBLISH_TIMEOUT_SECONDS,
    )


def _move_into_store(source: Path, target: Path) -> bool:
    """Rename ``source`` to ``target`` (same filesystem, atomic); an object
    the store already holds is dropped — content-addressed, never
    overwritten. True when the store gained the file."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        source.unlink()
        return False
    os.replace(source, target)
    return True


def _loose_object_refusal(path: Path, object_id: str, object_format: str) -> str | None:
    """Why ``path`` may not enter the store under ``object_id``: its bytes
    do not inflate, or they hash to another name."""
    try:
        if path.stat().st_size > _MAX_LOOSE_OBJECT_BYTES:
            return "object_too_large"
        inflated = zlib.decompressobj().decompress(path.read_bytes(), _MAX_LOOSE_OBJECT_BYTES + 1)
    except (OSError, zlib.error) as exc:
        return f"object_unreadable:{type(exc).__name__}"
    if len(inflated) > _MAX_LOOSE_OBJECT_BYTES:
        return "object_too_large"
    if hashlib.new(object_format, inflated).hexdigest() != object_id:
        return "object_hash_mismatch"
    return None


def _migrate_objects(
    quarantine: Path, store: Path, *, checkout: Path, env: dict[str, str], object_format: str,
) -> tuple[int, int, list[tuple[str, str]]]:
    loose = 0
    packs = 0
    refused: list[tuple[str, str]] = []
    for fan_out in sorted(quarantine.iterdir()):
        if not (fan_out.is_dir() and _LOOSE_OBJECT_DIR_RE.match(fan_out.name)):
            continue
        for entry in sorted(fan_out.iterdir()):
            object_id = fan_out.name + entry.name
            if not (entry.is_file() and _OBJECT_ID_RE.match(object_id)):
                continue
            why = _loose_object_refusal(entry, object_id, object_format)
            if why is not None:
                refused.append((object_id, why))
                entry.unlink()
                continue
            if _move_into_store(entry, store / fan_out.name / entry.name):
                loose += 1
    pack_dir = quarantine / "pack"
    if pack_dir.is_dir():
        for pack in sorted(path for path in pack_dir.iterdir() if path.is_file() and path.suffix == ".pack"):
            with pack.open("rb") as handle:
                unpacked = subprocess.run(
                    ["git", "unpack-objects", "-q", "--strict"], cwd=str(checkout), stdin=handle,
                    env={**env, GIT_OBJECT_DIRECTORY_ENV: str(store)}, capture_output=True, text=True,
                    check=False, timeout=_GIT_PUBLISH_TIMEOUT_SECONDS,
                )
            if unpacked.returncode == 0:
                packs += 1
            else:
                first = (unpacked.stderr.strip().splitlines() or [f"rc={unpacked.returncode}"])[0][:120]
                refused.append((pack.name, f"unpack_objects_failed:{first}"))
            for sibling in pack_dir.glob(pack.stem + ".*"):
                sibling.unlink()
    return loose, packs, refused


def _ref_name_refusal(name: str, content: str) -> str | None:
    if not _ARIA_IMPL_BRANCH_RE.match(name):
        return "not_an_aria_implementation_branch"
    if not content:
        return "empty_ref_file"
    if not _OBJECT_ID_RE.match(content):
        return "not_an_object_id"
    return None


def publish_quarantine(containment: GitContainment) -> QuarantinePublication:
    """Move what the agent committed inside the sandbox into the shared
    repository — outside the sandbox, with the kernel's authority and git's
    own checks — and publish its implementation branch: the ONE branch the
    kernel seeded (``seeded_refs``), when the agent advanced it. Every other
    quarantine ref is discarded by name. Idempotent: a quarantine already
    published (or never used) publishes nothing.
    """
    replica = containment.sandbox_git_dir
    if not containment.commit_capable or replica is None or not replica.is_dir():
        return QuarantinePublication(0, 0, (), (), ())
    quarantine = replica / COMMON_DIR_OBJECTS
    store = containment.common_git_dir / COMMON_DIR_OBJECTS
    env = _publish_environment()
    # Every git call runs in the worktree (its real private git dir on the
    # host; the common dir is what `refs/heads` and the store resolve to),
    # never in the common dir's parent, which need not be a working tree.
    checkout = containment.workspace_root
    try:
        answered = _git(["rev-parse", "--show-object-format"], cwd=checkout, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        return QuarantinePublication(0, 0, (), (), (), refusal=f"git_unavailable:{type(exc).__name__}")
    object_format = _OBJECT_FORMATS.get(answered.stdout.strip())
    if answered.returncode != 0 or object_format is None:
        return QuarantinePublication(0, 0, (), (), (), refusal="object_format_unresolvable")
    try:
        loose, packs, objects_refused = _migrate_objects(
            quarantine, store, checkout=checkout, env=env, object_format=object_format,
        ) if quarantine.is_dir() else (0, 0, [])
    except (OSError, subprocess.SubprocessError) as exc:
        return QuarantinePublication(0, 0, (), (), (), refusal=f"quarantine_migration_failed:{type(exc).__name__}")
    published: list[str] = []
    discarded: list[tuple[str, str]] = []
    heads = replica / "refs" / "heads"
    shared_heads = containment.common_git_dir / "refs" / "heads"
    # The mountpoints bwrap made in the quarantine for the read-only overlays
    # of existing loose refs: empty files under those names, not the agent's.
    placeholders = {loose.relative_to(shared_heads).as_posix() for loose in containment.loose_refs}
    seeded_names = {name for name, _seed in containment.seeded_refs}
    ref_files = sorted(path for path in heads.rglob("*") if path.is_file()) if heads.is_dir() else []
    try:
        for ref_file in ref_files:
            name = ref_file.relative_to(heads).as_posix()
            content = ref_file.read_text(encoding="utf-8", errors="replace").strip()
            if not content and name in placeholders:
                ref_file.unlink()
                continue
            refusal = _ref_name_refusal(name, content)
            if refusal is None and name not in seeded_names:
                # (round 3) only a branch the KERNEL seeded is published: the
                # agent has no admitted way to make another (`git branch
                # <name>`, `git switch -c`, `update-ref` are all refused),
                # and a second `aria-impl-*` ref would land in the shared
                # repository under ANOTHER request's name and make that
                # request collide before its first turn.
                refusal = "not_the_seeded_branch"
            if refusal is None and (name, content) in containment.seeded_refs:
                # The kernel's own seed (`stand_on_implementation_branch`),
                # never advanced by a commit inside: publishing it would
                # turn a failed spawn into a branch the retry collides with.
                refusal = "branch_unadvanced"
            if refusal is None:
                # git refuses a ref to an object the store does not hold —
                # a refused object cannot be published by naming it — and
                # `^{commit}` refuses a branch that would point at anything
                # but a commit.
                updated = _git(["update-ref", "-m", "aria: published from the request sandbox",
                                f"refs/heads/{name}", f"{content}^{{commit}}"], cwd=checkout, env=env)
                if updated.returncode != 0:
                    refusal = f"update_ref_failed:{(updated.stderr.strip().splitlines() or ['?'])[0][:120]}"
            ref_file.unlink()
            if refusal is None:
                published.append(name)
            else:
                discarded.append((name, refusal))
        head_adopted = _adopt_head(containment, replica, published, env=env)
    except (OSError, subprocess.SubprocessError) as exc:
        return QuarantinePublication(loose, packs, tuple(objects_refused), tuple(published), tuple(discarded),
                                     refusal=f"quarantine_publication_failed:{type(exc).__name__}")
    return QuarantinePublication(loose, packs, tuple(objects_refused), tuple(published), tuple(discarded),
                                 head_adopted=head_adopted)


def _adopt_head(containment: GitContainment, replica: Path, published: list[str], *, env: dict[str, str]) -> str | None:
    """Point the host worktree's HEAD at the branch the agent switched to in
    the replica, when that branch was published, and bring the index to it
    (the working tree already carries the agent's files): the kernel-made
    branch the agent committed on inside (ARIA-HIGH-124), adopted outside."""
    try:
        head = (replica / "HEAD").read_text(encoding="utf-8").strip()
    except OSError:
        return None
    prefix = "ref: refs/heads/"
    if not head.startswith(prefix):
        return None
    name = head[len(prefix):]
    if name not in published:
        return None
    workspace = containment.workspace_root
    pointed = _git(["symbolic-ref", "HEAD", f"refs/heads/{name}"], cwd=workspace, env=env)
    if pointed.returncode != 0:
        return None
    _git(["reset", "-q", "--mixed"], cwd=workspace, env=env)
    return name


__all__ = [
    "COMMON_DIR_OBJECTS",
    "KERNEL_GIT_NO_HOOKS_ARGS",
    "QUARANTINE_PUBLICATION_WORST_CASE_SECONDS",
    "COMMON_DIR_QUARANTINED_REF_DIRS",
    "COMMON_DIR_UNSHARED_ENTRIES",
    "COMMON_DIR_WORKTREES",
    "GIT_OBJECT_DIRECTORY_ENV",
    "GitContainment",
    "GitContainmentRefusal",
    "LOOSE_REF_OVERLAY_BOUND",
    "PRIVATE_GIT_DIR_CONTROL_ENTRIES",
    "QuarantinePublication",
    "SANDBOX_GIT_DIR_NAME",
    "SANDBOX_SIGNING_AGENT_SOCKET",
    "SSH_AUTH_SOCK_ENV",
    "SandboxSigning",
    "derive_git_containment",
    "publish_quarantine",
    "stand_on_implementation_branch",
]
