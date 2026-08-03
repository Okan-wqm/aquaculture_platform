from __future__ import annotations

import hashlib
import json
import os
import subprocess
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Any

from .ledger import append_declared_jsonl, file_hash, read_jsonl, write_index


@dataclass(frozen=True)
class WorkspacePaths:
    repo_root: Path
    workspace_root: Path
    memory_dir: Path
    state_dir: Path
    cycle_dir: Path
    feedback_index: Path
    identity_file: Path
    lock_file: Path
    ledgers: dict[str, Path]


def canonicalize_remote_url(raw: str) -> str:
    """Plan ARIA-V2 §3.1 — normalize a git remote URL to a canonical
    ``host/owner/repo`` form so that environment-specific variants
    (SSH vs HTTPS, with-or-without credentials, trailing .git, host
    casing) all hash identically.

    Steps:
      a. strip "https://" / "http://" / "git@" / "ssh://" prefix
      b. replace ":" after host with "/"  (SSH ``user@host:owner/repo``)
      c. lowercase host segment ONLY  (owner+repo casing preserved
         because GitHub treats ``Owner/Repo`` and ``owner/repo`` as
         the same repo at HTTP layer but distinct at URL layer;
         locking this rule with an invariant test prevents silent
         regression)
      d. strip trailing ".git"
      e. strip credentials "user(:pass)?@" prefix
    """
    s = raw.strip()
    if not s:
        return ""
    for proto in ("https://", "http://", "ssh://"):
        if s.startswith(proto):
            s = s[len(proto):]
            break
    if s.startswith("git@"):
        s = s[len("git@"):]
    if "@" in s and "/" not in s.split("@", 1)[0]:
        s = s.split("@", 1)[1]
    if ":" in s and "/" not in s.split(":", 1)[0]:
        host, rest = s.split(":", 1)
        s = f"{host}/{rest}"
    if "/" in s:
        host, _, rest = s.partition("/")
        s = f"{host.lower()}/{rest}"
    else:
        s = s.lower()
    if s.endswith(".git"):
        s = s[:-4]
    return s


def _git_root_commit_sha(repo_root: Path) -> str:
    """First root commit SHA, or empty string if unavailable.

    Used as the offline fallback for ``canonical_identity`` so two
    clones of the same repo at different paths still hash identically
    even without a configured remote.
    """
    try:
        result = subprocess.run(
            ["git", "rev-list", "--max-parents=0", "HEAD"],
            cwd=repo_root,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return ""
    if result.returncode != 0:
        return ""
    line = result.stdout.strip().splitlines()
    return line[0].strip() if line else ""


def canonical_identity(repo_root: Path) -> str:
    """Plan ARIA-V2 §3.1 — environment-independent repo identity.

    ``canonical_identity = sha256(canonicalize_remote_url(remote))[:16]``

    Property: same repo → same hash, regardless of clone path,
    protocol, credentials, .git suffix, host casing, or worktree
    location. The legacy ``repo_hash`` mixed the resolved filesystem
    path AND remote URL into the hash, which made the binding
    environment-bound and broke fresh clones / cross-environment
    operation (ARIA-V-006).

    Offline fallback: if no ``remote.origin.url`` is configured, the
    identity is anchored to ``git rev-list --max-parents=0 HEAD``
    (the repository's first root commit SHA), which is also clone-
    path-independent. If neither is available, falls back to the
    canonical repo root's basename — by definition clone-specific;
    this path emits a governance event so the audit trail names the
    degraded mode (see ``canonical_identity_source``).
    """
    canonical_root = canonical_repo_root(repo_root)
    raw_remote = ""
    try:
        raw_remote = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=canonical_root,
            text=True,
            capture_output=True,
            check=False,
        ).stdout.strip()
    except OSError:
        raw_remote = ""
    normalized = canonicalize_remote_url(raw_remote)
    if normalized:
        return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]
    root_sha = _git_root_commit_sha(canonical_root)
    if root_sha:
        return hashlib.sha256(f"local-root:{root_sha}".encode("utf-8")).hexdigest()[:16]
    fallback = canonical_root.name or "unknown"
    return hashlib.sha256(f"local-basename:{fallback}".encode("utf-8")).hexdigest()[:16]


