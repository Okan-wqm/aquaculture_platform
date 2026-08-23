from __future__ import annotations

import hashlib
import json
import os
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .ledger import (
    StateTransaction,
    append_declared_jsonl,
    append_jsonl,
    file_hash,
    load_jsonl,
    rewrite_declared_json,
    tools_index_group_ledgers,
    write_index,
)
from .workspace import canonical_identity, canonical_identity_source, canonical_repo_root, governance_event, repo_hash
from .implementation_safety import verify_bash_command_allowed


# Plan ARIA-V2 §3.2 — contract v3 introduces canonical-identity-bound
# tools root. v3 is backward-compatible at the IDENTITY FILE level:
# legacy ``bound_repo_hash`` is migrated to ``bound_canonical_identity``
# in place on first bind under v3. Operators on v2 trees must run
# ``aria-kernel integrity migrate-tools-bootstrap`` once after pull.
SCHEMA_VERSION = 3
TOOL_STATUSES = (
    "DRAFT",
    "SANDBOX",
    "SHADOW",
    "ACTIVE",
    "CALIBRATE",
    "QUARANTINED",
    "ARCHIVED",
)
TOOL_KINDS = ("adapter", "skill", "llm_amplified_skill")
# Plan 023 v3 §C-3 — initial-lifecycle states permitted on first
# register_tool call. ACTIVE / CALIBRATE / QUARANTINED / ARCHIVED on
# first registration is rejected so the only path to those states is
# transition_tool() (which enforces precision + evidence_chains_valid +
# operator_approval). This closes the new-tool-direct-ACTIVE bypass.
INITIAL_LIFECYCLE_STATES = ("DRAFT", "SANDBOX", "SHADOW")
RUNNER_REQUIRED_STATUSES = ("SANDBOX", "SHADOW", "ACTIVE", "CALIBRATE")
RUNNER_TYPES = ("subprocess",)
REQUIRED_TOOL_FIELDS = (
    "tool_id",
    "kind",
    "version",
    "status",
    "declared_scope",
    "output_schema",
    "fixture_set",
    "health_thresholds",
    "allowed_read_globs",
    "forbidden_read_globs",
    "claim_types",
    "owner",
    "schema_version",
)

DEFAULT_HEALTH_THRESHOLDS = {
    "precision_min": 0.85,
    "non_critical_false_positives_30d": 3,
    "critical_false_positives": 0,
    "crash_rate_last_10": 0.2,
}

# E13-C11 — freshness metadata is manifest-owned, validator-defaulted.
# WHY here and not adapter_portfolio: pre-E13-C11 these fields were patched
# onto registry rows at RUNTIME (adapter_portfolio.backfill_window_metadata)
# and silently deleted by every manifest recompile (registry_compiler) and
# per-cycle manifest re-registration (cycle.py -> register_tool) — a
# Potemkin metadata layer with zero readers. validate_tool_definition is the
# single write gate every registry row passes through, so owning the default
# and the derived signature HERE makes the fields survive every recompile by
# construction (Tier 1: the deleting path is the producing path).
DEFAULT_FRESHNESS_WINDOW_HOURS = 168  # Plan 016 §Recursive impact and freshness gates (7 days).

# The declaration fields that define a tool's parse window; the tuple
# parse_window_signature hashes over AND the trigger set for signature
# recomputation in update_tool.
PARSE_WINDOW_FIELDS: tuple[str, ...] = (
    "declared_scope",
    "claim_types",
    "default_input",
    "allowed_read_globs",
    "forbidden_read_globs",
)


class GovernanceError(ValueError):
    """Raised when a tool governance rule rejects an operation."""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_utc_stamp(raw: str) -> datetime | None:
    """Read a stamp this module minted, or None when it cannot be read.

    ORPHAN-HIGH-729 — one parser, living beside the writer. There were two
    private copies (`autonomy_unlock._parse_stamp`,
    `plan_convergence._older_than_hours`) and they disagreed about the
    important case: one returned None so the caller could SEE that a row was
    undateable, the other folded the failure into a bool, where "unparseable"
    became indistinguishable from "recent" and a corrupt stamp bought a plan
    immortality.

    None is the only honest answer for a stamp that cannot be read, and
    returning it forces every caller to decide what to do about that rather
    than inheriting a default. A naive stamp is read as UTC because UTC is
    what `utc_now` writes; that is the ledger's declared timezone, not a
    guess.
    """
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _walk_up_to_bound_identity(start_cwd: str | os.PathLike[str]) -> Path | None:
    """Plan ARIA-V3.3 §2a — walk-up resolver for an existing aria-tools.

    Walks the directory chain from ``start_cwd`` toward the filesystem
    root. At each ancestor checks whether
    ``<ancestor>/aria-tools/repo_identity.json`` exists; returns the
    FIRST matching ``<ancestor>/aria-tools`` as an absolute path.

    Why walk-up vs CWD-relative fallback (pre-V3.3 behavior):
      * Pre-V3.3, ``tools_dir(None)`` returned ``Path("aria-tools")``
        — CWD-relative. A kernel invocation from inside the
        ``aria-kernel/`` subdir silently created a SHADOW
        ``aria-kernel/aria-tools/`` tree because the relative path
        resolved against the wrong cwd. Reflection then read the
        shadow ledger (a handful of stale rows) instead of the
        canonical worktree-rooted ``aria-tools/``.
      * Walk-up locates the canonical tools root from ANY cwd inside
        the worktree by definition — the canonical root is the first
        initialized aria-tools encountered on the way to filesystem
        root. The defect class is structurally impossible after this
        change (Tier-1 — "make impossible").

    Returns ``None`` if no initialized aria-tools is found before the
    filesystem root. The caller decides whether ``None`` means
    "fail-fast" (the default ``tools_dir`` path) or "no-op" (the
    frozen-profile read helper ``ensure_tools_dir_readonly``).
    """
    cur = Path(start_cwd).resolve()
    while True:
        candidate = cur / "aria-tools" / "repo_identity.json"
        if candidate.is_file():
            return (cur / "aria-tools").resolve()
        if cur.parent == cur:
            return None
        cur = cur.parent


def tools_dir(path: str | os.PathLike[str] | None = None) -> Path:
    """Plan ARIA-V3.3 §2a — always-absolute tools_dir resolver.

    Resolution order:
      1. Explicit ``path`` argument → ``Path(path).resolve()``.
      2. ``ARIA_TOOLS_DIR`` env var → ``Path(env).resolve()``.
      3. Walk up from cwd to the first
         ``<ancestor>/aria-tools/repo_identity.json`` and return that
         absolute directory.
      4. Raise ``GovernanceError("tools_root_unresolvable")`` with a
         remediation pointer to ``aria-kernel integrity migrate-tools-
         bootstrap``.

    Why this matters (Plan ARIA-V3.3 §2a / F-010-D4):
      The pre-V3.3 fallback ``Path("aria-tools")`` was CWD-relative.
      When the kernel was invoked from inside the ``aria-kernel/``
      subdir (e.g. ``cd aria-kernel && python -m aria_kernel.cli ...``),
      the relative path resolved against the wrong cwd and silently
      created a SHADOW ``aria-kernel/aria-tools/`` tree. Reflection
      then read the shadow ledger instead of the canonical worktree-
      rooted ``aria-tools/`` — the daily report's "Total governance
      events" number diverged from the actual governance.jsonl
      contents.

      V3.3 closes the class architecturally: ``tools_dir`` NEVER
      returns a CWD-relative path. Every successful return is an
      absolute Path; if no path can be inferred, the kernel raises
      with an explicit remediation message rather than auto-creating a
      shadow.

    Operator workflow on a fresh checkout: run
    ``aria-kernel integrity migrate-tools-bootstrap --workspace-root .
    --tools-dir aria-tools --acknowledge --reason "<text>"`` once.
    Subsequent invocations from any cwd inside the worktree find the
    canonical aria-tools via walk-up.
    """
    if path is not None:
        return Path(path).resolve()
    env = os.environ.get("ARIA_TOOLS_DIR")
    if env:
        return Path(env).resolve()
    discovered = _walk_up_to_bound_identity(Path.cwd())
    if discovered is not None:
        return discovered
    raise GovernanceError(
        "tools_root_unresolvable: no --tools-dir argument, no "
        "ARIA_TOOLS_DIR env var, and no parent directory contains an "
        "initialized aria-tools/ with repo_identity.json. Run "
        "`aria-kernel integrity migrate-tools-bootstrap "
        "--workspace-root . --tools-dir aria-tools --acknowledge "
        "--reason \"<text>\"` to initialize a tools root, OR set "
        "ARIA_TOOLS_DIR=<absolute-path>, OR pass --tools-dir explicitly."
    )


