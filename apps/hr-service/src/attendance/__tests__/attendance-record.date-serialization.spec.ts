/**
 * WHY THIS FILE EXISTS:
 * `attendance_records.date` is a PostgreSQL `date` column exposed as GraphQL
 * `DateTime`, and every attendance fragment selects it (AttendanceRecordFull:
 * attendanceRecords, todaysAttendance — the Team › Today roster). PostgresDriver
 * hydrates a `date` column to 'YYYY-MM-DD' (DateUtils.mixedDateToDateString)
 * and then runs the column transformer; the DateTime scalar serialises only a
 * `Date`. Without the DateColumnTransformer those reads failed with
 * INTERNAL_SERVER_ERROR as soon as one record existed.
 */
import { GraphQLISODateTime } from '@nestjs/graphql';
import { getMetadataArgsStorage } from 'typeorm';
import { ApplyValueTransformers } from 'typeorm/util/ApplyValueTransformers';
import { DateUtils } from 'typeorm/util/DateUtils';

import { AttendanceRecord } from '../entities/attendance-record.entity';

/** What PostgresDriver.prepareHydratedValue hands back for AttendanceRecord.date. */
function hydrateDate(stored: string): unknown {
  const column = getMetadataArgsStorage().columns.find(
    (args) => args.target === AttendanceRecord && args.propertyName === 'date',
  );
  if (column === undefined) throw new Error('AttendanceRecord.date is not a column');
  const hydrated = DateUtils.mixedDateToDateString(stored);
  const transformer = column.options.transformer;
  return transformer === undefined
    ? hydrated
    : ApplyValueTransformers.transformFrom(transformer, hydrated);
}

describe('AttendanceRecord.date → GraphQL DateTime', () => {
  it('hydrates the stored day as a Date, which the DateTime scalar serialises', () => {
    const date = hydrateDate('2026-10-16');

    expect(date).toBeInstanceOf(Date);
    expect(GraphQLISODateTime.serialize(date)).toBe('2026-10-16T00:00:00.000Z');
  });
});
