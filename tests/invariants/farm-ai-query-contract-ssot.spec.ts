/**
 * INVARIANT: farm-AI query contract SSOT (PR-3 + PR-4 + PR-5).
 *
 * Binds every layer of the `request.farm.ai.*` read-only surface to the
 * single contract at libs/event-contracts/src/farm-ai-queries.ts:
 *
 *   1. ACL: every enforced subject (13 Water & Health + 17 Production + 10
 *      Operations) is granted EXPLICITLY (exact string, never a wildcard
 *      token) in farm_service.subscribe AND ai_service.publish of
 *      infrastructure/nats/services.yaml — a wildcard grant would silently
 *      widen if the contract ever grows.
 *   2. Responder: farm-service registers a @MessagePattern for each of the
 *      40 keys — a subject in the contract nobody answers is a guaranteed
 *      ai-service timeout.
 *   3. Caller: ai-service's tools/farm tree references each subject key at
 *      least once — an unreferenced key is dead contract surface.
 *   4. Guards: every PR-4/PR-5 key has a runtime request guard exported by
 *      the contract (per-guard behavior lives in libs/event-contracts specs).
 *   5. Read-only namespace: the farm-service responder/projection files
 *      contain NO transaction/command/persistence verbs.
 *   6. Tool metadata: every @Tool under tools/farm declares
 *      requiresModule 'farm' and (except the create-task ACTUATION tool)
 *      requiresConfirmation false — AI read tools never need confirmation.
 *   7. PII: the contract's request DTOs carry no banned identity/free-text
 *      field names.
 *
 * House style: plain fs reads + regex assertions (see
 * tenant-provisioning-ssot.spec.ts) — no app bootstrap, runs in layer-1.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

/** Comments are prose ("…no CommandBus…") — only code carries the invariant. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Recursively list .ts files under a repo dir (skips __tests__). */
function listSourceFiles(path: string): string[] {
  const absolute = resolve(REPO_ROOT, path);
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const childPath = `${path}/${entry}`;
    const stats = statSync(resolve(absolute, entry));
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      files.push(...listSourceFiles(childPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) files.push(childPath);
  }
  return files;
}

interface Service {
  name: string;
  publish: string[];
  subscribe: string[];
}

function loadServicesYaml(): { services: Service[] } {
  const text = readRepoFile('infrastructure/nats/services.yaml');
  return yamlParse(text) as { services: Service[] };
}

const CONTRACT = readRepoFile('libs/event-contracts/src/farm-ai-queries.ts');

/** The 13 PR-3 keys (Water & Health specialist). */
const PR3_KEYS = [
  'WQ_TANK_STATS',
  'WQ_SYSTEM_STATS',
  'WQ_HISTORY',
  'WQ_CRITICAL',
  'WQ_THRESHOLDS',
  'FH_STATS',
  'FH_EVENTS',
  'FH_CRITICAL',
  'FH_OVERDUE_FOLLOW_UPS',
  'FH_LICE_COUNTS',
  'FH_TREATMENTS',
  'FH_WELFARE',
  'FH_HARVEST_ELIGIBILITY',
] as const;

/** The 17 PR-4 keys (Production specialist). */
const PR4_KEYS = [
  'BATCH_PERFORMANCE',
  'BATCH_MORTALITY_BY_CAUSE',
  'BATCH_TRANSFERS_SUMMARY',
  'GROWTH_ANALYSIS',
  'GROWTH_MEASUREMENTS',
  'FEEDING_DAILY_PLAN',
  'FEEDING_SUMMARY',
  'FEEDING_SITE_CONSUMPTION',
  'FEED_PROTOCOLS',
  'SPECIES_LIST',
  'TANK_CAPACITY',
  'HARVEST_PLANS',
  'HARVEST_PLAN_STATS',
  'REG_BIOMASS_REPORT',
  'REG_REPORTS',
  'FINANCE_SUMMARY',
  'FINANCE_BATCH_TOTALS',
] as const;

