import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.cwd();
const SOURCE_ROOT = resolve(ROOT, 'web/apps/aquamobil/src');
const AUTHORITY = 'web/apps/aquamobil/src/hooks/useTodaysDayPlans.ts';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test') return [];
      return sourceFiles(absolute);
    }
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [absolute] : [];
  });
}

function repoPath(path: string): string {
  return relative(ROOT, path).replaceAll('\\', '/');
}

describe("INVARIANT: Aquamobil today's feeding-plan query has one authority", () => {
  const sources = sourceFiles(SOURCE_ROOT).map((path) => ({
    path: repoPath(path),
    source: readFileSync(path, 'utf8'),
  }));

  it('owns the React Query identity, network read, and encrypted cache write in one hook', () => {
    const queryKeyOwners = sources
      .filter(({ source }) =>
        /createTenantQueryKey\([\s\S]{0,160}['"]feedingDayPlans['"]/.test(source),
      )
      .map(({ path }) => path);
    const networkOwners = sources
      .filter(
        ({ source }) =>
          source.includes('GET_FEEDING_DAY_PLANS') && source.includes('graphqlRequest<'),
      )
      .map(({ path }) => path);
    const cacheOwners = sources
      .filter(
        ({ source }) =>
          source.includes("DAY_PLANS_CACHE_PREFIX = 'feedingDayPlans_'") &&
          source.includes('await cacheData('),
      )
      .map(({ path }) => path);

    expect(queryKeyOwners).toEqual([AUTHORITY]);
    expect(networkOwners).toEqual([AUTHORITY]);
    expect(cacheOwners).toEqual([AUTHORITY]);
  });

  it('routes both plan consumers through the canonical hook', () => {
    for (const consumer of [
      'web/apps/aquamobil/src/hooks/useDailyOpsStats.ts',
      'web/apps/aquamobil/src/pages/feeding/RecordFeedingPage.tsx',
    ]) {
      const source = readFileSync(resolve(ROOT, consumer), 'utf8');
      expect(source).toContain('useTodaysDayPlans');
      expect(source).not.toContain('GET_FEEDING_DAY_PLANS');
    }
  });
});
