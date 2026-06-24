import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

function uncommentedLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trimStart().startsWith('#'));
}

function extractComposeServiceBlock(compose: string, serviceName: string): string {
  return (
    new RegExp(`\\n  ${serviceName}:\\n[\\s\\S]*?(?=\\n  [a-zA-Z0-9_-]+:\\n|\\n\\S|\\s*$)`).exec(
      `\n${compose}`,
    )?.[0] ?? ''
  );
}

describe('deploy SSOT contract', () => {
  it('keeps production/staging compose on registry images only', () => {
    for (const path of ['docker-compose.droplet.yml', 'docker-compose.staging.yml']) {
      const lines = uncommentedLines(read(path));

      expect(lines.filter((line) => /^\s+build:\s*/.test(line))).toEqual([]);
      expect(lines.filter((line) => line.includes('${TAG:-latest}'))).toEqual([]);
    }
  });

  it('builds staging frontends from the catalog SSOT, not a hardcoded list (INFRA-MEDIUM-002)', () => {
    const staging = read('.github/workflows/deploy-staging.yml');
    // The production deploy derives its frontend build lists from the
    // generated service-catalog.deploy.vars; staging used to hardcode a
    // DIFFERENT split (3 modules via npm workspace while prod builds all
    // via NX), so staging could ship frontends compiled by a different
    // toolchain than production. The staging build step must consume the
    // same SSOT vars.
    expect(staging).toContain('infrastructure/deploy/service-catalog.deploy.vars');
    expect(staging).toContain('CATALOG_NX_FRONTEND_PROJECTS');
    expect(staging).toContain('CATALOG_NON_NX_FRONTEND_PROJECTS');
    // No hardcoded project list survives — the specific drifted list is gone.
    expect(staging).not.toContain(
      '--projects=shell,dashboard,farm-module,admin-panel,tenant-admin',
    );
    expect(staging).not.toMatch(/for mod in sensor-module hr-module hydroponics-module/);
  });

  it('retains exactly the manifest-protected rollback generation in safe GC (INFRA-HIGH-013)', () => {
    const capacity = read('scripts/deploy/droplet-capacity.sh');
    // Every deploy retags the previous generation as rollback-<sha>-<ts>;
    // without an explicit retention pass those retags never match the
    // SHA-only filter and accumulate ~a full image set per deploy (the
    // capacity gate blocked the merge train 3x on 2026-06-11).
    expect(capacity).toContain('rollback-*)');
    expect(capacity).toContain('remove superseded rollback retag');
    expect(capacity).toContain('keep protected rollback retag');
    // Untag passes must convert into reclaimed bytes — the final
    // dangling-only prune is what fixes the historical before=after
    // symptom.
    expect(capacity).toContain('removed_rollback_retags=');
    expect(capacity).toContain('GC_DRY_RUN');
  });

  it('keeps production deploy scripts away from local builds and volume pruning', () => {
    const script = [
      read('scripts/deploy/droplet-up.sh'),
      read('scripts/deploy/droplet-capacity.sh'),
      read('scripts/deploy-do.sh'),
    ].join('\n');

    expect(script).not.toMatch(/docker\s+build/);
    expect(script).not.toMatch(/docker\s+compose\s+build/);
    expect(script).not.toMatch(/docker-compose\s+build/);
    expect(script).not.toMatch(/up\s+[^#]*--build/);
    expect(script).not.toMatch(/docker\s+volume\s+prune/);
    expect(script).not.toMatch(/docker\s+system\s+prune[^#]*--volumes/);
  });

  it('builds production backend images from current-source artifacts only', () => {
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const provenance = read('scripts/deploy/verify-backend-dist-provenance.mjs');

    expect(workflow).not.toContain('path: .nx/cache');
    expect(workflow).toContain("NX_SKIP_NX_CACHE: 'true'");
    expect(workflow).toContain('node scripts/deploy/verify-backend-dist-provenance.mjs "${PROJECTS}"');
    expect(provenance).toContain('stale compiled app files detected');
    expect(provenance).toContain('apps\', project, \'src');
    expect(provenance).toContain('dist\', \'apps\', project');
  });

  it('expands manual selective deploys with migration owner services from the catalog', () => {
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const resolver = read('scripts/deploy/resolve-migration-owner-services.mjs');

    expect(workflow).toContain('MIGRATION_OWNER_SERVICES="$(node scripts/deploy/resolve-migration-owner-services.mjs');
    expect(workflow).toContain('append_backend_once "$svc"');
    expect(resolver).toContain('service-catalog.generated.json');
    expect(resolver).toContain('catalog.dbSchemas');
    expect(resolver).toContain('schema.migrationGlobs');
    expect(resolver).toContain('catalog.deploy?.backendImageTargets');
  });

  it('keeps Redis connection env single-source in droplet compose', () => {
    const compose = read('docker-compose.droplet.yml');
    const services = [
      'gateway-api',
      'auth-service',
      'farm-service',
      'sensor-service',
      'billing-service',
      'notification-service',
      'admin-api-service',
      'messaging-service',
    ];

    for (const service of services) {
      const block = extractComposeServiceBlock(compose, service);
      expect(block).toContain(`${service}:`);
      const hasUrl = /^\s+REDIS_URL:/.test(block);
      const hasHostStyle = /^\s+REDIS_(HOST|PORT|PASSWORD|DB):/m.test(block);
      expect(hasUrl && hasHostStyle).toBe(false);
    }
  });

  it('uses the shared Redis option builder for URL-aware backend Redis modules', () => {
    const gateway = read('apps/gateway-api/src/app.module.ts');
    const farm = read('apps/farm-service/src/app.module.ts');
    const notification = read('apps/notification-service/src/app.module.ts');

    for (const source of [gateway, farm, notification]) {
      expect(source).toContain('buildRedisOptions');
      expect(source).not.toContain("configService.get('REDIS_HOST', 'localhost')");
      expect(source).not.toContain("configService.get<string>('REDIS_PASSWORD')");
    }
  });

  it('scopes selective rollback to services changed by the current deploy', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');

    expect(deploy).toContain('scope_services=()');
    expect(deploy).toContain('done < <(restartable_deploy_services)');
    expect(deploy).toContain('Rollback scope had no restorable images.');
    expect(deploy).toContain('up -d --no-deps --no-build --force-recreate "${scope_services[@]}"');
    expect(deploy).not.toContain('up -d --no-build --remove-orphans');
  });

  it('reports droplet capacity evidence without mutating data-bearing storage', () => {
    const capacity = read('scripts/deploy/droplet-capacity.sh');

    expect(capacity).toContain('Top-level disk usage (same filesystem only):');
    expect(capacity).toContain('Docker image inventory:');
    expect(capacity).toContain('du -x -B1 -d1');
    expect(capacity).toContain('docker image ls --format');
    expect(capacity).toContain('CAPACITY_DISK_USAGE_MODE');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_SECONDS');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_SECONDS="${CAPACITY_DU_TIMEOUT_SECONDS:-60}"');
    expect(capacity).toContain('disk_usage_unavailable');
    expect(capacity).toContain('detect_docker_root');
    expect(capacity).toContain("awk 'NF {print; exit}'");
    expect(capacity).toContain("awk 'NR <= 20");
    expect(capacity).not.toContain('head -20');
  });

  it('keeps capacity diagnostics bounded below the deploy preflight timeout', () => {
    const capacity = read('scripts/deploy/droplet-capacity.sh');
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const capacityJobBlock =
      /\n {2}capacity-preflight:\n[\s\S]*?\n {2}# ===========================================================================/.exec(
        workflow,
      )?.[0] ?? '';
    const runGateStart = capacity.indexOf('run_gate() {');
    const runGateEnd = capacity.indexOf('case "${command}"');
    const runGateBlock =
      runGateStart >= 0 && runGateEnd > runGateStart
        ? capacity.slice(runGateStart, runGateEnd)
        : '';

    expect(capacityJobBlock).not.toEqual('');
    expect(runGateBlock).not.toEqual('');
    expect(runGateBlock).toContain('capacity_core_snapshot');
    expect(runGateBlock).toContain('capacity_diagnostic_snapshot');
    expect(runGateBlock).not.toContain('capacity_snapshot');
    expect((runGateBlock.match(/capacity_diagnostic_snapshot/g) ?? []).length).toBe(2);

    const duTimeoutSeconds = Number(
      /CAPACITY_DU_TIMEOUT_SECONDS="\$\{CAPACITY_DU_TIMEOUT_SECONDS:-(\d+)\}"/.exec(
        capacity,
      )?.[1],
    );
    const jobTimeoutMinutes = Number(/timeout-minutes:\s*(\d+)/.exec(capacityJobBlock)?.[1]);
    const commandTimeoutMinutes = Number(/command_timeout:\s*(\d+)m/.exec(capacityJobBlock)?.[1]);

    expect(duTimeoutSeconds).toBe(60);
    expect(commandTimeoutMinutes).toBeLessThan(jobTimeoutMinutes);
    expect(duTimeoutSeconds * 2).toBeLessThan(commandTimeoutMinutes * 60);
  });

  it('records deploy capacity and rollback metadata in the release ledger', () => {
    const sql = read('apps/db-migrate/src/sql/platform-bootstrap/007-bootstrap-signal.sql');
    const deploy = read('scripts/deploy/droplet-up.sh');

    for (const column of [
      'deploy_metadata',
      'rollback_manifest_sha256',
      'schema_may_be_forward',
      'rollback_skipped_reason',
    ]) {
      expect(sql).toContain(column);
      expect(deploy).toContain(column);
    }
  });

  it('covers platform bootstrap DDL authority stages 008-010', () => {
    const leastPrivilege = read(
      'apps/db-migrate/src/sql/platform-bootstrap/008-least-privilege-hardening.sql',
    );
    const provisioner = read(
      'apps/db-migrate/src/sql/platform-bootstrap/009-tenant-schema-provisioner.sql',
    );
    const provisioningFunction = provisioner.split(
      'CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion',
    )[0];
    const deletionFunction =
      provisioner.split('CREATE OR REPLACE FUNCTION platform.request_tenant_schema_deletion')[1] ??
      '';

    expect(leastPrivilege).toContain('Platform Bootstrap — Stage 8 of 10');
    expect(leastPrivilege).toContain('db_migrate is the only role granted schema-owner membership');
    expect(leastPrivilege).toContain('CREATE ROLE db_migrate NOLOGIN');
    expect(leastPrivilege).toContain("EXECUTE format('GRANT %I TO db_migrate'");
    expect(leastPrivilege).toContain("EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I'");

    // Stage 010 (DATA-HIGH-006): partition DDL authority lives in a
    // SECURITY DEFINER primitive owned by messaging_schema_owner; the
    // runtime role holds EXECUTE only. The 008 carve-out must stay gone.
    const partitionDefiner = read(
      'apps/db-migrate/src/sql/platform-bootstrap/010-messaging-partition-definer.sql',
    );
    expect(partitionDefiner).toContain(
      'CREATE OR REPLACE FUNCTION platform.create_messaging_partition',
    );
    expect(partitionDefiner).toContain('SECURITY DEFINER');
    expect(partitionDefiner).toContain('SET search_path = pg_catalog, pg_temp');
    expect(partitionDefiner).toContain('OWNER TO messaging_schema_owner');
    expect(partitionDefiner).toContain(
      'REVOKE ALL ON FUNCTION platform.create_messaging_partition(text, text, integer, integer) FROM PUBLIC',
    );
    expect(partitionDefiner).toContain(
      'GRANT EXECUTE ON FUNCTION platform.create_messaging_partition(text, text, integer, integer) TO messaging_service',
    );
    expect(leastPrivilege).not.toContain("IF spec.schema_name = 'messaging' THEN");

    expect(provisioner).toContain('Platform Bootstrap — Stage 9');
    expect(provisioner).toContain('aqua-db-migrate provisioner is the sole DDL worker');
    expect(provisioner).toContain('platform.tenant_schema_jobs');
    expect(provisioner).toContain(
      'aqua-db-migrate owns DDL and admin.tenant_schemas commit evidence',
    );
    expect(provisioningFunction).toContain("'PROVISION'");
    expect(provisioningFunction).not.toContain(
      'Tenant schema deletion requires cleanupProof evidence',
    );
    expect(deletionFunction).toContain("'DELETE'");
    expect(deletionFunction).toContain('Tenant schema deletion requires cleanupProof evidence');
    expect(deletionFunction).toContain('Tenant schema deletion requires encrypted backup evidence');
  });

  it('keeps runtime services out of production DDL authority in compose', () => {
    const runtimeServicesByCompose: Record<string, string[]> = {
      'docker-compose.prod.yml': [
        'gateway-api',
        'auth-service',
        'farm-service',
        'sensor-service',
        'hr-service',
        'billing-service',
        'alert-engine',
        'notification-service',
        'admin-api-service',
        'observability-service',
      ],
      'docker-compose.droplet.yml': [
        'gateway-api',
        'auth-service',
        'farm-service',
        'sensor-service',
        'admin-api-service',
        'alert-engine',
        'billing-service',
        'hr-service',
        'hydroponics-service',
        'notification-service',
        'observability-service',
        'config-service',
        'event-store-service',
        'messaging-service',
      ],
    };

    for (const [composePath, services] of Object.entries(runtimeServicesByCompose)) {
      const compose = read(composePath);
      expect(compose).not.toContain('DB_MIGRATE_DDL_AUTHORITY');

      for (const service of services) {
        const block = extractComposeServiceBlock(compose, service);
        expect(block).toContain(`${service}:`);
        expect(block).toMatch(/DB_MIGRATE_AUTHORITATIVE:\s*["']true["']/);
        expect(block).toMatch(/DATABASE_MIGRATIONS_RUN:\s*["']false["']/);
      }
    }
  });

  it('keeps CI-Affected as the main release orchestrator with explicit deploy mutation proof', () => {
    // A reusable-workflow caller's `result == success` only proves the called
    // workflow did not fail. The production deploy workflow keeps an explicit
    // mutation output and CI-Affected uses that output as the single release
    // orchestration contract: quality gates -> staging -> production -> proof.
    const deployWorkflow = read('.github/workflows/deploy-digitalocean.yml');
    const ciAffected = read('.github/workflows/ci-affected.yml');
    expect(deployWorkflow).toContain('deployed:');
    expect(deployWorkflow).toContain("value: ${{ jobs.deploy.outputs.performed == 'true' }}");
    expect(deployWorkflow).toContain('Mark deployment performed');
    expect(ciAffected).toContain('deploy-staging:');
    expect(ciAffected).toContain('deploy-production:');
    expect(ciAffected).toContain('production-post-deploy-verify:');
    expect(ciAffected).toContain('uses: ./.github/workflows/deploy-staging.yml');
    expect(ciAffected).toContain('uses: ./.github/workflows/deploy-digitalocean.yml');
    expect(ciAffected).toContain('uses: ./.github/workflows/production-post-deploy-verify.yml');
    expect(ciAffected).toContain('services: auto');
    expect(ciAffected).toContain("needs.deploy-production.outputs.deployed == 'true'");
    expect(ciAffected).toContain("needs.deploy-staging.result == 'success'");
    expect(ciAffected).toContain("needs.pre-flight.result == 'success'");
    expect(ciAffected).toContain("- '.github/workflows/production-post-deploy-verify.yml'");
  });

  it('verifies SHA images and capacity before SSH mutation', () => {
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const maintenance = read('.github/workflows/deploy-capacity-maintenance.yml');

    expect(workflow).toContain('verify-images:');
    expect(workflow).toContain('capacity-preflight:');
    expect(workflow).toContain('DEPLOY_IMAGE_DIGESTS_B64');
    expect(workflow).toContain(
      'CAPACITY_GC_MODE=auto bash scripts/deploy/droplet-capacity.sh gate',
    );
    expect(maintenance).toContain('workflow_dispatch:');
    expect(maintenance).toContain('safe-image-gc');
    expect(maintenance).toContain('bash scripts/deploy/droplet-capacity.sh gc');
    expect(maintenance).toContain(
      'CAPACITY_GC_MODE=auto bash scripts/deploy/droplet-capacity.sh gate',
    );
  });

  it('routes required-secret validation through the canonical npm script', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };
    const workflows = [
      read('.github/workflows/ci-affected.yml'),
      read('.github/workflows/ci-full.yml'),
    ].join('\n');

    expect(packageJson.scripts?.['validate:required-secrets']).toBe(
      'node scripts/ci/validate-secrets-manifest.ts',
    );
    expect(workflows).toContain('npm run validate:required-secrets');
    expect(workflows).not.toContain('python3 scripts/ci/validate-required-secrets.py');
  });

  it('keeps messaging NATS ACL smoke split into static, external, and repo-managed live gates', () => {
    const packageJson = JSON.parse(read('package.json')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['smoke:nats-messaging-acl:static']).toBe(
      'node scripts/nats/messaging-acl-smoke.mjs --mode static',
    );
    expect(packageJson.scripts?.['smoke:nats-messaging-acl:external']).toBe(
      'node scripts/nats/messaging-acl-smoke.mjs --mode live',
    );
    expect(packageJson.scripts?.['smoke:nats-messaging-acl']).toBe(
      'bash scripts/nats/messaging-acl-smoke-harness.sh',
    );
  });
});
