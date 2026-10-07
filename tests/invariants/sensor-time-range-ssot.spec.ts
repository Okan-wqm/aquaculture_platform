/**
 * Invariant: the sensor-reading time range
 * (libs/shared-contracts/src/sensor-readings/time-range.ts) is the only owner
 * of preset durations, and the shared-ui locale maps
 * (web/shared-ui/src/time-range/timeRangeLabels.ts) the only owner of their
 * words.
 *
 * The same durations used to be written in eight places across the readings
 * page, the widget dashboard, the heatmap, the SCADA trend widget, the chart
 * toolbar and the chart export, each with its own fallback for a value it did
 * not know (one became 24 h, another 1 h), and the labels in three languages
 * by file. The checks below fail on the shapes those copies took: a table that
 * maps two or more preset keys to a duration or to a label of its own.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  RELATIVE_TIME_RANGE_PRESETS,
  SCADA_RANGE_TOKENS,
} from '../../libs/shared-contracts/src/sensor-readings/time-range';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCANNED = ['web/modules/sensor-module/src', 'web/shared-ui/src'];

/**
 * Files whose tables share keys with the range table but are not chart ranges,
 * or whose removal is tracked. Each entry must still match, so a stale entry
 * fails too.
 */
const NOT_RANGE_TABLES = new Map<string, string>([
  [
    'web/modules/sensor-module/src/components/scada-builder/DaqConfigPanel.tsx',
    'DAQ sampling interval and retention vocabulary, not a chart range',
  ],
  [
    'web/modules/sensor-module/src/pages/SensorAnalyticsPage.tsx',
    'SENSOR-HIGH-153: the whole page is invented data with an unwired selector; phase 3c backs it with real aggregates or unroutes it',
  ],
]);

/** Every key a range table could be keyed by: the presets and the SCADA tokens. */
const RANGE_KEYS = new Set<string>([
  ...RELATIVE_TIME_RANGE_PRESETS.map((preset) => preset.key),
  ...SCADA_RANGE_TOKENS.map((entry) => entry.token),
]);

const KEY = String.raw`['"]?([\w]+)['"]?`;
const QUOTED_KEY = String.raw`['"]([\w]+)['"]`;
const DURATION = String.raw`([\d_]+(?:\s*\*\s*[\d_]+)*)`;

/** `'1h': 60 * 60 * 1000` — a record from key to milliseconds. */
const RECORD_ENTRY = new RegExp(String.raw`${KEY}\s*:\s*${DURATION}`, 'g');
/** `{ value: '1h', label: …, ms: … }` — a preset row with its own duration. */
const ROW_WITH_MS = new RegExp(String.raw`(?:key|value)\s*:\s*${QUOTED_KEY}[^}\n]*\bms\s*:`, 'g');
/** `{ value: '1h', label: 'Last 1 Hour' }` — a preset row with its own words. */
const ROW_WITH_LABEL = new RegExp(
  String.raw`(?:(?:key|value)\s*:\s*${QUOTED_KEY}\s*,\s*label\s*:|label\s*:\s*['"][^'"]*['"]\s*,\s*(?:key|value)\s*:\s*${QUOTED_KEY})`,
  'g',
);
/** `case '1h': return 60 * 60 * 1000` — a switch from key to milliseconds. */
const CASE_RETURN = new RegExp(String.raw`case\s+${QUOTED_KEY}\s*:\s*return\s+${DURATION}`, 'g');

const MIN_RANGE_MS = 60_000;

function durationOf(expression: string): number {
  return expression
    .split('*')
    .map((factor) => Number(factor.replace(/[\s_]/g, '')))
    .reduce((product, factor) => product * factor, 1);
}

