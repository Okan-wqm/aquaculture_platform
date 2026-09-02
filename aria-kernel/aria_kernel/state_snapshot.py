"""Wave 1 §2.2 — the state snapshot: ARIA's tree-level continuity root.

Every ledger the kernel writes carries a per-file hash chain, so any
single file's history is tamper-evident. What has never existed is a
root ABOVE the files: nothing said "these 137 surfaces, at these
hashes, are one coherent state". Without it, losing an entire surface —
or every surface at once, which is what a lost 30-day CI artifact does —
is indistinguishable from a fresh bootstrap. Each surviving file still
verifies perfectly; the tree just quietly has less in it.

``build_snapshot`` closes that gap: it walks ``state_manifest``, records
each present surface's identity, and folds the whole map into a single
``manifest_root``. Snapshots chain to their predecessor
(``prev_snapshot_id`` / ``prev_manifest_root``), so continuity is
checkable the same way row continuity already is — one link at a time,
with a hash that cannot be reproduced from a fresher, emptier tree.

WHAT BELONGS IN A SNAPSHOT IS THE MANIFEST'S ``state_class``, not a list
kept here. That column already says what each surface IS, and the
storage policy follows from it without a second inventory to maintain:

  * ``ledger`` / ``index`` / ``runtime_state`` → ``carried``: the bytes
    are the state; they belong wherever the store lives.
  * ``artifact`` → ``artifact_only``: run outputs and transcripts are
    bulky and re-derivable, so the snapshot pins their sha256 while the
    bytes ride the cache. Loss stays DETECTABLE without inflating the
    store — that is the whole point of pinning a hash you did not keep.
  * ``lock`` → excluded: a lock file is a runtime artefact of who is
    writing right now, never state to restore.

Signing is separate from building on purpose. ``build_snapshot`` is pure
and testable everywhere; ``sign_snapshot`` shells out to ``ssh-keygen``
(the same per-cycle ed25519 identity ``gh_token_factory.mint_signing_key``
already mints for commits) and REFUSES rather than degrades when that
binary is missing — an unsigned snapshot presented as signed would be
worse than no snapshot at all.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import os
import shutil
import stat
import subprocess
from dataclasses import dataclass, field
from fnmatch import fnmatchcase
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping

from .ledger import (
    LedgerIntegrityError,
    LedgerReadLimitError,
    canonical_json,
    verify_jsonl_chunks,
)
from .state_manifest import (
    MAX_SURFACE_PATH_COMPONENTS,
    StateSurface,
    iter_surfaces,
    normalize_surface_relative_path,
    surface_for_relative_path,
    surface_key_name,
    surface_path_matches,
    validate_state_surface_patterns,
)

SNAPSHOT_SCHEMA = "aria/state-snapshot/v1"
MAX_SNAPSHOT_JSON_BYTES = 4 * 1024 * 1024
SNAPSHOT_MAX_SURFACE_BLOB_BYTES = 128 * 1024 * 1024
SNAPSHOT_MAX_INPUT_BYTES = 1280 * 1024 * 1024
SNAPSHOT_MAX_LEDGER_LINE_BYTES = 1024 * 1024
SNAPSHOT_MAX_LEDGER_ROWS = 1_000_000
SNAPSHOT_MAX_SURFACE_ENTRIES = 10_000
SNAPSHOT_MAX_DISCOVERY_WORK = 100_000

# The signature namespace (`ssh-keygen -Y sign -n`). Namespacing is what
# stops a signature minted for one purpose from validating for another:
# a commit signature by the same cycle key must not verify as a state
# snapshot, and vice versa.
SIGNATURE_NAMESPACE = "aria-state-snapshot"

# Storage policy, derived from the manifest's own vocabulary. Declared as
# a mapping rather than an if-chain so an unclassified future
# ``StateClass`` is a KeyError at build time — a new class silently
# defaulting to "excluded" is exactly how a surface goes missing.
STORAGE_POLICY: dict[str, str] = {
    "ledger": "carried",
    "index": "carried",
    "runtime_state": "carried",
    "artifact": "artifact_only",
    "lock": "excluded",
}


class SnapshotError(RuntimeError):
    """Raised when a snapshot cannot be built, signed, or verified."""


def serialize_snapshot_json(manifest: Mapping[str, Any]) -> bytes:
    """Return the exact bounded canonical bytes used for snapshot storage."""

    payload = (canonical_json(manifest) + "\n").encode("utf-8")
    if len(payload) > MAX_SNAPSHOT_JSON_BYTES:
        raise SnapshotError("state_snapshot_json_too_large")
    return payload


class _SnapshotRootMissing(SnapshotError):
    """Internal control flow for an in-scope root with no bytes yet."""


@dataclass(frozen=True)
class SnapshotSignature:
    """A signed snapshot's on-disk trio: manifest, signature, public key."""

    manifest_path: Path
    signature_path: Path
    public_key_path: Path
    signer_fingerprint: str
    namespace: str = SIGNATURE_NAMESPACE


@dataclass
class _SnapshotDiscoveryBudget:
    """Aggregate metadata work performed while discovering one snapshot."""

    used: int = 0

    def charge(self) -> None:
        self.used += 1
        if self.used > SNAPSHOT_MAX_DISCOVERY_WORK:
            raise SnapshotError("snapshot_surface_discovery_budget_exceeded")


@dataclass(frozen=True)
class _SnapshotRootAnchor:
    path: Path
    descriptor: int | None
    identity: tuple[int, int, int] | None


_SnapshotStatIdentity = tuple[int, int, int, int, int]


@dataclass
class _SurfaceNamespaceCollector:
    """Full identities observed while projecting one declared surface."""

    leaves: dict[str, _SnapshotStatIdentity] = field(default_factory=dict)
    directories: dict[str, _SnapshotStatIdentity] = field(default_factory=dict)

    def record_leaf(self, relative: str, value: os.stat_result) -> None:
        self._record(self.leaves, relative, value)

    def record_directory(self, relative: str, value: os.stat_result) -> None:
        self._record(self.directories, relative, value)

    @staticmethod
    def _record(
        projection: dict[str, _SnapshotStatIdentity],
        relative: str,
        value: os.stat_result,
    ) -> None:
        identity = _stat_identity(value)
        previous = projection.get(relative)
        if previous is not None and previous != identity:
            raise SnapshotError(f"snapshot_surface_changed:{relative or '.'}")
        projection[relative] = identity


@dataclass(frozen=True)
class _SnapshotNamespaceProjection:
    """Canonical pass result compared byte-for-byte before publication."""

    leaves: tuple[tuple[str, str, str, _SnapshotStatIdentity], ...]
    directories: tuple[tuple[str, str, _SnapshotStatIdentity], ...]


_ROOT_FD_UNSET = object()


