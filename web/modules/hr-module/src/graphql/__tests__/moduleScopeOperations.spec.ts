/**
 * The Team-area operations declare the module scope the hooks send.
 *
 * hr-service gave each employee-list read of the Team pages an optional
 * `moduleCode: HRModuleCode` argument (only rows whose employee's live department is in that
 * module). An operation that forgets to declare `$moduleCode`, or declares it without handing it
 * to the field, would have the hooks send a variable the server ignores — a Production roster
 * quietly showing every module. The gate lives here, on the operation documents.
 */
import type { DocumentNode, FieldNode, OperationDefinitionNode } from 'graphql';
import { Kind } from 'graphql';
import { describe, expect, it } from 'vitest';

import {
  GET_ATTENDANCE_RECORDS,
  GET_DAILY_ATTENDANCE_OVERVIEW,
  GET_TODAYS_ATTENDANCE,
} from '../attendance.operations';
import {
  GET_LEAVE_REQUESTS,
  GET_PENDING_LEAVE_APPROVALS,
  GET_TEAM_LEAVE_CALENDAR,
} from '../leave.operations';
import {
  GET_OVERTIME_SUMMARY,
  GET_TEAM_WEEKLY_OVERVIEW,
  GET_WEEKLY_PLANS,
} from '../scheduling.operations';

/** Operation → the root field it must scope. */
const SCOPED_OPERATIONS: ReadonlyArray<readonly [string, DocumentNode, string]> = [
  ['GET_TODAYS_ATTENDANCE', GET_TODAYS_ATTENDANCE, 'todaysAttendance'],
  ['GET_DAILY_ATTENDANCE_OVERVIEW', GET_DAILY_ATTENDANCE_OVERVIEW, 'dailyAttendanceOverview'],
  ['GET_ATTENDANCE_RECORDS', GET_ATTENDANCE_RECORDS, 'attendanceRecords'],
  ['GET_TEAM_WEEKLY_OVERVIEW', GET_TEAM_WEEKLY_OVERVIEW, 'teamWeeklyOverview'],
  ['GET_WEEKLY_PLANS', GET_WEEKLY_PLANS, 'weeklyPlans'],
  ['GET_OVERTIME_SUMMARY', GET_OVERTIME_SUMMARY, 'overtimeSummary'],
  ['GET_LEAVE_REQUESTS', GET_LEAVE_REQUESTS, 'leaveRequests'],
  ['GET_PENDING_LEAVE_APPROVALS', GET_PENDING_LEAVE_APPROVALS, 'pendingLeaveApprovals'],
  ['GET_TEAM_LEAVE_CALENDAR', GET_TEAM_LEAVE_CALENDAR, 'teamLeaveCalendar'],
];

function operationOf(document: DocumentNode): OperationDefinitionNode {
  const operation = document.definitions.find(
    (definition): definition is OperationDefinitionNode =>
      definition.kind === Kind.OPERATION_DEFINITION,
  );
  if (!operation) throw new Error('the document has no operation');
  return operation;
}

function rootFieldOf(operation: OperationDefinitionNode): FieldNode {
  const field = operation.selectionSet.selections.find(
    (selection): selection is FieldNode => selection.kind === Kind.FIELD,
  );
  if (!field) throw new Error('the operation selects no field');
  return field;
}

describe.each(SCOPED_OPERATIONS)('%s', (_name, document, rootField) => {
  const operation = operationOf(document);
  const field = rootFieldOf(operation);

  it(`scopes the ${rootField} field`, () => {
    expect(field.name.value).toBe(rootField);
  });

  it('declares $moduleCode as the optional HRModuleCode (absent = every module)', () => {
    const declared = operation.variableDefinitions?.find(
      (definition) => definition.variable.name.value === 'moduleCode',
    );

    expect(declared?.type).toMatchObject({
      kind: Kind.NAMED_TYPE,
      name: { value: 'HRModuleCode' },
    });
  });

  it('hands $moduleCode to the field as its moduleCode argument', () => {
    const argument = field.arguments?.find((candidate) => candidate.name.value === 'moduleCode');

    expect(argument?.value).toMatchObject({ kind: Kind.VARIABLE, name: { value: 'moduleCode' } });
  });
});
