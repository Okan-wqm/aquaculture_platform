import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const E2E_ROOT = resolve(REPO_ROOT, 'apps/farm-service/src/__tests__/e2e');
const AUTHORITY = 'apps/farm-service/src/__tests__/e2e/helpers/stocked-tenant-fixture.ts';
const GOVERNED_CONSUMERS = Object.freeze([
  'apps/farm-service/src/__tests__/e2e/batch-allocation-tenant-isolation.postgres.spec.ts',
  'apps/farm-service/src/__tests__/e2e/feeding-record-tenant-isolation.postgres.spec.ts',
  'apps/farm-service/src/__tests__/e2e/mortality-cull-harvest-tenant-isolation.postgres.spec.ts',
]);

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    return entry.isDirectory()
      ? typescriptFiles(absolute)
      : entry.isFile() && entry.name.endsWith('.ts')
        ? [absolute]
        : [];
  });
}

function repoPath(absolute: string): string {
  return relative(REPO_ROOT, absolute).replaceAll('\\', '/');
}

describe('INVARIANT: real-Postgres stocked tenant fixture has one mutation authority', () => {
  const sources = typescriptFiles(E2E_ROOT).map((absolute) => ({
    path: repoPath(absolute),
    source: readFileSync(absolute, 'utf8'),
  }));

  it('keeps batch creation and initial allocation together in the shared helper', () => {
    const mutationOwners = sources
      .filter(
        ({ source }) =>
          source.includes('new CreateBatchCommand(') ||
          source.includes('new AllocateToTankCommand('),
      )
      .map(({ path }) => path);

    expect(mutationOwners).toEqual([AUTHORITY]);
    const authority = sources.find(({ path }) => path === AUTHORITY)?.source ?? '';
    expect(authority).toContain('new CreateBatchCommand(');
    expect(authority).toContain('new AllocateToTankCommand(');
  });

  it('routes every governed isolation suite through the shared stocked chain', () => {
    for (const consumer of GOVERNED_CONSUMERS) {
      const source = sources.find(({ path }) => path === consumer)?.source ?? '';
      expect(source).toContain('createStockedTenantFixtureV1');
      expect(source).not.toMatch(/function\s+createTenantFixture\s*\(/);
      expect(source).not.toContain('new CreateBatchCommand(');
      expect(source).not.toContain('new AllocateToTankCommand(');
    }
  });
});
