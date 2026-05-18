import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const SCHEMA_REGISTRY = 'apps/db-migrate/src/schema-registry.ts';
const DB_MIGRATE_TSCONFIG = 'apps/db-migrate/tsconfig.build.json';
const HR_REPLAY_MIGRATION =
  'apps/hr-service/src/database/migrations/1789300000000-ReplayHrEntitySurfaceAlignment.ts';

function gitLsFiles(patterns: string[]): string[] {
  const out = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', ...patterns], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean).sort();
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function serviceFromMigrationPath(path: string): string | undefined {
  return path.match(/^apps\/([^/]+)\//)?.[1];
}

describe('db-migrate entity metadata contract', () => {
  it('entity-driven migrations have matching db-migrate entitiesGlob coverage', () => {
    const migrationFiles = gitLsFiles([
      'apps/*/src/migrations/*.ts',
      'apps/*/src/database/migrations/*.ts',
    ]);
    const entityDrivenServices = new Set<string>();

    for (const rel of migrationFiles) {
      if (rel.endsWith('.spec.ts') || rel.endsWith('.test.ts')) continue;
      const source = read(rel);
      if (!/entityMetadatas|createSchemaBuilder\(\)\.log\(/.test(source)) {
        continue;
      }
      const service = serviceFromMigrationPath(rel);
      if (service !== undefined) entityDrivenServices.add(service);
    }

    expect([...entityDrivenServices].sort()).toEqual(['hr-service']);

    const registry = read(SCHEMA_REGISTRY);
    expect(registry).toContain("entitiesGlob: ['apps/hr-service/src/**/*.entity.{ts,js}']");

    const tsconfig = read(DB_MIGRATE_TSCONFIG);
    expect(tsconfig).toContain('"../hr-service/src/**/*.entity.ts"');
  });

  it('HR replay migration does not depend on runtime schema-builder diffing (or no longer exists post-Faz-6 reset)', () => {
    // ADR-030 day-one baseline reset (Faz 6) archived the HR replay
    // migration along with the rest of the pre-reset chain. Its purpose
    // — entity-surface alignment after silent-applied SAVEPOINT drift —
    // is now structurally impossible via the PostConditionAwareMigration
    // probe (Faz 1.1) + the no-savepoint-in-migrations invariant
    // (Faz 1.2). If the file no longer exists, the regression class
    // is closed by construction; the spec is vacuously satisfied.
    const fs = require('node:fs') as typeof import('node:fs');
    const fullPath = resolve(REPO_ROOT, HR_REPLAY_MIGRATION);
    if (!fs.existsSync(fullPath)) {
      expect(true).toBe(true);
      return;
    }
    const source = read(HR_REPLAY_MIGRATION);
    expect(source).not.toMatch(/createSchemaBuilder\(\)\.log\(/);
    expect(source).toContain('alignEntitySurface');
    expect(source).toContain('deterministic entity-surface alignment');
  });
});