/** The 10 PR-5 keys (Operations specialist). */
const PR5_KEYS = [
  'MAINT_OVERDUE_WORK_ORDERS',
  'MAINT_WORK_ORDER_STATS',
  'MAINT_SCHEDULE_ALERTS',
  'MAINT_LOW_STOCK',
  'MAINT_STOCK_SUMMARY',
  'EQUIPMENT_LIST',
  'EQUIPMENT_FEEDER_CALIBRATIONS',
  'FARM_STOCK_INVENTORY',
  'TASKS_TODAY',
  'TASK_STATS',
] as const;

/** Every now-enforced subject key: PR-3's 13 + PR-4's 17 + PR-5's 10. */
const ALL_KEYS = [...PR3_KEYS, ...PR4_KEYS, ...PR5_KEYS];

/** KEY: 'subject' pairs straight out of the contract source. */
function contractSubjects(): Map<string, string> {
  const subjects = new Map<string, string>();
  for (const match of CONTRACT.matchAll(/([A-Z][A-Z0-9_]+):\s*'(request\.farm\.ai\.[^']+)'/g)) {
    subjects.set(match[1], match[2]);
  }
  return subjects;
}

const RESPONDER_FILES = [
  'apps/farm-service/src/common/nats/ai-query-responder.ts',
  'apps/farm-service/src/water-quality/responders/water-quality-ai-query.responder.ts',
  'apps/farm-service/src/water-quality/responders/projections.ts',
  'apps/farm-service/src/fish-health/responders/fish-health-ai-query.responder.ts',
  'apps/farm-service/src/fish-health/responders/projections.ts',
  // PR-4 (Production specialist)
  'apps/farm-service/src/batch/responders/batch-ai-query.responder.ts',
  'apps/farm-service/src/batch/responders/projections.ts',
  'apps/farm-service/src/feeding/responders/feeding-ai-query.responder.ts',
  'apps/farm-service/src/feeding/responders/projections.ts',
  'apps/farm-service/src/species/responders/species-ai-query.responder.ts',
  'apps/farm-service/src/species/responders/projections.ts',
  'apps/farm-service/src/tank/responders/tank-ai-query.responder.ts',
  'apps/farm-service/src/tank/responders/projections.ts',
  'apps/farm-service/src/harvest/responders/harvest-ai-query.responder.ts',
  'apps/farm-service/src/harvest/responders/projections.ts',
  'apps/farm-service/src/regulatory/responders/regulatory-ai-query.responder.ts',
  'apps/farm-service/src/regulatory/responders/projections.ts',
  'apps/farm-service/src/finance/responders/finance-ai-query.responder.ts',
  'apps/farm-service/src/finance/responders/projections.ts',
  // PR-5 (Operations specialist)
  'apps/farm-service/src/equipment/responders/equipment-ai-query.responder.ts',
  'apps/farm-service/src/equipment/responders/projections.ts',
  'apps/farm-service/src/maintenance/responders/maintenance-ai-query.responder.ts',
  'apps/farm-service/src/maintenance/responders/projections.ts',
  'apps/farm-service/src/farm-stock/responders/farm-stock-ai-query.responder.ts',
  'apps/farm-service/src/farm-stock/responders/projections.ts',
  'apps/farm-service/src/task/responders/task-ai-query.responder.ts',
  'apps/farm-service/src/task/responders/projections.ts',
];

/** NATS subject match: exact string, or a `>`/`*` wildcard grant covering it. */
function grantCovers(grant: string, subject: string): boolean {
  if (grant === subject) return true;
  const grantTokens = grant.split('.');
  const subjectTokens = subject.split('.');
  for (let i = 0; i < grantTokens.length; i += 1) {
    const token = grantTokens[i];
    if (token === '>') return true;
    if (token === '*') continue;
    if (token !== subjectTokens[i]) return false;
  }
  return grantTokens.length === subjectTokens.length;
}

const BANNED_PII_KEYS = [
  'reportedBy',
  'assignedTo',
  'createdBy',
  'completedBy',
  'approvedBy',
  'verifiedBy',
  'vet',
  'userId',
  'userName',
  'notes',
  'attachments',
  'specifications',
  'checklist',
];

