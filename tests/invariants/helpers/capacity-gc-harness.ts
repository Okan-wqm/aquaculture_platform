/**
 * Capacity GC harness — runs `scripts/deploy/droplet-capacity.sh gate` against
 * a fake `docker` and `df`, and reports exactly which image references the
 * script asked Docker to remove.
 *
 * One home (INFRA-CRITICAL-085): the harness grew up inside
 * deploy-ssot-contract.spec.ts for the auto-GC stop rules; the capacity
 * maintenance authority spec needs the same fake daemon to prove WHICH
 * repositories GC may touch. A second copy of the fake daemon would drift from
 * the first the moment one of them learned a new docker subcommand.
 *
 * The fake inventory is `${IMAGE_PREFIX}/svc-{a,b,c}` plus any `extraInventory`
 * rows, listed BEFORE the default rows so a scope defect removes them first.
 * The generated service catalog the script reads is a fixture file holding
 * `catalogServices` (default `svc-a svc-b svc-c`); `catalogServices: null`
 * points the script at a catalog that does not exist.
 *
 * Directory layout: the fake `docker`/`df` live alone in `bin/` (the only
 * directory prepended to PATH); everything the shims or the script write —
 * removal counter, logs, TMPDIR — lives in sibling directories. A shim whose
 * log or temp output landed in its own PATH directory could shadow or rewrite
 * an executable mid-run; keeping writers out of `bin/` rules that out.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { removeFixtureTree } from '../../../tools/gates/fixture-tree';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

export const CAPACITY_GC_FIXTURE_IMAGE_PREFIX = 'ghcr.io/example/aqua';

export interface CapacityAutoGcScenario {
  initialFreeBytes: string;
  reclaimedPerImageBytes: string;
  projectedPullBytes: string;
  /** Deploy-owned dependency install projection; defaults to '0'. */
  projectedDepsBytes?: string;
  projectedReserveGib: string;
  /** `repository tag id` rows listed ahead of the default svc-a/b/c rows. */
  extraInventory?: readonly string[];
  /** Catalog image services; `null` means the catalog file is absent. */
  catalogServices?: string | null;
}

export interface CapacityAutoGcResult {
  status: number | null;
  stdout: string;
  stderr: string;
  removals: string[];
  dockerInvocations: string[];
}

export function runCapacityAutoGcScenario(scenario: CapacityAutoGcScenario): CapacityAutoGcResult {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'aqua-capacity-auto-gc-'));
  const fakeBin = join(fixtureRoot, 'bin');
  const stateDir = join(fixtureRoot, 'state');
  const scriptTmp = join(fixtureRoot, 'tmp');
  const dockerRoot = join(fixtureRoot, 'docker-root');
  for (const dir of [fakeBin, stateDir, scriptTmp, dockerRoot]) mkdirSync(dir);
  const dockerPath = join(fakeBin, 'docker');
  const dfPath = join(fakeBin, 'df');
  const removalState = join(stateDir, 'removal-count');
  const removalLog = join(stateDir, 'removals.log');
  const dockerInvocationLog = join(stateDir, 'docker-invocations.log');
  const inventoryPath = join(stateDir, 'inventory.txt');
  const catalogPath = join(stateDir, 'service-catalog.deploy.vars');
  writeFileSync(removalState, '0\n');
  writeFileSync(removalLog, '');
  writeFileSync(dockerInvocationLog, '');
  writeFileSync(
    inventoryPath,
    [
      ...(scenario.extraInventory ?? []),
      `${CAPACITY_GC_FIXTURE_IMAGE_PREFIX}/svc-a 1111111111111111111111111111111111111111 image-a`,
      `${CAPACITY_GC_FIXTURE_IMAGE_PREFIX}/svc-b 2222222222222222222222222222222222222222 image-b`,
      `${CAPACITY_GC_FIXTURE_IMAGE_PREFIX}/svc-c 3333333333333333333333333333333333333333 image-c`,
      '',
    ].join('\n'),
  );
  const catalogServices =
    scenario.catalogServices === undefined ? 'svc-a svc-b svc-c' : scenario.catalogServices;
  if (catalogServices !== null) {
    writeFileSync(catalogPath, `CATALOG_APPLICATION_IMAGE_SERVICES='${catalogServices}'\n`);
  }
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
      '      ls) cat "${FAKE_IMAGE_INVENTORY}" ;;',
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
          TMPDIR: scriptTmp,
          DOCKER_ROOT_DIR: dockerRoot,
          DOCKER_INVOCATION_LOG: dockerInvocationLog,
          FAKE_IMAGE_INVENTORY: inventoryPath,
          CATALOG_DEPLOY_ENV: catalogPath,
          RMI_STATE_FILE: removalState,
          RMI_LOG: removalLog,
          INITIAL_FREE_BYTES: scenario.initialFreeBytes,
          RECLAIMED_PER_IMAGE_BYTES: scenario.reclaimedPerImageBytes,
          FS_SIZE_BYTES: '10737418240',
          IMAGE_PREFIX: CAPACITY_GC_FIXTURE_IMAGE_PREFIX,
          DEPLOY_SHA: 'ffffffffffffffffffffffffffffffffffffffff',
          FULL_DEPLOY: 'false',
          DEPLOY_SERVICES: 'svc-a svc-b svc-c',
          DEPLOY_PROJECTED_PULL_BYTES: scenario.projectedPullBytes,
          // The GC scenarios calibrate free bytes against the pull projection;
          // the deploy-owned dependency projection (INFRA-HIGH-218) is explicit
          // (default zero) so host state under DEPLOY_DEPS_ROOT cannot shift them.
          DEPLOY_PROJECTED_DEPS_BYTES: scenario.projectedDepsBytes ?? '0',
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
    removeFixtureTree(fixtureRoot);
  }
}
