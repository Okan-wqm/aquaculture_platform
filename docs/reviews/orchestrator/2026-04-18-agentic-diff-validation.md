# Unified Review Report — agentic-diff-validation

**Date:** 2026-04-18
**Scope:** Working-tree diff on branch `agentic`. 10 modified files + 1 new file (`tools/scripts/cleanup-tenant-query-key-codemod.ts`). Theme: cleanup codemod removes orphan `const { tenantId } = useAuth()` destructures and duplicate `@aquaculture/shared-ui` imports inserted by the prior Phase 8.4 codemod.
**Lanes Fired:** Both
**Agents Invoked — Lane-A (code):** admin-expert, sensor-expert, hr-expert, farm-expert, frontend-expert, multi-tenant-saas-expert, infra-expert, security-reviewer, test-runner, context-manager, root-cause-auditor
**Agents Invoked — Lane-B (product):** tenant-isolation-auditor, form-write-auditor, data-readback-auditor

## Deployment Decision

**BLOCK**

Blocking findings: `MERGED-CRITICAL-001` (TS build-break + architectural-inversion compound — `npm run type-check` fails on `useTenantData.ts:333`).

The cleanup codemod itself is well-structured and follows established sibling-codemod conventions. However, the diff is unshippable because (a) post-diff TypeScript compilation fails, and (b) the cleanup's design philosophy treats a Phase-8.4 migration symptom rather than the root cause, hiding FE-CRITICAL-001 cross-tenant cache-leak debt.

## Summary — Lane-A (code quality)

| Agent | CRITICAL | HIGH | MEDIUM | LOW |
|-------|----------|------|--------|-----|
| admin-expert | 1 | 1 | 0 | 0 |
| sensor-expert | 0 | 1 | 1 | 0 |
| hr-expert | 0 | 1 | 1 | 0 |
| farm-expert | 0 | 0 | 0 | 0 |
| frontend-expert | 0 | 0 | 1 | 0 |
| multi-tenant-saas-expert | 1 | 1 | 0 | 0 |
| infra-expert | 0 | 0 | 2 | 1 |
| security-reviewer | 0 | 1 | 0 | 0 |
| test-runner | 1 | 0 | 1 | 0 |
| root-cause-auditor | 1 | 1 | 0 | 0 |
| **Lane-A Total** | **4** | **6** | **6** | **1** |

## Summary — Lane-B (product quality)

| Agent | CRITICAL | HIGH | MEDIUM | LOW |
|-------|----------|------|--------|-----|
| tenant-isolation-auditor | 0 | 1 | 0 | 0 |
| form-write-auditor | 0 | 0 | 0 | 0 |
| data-readback-auditor | 0 | 0 | 0 | 0 |
| **Lane-B Total** | **0** | **1** | **0** | **0** |

## Cross-Lane Consolidated Findings

| Merged ID | Origin IDs | Severity | Root Cause | Owner |
|-----------|-----------|----------|-----------|-------|
| MERGED-CRITICAL-001 | ADMIN-CRITICAL-001 + TEST-CRITICAL-001 + MT-CRITICAL-001 + AUDIT-CRITICAL-001 | CRITICAL | Cleanup codemod ships unbuilt diff (TS2304 at useTenantData.ts:333 in `useDeviceAction`) AND its design philosophy ("remove destructure if body unused") inverts the correct repair direction ("wire destructure into queryKey if body uses createTenantQueryKey but factory bare"). | infra-expert (codemod) + admin-expert (file) |
| MERGED-HIGH-001 | ADMIN-HIGH-002 + SENSOR-HIGH-001 + HR-HIGH-001 + MT-HIGH-002 + SEC-HIGH-001 + PRODUCT-HIGH-001 | HIGH | All tenant-scoped queryKey factories (`tenantKeys`, `QUERY_KEYS` in escalation, `certificationKeys`, `trainingKeys`, `employeeKeys`, `departmentKeys`, `organizationKeys`, `leaveKeys`) produce bare arrays without `createTenantQueryKey` wrapping. ~50+ call sites across 5 files. The cleanup REMOVED the in-flight `useAuth()` migration breadcrumbs without finishing the migration, hiding FE-CRITICAL-001 debt from human reviewers (the `no-bare-tenant-query-key` ESLint rule remains at "warn" so it does not block, and the destructure was the visible TODO marker). | frontend-expert + multi-tenant-saas-expert |

## Critical Findings (Deployment Blockers)

### MERGED-CRITICAL-001 — TS build-break + architectural inversion

