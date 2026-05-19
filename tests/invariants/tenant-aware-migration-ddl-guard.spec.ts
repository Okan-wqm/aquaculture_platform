import { readFileSync } from 'fs';
import { join, relative } from 'path';
import { execFileSync } from 'child_process';

const REPO_ROOT = join(__dirname, '..', '..');

const TENANT_AWARE_MIGRATION_DIRS = [
  'apps/farm-service/src/database/migrations',
  'apps/sensor-service/src/database/migrations',
  'apps/hr-service/src/database/migrations',
  'apps/messaging-service/src/migrations',
  'apps/messaging-service/src/database/migrations',
  'apps/alert-engine/src/database/migrations',
  'apps/ai-service/src/database/migrations',
  'apps/hydroponics-service/src/database/migrations',
] as const;

const SOURCE_SCHEMA_QUALIFIED_DDL =
  /\b(?:CREATE|ALTER|DROP|TRUNCATE)\s+(?:TABLE|INDEX|TYPE|SEQUENCE|VIEW|MATERIALIZED\s+VIEW)\b[\s\S]{0,220}"(?:farm|sensor|hr|messaging|alert|ai|hydroponics)"\."/i;

const EXPLICIT_ALLOW_MARKER = 'TENANT_AWARE_SOURCE_SCHEMA_DDL_OK';

function migrationFiles(): string[] {
  const args = [
    'ls-files',
    ...TENANT_AWARE_MIGRATION_DIRS.map((dir) => `${dir}/[0-9]*.ts`),
  ];
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => !file.endsWith('1800000000000-Baseline.ts'));
}

describe('tenant-aware migration DDL guard', () => {
  it('new tenant-aware migrations avoid hard-coded source-schema DDL unless explicitly annotated', () => {
    const offenders: string[] = [];
    for (const file of migrationFiles()) {
      const src = readFileSync(join(REPO_ROOT, file), 'utf8');
      if (!SOURCE_SCHEMA_QUALIFIED_DDL.test(src)) continue;
      if (src.includes(EXPLICIT_ALLOW_MARKER)) continue;
      offenders.push(relative(REPO_ROOT, join(REPO_ROOT, file)));
    }

    expect(offenders).toEqual([]);
  });
});
