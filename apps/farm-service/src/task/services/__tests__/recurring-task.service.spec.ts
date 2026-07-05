/**
 * RecurringTaskService Timezone Unit Tests
 *
 * Focuses on the phase 5.5 timezone invariants:
 *   - `calculateDueDate` returns end-of-day in the template's local
 *     timezone regardless of host server timezone.
 *   - `calculateNextGeneration` respects DST by using luxon's
 *     `plus({ days })` which preserves local wall-clock hour across
 *     spring-forward / fall-back.
 *   - Invalid / null timezone falls back to UTC with a warn.
 *   - Frequency-specific deltas (HOURLY / DAILY / WEEKLY / BIWEEKLY /
 *     MONTHLY / CUSTOM) all respect the chosen zone.
 *
 * The service methods under test are private. We reach them via
 * a minimal doubled instance — pass the Jest-mocked repositories and
 * DataSource in and then invoke the methods with a generic `any` cast.
 * Private-method tests are acceptable here because the behaviour
 * cannot be observed through the public CRUD surface without a
 * round-trip to the database.
 */
import { DateTime } from 'luxon';
import { DataSource, Repository } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { RecurringTaskService } from '../recurring-task.service';
import {
  RecurrenceFrequency,
  RecurringTemplate,
} from '../../entities/recurring-template.entity';
import { Task } from '../../entities/task.entity';

/**
 * The three methods under test are `private` on the service so the
 * test reaches them via an explicit structural cast rather than the
 * intersection trick (TS 4.8+ collapses intersections with private
 * members to `never`).
 */
interface PrivateAccess {
  calculateDueDate(tz?: string | null): Date;
  calculateNextGeneration(
    frequency: RecurrenceFrequency,
    detail?: string | null,
    tz?: string | null,
  ): Date;
  resolveTimezone(tz?: string | null): string;
}

function makeService(): PrivateAccess {
  const noop = {} as unknown;
  const templateRepo = noop as Repository<RecurringTemplate>;
  const taskRepo = noop as Repository<Task>;
  const dataSource = noop as DataSource;
  const outbox = noop as OutboxPublisher;
  const svc = new RecurringTaskService(templateRepo, taskRepo, dataSource, outbox);
  return svc as unknown as PrivateAccess;
}