def build_snapshot(
    *,
    snapshot_id: str,
    cycle_id: str,
    lane: str,
    roots: dict[str, Path],
    parent_commit: str | None = None,
    previous: dict[str, Any] | None = None,
    grandfather_row_counts: dict[str, int] | None = None,
) -> dict[str, Any]:
    """Fold the present state of ``roots`` into one signed-able manifest.

    ``roots`` maps a manifest ``root_kind`` (``tools`` / ``workspace`` /
    ``repo``) to its base directory. Only the kinds supplied are walked,
    so a caller that owns one root does not have to invent the others —
    and the manifest records which kinds were in scope, so a later reader
    can tell "this root held nothing" from "this root was never looked
    at". Those two being indistinguishable is the same defect class the
    snapshot exists to remove, one level up.

    A declared surface with no file on disk is simply absent from
    ``surfaces``: surfaces are created lazily on first write, so absence
    is normal at any single point in time. Absence only becomes evidence
    of LOSS when compared against a predecessor that had it — which is
    why the manifest chains, and why the comparison lives in the
    continuity checker rather than here.
    """
    if not roots:
        raise SnapshotError("snapshot_roots_required: at least one root_kind must be given")
    unknown = sorted(set(roots) - {"tools", "workspace", "repo"})
    if unknown:
        raise SnapshotError(f"snapshot_root_kind_unknown: {unknown}")

    declared = tuple(iter_surfaces())
    try:
        validate_state_surface_patterns(declared)
    except ValueError as exc:
        reason = (
            "snapshot_surface_ambiguous"
            if "ambiguous" in str(exc)
            else "snapshot_surface_pattern_invalid"
        )
        raise SnapshotError(f"{reason}:{exc}") from exc

    with _snapshot_root_anchors(roots) as root_anchors:
        surfaces: dict[str, Any] = {}
        artifact_only: list[str] = []
        owners: dict[tuple[str, str], str] = {}
        total_size = 0
        entry_count = 0
        discovery_budget = _SnapshotDiscoveryBudget()
        first_projection = _snapshot_namespace_projection(
            declared=declared,
            roots=roots,
            root_anchors=root_anchors,
            discovery_budget=discovery_budget,
        )
        by_name = {surface.name: surface for surface in declared}
        for surface_name, root_kind, relative, expected_identity in (
            first_projection.leaves
        ):
            surface = by_name[surface_name]
            policy = _storage_policy(surface)
            root = Path(roots[root_kind])
            wildcard = "*" in surface.path_pattern
            name = f"{surface.name}:{relative}" if wildcard else surface.name
            entry = _surface_entry(
                surface,
                relative,
                root,
                root_fd=root_anchors[root_kind].descriptor,
                expected_identity=expected_identity,
                grandfather_prefix=(grandfather_row_counts or {}).get(name, 0),
            )
            entry_count += 1
            if entry_count > SNAPSHOT_MAX_SURFACE_ENTRIES:
                raise SnapshotError("snapshot_surface_entry_budget_exceeded")
            owner_key = (surface.root_kind, entry["path"])
            previous_owner = owners.get(owner_key)
            if previous_owner is not None and previous_owner != surface.name:
                raise SnapshotError(
                    f"snapshot_surface_ambiguous:{previous_owner}:{surface.name}:"
                    f"{entry['path']}",
                )
            owners[owner_key] = surface.name
            total_size += entry["size_bytes"]
            if total_size > SNAPSHOT_MAX_INPUT_BYTES:
                raise SnapshotError("snapshot_input_budget_exceeded")
            surfaces[name] = entry
            if policy == "artifact_only":
                artifact_only.append(name)

        _validate_snapshot_root_anchors(root_anchors)
        second_projection = _snapshot_namespace_projection(
            declared=declared,
            roots=roots,
            root_anchors=root_anchors,
            discovery_budget=discovery_budget,
        )
        if first_projection != second_projection:
            raise SnapshotError("snapshot_surface_changed:namespace_projection")
        _revalidate_snapshot_directories(
            second_projection,
            root_anchors=root_anchors,
            discovery_budget=discovery_budget,
        )

        manifest: dict[str, Any] = {
            "$schema": SNAPSHOT_SCHEMA,
            "schema_version": 1,
            "snapshot_id": snapshot_id,
            "cycle_id": cycle_id,
            "lane": lane,
            "parent_commit": parent_commit,
            "root_kinds": sorted(roots),
            "surfaces": surfaces,
            "artifact_only_surfaces": sorted(artifact_only),
            "prev_snapshot_id": (previous or {}).get("snapshot_id"),
            "prev_manifest_root": (previous or {}).get("manifest_root"),
        }
        manifest["manifest_root"] = compute_manifest_root(manifest)
        validate_snapshot_manifest(
            manifest,
            expected_root_kinds=sorted(roots),
            surfaces=declared,
        )
        serialize_snapshot_json(manifest)
    return manifest


def compute_manifest_root(manifest: dict[str, Any]) -> str:
    """The tree-level continuity root: sha256 over the canonical manifest.

    Computed over every field EXCEPT ``manifest_root`` itself and the
    signature block, so the value is reproducible from the manifest a
    reader is holding. The predecessor links are inside the hashed
    payload deliberately — that is what makes the chain a chain: a
    snapshot rewritten to point at a different parent gets a different
    root, so a forged "continuous" history cannot be assembled from
    genuine snapshots.
    """
    payload = {k: v for k, v in manifest.items() if k not in {"manifest_root", "signature"}}
    return "sha256:" + hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


def verify_manifest_root(manifest: dict[str, Any]) -> bool:
    """Whether the manifest's recorded root matches its content."""
    recorded = manifest.get("manifest_root")
    return isinstance(recorded, str) and recorded == compute_manifest_root(manifest)


