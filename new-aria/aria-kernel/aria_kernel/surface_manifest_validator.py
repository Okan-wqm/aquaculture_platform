"""Plan 020 Phase 11 — surface manifest validator.

WHY this module exists
----------------------
ARIA's runtime depends on multiple manifests staying in sync:
- .claude/agents/**/*.md frontmatter shape (name + tools + model + ...).
- agent_contract.DEFAULT_TARGET_AGENT_WHITELIST entries map to real .md
  files (root + _maintenance + product-audit lookup).
- agent_contract.ROLE_TARGET_PAIRING entries reference whitelist agents.
- aria-tools/registry.json runner.argv paths resolve on disk.
- docs/aria/plans/*.md don't reference RESOLVED debts as 'in progress'.
- _maintenance kernel agents don't sneak into domain reviewer or
  product-audit roster.

Pre-Plan-020 there was no closed-loop validator — drift surfaced as
runtime errors only. Phase 11 implements 6 validators that fail-closed at
PR time via the CI invariant test (tests/invariants/aria-surface-manifest
.spec.ts).

6 validators (Plan v3.3 §Phase 11.A — operator gap #7 parity rule fix)
----------------------------------------------------------------------
1. validate_agent_frontmatter
   .claude/agents/**/*.md AGENT files have required frontmatter (name,
   description, model, tools). README.md and non-agent docs (no
   frontmatter) are EXCLUDED.

2. validate_target_agent_existence (RENAMED from target_agent_parity)
   For every entry in agent_contract.DEFAULT_TARGET_AGENT_WHITELIST,
   resolve_agent_md_path returns a real file. The reverse is NOT a
   validator (whitelist is intentionally smaller than the full agent
   roster — domain reviewers exist but are not whitelisted for kernel
   dispatch).

3. validate_role_target_pairing
   Every (role, target_agent) tuple in ROLE_TARGET_PAIRING references a
   whitelist member that has a real .md file.

4. validate_registry_runner_paths
   aria-tools/registry.json adapters' runner.argv first non-flag token
   resolves on disk under the runner.cwd.

5. validate_plan_doc_freshness
   docs/aria/plans/*.md don't cite a debt_id whose current_status is
   RESOLVED but the plan still describes it as IN_PROGRESS.

6. validate_maintenance_agent_isolation
   .claude/agents/_maintenance/**/*.md kernel-bound agents (aria-primary-
   planner, aria-challenger-planner, aria-prompt-writer) are NOT the
   target of domain-reviewer roles in ROLE_TARGET_PAIRING and do NOT
   appear in product-audit-* prefix listings.

Plan 020 surface
----------------
surface_validations is in OBSERVE_PERMITTED_SURFACES (validator finding =
observation-class) AND in PLAN_020_WRITE_SURFACES (frozen blocks the
persist). Observe profiles can run validation; frozen blocks even
validation persists (safety boundary).
"""
from __future__ import annotations

import json
import re
import shlex
from pathlib import Path
from typing import Any

from .agent_resolver import resolve_agent_md_path
from .ledger import append_declared_jsonl, read_jsonl
from .runtime_profile import enforce_profile_for_write
from .tool_registry import (
    GovernanceError,
    append_tools_governance,
    ensure_tools_dir,
    ensure_tools_dir_readonly,
    utc_now,
)

VALIDATIONS_FILENAME = "surface-validations.jsonl"

VALIDATOR_NAMES: tuple[str, ...] = (
    "validate_agent_frontmatter",
    "validate_target_agent_existence",
    "validate_role_target_pairing",
    "validate_registry_runner_paths",
    "validate_plan_doc_freshness",
    "validate_maintenance_agent_isolation",
    # Plan 022 §M-6 — 7th validator. Enforces registry <-> adapter
    # manifest sync; intentional shadow_runner stubs must be in the
    # explicit allowlist (aria-tools/registry-stub-allowlist.json).
    "validate_registry_adapter_sync",
)

REQUIRED_FRONTMATTER_FIELDS: tuple[str, ...] = ("name", "description", "tools")
_FRONTMATTER_RE = re.compile(r"^---\n(.*?)\n---", re.DOTALL)
_FIELD_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*):", re.MULTILINE)
_DEBT_REF_RE = re.compile(r"DEBT-\d{4}-\d{2}-\d{2}-\d{3}")


