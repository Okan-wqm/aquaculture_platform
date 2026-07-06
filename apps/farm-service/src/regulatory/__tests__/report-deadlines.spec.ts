/**
 * Report deadline engine — the official Mattilsynet deadlines encoded once.
 */
import { ReportPrefillType } from '../assembly/report-assembly.service';
import { computeDueDate, isOverdueInOslo, osloDateString } from '../services/report-deadlines';

describe('computeDueDate', () => {
  it('sea-lice weekly is due the Tuesday of the following week', () => {
    // ISO 2026 week 27 runs Mon 2026-06-29 .. Sun 2026-07-05; following
    // Tuesday is 2026-07-07.
    expect(computeDueDate(ReportPrefillType.SEA_LICE, { year: 2026, week: 27 })).toBe('2026-07-07');
  });

  it('planned slaughter is due the Thursday of the week before the slaughter week', () => {
    // Slaughter week 27 Monday is 2026-06-29; previous Thursday is 2026-06-25.
    expect(computeDueDate(ReportPrefillType.SLAUGHTER_PLANNED, { year: 2026, week: 27 })).toBe(
      '2026-06-25',
    );
  });

  it('executed slaughter is due the 7th of the month following the week', () => {
    // Week 27/2026 belongs to July (its Thursday 2026-07-02) → due 2026-08-07.
    expect(computeDueDate(ReportPrefillType.SLAUGHTER_EXECUTED, { year: 2026, week: 27 })).toBe(
      '2026-08-07',
    );
  });

  it('monthly reports are due the 7th of the following month', () => {
    expect(computeDueDate(ReportPrefillType.SMOLT, { year: 2026, month: 6 })).toBe('2026-07-07');
    expect(computeDueDate(ReportPrefillType.CLEANER_FISH, { year: 2026, month: 6 })).toBe(
      '2026-07-07',
    );
    expect(computeDueDate(ReportPrefillType.BIOMASS, { year: 2026, month: 6 })).toBe('2026-07-07');
  });

  it('rolls the year over for a December monthly report', () => {
    expect(computeDueDate(ReportPrefillType.SMOLT, { year: 2026, month: 12 })).toBe('2027-01-07');
  });

  it('rejects the immediate varsling types (not scheduled)', () => {
    expect(() => computeDueDate(ReportPrefillType.ESCAPE, { year: 2026, week: 27 })).toThrow(
      /immediate/,
    );
    expect(() => computeDueDate(ReportPrefillType.WELFARE_EVENT, { year: 2026, month: 6 })).toThrow(
      /immediate/,
    );
  });

  it('requires the matching period grain', () => {
    expect(() => computeDueDate(ReportPrefillType.SEA_LICE, { year: 2026 })).toThrow(/periodWeek/);
    expect(() => computeDueDate(ReportPrefillType.SMOLT, { year: 2026 })).toThrow(/periodMonth/);
  });
});

describe('osloDateString / isOverdueInOslo', () => {
  it('returns the Oslo calendar date for an instant just before Oslo midnight', () => {
    // 2026-07-06T21:30:00Z is 2026-07-06 23:30 in Oslo (UTC+2 summer).
    expect(osloDateString(new Date('2026-07-06T21:30:00Z'))).toBe('2026-07-06');
  });

  it('rolls to the next Oslo day once past Oslo midnight', () => {
    // 2026-07-06T22:30:00Z is 2026-07-07 00:30 in Oslo (UTC+2).
    expect(osloDateString(new Date('2026-07-06T22:30:00Z'))).toBe('2026-07-07');
  });

  it('flags a due date as overdue only once the Oslo day reaches it', () => {
    const beforeMidnightOslo = new Date('2026-07-06T21:00:00Z'); // Oslo 2026-07-06
    expect(isOverdueInOslo('2026-07-07', beforeMidnightOslo)).toBe(false);
    const afterMidnightOslo = new Date('2026-07-06T22:30:00Z'); // Oslo 2026-07-07
    expect(isOverdueInOslo('2026-07-07', afterMidnightOslo)).toBe(true);
  });
});