def validate_snapshot_manifest(
    manifest: Mapping[str, Any],
    *,
    expected_root_kinds: Iterable[str] | None = None,
    surfaces: Iterable[StateSurface] | None = None,
) -> None:
    """Validate the exact typed contract emitted by ``build_snapshot``."""
    expected_keys = {
        "$schema",
        "schema_version",
        "snapshot_id",
        "cycle_id",
        "lane",
        "parent_commit",
        "root_kinds",
        "surfaces",
        "artifact_only_surfaces",
        "prev_snapshot_id",
        "prev_manifest_root",
        "manifest_root",
    }
    try:
        if not isinstance(manifest, dict) or set(manifest) != expected_keys:
            raise ValueError("top_level_keys")
        schema_version = manifest["schema_version"]
        if (
            manifest["$schema"] != SNAPSHOT_SCHEMA
            or not isinstance(schema_version, int)
            or isinstance(schema_version, bool)
            or schema_version != 1
        ):
            raise ValueError("schema")
        for field in ("snapshot_id", "cycle_id", "lane"):
            if not isinstance(manifest[field], str) or not manifest[field]:
                raise ValueError(f"field_type:{field}")
        for field in ("parent_commit", "prev_snapshot_id", "prev_manifest_root"):
            if manifest[field] is not None and not isinstance(manifest[field], str):
                raise ValueError(f"field_type:{field}")

        root_kinds = manifest["root_kinds"]
        if (
            not isinstance(root_kinds, list)
            or not all(isinstance(root, str) for root in root_kinds)
            or root_kinds != sorted(set(root_kinds))
            or not set(root_kinds).issubset({"repo", "tools", "workspace"})
        ):
            raise ValueError("root_kinds")
        if (
            expected_root_kinds is not None
            and root_kinds != sorted(expected_root_kinds)
        ):
            raise ValueError("root_kinds")

        claims = manifest["surfaces"]
        artifacts = manifest["artifact_only_surfaces"]
        if not isinstance(claims, dict) or not isinstance(artifacts, list):
            raise ValueError("projection_type")
        if len(claims) > SNAPSHOT_MAX_SURFACE_ENTRIES:
            raise ValueError("surface_claim_budget_exceeded")
        if len(artifacts) > SNAPSHOT_MAX_SURFACE_ENTRIES:
            raise ValueError("artifact_projection_budget_exceeded")
        if (
            not all(isinstance(item, str) for item in artifacts)
            or artifacts != sorted(set(artifacts))
        ):
            raise ValueError("artifact_projection")

        declared = tuple(iter_surfaces() if surfaces is None else surfaces)
        validate_state_surface_patterns(declared)
        by_name = {surface.name: surface for surface in declared}
        expected_artifacts: list[str] = []
        claimed_paths: set[tuple[str, str]] = set()
        for key, claim in claims.items():
            if not isinstance(key, str) or not isinstance(claim, dict):
                raise ValueError("surface_claim_type")
            surface = by_name.get(surface_key_name(key))
            if surface is None:
                raise ValueError("surface_unknown")
            policy = _storage_policy(surface)
            if policy == "excluded":
                raise ValueError("surface_excluded")
            expected_claim_keys = {
                "path",
                "root_kind",
                "state_class",
                "storage",
                "sha256",
                "size_bytes",
                "segments",
            }
            if surface.state_class == "ledger":
                expected_claim_keys.update({
                    "chain_valid",
                    "row_count",
                    "tail_ledger_hash",
                })
            if set(claim) != expected_claim_keys:
                raise ValueError("surface_claim_keys")
            relative = claim["path"]
            if not isinstance(relative, str):
                raise ValueError("surface_path_type")
            if normalize_surface_relative_path(relative) != relative:
                raise ValueError("surface_path_normalization")
            owner = surface_for_relative_path(
                relative,
                root_kind=surface.root_kind,
                surfaces=declared,
            )
            if owner is None or owner.name != surface.name:
                raise ValueError("surface_owner")
            wildcard = "*" in surface.path_pattern
            expected_key = f"{surface.name}:{relative}" if wildcard else surface.name
            size = claim["size_bytes"]
            claimed_hash = claim["sha256"]
            if (
                key != expected_key
                or claim["root_kind"] != surface.root_kind
                or surface.root_kind not in root_kinds
                or claim["state_class"] != surface.state_class
                or claim["storage"] != policy
                or claim["segments"] != [relative]
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
                or not isinstance(claimed_hash, str)
                or len(claimed_hash) != 64
                or any(character not in "0123456789abcdef" for character in claimed_hash)
                or not surface_path_matches(relative, surface.path_pattern)
            ):
                raise ValueError("surface_claim_value")
            owner_key = (surface.root_kind, relative)
            if owner_key in claimed_paths:
                raise ValueError("surface_claim_duplicate")
            claimed_paths.add(owner_key)

            if surface.state_class == "ledger":
                row_count = claim["row_count"]
                tail = claim["tail_ledger_hash"]
                if (
                    claim["chain_valid"] is not True
                    or not isinstance(row_count, int)
                    or isinstance(row_count, bool)
                    or row_count < 0
                    or (
                        row_count == 0
                        and tail is not None
                    )
                    or (
                        row_count > 0
                        and (
                            not isinstance(tail, str)
                            or len(tail) != 71
                            or not tail.startswith("sha256:")
                            or any(
                                character not in "0123456789abcdef"
                                for character in tail[7:]
                            )
                        )
                    )
                ):
                    raise ValueError("ledger_claim_type")
            if policy == "artifact_only":
                expected_artifacts.append(key)
        if artifacts != sorted(expected_artifacts):
            raise ValueError("artifact_projection")
        if not verify_manifest_root(dict(manifest)):
            raise ValueError("manifest_root")
    except (KeyError, RecursionError, TypeError, ValueError) as exc:
        raise SnapshotError(f"snapshot_manifest_invalid:{exc}") from exc