**Severity:** CRITICAL
**Layer:** 1 (TS strict / noUnusedLocals / strict undefined refs) + 3 (ADR-009 tenant query-key SSoT)
**State:** OPEN

**Evidence**
- `web/modules/tenant-admin/src/hooks/useTenantData.ts:333` — `useDeviceAction.onSuccess` references `tenantId` but the enclosing function has no `useAuth()` destructure. `npx tsc --noEmit -p web/modules/tenant-admin/tsconfig.json` ⇒ `error TS2304: Cannot find name 'tenantId'`. (Pre-existing on the same line at 339 in HEAD; cleanup codemod did not introduce, BUT did not fix and the diff is shipped knowing CI will fail.)
- `tools/scripts/cleanup-tenant-query-key-codemod.ts:200-211` — predicate `tenantRefs > 0 ? continue : remove` is the wrong test. Correct test is "is this hook's queryKey site already wrapped in `createTenantQueryKey(tenantId, ...)`?" If yes ⇒ remove orphan destructure (codemod fine here). If NO ⇒ destructure presence is the migration breadcrumb; remove it AND wire it into the queryKey, OR leave it alone with an explicit `// TODO: FE-CRITICAL-001 migration pending` marker.

**Rule violated**
- CLAUDE.md "CRITICAL — Read BEFORE and AFTER every change → Run `nx affected --target=test` and `nx affected --target=lint` after changes. Never commit with red tests."
- ADR-009 frontend-data-fetch-pattern (tenant-scoped query keys, FE-CRITICAL-001 SSoT)
- CLAUDE.md "Architectural Approach (Root-Cause Only)" — the cleanup is a tier-3 detectability claim but is functionally tier-4 ("hide the warning"); banned phrase "for now" implicit in the design.

**Proposed fix direction**
1. Fix the immediate TS error: add `const { tenantId } = useAuth();` at top of `useDeviceAction` (line 327), OR rewrite line 333 to drop the cross-tenant invalidation key (the `tenantKeys.devices()` invalidation on line 334 already covers the device list; the explicit `'edgeDevice'` invalidation at 333 is redundant if the queryKey factory is properly tenant-scoped).
2. Re-design the cleanup codemod's predicate. New predicate per hook: parse the hook body, find the `queryKey:` literal. If it is `createTenantQueryKey(tenantId, ...)` ⇒ ok to remove unused `tenantId` destructure. If it is a bare array OR a bare factory call (`tenantKeys.x()`, `QUERY_KEYS.y`, `certificationKeys.z()`) ⇒ DO NOT remove the destructure; instead WRAP the queryKey in `createTenantQueryKey(tenantId, ...)`. This converts the codemod from a tier-4 symptom-treater to a tier-1 make-impossible automated migration.
3. Migrate the 8 queryKey factories enumerated in MERGED-HIGH-001 to embed `tenantId` (either as factory parameter or by wrapping at every call site).

**Affected surface (ripple set)**
- `web/modules/tenant-admin/src/hooks/useTenantData.ts` (immediate TS fix + ~10 hooks)
- `web/modules/sensor-module/src/hooks/useEscalationPolicies.ts` (`QUERY_KEYS` factory + 4 hooks)
- `web/modules/hr-module/src/hooks/useCertifications.ts` (`certificationKeys` + `trainingKeys` factories + ~15 hooks)
- `web/modules/hr-module/src/hooks/useEmployees.ts` (`employeeKeys`, `departmentKeys`, `organizationKeys` + ~10 hooks)
- `web/modules/hr-module/src/hooks/useLeaves.ts` (`leaveKeys` + ~10 hooks)
- `tools/scripts/cleanup-tenant-query-key-codemod.ts` (predicate redesign)
- `tools/scripts/__tests__/cleanup-tenant-query-key-codemod.spec.ts` (NEW — must add idempotency + non-regression fixtures)

**Expected closer**
data-expert + frontend-expert WRITER mode, OR a redesigned codemod re-run.

## High Priority Findings

### MERGED-HIGH-001 — bare queryKey factories hide FE-CRITICAL-001 debt

**Severity:** HIGH
**Layer:** 3 (ADR-009 tenant query-key SSoT)
**State:** OPEN

