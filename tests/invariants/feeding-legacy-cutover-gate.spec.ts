import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

import {
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1,
  FEEDING_SCHEDULER_TRIGGER,
} from '../../libs/feeding-contracts/src/feeding-mutation-catalog';
import { FEEDING_SCHEDULER_OBSERVABILITY_V1 } from '../../libs/feeding-contracts/src/feeding-job-catalog';
import { RETIRED_FEEDING_MUTATION_IDS_V1 } from '../../apps/farm-service/src/feeding/retirement/feeding-legacy-mutation-retirement.authority';

const REPO_ROOT = resolve(__dirname, '..', '..');

function path(relativePath: string): string {
  return join(REPO_ROOT, relativePath);
}

function read(relativePath: string): string {
  return readFileSync(path(relativePath), 'utf8');
}

describe('feeding legacy engine retirement authority', () => {
  it('removes every legacy runtime provider instead of retaining a rollback shim', () => {
    for (const relativePath of [
      'apps/farm-service/src/feeding/services/feeding-cron.service.ts',
      'apps/farm-service/src/scheduler/feeding-scheduler.service.ts',
      'apps/farm-service/src/feeding/constants/legacy-engine-gate.ts',
    ]) {
      expect(existsSync(path(relativePath))).toBe(false);
    }

    const schedulerModule = read('apps/farm-service/src/scheduler/scheduler.module.ts');
    const constantsIndex = read('apps/farm-service/src/feeding/constants/index.ts');
    expect(schedulerModule).not.toContain('FeedingSchedulerService');
    expect(constantsIndex).not.toContain('legacy-engine-gate');
  });

  it('keeps the catalog and mutation kernel free of v1 compatibility capabilities', () => {
    const catalog = read('libs/feeding-contracts/src/feeding-job-catalog.ts');
    const mutationKernel = read(
      'apps/farm-service/src/database/migrations/1808700000000-InstallFeedingOperationMutationKernel.ts',
    );

    for (const source of [catalog, mutationKernel]) {
      expect(source).not.toContain('scheduled.v1');
      expect(source).not.toContain('v1.day-plan.generate');
      expect(source).not.toContain('v1.schedule.execute');
      expect(source).not.toContain('FEEDING_LEGACY_ENGINE_ENABLED');
    }
  });

  it('uses one process heartbeat while catalog definitions own semantic schedules', () => {
    const service = read('apps/farm-feeding-scheduler/src/feeding-schedule-ingress.service.ts');
    const cronDecorators = service.match(/@Cron\(/g) ?? [];

    expect(cronDecorators).toHaveLength(1);
    expect(FEEDING_SCHEDULER_TRIGGER).toEqual({
      name: FEEDING_SCHEDULER_OBSERVABILITY_V1.heartbeatJob,
      schedule: '* * * * *',
    });
    expect(FEEDING_SCHEDULER_TRIGGER.name).toBe(FEEDING_SCHEDULER_OBSERVABILITY_V1.heartbeatJob);
    expect(read('libs/feeding-contracts/src/feeding-mutation-catalog.ts')).not.toContain(
      "'feeding-catalog-reconciler'",
    );
    expect(service).toContain('@Cron(FEEDING_SCHEDULER_TRIGGER.schedule');
    expect(service).not.toContain('Europe/Istanbul');
    expect(service).not.toContain('pg_try_advisory_lock');
    expect(service).not.toContain('runExclusive');
  });

  it('removes the exact v1 write surface without a runtime compatibility shim', () => {
    const retiredMethods = new Set<string>(RETIRED_FEEDING_MUTATION_IDS_V1);
    const resolverPath = path(
      'apps/farm-service/src/feeding/resolvers/feeding-program.resolver.ts',
    );
    const source = ts.createSourceFile(
      resolverPath,
      readFileSync(resolverPath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const resolverMethods = new Set<string>();
    for (const statement of source.statements) {
      if (!ts.isClassDeclaration(statement) || statement.name?.text !== 'FeedingProgramResolver') {
        continue;
      }
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
        resolverMethods.add(member.name.text);
      }
    }
    for (const retiredMethod of retiredMethods) {
      expect(resolverMethods.has(retiredMethod)).toBe(false);
    }
    expect(readFileSync(resolverPath, 'utf8')).not.toContain('RetiredFeedingMutation');
    expect(
      FEEDING_MUTATION_AUTHORITY_CATALOG_V1.some(
        (entry) =>
          entry.ingress.provider === 'FeedingProgramResolver' &&
          retiredMethods.has(entry.ingress.method),
      ),
    ).toBe(false);

    const feedingModule = read('apps/farm-service/src/feeding/feeding.module.ts');
    expect(feedingModule).not.toContain('DailyFeedingExecutionService');
    expect(feedingModule).not.toContain('FeedingProgramService');
    expect(feedingModule).not.toContain('RestoreModule');
    const operationRegistry = read('web/apps/aquamobil/src/pwa/operation-registry.ts');
    expect(operationRegistry).not.toContain('recordDailyFeeding');
    const mobileTypes = read('web/apps/aquamobil/src/types/index.ts');
    expect(mobileTypes).not.toContain("'recordFeeding'");
    const offlineQueue = read('web/apps/aquamobil/src/pwa/offline-queue.ts');
    expect(offlineQueue).toContain("operation.type === 'recordFeeding'");
    expect(offlineQueue).toContain('legacy-daily-feeding-authority-retired');
    expect(offlineQueue).toMatch(
      /database\.transaction\(\s*OFFLINE_QUEUE_STORAGE_AUTHORITY_V1\.objectStoreName,\s*'readwrite',?\s*\)/,
    );
    expect(offlineQueue).toMatch(
      /transaction\.objectStore\(OFFLINE_QUEUE_STORAGE_AUTHORITY_V1\.objectStoreName\)/,
    );
    expect(offlineQueue).not.toContain('QUEUE_OBJECT_STORE_NAME');
    expect(offlineQueue).not.toContain("createStore('aquamobil-retired-queue'");
  });
});