def registry_path(base_dir: str | os.PathLike[str] | None = None) -> Path:
    return tools_dir(base_dir) / "registry.json"


TOOLS_CONTRACT_FILENAME = "tools_contract.json"

# ORPHAN-HIGH-556 — the fields of ``repo_identity.json`` that describe the
# TREE and the REPOSITORY rather than the HOST.
#
# ``repo_identity.json`` mixes three scopes: the contract version (a property
# of the tree), the canonical identity (a property of the repository, and
# environment-independent by ARIA-V2 §3.2), and ``bound_repo_root`` (an
# ABSOLUTE PATH on the machine that wrote it). The last one is why the file
# cannot be published to the shared ``aria/state`` branch — and one
# unpublishable field was making the whole file unpublishable, so a restored
# tree arrived unable to state its own contract version, ``tools_contract_version``
# read 0, and every nightly bind re-migrated a healthy v3 tree from nothing.
#
# Splitting the publishable subset into its own declared surface is what lets
# a restored tree say what it already is. ONE definition of the subset, called
# from every place that writes the identity, because five copies of "which
# fields may travel" is five chances for one of them to leak a host path.
PUBLISHABLE_IDENTITY_FIELDS: tuple[str, ...] = (
    "aria_tools_contract_version",
    "schema_version",
    "bound_canonical_identity",
)


def sync_tools_contract(root: Path) -> dict[str, Any]:
    """Mirror the publishable half of ``repo_identity.json`` beside it."""
    identity = _read_identity(root)
    contract = {
        field: identity[field]
        for field in PUBLISHABLE_IDENTITY_FIELDS
        if identity.get(field) is not None
    }
    _atomic_write_json(root / TOOLS_CONTRACT_FILENAME, contract)
    return contract


