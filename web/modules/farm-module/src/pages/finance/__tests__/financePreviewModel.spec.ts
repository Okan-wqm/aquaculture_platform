/**
 * Finance preview models — the arithmetic the Budget and Cost centres tabs
 * draw from their sample data (FARM-MEDIUM-439, FARM-MEDIUM-440).
 *
 * The fixtures here are the spec's own: a test file may not import a
 * `*.preview` module without rendering it through MockPreview
 * (web-preview-data-path rule 2), and the arithmetic must hold for any input,
 * not only for the sample the tabs ship with. The expected figures are the
 * design's (Tenant Console D6, tenant-fin.js) worked by hand.
 */
import { describe, expect, it } from 'vitest';

import { budgetView, daysInMonth, type BudgetSample } from '../model/budgetModel';
import { unitCostRows, type CostCentresSample } from '../model/costCentreModel';
import { severityOf } from '../model/severity';

const NAME = { en: 'Centre', tr: 'Merkez' };

const BUDGET: BudgetSample = {
  currency: 'TRY',
  month: { year: 2026, month: 10 },
  dayOfMonth: 14,
  centres: [
    { code: 'AQ', name: NAME, owner: NAME, budget: 4200, actual: 2050 },
    { code: 'HAT', name: NAME, owner: NAME, budget: 620, actual: 262 },
    { code: 'GH', name: NAME, owner: NAME, budget: 540, actual: 318 },
  ],
};

describe('severityOf', () => {
  it('is ok up to the target, warn above it and alarm above 110 %', () => {
    expect(severityOf(1)).toBe('ok');
    expect(severityOf(1.0001)).toBe('warn');
    expect(severityOf(1.1)).toBe('warn');
    expect(severityOf(1.1001)).toBe('alarm');
  });
});

describe('daysInMonth', () => {
  it('counts the days of the calendar month, leap years included', () => {
    expect(daysInMonth(2026, 10)).toBe(31);
    expect(daysInMonth(2026, 11)).toBe(30);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2026, 2)).toBe(28);
  });
});

describe('budgetView', () => {
  const view = budgetView(BUDGET);
  const row = (code: string): (typeof view.rows)[number] => {
    const found = view.rows.find((r) => r.code === code);
    if (found === undefined) throw new Error(`no row ${code}`);
    return found;
  };

  it('puts today at day / days-in-month of the month', () => {
    expect(view.daysInMonth).toBe(31);
    expect(view.pace).toBeCloseTo(14 / 31, 6);
  });

  it('projects the month-to-date spend to month end at the same daily rate', () => {
    expect(row('AQ').used).toBeCloseTo(2050 / 4200, 6);
    expect(row('AQ').forecast).toBeCloseTo((2050 / 14) * 31, 6);
    expect(Math.round(row('AQ').forecast)).toBe(4539);
    expect(Math.round(row('AQ').variance)).toBe(339);
    expect(Math.round(row('HAT').variance)).toBe(-40);
  });

  it('flags a centre by its forecast against its budget', () => {
    expect(row('AQ').severity).toBe('warn');
    expect(row('HAT').severity).toBe('ok');
    expect(row('GH').severity).toBe('alarm');
    expect(Math.round(row('GH').forecastRatio * 100)).toBe(130);
  });
});

describe('unitCostRows', () => {
  const SAMPLE: CostCentresSample = {
    currency: 'TRY',
    period: { year: 2026, month: 10, fromDay: 1, toDay: 14 },
    centres: [
      { code: 'AQ', name: { en: 'Aquaculture', tr: 'Su ürünleri' }, sites: [NAME], owner: NAME },
      { code: 'GH', name: { en: 'Greenhouse', tr: 'Sera' }, sites: [NAME], owner: NAME },
    ],
    registerNote: NAME,
    unitCosts: [
      {
        site: NAME,
        centreCode: 'AQ',
        output: 21.4,
        outputUnit: NAME,
        cost: 1380,
        target: 62,
        unit: NAME,
        feedShare: 0.58,
      },
      {
        site: NAME,
        centreCode: 'AQ',
        output: 11.2,
        outputUnit: NAME,
        cost: 670,
        target: 62,
        unit: NAME,
        feedShare: 0.61,
      },
      {
        site: NAME,
        centreCode: 'GH',
        output: 18.6,
        outputUnit: NAME,
        cost: 318,
        target: 14,
        unit: NAME,
        feedShare: null,
      },
    ],
    unitNote: NAME,
  };
  const rows = unitCostRows(SAMPLE);

  it('derives unit cost as period cost over period output', () => {
    expect(rows.map((r) => Math.round(r.unitCost * 10) / 10)).toEqual([64.5, 59.8, 17.1]);
  });

  it('names each row’s cost centre and flags unit cost above its target', () => {
    expect(rows.map((r) => r.centreName.en)).toEqual(['Aquaculture', 'Aquaculture', 'Greenhouse']);
    expect(rows.map((r) => r.severity)).toEqual(['warn', 'ok', 'alarm']);
  });

  it('refuses a row whose cost centre is not in the register', () => {
    expect(() =>
      unitCostRows({
        ...SAMPLE,
        unitCosts: [{ ...SAMPLE.unitCosts[0], centreCode: 'NOPE' }],
      }),
    ).toThrow(/NOPE/);
  });
});
