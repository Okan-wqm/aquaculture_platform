import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_REPAIR_MIGRATION = resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/1789400000000-RepairFarmLiveSchemaDrift.ts',
);
const DROPLET_DEPLOY_SCRIPT = resolve(
  REPO_ROOT,
  'scripts/deploy/droplet-up.sh',
);

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('farm live schema drift repair contract', () => {
  it('captures every production-blocking farm drift column in a forward migration', () => {
    const source = read(FARM_REPAIR_MIGRATION);

    expect(source).toContain('RepairFarmLiveSchemaDrift1789400000000');
    expect(source).toContain('tenant_erasure_audit');

    for (const token of [
      '"departmentId"',
      '"parentSystemId"',
      '"totalVolumeM3"',
      '"maxBiomassKg"',
      '"tankCount"',
      '"labSampleTaken"',
      '"maskinporten_environment"',
      '"site_locality_mappings"',
      '"capacity_unit"',
      '"used_capacity"',
      '"version"',
      '"lot_number"',
      '"expiry_date"',
      '"idempotency_key"',
      '"performed_by_name"',
      '"checklistItems"',
      '"notes"',
    ]) {
      expect(source).toContain(token);
    }

    expect(source).toContain('withDdlSafety');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS farm.tenant_erasure_audit');
    expect(source).toContain('ADD COLUMN IF NOT EXISTS');
    expect(source).toContain('information_schema.columns');
    expect(source).toContain('ALTER COLUMN "status" TYPE farm.systems_status_enum');
    expect(source).toContain('ALTER COLUMN "status" TYPE farm.sub_systems_status_enum');
  });

  it('does not weaken drift validation or depend on runtime schema-builder diffing', () => {
    const source = read(FARM_REPAIR_MIGRATION);

    expect(source).not.toMatch(/SCHEMA_DRIFT_FATAL\s*=\s*false/);
    expect(source).not.toMatch(/SCHEMA_DRIFT_ENABLED\s*=\s*false/);
    expect(source).not.toMatch(/createSchemaBuilder\(\)\.log\(/);
    expect(source).not.toMatch(/synchronize:\s*true/);
  });

  it('uses the same bounded db-migrate runner for full and selective deploys', () => {
    const source = read(DROPLET_DEPLOY_SCRIPT);
    const rawDbMigrateRuns = source.match(/--exit-code-from db-migrate/g) ?? [];

    expect(source).toContain('run_db_migrate_or_exit()');
    expect(source).toContain('DB_MIGRATE_TIMEOUT_SECONDS');
    expect(source).toContain('run_db_migrate_or_exit "full deploy"');
    expect(source).toContain('run_db_migrate_or_exit "selective deploy"');
    expect(rawDbMigrateRuns).toHaveLength(1);
  });
});
