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

import hashlib
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .ledger import LedgerIntegrityError, canonical_json, file_hash, load_jsonl_verified
from .state_manifest import StateSurface, iter_surfaces

SNAPSHOT_SCHEMA = "aria/state-snapshot/v1"

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


@dataclass(frozen=True)
class SnapshotSignature:
    """A signed snapshot's on-disk trio: manifest, signature, public key."""

    manifest_path: Path
    signature_path: Path
    public_key_path: Path
    signer_fingerprint: str
    namespace: str = SIGNATURE_NAMESPACE


def build_snapshot(
    *,
    snapshot_id: str,
    cycle_id: str,
    lane: str,
    roots: dict[str, Path],
    parent_commit: str | None = None,
    previous: dict[str, Any] | None = None,
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

    surfaces: dict[str, Any] = {}
    artifact_only: list[str] = []
    for surface in iter_surfaces():
        root = roots.get(surface.root_kind)
        if root is None:
            continue
        policy = _storage_policy(surface)
        if policy == "excluded":
            continue
        for name, entry in _surface_entries(surface, Path(root)):
            surfaces[name] = entry
            if policy == "artifact_only":
                artifact_only.append(name)

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

    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "snapshot.json"
    manifest_path.write_text(canonical_json(manifest) + "\n", encoding="utf-8")

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
    identity: str = "aria-state",
) -> dict[str, Any]:
    """Verify a snapshot's signature AND that its root still matches.

    Both halves are one answer on purpose. A valid signature over a
    manifest whose ``manifest_root`` no longer matches its content proves
    only that someone signed something once; the pair is what says "this
    exact tree state was attested".
    """
    if shutil.which("ssh-keygen") is None:
        raise SnapshotError(
            "snapshot_verification_unavailable: ssh-keygen not on PATH; a missing "
            "verifier is not a passing verification"
        )
    for path in (manifest_path, signature_path, public_key_path):
        if not path.exists():
            raise SnapshotError(f"snapshot_verify_input_missing: {path.as_posix()}")

    allowed_signers = signature_path.parent / "allowed_signers"
    key_line = public_key_path.read_text(encoding="utf-8").strip()
    allowed_signers.write_text(f"{identity} {key_line}\n", encoding="utf-8")

    try:
        proc = subprocess.run(
            [
                "ssh-keygen", "-Y", "verify",
                "-f", str(allowed_signers),
                "-I", identity,
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
    linked = (
        current.get("prev_snapshot_id") == previous.get("snapshot_id")
        and current.get("prev_manifest_root") == previous.get("manifest_root")
    )
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


def _surface_entries(surface: StateSurface, root: Path) -> list[tuple[str, dict[str, Any]]]:
    """One entry per file backing the surface; glob surfaces fan out.

    Keys match the coverage projection used by ``covered_tool_ledgers``
    (``name`` for a fixed path, ``name:relative/path`` for each glob
    match), so the snapshot and the integrity verifier speak about
    surfaces with the same vocabulary.
    """
    entries: list[tuple[str, dict[str, Any]]] = []
    if "*" in surface.path_pattern:
        for match in sorted(root.glob(surface.path_pattern)):
            if match.is_file():
                key = f"{surface.name}:{match.relative_to(root).as_posix()}"
                entries.append((key, _surface_entry(surface, match, root)))
        return entries
    path = root / surface.path_pattern
    if path.is_file():
        entries.append((surface.name, _surface_entry(surface, path, root)))
    return entries


def _surface_entry(surface: StateSurface, path: Path, root: Path) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "path": path.relative_to(root).as_posix(),
        "root_kind": surface.root_kind,
        "state_class": surface.state_class,
        "storage": _storage_policy(surface),
        "sha256": file_hash(path),
        # Recorded because the walk is already here and the number is
        # otherwise unmeasured. PLAN §2.2b's replacement for `.seg-NNN`
        # rollover is a MEASURED archival trigger, and a trigger needs a
        # series to fire on; without this, "is any surface approaching a
        # size that matters" is a question nothing in ARIA can answer,
        # and the answer would arrive as a slow workflow rather than as
        # a number.
        "size_bytes": path.stat().st_size,
        # ``segments`` carries every physical file backing this surface.
        # It is a list from the start — today always one entry — so the
        # rollover that splits a large ledger records itself here without
        # a schema change, and a reader written now stays correct then.
        "segments": [path.relative_to(root).as_posix()],
    }
    if surface.state_class == "ledger":
        entry.update(_ledger_state(path))
    return entry


def _ledger_state(path: Path) -> dict[str, Any]:
    """Chain tip and row count via the kernel's ONE strict reader.

    ``load_jsonl_verified`` is the sanctioned path (a hand-rolled parse
    that skipped malformed rows would be both a second reader and a
    silent skip — the defect an AST invariant already bans). A ledger
    that fails verification is recorded as ``chain_valid: false`` with no
    counts rather than being given plausible-looking ones: a snapshot
    that reported a tip for a broken chain would attest to a state that
    does not exist, which is worse than attesting nothing.
    """
    try:
        rows = load_jsonl_verified(path)
    except LedgerIntegrityError:
        return {"chain_valid": False, "row_count": None, "tail_ledger_hash": None}
    tail = None
    if rows:
        value = rows[-1].get("ledger_hash")
        if isinstance(value, str) and value:
            tail = value
    return {"chain_valid": True, "row_count": len(rows), "tail_ledger_hash": tail}