describe('RecurringTaskService timezone handling', () => {
  describe('resolveTimezone', () => {
    it('returns UTC when timezone is null/undefined/empty', () => {
      const svc = makeService();
      expect(svc.resolveTimezone(undefined)).toBe('UTC');
      expect(svc.resolveTimezone(null)).toBe('UTC');
      expect(svc.resolveTimezone('')).toBe('UTC');
    });

    it('accepts valid IANA zones', () => {
      const svc = makeService();
      expect(svc.resolveTimezone('Europe/Istanbul')).toBe('Europe/Istanbul');
      expect(svc.resolveTimezone('America/Los_Angeles')).toBe(
        'America/Los_Angeles',
      );
      expect(svc.resolveTimezone('Europe/Oslo')).toBe('Europe/Oslo');
    });

    it('falls back to UTC for invalid zone identifiers', () => {
      const svc = makeService();
      expect(svc.resolveTimezone('Not/Real')).toBe('UTC');
      expect(svc.resolveTimezone('EST')).toBe('EST'); // luxon accepts EST — documented
    });
  });

  describe('calculateDueDate', () => {
    it('returns 23:59:59.999 of today in the given zone', () => {
      const svc = makeService();
      const due = svc.calculateDueDate('Europe/Istanbul');
      const dueLocal = DateTime.fromJSDate(due).setZone('Europe/Istanbul');
      expect(dueLocal.hour).toBe(23);
      expect(dueLocal.minute).toBe(59);
      expect(dueLocal.second).toBe(59);
    });

    it('returns a different UTC instant for two zones on the same call instant', () => {
      // Deterministic clock: the 9-11h window below only holds while
      // Istanbul and Los Angeles are on the SAME calendar date. Outside
      // 07:00-21:00 UTC the zones straddle midnight and the honest
      // difference is 24h minus the offset gap (~14h), so a wall-clock
      // run flaked for ~10 hours of every day. Pin an instant where
      // both zones share the date (12:00 UTC → 15:00 Istanbul, 05:00 LA).
      jest.useFakeTimers({ now: new Date('2026-07-01T12:00:00.000Z') });
      try {
        const svc = makeService();
        const dueIstanbul = svc.calculateDueDate('Europe/Istanbul');
        const dueLA = svc.calculateDueDate('America/Los_Angeles');
        // LA is 10h behind Istanbul; their local-end-of-day instants
        // are 10h apart in UTC terms (or very close, accounting for
        // DST state on the call day).
        const diffMs = Math.abs(
          dueIstanbul.getTime() - dueLA.getTime(),
        );
        const diffHours = diffMs / (1000 * 60 * 60);
        expect(diffHours).toBeGreaterThanOrEqual(9);
        expect(diffHours).toBeLessThanOrEqual(11);
      } finally {
        jest.useRealTimers();
      }
    });

    it('falls back to UTC when timezone is null', () => {
      const svc = makeService();
      const due = svc.calculateDueDate(null);
      const dueUtc = DateTime.fromJSDate(due).setZone('UTC');
      expect(dueUtc.hour).toBe(23);
      expect(dueUtc.minute).toBe(59);
    });
  });

  describe('calculateNextGeneration', () => {
    it('adds exactly one hour for HOURLY', () => {
      const svc = makeService();
      const before = Date.now();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.HOURLY,
        null,
        'Europe/Istanbul',
      );
      const diffMs = next.getTime() - before;
      // Allow a 500ms slack for the call itself.
      expect(diffMs).toBeGreaterThanOrEqual(60 * 60 * 1000 - 500);
      expect(diffMs).toBeLessThanOrEqual(60 * 60 * 1000 + 500);
    });

    it('DAILY preserves local wall-clock hour across DST — spring forward', () => {
      // Spy on DateTime.now to return a fixed "day before spring-
      // forward" instant in Europe/Oslo. Norway springs forward on
      // the last Sunday of March at 02:00 → 03:00.
      const springBefore = DateTime.fromISO('2026-03-28T14:00:00', {
        zone: 'Europe/Oslo',
      });
      const spy = jest
        .spyOn(DateTime, 'now')
        .mockReturnValue(springBefore as unknown as DateTime<true>);

      const svc = makeService();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.DAILY,
        null,
        'Europe/Oslo',
      );
      const nextLocal = DateTime.fromJSDate(next).setZone('Europe/Oslo');
      expect(nextLocal.toISODate()).toBe('2026-03-29');
      // Local wall-clock hour preserved despite the DST shift.
      expect(nextLocal.hour).toBe(14);

      spy.mockRestore();
    });

    it('WEEKLY bumps by seven local days', () => {
      const svc = makeService();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.WEEKLY,
        null,
        'Europe/Istanbul',
      );
      const diffDays =
        (next.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
      expect(diffDays).toBeGreaterThanOrEqual(6.95);
      expect(diffDays).toBeLessThanOrEqual(7.05);
    });

    it('MONTHLY clamps to end-of-month when target is shorter', () => {
      const jan31 = DateTime.fromISO('2026-01-31T09:00:00', {
        zone: 'UTC',
      });
      const spy = jest
        .spyOn(DateTime, 'now')
        .mockReturnValue(jan31 as unknown as DateTime<true>);

      const svc = makeService();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.MONTHLY,
        null,
        'UTC',
      );
      const nextUtc = DateTime.fromJSDate(next).setZone('UTC');
      expect(nextUtc.month).toBe(2);
      expect(nextUtc.day).toBe(28);

      spy.mockRestore();
    });

    it('CUSTOM honors the hour count from frequencyDetail', () => {
      const svc = makeService();
      const before = Date.now();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.CUSTOM,
        '6',
        'UTC',
      );
      const diffMs = next.getTime() - before;
      expect(diffMs).toBeGreaterThanOrEqual(6 * 60 * 60 * 1000 - 500);
      expect(diffMs).toBeLessThanOrEqual(6 * 60 * 60 * 1000 + 500);
    });

    it('CUSTOM falls back to 24h for invalid frequencyDetail', () => {
      const svc = makeService();
      const before = Date.now();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.CUSTOM,
        'not-a-number',
        'UTC',
      );
      const diffMs = next.getTime() - before;
      expect(diffMs).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 500);
      expect(diffMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 500);
    });

    it('falls back to UTC for null timezone', () => {
      const svc = makeService();
      const next = svc.calculateNextGeneration(
        RecurrenceFrequency.DAILY,
        null,
        null,
      );
      // Smoke — we only assert it returns a valid Date and runs without throwing.
      expect(next).toBeInstanceOf(Date);
      expect(Number.isNaN(next.getTime())).toBe(false);
    });
  });
});
