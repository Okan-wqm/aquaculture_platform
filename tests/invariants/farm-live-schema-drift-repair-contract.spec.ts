import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_REPAIR_MIGRATION = resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/1789400000000-RepairFarmLiveSchemaDrift.ts',
);
const FARM_ERASURE_AUDIT_REINSTATE_MIGRATION = resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/1789500000000-ReinstateFarmTenantErasureAuditOwnership.ts',
);
const FARM_MIGRATION_MANIFEST = resolve(
  REPO_ROOT,
  'apps/farm-service/src/database/migrations/manifest.ts',
);
const DROPLET_DEPLOY_SCRIPT = resolve(REPO_ROOT, 'scripts/deploy/droplet-up.sh');
const DROPLET_DEPLOY_WORKFLOW = resolve(REPO_ROOT, '.github/workflows/deploy-digitalocean.yml');
const SCHEMA_MANAGER = resolve(
  REPO_ROOT,
  'libs/backend-common/src/database/schema-manager.service.ts',
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

  it('reinstates farm tenant erasure audit after applied repair migrations', () => {
    const source = read(FARM_ERASURE_AUDIT_REINSTATE_MIGRATION);
    const manifest = read(FARM_MIGRATION_MANIFEST);

    expect(source).toContain('ReinstateFarmTenantErasureAuditOwnership1789500000000');
    expect(source).toContain('CREATE TABLE IF NOT EXISTS farm.tenant_erasure_audit');
    expect(source).toContain('farm.tenant_erasure_audit_prevent_mutation');
    expect(source).toContain('ALTER TABLE farm.tenant_erasure_audit OWNER TO farm_service');
    expect(source).toContain('withDdlSafety');
    expect(source).toContain('forward-only');
    expect(source).not.toMatch(/DROP TABLE\s+IF EXISTS\s+farm\.tenant_erasure_audit/);
    expect(source).not.toMatch(/synchronize:\s*true/);

    expect(manifest).toContain('ReinstateFarmTenantErasureAuditOwnership1789500000000');
    expect(manifest).toContain('./1789500000000-ReinstateFarmTenantErasureAuditOwnership');
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

  it('keeps post-success image cleanup bounded and non-critical', () => {
    const source = read(DROPLET_DEPLOY_SCRIPT);
    const rawImagePrunes = source.match(/docker image prune/g) ?? [];

    expect(source).toContain('run_image_prune_best_effort()');
    expect(source).toContain('IMAGE_PRUNE_TIMEOUT_SECONDS');
    expect(source).toContain('timeout --kill-after=10s');
    expect(source).toContain('post-success best effort');
    expect(source).toContain('run_image_prune_best_effort "dangling images"');
    expect(source).toContain('run_image_prune_best_effort "stale images"');
    expect(rawImagePrunes).toHaveLength(1);
  });

  it('fails closed when an affected deploy image cannot be pulled', () => {
    const source = read(DROPLET_DEPLOY_SCRIPT);

    expect(source).toContain('APPLICATION_IMAGE_SERVICES');
    expect(source).toContain('is_application_image_service()');
    expect(source).toContain('deploy_includes_service()');
    expect(source).toContain('pull_deploy_image_required()');
    expect(source).toContain('DEPLOY_SHA is required');
    expect(source).toContain('local immutable_ref="${image}:${DEPLOY_SHA}"');
    expect(source).toContain('docker pull "${immutable_ref}"');
    expect(source).toContain('docker tag "${immutable_ref}" "${compose_ref}"');
    expect(source).toContain('Required image pull failed for ${svc} (${immutable_ref})');
    expect(source).toContain(
      'Aborting BEFORE service restart so the deploy cannot keep running stale images.',
    );
    expect(source).toContain('pull_deploy_image_required "$svc"');
    expect(source).toContain('--force-recreate ${DEPLOY_SERVICES}');
    expect(source).not.toContain('WARN: $svc pull failed, continuing');
  });

  it('pins full deploy application images without using mutable latest races', () => {
    const source = read(DROPLET_DEPLOY_SCRIPT);

    expect(source).toContain('FULL DEPLOY: Pulling application images by immutable deploy SHA');
    expect(source).toContain('for svc in ${APPLICATION_IMAGE_SERVICES}; do');
    expect(source).toContain('pull_deploy_image_required "$svc"');
    expect(source).toContain('deploy_includes_service "db-migrate"');
    expect(source).toContain(
      'infrastructure image pull for $svc failed, continuing with local image if present',
    );
  });

  it('forwards the canonical image prefix into the droplet script', () => {
    const source = read(DROPLET_DEPLOY_WORKFLOW);

    expect(source).toContain('IMAGE_PREFIX: ${{ needs.prepare.outputs.image_prefix }}');
    expect(source).toContain(
      'envs: DEPLOY_SERVICES,FULL_DEPLOY,DEPLOY_SHA,IMAGE_PREFIX,GHCR_TOKEN,GHCR_ACTOR',
    );
  });

  it('captures rollback image from the real compose gateway container', () => {
    const source = read(DROPLET_DEPLOY_SCRIPT);

    expect(source).toContain('docker compose -f docker-compose.droplet.yml ps -q gateway-api');
    expect(source).toContain('docker inspect --format');
    expect(source).toContain('aqua-gateway');
    expect(source).toContain('GATEWAY_IMAGE_REF');
    expect(source).not.toContain('aqua-saas-gateway-api-1');
  });

  it('keeps tenant erasure audit in farm strict-ownership source-only tables', () => {
    const source = read(SCHEMA_MANAGER);
    const farmStart = source.indexOf("moduleName: 'farm'");
    const nextModule = source.indexOf("moduleName: 'hr'", farmStart);
    const farmBlock = source.slice(farmStart, nextModule);

    expect(farmStart).toBeGreaterThanOrEqual(0);
    expect(nextModule).toBeGreaterThan(farmStart);
    expect(farmBlock).toContain('strictOwnership: true');
    expect(farmBlock).toContain('infrastructureTables:');
    expect(farmBlock).toMatch(/infrastructureTables:\s*\[[\s\S]*'tenant_erasure_audit'/);
    expect(farmBlock).not.toMatch(/referenceDataTables:\s*\[[\s\S]*'tenant_erasure_audit'/);
    expect(farmBlock).not.toMatch(/tables:\s*\[[\s\S]*'tenant_erasure_audit'/);
  });
});