def canonical_identity_source(repo_root: Path) -> dict[str, str]:
    """Diagnostic info about which identity source was used.

    Used by ``ensure_workspace`` / ``ensure_tools_binding`` to emit a
    ``canonical_identity_offline_fallback`` governance event when the
    identity is computed from the root commit SHA or basename rather
    than the remote URL.
    """
    canonical_root = canonical_repo_root(repo_root)
    raw_remote = ""
    try:
        raw_remote = subprocess.run(
            ["git", "config", "--get", "remote.origin.url"],
            cwd=canonical_root,
            text=True,
            capture_output=True,
            check=False,
        ).stdout.strip()
    except OSError:
        raw_remote = ""
    normalized = canonicalize_remote_url(raw_remote)
    if normalized:
        return {"source": "remote_url", "normalized": normalized}
    root_sha = _git_root_commit_sha(canonical_root)
    if root_sha:
        return {"source": "root_commit_sha", "normalized": f"local-root:{root_sha}"}
    return {"source": "basename", "normalized": f"local-basename:{canonical_root.name or 'unknown'}"}


def repo_hash(repo_root: Path) -> str:
    """DEPRECATED alias for ``canonical_identity`` (Plan ARIA-V2 §3.1).

    Pre-Plan-ARIA-V2 implementation mixed absolute path + remote URL
    into the hash, which made the binding environment-specific
    (ARIA-V-006). This alias preserves the legacy callsite signature
    while delegating to the new path-independent implementation. New
    code SHOULD call ``canonical_identity`` directly.

    WHY KEEP: ``workspace_paths`` uses this to compute the workspace
    directory name; switching to ``canonical_identity`` directly would
    change every existing workspace path and orphan in-flight state.
    The alias ensures the workspace path is always canonical (path-
    independent) post-v3 while legacy callsites continue to compile.
    """
    return canonical_identity(repo_root)


def canonical_repo_root(repo_root: Path) -> Path:
    """Plan 024 v3 followup (ORPHAN-HIGH-056) — resolve a git-worktree
    path to its canonical repo root.

    Uses ``git rev-parse --git-common-dir``:
    * In a normal (non-worktree) repo this returns ``.git`` relative
      to the repo root; the parent of that is the repo root itself.
    * In a worktree (e.g. ``/var/aqua-saas/.worktrees/snowball``) this
      returns the canonical repo's ``.git/`` (e.g.
      ``/var/aqua-saas/.git``); the parent of that is the canonical
      repo root.

    The canonical root is what ``aria-tools/`` binding pins, so
    callers comparing the binding hash should resolve the workspace_-
    root through this helper first to ensure a worktree of the same
    repo matches the binding. Falls back to the resolved repo_root
    when not inside a git repo (defensive for fixture roots that
    are not git'd).
    """
    resolved = repo_root.resolve()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--git-common-dir"],
            cwd=resolved,
            text=True,
            capture_output=True,
            check=False,
        )
    except OSError:
        return resolved
    if result.returncode != 0:
        return resolved
    common_dir_str = result.stdout.strip()
    if not common_dir_str:
        return resolved
    common_dir = Path(common_dir_str)
    if not common_dir.is_absolute():
        common_dir = resolved / common_dir
    try:
        canonical = common_dir.resolve().parent
    except OSError:
        return resolved
    return canonical


REPO_STATE_ROOT_ENV = "ARIA_REPO_STATE_ROOT"


def repo_state_root(repo_root: Path) -> Path:
    """Where the manifest's ``repo``-root surfaces actually live.

    ``aria-findings/`` and ``aria-debts/`` are declared surfaces, but both
    are gitignored in the checkout BY DESIGN — a runtime cycle must not
    dirty the discovery tree. The consequence was that they died with the
    runner: ``_allocate_finding_id`` restarted at ``F-001`` on every
    bootstrap, so finding identity meant nothing across runs.

    This is the one seam that redirects them into the durable state store,
    mirroring ``ARIA_WORKSPACE_BASE`` for the ``workspace`` root. Both
    ``finding.py`` and ``debt.py`` resolve through here so the two cannot
    drift apart the way two hand-copied restore heredocs did
    (ORPHAN-CRITICAL-513).

    DELIBERATELY NOT USED BY ``gh_token_factory._keys_dir``. That writes
    per-cycle ed25519 PRIVATE keys and scoped tokens under
    ``aria-debts/keys/``; they are runtime credentials, not state, and
    they have no declared surface. Keeping them on the ephemeral checkout
    is the point — dying with the runner is the correct lifetime for a
    per-cycle key. (The store also stages only attested surfaces, so a key
    could not be committed even if it did land there; that is the second
    lock, not the first.)
    """
    override = os.environ.get(REPO_STATE_ROOT_ENV)
    if override:
        return Path(override).expanduser().resolve()
    return Path(repo_root)


