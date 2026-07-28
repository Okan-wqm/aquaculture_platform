import * as fs from 'node:fs';
import * as path from 'node:path';

interface CoverageMetric {
  covered: number;
  found: number;
  percentage: number;
}

interface ParsedCoverage {
  source_files: number;
  branches: CoverageMetric;
  functions: CoverageMetric;
  lines: CoverageMetric;
}

const coverageEvidence: {
  parseLcov(content: string, reportPath: string): ParsedCoverage;
} = require('../../tools/quality/coverage-evidence.js');
const createVitestTestPolicy: () => {
  maxWorkers: number;
  coverage: { provider: string; reporter: string[] };
} = require('@aquaculture/testing/vitest');
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const INVENTORY_PATH = path.join(REPO_ROOT, 'tools', 'quality', 'coverage-report-inventory.json');
const VITEST_CONFIGS = [
  'libs/aquaculture-engines/vitest.config.ts',
  'web/modules/admin-panel/vite.config.ts',
  'web/modules/dashboard/vite.config.ts',
  'web/modules/farm-module/vite.config.ts',
  'web/modules/hr-module/vite.config.ts',
  'web/modules/messaging-module/vite.config.ts',
  'web/modules/sensor-module/vite.config.ts',
  'web/modules/tenant-admin/vite.config.ts',
  'web/shared-ui/vitest.config.ts',
  'web/shell/vitest.config.ts',
];

describe('repository-owned coverage evidence contract', () => {
  it('keeps every JS/TS coverage producer in one sorted, duplicate-free inventory', () => {
    const inventory = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8')) as {
      schema_version: number;
      reports: string[];
    };

    expect(inventory.schema_version).toBe(1);
    expect(inventory.reports).toHaveLength(34);
    expect(new Set(inventory.reports).size).toBe(inventory.reports.length);
    expect(inventory.reports).toEqual([...inventory.reports].sort());
    expect(
      inventory.reports.every(
        (report) =>
          !path.isAbsolute(report) && !report.includes('..') && report.endsWith('lcov.info'),
      ),
    ).toBe(true);
  });

  it('aggregates LCOV counters deterministically across source records', () => {
    const parsed = coverageEvidence.parseLcov(
      [
        'SF:src/one.ts',
        'FNF:2',
        'FNH:1',
        'BRF:4',
        'BRH:3',
        'LF:10',
        'LH:8',
        'end_of_record',
        'SF:src/two.ts',
        'FNF:1',
        'FNH:1',
        'BRF:2',
        'BRH:1',
        'LF:5',
        'LH:4',
        'end_of_record',
      ].join('\n'),
      'fixture/lcov.info',
    );

    expect(parsed).toEqual({
      source_files: 2,
      branches: { covered: 4, found: 6, percentage: 66.67 },
      functions: { covered: 2, found: 3, percentage: 66.67 },
      lines: { covered: 12, found: 15, percentage: 80 },
    });
  });

  it('bounds nested Vitest worker pools and gives every producer the same LCOV policy', () => {
    expect(createVitestTestPolicy()).toEqual({
      maxWorkers: 2,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
      },
    });

    for (const configPath of VITEST_CONFIGS) {
      const config = fs.readFileSync(path.join(REPO_ROOT, configPath), 'utf8');
      expect(config).toContain('@aquaculture/testing/vitest');
      expect(config).toContain('...createVitestTestPolicy()');
    }
  });

  it('returns an isolated reporter array for every config consumer', () => {
    const first = createVitestTestPolicy();
    const second = createVitestTestPolicy();

    expect(first).not.toBe(second);
    expect(first.coverage.reporter).not.toBe(second.coverage.reporter);
  });

  it('rejects syntactically present reports with no instrumented source lines', () => {
    expect(() => coverageEvidence.parseLcov('TN:\\nend_of_record\\n', 'empty/lcov.info')).toThrow(
      'LCOV contains no instrumented source lines',
    );
  });
});
