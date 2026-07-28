/**
 * APA-141 — a report definition can no longer store a schedule nothing runs.
 *
 * `schedule` and `recipients` were written by `createDefinition` /
 * `updateDefinition` and read by NOBODY. The only `@Cron` in the analytics
 * module drives the daily snapshot; a repo-wide search for reads of
 * `definition.schedule` / `.recipients` returns the write sites and type
 * declarations only. A definition saved with `schedule='daily'` never ran and
 * its recipients never received anything.
 *
 * Removing them from the DTOs is the tier-1 half: with the platform-wide
 * `forbidNonWhitelisted: true` pipe, submitting one is now a 400 rather than a
 * silent write of a promise the platform does not keep.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/analytics.md#APA-141
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CONTROLLER = readFileSync(
  join(__dirname, '..', 'controllers', 'reports.controller.ts'),
  'utf8',
);
const SERVICE = readFileSync(join(__dirname, '..', 'services', 'reports.service.ts'), 'utf8');
const ENTITY = readFileSync(
  join(__dirname, '..', 'entities', 'analytics-snapshot.entity.ts'),
  'utf8',
);

describe('report definition scheduling is retired (APA-141)', () => {
  it('neither definition DTO accepts a schedule or recipients', () => {
    // With `forbidNonWhitelisted: true` the ABSENCE of the property is the
    // enforcement: an unknown key is rejected at the pipe, so a client cannot
    // store a schedule at all.
    expect(CONTROLLER).not.toMatch(/schedule\?:\s*ReportSchedule/);
    expect(CONTROLLER).not.toMatch(/recipients\?:\s*string\[\]/);
  });

  it('the service no longer writes either field', () => {
    expect(SERVICE).not.toMatch(/schedule:\s*data\.schedule/);
    expect(SERVICE).not.toMatch(/recipients:\s*data\.recipients/);
  });

  it('the persistence entity no longer declares either column', () => {
    // Left declared, the fields would keep reading back as a promise the
    // platform does not keep, and would invite a future writer.
    expect(ENTITY).not.toMatch(/^\s*schedule!:\s*ReportSchedule;/m);
    expect(ENTITY).not.toMatch(/^\s*recipients\?:\s*string\[\];/m);
  });

  it('no scheduler consumes a report definition', () => {
    // The retirement rests on this: if a consumer appears, the fields must come
    // back WITH it, not before it.
    const scheduler = readFileSync(
      join(__dirname, '..', 'services', 'analytics-snapshot.scheduler.ts'),
      'utf8',
    );
    expect(scheduler).not.toMatch(/definitionRepository|ReportDefinition/);
    // The one @Cron in the module drives the daily snapshot, nothing else.
    expect(scheduler).toMatch(/createDailySnapshot/);
  });
});