def workspace_paths(repo_root: Path, workspace_base: Path | None = None) -> WorkspacePaths:
    # Plan 020 Phase 0 — operator gap #6: sandbox /root/.aria/... read-only
    # nedeniyle test env'de workspace creation fail oluyordu. ARIA_WORKSPACE_BASE
    # env var override eklendi; explicit kwarg > env var > Path.home() fallback.
    import os
    if workspace_base is not None:
        base = workspace_base
    elif os.environ.get("ARIA_WORKSPACE_BASE"):
        base = Path(os.environ["ARIA_WORKSPACE_BASE"])
    else:
        base = Path.home() / ".aria" / "workspaces"
    root = base.expanduser().resolve() / repo_hash(repo_root)
    memory = root / "aria-memory"
    state = root / "aria-state"
    ledgers = {
        "unknowns": memory / "unknowns.jsonl",
        "missed_signals": memory / "missed_signals.jsonl",
        "external_feedback": memory / "external_feedback.jsonl",
        "pressure": memory / "pressure.jsonl",
        "pressure_state": memory / "pressure_state.jsonl",
        "vocabulary_rejections": memory / "vocabulary_rejections.jsonl",
        "since_migration_events": memory / "since_migration_events.jsonl",
        "governance": memory / "governance.jsonl",
    }
    return WorkspacePaths(
        repo_root=repo_root.resolve(),
        workspace_root=root,
        memory_dir=memory,
        state_dir=state,
        cycle_dir=state / "cycles",
        feedback_index=state / "integrity_index.json",
        identity_file=root / "repo_identity.json",
        lock_file=state / "feedback.lock",
        ledgers=ledgers,
    )


def ensure_workspace(paths: WorkspacePaths) -> None:
    repo_root = paths.repo_root.resolve()

    identity = {
        "repo_root": str(repo_root),
        "repo_hash": paths.workspace_root.name,
        "aria_workspace_contract_version": 2,
        "schema_version": 2,
    }
    if paths.identity_file.exists():
        existing = json.loads(paths.identity_file.read_text(encoding="utf-8"))
        if existing.get("repo_hash") != identity["repo_hash"]:
            raise ValueError("ARIA workspace belongs to a different repository hash")
        if workspace_contract_version(paths) < 2:
            return
    else:
        if _workspace_has_covered_state(paths):
            raise RuntimeError("workspace_migration_required")
        _prepare_workspace_dirs(paths)
        _atomic_write_json(paths.identity_file, identity)
        record_workspace_governance(
            paths,
            "workspace_bootstrapped",
            {
                "workspace_root": paths.workspace_root.as_posix(),
                "schema_version": 2,
                "repo_hash": paths.workspace_root.name,
            },
        )
        record_workspace_governance(paths, "vocabulary_loaded", _failure_mode_vocabulary_marker(paths))
    _prepare_workspace_dirs(paths)
    write_index(paths.feedback_index, _index_state(paths), paths.ledgers)


