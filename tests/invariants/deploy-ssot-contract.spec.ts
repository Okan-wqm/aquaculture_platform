import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), 'utf8');
}

interface CapacityAutoGcScenario {
  initialFreeBytes: string;
  reclaimedPerImageBytes: string;
  projectedPullBytes: string;
  projectedReserveGib: string;
}

interface CapacityAutoGcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  removals: string[];
  dockerInvocations: string[];
}

function runCapacityAutoGcScenario(scenario: CapacityAutoGcScenario): CapacityAutoGcResult {
  const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-auto-gc-'));
  const dockerPath = join(fakeBin, 'docker');
  const dfPath = join(fakeBin, 'df');
  const removalState = join(fakeBin, 'removal-count');
  const removalLog = join(fakeBin, 'removals.log');
  const dockerInvocationLog = join(fakeBin, 'docker-invocations.log');
  writeFileSync(removalState, '0\n');
  writeFileSync(removalLog, '');
  writeFileSync(dockerInvocationLog, '');
  writeFileSync(
    dockerPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\0" "$*" >> "${DOCKER_INVOCATION_LOG}"',
      'case "${1:-}" in',
      '  info)',
      '    printf "%s\\n" "${DOCKER_ROOT_DIR}"',
      '    ;;',
      '  system)',
      '    printf "TYPE TOTAL ACTIVE SIZE RECLAIMABLE\\nImages 3 0 6GB 6GB\\n"',
      '    ;;',
      '  ps)',
      '    printf "running-a\\nrunning-b\\n"',
      '    ;;',
      '  inspect)',
      '    printf "sha256:running-image-a\\nsha256:running-image-b\\n"',
      '    ;;',
      '  image)',
      '    case "${2:-}" in',
      '      prune) printf "Total reclaimed space: 0B\\n" ;;',
      '      ls)',
      '        printf "%s\\n" \\',
      '          "${IMAGE_PREFIX}/svc-a 1111111111111111111111111111111111111111 image-a" \\',
      '          "${IMAGE_PREFIX}/svc-b 2222222222222222222222222222222222222222 image-b" \\',
      '          "${IMAGE_PREFIX}/svc-c 3333333333333333333333333333333333333333 image-c"',
      '        ;;',
      '    esac',
      '    ;;',
      '  rmi)',
      '    count="$(< "${RMI_STATE_FILE}")"',
      '    count=$((count + 1))',
      '    printf "%s\\n" "${count}" > "${RMI_STATE_FILE}"',
      '    printf "%s\\n" "${2}" >> "${RMI_LOG}"',
      '    printf "Deleted: %s\\n" "${2}"',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
  writeFileSync(
    dfPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'count="$(< "${RMI_STATE_FILE}")"',
      'avail=$((INITIAL_FREE_BYTES + count * RECLAIMED_PER_IMAGE_BYTES))',
      'mode=bytes',
      'for arg in "$@"; do',
      '  case "${arg}" in',
      '    -Pi) mode=inodes ;;',
      '    -k) mode=kilobytes ;;',
      '  esac',
      'done',
      'case "${mode}" in',
      '  inodes)',
      '    printf "Filesystem Inodes IUsed IFree IUse%% Mounted-on\\n/dev/fake 1000 100 900 10%% /\\n"',
      '    ;;',
      '  kilobytes)',
      '    printf "Avail\\n%s\\n" "$((avail / 1024))"',
      '    ;;',
      '  bytes)',
      '    printf "Filesystem 1-blocks Used Available Capacity Mounted-on\\n"',
      '    printf "/dev/fake %s %s %s 1%% /\\n" "${FS_SIZE_BYTES}" "$((FS_SIZE_BYTES - avail))" "${avail}"',
      '    ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(dockerPath, 0o755);
  chmodSync(dfPath, 0o755);

  try {
    const result = spawnSync(
      'bash',
      [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'gate'],
      {
        env: {
          ...process.env,
          PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
          TMPDIR: fakeBin,
          DOCKER_ROOT_DIR: fakeBin,
          DOCKER_INVOCATION_LOG: dockerInvocationLog,
          RMI_STATE_FILE: removalState,
          RMI_LOG: removalLog,
          INITIAL_FREE_BYTES: scenario.initialFreeBytes,
          RECLAIMED_PER_IMAGE_BYTES: scenario.reclaimedPerImageBytes,
          FS_SIZE_BYTES: '10737418240',
          IMAGE_PREFIX: 'ghcr.io/example/aqua',
          DEPLOY_SHA: 'ffffffffffffffffffffffffffffffffffffffff',
          FULL_DEPLOY: 'false',
          DEPLOY_SERVICES: 'svc-a svc-b svc-c',
          DEPLOY_PROJECTED_PULL_BYTES: scenario.projectedPullBytes,
          SELECTIVE_HARD_FREE_GIB: '0',
          SELECTIVE_WARN_FREE_GIB: '3',
          SELECTIVE_HARD_FREE_PERCENT: '0',
          SELECTIVE_PROJECTED_RESERVE_GIB: scenario.projectedReserveGib,
          HARD_INODE_FREE_PERCENT: '0',
          WARN_INODE_FREE_PERCENT: '0',
          CAPACITY_GC_MODE: 'auto',
          CAPACITY_DISK_USAGE_MODE: 'off',
        },
        encoding: 'utf8',
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      removals: readFileSync(removalLog, 'utf8').trim().split('\n').filter(Boolean),
      dockerInvocations: readFileSync(dockerInvocationLog, 'utf8').split('\0').filter(Boolean),
    };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
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

    expect(generated.deploy?.infraImageMatrix).toContainEqual(
      expect.objectContaining({
        image: 'postgres',
        dockerfile: 'infrastructure/docker/Dockerfile.postgres-walg',
        context: '.',
        buildInputGlobs: expect.arrayContaining([
          'infrastructure/docker/Dockerfile.postgres-walg',
          'infrastructure/docker/scripts/postgres-walg-healthcheck.sh',
        ]),
      }),
    );
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

  it('binds admin-api and gateway to distinct NATS certificate identities across deploy targets', () => {
    const droplet = read('docker-compose.droplet.yml');
    const prod = extractComposeServiceBlock(read('docker-compose.prod.yml'), 'admin-api-service');
    const identities = read('infrastructure/helm/aquaculture/files/nats-service-identities.yaml');
    const certificates = read(
      'infrastructure/helm/aquaculture/templates/internal-certificates.yaml',
    );
    const helpers = read('infrastructure/helm/aquaculture/templates/_helpers.tpl');
    const certGenerator = read('infrastructure/docker/scripts/generate-internal-certs.sh');

    expect(droplet).toContain('x-nats-admin-api-env: &nats-admin-api-env');
    expect(droplet).toContain('/admin_api_service-cert.pem');
    expect(extractComposeServiceBlock(droplet, 'admin-api-service')).toContain(
      '<<: *nats-admin-api-env',
    );
    expect(prod).toContain('/admin_api_service-cert.pem');
    expect(prod).toContain('/admin_api_service-key.pem');
    expect(prod).not.toContain('/gateway_service-cert.pem');
    expect(prod).toMatch(/\n {6}nats:\n {8}condition: service_healthy/);

    expect(identities).toContain('  - admin_api_service');
    expect(identities).toContain('  - gateway_service');
    expect(certificates).toContain('files/nats-service-identities.yaml');
    expect(certificates).toContain('commonName: {{ $identity | quote }}');
    expect(certificates).not.toContain('commonName: aqua-services');
    expect(helpers).toContain('aquaculture.natsClientSecretName');
    expect(helpers).toContain('secretName: {{ include "aquaculture.natsClientSecretName"');

    expect(certGenerator).toContain('validate_per_service_client_cert');
    expect(certGenerator).toContain('subject=CN=${svc_user}');
    expect(certGenerator).toContain('openssl verify -CAfile');
    expect(certGenerator).toContain('certificate and private key do not match');
  });

  it('reloads and proves the NATS ACL before rolling application identities', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const staging = read('.github/workflows/deploy-staging.yml');
    const fullBranch = deploy.slice(deploy.indexOf('if deploy_uses_full_stack_path; then'));
    const selectiveBranch = fullBranch.slice(
      fullBranch.indexOf('else\n  # ── Application rollout'),
    );

    expect(deploy).toContain('ensure_nats_acl_loaded()');
    expect(deploy).toContain('sha256sum "${mounted_source}"');
    expect(deploy).toContain('stat -c \'%Y\' "${mounted_source}"');
    expect(deploy).toContain("docker inspect --format '{{.State.StartedAt}}'");
    expect(deploy).toContain('[ "${source_mtime}" -lt "${started_epoch}" ]');
    expect(deploy).toContain('--force-recreate nats');
    expect(deploy).toContain('run --rm --no-deps -T nats');
    expect(deploy).toContain('live broker was not replaced');
    expect(deploy).toContain('NATS did not become healthy after ACL reload');
    expect(deploy).toContain('NATS_ACL_RELOADED=true');

    expect(fullBranch.indexOf('ensure_nats_acl_loaded')).toBeLessThan(
      fullBranch.indexOf('run_db_migrate_or_exit "full deploy"'),
    );
    expect(selectiveBranch).toContain('up -d --no-build postgres redis minio');
    expect(selectiveBranch).not.toContain('up -d --no-build postgres redis nats minio');
    expect(selectiveBranch.indexOf('ensure_nats_acl_loaded')).toBeLessThan(
      selectiveBranch.indexOf('RESTART_SERVICES=$(restartable_deploy_services'),
    );
    expect(selectiveBranch).toContain('admin-api-service');

    expect(staging.indexOf('Reloading staging NATS ACL first')).toBeLessThan(
      staging.indexOf('Starting staging stack'),
    );
    expect(staging).toContain('run --rm --no-deps -T nats -t -c /etc/nats/nats.conf');
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

  it('restarts long-running compose consumers when their shared image is deployed', () => {
    const generated = read('infrastructure/deploy/service-catalog.deploy.vars');
    const deploy = read('scripts/deploy/droplet-up.sh');
    expect(generated).toContain(
      "CATALOG_SHARED_IMAGE_RESTART_SERVICES='db-migrate:tenant-schema-provisioner'",
    );
    expect(deploy).toContain(
      'SHARED_IMAGE_RESTART_SERVICES="${CATALOG_SHARED_IMAGE_RESTART_SERVICES:?generated shared image restart services missing}"',
    );
    expect(deploy).toContain(
      'DEPLOY_SERVICES="${APPLICATION_IMAGE_SERVICES}" restartable_deploy_services',
    );
    expect(deploy).toContain('image_service_for_compose_service "${svc}"');

    const result = spawnSync(
      'bash',
      [
        '-c',
        [
          'source scripts/deploy/lib/deployment-mode-policy.sh',
          "DEPLOY_SERVICES='db-migrate farm-service'",
          "SHARED_IMAGE_RESTART_SERVICES='db-migrate:tenant-schema-provisioner'",
          'restartable_deploy_services',
          'image_service_for_compose_service tenant-schema-provisioner',
          'image_service_for_compose_service farm-service',
        ].join('; '),
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim().split('\n')).toEqual([
      'tenant-schema-provisioner',
      'farm-service',
      'db-migrate',
      'farm-service',
    ]);

    const frontendOnly = spawnSync(
      'bash',
      [
        '-c',
        [
          'source scripts/deploy/lib/deployment-mode-policy.sh',
          "DEPLOY_SERVICES='shell'",
          "SHARED_IMAGE_RESTART_SERVICES='db-migrate:tenant-schema-provisioner'",
          'restartable_deploy_services',
        ].join('; '),
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );

    expect(frontendOnly.status).toBe(0);
    expect(frontendOnly.stderr).toBe('');
    expect(frontendOnly.stdout.trim()).toBe('shell');
  });

  it('bounds failure log collection and skips healthy running containers without healthchecks', () => {
    const deploy = read('scripts/deploy/droplet-up.sh');
    const diagnostics = /dump_nonhealthy_container_logs\(\) \{[\s\S]*?\n\}/.exec(deploy)?.[0] ?? '';

    expect(diagnostics).not.toEqual('');
    expect(diagnostics).toContain("RUNNING=$(docker inspect --format='{{.State.Running}}'");
    expect(diagnostics).toContain('[ "$HEALTH" = "none" ] && [ "$RUNNING" = "true" ]');
    expect(diagnostics).toContain('timeout --kill-after=5s "${CONTAINER_LOG_TIMEOUT_SECONDS}s"');
  });

  it('reports droplet capacity evidence without mutating data-bearing storage', () => {
    const capacity = read('scripts/deploy/droplet-capacity.sh');
    const duFunction = /du_frontier_snapshot\(\) \{[\s\S]*?\n\}/.exec(capacity)?.[0] ?? '';

    expect(capacity).toContain('Top-level disk usage (same filesystem only):');
    expect(capacity).toContain('Docker image inventory:');
    expect(duFunction).not.toEqual('');
    expect(duFunction).toContain('du -sx -B1 --null -- "${scope_path}"');
    expect(duFunction).not.toContain(' -d1 ');
    expect(capacity).toContain('docker image ls --format');
    expect(capacity).toContain('CAPACITY_DISK_USAGE_MODE');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_SECONDS');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_SECONDS="${CAPACITY_DU_TIMEOUT_SECONDS:-120}"');
    expect(capacity).toContain('CAPACITY_DU_TIMEOUT_MAX_SECONDS=120');
    expect(capacity).toContain('CAPACITY_DU_KILL_GRACE_SECONDS=5');
    expect(capacity).toContain('CAPACITY_NON_DU_HEADROOM_SECONDS=300');
    expect(capacity).toContain('CAPACITY_DU_PARALLELISM=4');
    expect(capacity).toContain('CAPACITY_DU_MAX_SCOPES=512');
    expect(capacity).toContain('CAPACITY_DU_SCOPE_TIMEOUT_SECONDS=15');
    expect(capacity).toContain('CAPACITY_DU_DISCOVERY_TIMEOUT_SECONDS=20');
    expect(capacity).toContain('CAPACITY_DU_MAX_DISCOVERY_CALLS=64');
    expect(capacity).toContain('CAPACITY_DU_MAX_CHILDREN_PER_DIRECTORY=128');
    expect(capacity).toContain('CAPACITY_DU_MAX_UNAVAILABLE_RECORDS=64');
    expect(capacity).toContain('CAPACITY_DU_MAX_RESULT_BYTES=8192');
    // Docker subtrees are excluded from the du walk — their bytes come from
    // `docker system df`; traversing overlay2 inodes is what timed the walk
    // out exactly when capacity triage needed the non-docker attribution.
    expect(capacity).toContain('emit_exclusion_safe_frontier');
    expect(capacity).toContain('[ "${candidate_path}" = "${docker_path}" ]');
    expect(capacity).toContain('[ "${candidate_path}" = "${containerd_path}" ]');
    // Hotspot children are separate summary scopes; every emitted scope is
    // disjoint and shares the same discovery + du deadline.
    expect(capacity).not.toContain('disk_usage_paths()');
    expect(capacity).toContain('scope=disjoint_frontier');
    expect(capacity).toContain('capacity_hotspot_frontier');
    expect(capacity).toContain('head -z -n');
    expect(capacity).toContain('head -c "${CAPACITY_DU_MAX_RESULT_BYTES}"');
    expect(duFunction).toContain('"${scope_timeout}s" du -sx');
    expect(capacity).toContain('global_timeout_seconds=${CAPACITY_DU_TIMEOUT_SECONDS}');
    expect(capacity).toContain('timeout_label=scope_timeout_seconds');
    expect(capacity).toContain('timeout_label=discovery_timeout_seconds');
    expect(capacity).toContain('frontier_scopes_discovered=');
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
    const safeImageGcBlock =
      /safe-image-gc\s*\|\s*gate\)\n[\s\S]*?\n\s+;;/.exec(maintenance)?.[0] ?? '';

    expect(safeImageGcBlock).not.toEqual('');
    expect(safeImageGcBlock).toContain(
      'CAPACITY_GC_MODE=auto CAPACITY_DISK_USAGE_MODE=deep bash scripts/deploy/droplet-capacity.sh gate',
    );
    expect(safeImageGcBlock).not.toContain('droplet-capacity.sh report');
    expect(safeImageGcBlock).not.toContain('droplet-capacity.sh gc');
    expect((safeImageGcBlock.match(/CAPACITY_DISK_USAGE_MODE=deep/g) ?? []).length).toBe(1);
  });

  it('stops automatic image GC once a hard verdict becomes warning-only', () => {
    const result = runCapacityAutoGcScenario({
      initialFreeBytes: '1610612736',
      reclaimedPerImageBytes: '805306368',
      projectedPullBytes: '1073741824',
      projectedReserveGib: '1',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.removals).toEqual([
      'ghcr.io/example/aqua/svc-a:1111111111111111111111111111111111111111',
    ]);
    expect(result.stdout).toContain('Capacity GC target met: hard failures cleared');
    expect(result.stdout).toContain('Capacity preflight: PASS with warnings');
  });

  it('continues automatic image GC until an initial warning clears', () => {
    const result = runCapacityAutoGcScenario({
      initialFreeBytes: '1610612736',
      reclaimedPerImageBytes: '805306368',
      projectedPullBytes: '0',
      projectedReserveGib: '0',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.removals).toEqual([
      'ghcr.io/example/aqua/svc-a:1111111111111111111111111111111111111111',
      'ghcr.io/example/aqua/svc-b:2222222222222222222222222222222222222222',
    ]);
    expect(result.stdout).toContain('Capacity GC target met: warnings cleared');
    expect(result.stdout).toContain('Capacity preflight: PASS');
  });

  it('bounds Docker metadata discovery during capacity recovery', () => {
    const result = runCapacityAutoGcScenario({
      initialFreeBytes: '1610612736',
      reclaimedPerImageBytes: '805306368',
      projectedPullBytes: '1073741824',
      projectedReserveGib: '1',
    });
    const systemDfCalls = result.dockerInvocations.filter((call) => call.startsWith('system df'));
    const imageListCalls = result.dockerInvocations.filter((call) => call.startsWith('image ls'));
    const inspectCalls = result.dockerInvocations.filter((call) => call.startsWith('inspect '));

    expect(systemDfCalls).toHaveLength(1);
    expect(imageListCalls).toHaveLength(2);
    expect(inspectCalls).toHaveLength(1);
    expect(inspectCalls[0]).toContain('running-a running-b');
  });

  it('executes one bounded disjoint frontier and rejects over-limit timeouts before invocation', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-du-args-'));
    const invocationLog = join(fakeBin, 'du-invocations.log');
    const timeoutPath = join(fakeBin, 'timeout');
    const duPath = join(fakeBin, 'du');
    const dockerPath = join(fakeBin, 'docker');
    const findPath = join(fakeBin, 'find');
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
        'scope="${!#}"',
        'printf "4096\\t%s\\0" "${scope}"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      findPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "${1:-}" in',
        '  /) printf "/opt\\0/tmp\\0/var\\0" ;;',
        '  /tmp) printf "%s\\0" "${FAKE_HOTSPOT_SCOPE}" ;;',
        '  /var/aqua-saas|/var/suderra-os) : ;;',
        '  /var) printf "/var/aqua-saas\\0/var/lib\\0/var/log\\0/var/suderra-os\\0" ;;',
        '  /var/lib) printf "/var/lib/docker\\0/var/lib/containerd\\0/var/lib/postgresql\\0" ;;',
        '  *) : ;;',
        'esac',
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
    chmodSync(findPath, 0o755);

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
            FAKE_HOTSPOT_SCOPE: fakeBin,
            DOCKER_ROOT_DIR: '/var/lib/docker',
          },
          encoding: 'utf8',
        },
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe(0);
      const invocations = readFileSync(invocationLog, 'utf8').trim().split('\n');
      expect(invocations).toContain(`-sx -B1 --null -- ${fakeBin}`);
      expect(invocations).toContain('-sx -B1 --null -- /opt');
      expect(invocations).toContain('-sx -B1 --null -- /var/log');
      expect(invocations.every((invocation) => invocation.startsWith('-sx '))).toBe(true);
      expect(invocations).not.toContain('-sx -B1 --null -- /tmp');
      expect(invocations).not.toContain('-sx -B1 --null -- /var/aqua-saas');
      expect(invocations).not.toContain('-sx -B1 --null -- /var/suderra-os');
      expect(invocations.some((invocation) => invocation.includes('/var/lib/docker'))).toBe(false);
      expect(invocations.some((invocation) => invocation.includes('/var/lib/containerd'))).toBe(
        false,
      );
      expect(new Set(invocations).size).toBe(invocations.length);
      expect(report.stdout).toContain(`path=${fakeBin}`);
      const invocationCount = invocations.length;

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
              FAKE_HOTSPOT_SCOPE: fakeBin,
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
        expect(readFileSync(invocationLog, 'utf8').trim().split('\n')).toHaveLength(
          invocationCount,
        );
      }
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('keeps a bounded du timeout non-fatal to the canonical capacity verdict', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-test-'));
    const timeoutPath = join(fakeBin, 'timeout');
    const dockerPath = join(fakeBin, 'docker');
    const findPath = join(fakeBin, 'find');
    writeFileSync(timeoutPath, '#!/usr/bin/env bash\nexit 124\n');
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    writeFileSync(
      findPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = / ]; then printf "/tmp\\0"; else exec /usr/bin/find "$@"; fi\n',
    );
    chmodSync(timeoutPath, 0o755);
    chmodSync(dockerPath, 0o755);
    chmodSync(findPath, 0o755);

    const baseEnv = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      CAPACITY_DISK_USAGE_MODE: 'deep',
      CAPACITY_DU_TIMEOUT_SECONDS: '3',
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
      expect(passing.stdout).toContain('disk_usage_unavailable path=');
      expect(passing.stdout).toContain(
        'reason=du_timeout detail=124 global_timeout_seconds=3 scope_timeout_seconds=',
      );
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
      expect(failing.stdout).toContain('disk_usage_unavailable path=');
      expect(failing.stdout).toContain(
        'reason=du_timeout detail=124 global_timeout_seconds=3 scope_timeout_seconds=',
      );
      expect(failing.stdout).toContain('Capacity preflight failed');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('preserves completed frontier evidence when one hotspot times out', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-partial-'));
    const duPath = join(fakeBin, 'du');
    const dockerPath = join(fakeBin, 'docker');
    const findPath = join(fakeBin, 'find');
    writeFileSync(
      duPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'scope="${!#}"',
        'if [ "${scope}" = "${SLOW_SCOPE}" ]; then while :; do :; done; fi',
        'printf "4096\\t%s\\0" "${scope}"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    writeFileSync(
      findPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "${1:-}" in',
        '  /) printf "/tmp\\0/opt\\0" ;;',
        '  /tmp) printf "%s\\0" "${SLOW_SCOPE}" ;;',
        '  *) : ;;',
        'esac',
        '',
      ].join('\n'),
    );
    for (const executable of [duPath, dockerPath, findPath]) {
      chmodSync(executable, 0o755);
    }

    try {
      const report = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'report'],
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            CAPACITY_DISK_USAGE_MODE: 'deep',
            CAPACITY_DU_TIMEOUT_SECONDS: '3',
            DOCKER_ROOT_DIR: '/var/lib/docker',
            SLOW_SCOPE: fakeBin,
          },
          encoding: 'utf8',
        },
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe(0);
      // The observable contract is that the completed /opt result survives
      // beside the explicit three-second timeout verdict. Host scheduling can
      // delay spawnSync after both child processes have already produced those
      // results, so parent wall-clock time is not evidence of this behavior.
      expect(report.stdout).toContain('bytes=4096 path=/opt');
      expect(report.stdout).toContain(
        `disk_usage_unavailable path=${fakeBin} reason=du_timeout detail=124 global_timeout_seconds=3 scope_timeout_seconds=`,
      );
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('releases four blocked workers at the per-scope quantum and starts the next scope', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-quantum-bin-'));
    const hotspotScopes = Array.from({ length: 5 }, () =>
      mkdtempSync(join(tmpdir(), 'aqua-capacity-quantum-scope-')),
    );
    const invocationLog = join(fakeBin, 'timeout-invocations.log');
    const timeoutPath = join(fakeBin, 'timeout');
    const duPath = join(fakeBin, 'du');
    const dockerPath = join(fakeBin, 'docker');
    const findPath = join(fakeBin, 'find');
    writeFileSync(
      timeoutPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'duration=',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --signal=*|--kill-after=*) shift ;;',
        '    *s) duration="$1"; shift; break ;;',
        '    *) exit 64 ;;',
        '  esac',
        'done',
        'if [ "${1:-}" = du ]; then',
        '  scope="${!#}"',
        '  printf "%s\\t%s\\n" "${duration}" "${scope}" >> "${TIMEOUT_INVOCATION_LOG}"',
        '  case ":${BLOCKED_SCOPES}:" in',
        '    *":${scope}:"*) sleep 0.2; exit 124 ;;',
        '  esac',
        'fi',
        'exec "$@"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      duPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nscope="${!#}"\nprintf "4096\\t%s\\0" "${scope}"\n',
    );
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    writeFileSync(
      findPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "${1:-}" in',
        '  /tmp)',
        '    IFS=: read -r -a scopes <<< "${HOTSPOT_SCOPES}"',
        '    for scope in "${scopes[@]}"; do printf "%s\\0" "${scope}"; done',
        '    ;;',
        '  /) printf "/tmp\\0/opt\\0" ;;',
        '  *) : ;;',
        'esac',
        '',
      ].join('\n'),
    );
    for (const executable of [timeoutPath, duPath, dockerPath, findPath]) {
      chmodSync(executable, 0o755);
    }

    try {
      const report = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'report'],
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            CAPACITY_DISK_USAGE_MODE: 'deep',
            DOCKER_ROOT_DIR: '/var/lib/docker',
            HOTSPOT_SCOPES: hotspotScopes.join(':'),
            BLOCKED_SCOPES: hotspotScopes.slice(0, 4).join(':'),
            TIMEOUT_INVOCATION_LOG: invocationLog,
          },
          encoding: 'utf8',
        },
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe(0);
      expect(report.stdout).toContain(`bytes=4096 path=${hotspotScopes[4]}`);
      for (const blockedScope of hotspotScopes.slice(0, 4)) {
        expect(report.stdout).toContain(
          `path=${blockedScope} reason=du_timeout detail=124 global_timeout_seconds=120 scope_timeout_seconds=15`,
        );
      }
      const timeoutInvocations = readFileSync(invocationLog, 'utf8').trim().split('\n');
      // Every blocked worker must consume the fixed quantum and the fifth
      // scope must actually start. Those side effects prove slot release
      // deterministically; elapsed parent-process time measures host load.
      for (const hotspotScope of hotspotScopes) {
        expect(timeoutInvocations).toContain(`15s\t${hotspotScope}`);
      }
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
      for (const hotspotScope of hotspotScopes) {
        rmSync(hotspotScope, { recursive: true, force: true });
      }
    }
  });

  it('bounds a blocked discovery phase and reports the incomplete parent', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-discovery-timeout-'));
    const duPath = join(fakeBin, 'du');
    const dockerPath = join(fakeBin, 'docker');
    const findPath = join(fakeBin, 'find');
    writeFileSync(
      duPath,
      '#!/usr/bin/env bash\nset -euo pipefail\nscope="${!#}"\nprintf "4096\\t%s\\0" "${scope}"\n',
    );
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    writeFileSync(
      findPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "${1:-}" in',
        '  /tmp) while :; do :; done ;;',
        '  /) printf "/tmp\\0/opt\\0" ;;',
        '  *) : ;;',
        'esac',
        '',
      ].join('\n'),
    );
    for (const executable of [duPath, dockerPath, findPath]) {
      chmodSync(executable, 0o755);
    }

    try {
      const startedAt = Date.now();
      const report = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'report'],
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            CAPACITY_DISK_USAGE_MODE: 'deep',
            CAPACITY_DU_TIMEOUT_SECONDS: '3',
            DOCKER_ROOT_DIR: '/var/lib/docker',
          },
          encoding: 'utf8',
        },
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(6_000);
      expect(report.stdout).toContain(
        'disk_usage_unavailable path=/tmp reason=discovery_timeout detail=124 global_timeout_seconds=3 discovery_timeout_seconds=',
      );
      expect(report.stdout).toContain('truncated=true');
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
    }
  });

  it('caps discovery records, worker output, and hostile filename handling', () => {
    const fakeBin = mkdtempSync(join(tmpdir(), 'aqua-capacity-output-cap-'));
    const hostileScope = mkdtempSync(join(tmpdir(), 'aqua capacity\n'));
    const invocationLog = join(fakeBin, 'du-scope-base64.log');
    const duPath = join(fakeBin, 'du');
    const dockerPath = join(fakeBin, 'docker');
    const findPath = join(fakeBin, 'find');
    writeFileSync(
      duPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'scope="${!#}"',
        // Encode first, then log the invocation as ONE append. A single
        // `printf` write of `<base64>\n` is < PIPE_BUF and therefore atomic
        // under O_APPEND, so the concurrent du workers the script spawns
        // (CAPACITY_DU_PARALLELISM) can never interleave partial log lines. An
        // earlier two-append form (base64, then newline separately) raced under
        // load, corrupting the per-scope line and making this test's invocation
        // count flaky on busy CI runners while passing locally. Keep the write
        // to one printf.
        'encoded_scope="$(printf "%s" "${scope}" | base64 -w0)"',
        'printf "%s\\n" "${encoded_scope}" >> "${DU_INVOCATION_LOG}"',
        'if [ "${scope}" = /opt ]; then printf "%09000d" 0; exit 0; fi',
        'printf "4096\\t%s\\0" "${scope}"',
        '',
      ].join('\n'),
    );
    writeFileSync(
      dockerPath,
      '#!/usr/bin/env bash\nif [ "${1:-}" = "info" ]; then echo /var/lib/docker; fi\nexit 0\n',
    );
    writeFileSync(
      findPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'case "${1:-}" in',
        '  /tmp)',
        '    for ((i = 0; i < 129; i++)); do printf "%s\\0" "${HOSTILE_SCOPE}"; done',
        '    ;;',
        '  /) printf "/tmp\\0/opt\\0" ;;',
        '  *) : ;;',
        'esac',
        '',
      ].join('\n'),
    );
    for (const executable of [duPath, dockerPath, findPath]) {
      chmodSync(executable, 0o755);
    }

    try {
      const report = spawnSync(
        'bash',
        [join(REPO_ROOT, 'scripts/deploy/droplet-capacity.sh'), 'report'],
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
            CAPACITY_DISK_USAGE_MODE: 'deep',
            DOCKER_ROOT_DIR: '/var/lib/docker',
            DU_INVOCATION_LOG: invocationLog,
            HOSTILE_SCOPE: hostileScope,
          },
          encoding: 'utf8',
        },
      );
      expect(report.error).toBeUndefined();
      expect(report.status).toBe(0);
      expect(report.stdout).toContain(
        'path=/tmp reason=discovery_scope_limit detail=128 global_timeout_seconds=120 discovery_timeout_seconds=0',
      );
      expect(report.stdout).toContain(
        'path=/opt reason=du_output_limit detail=8192 global_timeout_seconds=120 scope_timeout_seconds=15',
      );
      expect(report.stdout).toContain("path=$'/tmp/aqua capacity\\n");
      const encodedHostileScope = Buffer.from(hostileScope).toString('base64');
      expect(
        readFileSync(invocationLog, 'utf8')
          .trim()
          .split('\n')
          .filter((scope) => scope === encodedHostileScope),
      ).toHaveLength(1);
    } finally {
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(hostileScope, { recursive: true, force: true });
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

  it('keeps production locked separately and makes CI-Affected the development orchestrator', () => {
    const deployWorkflow = read('.github/workflows/deploy-digitalocean.yml');
    const developmentWorkflow = read('.github/workflows/deploy-development.yml');
    const ciAffected = read('.github/workflows/ci-affected.yml');
    expect(deployWorkflow).toContain('deployed:');
    expect(deployWorkflow).toContain("value: ${{ jobs.deploy.outputs.performed == 'true' }}");
    expect(deployWorkflow).toContain('Mark deployment performed');
    expect(developmentWorkflow).toContain('deployed:');
    expect(developmentWorkflow).toContain('Mark deployment performed');
    expect(ciAffected).toContain('build-development-images:');
    expect(ciAffected).toContain('deploy-development:');
    expect(ciAffected).toContain('uses: ./.github/workflows/build-images.yml');
    expect(ciAffected).toContain('uses: ./.github/workflows/deploy-development.yml');
    expect(ciAffected).not.toContain('uses: ./.github/workflows/deploy-staging.yml');
    expect(ciAffected).not.toContain('uses: ./.github/workflows/deploy-digitalocean.yml');
    expect(ciAffected).toContain("needs.pre-flight.result == 'success'");
    expect(read('scripts/ci/select-deployment-scope.ts')).toContain(
      "file.startsWith('.github/workflows/')",
    );
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
    expect(maintenance).not.toContain('bash scripts/deploy/droplet-capacity.sh gc');
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
