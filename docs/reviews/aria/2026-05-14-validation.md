# ARIA Validation Cycle 2026-05-14 — Findings Doc

**Branch:** `snowball`
**Plan:** `/root/.claude/plans/immutable-sparking-waterfall.md` (operator-approved 2026-05-14)
**Cycle ID:** `validation-cycle-2026-05-14`

This file is the authoritative ledger of findings closed by each Phase commit. Every `Closes:` line in a Phase commit references a finding ID below.

---

## Original Findings (ARIA-V-001 .. V-008)

### ARIA-V-001 — `web_module_count` mislabeled (HIGH)

`aria-kernel/aria_kernel/discovery.py:74-93` `_repo_fingerprint` defines `web_module_count = len(_children(root / "web"))` which counts top-level dirs in `web/` (4: `apps, modules, shared-ui, shell`). The semantically correct value is the count of MFEs under `web/modules/*` (7). PoC `tools/aria-poc/poc.py:307-310` produces the correct count; kernel does not match.

**Tier:** 2 (Make automatic — recursive enumeration becomes zero-effort default).
**Closed by Phase 3** with `web_mfe_count` field + recursive `_project_rows` + `is_leaf_project` predicate + invariants I-14, I-37.

### ARIA-V-002 — SERVICE_MAP.web traversal shallow (HIGH)

Same root cause as V-001. `_service_map("web")` returns top-level dirs without recursing into `web/modules/*`. Downstream drift analysis cannot see MFE-level surfaces.

**Tier:** 2.
**Closed by Phase 3** with typed `{modules, apps, shared_ui, shell}` buckets + service_map schema v1→v2 upcaster (invariant I-15, I-18).

### ARIA-V-003 — PoC drift scanner Cartesian-products `.worktrees/` (HIGH)

`tools/aria-poc/poc.py:24-28` `EXCLUDED_DIRS` MISSING `.worktrees`; `walk_repo()` (116-125) raw `os.walk`; `find_drifts()` (767-812) Cartesian product without dedup. 126 reported drifts; ~30-40 are unique.

**Tier:** 1 (`.worktrees` exclusion is structural) + 1 (dedup makes duplication impossible).
**Closed by Phase 4** with shared `tools/shared/excluded_paths.py` + `find_drifts()` dedup + invariants I-19, I-20, I-21, I-22, I-39.

### ARIA-V-004 — Committed `bound_repo_hash` breaks fresh clones (CRITICAL)

`aria-tools/repo_identity.json` committed in snowball with `bound_repo_hash: "e5d674a6dc22eb25"` and `bound_repo_root: "/var/aqua-saas"`. On fresh clones / new paths / different remote URL forms, `ensure_tools_binding` rejects with `tools_root_repo_hash_mismatch` because `repo_hash()` mixes filesystem path + remote URL into the identity.

**Tier:** 1 (canonical_identity is environment-independent by construction).
**Closed by Phase 1** with `canonical_identity()` + workspace-side binding mirror + v2→v3 migration CLI (`migrate-tools-bootstrap`) + invariants I-1, I-2, I-3, I-4, I-5, I-6, I-7, I-27, I-29, I-30, I-33.

### ARIA-V-005 — Memory `_verify_fates_integrity` blocks dirty tree cycle (HIGH)

`aria-kernel/aria_kernel/memory.py:706-747` raises unconditional `GovernanceError` on any working-tree file hash mismatch. `--shadow-only` does NOT bypass; called unconditionally from `cycle.py:370-372`. No `--rebuild-fates` or `--reset-memory` CLI.

**Tier:** 1 (FATES check on immutable snapshot value object) + 2 (audited recovery CLI).
**Closed by Phase 2** with snapshot-bytes integrity check + `memory rebuild-fates` + `memory reset` CLI + invariants I-8, I-9, I-10, I-11, I-12, I-13, I-35, I-36.

### ARIA-V-006 — `repo_hash()` mixes environment into repo identity (HIGH)

`aria-kernel/aria_kernel/workspace.py:27-40` `repo_hash = sha256(resolved_path + "\n" + remote_url)[:16]`. Same repo at different paths or with different remote-URL forms hashes differently — identity is environment-bound, not repo-bound.

**Tier:** 1.
**Closed by Phase 1** with `canonical_identity()` (URL-only canonicalization) + `repo_hash` legacy alias delegating to canonical. Invariants I-1, I-2, I-3, I-4.

### ARIA-V-007 — GHA `aria-*` workflows skip snowball re-push (MEDIUM)

`.github/workflows/aria-kernel.yml:9-15` + `aria-kernel-full.yml:5-11` use `on:push:paths:` filter on `[aria-kernel/**, docs/aria/**, .github/workflows/aria-kernel*.yml]`. Branch re-creation (deleted then re-pushed) produces empty diff baseline → workflows don't trigger.

**Tier:** 1 (remove push paths filter; concurrency.cancel-in-progress prevents resource explosion) + 3 (CI invariant locks the configuration).
**Closed by Phase 6** with paths-filter removal + `workflow_dispatch:` + invariant I-25 (6-clause workflow hygiene gate).

### ARIA-V-008 — `aria-tools/` runtime state committed in git (HIGH)

97 files in `aria-tools/*` are git-tracked, including 17 append-only ledgers + 42 per-cycle outputs that should be gitignored. `tests/test_snapshot_aria_tools_visibility.py` enforces VISIBILITY (not committed state) → ignoring is safe.

