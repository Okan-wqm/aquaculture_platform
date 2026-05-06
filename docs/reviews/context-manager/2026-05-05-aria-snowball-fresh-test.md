# ARIA snowball — fresh end-to-end test review

**Cycle:** 2026-05-05-aria-snowball-fresh-test
**Branch:** snowball
**Reviewer:** context-manager (acting on plan-revision conversation v9→v13)
**Workspace fixture:** `/tmp/aria-fresh-test/e5d674a6dc22eb25/`

## Scope

Fresh probe of the ARIA kernel after partial v9 hardening shipped on `snowball`. Probe fed three real `getRepository(Plan)` violations from `apps/billing-service/**` (CLAUDE.md banned pattern) into `feedback add`, then exercised `discovery run`, `integrity verify`, `pressure list`, `closed_signal`, and surface inference probes against 16 representative refs spanning every top-level subtree.

## Findings

### ULTRA-HIGH-077 — `infer_surface()` coalesced 12 top-level subtrees into single `repo` bucket

**Severity:** HIGH
**State:** RESOLVED (closed by Phase-1.1 surface inference 4-tier resolution)
**Layer:** 3

**Evidence:**
- `aria-kernel/aria_kernel/feedback.py:39-46` (pre-fix) — only 4 prefixes recognised: `web/{modules,apps}/`, `apps/`, `infra/`, `.github/`
- Fresh probe output: `libs/`, `platform/libs/`, `mcp/`, `sens-api-gateway/`, `tools/`, `scripts/`, `e2e/`, `tests/`, `agents/`, `agent-workspace/`, `aria-kernel/`, `aria-tools/`, `infrastructure/` all returned `capability_gap_key = repo:evidence_gap:*`

**Rule violated:** ARIA SPEC §1 (capability_gap_key must reflect surface granularity for distinct top-level subtrees) — plan v13 Phase-1 contract.

**Impact:** Distinct capability gaps from edge code, shared lib code, MCP server code, etc. all coalesced into a single bucket. Pressure threshold (3 refs) hit prematurely across unrelated concerns; pressure granularity was lost across half the codebase.

**Resolution:** Plan v13 Phase-1.1 — `infer_surface()` rewritten with 4-tier resolution:

1. Operator `--surface` override (caller-side)
2. Exact root-file glob match (`Dockerfile*`, `docker-compose*.yml`, `docker-compose*.yaml`) for one-segment paths
3. Ordered prefix list (20 prefixes, longest-first; `platform/libs/` before `libs/`)
4. `repo` fallback

22 new tests in `aria-kernel/test_feedback_loop.py` — `SurfaceInferenceTests` + `SurfacePrefixOrderingTests` — every prefix asserted, ordering invariant locked, exact-match precedence verified, trailing-slash optionality, line-suffix tolerance, `.github/`-leading-dot bug fixed (`lstrip("./")` → `removeprefix("./")`).

**Verification:** Re-running the same 16-ref probe after the fix produces 11 distinct surfaces (`shared_lib`, `platform`, `integration`, `edge`, `tooling`, `test`, `aria`, `agent_runtime`, `infra`, `frontend`, `backend`) plus `repo` fallback for unmapped root files.

## Out-of-scope (queued for follow-on Phase-1 commits)

- Phase-1.2 — `pressure_keys_emitted` drop from indexes
- Phase-1.3 — `run_cycle()` schema_version: 2
- Phase-1.4 — vocabulary kind/mode split + v3 schema bump
- Phase-1.5 — tools v0→v2 bypass migration with backup/lock/governance/resume
- Phase-1.6 — vocabulary_normalization_drift event wiring + integrity tampering matrix expansion

## Pre-existing failures unaffected

Two test failures observed on baseline (before Phase-1.1) and after — separate concerns:

- `tests.test_enterprise_cycle.test_committed_snapshot_blocks_dirty_git_workspace` — `GovernanceError` not raised; discovery snapshot-mode logic
- `tests.test_typeorm_adapter_integration.test_typeorm_entity_schema_adapter_runs_in_shadow_without_mutation` — `raw_findings_count: 71 != 0`; adapter scope drift

Both require their own findings + fixes; not Phase-1 scope.