describe('INVARIANT: farm-AI query contract SSOT (PR-3 + PR-4 + PR-5)', () => {
  const subjects = contractSubjects();

  it('the contract declares all 40 enforced keys in the request.farm.ai namespace', () => {
    expect(subjects.size).toBe(40);
    expect(ALL_KEYS).toHaveLength(40);
    expect(new Set(ALL_KEYS).size).toBe(40);
    for (const key of ALL_KEYS) {
      expect(subjects.has(key)).toBe(true);
      expect(subjects.get(key)).toMatch(/^request\.farm\.ai\.[a-z][A-Za-z]+$/);
    }
  });

  it('grants every enforced subject EXPLICITLY (exact entry, never a wildcard) in both ACLs', () => {
    const services = loadServicesYaml().services;
    const farmService = services.find((service) => service.name === 'farm_service');
    const aiService = services.find((service) => service.name === 'ai_service');
    expect(farmService).toBeDefined();
    expect(aiService).toBeDefined();

    for (const key of ALL_KEYS) {
      const subject = subjects.get(key) as string;

      const subscribeHits = (farmService as Service).subscribe.filter((grant) =>
        grantCovers(grant, subject),
      );
      const publishHits = (aiService as Service).publish.filter((grant) =>
        grantCovers(grant, subject),
      );

      // At least one grant covers it…
      expect(subscribeHits.length).toBeGreaterThan(0);
      expect(publishHits.length).toBeGreaterThan(0);
      // …and the covering grant is the EXACT subject (no wildcard shortcuts).
      expect(subscribeHits).toContain(subject);
      expect(publishHits).toContain(subject);
    }
  });

  it('farm-service registers a @MessagePattern for each of the 40 keys', () => {
    const responderSources = [
      'water-quality/responders/water-quality-ai-query.responder.ts',
      'fish-health/responders/fish-health-ai-query.responder.ts',
      'batch/responders/batch-ai-query.responder.ts',
      'feeding/responders/feeding-ai-query.responder.ts',
      'species/responders/species-ai-query.responder.ts',
      'tank/responders/tank-ai-query.responder.ts',
      'harvest/responders/harvest-ai-query.responder.ts',
      'regulatory/responders/regulatory-ai-query.responder.ts',
      'finance/responders/finance-ai-query.responder.ts',
      'equipment/responders/equipment-ai-query.responder.ts',
      'maintenance/responders/maintenance-ai-query.responder.ts',
      'farm-stock/responders/farm-stock-ai-query.responder.ts',
      'task/responders/task-ai-query.responder.ts',
    ]
      .map((file) => readRepoFile(`apps/farm-service/src/${file}`))
      .join('\n');

    for (const key of ALL_KEYS) {
      expect({
        key,
        pattern: responderSources.includes(`FARM_AI_QUERY_SUBJECTS.${key}`),
      }).toEqual({ key, pattern: true });
    }
  });

  it('ai-service tools/farm references each subject key at least once', () => {
    const toolSources = listSourceFiles('apps/ai-service/src/tools/farm')
      .map((file) => readFileSync(resolve(REPO_ROOT, file), 'utf-8'))
      .join('\n');

    for (const key of ALL_KEYS) {
      expect({
        key,
        referenced: toolSources.includes(`FARM_AI_QUERY_SUBJECTS.${key}`),
      }).toEqual({ key, referenced: true });
    }
  });

  it('the contract exposes a runtime request guard for every PR-4/PR-5 key', () => {
    // Explicit key → guard map (guard names don't derive mechanically from
    // the keys). Per-guard behavior is pinned by libs/event-contracts specs;
    // this invariant only proves a guard EXISTS for each implemented subject.
    const GUARDS: Record<string, string> = {
      BATCH_PERFORMANCE: 'isBatchPerformanceRequest',
      BATCH_MORTALITY_BY_CAUSE: 'isMortalityByCauseRequest',
      BATCH_TRANSFERS_SUMMARY: 'isTransfersSummaryRequest',
      GROWTH_ANALYSIS: 'isGrowthAnalysisRequest',
      GROWTH_MEASUREMENTS: 'isGrowthMeasurementsRequest',
      FEEDING_DAILY_PLAN: 'isDailyFeedingPlanRequest',
      FEEDING_SUMMARY: 'isFeedingSummaryRequest',
      FEEDING_SITE_CONSUMPTION: 'isSiteFeedConsumptionRequest',
      FEED_PROTOCOLS: 'isFeedProtocolsRequest',
      SPECIES_LIST: 'isSpeciesListRequest',
      TANK_CAPACITY: 'isTankCapacityRequest',
      HARVEST_PLANS: 'isHarvestPlansRequest',
      HARVEST_PLAN_STATS: 'isHarvestPlanStatsRequest',
      REG_BIOMASS_REPORT: 'isBiomassReportRequest',
      REG_REPORTS: 'isRegulatoryReportsRequest',
      FINANCE_SUMMARY: 'isFinanceSummaryRequest',
      FINANCE_BATCH_TOTALS: 'isFinanceBatchTotalsRequest',
      MAINT_OVERDUE_WORK_ORDERS: 'isOverdueWorkOrdersRequest',
      MAINT_WORK_ORDER_STATS: 'isWorkOrderStatsRequest',
      MAINT_SCHEDULE_ALERTS: 'isMaintenanceScheduleAlertsRequest',
      MAINT_LOW_STOCK: 'isLowStockPartsRequest',
      MAINT_STOCK_SUMMARY: 'isStockSummaryRequest',
      EQUIPMENT_LIST: 'isEquipmentListRequest',
      EQUIPMENT_FEEDER_CALIBRATIONS: 'isFeederCalibrationsRequest',
      FARM_STOCK_INVENTORY: 'isFarmStockInventoryRequest',
      TASKS_TODAY: 'isTodaysTasksRequest',
      TASK_STATS: 'isTaskStatsRequest',
    };
    for (const [key, guard] of Object.entries(GUARDS)) {
      expect({
        key,
        guard,
        exported: CONTRACT.includes(`export function ${guard}(`),
      }).toEqual({ key, guard, exported: true });
    }
  });

  it('the responder namespace stays read-only (no transactions/commands/persistence)', () => {
    const banned =
      /runInTenantTransaction|CommandBus|\.save\(|\.insert\(|\.update\(|\.delete\(/;
    for (const file of RESPONDER_FILES) {
      const source = stripComments(readRepoFile(file));
      const offenders = source.match(banned) ?? [];
      expect({ file, offenders }).toEqual({ file, offenders: [] });
    }
  });

  it('every @Tool under tools/farm requires the farm module; read tools never require confirmation', () => {
    // The single sanctioned actuation exception: create_task is a write tool
    // and MUST keep its human-confirmation gate.
    const ACTUATION_EXCEPTIONS = new Set(['create-task.tool.ts']);

    const toolFiles = listSourceFiles('apps/ai-service/src/tools/farm').filter((file) =>
      file.endsWith('.tool.ts'),
    );
    // 13 PR-3 + 27 PR-4/5 + 6 pre-existing decorated tools
    // (farm-ai-query.tool.ts is the abstract base — deliberately without
    // @Tool metadata of its own).
    const decorated = toolFiles.filter(
      (file) => stripComments(readRepoFile(file)).includes('@Tool({'),
    );
    expect(decorated.length).toBe(46);

    for (const file of decorated) {
      const source = readRepoFile(file);
      expect({ file, requiresModule: /requiresModule:\s*'farm'/.test(source) }).toEqual({
        file,
        requiresModule: true,
      });

      const fileName = file.split('/').pop() as string;
      const declaresConfirmationGate = /requiresConfirmation:\s*true/.test(source);
      const declaresNoConfirmation = /requiresConfirmation:\s*false/.test(source);
      if (ACTUATION_EXCEPTIONS.has(fileName)) {
        expect({ file, declaresConfirmationGate }).toEqual({
          file,
          declaresConfirmationGate: true,
        });
      } else {
        expect({ file, declaresNoConfirmation }).toEqual({
          file,
          declaresNoConfirmation: true,
        });
      }
    }
  });

  it('contract request DTO keys carry no banned PII field names', () => {
    for (const banned of BANNED_PII_KEYS) {
      // `banned?:` / `banned:` as a property declaration (not a comment word)
      const declared = new RegExp(`(^|\\s)${banned}\\??:`, 'm').test(CONTRACT);
      expect({ banned, declared }).toEqual({ banned, declared: false });
    }
  });
});