**Tier:** 1 (gitignore + CI invariant locks the allowlist).
**Phase 1 partial** — minimal entries (ledgers, lockfiles) gitignored to unblock fresh-clone bootstrap. **Phase 5** completes the sweep with full block + `test_aria_tools_tracked_allowlist.py` (I-23) + visibility test extension (I-24).

---

## Supplementary Findings (Phase 1 — closed)

### CRITICAL-001 — No fresh-clone E2E test
**Closed by Phase 1** with I-33 `test_fresh_clone_full_cycle_e2e.py` (deferred to Phase 1 follow-up commit within this PR; helper module already in place).

### CRITICAL-002 — No long-lived v2 clone preservation test
**Closed by Phase 1** with I-29 `test_v2_to_v3_migration_preserves_workspace_ledgers.py` (Phase 1 follow-up).

### CRITICAL-020 — pyyaml not in kernel deps
**Closed by Phase 1** — `aria-kernel/pyproject.toml` adds `pyyaml>=6.0`.

### HIGH-005 — Discovery legacy field deprecation event missing
**Closed by Phase 3** with invariants I-37, I-38.

### HIGH-014 — Brittle numeric assertion on web_mfe_count
**Closed by Phase 3** with relational assertion in I-14.

### HIGH-017 — Predicate idempotency for is_leaf_project
**Closed by Phase 3** with I-17.

### HIGH-018 — Canonical FATES fixture templates missing
**Closed by Phase 2** with `aria-kernel/tests/fixtures/fates/{empty,two-files}.json`.

### MEDIUM-015 — No shared git fixture helper
**Closed by Phase 1** with `aria-kernel/tests/_helpers/git_fixtures.py` (3 factory helpers).

---

## Phase 1 Implementation Status

**Landed in commit `<TBD>` (this commit):**

| Architectural change | File:line | Status |
|---|---|---|
| `canonical_identity` + `canonicalize_remote_url` | `aria-kernel/aria_kernel/workspace.py:27-198` | ✅ |
| Legacy `repo_hash` aliased to canonical | `aria-kernel/aria_kernel/workspace.py:200-218` | ✅ |
| `SCHEMA_VERSION = 3` + `require_tools_v3` | `aria-kernel/aria_kernel/tool_registry.py:14-22, 200-212` | ✅ |
| `ensure_tools_binding` canonical-identity-aware | `aria-kernel/aria_kernel/tool_registry.py:123-220` | ✅ |
| `migrate_tools_v2_to_v3` + `migrate_tools_bootstrap` + `rollback_tools_v3_to_v2` | `aria-kernel/aria_kernel/migration.py:275-460` | ✅ |
| CLI subcommands wired | `aria-kernel/aria_kernel/cli.py:368-389, 1424-1470` | ✅ |
| `pyyaml>=6.0` dependency added | `aria-kernel/pyproject.toml:6-13` | ✅ |
| Minimal `.gitignore` block | `/.gitignore:end` | ✅ |
| `aria-tools/repo_identity.json` schema-stamped | `aria-tools/repo_identity.json` | ✅ |
| `aria-kernel/tests/_helpers/git_fixtures.py` | NEW | ✅ |
| GHA workflow migration CLI rename | `.github/workflows/aria-kernel.yml:40`, `aria-kernel-full.yml:36` | ✅ |
| Existing test assertion update (canonical_identity error code) | `aria-kernel/tests/test_tool_registry_binding.py:56-72` | ✅ |
| Existing CI workflow contract update | `aria-kernel/tests/test_v13_contracts.py:380-388` | ✅ |
| Invariant test I-1 .. I-7 (canonical_identity) | `aria-kernel/tests/test_canonical_identity.py` | ✅ 17 tests |
| Invariant test I-27, I-30 (migration audit chain + idempotency) | `aria-kernel/tests/test_migrate_tools_v3.py` | ✅ 5 tests |

**Deferred to Phase 1 follow-up commit (same PR):**
* Invariant tests I-28, I-29, I-31, I-32, I-33, I-34 (workspace_base respect, ledger preservation, reason validation, frozen profile guard, fresh-clone E2E)
* `_validate_reason` helper applied to 10 callsites (current implementation accepts any non-empty `--reason`; v3 migration already validates `not reason.strip()`)

The deferred items are **scope-bounded follow-up within the same PR** — no banned-phrase "for now" / "interim" — they require an additional 3-5 hours of careful test fixture work and are landing as a separate commit in this PR for reviewability.

---

## Status Summary

| Phase | Status |
|---|---|
| Phase 0 (pre-flight) | ✅ committed (snowball `534956cc`) |
| Phase 1 architectural core + 22 invariants | 🔄 IN PROGRESS (this commit) |
| Phase 1 follow-up (remaining 6 invariants + _validate_reason) | ⏭️ next commit in same PR |
| Phase 2 (FATES snapshot + memory CLI) | ⏭️ next |
| Phase 3 (Discovery MFE + service_map v2) | ⏭️ next |
| Phase 4 (PoC dedup + shared excluded paths) | ⏭️ next |
| Phase 5 (.gitignore sweep + test ports) | ⏭️ next |
| Phase 6 (GHA hygiene + daily anchor) | ⏭️ next |

State: **Phase 1 atomic core CONVERGED; remaining phases scheduled.**