def _read_identity(root: Path) -> dict[str, Any]:
    try:
        payload = json.loads((root / "repo_identity.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def ensure_tools_dir(base_dir: str | os.PathLike[str] | None = None) -> Path:
    root = tools_dir(base_dir)
    root.mkdir(parents=True, exist_ok=True)
    _guard_tools_lock(root)
    identity_file = root / "repo_identity.json"
    if not identity_file.exists():
        if _tools_has_covered_state(root):
            raise GovernanceError("ambiguous_tools_root")
        identity = {
            "aria_tools_contract_version": 2,
            "bound_repo_hash": None,
            "bound_repo_root": None,
            "schema_version": 2,
        }
        _prepare_tools_dirs(root)
        _atomic_write_json(identity_file, identity)
        sync_tools_contract(root)
        if not registry_path(root).exists():
            _atomic_write_json(registry_path(root), {"schema_version": SCHEMA_VERSION, "tools": []})
        append_tools_governance(
            root,
            "tools_root_bootstrapped",
            {"tools_dir": root.as_posix(), "schema_version": 2, "bound_repo_hash": None},
        )
    _prepare_tools_dirs(root)
    update_tools_index(root)
    return root


def ensure_tools_dir_readonly(base_dir: str | os.PathLike[str] | None = None) -> Path | None:
    """Plan 020 Phase 0 — frozen profile read path helper.

    Returns the tools_dir Path if it already exists with a valid
    repo_identity.json (bound state), else None. Does NOT create the
    directory, write the identity file, or emit governance events.

    Why: frozen runtime profile semantic is "no ledger/governance
    write". Read commands (spine status, change show, dashboard render)
    that call ensure_tools_dir() under frozen would silently break the
    no-write invariant by emitting tools_root_bootstrapped events on a
    fresh sandbox. This helper lets read paths fail-closed rather than
    write-init under frozen — caller checks None and raises a profile-
    aware error.
    """
    root = tools_dir(base_dir)
    if not root.exists() or not root.is_dir():
        return None
    identity_file = root / "repo_identity.json"
    if not identity_file.exists():
        return None
    return root


def ensure_tools_binding(
    base_dir: str | os.PathLike[str] | None = None,
    *,
    workspace_root: str | os.PathLike[str] | None = None,
) -> Path:
    """Plan ARIA-V2 §3.2 — bind aria-tools to a canonical repo identity.

    v3 semantics (backward-compatible upgrade from v2):
      * Binding identity is ``canonical_identity(workspace_root)`` —
        environment-independent (ARIA-V-006 fix). Cross-clone /
        cross-protocol invocation of the same repo binds identically;
        legitimate cross-repo reuse still fails closed.
      * ``aria-tools/repo_identity.json`` stores the binding as
        ``bound_canonical_identity`` (preferred) while keeping legacy
        ``bound_repo_hash`` populated for callsites still reading it.
        Both fields are kept in sync on every bind under v3.
      * Worktree paths of the SAME repo bind identically because
        ``canonical_identity`` resolves through ``--git-common-dir``
        before hashing. The legacy worktree-aware fallback is no
        longer needed — the canonical resolution is built into the
        identity function itself (Tier-1: structural).
    """
    root = ensure_tools_dir(base_dir)
    if workspace_root is None:
        return root
    repo_root = Path(workspace_root).resolve()
    identity_file = root / "repo_identity.json"
    identity = json.loads(identity_file.read_text(encoding="utf-8"))
    expected = canonical_identity(repo_root)
    legacy_bound = identity.get("bound_repo_hash")
    bound_canonical = identity.get("bound_canonical_identity")
    bound_value = bound_canonical or legacy_bound  # tolerate either field during migration
    if bound_value in (None, ""):
        # Fresh bind — populate both legacy and canonical fields so
        # any reader on either schema sees a consistent value.
        identity_source = canonical_identity_source(repo_root)
        identity["bound_canonical_identity"] = expected
        identity["bound_repo_hash"] = expected  # legacy mirror
        identity["bound_repo_root"] = str(repo_root)
        identity["aria_tools_contract_version"] = SCHEMA_VERSION
        identity["schema_version"] = SCHEMA_VERSION
        _atomic_write_json(identity_file, identity)
        sync_tools_contract(root)
        append_tools_governance(
            root,
            "tools_root_bound",
            {
                "bound_canonical_identity": expected,
                "bound_repo_root": str(repo_root),
                "identity_source": identity_source["source"],
            },
        )
        if identity_source["source"] != "remote_url":
            append_tools_governance(
                root,
                "canonical_identity_offline_fallback",
                {
                    "identity_source": identity_source["source"],
                    "seed_summary": identity_source["normalized"][:64],
                    "canonical_identity": expected,
                },
            )
        return root
    if bound_value == expected:
        # Already bound and identity matches. If this is a legacy v2
        # tree (only ``bound_repo_hash`` set, no ``bound_canonical_identity``)
        # transparently upgrade to v3 by populating the canonical
        # field in place. This makes ``migrate-tools-bootstrap`` a
        # no-op for trees that happen to have already had their
        # binding computed via the new canonical recipe.
        if bound_canonical in (None, "") and legacy_bound:
            identity["bound_canonical_identity"] = legacy_bound
            identity["aria_tools_contract_version"] = SCHEMA_VERSION
            identity["schema_version"] = SCHEMA_VERSION
            _atomic_write_json(identity_file, identity)
            sync_tools_contract(root)
            append_tools_governance(
                root,
                "tools_root_canonical_identity_backfilled",
                {"bound_canonical_identity": legacy_bound},
            )
        return root
    # Mismatch. Try the legacy worktree-aware fallback (which now
    # delegates to canonical_repo_root → canonical_identity, so a
    # different working tree of the same repo binds identically).
    canonical = canonical_repo_root(repo_root)
    canonical_hash = canonical_identity(canonical) if canonical != repo_root else expected
    if bound_value == canonical_hash:
        append_tools_governance(
            root,
            "tools_root_worktree_resolved",
            {
                "bound_canonical_identity": bound_value,
                "bound_repo_root": identity.get("bound_repo_root"),
                "worktree_root": str(repo_root),
                "canonical_repo_root": str(canonical),
            },
        )
        return root
    # Plan ARIA-V2 §3.2 — fail-closed on cross-repo aria-tools reuse.
    # Under v3 this should fire ONLY for genuine cross-repo reuse
    # because the canonical_identity recipe is path-independent.
    # Operators on legacy v2 trees with a stale env-bound hash see
    # this error and run ``integrity migrate-tools-bootstrap`` to
    # rebind under v3.
    raise GovernanceError(
        f"tools_root_canonical_identity_mismatch: "
        f"bound={bound_value!r} current={expected!r} canonical={canonical_hash!r}; "
        f"aria-tools cannot be reused across repos. "
        f"bound_repo_root={identity.get('bound_repo_root')!r}, "
        f"current workspace_root={str(repo_root)!r}, "
        f"canonical_repo_root={str(canonical)!r}. "
        f"If this is a stale legacy v2 binding from another environment, "
        f"run `aria-kernel integrity migrate-tools-bootstrap --acknowledge --reason \"<text>\"`."
    )


def tools_contract_version(base_dir: str | os.PathLike[str] | None = None) -> int:
    """The contract version of the TREE, whether or not this host is bound.

    ORPHAN-HIGH-556 — the published contract is consulted FIRST. Reading only
    ``repo_identity.json`` meant a restored ``aria/state`` tree, which
    deliberately does not carry that host-local file, reported version 0 — so
    a healthy v3 tree looked to ``migrate_tools_bootstrap`` like a v0 tree
    needing a full migration, every single night. The identity file remains
    the fallback so a tree written before the split still answers.
    """
    root = tools_dir(base_dir)
    contract_file = root / TOOLS_CONTRACT_FILENAME
    if contract_file.exists():
        try:
            contract = json.loads(contract_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            contract = {}
        if isinstance(contract, dict) and (
            contract.get("aria_tools_contract_version") or contract.get("schema_version")
        ):
            return int(
                contract.get("aria_tools_contract_version") or contract.get("schema_version")
            )
    identity = _read_identity(root)
    if not identity:
        return 0
    return int(identity.get("aria_tools_contract_version") or identity.get("schema_version") or 1)


def require_tools_v2(base_dir: str | os.PathLike[str] | None = None) -> None:
    if tools_contract_version(base_dir) < 2:
        raise GovernanceError("tools_migration_required")


# The four surfaces every tools root has from its first cycle. They stay
# in coverage even when the file is missing, so an empty or gutted root
# fails verification instead of passing vacuously (fail-closed).
CORE_TOOL_LEDGER_SURFACES: frozenset[str] = frozenset(
    {"runs", "health", "cycles", "tools_governance"}
)


def covered_tool_ledgers(root: Path) -> dict[str, Path]:
    """Every declared tools-root ledger surface, DERIVED from the manifest.

    ORPHAN-HIGH-433: this used to be a hand list — 4 required + 28
    optional entries — while ``state_manifest`` declared ~129 tools-root
    ledger surfaces. memory/*, enterprise/*, change-ledger/*,
    validation/*, queues/* were written with full hash-chain discipline
    and never verified: a surface had to be REMEMBERED here to be
    covered, and the list was the blind-spot generator. Deriving from the
    manifest makes coverage automatic — declaring a surface IS enrolling
    it — and the projection test pins that a hand list cannot come back.

    Keys are the manifest surface names (glob surfaces contribute one
    entry per existing match, keyed ``name:relative/path``). Ledgers that
    have not been created yet are skipped — most appear lazily on first
    write — except the core set above, which is unconditional.
    ``integrity_index.json`` written before this derivation carries the
    old key names; the first grouped index refresh rewrites it, and until
    then ``verify`` reports the drift instead of hiding it.
    """
    from .state_manifest import iter_surfaces

    ledgers: dict[str, Path] = {}
    for surface in iter_surfaces():
        if surface.root_kind != "tools" or surface.state_class != "ledger":
            continue
        if "*" in surface.path_pattern:
            for match in sorted(root.glob(surface.path_pattern)):
                if match.is_file():
                    key = f"{surface.name}:{match.relative_to(root).as_posix()}"
                    ledgers[key] = match
            continue
        path = root / surface.path_pattern
        if surface.name in CORE_TOOL_LEDGER_SURFACES or path.exists():
            ledgers[surface.name] = path
    return ledgers


def update_tools_index(
    root: Path,
    *,
    transaction: StateTransaction | None = None,
) -> None:
    index: dict[str, Any] = {}
    file_hashes: dict[str, str] = {}
    state_path = root / "migration_state.json"
    if state_path.exists():
        file_hashes["migration_state"] = file_hash(state_path)
    since_path = root / "since_migration_events.jsonl"
    if since_path.exists():
        file_hashes["since_migration_events.jsonl"] = file_hash(since_path)
    if file_hashes:
        index["file_hashes"] = file_hashes
    # The index tracks its GROUP membership, not the whole covered set:
    # the grouped refresh replaces ledger_hashes with the group on every
    # indexed append, so writing a wider set here would plant entries the
    # next append silently discards (ORPHAN-HIGH-525). Chain verification
    # of the full covered set is integrity's job, not this index's.
    index_path = root / "integrity_index.json"
    ledgers = tools_index_group_ledgers(root)
    if transaction is None:
        write_index(index_path, index, ledgers)
    else:
        transaction.write_index(index_path, index, ledgers)


def append_tools_governance(
    base_dir: str | os.PathLike[str] | Path,
    kind: str,
    details: dict[str, Any],
    *,
    bypass_profile_gate: bool = False,
    transaction: StateTransaction | None = None,
    prepared_event: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Plan 026R §A.2 — append a governance row and rely on A.1's grouped
    index refresh to keep ``integrity_index.json`` current.

    Plan 026R §A.4 — frozen-profile gate at function entry via the
    ``tool_governance`` surface_kind. The control-plane exception
    (``runtime_profile.set_profile`` MUST emit
    ``runtime_profile_changed`` to record an operator THAW from a
    frozen kernel) passes ``bypass_profile_gate=True``; every other
    caller honours the gate. Documented bypass keeps the SSoT
    explicit — every callsite is auditable for whether it intends to
    bypass.

    ``governance.jsonl`` is a member of the tools integrity-index group;
    ``append_jsonl`` therefore acquires the index-group lock OUTER + the
    per-file lock INNER and rewrites ``integrity_index.json`` under both
    locks via ``_refresh_adjacent_index_grouped``. The pre-§A.2 extra
    ``update_tools_index(root)`` call BELOW the lock was redundant (same
    output) AND racy: under N concurrent ``append_tools_governance``
    calls, two writers raced on the fixed ``.integrity_index.json.tmp``
    side-car and one ``tmp.replace(path)`` failed with FileNotFoundError
    (surfaced by ``test_concurrent_submit_race_5_subprocesses``).
    Removing the duplicate eliminates both the race and the extra fcntl
    pair per governance event.
    """
    if prepared_event is None and not bypass_profile_gate:
        # Late import avoids a module-load cycle: runtime_profile imports
        # tool_registry for ensure_tools_dir + append_tools_governance.
        from .runtime_profile import enforce_profile_for_write
        enforce_profile_for_write("tool_governance", base_dir=base_dir)
    event = prepared_event or governance_event(kind=kind, details=details)
    root = tools_dir(base_dir) if transaction is not None else ensure_tools_dir(base_dir)
    governance_path = root / "governance.jsonl"
    if transaction is not None:
        return transaction.append_declared_jsonl(
            governance_path,
            event,
            expected_surface="tools_governance",
            bypass_profile_gate=bypass_profile_gate,
        )
    return append_declared_jsonl(
        governance_path,
        event,
        expected_surface="tools_governance",
        bypass_profile_gate=bypass_profile_gate,
    )


def disclosure_fingerprint(kind: str, claim: dict[str, Any]) -> str:
    """The identity of what a disclosure ASSERTS, ignoring when it was said.

    Canonical JSON so key order cannot fork the fingerprint, and the kind is
    part of it so two different disclosures that happen to share a claim
    shape stay distinguishable.
    """
    canonical = json.dumps(
        {"kind": kind, "claim": claim}, sort_keys=True, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def append_tools_governance_once(
    base_dir: str | os.PathLike[str] | Path,
    kind: str,
    details: dict[str, Any],
    *,
    claim_keys: tuple[str, ...],
) -> dict[str, Any]:
    """Disclose a standing fact ONCE, and again only when the fact changes.

    ORPHAN-MEDIUM-730. A governance row is evidence; a governance row an
    unattended lane re-appends verbatim every night is noise that buries
    evidence. Measured: four identical evidence-free cycles wrote 16
    ``service_mission_refused`` rows — 4 per cycle, byte-identical apart from
    the cycle id — and with an empty findings ledger that is what the nightly
    would do forever. The class this whole train exists to end is "a gate
    reporting the same weather every night"; a refusal doing it in a second
    ledger is the same defect wearing the other ledger's name.

    ``claim_keys`` names the fields that ARE the claim (project + reason +
    census, not the cycle id or the timestamp). A row whose claim matches one
    already on `governance.jsonl` is not appended and the caller is told so;
    a changed claim — new reason, new counts, evidence that arrived — is a
    NEW fact and gets its own row. Callers that must never be silenced keep
    using `append_tools_governance`; this is opt-in per callsite.

    The fingerprint is stored ON the row (``disclosure_fingerprint``) rather
    than in a side index, so the ledger stays the only thing that has to be
    read to know what has been said, and losing a projection costs nothing.

    Returns ``{"appended": bool, "fingerprint": str}``.
    """
    root = ensure_tools_dir(base_dir)
    claim = {key: details.get(key) for key in claim_keys}
    fingerprint = disclosure_fingerprint(kind, claim)
    for row in load_jsonl(root / "governance.jsonl"):
        if row.get("kind") != kind:
            continue
        recorded = row.get("details")
        if isinstance(recorded, dict) and recorded.get("disclosure_fingerprint") == fingerprint:
            return {"appended": False, "fingerprint": fingerprint}
    append_tools_governance(
        root, kind, {**details, "disclosure_fingerprint": fingerprint}
    )
    return {"appended": True, "fingerprint": fingerprint}


def _prepare_tools_dirs(root: Path) -> None:
    (root / "fixtures").mkdir(parents=True, exist_ok=True)
    for path in covered_tool_ledgers(root).values():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)


def _tools_has_covered_state(root: Path) -> bool:
    if (root / "integrity_index.json").exists():
        return True
    return any(path.exists() and path.stat().st_size > 0 for path in covered_tool_ledgers(root).values())


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _guard_tools_lock(root: Path) -> None:
    lock_path = root / "tools.lock"
    if not lock_path.exists():
        return
    try:
        payload = json.loads(lock_path.read_text(encoding="utf-8") or "{}")
        started = datetime.fromisoformat(str(payload.get("started_at", "")).replace("Z", "+00:00"))
    except (OSError, ValueError, json.JSONDecodeError):
        started = datetime.fromtimestamp(0, timezone.utc)
        payload = {}
    age = (datetime.now(timezone.utc) - started.astimezone(timezone.utc)).total_seconds()
    pid = int(payload.get("pid") or 0)
    operation = str(payload.get("operation") or "")
    # RE-ENTRANCY IS A PROPERTY OF HOLDING THE LOCK, not of appearing on a
    # list. This used to also require `operation in {"tools_migration",
    # "tools_rollback"}` — a hardcoded roster of the operations allowed to
    # write while holding their own lock, which silently refused the next
    # operation anyone added. `tools_binding` (ORPHAN-HIGH-556) was that next
    # operation: it took the lock correctly and then could not write its own
    # governance row. The pid check is the whole of the safety question; the
    # operation name added no protection and one more thing to remember.
    if pid == os.getpid():
        return
    if age >= 120 and (pid <= 0 or not _pid_exists(pid)):
        try:
            lock_path.unlink()
            append_tools_governance(
                root,
                "lock_reaped",
                {"stale_lock_pid": pid, "lock_age_seconds": int(age), "reaped_by_pid": os.getpid()},
            )
            return
        except FileNotFoundError:
            return
    raise GovernanceError("tools_root_locked")


def _pid_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def load_registry(base_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    path = registry_path(base_dir)
    if not path.exists():
        return {"schema_version": SCHEMA_VERSION, "tools": []}
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict) or not isinstance(data.get("tools"), list):
        raise GovernanceError(f"{path} must contain an object with a tools array")
    return data


def save_registry(
    registry: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
) -> None:
    ensure_tools_dir(base_dir)
    path = registry_path(base_dir)
    rewrite_declared_json(
        path,
        registry,
        expected_surface="tool_registry",
    )


def parse_window_signature(declaration: dict[str, Any]) -> str:
    """Stable SHA-256 hash of the parser-declaration tuple.

    The signature changes ONLY when the parser's declared scope, claim
    types, or input roots change — not when the underlying repo content
    changes. This is what the kernel uses to decide whether a recorded
    SHADOW run still matches the current adapter declaration.

    Moved here from adapter_portfolio (E13-C11) because the validator is
    now the single producer/verifier of the derived field; adapter_portfolio
    importing it back from here would be the only alternative and would
    invert the dependency direction it already has on this module.

    Returns: "sha256:<hex>" of a canonical JSON over (declared_scope,
    claim_types, default_input.roots, allowed_read_globs,
    forbidden_read_globs).
    """
    fields = {
        "declared_scope": sorted(declaration.get("declared_scope", []) or []),
        "claim_types": sorted(declaration.get("claim_types", []) or []),
        "default_input_roots": sorted(
            (declaration.get("default_input") or {}).get("roots", []) or []
        ),
        "allowed_read_globs": sorted(declaration.get("allowed_read_globs", []) or []),
        "forbidden_read_globs": sorted(declaration.get("forbidden_read_globs", []) or []),
    }
    canonical = json.dumps(fields, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def effective_freshness_window_hours(tool: dict[str, Any]) -> float:
    """Freshness window for a tool row, defaulting for legacy rows.

    Rows written through validate_tool_definition always carry the field;
    rows persisted before E13-C11 may not. This is the single defaulting
    point shared by readers (readiness) so the read-side default can never
    drift from the write-side DEFAULT_FRESHNESS_WINDOW_HOURS constant.
    """
    raw = tool.get("freshness_window_hours")
    if isinstance(raw, (int, float)) and not isinstance(raw, bool) and raw > 0:
        return float(raw)
    return float(DEFAULT_FRESHNESS_WINDOW_HOURS)


def validate_tool_definition(tool: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(tool, dict):
        raise GovernanceError("tool definition must be a JSON object")
    missing = [field for field in REQUIRED_TOOL_FIELDS if field not in tool]
    if missing:
        raise GovernanceError(f"tool definition missing required field(s): {', '.join(missing)}")

    candidate = deepcopy(tool)
    _require_string(candidate, "tool_id")
    _require_string(candidate, "version")
    _require_string(candidate, "owner")

    if candidate["kind"] not in TOOL_KINDS:
        raise GovernanceError(f"unknown tool kind: {candidate['kind']}")
    if candidate["status"] not in TOOL_STATUSES:
        raise GovernanceError(f"unknown lifecycle state: {candidate['status']}")
    if not candidate["declared_scope"]:
        raise GovernanceError("declared_scope must not be empty")
    if not isinstance(candidate["output_schema"], dict) or not candidate["output_schema"]:
        raise GovernanceError("output_schema must be a non-empty object")
    _validate_output_schema(candidate["output_schema"])
    if not candidate["fixture_set"]:
        raise GovernanceError("fixture_set must not be empty")
    if not isinstance(candidate["health_thresholds"], dict):
        raise GovernanceError("health_thresholds must be an object")
    # Plan 023 v3 §C-4 — range invariant on threshold values.
    _validate_health_thresholds_ranges(candidate["health_thresholds"])
    if not isinstance(candidate["allowed_read_globs"], list) or not candidate["allowed_read_globs"]:
        raise GovernanceError("allowed_read_globs must be a non-empty array")
    if not isinstance(candidate["forbidden_read_globs"], list):
        raise GovernanceError("forbidden_read_globs must be an array")
    if not isinstance(candidate["claim_types"], list) or not candidate["claim_types"]:
        raise GovernanceError("claim_types must be a non-empty array")
    if "default_input" in candidate and not isinstance(candidate["default_input"], dict):
        raise GovernanceError("default_input must be a JSON object when provided")

    # E13-C11 — freshness metadata (see DEFAULT_FRESHNESS_WINDOW_HOURS
    # comment for the full WHY). Optional in the manifest; defaulted when
    # absent (same pattern as health_thresholds), type-checked when present.
    freshness = candidate.get("freshness_window_hours")
    if freshness is None:
        candidate["freshness_window_hours"] = DEFAULT_FRESHNESS_WINDOW_HOURS
    elif isinstance(freshness, bool) or not isinstance(freshness, (int, float)) or freshness <= 0:
        raise GovernanceError(
            f"freshness_window_hours must be a positive number, got {freshness!r}"
        )
    # parse_window_signature is DERIVED from the declaration; when a
    # manifest carries it, it MUST match the recomputation — a mismatch
    # means the declaration changed without acknowledging that recorded
    # SHADOW evidence no longer covers the new parse window. Silent
    # correction would recreate the decorative-field defect this closes.
    declared_sig = candidate.get("parse_window_signature")
    computed_sig = parse_window_signature(candidate)
    if declared_sig is None:
        candidate["parse_window_signature"] = computed_sig
    elif not isinstance(declared_sig, str) or not declared_sig.strip():
        raise GovernanceError("parse_window_signature must be a non-empty string")
    elif declared_sig != computed_sig:
        raise GovernanceError(
            f"parse_window_signature_mismatch: tool_id={candidate.get('tool_id')!r} "
            f"declares {declared_sig!r} but the declaration-derived signature is "
            f"{computed_sig!r}; recompute it after changing any of {PARSE_WINDOW_FIELDS}"
        )

    thresholds = dict(DEFAULT_HEALTH_THRESHOLDS)
    thresholds.update(candidate["health_thresholds"])
    candidate["health_thresholds"] = thresholds
    if candidate["status"] in RUNNER_REQUIRED_STATUSES and "runner" not in candidate:
        raise GovernanceError(f"{candidate['status']} tool requires runner configuration")
    if "runner" in candidate:
        candidate["runner"] = validate_runner_definition(candidate["runner"])
    candidate.setdefault("created_at", utc_now())
    candidate["updated_at"] = utc_now()
    return candidate


def validate_runner_definition(runner: Any) -> dict[str, Any]:
    if not isinstance(runner, dict):
        raise GovernanceError("runner must be a JSON object")
    candidate = deepcopy(runner)
    if candidate.get("type") not in RUNNER_TYPES:
        raise GovernanceError(f"unknown runner type: {candidate.get('type')}")
    argv = candidate.get("argv")
    if not isinstance(argv, list) or not argv:
        raise GovernanceError("runner.argv must be a non-empty array")
    if not all(isinstance(part, str) and part.strip() for part in argv):
        raise GovernanceError("runner.argv must contain only non-empty strings")
    if len(argv) >= 2 and argv[0] == "npx" and argv[1] == "ts-node":
        candidate["argv"] = ["node", "./node_modules/ts-node/dist/bin.js", *argv[2:]]
    cwd = candidate.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        raise GovernanceError("runner.cwd must be a non-empty string")
    cwd_path = Path(cwd)
    if cwd_path.is_absolute() or ".." in cwd_path.parts:
        raise GovernanceError("runner.cwd must be relative to the workspace root and must not escape it")
    try:
        verify_bash_command_allowed(list(candidate["argv"]), cwd=cwd)
    except Exception as exc:
        raise GovernanceError(f"runner.argv_rejected_by_command_policy:{exc}") from exc
    timeout_ms = candidate.get("timeout_ms")
    if not isinstance(timeout_ms, int) or timeout_ms <= 0:
        raise GovernanceError("runner.timeout_ms must be a positive integer")
    # Optional memory budget for node runners; the tool_runner defaults to
    # 2048 MB when absent. Declared here so a wide-scope adapter can raise
    # its ceiling in the manifest instead of inheriting the host's accident.
    node_heap = candidate.get("node_max_old_space_mb")
    if node_heap is not None and (not isinstance(node_heap, int) or node_heap <= 0):
        raise GovernanceError("runner.node_max_old_space_mb must be a positive integer")
    if not isinstance(candidate.get("stdin_json"), bool):
        raise GovernanceError("runner.stdin_json must be a boolean")
    return candidate


def register_tool(
    tool: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Register a new tool or refresh an existing manifest.

    Plan 022 §C-2 — re-registration is gated against the status transition
    matrix so a manifest reload cannot bypass QUARANTINED -> ACTIVE
    discipline:

    - QUARANTINED on disk + any non-QUARANTINED in candidate -> reject.
      Use unquarantine_tool() (which delegates through transition_tool)
      to legitimately move a quarantined tool back into circulation.
    - ACTIVE/CALIBRATE on disk + SHADOW/SANDBOX/DRAFT in candidate ->
      reject. Use transition_tool(target_status='SHADOW', ...) for an
      explicit demotion with reason audit trail.
    - Same status (manifest hash drift) -> allow. Parser/runner update
      path; transition matrix preserved.
    - Forward progression (DRAFT -> SANDBOX/SHADOW) -> allow.
    """
    candidate = validate_tool_definition(tool)
    registry = load_registry(base_dir)
    existing_rows = [t for t in registry["tools"] if t.get("tool_id") == candidate["tool_id"]]
    if existing_rows:
        existing = existing_rows[0]
        existing_status = existing.get("status")
        candidate_status = candidate.get("status")
        # QUARANTINED is a terminal-ish state; anything but a quarantined
        # re-register requires the operator-driven unquarantine path.
        if existing_status == "QUARANTINED" and candidate_status != "QUARANTINED":
            raise GovernanceError(
                f"register_tool blocked: tool_id={candidate['tool_id']!r} is "
                f"QUARANTINED on disk; cannot re-register as {candidate_status!r} via "
                f"manifest reload. Use unquarantine_tool() for an audited "
                f"QUARANTINED -> CALIBRATE transition."
            )
        # Promotions through SHADOW -> ACTIVE require precision/evidence
        # validation that only transition_tool() performs. Block bare
        # re-registration that tries to skip the matrix.
        if existing_status in {"DRAFT", "SANDBOX", "SHADOW", "CALIBRATE"} and candidate_status == "ACTIVE":
            raise GovernanceError(
                f"register_tool blocked: tool_id={candidate['tool_id']!r} promotion "
                f"{existing_status!r} -> 'ACTIVE' must route through transition_tool() "
                f"with precision + evidence_chains_valid + operator_approval."
            )
        # Demotions from ACTIVE/CALIBRATE down to early-lifecycle states
        # similarly require an explicit reason audit trail.
        if existing_status in {"ACTIVE", "CALIBRATE"} and candidate_status in {"SHADOW", "SANDBOX", "DRAFT"}:
            raise GovernanceError(
                f"register_tool blocked: tool_id={candidate['tool_id']!r} demotion "
                f"{existing_status!r} -> {candidate_status!r} must route through "
                f"transition_tool() with an explicit reason."
            )
        registry["tools"] = [
            candidate if t.get("tool_id") == candidate["tool_id"] else t for t in registry["tools"]
        ]
    else:
        # Plan 023 v3 §C-3 — first-time registration MUST land in an
        # initial-lifecycle state (DRAFT / SANDBOX / SHADOW). Pre-fix
        # this branch silently appended the candidate at any status,
        # letting `register_tool({status: 'ACTIVE'})` skip the
        # transition_tool() promotion matrix. The only path to ACTIVE /
        # CALIBRATE / QUARANTINED / ARCHIVED is now an explicit
        # transition after a prior initial registration.
        candidate_status = candidate.get("status")
        if candidate_status not in INITIAL_LIFECYCLE_STATES:
            raise GovernanceError(
                "first_register_status_must_be_initial_lifecycle_state: "
                f"tool_id={candidate['tool_id']!r} cannot register at "
                f"{candidate_status!r}; must be one of {INITIAL_LIFECYCLE_STATES}. "
                f"Use register_tool with an initial state then transition_tool() "
                f"to promote."
            )
        registry["tools"].append(candidate)
        # Audit-trail: emit governance event so operator can see initial
        # registrations and their starting lifecycle state. The event
        # payload captures tool_id + initial_status for downstream
        # health and lifecycle review.
        append_tools_governance(
            ensure_tools_dir(base_dir),
            "tool_registered_initial",
            {
                "tool_id": candidate["tool_id"],
                "initial_status": candidate_status,
                "version": candidate.get("version"),
            },
        )
    registry["schema_version"] = SCHEMA_VERSION
    save_registry(registry, base_dir)
    return candidate


def unquarantine_tool(
    tool_id: str,
    *,
    operator_approval_ref: str,
    reason: str,
    root_cause_note: str,
    fixture_update_ref: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Plan 022 §C-2 — operator-driven QUARANTINED -> CALIBRATE transition.

    Companion to the register_tool guard: when a tool is QUARANTINED, the
    only legitimate path back into circulation is through this API, which
    routes through transition_tool() so the lifecycle audit trail
    (root_cause_note + fixture_update_ref + last_transition entry) is
    preserved.
    """
    if not (operator_approval_ref or "").strip():
        raise GovernanceError("unquarantine_tool requires operator_approval_ref")
    if not (reason or "").strip():
        raise GovernanceError("unquarantine_tool requires reason")
    tool = get_tool(tool_id, base_dir)
    if tool.get("status") != "QUARANTINED":
        raise GovernanceError(
            f"unquarantine_tool: tool_id={tool_id!r} is not QUARANTINED "
            f"(current status={tool.get('status')!r})"
        )
    return transition_tool(
        tool_id,
        target_status="CALIBRATE",
        reason=f"unquarantine: {reason} (operator_approval_ref={operator_approval_ref})",
        root_cause_note=root_cause_note,
        fixture_update_ref=fixture_update_ref,
        operator_approval=True,
        base_dir=base_dir,
    )


def get_tool(
    tool_id: str,
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    for tool in load_registry(base_dir)["tools"]:
        if tool.get("tool_id") == tool_id:
            return deepcopy(tool)
    raise GovernanceError(f"tool not found: {tool_id}")


def list_tools(
    status: str | None = None,
    base_dir: str | os.PathLike[str] | None = None,
) -> list[dict[str, Any]]:
    if status is not None and status not in TOOL_STATUSES:
        raise GovernanceError(f"unknown lifecycle state: {status}")
    tools = load_registry(base_dir)["tools"]
    if status is not None:
        tools = [tool for tool in tools if tool.get("status") == status]
    return deepcopy(tools)


# Plan 022 §C-2b — runner/scope fields whose changes require an
# explicit operator_approval_ref via update_tool. (status is handled
# separately — it must route through transition_tool.)
# Plan 023 v3 §C-4 — health_thresholds added: rewriting the
# demotion / quarantine / calibrate trigger thresholds is a
# governance-level mutation of the tool's lifecycle gates and must be
# operator-audited. tool_health_thresholds_updated governance event
# fires on every accepted change.
_OPERATOR_APPROVAL_GATED_FIELDS: tuple[str, ...] = (
    "runner",
    "allowed_read_globs",
    "forbidden_read_globs",
    "declared_scope",
    "health_thresholds",
)


def _validate_health_thresholds_ranges(thresholds: Any) -> None:
    """Plan 023 v3 §C-4 — per-field range invariant.

    Out-of-range threshold values disable the lifecycle gates they're
    supposed to enforce: precision_min=0 lets every adapter through,
    critical_false_positives=999 disables critical-FP quarantine,
    crash_rate_last_10=1.0 lets a runner crash on every call without
    auto-calibrate. The invariant fires at validate_tool_definition
    time AND in update_tool's revalidation path so neither register_
    nor update_ can land bad ranges.
    """
    if not isinstance(thresholds, dict):
        raise GovernanceError("health_thresholds must be an object")
    precision = thresholds.get("precision_min")
    if precision is not None:
        if not isinstance(precision, (int, float)) or not (0.5 <= float(precision) <= 1.0):
            raise GovernanceError(
                f"health_thresholds_out_of_range: precision_min={precision!r} "
                f"must be a float in [0.5, 1.0]"
            )
    cfp = thresholds.get("critical_false_positives")
    if cfp is not None:
        if not isinstance(cfp, int) or isinstance(cfp, bool) or cfp != 0:
            raise GovernanceError(
                f"health_thresholds_out_of_range: critical_false_positives={cfp!r} "
                f"must be exactly 0 (any nonzero value disables critical-FP quarantine)"
            )
    crash = thresholds.get("crash_rate_last_10")
    if crash is not None:
        if not isinstance(crash, (int, float)) or not (0.0 <= float(crash) <= 0.5):
            raise GovernanceError(
                f"health_thresholds_out_of_range: crash_rate_last_10={crash!r} "
                f"must be a float in [0.0, 0.5]"
            )
    nc_fp = thresholds.get("non_critical_false_positives_30d")
    if nc_fp is not None:
        if not isinstance(nc_fp, int) or isinstance(nc_fp, bool) or not (1 <= nc_fp <= 100):
            raise GovernanceError(
                f"health_thresholds_out_of_range: non_critical_false_positives_30d={nc_fp!r} "
                f"must be an int in [1, 100]"
            )


def _update_tool_internal(
    tool_id: str,
    updates: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
) -> dict[str, Any]:
    """Plan 022 §C-2b — unguarded merge primitive used by transition_tool.

    Direct callers MUST go through public update_tool() which gates
    status changes (must route through transition_tool) and runner/
    scope changes (require operator_approval_ref). This private path
    exists so transition_tool() — which is itself the audited state
    machine — can write its own status + last_transition update without
    self-blocking.
    """
    registry = load_registry(base_dir)
    updated: dict[str, Any] | None = None
    next_tools = []
    for tool in registry["tools"]:
        if tool.get("tool_id") == tool_id:
            merged = dict(tool)
            merged.update(updates)
            merged["updated_at"] = utc_now()
            updated = merged
            next_tools.append(merged)
        else:
            next_tools.append(tool)
    if updated is None:
        raise GovernanceError(f"tool not found: {tool_id}")
    registry["tools"] = next_tools
    save_registry(registry, base_dir)
    return deepcopy(updated)


def update_tool(
    tool_id: str,
    updates: dict[str, Any],
    base_dir: str | os.PathLike[str] | None = None,
    *,
    operator_approval_ref: str | None = None,
    reason: str | None = None,
) -> dict[str, Any]:
    """Plan 022 §C-2b — guarded public update_tool.

    Pre-Plan-022 update_tool() merged the updates dict directly without
    revalidating, without enforcing the status transition matrix, and
    without auditing runner/scope changes. A caller could promote a
    tool to ACTIVE (skipping precision + evidence + approval checks) or
    silently widen its scope just by passing the new fields here.

    Guards:
    1. Status changes are forbidden via update_tool — must route through
       transition_tool() (which internally calls _update_tool_internal).
       The error directs callers to the legitimate API.
    2. Runner / allowed_read_globs / forbidden_read_globs / declared_scope
       changes require operator_approval_ref + reason; emits
       tool_runner_replaced governance event when runner.argv differs
       so audit history captures the swap.
    3. Merged candidate is re-validated via validate_tool_definition so
       the post-update row is still well-formed.
    """
    if "status" in updates:
        raise GovernanceError(
            f"status_change_must_route_through_transition_tool: "
            f"tool_id={tool_id!r} update_tool() does not accept status field; "
            f"call transition_tool(tool_id, target_status, reason=...) instead"
        )
    gated_present = [f for f in _OPERATOR_APPROVAL_GATED_FIELDS if f in updates]
    if gated_present:
        if not (operator_approval_ref or "").strip():
            raise GovernanceError(
                f"runner_or_scope_change_requires_operator_approval: "
                f"tool_id={tool_id!r} update_tool() touching {gated_present} "
                f"requires operator_approval_ref kwarg"
            )
        if not (reason or "").strip():
            raise GovernanceError(
                f"runner_or_scope_change_requires_operator_approval: "
                f"tool_id={tool_id!r} update_tool() touching {gated_present} "
                f"requires reason kwarg"
            )

    # Capture pre-update runner argv so we can emit tool_runner_replaced
    # only when it actually changes.
    pre_runner_argv: list[str] | None = None
    if "runner" in updates:
        try:
            pre_runner_argv = list((get_tool(tool_id, base_dir).get("runner") or {}).get("argv", []))
        except GovernanceError:
            pre_runner_argv = None

    # Merge + re-validate.
    pre = get_tool(tool_id, base_dir)
    # E13-C11 — parse_window_signature is DERIVED from the parse-window
    # declaration. When an operator-approved update changes any declaration
    # field without explicitly supplying a matching signature, recompute it
    # here (mirroring the updated_at refresh) instead of letting the stored
    # stale hash trip the validator's mismatch gate. An explicitly supplied
    # signature is still verified strictly by validate_tool_definition.
    if set(PARSE_WINDOW_FIELDS) & set(updates) and "parse_window_signature" not in updates:
        merged_declaration = dict(pre)
        merged_declaration.update(updates)
        updates = dict(updates)
        updates["parse_window_signature"] = parse_window_signature(merged_declaration)
    merged_for_validation = dict(pre)
    merged_for_validation.update(updates)
    validate_tool_definition(merged_for_validation)

    result = _update_tool_internal(tool_id, updates, base_dir)

    # Audit runner.argv swaps post-merge.
    if "runner" in updates:
        new_argv = list((result.get("runner") or {}).get("argv", []))
        if pre_runner_argv != new_argv:
            tools_root = ensure_tools_dir(base_dir)
            append_tools_governance(
                tools_root,
                "tool_runner_replaced",
                {
                    "tool_id": tool_id,
                    "previous_argv": pre_runner_argv,
                    "new_argv": new_argv,
                    "reason": reason,
                    "operator_approval_ref": operator_approval_ref,
                },
            )

    # Plan 023 v3 §C-4 — emit tool_health_thresholds_updated when the
    # field actually changed. Captures pre + post for operator audit
    # so demotion / quarantine / calibrate trigger rewrites are
    # readable from governance.jsonl alone.
    if "health_thresholds" in updates:
        tools_root = ensure_tools_dir(base_dir)
        append_tools_governance(
            tools_root,
            "tool_health_thresholds_updated",
            {
                "tool_id": tool_id,
                "previous_thresholds": pre.get("health_thresholds"),
                "new_thresholds": result.get("health_thresholds"),
                "reason": reason,
                "operator_approval_ref": operator_approval_ref,
            },
        )

    return result


# Plan 026R §E.10 — forbidden direct-to-ACTIVE source states.
# Lifecycle invariant: a tool can only reach ACTIVE via the documented
# SHADOW -> ACTIVE promotion path (with precision threshold + operator
# approval). Pre-§E.10 the kernel only checked CALIBRATE explicitly;
# every other source state silently succeeded.
_FORBIDDEN_ACTIVE_SOURCES: frozenset[str] = frozenset({
    "DRAFT", "SANDBOX", "ARCHIVED", "QUARANTINED", "CALIBRATE",
})


def transition_tool(
    tool_id: str,
    target_status: str,
    *,
    reason: str,
    base_dir: str | os.PathLike[str] | None = None,
    root_cause_note: str | None = None,
    fixture_update_ref: str | None = None,
    fixture_suite_passed: bool = False,
    operator_approval: bool = False,
    auto_promote_token: str | None = None,
    panel_approval_token: str | None = None,
    precision: float | None = None,
    critical_false_positives: int = 0,
    evidence_chains_valid: bool = False,
) -> dict[str, Any]:
    """Plan ARIA-V6 §2e v2 B-V1-1 — auto_promote_token added.

    The ``auto_promote_token`` kwarg substitutes for ``operator_
    approval`` ONLY when the genesis_policy ``auto_promote`` block is
    enabled, the runtime profile is ``autonomous``, the adapter's
    precision history shows ≥ ``min_precision`` over ≥
    ``min_clean_cycles`` consecutive runs, and ``critical_false_
    positives`` over that window is zero. The token is generated by
    ``adapter_calibration.compute_auto_promote_token(tool_id, base_dir)``
    which inspects the precision_history ledger; tamper-evident hash
    over (tool_id, last_N runs, base_dir contract hash).

    JJ-2b (ORPHAN-HIGH-732) — ``panel_approval_token`` is the THIRD
    authority. Operator directive 2026-08-18: promotion to ACTIVE is
    PANEL-APPROVED with a 24-hour operator VETO window, not operator-
    approved. The token is minted by ``promotion_veto.compute_panel_
    approval_token`` ONLY after the kernel has re-derived the panel approval
    from the human-required adjudication record (exists, resolved, resolved_
    by=agent_panel, kind=tool_promotion, context.tool_id matches) AND the
    veto window elapsed with no veto recorded. A kernel-scoped adapter can
    never obtain one — that exception is enforced at mint time, where the
    scope is readable, and kernel scope is decided by the runtime glob
    evaluator, not by how the manifest spells its globs.

    What the token is NOT: a value this function verifies. Like the auto-
    promote token it is a workspace-bound HMAC — but unlike the auto-
    promote token (whose consume-time MAC verification is wired since
    ORPHAN-HIGH-787), the panel token's verification lives at its MINT:
    ``promotion_veto.compute_panel_approval_token`` re-derives the panel
    approval from the human-required adjudication record before signing,
    so the kernel-side mint IS the check. Calling the panel token
    "unforgeable HERE" would describe a consume-time check that does not
    exist; its load-bearing gates are upstream, at mint.

    The literal predicate (I-V6.4-04 source-substring invariant pins):

        if (not operator_approval and not _auto_promote_verified and not panel_approval_token) or not evidence_chains_valid:

    preserves V5's evidence_chains_valid check unchanged; no authority
    can bypass evidence chain integrity — it is still the LAST clause and
    still short-circuits independently of who vouched. Precision + FP
    thresholds above this line are also UNCHANGED.
    """
    if target_status not in TOOL_STATUSES:
        raise GovernanceError(f"unknown lifecycle state: {target_status}")
    if not reason:
        raise GovernanceError("transition reason is required")

    tool = get_tool(tool_id, base_dir)
    if target_status in RUNNER_REQUIRED_STATUSES and "runner" not in tool:
        raise GovernanceError(f"{target_status} tool requires runner configuration")
    current = tool["status"]
    if current == "QUARANTINED" and target_status == "CALIBRATE":
        if not root_cause_note or not fixture_update_ref:
            raise GovernanceError(
                "QUARANTINED -> CALIBRATE requires root_cause_note and fixture_update_ref",
            )
    if current == "CALIBRATE" and target_status == "SHADOW" and not fixture_suite_passed:
        raise GovernanceError("CALIBRATE -> SHADOW requires fixture_suite_passed")
    if target_status == "ACTIVE":
        # Plan 026R §E.10 — explicit lifecycle matrix. Pre-§E.10 only
        # ``CALIBRATE → ACTIVE`` and ``SHADOW → ACTIVE`` were
        # explicitly checked; ``DRAFT → ACTIVE`` /
        # ``SANDBOX → ACTIVE`` / ``ARCHIVED → ACTIVE`` /
        # ``QUARANTINED → ACTIVE`` silently succeeded because no
        # branch handled them. The matrix below names every forbidden
        # source explicitly so the kernel rejects the typo /
        # malicious / accident.
        if current in _FORBIDDEN_ACTIVE_SOURCES:
            raise GovernanceError(
                f"tool_lifecycle_forbidden_active_promotion: "
                f"{current} -> ACTIVE is not permitted. "
                f"Forbidden sources: {sorted(_FORBIDDEN_ACTIVE_SOURCES)}. "
                f"Use the documented lifecycle path (e.g. SHADOW -> "
                f"ACTIVE with precision threshold + operator approval)."
            )
        threshold = float(tool["health_thresholds"].get("precision_min", 0.85))
        if current == "SHADOW":
            if precision is None or precision < threshold:
                raise GovernanceError("SHADOW -> ACTIVE requires precision above threshold")
            if critical_false_positives > 0:
                raise GovernanceError("SHADOW -> ACTIVE requires zero critical false positives")
            # Plan ARIA-V6 §2e v2 B-V1-1 — literal predicate pinned by
            # I-V6.4-04 source-substring invariant. The order of the
            # boolean clauses is load-bearing: evidence_chains_valid
            # is checked LAST so it short-circuits independently of
            # the operator_approval / auto_promote_token /
            # panel_approval_token path. A refactor that reorders OR
            # drops any clause silently weakens the SHADOW -> ACTIVE
            # gate. JJ-2b added the panel clause; the pin was rewritten
            # with it, never deleted to make a test pass.
            # ORPHAN-HIGH-787 — the auto-promote token is VERIFIED, not
            # counted: verify_auto_promote_token recomputes the
            # workspace-bound HMAC over the envelope's payload and its
            # tool binding, so a fabricated string, a cross-workspace
            # replay or a cross-tool replay all read as "no token".
            # Late import: adapter_calibration reads tool_registry at
            # module level, so a top-level import would be a cycle.
            _auto_promote_verified = False
            if auto_promote_token:
                from .adapter_calibration import verify_auto_promote_token

                _auto_promote_verified = (
                    verify_auto_promote_token(
                        auto_promote_token, tool_id=tool_id, base_dir=base_dir
                    )
                    is not None
                )
            if (not operator_approval and not _auto_promote_verified and not panel_approval_token) or not evidence_chains_valid:
                raise GovernanceError(
                    "SHADOW -> ACTIVE requires valid evidence chains and "
                    "(operator_approval OR auto_promote_token OR "
                    "panel_approval_token under safe conditions)",
                )

    # Plan 022 §C-2b — transition_tool is the audited state machine;
    # write its own status + last_transition update via the internal
    # primitive so the public update_tool() guard does not self-block.
    return _update_tool_internal(
        tool_id,
        {
            "status": target_status,
            "last_transition": {
                "at": utc_now(),
                "from": current,
                "to": target_status,
                "reason": reason,
            },
        },
        base_dir,
    )


def _require_string(tool: dict[str, Any], field: str) -> None:
    if not isinstance(tool.get(field), str) or not tool[field].strip():
        raise GovernanceError(f"{field} must be a non-empty string")


def _validate_output_schema(schema: dict[str, Any]) -> None:
    required = schema.get("required")
    if required is not None and (
        not isinstance(required, list)
        or not all(isinstance(field, str) and field.strip() for field in required)
    ):
        raise GovernanceError("output_schema.required must be an array of non-empty strings")
    # Plan 023 v3 §C-2 — every ARIA tool, finding-emitting or not, MUST
    # declare read_paths in its output_schema.required. read_paths is
    # the load-bearing self-report for what the adapter inspected;
    # downstream scope-out detection (C-1) and evidence subset
    # enforcement (M-2 + C-2) cannot work without the field. Tools that
    # genuinely read nothing declare read_paths: [] in their output —
    # registration enforces presence, runtime treats empty list as
    # "no reads" (subset rejects any evidence ref).
    if not isinstance(required, list) or "read_paths" not in required:
        raise GovernanceError(
            "output_schema.required must include 'read_paths' (Plan 023 §C-2)"
        )