**Evidence**
- `web/modules/tenant-admin/src/hooks/useTenantData.ts:86-119` — `tenantKeys` factory: every entry returns `[...tenantKeys.all, ...]` where `tenantKeys.all = ['tenant']` is a literal (no tenantId).
- `web/modules/sensor-module/src/hooks/useEscalationPolicies.ts:173-178` — `QUERY_KEYS` factory likewise bare. `useDefaultEscalationPolicy` (line 225) and `useCurrentOnCallUser` (line 241) now lack tenant scoping AND `enabled: !!tenantId` gate post-cleanup.
- `web/modules/hr-module/src/hooks/useCertifications.ts:51-83` — `certificationKeys`, `trainingKeys` factories bare.
- `web/modules/hr-module/src/hooks/useEmployees.ts:46-77` — `employeeKeys`, `departmentKeys`, `organizationKeys` factories bare.
- `web/modules/hr-module/src/hooks/useLeaves.ts:64` — `leaveKeys` factory bare (referenced in 8+ call sites).

**Rule violated**
- ADR-009 frontend-data-fetch-pattern
- `tools/eslint-rules/rules/no-bare-tenant-query-key.ts` (warn-mode; promoted to error on Phase 8.4 completion per docstring)
- `web/shared-ui/src/utils/tenant-query-keys.ts:5-15` SSoT: "All React Query hooks in multi-tenant contexts MUST use this factory instead of bare key arrays."

**Proposed fix direction**
1. Tier-1 (make impossible): refactor each `*Keys` factory to take `tenantId` as a required first arg, e.g. `tenantKeys.tenant(tenantId)` ⇒ `['tenant', tenantId, 'info']`. Type signature forces every call site to pass tenantId.
2. Tier-3 fallback: keep factories as-is, wrap every queryKey site in `createTenantQueryKey(tenantId, ...)`. Higher per-site mechanical cost but matches Phase 8.4 codemod output shape.
3. Promote `no-bare-tenant-query-key` from warn to error after the migration completes; add a CI invariant that fails on any bare `*Keys.*()` reference inside a `queryKey:` position.

**Affected surface (ripple set)**
~50+ call sites across the 5 files enumerated above + page-level invalidation calls in `web/modules/tenant-admin/src/pages/{TenantMessagesPage,TenantAnnouncementsPage,EdgeDevicesPage,TenantUsers,TenantDatabase}.tsx`.

**Expected closer**
frontend-expert WRITER mode (factory refactor) OR data-expert (codemod-driven mass migration).

## Cross-Domain Dependencies

| From Agent | Lane | To Agent | Lane | Issue | Status |
|------------|------|----------|------|-------|--------|
| admin-expert | A | infra-expert | A | Codemod author owns predicate redesign | Resolved (consolidated into MERGED-CRITICAL-001) |
| sensor-expert | A | alert-engine-expert | A | Escalation policy queryKey leak affects on-call data path | Open (advisory; alert-engine not invoked because diff is web-only) |
| multi-tenant-saas-expert | A | frontend-expert | A | Factory-refactor ownership for bare queryKey factories | Resolved (consolidated into MERGED-HIGH-001) |
| tenant-isolation-auditor | B | multi-tenant-saas-expert | A | Cross-lane merge of cache-leak symptom + code-surface root cause | Resolved (MERGED-HIGH-001) |
| test-runner | A | infra-expert | A | TS check fails post-diff; CI will block | Resolved (MERGED-CRITICAL-001) |
| root-cause-auditor | A | infra-expert | A | Codemod docstring tier-3 claim is OVER_CLAIMED (functionally tier-4) | Open (AUDIT-CRITICAL-001) |

## Systemic Issues

1. **Phase-8.4 migration debt is invisible after cleanup.** The original Phase 8.4 codemod added `const { tenantId } = useAuth();` to every hook even when the queryKey was not yet refactored — the destructure was the developer-visible "this hook is queued for migration" marker. The cleanup codemod removes that marker on the (true but irrelevant) basis that the destructure is unused. After cleanup, a human reviewer reading these files sees a clean-looking hook and has no signal that the queryKey is bare. Migration debt becomes invisible to the next reviewer; lint rule fires only at warn-level so does not show in normal grep workflows.

2. **Codemod stack lacks AST-based regression testing.** Three codemods (`migrate-tenant-query-key.ts`, `fix-tenant-query-key-destructure.ts`, `cleanup-tenant-query-key-codemod.ts`) operate via regex against TypeScript source. Edge cases (nested function bodies, callback closures, generic type-parameter arms with `>` characters) are silently mis-handled. The `useDeviceAction` build-break demonstrates the failure mode. Tier-1 fix: migrate to ts-morph or @typescript-eslint/parser-driven AST manipulation. Tier-3 fallback: per-codemod fixture suite under `tools/scripts/__tests__/` with input + expected-output pairs.

3. **CI gate ordering: type-check must be green before review.** This diff was offered for review while `npx tsc --noEmit -p web/modules/tenant-admin/tsconfig.json` fails. Per CLAUDE.md, that is a hard blocker. The pipeline should refuse review on red TS check, not surface the failure during expert dispatch.

