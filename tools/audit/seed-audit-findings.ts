#!/usr/bin/env ts-node
/**
 * seed-audit-findings — Phase 4 of the cold-audit cycle.
 *
 * Emits individual stub JSON files into
 *   docs/reviews/_audit/<cycle>/stubs/<id>.json
 * then invokes `tools/gates/finding-registry.ts add-explicit <stub>` for
 * each historical fixed-id fixture, preserving hash-chain integrity
 * between every append.
 *
 * Usage:
 *   ts-node --project tools/audit/tsconfig.json \
 *     tools/audit/seed-audit-findings.ts --cycle 2026-04-22-cold-audit
 *
 * The `FINDINGS` array below is the single source of truth. Each entry
 * mirrors Phase 2's `03-explore-findings.md` section with the exact
 * severity / tier / owner established there. Evidence is `file:line`
 * per the schema at `docs/reviews/_registry/findings.jsonl.schema.json`.
 *
 * The seeder is idempotent: it checks the registry for existing ids
 * before attempting to add, so re-running after a partial failure
 * resumes at the next unseen id.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = process.cwd();

interface FindingStub {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  layer: 1 | 2 | 3;
  evidence?: string[];
  rule_violated?: string;
  owner_agent: string;
  raised_in_cycle: string;
  review_file: string;
  created_at: string;
  notes?: string;
}

const CYCLE = '2026-04-22-cold-audit';
const CREATED_AT = '2026-04-22T19:00:00Z';
const REVIEW_FILE = `docs/reviews/_audit/${CYCLE}/03-explore-findings.md`;

const FINDINGS: FindingStub[] = [
  {
    id: 'AUDIT-CRITICAL-001',
    severity: 'CRITICAL',
    state: 'OPEN',
    title:
      'npm run type-check is a silent no-op — no root tsconfig.json, tsc prints help and exits 0',
    layer: 3,
    evidence: ['package.json:33', 'tsconfig.base.json:1'],
    rule_violated:
      'CLAUDE.md "CRITICAL — Run nx affected --target=test and nx affected --target=lint after changes. Never commit with red tests." (type-check cannot fail red because it never actually checks)',
    owner_agent: 'orchestrator',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 1 fix: rename script or point --project explicitly; tsc without a project returns help and exits 0, so every PR "passes" type-check without checking.',
  },
  {
    id: 'AUDIT-CRITICAL-002',
    severity: 'CRITICAL',
    state: 'OPEN',
    title:
      'npm run gates:all chain is broken — gates:banned-phrase invoked without --mode, prints Usage and exits 2',
    layer: 3,
    evidence: ['package.json:90', 'tools/gates/banned-phrase.ts:1'],
    rule_violated:
      'CLAUDE.md "nx affected --target=test && nx affected --target=lint green before every commit" (gates:all is expected to catch banned phrases; it short-circuits before ever running)',
    owner_agent: 'orchestrator',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 1 fix: require --mode in CLI parser and propagate from gates:all wrapper; today the banned-phrase gate exits 2 before migration-sql and tier-claim gates run.',
  },
  {
    id: 'AUDIT-CRITICAL-003',
    severity: 'CRITICAL',
    state: 'OPEN',
    title:
      'npm run invariants:fast has 3 failing tests including finding-registry-integrity (duplicate ids) and knowledge-ssot',
    layer: 3,
    evidence: [
      'tests/invariants/finding-registry-integrity.spec.ts:144',
      'tests/invariants/knowledge-ssot.spec.ts:1',
    ],
    rule_violated:
      'ADR-012 schema-drift-prevention: invariants must be green at every commit. Registry integrity gate is DETECTING duplicate ids (INFRA-CRITICAL-001 etc.) that should have been prevented at add time.',
    owner_agent: 'context-manager',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Root causes: (a) seed-finding-registry script reused numeric suffixes across runs; dedupe at add-time or switch to monotonic counter. (b) knowledge-ssot test expects 17 services, apps/ has 17 dirs (includes db-migrate CLI which is not a service per CLAUDE.md "16 services (15 runtime + db-migrate CLI)").',
  },
  {
    id: 'AUDIT-HIGH-002',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'apps/farm-service uses direct repository access in multiple handlers — bypasses tenant isolation',
    layer: 2,
    evidence: [
      'apps/farm-service/src/storage/handlers/record-stock-movement.handler.ts:1',
      'apps/farm-service/src/scheduler/feeding-scheduler.service.ts:1',
      'apps/farm-service/src/storage/handlers/receive-delivery.handler.ts:1',
      'apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts:1',
    ],
    rule_violated:
      'CLAUDE.md "direct repository access is FORBIDDEN → use getScopedRepository() (tenant isolation)"',
    owner_agent: 'data-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'record-stock-movement.handler alone has 12 getRepository calls. Tier 1 solution: eslint rule no-direct-get-repository across apps/** + inject scoped repo via module provider.',
  },
  {
    id: 'AUDIT-HIGH-003',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'apps/sensor-service uses direct repository access in ingestion/automation/edge-device — tenant isolation bypass',
    layer: 2,
    evidence: [
      'apps/sensor-service/src/ingestion/mqtt-listener.service.ts:1',
      'apps/sensor-service/src/automation/automation.service.ts:1',
      'apps/sensor-service/src/edge-device/edge-device.service.ts:1',
      'apps/sensor-service/src/sensor-type/channel-detection.service.ts:1',
    ],
    rule_violated:
      'CLAUDE.md "direct repository access is FORBIDDEN → use getScopedRepository() (tenant isolation)"',
    owner_agent: 'data-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Sensor ingestion path is edge-device originated — tenant binding must come from device cert CN (ADR-015 NATS identity pattern) or signed payload, not ambient context. Review each call site.',
  },
  {
    id: 'AUDIT-HIGH-004',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'water-chemistry engine duplicated: libs/aquaculture-engines shadowed by web/modules/farm-module copy (~2150 lines)',
    layer: 2,
    evidence: [
      'libs/aquaculture-engines/src/water-chemistry/water-quality.ts:1',
      'web/modules/farm-module/src/pages/water-chemistry/engine/water-quality.ts:1',
      'libs/aquaculture-engines/src/water-chemistry/reagents.ts:1',
      'web/modules/farm-module/src/pages/water-chemistry/engine/reagents.ts:1',
    ],
    rule_violated:
      'DRY / extract-to-lib — the lib already exists; the web copy is a fork that has begun drifting (import path difference).',
    owner_agent: 'farm-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Files covered: water-quality (581), reagents (577), deffeyes-data (414), ammonia-calc (293), types (183), co2-calc. Action: delete web copies, import from libs/aquaculture-engines.',
  },
  {
    id: 'AUDIT-HIGH-005',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'ST AST types duplicated across apps/sensor-service and web/modules/sensor-module (520 lines)',
    layer: 2,
    evidence: [
      'apps/sensor-service/src/automation/compiler/parser/st-ast.ts:14-533',
      'web/modules/sensor-module/src/simulation/st-ast-types.ts:16-535',
    ],
    rule_violated:
      'DRY / extract-to-lib — drift-prone domain types shared across backend parser and frontend simulator.',
    owner_agent: 'sensor-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Create libs/sensor-automation-types (pure types, no runtime). Both sides import. Align with sens-api-gateway ST compiler if types converge there too.',
  },
  {
    id: 'AUDIT-HIGH-006',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'node-components edges duplicated: libs/node-components shadowed by web/modules/sensor-module copies (~700 lines across 3 files)',
    layer: 2,
    evidence: [
      'libs/node-components/src/edges/OrthogonalEdge.tsx:1',
      'web/modules/sensor-module/src/components/process-editor/edges/OrthogonalEdge.tsx:1',
      'libs/node-components/src/edges/MultiHandleEdge.tsx:1',
      'libs/node-components/src/edges/DraggableEdge.tsx:1',
    ],
    rule_violated:
      'DRY / extract-to-lib — libs/node-components exists as home; sensor-module additionally has its own intra-dup between process-editor and scada-builder.',
    owner_agent: 'frontend-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Also delete web/modules/sensor-module/src/components/scada-builder/edges/{Orthogonal,MultiHandle}Edge.tsx which duplicate their siblings in process-editor/edges/.',
  },
  {
    id: 'AUDIT-HIGH-007',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'AI safety validators (SSRF + input-filter + output-pii) duplicated byte-identical across ai-service and messaging-service (~782 lines)',
    layer: 2,
    evidence: [
      'apps/ai-service/src/safety/ssrf-validator.service.ts:1',
      'apps/messaging-service/src/ai/safety/ssrf-validator.service.ts:1',
      'apps/ai-service/src/safety/input-filter.service.ts:1',
      'apps/ai-service/src/safety/output-pii-scanner.service.ts:1',
    ],
    rule_violated:
      'Cross-service security logic must live in libs/backend-common/src/security to prevent future divergence — next patch will ship to only one copy otherwise.',
    owner_agent: 'security-reviewer',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Byte-level diff verified identical today. Extract to libs/backend-common/src/ai-safety/ (or a new libs/ai-safety/) before next security fix lands on either side.',
  },
  {
    id: 'AUDIT-HIGH-008',
    severity: 'HIGH',
    state: 'OPEN',
    title:
      'apps/billing-service uses direct repository access in usage-aggregator, create-invoice, subscription handlers — tenant isolation bypass in financial code',
    layer: 2,
    evidence: [
      'apps/billing-service/src/modules/metering/usage-aggregator.service.ts:1',
      'apps/billing-service/src/billing/handlers/create-invoice.handler.ts:1',
      'apps/billing-service/src/billing/handlers/change-subscription-plan.handler.ts:1',
      'apps/billing-service/src/billing/query-handlers/get-tenant-billing.handler.ts:1',
      'apps/billing-service/src/billing/event-handlers/tenant-subscription-requested.handler.ts:1',
    ],
    rule_violated:
      'CLAUDE.md "direct repository access is FORBIDDEN → use getScopedRepository()" — especially severe in billing because cross-tenant leakage = wrong invoice to wrong tenant.',
    owner_agent: 'billing-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Financial correctness depends on tenant scoping. Audit each callsite against billing.subscriptions / billing.invoices schema (ADR-011).',
  },
  {
    id: 'AUDIT-MEDIUM-001',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'web/sensor-module high churn (319 pts) on automation editor, scada-builder, package-builder pages',
    layer: 1,
    evidence: [
      'web/modules/sensor-module/src/pages/automation/AutomationProgramEditorPage.tsx:1',
      'web/modules/sensor-module/src/components/scada-builder/ScreenCanvas.tsx:1',
    ],
    rule_violated:
      'No hard rule — churn is a leading signal that the abstraction may be under-fitting requirements.',
    owner_agent: 'frontend-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 4 monitor: revisit after next cycle; if churn correlates with failing e2e, escalate to Tier 3 (coverage invariant).',
  },
  {
    id: 'AUDIT-MEDIUM-004',
    severity: 'MEDIUM',
    state: 'OPEN',
    title: 'apps/hr-service hotspot (225 pts) — app.module + entities (employee, payroll) churn',
    layer: 1,
    evidence: [
      'apps/hr-service/src/hr/entities/employee.entity.ts:1',
      'apps/hr-service/src/hr/hr.resolver.ts:1',
    ],
    rule_violated: 'No hard rule — churn signal, not ADR violation.',
    owner_agent: 'hr-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes: 'Tier 4 monitor. HR is actively under feature development; no architectural action.',
  },
  {
    id: 'AUDIT-MEDIUM-005',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'libs/backend-common/src/database hotspot (213 pts) — schema-manager + index barrel churn',
    layer: 2,
    evidence: [
      'libs/backend-common/src/database/schema-manager.service.ts:1',
      'libs/backend-common/src/database/index.ts:1',
      'libs/backend-common/src/index.ts:1',
    ],
    rule_violated:
      'Anti-pattern: omnibus barrel file (libs/backend-common/src/index.ts) that re-exports everything; every add triggers a wide invalidation.',
    owner_agent: 'data-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 2 fix: split barrels — database/index.ts, auth/index.ts etc., consumers import specific subtree. Move schema-manager logic into migration-runner (already owns schema semantics).',
  },
  {
    id: 'AUDIT-MEDIUM-006',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'apps/messaging-service entity-relation hotspot — channel-member/message-attachment joins with 6 open findings',
    layer: 2,
    evidence: [
      'apps/messaging-service/src/channel/entities/channel-member.entity.ts:1',
      'apps/messaging-service/src/message/entities/message-attachment.entity.ts:1',
    ],
    rule_violated:
      'ADR-013 messaging isolation + ADR-011 schema ownership — joined tables across schema boundaries risk convergence bugs.',
    owner_agent: 'messaging-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 3 fix: integration test enforcing no-orphan-query invariant on messaging entities. Every JOIN must have a corresponding foreign key + tenant scoping test.',
  },
  {
    id: 'AUDIT-MEDIUM-007',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'apps/auth-service authentication.service.ts has 8 direct repository calls — cross-tenant risk in auth path',
    layer: 2,
    evidence: [
      'apps/auth-service/src/modules/authentication/services/authentication.service.ts:1',
      'apps/auth-service/src/modules/tenant/services/user-lifecycle.service.ts:1',
    ],
    rule_violated:
      'CLAUDE.md "direct repository access is FORBIDDEN → use getScopedRepository()" — auth is MEDIUM here because auth.tenants is intentionally cross-tenant (login resolves tenant); but every NON-tenant-resolver callsite must scope.',
    owner_agent: 'auth-security-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 1: same eslint ban as HIGH-002/003/008, plus per-callsite review to distinguish legit cross-tenant resolver calls from bypasses.',
  },
  {
    id: 'AUDIT-MEDIUM-009',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'apps/admin-api-service hotspot — explorer controller has broad DB access by design, needs explicit contract',
    layer: 3,
    evidence: [
      'apps/admin-api-service/src/database-management/controllers/explorer.controller.ts:1',
      'apps/admin-api-service/src/tenant/services/tenant-provisioning.service.ts:1',
    ],
    rule_violated:
      'ADR-011 shared schema boundaries — admin has cross-tenant reach; tenant-provisioning writes to auth.tenants + shared schema.',
    owner_agent: 'admin-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 4 document + Tier 3 guard: write an explicit contract (admin may not write outside its own schema + auth + shared), enforce via CI invariant.',
  },
  {
    id: 'AUDIT-MEDIUM-010',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'web/tenant-admin hotspot (86 pts) — TenantDashboard / TenantUsers / TenantSettings page churn',
    layer: 1,
    evidence: ['web/modules/tenant-admin/src/pages/TenantDashboard.tsx:1'],
    rule_violated: 'No hard rule — churn signal.',
    owner_agent: 'frontend-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes: 'Tier 4 monitor. Expected UI churn during feature work.',
  },
  {
    id: 'AUDIT-MEDIUM-011',
    severity: 'MEDIUM',
    state: 'OPEN',
    title: 'web/modules/admin-panel AdminSidebar is a 255-line fork of shared-ui Sidebar',
    layer: 2,
    evidence: [
      'web/modules/admin-panel/src/components/AdminSidebar.tsx:1',
      'web/shared-ui/src/components/Layout/Sidebar.tsx:1',
    ],
    rule_violated:
      'DRY / shared-ui contract — parameterize the shared component (logo, nav, footer props); delete the fork.',
    owner_agent: 'frontend-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Shared Sidebar must accept nav config + branding props. Admin fork likely added custom-admin items; move those into nav config parameter.',
  },
  {
    id: 'AUDIT-MEDIUM-012',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'web/apps/aquamobil record pages duplicate ~600 lines of form scaffolding across cull/mortality/harvest',
    layer: 1,
    evidence: [
      'web/apps/aquamobil/src/pages/cull/RecordCullPage.tsx:1',
      'web/apps/aquamobil/src/pages/mortality/RecordMortalityPage.tsx:1',
      'web/apps/aquamobil/src/pages/harvest/RecordHarvestPage.tsx:1',
    ],
    rule_violated:
      'DRY / domain-local — generic RecordEntityPage<T> scaffold, then each page passes entity config.',
    owner_agent: 'frontend-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Domain-local extraction: web/apps/aquamobil/src/pages/_shared/RecordEntityPage.tsx. No new lib (only aquamobil consumes).',
  },
  {
    id: 'AUDIT-MEDIUM-013',
    severity: 'MEDIUM',
    state: 'OPEN',
    title:
      'platform/libs/event-bus real circular dependency: nats-event-bus.ts ↔ nats.module.ts (the only real cycle from madge)',
    layer: 2,
    evidence: [
      'platform/libs/event-bus/src/nats/nats-event-bus.ts:1',
      'platform/libs/event-bus/src/nats/nats.module.ts:1',
      'platform/libs/event-bus/src/nats/nats-request-reply.ts:1',
    ],
    rule_violated:
      'NestJS module boundary — service imports module; module imports service for provider registration.',
    owner_agent: 'platform-kernel-expert',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Minimum-cost break: extract bare NatsEventBus class to nats-event-bus-impl.ts (no decorators); module imports factory function, not the service class directly. All 24 other circular chains are TypeORM/NestJS false-positives.',
  },
  {
    id: 'AUDIT-LOW-001',
    severity: 'LOW',
    state: 'OPEN',
    title:
      'Nx-intrinsic duplication in tsconfig.build.json / jest.config files across services (no action)',
    layer: 1,
    evidence: ['apps/admin-api-service/tsconfig.build.json:4-68'],
    rule_violated:
      'No violation — Nx workspace generators produce identical per-service scaffolding by design.',
    owner_agent: 'orchestrator',
    raised_in_cycle: CYCLE,
    review_file: REVIEW_FILE,
    created_at: CREATED_AT,
    notes:
      'Tier 4 document: explicitly call out that this class of duplication is noise, to avoid future audit cycles re-raising it.',
  },
];

function main(): void {
  const args = process.argv.slice(2);
  const cycleIdx = args.indexOf('--cycle');
  const cycleArg = cycleIdx >= 0 ? args[cycleIdx + 1] : CYCLE;
  if (cycleArg !== CYCLE) {
    console.error(`This seeder is bound to cycle ${CYCLE} (got ${cycleArg})`);
    process.exit(2);
  }

  const stubsDir = resolve(REPO_ROOT, 'docs/reviews/_audit', CYCLE, 'stubs');
  mkdirSync(stubsDir, { recursive: true });

  // Check existing registry for already-added ids so the seeder is idempotent.
  const registryPath = resolve(REPO_ROOT, 'docs/reviews/_registry/findings.jsonl');
  const existing = new Set<string>();
  if (existsSync(registryPath)) {
    for (const line of readFileSync(registryPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        existing.add((JSON.parse(line) as { id: string }).id);
      } catch {
        /* skip */
      }
    }
  }

  let added = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const f of FINDINGS) {
    const stubPath = resolve(stubsDir, `${f.id}.json`);
    writeFileSync(stubPath, JSON.stringify(f, null, 2) + '\n', 'utf8');
    if (existing.has(f.id)) {
      skipped += 1;
      continue;
    }
    try {
      execSync(
        `ts-node --project tools/gates/tsconfig.json tools/gates/finding-registry.ts add-explicit ${stubPath}`,
        { cwd: REPO_ROOT, stdio: 'inherit' },
      );
      added += 1;
    } catch {
      failures.push(f.id);
    }
  }

  console.log('');
  console.log(
    `[seed-audit-findings] done. added=${added} skipped=${skipped} failures=${failures.length}`,
  );
  if (failures.length) {
    console.log(`  failed ids: ${failures.join(', ')}`);
    process.exit(1);
  }
}

main();
