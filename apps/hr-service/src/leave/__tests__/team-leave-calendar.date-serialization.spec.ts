/**
 * WHY THIS FILE EXISTS:
 * `leave_requests.startDate` / `endDate` are PostgreSQL `date` columns exposed
 * as GraphQL `DateTime`. PostgresDriver hydrates a `date` column to the string
 * 'YYYY-MM-DD' (DateUtils.mixedDateToDateString) and only then runs the
 * column's transformer; the DateTime scalar serialises nothing but a `Date`
 * (anything else → null, which graphql-js rejects). Without the
 * DateColumnTransformer every read selecting a leave's dates — leaveRequests,
 * teamLeaveCalendar (the Team › Today page's open-leave panel) — failed with
 * INTERNAL_SERVER_ERROR as soon as one row matched.
 *
 * These tests hydrate a row exactly as PostgresDriver does and push the
 * GetTeamLeaveCalendarHandler result through the real DateTime scalar.
 */
import { GraphQLISODateTime } from '@nestjs/graphql';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getMetadataArgsStorage } from 'typeorm';
import { ApplyValueTransformers } from 'typeorm/util/ApplyValueTransformers';
import { DateUtils } from 'typeorm/util/DateUtils';

import { LeaveRequest, LeaveRequestStatus } from '../entities/leave-request.entity';
import { GetTeamLeaveCalendarHandler } from '../query-handlers/get-team-leave-calendar.handler';
import { GetTeamLeaveCalendarQuery } from '../queries/get-team-leave-calendar.query';

/** What PostgresDriver.prepareHydratedValue hands back for a `date` column of LeaveRequest. */
function hydrateDateColumn(property: 'startDate' | 'endDate', stored: string): unknown {
  const column = getMetadataArgsStorage().columns.find(
    (args) => args.target === LeaveRequest && args.propertyName === property,
  );
  if (column === undefined) throw new Error(`LeaveRequest.${property} is not a column`);
  const hydrated = DateUtils.mixedDateToDateString(stored);
  const transformer = column.options.transformer;
  return transformer === undefined
    ? hydrated
    : ApplyValueTransformers.transformFrom(transformer, hydrated);
}

function hydratedLeaveRequest(): LeaveRequest {
  const row = new LeaveRequest();
  Object.assign(row, {
    id: 'lr-1',
    tenantId: 'tenant-1',
    employeeId: 'emp-1',
    employee: { id: 'emp-1', firstName: 'Zeynep', lastName: 'Arslan' },
    leaveType: { id: 'lt-1', name: 'Annual leave', color: 'teal' },
    startDate: hydrateDateColumn('startDate', '2026-10-12'),
    endDate: hydrateDateColumn('endDate', '2026-10-18'),
    totalDays: '5.00',
    status: LeaveRequestStatus.PENDING,
    isHalfDayStart: false,
    isHalfDayEnd: false,
  });
  return row;
}

async function handlerReturning(rows: LeaveRequest[]): Promise<GetTeamLeaveCalendarHandler> {
  const qb: Record<string, jest.Mock> = {};
  for (const method of ['leftJoin', 'addSelect', 'where', 'andWhere', 'orderBy', 'take']) {
    qb[method] = jest.fn(() => qb);
  }
  qb['getMany'] = jest.fn(() => Promise.resolve(rows));
  const module = await Test.createTestingModule({
    providers: [
      GetTeamLeaveCalendarHandler,
      {
        provide: getRepositoryToken(LeaveRequest),
        useValue: { createQueryBuilder: jest.fn(() => qb) },
      },
    ],
  }).compile();
  return module.get(GetTeamLeaveCalendarHandler);
}

describe('LeaveRequest date columns → GraphQL DateTime (teamLeaveCalendar)', () => {
  it('hydrates a stored leave date as a Date, which the DateTime scalar serialises', () => {
    const startDate = hydrateDateColumn('startDate', '2026-10-12');

    expect(startDate).toBeInstanceOf(Date);
    expect(GraphQLISODateTime.serialize(startDate)).toBe('2026-10-12T00:00:00.000Z');
  });

  it('serialises every teamLeaveCalendar entry date to the stored calendar day at UTC midnight', async () => {
    const handler = await handlerReturning([hydratedLeaveRequest()]);

    const [entry] = await handler.execute(
      new GetTeamLeaveCalendarQuery('tenant-1', undefined, '2026-10-16', '2026-10-16'),
    );

    expect(entry).toBeDefined();
    expect(GraphQLISODateTime.serialize(entry?.startDate)).toBe('2026-10-12T00:00:00.000Z');
    expect(GraphQLISODateTime.serialize(entry?.endDate)).toBe('2026-10-18T00:00:00.000Z');
    expect(entry?.totalDays).toBe(5);
  });
});