/** The range keys a source maps to a duration or a label of its own. */
function rangeTableKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const pattern of [RECORD_ENTRY, CASE_RETURN]) {
    for (const match of source.matchAll(pattern)) {
      const [, key, expression] = match;
      if (key && expression && RANGE_KEYS.has(key) && durationOf(expression) >= MIN_RANGE_MS) {
        keys.add(key);
      }
    }
  }
  for (const pattern of [ROW_WITH_MS, ROW_WITH_LABEL]) {
    for (const match of source.matchAll(pattern)) {
      const key = match[1] ?? match[2];
      if (key && RANGE_KEYS.has(key)) {
        keys.add(key);
      }
    }
  }
  return [...keys];
}

function scannedSources(): string[] {
  return (
    execFileSync(
      'git',
      [
        'ls-files',
        ...SCANNED.map((dir) => `${dir}/**/*.ts`),
        ...SCANNED.map((dir) => `${dir}/**/*.tsx`),
      ],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    )
      .split('\n')
      .filter((file) => file.length > 0)
      .filter((file) => !/(\.spec|\.test)\.tsx?$|\/__tests__\/|\/__fixtures__\//.test(file))
      // The locale maps are where the words belong.
      .filter((file) => !file.startsWith('web/shared-ui/src/i18n/locales/'))
  );
}

describe('sensor-reading time range has one owner', () => {
  it('no browser surface keeps its own table of range durations or range words', () => {
    const offenders = scannedSources()
      .map(
        (file) => [file, rangeTableKeys(readFileSync(path.join(REPO_ROOT, file), 'utf8'))] as const,
      )
      .filter(([file, keys]) => keys.length >= 2 && !NOT_RANGE_TABLES.has(file))
      .map(([file, keys]) => `${file}: ${keys.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('keeps no stale exemption', () => {
    const stale = [...NOT_RANGE_TABLES.keys()].filter(
      (file) => rangeTableKeys(readFileSync(path.join(REPO_ROOT, file), 'utf8')).length < 2,
    );
    expect(stale).toEqual([]);
  });

  it('recognises every shape the removed copies took', () => {
    const removedCopies = {
      // readingsModel.ts PERIODS
      readings: `{ value: '1h', label: 'Son 1 Saat', ms: 60 * 60 * 1000 },
        { value: '6h', label: 'Son 6 Saat', ms: 6 * 60 * 60 * 1000 },`,
      // useWidgetData.ts getTimeRangeMs
      widget: `live: 5 * 60 * 1000, // 5 minutes for live
        '1h': 60 * 60 * 1000,`,
      // dashboard/types.ts TIME_RANGES
      dashboardLabels: `{ value: 'live', label: 'Live' },
        { value: '1h', label: 'Last 1 Hour' },`,
      // useTrendData.ts PRESET_MS
      trend: `last1h:  1 * 60 * 60 * 1000,
        last8h:  8 * 60 * 60 * 1000,`,
      // ChartExport.tsx resolveRangeDates
      chartExport: `last1h:  3_600_000,
        last8h:  28_800_000,`,
      // trendChartUtils.ts TIME_RANGES
      trendWidget: `{ key: '1h',  label: '1h',  ms: 3_600_000 },
        { key: '6h',  label: '6h',  ms: 21_600_000 },`,
      // a switch, the shape a rewrite most likely takes
      switchCopy: `case '1h': return 3_600_000; case '24h': return 86_400_000;`,
    };
    for (const [name, source] of Object.entries(removedCopies)) {
      expect([name, rangeTableKeys(source).length >= 2]).toEqual([name, true]);
    }
  });

  it('leaves alone what is not a range table', () => {
    const notRangeTables = [
      // an aggregation-width map: only '1h' is a range key
      `raw: 1_000, '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000, '1d': 86_400_000,`,
      // the heatmap's bucket counts per range: counts, not durations
      `live: 10, '1h': 12, '6h': 12, '8h': 16, '24h': 24, '3d': 24,`,
    ];
    for (const source of notRangeTables) {
      expect(rangeTableKeys(source).length).toBeLessThan(2);
    }
  });
});