def workspace_contract_version(paths: WorkspacePaths) -> int:
    if not paths.identity_file.exists():
        return 0
    try:
        identity = json.loads(paths.identity_file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    return int(identity.get("aria_workspace_contract_version") or identity.get("schema_version") or 1)


def require_workspace_v2(paths: WorkspacePaths) -> None:
    version = workspace_contract_version(paths)
    if version < 2:
        raise RuntimeError("workspace_migration_required")


def record_workspace_governance(paths: WorkspacePaths, kind: str, details: dict[str, Any]) -> dict[str, Any]:
    event = governance_event(kind=kind, details=details)
    stored = append_declared_jsonl(
        paths.ledgers["governance"],
        event,
        expected_surface="workspace_memory_governance",
    )
    if paths.feedback_index.exists():
        write_index(paths.feedback_index, _index_state(paths), paths.ledgers)
    return stored


def governance_event(kind: str, details: dict[str, Any]) -> dict[str, Any]:
    import socket
    from datetime import datetime, timezone

    ts = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    actor = default_actor()
    canonical = {
        "actor": actor,
        "details": details,
        "kind": kind,
        "ts": ts,
    }
    digest = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    slug_prefix = kind.replace("_", "-")[:32] or "event"
    return {
        "$schema": "aria/governance-event/v2",
        "event_id": f"GE-{slug_prefix}-{digest[:16]}",
        "kind": kind,
        "actor": actor,
        "ts": ts,
        "details": details,
        "host": socket.gethostname(),
        "schema_version": 2,
    }


def default_actor() -> dict[str, Any]:
    import getpass
    import os
    import socket

    raw = os.environ.get("ARIA_ACTOR")
    if raw:
        try:
            actor = json.loads(raw)
        except json.JSONDecodeError:
            actor = {}
        if isinstance(actor, dict) and isinstance(actor.get("kind"), str) and isinstance(actor.get("id"), str):
            return actor
    return {"kind": "human", "id": f"{getpass.getuser()}@{socket.gethostname()}"}


def _prepare_workspace_dirs(paths: WorkspacePaths) -> None:
    paths.memory_dir.mkdir(parents=True, exist_ok=True)
    paths.state_dir.mkdir(parents=True, exist_ok=True)
    paths.cycle_dir.mkdir(parents=True, exist_ok=True)
    for ledger in paths.ledgers.values():
        ledger.parent.mkdir(parents=True, exist_ok=True)
        ledger.touch(exist_ok=True)


def _workspace_has_covered_state(paths: WorkspacePaths) -> bool:
    if paths.feedback_index.exists():
        return True
    return any(path.exists() and path.stat().st_size > 0 for path in paths.ledgers.values())


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _index_state(paths: WorkspacePaths) -> dict[str, Any]:
    current: dict[str, Any] = {}
    if paths.feedback_index.exists():
        try:
            current = json.loads(paths.feedback_index.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            current = {}
    current.setdefault("pressure_evidence_fingerprints_emitted", _pressure_fingerprints(paths))
    current.setdefault("failure_mode_vocabulary_loaded", _failure_mode_vocabulary_marker(paths))
    return current


def _pressure_fingerprints(paths: WorkspacePaths) -> list[str]:
    rows = read_jsonl(paths.ledgers["pressure"])
    return sorted(
        str(row["evidence_fingerprint"])
        for row in rows
        if isinstance(row.get("evidence_fingerprint"), str) and row.get("evidence_fingerprint")
    )


def _failure_mode_vocabulary_marker(paths: WorkspacePaths) -> dict[str, Any]:
    try:
        resource = resources.files("aria_kernel.data").joinpath("default_failure_modes.json")
        payload = json.loads(resource.read_text(encoding="utf-8"))
    except (FileNotFoundError, ModuleNotFoundError):
        payload = {"$schema": "aria/failure-mode-vocab/v3", "modes": []}
    default_modes = _modes_from_payload(payload, ignore_feedback_kinds=False)
    marker = {
        "source": "embedded",
        "schema": payload.get("$schema"),
        "default_count": len(default_modes),
        "override_count": 0,
        "legacy_schema_detected": False,
        "override_hash": None,
    }
    override_path = paths.workspace_root / "aria-config" / "failure_mode_vocabulary.json"
    if not override_path.exists():
        return marker
    try:
        override = json.loads(override_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return marker
    legacy = str(override.get("$schema") or "").endswith("/v2")
    marker["source"] = "legacy-v2-tolerated" if legacy else "override-merged"
    marker["override_count"] = len(_modes_from_payload(override, ignore_feedback_kinds=legacy))
    marker["legacy_schema_detected"] = legacy
    marker["override_hash"] = file_hash(override_path)
    return marker


def _modes_from_payload(payload: dict[str, Any], *, ignore_feedback_kinds: bool) -> set[str]:
    raw_modes = payload.get("modes", [])
    modes = {
        str(item.get("id") if isinstance(item, dict) else item)
        for item in raw_modes
        if item and str(item.get("id") if isinstance(item, dict) else item).strip()
    }
    if ignore_feedback_kinds:
        modes.difference_update({"missed_signal", "false_positive", "confirmed_signal", "unknown_capability", "external_contradiction", "closed_signal"})
    return modes