def sign_snapshot(
    manifest: dict[str, Any],
    *,
    out_dir: Path,
    private_key_path: Path,
    public_key_path: Path,
    signer_fingerprint: str,
) -> SnapshotSignature:
    """Write ``snapshot.json`` + ``.sig`` and copy the signer's pubkey.

    The public key travels WITH the snapshot (``keys/<cycle_id>.pub`` in
    the store layout) because a verifier that has to fetch the key from
    the same place it fetches the claim gains nothing; the audit value
    comes from cross-checking that key against the fingerprint recorded
    in the cycle's independent governance trail.

    Refuses when ``ssh-keygen`` is absent instead of writing an unsigned
    manifest: a caller that cannot tell "signed" from "we skipped it"
    would publish the second while believing the first.
    """
    if shutil.which("ssh-keygen") is None:
        raise SnapshotError(
            "snapshot_signing_unavailable: ssh-keygen not on PATH; refusing to "
            "emit an unsigned snapshot"
        )
    if not private_key_path.exists():
        raise SnapshotError(f"snapshot_signing_key_missing: {private_key_path.as_posix()}")
    if not verify_manifest_root(manifest):
        raise SnapshotError("snapshot_manifest_root_mismatch: refusing to sign a stale root")

    manifest_bytes = serialize_snapshot_json(manifest)
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "snapshot.json"
    manifest_path.write_bytes(manifest_bytes)

    # Re-signing the same store is the NORMAL case — every publish writes a
    # new snapshot where the last one sat. ``ssh-keygen -Y sign`` refuses to
    # clobber an existing ``.sig`` and asks interactively, so without this
    # the publish either blocks on a prompt forever or (with no tty) leaves
    # the PREVIOUS signature next to the new manifest: an attestation of a
    # state that is no longer there. Removing the stale signature first and
    # denying the process a stdin makes both outcomes unreachable. The key
    # factory learned the same lesson (`gh_token_factory.mint_signing_key`).
    signature_path = manifest_path.with_suffix(".json.sig")
    signature_path.unlink(missing_ok=True)

    try:
        proc = subprocess.run(
            [
                "ssh-keygen", "-Y", "sign",
                "-f", str(private_key_path),
                "-n", SIGNATURE_NAMESPACE,
                str(manifest_path),
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            check=False,
            # Bounded like the key factory's mint call: a signer that never
            # returns would wedge the publishing cycle indefinitely, and a
            # cycle that cannot end also cannot be recovered by a watchdog
            # that is waiting for that cycle to report.
            timeout=15,
        )
    except subprocess.TimeoutExpired as exc:
        raise SnapshotError("snapshot_signing_timeout: ssh-keygen did not return") from exc
    if proc.returncode != 0:
        raise SnapshotError(f"snapshot_signing_failed: {proc.stderr.strip()[:200]}")

    if not signature_path.exists():
        raise SnapshotError("snapshot_signature_absent: ssh-keygen reported success without a .sig")

    keys_dir = out_dir / "keys"
    keys_dir.mkdir(parents=True, exist_ok=True)
    carried_public = keys_dir / public_key_path.name
    carried_public.write_bytes(public_key_path.read_bytes())

    return SnapshotSignature(
        manifest_path=manifest_path,
        signature_path=signature_path,
        public_key_path=carried_public,
        signer_fingerprint=signer_fingerprint,
    )


def verify_snapshot_signature(
    *,
    manifest_path: Path,
    signature_path: Path,
    public_key_path: Path,
    trust_store: Path,
    identity: str = "aria-state",
) -> dict[str, Any]:
    """Verify a snapshot's signature AND that its root still matches.

    Both halves are one answer on purpose. A valid signature over a
    manifest whose ``manifest_root`` no longer matches its content proves
    only that someone signed something once; the pair is what says "this
    exact tree state was attested".

    The verifier's TRUST is the operator-pinned ``trust_store`` allowlist
    (``identity keytype blob [comment]`` lines), not the key that happens
    to travel with the snapshot: a snapshot carrying its own public key is
    a CLAIM, and honoring it lets anyone self-sign both the content and
    the root of trust. The presented key must match a pinned key blob or
    verification refuses; a missing/empty store refuses too — there is no
    verification without an anchor chosen outside the artifact.
    """
    if shutil.which("ssh-keygen") is None:
        raise SnapshotError(
            "snapshot_verification_unavailable: ssh-keygen not on PATH; a missing "
            "verifier is not a passing verification"
        )
    for path in (manifest_path, signature_path, public_key_path):
        if not path.exists():
            raise SnapshotError(f"snapshot_verify_input_missing: {path.as_posix()}")
    if not trust_store.exists() or not trust_store.read_text(encoding="utf-8").strip():
        raise SnapshotError(
            f"snapshot_trust_store_missing: {trust_store.as_posix()} — provision the "
            "operator-pinned allowlist; a snapshot's own carried key is not trust"
        )
    pinned = [
        line.split() for line in trust_store.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    presented_fields = public_key_path.read_text(encoding="utf-8").strip().split()
    if len(presented_fields) < 2:
        raise SnapshotError("snapshot_trust_presented_key_unparseable")
    matching = [
        fields for fields in pinned
        if len(fields) >= 3
        and fields[1] == presented_fields[0]
        and fields[2] == presented_fields[1]
    ]
    if not matching:
        raise SnapshotError(
            "snapshot_trust_key_not_pinned: the presented key is not in the "
            "operator trust store; a self-signed snapshot is a claim, not an "
            "attestation"
        )

    allowed_signers = signature_path.parent / "allowed_signers"
    pinned_identity = matching[0][0]
    allowed_signers.write_text(" ".join(matching[0]) + "\n", encoding="utf-8")

    try:
        proc = subprocess.run(
            [
                "ssh-keygen", "-Y", "verify",
                "-f", str(allowed_signers),
                "-I", pinned_identity,
                "-n", SIGNATURE_NAMESPACE,
                "-s", str(signature_path),
            ],
            input=manifest_path.read_bytes(),
            capture_output=True,
            check=False,
            timeout=15,
        )
    except subprocess.TimeoutExpired as exc:
        # A verifier that hangs must not read as a passing verification.
        raise SnapshotError("snapshot_verification_timeout: ssh-keygen did not return") from exc
    signature_valid = proc.returncode == 0
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    root_valid = verify_manifest_root(manifest)
    return {
        "valid": signature_valid and root_valid,
        "signature_valid": signature_valid,
        "manifest_root_valid": root_valid,
        "manifest_root": manifest.get("manifest_root"),
        "snapshot_id": manifest.get("snapshot_id"),
        "detail": proc.stderr.decode("utf-8", errors="replace").strip()[:200] or None,
    }


def snapshots_are_linked(current: dict[str, Any], previous: dict[str, Any]) -> bool:
    """Does ``current`` name ``previous`` as its parent, by BOTH id and root?

    Extracted so there is one definition of descent. `snapshot_continuity`
    needs it, and so does the continuity gate when its reference is a
    committed daily anchor — an anchor carries `manifest_root` and no surface
    map, so it cannot go through `snapshot_continuity` at all. Two callers
    computing the same comparison inline is how one of them ends up checking
    only the id, which a re-pointed snapshot would satisfy.
    """
    return (
        current.get("prev_snapshot_id") == previous.get("snapshot_id")
        and current.get("prev_manifest_root") == previous.get("manifest_root")
    )


def snapshot_continuity(
    current: dict[str, Any],
    previous: dict[str, Any] | None,
) -> dict[str, Any]:
    """Compare two snapshots and name what changed — including what left.

    ``lost_surfaces`` is the field this whole module exists to produce: a
    surface the predecessor carried and the successor does not. Every
    file that remains still verifies, so no per-file check can see this;
    only the tree-level comparison can.
    """
    if previous is None:
        return {
            "status": "genesis",
            "linked": False,
            "lost_surfaces": [],
            "new_surfaces": sorted(current.get("surfaces") or {}),
            "changed_surfaces": [],
        }
    prev_surfaces = previous.get("surfaces") or {}
    cur_surfaces = current.get("surfaces") or {}
    linked = snapshots_are_linked(current, previous)
    lost = sorted(set(prev_surfaces) - set(cur_surfaces))
    changed = sorted(
        name for name in set(prev_surfaces) & set(cur_surfaces)
        if prev_surfaces[name].get("sha256") != cur_surfaces[name].get("sha256")
    )
    if not linked:
        status = "chain_broken"
    elif lost:
        status = "surfaces_lost"
    else:
        status = "ok"
    return {
        "status": status,
        "linked": linked,
        "lost_surfaces": lost,
        "new_surfaces": sorted(set(cur_surfaces) - set(prev_surfaces)),
        "changed_surfaces": changed,
    }


def _storage_policy(surface: StateSurface) -> str:
    try:
        return STORAGE_POLICY[surface.state_class]
    except KeyError as exc:  # pragma: no cover - guarded by the manifest's Literal
        raise SnapshotError(
            f"snapshot_storage_policy_undeclared: state_class={surface.state_class!r} "
            f"(surface {surface.name!r}); classify it in STORAGE_POLICY rather than "
            f"letting it fall out of the snapshot silently"
        ) from exc


def _snapshot_namespace_projection(
    *,
    declared: tuple[StateSurface, ...],
    roots: Mapping[str, Path],
    root_anchors: Mapping[str, _SnapshotRootAnchor],
    discovery_budget: _SnapshotDiscoveryBudget,
) -> _SnapshotNamespaceProjection:
    """Project every in-scope path and identity without reading file bytes."""
    leaves: dict[
        tuple[str, str, str],
        _SnapshotStatIdentity,
    ] = {}
    directories: dict[
        tuple[str, str],
        _SnapshotStatIdentity,
    ] = {}
    for surface in declared:
        if surface.root_kind not in roots or _storage_policy(surface) == "excluded":
            continue
        root_fd = root_anchors[surface.root_kind].descriptor
        if root_fd is None:
            continue
        collector = _SurfaceNamespaceCollector()
        matches = _secure_surface_matches(
            surface,
            root_fd,
            discovery_budget=discovery_budget,
            projection=collector,
        )
        for relative, identity in collector.directories.items():
            key = (surface.root_kind, relative)
            previous = directories.get(key)
            if previous is not None and previous != identity:
                raise SnapshotError(
                    f"snapshot_surface_changed:{surface.root_kind}:{relative or '.'}",
                )
            directories[key] = identity
        for relative in matches:
            try:
                owner = surface_for_relative_path(
                    relative,
                    root_kind=surface.root_kind,
                    surfaces=declared,
                )
            except ValueError as exc:
                raise SnapshotError(
                    f"snapshot_surface_ambiguous:{relative}",
                ) from exc
            if owner is None:
                raise SnapshotError(f"snapshot_surface_owner_missing:{relative}")
            if owner.name != surface.name:
                continue
            try:
                identity = collector.leaves[relative]
            except KeyError as exc:  # pragma: no cover - internal projection invariant
                raise SnapshotError(
                    f"snapshot_surface_projection_incomplete:{relative}",
                ) from exc
            key = (surface.name, surface.root_kind, relative)
            previous = leaves.get(key)
            if previous is not None and previous != identity:
                raise SnapshotError(f"snapshot_surface_changed:{relative}")
            leaves[key] = identity
            if len(leaves) > SNAPSHOT_MAX_SURFACE_ENTRIES:
                raise SnapshotError("snapshot_surface_entry_budget_exceeded")

    return _SnapshotNamespaceProjection(
        leaves=tuple(
            (*key, identity)
            for key, identity in sorted(leaves.items())
        ),
        directories=tuple(
            (*key, identity)
            for key, identity in sorted(directories.items())
        ),
    )


def _revalidate_snapshot_directories(
    projection: _SnapshotNamespaceProjection,
    *,
    root_anchors: Mapping[str, _SnapshotRootAnchor],
    discovery_budget: _SnapshotDiscoveryBudget,
) -> None:
    """DFS over P2's directory trie while retaining ancestry descriptors only."""
    expected = {
        (root_kind, relative): identity
        for root_kind, relative, identity in projection.directories
    }
    children: dict[
        tuple[str, str],
        list[tuple[str, str, _SnapshotStatIdentity]],
    ] = {}
    for (root_kind, relative), identity in expected.items():
        if not relative:
            continue
        parent_relative, _, name = relative.rpartition("/")
        if (root_kind, parent_relative) not in expected:
            raise SnapshotError(
                f"snapshot_surface_changed:{root_kind}:{relative}",
            )
        children.setdefault((root_kind, parent_relative), []).append(
            (name, relative, identity),
        )

    mutation_errnos = {errno.ENOENT, errno.ENOTDIR, errno.ELOOP}

    def raise_os_error(
        root_kind: str,
        relative: str,
        error: OSError,
    ) -> None:
        label = f"{root_kind}:{relative or '.'}"
        if error.errno in mutation_errnos:
            raise SnapshotError(f"snapshot_surface_changed:{label}") from error
        raise SnapshotError(
            f"snapshot_surface_revalidation_unavailable:{label}:"
            f"errno={error.errno}",
        ) from error

    def validate_root(
        root_kind: str,
        identity: _SnapshotStatIdentity,
    ) -> int:
        discovery_budget.charge()
        anchor = root_anchors[root_kind]
        if anchor.descriptor is None:
            raise SnapshotError(f"snapshot_surface_changed:{root_kind}:.")
        try:
            descriptor_state = os.fstat(anchor.descriptor)
            path_state = os.stat(anchor.path, follow_symlinks=False)
        except OSError as exc:
            raise_os_error(root_kind, "", exc)
        if (
            not stat.S_ISDIR(descriptor_state.st_mode)
            or not stat.S_ISDIR(path_state.st_mode)
            or _stat_identity(descriptor_state) != identity
            or _stat_identity(path_state) != identity
        ):
            raise SnapshotError(f"snapshot_surface_changed:{root_kind}:.")
        return anchor.descriptor

    def lstat_for_revalidation(
        parent_fd: int,
        *,
        root_kind: str,
        name: str,
        relative: str,
    ) -> os.stat_result | None:
        try:
            return _lstat_child(
                parent_fd,
                name,
                surface_name=relative,
                discovery_budget=discovery_budget,
            )
        except SnapshotError as exc:
            cause = exc.__cause__
            if isinstance(cause, OSError):
                raise_os_error(root_kind, relative, cause)
            raise

    def visit(
        *,
        root_kind: str,
        parent_relative: str,
        parent_fd: int,
    ) -> None:
        for name, relative, identity in sorted(
            children.get((root_kind, parent_relative), ()),
        ):
            before = lstat_for_revalidation(
                parent_fd,
                root_kind=root_kind,
                name=name,
                relative=relative,
            )
            if (
                before is None
                or not stat.S_ISDIR(before.st_mode)
                or _stat_identity(before) != identity
            ):
                raise SnapshotError(
                    f"snapshot_surface_changed:{root_kind}:{relative}",
                )
            try:
                with _open_child_directory(
                    parent_fd,
                    name,
                    before=before,
                    relative=relative,
                ) as descriptor:
                    visit(
                        root_kind=root_kind,
                        parent_relative=relative,
                        parent_fd=descriptor,
                    )
                    current_path = lstat_for_revalidation(
                        parent_fd,
                        root_kind=root_kind,
                        name=name,
                        relative=relative,
                    )
                    try:
                        descriptor_state = os.fstat(descriptor)
                    except OSError as error:
                        raise_os_error(root_kind, relative, error)
                    if (
                        current_path is None
                        or not stat.S_ISDIR(current_path.st_mode)
                        or not stat.S_ISDIR(descriptor_state.st_mode)
                        or _stat_identity(current_path) != identity
                        or _stat_identity(descriptor_state) != identity
                    ):
                        raise SnapshotError(
                            f"snapshot_surface_changed:{root_kind}:{relative}",
                        )
            except SnapshotError as exc:
                cause = exc.__cause__
                if isinstance(cause, OSError):
                    raise_os_error(root_kind, relative, cause)
                if str(exc).startswith((
                    "snapshot_nofollow_unavailable",
                    "snapshot_surface_changed:",
                    "snapshot_surface_discovery_budget_exceeded",
                    "snapshot_surface_revalidation_unavailable:",
                )):
                    raise
                raise SnapshotError(
                    f"snapshot_surface_changed:{root_kind}:{relative}",
                ) from exc

    roots = sorted(
        (root_kind, identity)
        for (root_kind, relative), identity in expected.items()
        if not relative
    )
    for root_kind, identity in roots:
        root_fd = validate_root(root_kind, identity)
        visit(root_kind=root_kind, parent_relative="", parent_fd=root_fd)
        validate_root(root_kind, identity)


def _surface_entries(
    surface: StateSurface,
    root: Path,
    *,
    declared: tuple[StateSurface, ...] | None = None,
    discovery_budget: _SnapshotDiscoveryBudget | None = None,
    root_fd: int | None | object = _ROOT_FD_UNSET,
    grandfather_row_counts: dict[str, int] | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    """One entry per file backing the surface; glob surfaces fan out.

    Keys match the coverage projection used by ``covered_tool_ledgers``
    (``name`` for a fixed path, ``name:relative/path`` for each glob
    match), so the snapshot and the integrity verifier speak about
    surfaces with the same vocabulary.
    """
    if declared is None:
        declared = tuple(iter_surfaces())
    if discovery_budget is None:
        discovery_budget = _SnapshotDiscoveryBudget()
    if root_fd is _ROOT_FD_UNSET:
        try:
            with _open_snapshot_root(root) as opened_root_fd:
                return _surface_entries(
                    surface,
                    root,
                    declared=declared,
                    discovery_budget=discovery_budget,
                    root_fd=opened_root_fd,
                    grandfather_row_counts=grandfather_row_counts,
                )
        except _SnapshotRootMissing:
            return []
    if root_fd is None:
        return []
    if not isinstance(root_fd, int):  # pragma: no cover - internal sentinel guard
        raise SnapshotError("snapshot_root_descriptor_invalid")

    entries: list[tuple[str, dict[str, Any]]] = []
    wildcard = "*" in surface.path_pattern
    projection = _SurfaceNamespaceCollector()
    for relative in _secure_surface_matches(
        surface,
        root_fd,
        discovery_budget=discovery_budget,
        projection=projection,
    ):
        try:
            owner = surface_for_relative_path(
                relative,
                root_kind=surface.root_kind,
                surfaces=declared,
            )
        except ValueError as exc:
            raise SnapshotError(
                f"snapshot_surface_ambiguous:{relative}",
            ) from exc
        if owner is None:
            raise SnapshotError(f"snapshot_surface_owner_missing:{relative}")
        if owner.name != surface.name:
            continue
        key = f"{surface.name}:{relative}" if wildcard else surface.name
        entries.append((
            key,
            _surface_entry(
                surface,
                relative,
                root,
                root_fd=root_fd,
                grandfather_prefix=(grandfather_row_counts or {}).get(key, 0),
                expected_identity=projection.leaves[relative],
            ),
        ))
    return entries


def _normalize_snapshot_relative_path(relative: str) -> str:
    try:
        return normalize_surface_relative_path(relative)
    except ValueError as exc:
        raise SnapshotError(f"snapshot_surface_path_invalid:{exc}") from exc


def _require_nofollow_dirfd_support() -> None:
    supports_dir_fd = getattr(os, "supports_dir_fd", set())
    supports_follow = getattr(os, "supports_follow_symlinks", set())
    if (
        not hasattr(os, "O_NOFOLLOW")
        or not hasattr(os, "O_DIRECTORY")
        or os.open not in supports_dir_fd
        or os.stat not in supports_dir_fd
        or os.stat not in supports_follow
    ):
        raise SnapshotError("snapshot_nofollow_unavailable")


def _directory_open_flags() -> int:
    _require_nofollow_dirfd_support()
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    flags |= int(getattr(os, "O_CLOEXEC", 0))
    return flags


def _stat_identity(value: os.stat_result) -> tuple[int, int, int, int, int]:
    return (
        value.st_dev,
        value.st_ino,
        value.st_mode,
        value.st_mtime_ns,
        value.st_ctime_ns,
    )


def _root_identity(value: os.stat_result) -> tuple[int, int, int]:
    return (value.st_dev, value.st_ino, value.st_mode)


@contextlib.contextmanager
def _open_snapshot_root(root: Path) -> Iterator[int]:
    try:
        descriptor = os.open(root, _directory_open_flags())
    except FileNotFoundError as exc:
        raise _SnapshotRootMissing(
            f"snapshot_root_missing:{root.as_posix()}",
        ) from exc
    except SnapshotError:
        raise
    except OSError as exc:
        raise SnapshotError(f"snapshot_root_unavailable:{root.as_posix()}") from exc
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISDIR(opened.st_mode):
            raise SnapshotError(f"snapshot_root_not_directory:{root.as_posix()}")
        yield descriptor
    finally:
        os.close(descriptor)


@contextlib.contextmanager
def _snapshot_root_anchors(
    roots: Mapping[str, Path],
) -> Iterator[dict[str, _SnapshotRootAnchor]]:
    """Hold every supplied root inode stable for one complete snapshot."""
    with contextlib.ExitStack() as stack:
        anchors: dict[str, _SnapshotRootAnchor] = {}
        for root_kind in sorted(roots):
            path = Path(roots[root_kind])
            try:
                descriptor = stack.enter_context(_open_snapshot_root(path))
            except _SnapshotRootMissing:
                anchors[root_kind] = _SnapshotRootAnchor(path, None, None)
                continue
            anchors[root_kind] = _SnapshotRootAnchor(
                path,
                descriptor,
                _root_identity(os.fstat(descriptor)),
            )

        yield anchors

        _validate_snapshot_root_anchors(anchors)



def _validate_snapshot_root_anchors(
    anchors: Mapping[str, _SnapshotRootAnchor],
) -> None:
    """Preserve the root-path error contract before namespace comparison."""
    for root_kind, anchor in anchors.items():
        if anchor.descriptor is None:
            try:
                os.stat(anchor.path, follow_symlinks=False)
            except FileNotFoundError:
                continue
            except OSError as exc:
                raise SnapshotError(
                    f"snapshot_root_changed:{root_kind}",
                ) from exc
            raise SnapshotError(f"snapshot_root_changed:{root_kind}")

        try:
            anchored = os.fstat(anchor.descriptor)
            current_path = os.stat(anchor.path, follow_symlinks=False)
        except OSError as exc:
            raise SnapshotError(f"snapshot_root_changed:{root_kind}") from exc
        if (
            anchor.identity is None
            or not stat.S_ISDIR(anchored.st_mode)
            or not stat.S_ISDIR(current_path.st_mode)
            or _root_identity(anchored) != anchor.identity
            or _root_identity(current_path) != anchor.identity
        ):
            raise SnapshotError(f"snapshot_root_changed:{root_kind}")


def _lstat_child(
    parent_fd: int,
    name: str,
    *,
    surface_name: str,
    discovery_budget: _SnapshotDiscoveryBudget | None = None,
) -> os.stat_result | None:
    if discovery_budget is not None:
        discovery_budget.charge()
    try:
        return os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise SnapshotError(
            f"snapshot_surface_enumeration_unavailable:{surface_name}",
        ) from exc


@contextlib.contextmanager
def _open_child_directory(
    parent_fd: int,
    name: str,
    *,
    before: os.stat_result,
    relative: str,
) -> Iterator[int]:
    if not stat.S_ISDIR(before.st_mode):
        raise SnapshotError(
            f"snapshot_surface_ancestry_not_directory:{relative}",
        )
    try:
        descriptor = os.open(name, _directory_open_flags(), dir_fd=parent_fd)
    except SnapshotError:
        raise
    except OSError as exc:
        raise SnapshotError(f"snapshot_surface_changed:{relative}") from exc
    try:
        opened = os.fstat(descriptor)
        if (
            not stat.S_ISDIR(opened.st_mode)
            or _stat_identity(opened) != _stat_identity(before)
        ):
            raise SnapshotError(f"snapshot_surface_changed:{relative}")
        yield descriptor
    finally:
        os.close(descriptor)


def _entry_lstat(entry: Any, *, surface_name: str) -> os.stat_result:
    try:
        return entry.stat(follow_symlinks=False)
    except OSError as exc:
        raise SnapshotError(
            f"snapshot_surface_enumeration_unavailable:{surface_name}",
        ) from exc


def _scan_snapshot_directory(
    directory_fd: int,
    *,
    surface_name: str,
    discovery_budget: _SnapshotDiscoveryBudget,
) -> Iterator[Any]:
    try:
        with os.scandir(directory_fd) as scanner:
            for entry in scanner:
                discovery_budget.charge()
                yield entry
    except SnapshotError:
        raise
    except (OSError, TypeError, NotImplementedError) as exc:
        raise SnapshotError(
            f"snapshot_surface_enumeration_unavailable:{surface_name}",
        ) from exc


def _secure_surface_matches(
    surface: StateSurface,
    root_fd: int,
    *,
    discovery_budget: _SnapshotDiscoveryBudget,
    projection: _SurfaceNamespaceCollector | None = None,
) -> list[str]:
    """Discover one surface without following or enumerating symlink trees."""
    if projection is None:
        projection = _SurfaceNamespaceCollector()
    pattern_parts = tuple(surface.path_pattern.split("/"))
    matches: set[str] = set()

    def checked_relative(parts: tuple[str, ...]) -> str:
        relative = _normalize_snapshot_relative_path("/".join(parts))
        if len(parts) > MAX_SURFACE_PATH_COMPONENTS:
            # Kept explicit even though the shared normalizer enforces it:
            # directory traversal must stop before recursion can grow.
            raise SnapshotError(
                "snapshot_surface_path_invalid:surface_path_too_deep",
            )
        return relative

    def record(parts: tuple[str, ...], value: os.stat_result) -> None:
        relative = checked_relative(parts)
        matches.add(relative)
        projection.record_leaf(relative, value)
        if len(matches) > SNAPSHOT_MAX_SURFACE_ENTRIES:
            raise SnapshotError("snapshot_surface_entry_budget_exceeded")

    def visit(
        directory_fd: int,
        prefix: tuple[str, ...],
        pattern_index: int,
    ) -> None:
        discovery_budget.charge()
        try:
            directory_state = os.fstat(directory_fd)
        except OSError as exc:
            raise SnapshotError(
                f"snapshot_surface_enumeration_unavailable:{surface.name}",
            ) from exc
        if not stat.S_ISDIR(directory_state.st_mode):
            raise SnapshotError(
                f"snapshot_surface_ancestry_not_directory:{'/'.join(prefix) or '.'}",
            )
        projection.record_directory("/".join(prefix), directory_state)
        component = pattern_parts[pattern_index]
        is_final = pattern_index == len(pattern_parts) - 1

        if component == "**":
            if is_final:
                raise SnapshotError(
                    f"snapshot_surface_pattern_invalid:{surface.name}",
                )
            visit(directory_fd, prefix, pattern_index + 1)
            for entry in _scan_snapshot_directory(
                directory_fd,
                surface_name=surface.name,
                discovery_budget=discovery_budget,
            ):
                before = _entry_lstat(entry, surface_name=surface.name)
                relative_parts = (*prefix, entry.name)
                relative = checked_relative(relative_parts)
                if stat.S_ISLNK(before.st_mode):
                    raise SnapshotError(
                        f"snapshot_surface_ancestry_not_directory:{relative}",
                    )
                if not stat.S_ISDIR(before.st_mode):
                    continue
                with _open_child_directory(
                    directory_fd,
                    entry.name,
                    before=before,
                    relative=relative,
                ) as child_fd:
                    visit(child_fd, relative_parts, pattern_index)
            return

        if is_final:
            if "*" not in component:
                before = _lstat_child(
                    directory_fd,
                    component,
                    surface_name=surface.name,
                    discovery_budget=discovery_budget,
                )
                if before is not None:
                    record((*prefix, component), before)
                return
            for entry in _scan_snapshot_directory(
                directory_fd,
                surface_name=surface.name,
                discovery_budget=discovery_budget,
            ):
                if fnmatchcase(entry.name, component):
                    record(
                        (*prefix, entry.name),
                        _entry_lstat(entry, surface_name=surface.name),
                    )
            return

        if "*" not in component:
            before = _lstat_child(
                directory_fd,
                component,
                surface_name=surface.name,
                discovery_budget=discovery_budget,
            )
            if before is None:
                return
            relative_parts = (*prefix, component)
            relative = checked_relative(relative_parts)
            with _open_child_directory(
                directory_fd,
                component,
                before=before,
                relative=relative,
            ) as child_fd:
                visit(child_fd, relative_parts, pattern_index + 1)
            return

        for entry in _scan_snapshot_directory(
            directory_fd,
            surface_name=surface.name,
            discovery_budget=discovery_budget,
        ):
            if not fnmatchcase(entry.name, component):
                continue
            before = _entry_lstat(entry, surface_name=surface.name)
            relative_parts = (*prefix, entry.name)
            relative = checked_relative(relative_parts)
            if not stat.S_ISDIR(before.st_mode):
                raise SnapshotError(
                    f"snapshot_surface_ancestry_not_directory:{relative}",
                )
            with _open_child_directory(
                directory_fd,
                entry.name,
                before=before,
                relative=relative,
            ) as child_fd:
                visit(child_fd, relative_parts, pattern_index + 1)

    visit(root_fd, (), 0)
    return sorted(matches)


def _surface_entry(
    surface: StateSurface,
    relative: str,
    root: Path,
    *,
    root_fd: int | None = None,
    grandfather_prefix: int = 0,
    expected_identity: _SnapshotStatIdentity | None = None,
) -> dict[str, Any]:
    relative = _normalize_snapshot_relative_path(relative)
    path = root / relative
    with _bounded_regular_file_chunks(
        root,
        relative,
        root_fd=root_fd,
        expected_identity=expected_identity,
    ) as (size, chunks):
        if surface.state_class == "ledger":
            try:
                summary = verify_jsonl_chunks(
                    chunks,
                    source=path,
                    expected_size=size,
                    max_line_bytes=SNAPSHOT_MAX_LEDGER_LINE_BYTES,
                    max_rows=SNAPSHOT_MAX_LEDGER_ROWS,
                    grandfather_line_prefixes=grandfather_prefix,
                    expected_surface=surface.name,
                    expected_surface_instance=relative,
                )
            except LedgerReadLimitError as exc:
                reason = (
                    "snapshot_surface_line_too_large"
                    if "line_too_large" in str(exc)
                    else "snapshot_surface_row_limit_exceeded"
                )
                raise SnapshotError(f"{reason}:{relative}") from exc
            except LedgerIntegrityError as exc:
                raise SnapshotError(f"snapshot_ledger_invalid:{relative}") from exc
            sha256 = summary["sha256"]
            ledger_state = {
                "chain_valid": True,
                "row_count": summary["row_count"],
                "tail_ledger_hash": summary["last_hash"],
            }
        else:
            digest = hashlib.sha256()
            observed = 0
            for chunk in chunks:
                observed += len(chunk)
                digest.update(chunk)
            if observed != size:
                raise SnapshotError(f"snapshot_surface_changed:{relative}")
            sha256 = digest.hexdigest()
            ledger_state = {}
    entry: dict[str, Any] = {
        "path": relative,
        "root_kind": surface.root_kind,
        "state_class": surface.state_class,
        "storage": _storage_policy(surface),
        "sha256": sha256,
        # Recorded because the walk is already here and the number is
        # otherwise unmeasured. PLAN §2.2b's replacement for `.seg-NNN`
        # rollover is a MEASURED archival trigger, and a trigger needs a
        # series to fire on; without this, "is any surface approaching a
        # size that matters" is a question nothing in ARIA can answer,
        # and the answer would arrive as a slow workflow rather than as
        # a number.
        "size_bytes": size,
        # ``segments`` carries every physical file backing this surface.
        # It is a list from the start — today always one entry — so the
        # rollover that splits a large ledger records itself here without
        # a schema change, and a reader written now stays correct then.
        "segments": [relative],
    }
    entry.update(ledger_state)
    return entry


@contextlib.contextmanager
def _bounded_regular_file_chunks(
    root: Path,
    relative: str,
    *,
    root_fd: int | None = None,
    max_bytes: int | None = None,
    expected_identity: _SnapshotStatIdentity | None = None,
) -> Iterator[tuple[int, Iterable[bytes]]]:
    """Read a bounded regular file through a no-follow root-to-leaf chain."""
    byte_limit = SNAPSHOT_MAX_SURFACE_BLOB_BYTES if max_bytes is None else max_bytes
    if byte_limit < 0:
        raise SnapshotError("snapshot_surface_byte_limit_invalid")
    relative = _normalize_snapshot_relative_path(relative)
    path = root / relative
    parts = tuple(relative.split("/"))
    with contextlib.ExitStack() as stack:
        if root_fd is None:
            try:
                parent_fd = stack.enter_context(_open_snapshot_root(root))
            except _SnapshotRootMissing as exc:
                raise SnapshotError(
                    f"snapshot_surface_unavailable:{path.as_posix()}",
                ) from exc
        else:
            parent_fd = root_fd
        prefix: tuple[str, ...] = ()
        for component in parts[:-1]:
            prefix = (*prefix, component)
            prefix_path = "/".join(prefix)
            before_directory = _lstat_child(
                parent_fd,
                component,
                surface_name=relative,
            )
            if before_directory is None:
                raise SnapshotError(f"snapshot_surface_unavailable:{path.as_posix()}")
            parent_fd = stack.enter_context(
                _open_child_directory(
                    parent_fd,
                    component,
                    before=before_directory,
                    relative=prefix_path,
                ),
            )

        before = _lstat_child(
            parent_fd,
            parts[-1],
            surface_name=relative,
        )
        if before is None:
            if expected_identity is not None:
                raise SnapshotError(f"snapshot_surface_changed:{path.as_posix()}")
            raise SnapshotError(f"snapshot_surface_unavailable:{path.as_posix()}")
        if not stat.S_ISREG(before.st_mode):
            raise SnapshotError(f"snapshot_surface_not_regular:{path.as_posix()}")
        if (
            expected_identity is not None
            and _stat_identity(before) != expected_identity
        ):
            raise SnapshotError(f"snapshot_surface_changed:{path.as_posix()}")
        if before.st_size > byte_limit:
            raise SnapshotError(f"snapshot_surface_too_large:{path.as_posix()}")
        flags = os.O_RDONLY | os.O_NOFOLLOW
        for option in ("O_CLOEXEC", "O_NONBLOCK"):
            flags |= int(getattr(os, option, 0))
        try:
            descriptor = os.open(parts[-1], flags, dir_fd=parent_fd)
        except OSError as exc:
            raise SnapshotError(f"snapshot_surface_unavailable:{path.as_posix()}") from exc
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or (
                    opened.st_dev,
                    opened.st_ino,
                    opened.st_mode,
                    opened.st_size,
                    opened.st_mtime_ns,
                    opened.st_ctime_ns,
                )
                != (
                    before.st_dev,
                    before.st_ino,
                    before.st_mode,
                    before.st_size,
                    before.st_mtime_ns,
                    before.st_ctime_ns,
                )
            ):
                raise SnapshotError(f"snapshot_surface_changed:{path.as_posix()}")

            def chunks() -> Iterator[bytes]:
                observed = 0
                while True:
                    try:
                        chunk = os.read(descriptor, 1024 * 1024)
                    except OSError as exc:
                        raise SnapshotError(
                            f"snapshot_surface_unavailable:{path.as_posix()}",
                        ) from exc
                    if not chunk:
                        break
                    observed += len(chunk)
                    if observed > before.st_size or observed > byte_limit:
                        raise SnapshotError(
                            f"snapshot_surface_changed:{path.as_posix()}",
                        )
                    yield chunk
                if observed != before.st_size:
                    raise SnapshotError(f"snapshot_surface_changed:{path.as_posix()}")

            yield before.st_size, chunks()
            try:
                after = os.fstat(descriptor)
            except OSError as exc:
                raise SnapshotError(
                    f"snapshot_surface_unavailable:{path.as_posix()}",
                ) from exc
            if (
                after.st_dev,
                after.st_ino,
                after.st_mode,
                after.st_size,
                after.st_mtime_ns,
                after.st_ctime_ns,
            ) != (
                opened.st_dev,
                opened.st_ino,
                opened.st_mode,
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_ctime_ns,
            ):
                raise SnapshotError(f"snapshot_surface_changed:{path.as_posix()}")
        finally:
            os.close(descriptor)
