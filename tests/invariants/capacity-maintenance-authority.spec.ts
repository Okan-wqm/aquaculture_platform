/**
 * Invariant — production image GC takes its scope from canonical sources, never
 * from whoever dispatches it (INFRA-CRITICAL-085).
 *
 * # WHAT this enforces
 *
 *   1. `deploy-capacity-maintenance.yml` accepts no dispatch input that names a
 *      release, image, registry, repository or tag. The remaining inputs choose
 *      the operation and the capacity thresholds; none of them can widen what
 *      GC is allowed to delete or move it onto a historical release.
 *   2. The values that DO decide scope reach the host from canonical sources:
 *      the image prefix from `github.repository` (the identity the image
 *      producers use), the release from the remote's current `main` resolved on
 *      the host. No step env feeding the host reads `inputs.*` for them.
 *   3. `droplet-capacity.sh` removes images only from repositories in the
 *      generated service catalog under that prefix. A repository that is under
 *      the prefix but not in the catalog is never touched, and GC refuses to
 *      run at all when the catalog cannot be read.
 *
 * # WHY
 *
 * The workflow accepted `image_prefix` and `deploy_sha` as dispatch inputs, and
 * the host script deleted any tag under `${IMAGE_PREFIX}/*`. A validly
 * dispatched maintenance run could therefore point GC at a wider registry
 * namespace or at a historical main ancestor, and remove current or rollback
 * images that are outside the intended catalog. Prefix-wide matching is the
 * same over-reach without any dispatch: anything that happens to live under
 * the prefix was in scope.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import yaml from 'js-yaml';

import {
  CAPACITY_GC_FIXTURE_IMAGE_PREFIX,
  runCapacityAutoGcScenario,
} from './helpers/capacity-gc-harness';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MAINTENANCE_WORKFLOW = join(
  REPO_ROOT,
  '.github',
  'workflows',
  'deploy-capacity-maintenance.yml',
);

interface MaintenanceStep {
  readonly uses?: string;
  readonly env?: Record<string, string>;
  readonly with?: { readonly script?: string; readonly envs?: string };
}

interface MaintenanceWorkflow {
  readonly on?: { readonly workflow_dispatch?: { readonly inputs?: Record<string, unknown> } };
  readonly jobs?: Record<string, { readonly steps?: MaintenanceStep[] }>;
}

function maintenanceWorkflow(): MaintenanceWorkflow {
  return yaml.load(readFileSync(MAINTENANCE_WORKFLOW, 'utf8')) as MaintenanceWorkflow;
}

function sshStep(workflow: MaintenanceWorkflow): MaintenanceStep {
  const steps = workflow.jobs?.['capacity-maintenance']?.steps ?? [];
  const step = steps.find((candidate) => candidate.uses?.startsWith('appleboy/ssh-action@'));
  if (step === undefined) throw new Error('capacity-maintenance has no SSH step');
  return step;
}

/** A GC scenario that clears its hard failure after exactly one removal. */
const ONE_REMOVAL_CLEARS_HARD_FAILURE = {
  initialFreeBytes: '1610612736',
  reclaimedPerImageBytes: '805306368',
  projectedPullBytes: '1073741824',
  projectedReserveGib: '1',
} as const;

describe('capacity maintenance derives GC scope from canonical sources (INFRA-CRITICAL-085)', () => {
  it('accepts no dispatch input that can name a release, image, registry or repository', () => {
    const inputs = Object.keys(maintenanceWorkflow().on?.workflow_dispatch?.inputs ?? {});

    expect(inputs).not.toContain('deploy_sha');
    expect(inputs).not.toContain('image_prefix');
    expect(
      inputs.filter((name) => /sha|prefix|image|registry|repo|tag|release/i.test(name)),
    ).toEqual([]);
  });

  it('feeds the host its image prefix and release from canonical sources only', () => {
    const step = sshStep(maintenanceWorkflow());
    const env = step.env ?? {};
    const script = step.with?.script ?? '';
    const forwarded = (step.with?.envs ?? '').split(',').map((name) => name.trim());

    // Only threshold/operation selectors may read inputs.
    const inputReaders = Object.entries(env)
      .filter(([, value]) => /\binputs\./.test(value))
      .map(([name]) => name)
      .sort();
    expect(inputReaders).toEqual(['DEPLOY_SERVICES', 'FULL_DEPLOY', 'OPERATION']);

    expect(env).not.toHaveProperty('IMAGE_PREFIX');
    expect(env).not.toHaveProperty('REQUESTED_DEPLOY_SHA');
    expect(env['IMAGE_REPOSITORY']).toBe('${{ github.repository }}');
    expect(forwarded).toContain('IMAGE_REPOSITORY');
    expect(forwarded).not.toContain('IMAGE_PREFIX');
    expect(forwarded).not.toContain('REQUESTED_DEPLOY_SHA');

    expect(script).not.toContain('REQUESTED_DEPLOY_SHA');
    expect(script).toContain('IMAGE_PREFIX="ghcr.io/${IMAGE_REPOSITORY,,}"');
    expect(script).toContain('TARGET_SHA="$(git rev-parse origin/main)"');
  });

  it('never removes an image from a repository outside the generated catalog', () => {
    const outsideCatalog = `${CAPACITY_GC_FIXTURE_IMAGE_PREFIX}/retired-svc`;
    const result = runCapacityAutoGcScenario({
      ...ONE_REMOVAL_CLEARS_HARD_FAILURE,
      extraInventory: [`${outsideCatalog} 4444444444444444444444444444444444444444 image-x`],
    });

    expect(result.status).toBe(0);
    expect(result.removals.filter((ref) => ref.startsWith(`${outsideCatalog}:`))).toEqual([]);
    expect(result.removals).toEqual([
      `${CAPACITY_GC_FIXTURE_IMAGE_PREFIX}/svc-a:1111111111111111111111111111111111111111`,
    ]);
  });

  it.each([
    ['cannot be read', null],
    ['names no services', ''],
    ['names a service that is not a repository component', 'svc-a ../svc-b'],
    ['spreads the service list over several lines', 'svc-a\nsvc-b'],
  ])('refuses image GC when the generated catalog %s', (_label, catalogServices) => {
    const result = runCapacityAutoGcScenario({
      ...ONE_REMOVAL_CLEARS_HARD_FAILURE,
      catalogServices,
    });

    expect(result.removals).toEqual([]);
    expect(result.dockerInvocations.filter((call) => call.startsWith('image prune'))).toEqual([]);
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('refusing image GC');
  });
});
