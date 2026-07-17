import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  it('keeps production releases fail-closed behind the backup/restore stop-line', () => {
    const workflow = read('.github/workflows/deploy-digitalocean.yml');

    expect(workflow).toContain('production-deploy-lock:');
    expect(workflow).toContain('PRODUCTION_DEPLOY_ENABLED: ${{ vars.PRODUCTION_DEPLOY_ENABLED }}');
    expect(workflow).toContain("needs.production-deploy-lock.outputs.enabled == 'true'");
    const dispatchInputs =
      /workflow_dispatch:\n([\s\S]*?)\n\n# Permissions/.exec(workflow)?.[1] ?? '';
    expect(dispatchInputs).not.toContain('PRODUCTION_DEPLOY_ENABLED');
  });

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
    // Default-deny tag policy: an app tag outside the closed keep-allowlist
    // (latest/staging/buildcache-*/current sha/rollback retention) is
    // reclaimed when unprotected — ad-hoc retags (incident-clean-*) were
    // immortal because they matched no GC branch.
    expect(capacity).toContain('remove unclassified app tag');
    expect(capacity).toContain('removed_unclassified=');
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
    expect(workflow).toContain(
      'node scripts/deploy/verify-backend-dist-provenance.mjs "${PROJECTS}"',
    );
    expect(provenance).toContain('stale compiled app files detected');
    expect(provenance).toContain("apps', project, 'src");
    expect(provenance).toContain("dist', 'apps', project");
  });

  it('builds the production PostgreSQL WAL-G image through the catalog infra matrix', () => {
    const generated = JSON.parse(read('infrastructure/deploy/service-catalog.generated.json')) as {
      deploy?: {
        infraImageMatrix?: Array<{ image: string; dockerfile: string; context: string }>;
      };
    };
    const workflow = read('.github/workflows/deploy-digitalocean.yml');

    expect(generated.deploy?.infraImageMatrix).toContainEqual({
      image: 'postgres',
      dockerfile: 'infrastructure/docker/Dockerfile.postgres-walg',
      context: '.',
    });
    expect(workflow).toContain('data.deploy?.infraImageMatrix');
    expect(workflow).toContain('BUILD_MAIN_SHA=${{ github.sha }}');
    expect(workflow).toContain('POSTGRES_DR_CONTRACT_SHA256=');
    expect(workflow).toContain('sha256sum --strict --check "${CONTRACT_MANIFEST}"');
  });

  it('expands manual selective deploys with migration owner services from the catalog', () => {
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const resolver = read('scripts/deploy/resolve-migration-owner-services.mjs');

    expect(workflow).toContain(
      'MIGRATION_OWNER_SERVICES="$(node scripts/deploy/resolve-migration-owner-services.mjs',
    );
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
    const duFunction = /du_filesystem_snapshot\(\) \{[\s\S]*?\n\}/.exec(capacity)?.[0] ?? '';

    expect(capacity).toContain('Top-level disk usage (same filesystem only):');
    expect(capacity).toContain('Docker image inventory:');
    expect(duFunction).not.toEqual('');
    expect((capacity.match(/\bdu -x -B1/g) ?? []).length).toBe(1);
    expect(duFunction).toContain('"-d${depth}"');
    expect(capacity).toContain('docker image ls --format');
    expect(capacity).toContain('CAPACITY_DISK_USAGE_MODE');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_SECONDS');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_SECONDS="${CAPACITY_DU_TIMEOUT_SECONDS:-120}"');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_MAX_SECONDS=120');
    expect(capacity).toContain('CAPACITY_DU_KILL_GRACE_SECONDS=5');
    expect(capacity).toContain('CAPACITY_NON_DU_HEADROOM_SECONDS=300');
    expect(capacity).toContain('CAPACITY_SUMMARY_DU_DEPTH=1');
    expect(capacity).toContain('CAPACITY_DEEP_DU_DEPTH=3');
    // Docker subtrees are excluded from the du walk — their bytes come from
    // `docker system df`; traversing overlay2 inodes is what timed the walk
    // out exactly when capacity triage needed the non-docker attribution.
    expect(duFunction).toContain('"--exclude=$(docker_root)"');
    expect(duFunction).toContain('--exclude=/var/lib/containerd /)');
    // A single root traversal at depth 3 replaces the old nested /, /var,
    // /var/lib, /var/aqua-saas, and /tmp scan loop.
    expect(capacity).not.toContain('disk_usage_paths()');
    expect(capacity).toContain('scope=/ max_depth=${depth}');
    expect(capacity).toContain('disk_usage_unavailable');
    expect(capacity).toContain('detect_docker_root');
    expect(capacity).toContain("awk 'NF {print; exit}'");
    expect(capacity).toContain("awk 'NR <= 40");
    expect(capacity).not.toContain('head -40');
  });

  it('keeps one final capacity diagnostic bounded below deploy and maintenance budgets', () => {
    const capacity = read('scripts/deploy/droplet-capacity.sh');
    const workflow = read('.github/workflows/deploy-digitalocean.yml');
    const maintenance = read('.github/workflows/deploy-capacity-maintenance.yml');
    const capacityJobBlock =
      /\n {2}capacity-preflight:\n[\s\S]*?\n {2}# ===========================================================================/.exec(
        workflow,
      )?.[0] ?? '';
    const maintenanceJobBlock = /\n {2}capacity-maintenance:\n[\s\S]*/.exec(maintenance)?.[0] ?? '';
    const runGateStart = capacity.indexOf('run_gate() {');
    const runGateEnd = capacity.indexOf('case "${command}"');
    const runGateBlock =
      runGateStart >= 0 && runGateEnd > runGateStart
        ? capacity.slice(runGateStart, runGateEnd)
        : '';

    expect(capacityJobBlock).not.toEqual('');
    expect(maintenanceJobBlock).not.toEqual('');
    expect(runGateBlock).not.toEqual('');
    expect(runGateBlock).toContain('capacity_core_snapshot');
    expect(runGateBlock).toContain('capacity_diagnostic_snapshot');
    expect(runGateBlock).not.toContain('capacity_snapshot');
    expect((runGateBlock.match(/capacity_diagnostic_snapshot/g) ?? []).length).toBe(1);
    expect(runGateBlock.indexOf('capacity_diagnostic_snapshot')).toBeGreaterThan(
      runGateBlock.lastIndexOf('capacity_failures'),
    );

    const duTimeoutSeconds = Number(
      /CAPACITY_DU_TIMEOUT_SECONDS="\$\{CAPACITY_DU_TIMEOUT_SECONDS:-(\d+)\}"/.exec(capacity)?.[1],
    );
    const duKillGraceSeconds = Number(/CAPACITY_DU_KILL_GRACE_SECONDS=(\d+)/.exec(capacity)?.[1]);
    const nonDuHeadroomSeconds = Number(
      /CAPACITY_NON_DU_HEADROOM_SECONDS=(\d+)/.exec(capacity)?.[1],
    );
    const jobTimeoutMinutes = Number(/timeout-minutes:\s*(\d+)/.exec(capacityJobBlock)?.[1]);
    const commandTimeoutMinutes = Number(/command_timeout:\s*(\d+)m/.exec(capacityJobBlock)?.[1]);
    const maintenanceJobTimeoutMinutes = Number(
      /timeout-minutes:\s*(\d+)/.exec(maintenanceJobBlock)?.[1],
    );
    const maintenanceCommandTimeoutMinutes = Number(
      /command_timeout:\s*(\d+)m/.exec(maintenanceJobBlock)?.[1],
    );

    expect(duTimeoutSeconds).toBe(120);
    expect(duKillGraceSeconds).toBe(5);
    expect(nonDuHeadroomSeconds).toBe(300);
    expect(commandTimeoutMinutes).toBeLessThan(jobTimeoutMinutes);
    expect(duTimeoutSeconds + duKillGraceSeconds + nonDuHeadroomSeconds).toBeLessThan(
      commandTimeoutMinutes * 60,
    );
    expect(maintenanceCommandTimeoutMinutes).toBeLessThan(maintenanceJobTimeoutMinutes);
    expect(duTimeoutSeconds + duKillGraceSeconds + nonDuHeadroomSeconds).toBeLessThan(
      maintenanceCommandTimeoutMinutes * 60,
    );
  });

  it('keeps safe image GC to one post-GC deep traversal', () => {
    const maintenance = read('.github/workflows/deploy-capacity-maintenance.yml');
    const safeImageGcBlock = /safe-image-gc\)\n[\s\S]*?\n\s+;;/.exec(maintenance)?.[0] ?? '';

    expect(safeImageGcBlock).not.toEqual('');
    expect(safeImageGcBlock).toContain(
      'CAPACITY_DISK_USAGE_MODE=off bash scripts/deploy/droplet-capacity.sh report',
    );
    expect(safeImageGcBlock).toContain('bash scripts/deploy/droplet-capacity.sh gc');
    expect(safeImageGcBlock).toContain(
      'CAPACITY_GC_MODE=off CAPACITY_DISK_USAGE_MODE=deep bash scripts/deploy/droplet-capacity.sh gate',
    );
    expect((safeImageGcBlock.match(/CAPACITY_DISK_USAGE_MODE=deep/g) ?? []).length).toBe(1);
  });

  it('executes one canonical deep du and rejects over-limit timeouts before invocation', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-du-args-'));
    const invocationLog = join(fakeBin, 'du-invocations.log');
    const timeoutPath = join(fakeBin, 'timeout');
    const duPath = join(fakeBin, 'du');
    const dockerPath = join(fakeBin, 'docker');
    writeFileSync(
      timeoutPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --signal=*|--kill-after=*) shift ;;',
        '    *s) shift; break ;;',
        '    *) exit 64 ;;',
        '  esac',
        'done',
        'exec "$@"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      duPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf "%s\\n" "$*" >> "${DU_INVOCATION_LOG}"',
        'printf "4096\\t/tmp/capacity-artifact-tree\\n"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    chmodSync(timeoutPath, 0o755);
    chmodSync(duPath, 0o755);
    chmodSync(dockerPath, 0o755);

    try {
      const report = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'report'],
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            CAPACITY_DISK_USAGE_MODE: 'deep',
            DU_INVOCATION_LOG: invocationLog,
            DOCKER_ROOT_DIR: '/var/lib/docker',
          },
          encoding: 'utf8',
        },
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe(0);
      expect(readFileSync(invocationLog, 'utf8').trim().split('\n')).toEqual([
        '-x -B1 -d3 --exclude=/var/lib/docker --exclude=/var/lib/containerd /',
      ]);
      expect(report.stdout).toContain('path=/tmp/capacity-artifact-tree');

      for (const invalidTimeout of ['121', '900']) {
        const rejected = spawnSync(
          'bash',
          [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'report'],
          {
            env: {
              ...process.env,
              PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
              CAPACITY_DISK_USAGE_MODE: 'deep',
              CAPACITY_DU_TIMEOUT_SECONDS: invalidTimeout,
              DU_INVOCATION_LOG: invocationLog,
              DOCKER_ROOT_DIR: '/var/lib/docker',
            },
            encoding: 'utf8',
          },
        );
        expect(rejected.error).toBeUndefined();
        expect(rejected.status).toBe(0);
        expect(rejected.stdout).toContain(
          `disk_usage_unavailable reason=invalid_timeout_seconds value=${invalidTimeout} allowed_range=1-120`,
        );
        expect(readFileSync(invocationLog, 'utf8').trim().split('\n')).toHaveLength(1);
      }
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('keeps a bounded du timeout non-fatal to the canonical capacity verdict', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-test-'));
    const timeoutPath = join(fakeBin, 'timeout');
    const dockerPath = join(fakeBin, 'docker');
    writeFileSync(timeoutPath, '#!/usr/bin/env bash\nexit 124\n');
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    chmodSync(timeoutPath, 0o755);
    chmodSync(dockerPath, 0o755);

    const baseEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CAPACITY_DISK_USAGE_MODE: 'deep',
      CAPACITY_DU_TIMEOUT_SECONDS: '1',
      CAPACITY_GC_MODE: 'off',
      FULL_DEPLOY: 'false',
      DEPLOY_PROJECTED_PULL_BYTES: '0',
      SELECTIVE_HARD_FREE_GIB: '0',
      SELECTIVE_WARN_FREE_GIB: '0',
      SELECTIVE_HARD_FREE_PERCENT: '0',
      SELECTIVE_PROJECTED_RESERVE_GIB: '0',
      HARD_INODE_FREE_PERCENT: '0',
      WARN_INODE_FREE_PERCENT: '0',
    };

    try {
      const passing = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'gate'],
        { env: baseEnv, encoding: 'utf8' },
      );
      expect(passing.error).toBeUndefined();
      expect(passing.status).toBe(0);
      expect(passing.stdout).toContain('disk_usage_unavailable path=/ reason=timeout');
      expect(passing.stdout).toContain('Capacity preflight: PASS');

      const failing = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'gate'],
        {
          env: { ...baseEnv, SELECTIVE_HARD_FREE_GIB: '1000000' },
          encoding: 'utf8',
        },
      );
      expect(failing.error).toBeUndefined();
      expect(failing.status).toBe(1);
      expect(failing.stdout).toContain('disk_preflight_low_bytes');
      expect(failing.stdout).toContain('disk_usage_unavailable path=/ reason=timeout');
      expect(failing.stdout).toContain('Capacity preflight failed');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
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

    // DATA-HIGH-001 (mirror collapse): the messaging-partition privilege recipe
    // — re-own to messaging_schema_owner AND the runtime-DML grant that MUST
    // travel with it — lives in ONE SSoT function that both the Stage 010
    // backfill and the TS provisioner forward path call. This regression guard
    // fails if the runtime DML grant or its forward cover ever goes missing
    // again (the "permission denied for table messages" bug), or if either
    // caller re-inlines the recipe instead of delegating.
    expect(partitionDefiner).toContain(
      'CREATE OR REPLACE FUNCTION platform.grant_messaging_partition_authority',
    );
    expect(partitionDefiner).toContain(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO messaging_service',
    );
    expect(partitionDefiner).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE messaging_schema_owner IN SCHEMA %I ',
    );
    // The backfill delegates to the function — the recipe is not re-inlined.
    expect(partitionDefiner).toContain(
      'PERFORM platform.grant_messaging_partition_authority(tenant_schema)',
    );
    // The TS provisioner forward path calls the SAME function, never a
    // hand-mirrored GRANT/ALTER sequence.
    const messagingPartitionTs = read(
      'libs/backend-common/src/database/messaging-partition-privileges.ts',
    );
    expect(messagingPartitionTs).toContain(
      'SELECT platform.grant_messaging_partition_authority($1)',
    );
    // The recipe is not re-inlined in TS: no executor.query emitting the
    // re-own / grant SQL directly (a comment may still describe the recipe).
    expect(messagingPartitionTs).not.toContain('OWNER TO "${MESSAGING_PARTITION_OWNER_ROLE}"');

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
      'CAPACITY_GC_MODE=auto CAPACITY_DISK_USAGE_MODE=deep bash scripts/deploy/droplet-capacity.sh gate',
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
