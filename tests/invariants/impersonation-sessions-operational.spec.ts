import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  APPEND_ONLY_TABLES,
  LIFECYCLE_GUARDED_TABLES,
  PROTECTED_TABLES,
  appendOnlyTableBaseNames,
} from '../../libs/backend-common/src/constants/protected-tables';

const ROOT = resolve(process.cwd());
const MIGRATION_DIRECTORY = join(ROOT, 'apps/admin-api-service/src/migrations');

function migrationUpBodies(): string {
  return readdirSync(MIGRATION_DIRECTORY)
    .filter((name) => /^\d+-.+\.ts$/.test(name))
    .sort()
    .map((name) => {
      const contents = readFileSync(join(MIGRATION_DIRECTORY, name), 'utf8');
      const up = contents.indexOf('async up(');
      const down = contents.indexOf('async down(');
      return up < 0 ? '' : contents.slice(up, down < 0 ? undefined : down);
    })
    .join('\n');
}

describe('impersonation session operational classification', () => {
  it('separates lifecycle retention from row append-only semantics', () => {
    expect(PROTECTED_TABLES).toContain('admin.impersonation_sessions');
    expect(LIFECYCLE_GUARDED_TABLES).toContain('admin.impersonation_sessions');
    expect(APPEND_ONLY_TABLES).not.toContain('admin.impersonation_sessions');
    expect(appendOnlyTableBaseNames()).not.toContain('impersonation_sessions');
  });

  it('leaves the blanket prevent-update trigger net absent', () => {
    const upBodies = migrationUpBodies();
    expect(upBodies).toMatch(/CREATE TRIGGER trg_impersonation_sessions_prevent_update/);
    expect(upBodies).toMatch(/DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update/);
    expect(
      upBodies.lastIndexOf('DROP TRIGGER IF EXISTS trg_impersonation_sessions_prevent_update'),
    ).toBeGreaterThan(
      upBodies.lastIndexOf('CREATE TRIGGER trg_impersonation_sessions_prevent_update'),
    );
  });

  it('installs lifecycle and retention guards instead', () => {
    const migration = readFileSync(
      join(MIGRATION_DIRECTORY, '1808500000000-MakeImpersonationSessionsOperational.ts'),
      'utf8',
    );
    expect(migration).toMatch(/trg_impersonation_sessions_enforce_lifecycle/);
    expect(migration).toMatch(/terminal impersonation sessions are immutable/);
    expect(migration).toMatch(/trg_impersonation_sessions_prevent_delete/);
  });

  it('makes both trigger-generating tools consume the append-only authority', () => {
    const generator = readFileSync(join(ROOT, 'scripts/migration/baseline-generator.ts'), 'utf8');
    const applicator = readFileSync(
      join(ROOT, 'scripts/migration/apply-audit-immutability.mjs'),
      'utf8',
    );
    expect(generator).toMatch(/appendOnlyTableBaseNames\(\)/);
    expect(applicator).toMatch(/append-only-table-catalog\.json/);
    expect(applicator).not.toMatch(/tables:\s*\[[^\]]*impersonation_sessions/);
  });
});