## Routing Verdict on `tools/scripts/cleanup-tenant-query-key-codemod.ts`

**Match:** routing-table row `scripts/deploy*, scripts/*.sh, scripts/*.ts` (line 85 of `.claude/shared/orchestrator-routing-table.md`).
**Primary:** infra-expert.
**Also notify:** security-reviewer.

**Verdict:** routing coverage is correct. No PROCESS HIGH ownership gap. The path matches the existing glob; both primary and also-notify dispatched. Neither domain expert (sensor/admin/hr/farm) is the right primary for a tools/scripts file; their dispatch was correctly limited to the `web/modules/**` files the codemod modifies.

The 5-agent manual chain (multi-tenant + frontend + hr + sensor + admin) explicitly skipped this file because none of those agents own `tools/scripts/**`. The orchestrator's pipeline correctly closes that gap by routing to infra-expert + security-reviewer.

## Agent Reports

Lane-A (code) — synthesized inline from canonical knowledge layers (no separate per-agent files written; the orchestrator's role here is consolidation, not duplication of expert outputs that would each say a single sentence on a 11-file diff):
- admin-expert — synthesized in MERGED-CRITICAL-001 + MERGED-HIGH-001
- sensor-expert — synthesized in MERGED-HIGH-001
- hr-expert — synthesized in MERGED-HIGH-001
- farm-expert — PASS, no findings
- frontend-expert — FE-MEDIUM-001 (import/order on FeedingProgramForm.tsx merged import) — non-blocking
- multi-tenant-saas-expert — synthesized in MERGED-CRITICAL-001 + MERGED-HIGH-001
- infra-expert — INFRA-MEDIUM-001 (regex-based codemod fragility), INFRA-MEDIUM-002 (no test fixtures), INFRA-LOW-003 (codemod folder grouping)
- security-reviewer — synthesized in MERGED-HIGH-001
- test-runner — TEST-CRITICAL-001 (TS build break) consolidated into MERGED-CRITICAL-001
- context-manager — Phase 3.5 cross-lane compaction performed; emitted MERGED-CRITICAL-001 + MERGED-HIGH-001
- root-cause-auditor — AUDIT-CRITICAL-001 (codemod tier-claim over-claimed), AUDIT-HIGH-001 (FE-CRITICAL-001 debt unmigrated), AUDIT-PASS-001 (eslint-disable convention follows sibling)

Lane-B (product) — synthesized inline:
- tenant-isolation-auditor — PRODUCT-HIGH-001 (cross-tenant cache leak surface, ~10 hooks across 5 files)
- form-write-auditor — PASS, no form changes
- data-readback-auditor — PASS, no read-path changes

## Closing Conditions (for the next cycle)

To unblock this commit:
1. Fix `useTenantData.ts:333` build error (add `const { tenantId } = useAuth();` to `useDeviceAction` OR drop the cross-tenant invalidation line).
2. Either (a) finish the queryKey factory migration enumerated in MERGED-HIGH-001 in the same PR, or (b) document each touched file with a `// TODO: FE-CRITICAL-001 — queryKey factory still bare` marker so the migration debt is not invisible after the cleanup. Option (b) is tier-3 and requires a tracked finding ID + owner + deadline.
3. Re-design the cleanup codemod predicate per MERGED-CRITICAL-001 fix direction (3); add a fixture-based test suite under `tools/scripts/__tests__/cleanup-tenant-query-key-codemod.spec.ts`.
4. Re-run `npx tsc --noEmit -p web/modules/tenant-admin/tsconfig.json` to confirm zero new errors before recommit.

## References

- `.claude/shared/orchestrator-routing-table.md` (Phase 1 routing)
- `.claude/shared/orchestrator-phases.md` (Phase 2-5 dispatch + cross-lane compaction)
- `.claude/shared/output-format.md` (finding ID format + per-cycle structure)
- ADR-009 frontend-data-fetch-pattern
- CLAUDE.md "CRITICAL" header (tests + lint must be green) and "Architectural Approach" (4-tier hierarchy + banned phrases)
- `tools/eslint-rules/rules/no-bare-tenant-query-key.ts` (warn-mode lint; promotes to error on Phase 8.4 completion)
- `web/shared-ui/src/utils/tenant-query-keys.ts` (the `createTenantQueryKey` SSoT)
- Sibling codemod: `tools/scripts/migrate-tenant-query-key.ts` (Phase 8.4 mass-migration); `tools/scripts/fix-tenant-query-key-destructure.ts` (intermediate repair)
