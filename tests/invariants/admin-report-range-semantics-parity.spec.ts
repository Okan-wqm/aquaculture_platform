/**
 * APA-140 — the admin panel and the backend must agree on which reports take a
 * date range.
 *
 * `REPORT_RANGE_SEMANTICS` exists in two places by necessity: the backend uses
 * it to key the cache and to decide whether an execution records a window, and
 * `ReportsPage` uses it to decide whether the Generate modal collects one. The
 * admin panel is a federated remote with no generated client, so it cannot
 * import the backend entity — which is exactly how this class of drift is born.
 *
 * If the two disagree the original defect returns in one direction or the
 * other: the modal collects a window the generator discards (a user picks "last
 * week" and gets all-time data labelled with their range), or it withholds a
 * window the generator needs and every run silently defaults to the last 30
 * days. Binding them here makes either a build failure.
 *
 * Same shape as the AuditSeverity and DataRequestStatus vocabulary gates: parse
 * both literal maps out of source and require set-and-value equality.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-140
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

const BACKEND_SOURCE = join(
  REPO_ROOT,
  'apps/admin-api-service/src/analytics/entities/analytics-snapshot.entity.ts',
);
const FRONTEND_SOURCE = join(
  REPO_ROOT,
  'web/modules/admin-panel/src/pages/ReportsPage.tsx',
);

/**
 * Extracts the `key: 'value'` pairs of the named literal map.
 *
 * Comments inside the map body are stripped first, so a commented-out entry
 * cannot masquerade as a declaration on either side.
 */
function parseSemanticsMap(source: string, file: string): Record<string, string> {
  const start = source.indexOf('REPORT_RANGE_SEMANTICS: Record<ReportType, ');
  if (start === -1) {
    throw new Error(`REPORT_RANGE_SEMANTICS declaration not found in ${file}`);
  }
  const open = source.indexOf('{', start);
  const close = source.indexOf('};', open);
  if (open === -1 || close === -1) {
    throw new Error(`REPORT_RANGE_SEMANTICS body not delimited in ${file}`);
  }

  const body = source
    .slice(open + 1, close)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  const entries: Record<string, string> = {};
  for (const match of body.matchAll(/(\w+)\s*:\s*'(ranged|point_in_time)'/g)) {
    const [, key, value] = match;
    if (key && value) {
      entries[key] = value;
    }
  }
  if (Object.keys(entries).length === 0) {
    throw new Error(`REPORT_RANGE_SEMANTICS in ${file} parsed to zero entries`);
  }
  return entries;
}

describe('admin report range semantics parity (APA-140)', () => {
  const backend = parseSemanticsMap(readFileSync(BACKEND_SOURCE, 'utf8'), BACKEND_SOURCE);
  const frontend = parseSemanticsMap(readFileSync(FRONTEND_SOURCE, 'utf8'), FRONTEND_SOURCE);

  it('covers the same report types on both sides', () => {
    expect(Object.keys(frontend).sort()).toEqual(Object.keys(backend).sort());
  });

  it('agrees on every report type', () => {
    // Value equality, not just key coverage: flipping one side's entry is the
    // drift that silently re-opens the finding.
    expect(frontend).toEqual(backend);
  });

  it('covers every report type the backend can produce', () => {
    // The backend map is `Record<ReportType, …>` so it is exhaustive by
    // compilation; this pins the parsed view to the declared vocabulary so a
    // parser change cannot silently narrow what the gate compares.
    const backendSource = readFileSync(BACKEND_SOURCE, 'utf8');
    const typesStart = backendSource.indexOf('export const REPORT_TYPES = [');
    const typesEnd = backendSource.indexOf('] as const;', typesStart);
    expect(typesStart).toBeGreaterThan(-1);
    expect(typesEnd).toBeGreaterThan(typesStart);

    const declared = [
      ...backendSource
        .slice(typesStart, typesEnd)
        .matchAll(/'([a-z_]+)'/g),
    ].map((match) => match[1]);

    expect(Object.keys(backend).sort()).toEqual([...declared].sort());
  });
});