def _agent_md_files(repo_root: Path) -> list[Path]:
    matches: list[Path] = []
    for pattern in (".claude/agents/**/*.md",):
        for path in repo_root.glob(pattern):
            if path.is_file() and path.name != "README.md":
                matches.append(path)
    return matches


def validate_agent_frontmatter(*, repo_root: Path) -> list[dict[str, Any]]:
    """Layer 1: every agent .md (excluding non-agent README/docs) has the
    required frontmatter fields."""
    failures: list[dict[str, Any]] = []
    for path in _agent_md_files(repo_root):
        rel = path.relative_to(repo_root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            failures.append({"validator": "validate_agent_frontmatter",
                            "ref": rel, "reason": "unreadable"})
            continue
        if not content.startswith("---"):
            # Non-agent doc heuristic — not a frontmatter file. Skip.
            continue
        match = _FRONTMATTER_RE.match(content)
        if not match:
            failures.append({"validator": "validate_agent_frontmatter",
                            "ref": rel, "reason": "frontmatter_unparseable"})
            continue
        fm_text = match.group(1)
        fields = set(_FIELD_RE.findall(fm_text))
        missing = [f for f in REQUIRED_FRONTMATTER_FIELDS if f not in fields]
        if missing:
            failures.append({"validator": "validate_agent_frontmatter",
                            "ref": rel, "reason": "missing_fields",
                            "missing": missing})
    return failures


def validate_target_agent_existence(*, repo_root: Path) -> list[dict[str, Any]]:
    """Layer 2: every whitelist entry resolves to a real .md (root +
    _maintenance + product-audit search per agent_resolver)."""
    from .agent_contract import DEFAULT_TARGET_AGENT_WHITELIST
    failures: list[dict[str, Any]] = []
    for target in DEFAULT_TARGET_AGENT_WHITELIST:
        path = resolve_agent_md_path(target, repo_root)
        if path is None:
            failures.append({
                "validator": "validate_target_agent_existence",
                "target_agent": target,
                "reason": "no_md_file_in_root_maintenance_or_product_audit",
            })
    return failures


def validate_role_target_pairing(*, repo_root: Path) -> list[dict[str, Any]]:
    """Layer 3: every (role, target) pair references a real whitelist
    member with a real .md file."""
    from .agent_contract import DEFAULT_TARGET_AGENT_WHITELIST, ROLE_TARGET_PAIRING
    whitelist = set(DEFAULT_TARGET_AGENT_WHITELIST)
    failures: list[dict[str, Any]] = []
    for role, targets in ROLE_TARGET_PAIRING.items():
        for target in targets:
            if target not in whitelist:
                failures.append({
                    "validator": "validate_role_target_pairing",
                    "role": role, "target": target,
                    "reason": "target_not_in_whitelist",
                })
                continue
            if resolve_agent_md_path(target, repo_root) is None:
                failures.append({
                    "validator": "validate_role_target_pairing",
                    "role": role, "target": target,
                    "reason": "target_md_file_missing",
                })
    return failures


def validate_registry_runner_paths(*, repo_root: Path,
                                    base_dir: str | Path | None) -> list[dict[str, Any]]:
    """Layer 4: every adapter row's runner.argv first non-flag token
    resolves under runner.cwd."""
    failures: list[dict[str, Any]] = []
    registry_path = repo_root / (str(base_dir) if base_dir else "aria-tools") / "registry.json"
    if not registry_path.exists():
        return failures
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [{
            "validator": "validate_registry_runner_paths",
            "reason": "registry_unreadable", "error": str(exc),
        }]
    for tool in registry.get("tools", []):
        runner = tool.get("runner") or {}
        argv = runner.get("argv") or []
        cwd = runner.get("cwd", ".")
        if not argv:
            continue
        # Plan 023 v3 §C-5 — wrapper-skip script-arg picking.
        # Pre-fix `next(a for a in argv if a.endswith(('.ts','.py','.js')))`
        # picked the first .ts/.py/.js token, which mismatches argv shapes
        # like ["node", "./node_modules/ts-node/dist/bin.js", "adapter.ts"]:
        # bin.js is a wrapper, not the real adapter. Post-fix: explicitly
        # skip known wrappers (node / ts-node / python3 / npx / deno /
        # bun) plus any node_modules/.../bin.{js,cjs,mjs} pattern, then
        # pick the first remaining .ts/.py/.js/.mjs arg as the script.
        script_arg = _pick_script_arg(argv)
        if script_arg is None:
            failures.append({
                "validator": "validate_registry_runner_paths",
                "tool_id": tool.get("tool_id"),
                "reason": "runner_argv_no_non_wrapper_script_path",
                "argv": argv,
            })
            continue
        candidate = repo_root / cwd / script_arg
        if not candidate.exists():
            failures.append({
                "validator": "validate_registry_runner_paths",
                "tool_id": tool.get("tool_id"),
                "reason": "runner_script_missing",
                "expected_path": str(candidate),
            })
    return failures


# Plan 023 v3 §C-5 — known runner-wrapper tokens. The validator skips
# these when picking the real-script argument so wrappers cannot mask
# the actual adapter path under existence-checking.
_KNOWN_RUNNER_WRAPPERS: frozenset[str] = frozenset({
    "node", "ts-node", "python", "python3", "python3.11", "python3.12",
    "npx", "deno", "bun",
})
import re as _re_mod  # noqa: E402

_NODE_MODULES_BIN_RE = _re_mod.compile(r"node_modules/.+/bin\.(js|cjs|mjs)$")


def _is_runner_wrapper(arg: str) -> bool:
    """True if arg is a known language-runner wrapper that should be
    skipped when picking the real-script argument from runner.argv."""
    if arg in _KNOWN_RUNNER_WRAPPERS:
        return True
    if _NODE_MODULES_BIN_RE.search(arg):
        return True
    return False


def _pick_script_arg(argv: list[str]) -> str | None:
    """Return the first argv entry that (a) has a script-like suffix
    and (b) is not a known runner wrapper. Returns None if every
    candidate looks like a wrapper or no suffix matches at all."""
    for a in argv:
        if not isinstance(a, str):
            continue
        if not (a.endswith(".ts") or a.endswith(".py") or a.endswith(".js") or a.endswith(".mjs")):
            continue
        if _is_runner_wrapper(a):
            continue
        return a
    return None


def validate_plan_doc_freshness(*, repo_root: Path) -> list[dict[str, Any]]:
    """Layer 5: docs/aria/plans/*.md don't reference RESOLVED debts as
    open or in-progress work."""
    plans_dir = repo_root / "docs" / "aria" / "plans"
    if not plans_dir.exists():
        return []
    debts_dir = repo_root / "aria-debts"
    if not debts_dir.exists():
        return []
    resolved_ids: set[str] = set()
    for debt_path in debts_dir.glob("DEBT-*.json"):
        try:
            d = json.loads(debt_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if d.get("current_status") == "RESOLVED":
            resolved_ids.add(d.get("debt_id"))
    failures: list[dict[str, Any]] = []
    for plan_path in plans_dir.glob("*.md"):
        try:
            content = plan_path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        for did in _DEBT_REF_RE.findall(content):
            if did in resolved_ids:
                # Look at neighbouring text — flag only if 'open' or
                # 'in progress' appears within ±100 chars of the ref.
                idx = content.find(did)
                window = content[max(0, idx - 100): idx + 100].lower()
                if "open" in window or "in progress" in window or "in_progress" in window:
                    failures.append({
                        "validator": "validate_plan_doc_freshness",
                        "plan": plan_path.relative_to(repo_root).as_posix(),
                        "debt_id": did,
                        "reason": "resolved_debt_referenced_as_open",
                    })
    return failures


def validate_maintenance_agent_isolation(*, repo_root: Path) -> list[dict[str, Any]]:
    """Layer 6: _maintenance kernel agents don't appear as domain reviewers
    or in the product-audit-* roster.

    E14 — this layer used to read the three per-domain roles
    (auth/access/tenant) out of ROLE_TARGET_PAIRING. Those roles had no
    producer and were removed, so the check is re-pointed at the surface that
    DOES select domain reviewers: the specialist touch-map plus the
    expert-review independence top-up. The invariant is unchanged — a kernel
    maintenance agent must never be dispatched as a domain reviewer — but it
    now watches the live roster instead of a dead one.
    """
    from .expert_review_gate import _INDEPENDENCE_TOPUP
    from .specialist_review_runner import (
        _CROSS_CUTTING_SPECIALISTS,
        domain_touch_map,
    )
    maintenance_dir = repo_root / ".claude" / "agents" / "_maintenance"
    if not maintenance_dir.exists():
        return []
    maintenance_names: set[str] = {
        p.stem for p in maintenance_dir.glob("*.md")
    }
    failures: list[dict[str, Any]] = []
    domain_reviewers: dict[str, str] = {}
    for prefix, agents in domain_touch_map().items():
        for agent in agents:
            domain_reviewers.setdefault(agent, f"touch_map:{prefix}")
    for agent in _CROSS_CUTTING_SPECIALISTS:
        domain_reviewers.setdefault(agent, "cross_cutting_specialists")
    for agent in _INDEPENDENCE_TOPUP:
        domain_reviewers.setdefault(agent, "expert_review_independence_topup")
    for target, source in sorted(domain_reviewers.items()):
        if target in maintenance_names:
            failures.append({
                "validator": "validate_maintenance_agent_isolation",
                "role": source, "target": target,
                "reason": "maintenance_agent_in_domain_review_pairing",
            })
    # Also check product-audit roster.
    pa_dir = repo_root / ".claude" / "agents" / "product-audit"
    if pa_dir.exists():
        for path in pa_dir.glob("*.md"):
            if path.stem in maintenance_names:
                failures.append({
                    "validator": "validate_maintenance_agent_isolation",
                    "agent": path.stem,
                    "reason": "maintenance_agent_in_product_audit_roster",
                })
    return failures


def validate_registry_adapter_sync(
    *, repo_root: Path, base_dir: str | Path | None,
) -> list[dict[str, Any]]:
    """Plan 022 §M-6 — registry <-> adapter manifest sync invariant.

    Pre-Plan-022 the v1 audit's "registry-adapter synchronized" verdict
    missed deeper drift: tools/aria-adapters/typeorm-entity-schema-adapter
    .tool.json existed on disk but was never bound to aria-tools/registry
    .json, and aria_kernel/adapter_portfolio.py:43 carried admitted
    stub-runner pattern. M-6 surfaces both:

    1. Every tools/aria-adapters/*.tool.json MUST have a registry row
       with a matching tool_id. Missing -> failure.
    2. Every registry tool whose runner.argv resolves to
       tools/aria-poc/shadow_runner.py MUST be in the explicit
       aria-tools/registry-stub-allowlist.json. Allowlist entry
       requires {tool_id, justification, plan_021_stream_a_owner}.
       A stub OUTSIDE the allowlist is a failure (drift detection).
    3. Manifest dosyası registry'de yoksa "missing_registry_row";
       allowlist'te değil shadow_runner kullanıyorsa
       "unallowlisted_stub_runner".

    Failures are surface_validations.jsonl rows; the run_all_validators
    aggregator wires this into the new 7th validator slot.
    """
    failures: list[dict[str, Any]] = []
    registry_path = repo_root / (str(base_dir) if base_dir else "aria-tools") / "registry.json"
    if not registry_path.exists():
        return [{
            "validator": "validate_registry_adapter_sync",
            "reason": "registry_missing",
            "expected_path": str(registry_path),
        }]
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return [{
            "validator": "validate_registry_adapter_sync",
            "reason": "registry_unreadable",
            "error": str(exc),
        }]
    registry_tool_ids = {t.get("tool_id") for t in registry.get("tools", [])}

    # Layer 1: every adapter manifest -> registry row.
    adapters_dir = repo_root / "tools" / "aria-adapters"
    if adapters_dir.exists():
        for manifest_path in adapters_dir.glob("*.tool.json"):
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            tool_id = manifest.get("tool_id")
            if tool_id and tool_id not in registry_tool_ids:
                failures.append({
                    "validator": "validate_registry_adapter_sync",
                    "manifest_path": manifest_path.relative_to(repo_root).as_posix(),
                    "tool_id": tool_id,
                    "reason": "missing_registry_row",
                })

    # Layer 2: shadow_runner stubs MUST be in allowlist.
    # Plan 023 v3 §C-5 — allowlist entries also have shape requirements:
    # `justification` must be a non-empty string AND
    # `plan_021_stream_a_owner` must be a non-empty string. Pre-fix the
    # validator only checked tool_id membership; entries with missing /
    # empty justification were silently accepted. The new shape check
    # surfaces shape failures alongside the existing missing_registry_row
    # and unallowlisted_stub_runner reasons.
    allowlist_path = repo_root / "aria-tools" / "registry-stub-allowlist.json"
    allowlist_ids: set[str] = set()
    if allowlist_path.exists():
        try:
            allowlist = json.loads(allowlist_path.read_text(encoding="utf-8"))
            entries = allowlist.get("entries", []) or []
            for entry in entries:
                tid = entry.get("tool_id") if isinstance(entry, dict) else None
                if not tid:
                    continue
                allowlist_ids.add(tid)
                # Shape validation per Plan 023 v3 §C-5.
                justification = entry.get("justification")
                owner = entry.get("plan_021_stream_a_owner")
                shape_problem: str | None = None
                if not isinstance(justification, str) or not justification.strip():
                    shape_problem = "justification must be a non-empty string"
                elif not isinstance(owner, str) or not owner.strip():
                    shape_problem = "plan_021_stream_a_owner must be a non-empty string"
                if shape_problem is not None:
                    failures.append({
                        "validator": "validate_registry_adapter_sync",
                        "tool_id": tid,
                        "reason": "allowlist_entry_shape_invalid",
                        "detail": shape_problem,
                    })
        except (OSError, json.JSONDecodeError) as exc:
            failures.append({
                "validator": "validate_registry_adapter_sync",
                "reason": "allowlist_unreadable",
                "error": str(exc),
            })

    for tool in registry.get("tools", []):
        runner = tool.get("runner") or {}
        argv = runner.get("argv") or []
        # Detect shadow_runner.py in argv.
        if any(isinstance(a, str) and "shadow_runner.py" in a for a in argv):
            tid = tool.get("tool_id")
            if tid and tid not in allowlist_ids:
                failures.append({
                    "validator": "validate_registry_adapter_sync",
                    "tool_id": tid,
                    "reason": "unallowlisted_stub_runner",
                })
    return failures


def run_all_validators(
    *,
    repo_root: str | Path | None = None,
    base_dir: str | Path | None = None,
    write_ledger: bool = True,
) -> dict[str, Any]:
    """Run all 6 validators; persist failures to surface-validations.jsonl
    + emit one surface_validation_failed governance event per failure
    (when write_ledger=True)."""
    if write_ledger:
        enforce_profile_for_write("surface_validations", base_dir=base_dir)

    repo = Path(repo_root or Path.cwd()).resolve()
    failures: list[dict[str, Any]] = []
    failures.extend(validate_agent_frontmatter(repo_root=repo))
    failures.extend(validate_target_agent_existence(repo_root=repo))
    failures.extend(validate_role_target_pairing(repo_root=repo))
    failures.extend(validate_registry_runner_paths(repo_root=repo, base_dir=base_dir))
    failures.extend(validate_plan_doc_freshness(repo_root=repo))
    failures.extend(validate_maintenance_agent_isolation(repo_root=repo))
    # Plan 022 §M-6 — 7th validator.
    failures.extend(validate_registry_adapter_sync(repo_root=repo, base_dir=base_dir))

    summary: dict[str, Any] = {
        "$schema": "aria/surface-validation-summary/v1",
        "schema_version": 1,
        "ran_at": utc_now(),
        "validator_count": len(VALIDATOR_NAMES),
        "failure_count": len(failures),
        "failures": failures,
    }

    if write_ledger:
        root = ensure_tools_dir(base_dir)
        append_declared_jsonl(
            root / VALIDATIONS_FILENAME,
            summary,
            expected_surface="surface_validations",
        )
        for fail in failures:
            append_tools_governance(root, "surface_validation_failed", fail)
    return summary


def list_surface_validations(
    *, base_dir: str | Path | None = None, limit: int | None = None,
) -> list[dict[str, Any]]:
    root = ensure_tools_dir_readonly(base_dir)
    if root is None:
        return []
    path = root / VALIDATIONS_FILENAME
    if not path.exists():
        return []
    rows = read_jsonl(path, expected_surface="surface_validations")
    if limit is not None and limit > 0:
        rows = rows[-limit:]
    return rows


__all__ = [
    "VALIDATOR_NAMES",
    "REQUIRED_FRONTMATTER_FIELDS",
    "validate_agent_frontmatter",
    "validate_target_agent_existence",
    "validate_role_target_pairing",
    "validate_registry_runner_paths",
    "validate_plan_doc_freshness",
    "validate_maintenance_agent_isolation",
    "run_all_validators",
    "list_surface_validations",
]
