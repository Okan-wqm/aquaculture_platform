/**
 * Attendance approval — nobody approves their own record (HR-HIGH-056).
 *
 * The queue already hides the approver's own records, but the mutation took any record id, so a
 * manager could create a manual record for themselves and approve it. The record carries an HR
 * employee id and the command the auth user id, so the approver's employee is looked up and
 * compared id with id, the way the leave handlers do.
 */
import { ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { Employee } from '../../hr/entities/employee.entity';
import { ApproveAttendanceCommand } from '../commands/approve-attendance.command';
import { ApproveAttendanceHandler } from '../handlers/approve-attendance.handler';
import { ApprovalStatus, AttendanceRecord } from '../entities/attendance-record.entity';

const tenantId = 'tenant-uuid-001';
const approverUserId = 'manager-user-001';
const approverEmployeeId = 'manager-employee-001';

const pendingRecord = (employeeId: string): AttendanceRecord =>
  Object.assign(new AttendanceRecord(), {
    id: 'record-1',
    tenantId,
    employeeId,
    approvalStatus: ApprovalStatus.PENDING_REVIEW,
    isDeleted: false,
  });

const build = (record: AttendanceRecord, approver: Partial<Employee> | null) => {
  const attendanceRepo = {
    findOne: jest.fn().mockResolvedValue(record),
    // tenantManagerRepo wraps the repository in the real tenant-scoped one, whose save() builds
    // the row through create() first.
    create: jest.fn().mockImplementation((row: AttendanceRecord) => row),
    save: jest.fn().mockImplementation((saved: AttendanceRecord) => Promise.resolve(saved)),
  };
  const findOne = jest.fn().mockResolvedValue(approver);
  const manager: Partial<EntityManager> = {
    getRepository: jest.fn().mockReturnValue(attendanceRepo),
    findOne,
  };
  const queryRunner: Partial<QueryRunner> = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: manager as EntityManager,
  };
  const dataSource: Partial<DataSource> = {
    createQueryRunner: jest.fn().mockReturnValue(queryRunner),
  };
  return {
    handler: new ApproveAttendanceHandler(dataSource as DataSource),
    attendanceRepo,
    findOne,
    queryRunner,
  };
};

const approve = (): ApproveAttendanceCommand =>
  new ApproveAttendanceCommand(tenantId, approverUserId, 'record-1');

describe('ApproveAttendanceHandler self-approval', () => {
  it('refuses a manager approving their OWN record with a 403, not a 500, and saves nothing', async () => {
    const { handler, attendanceRepo, queryRunner } = build(pendingRecord(approverEmployeeId), {
      id: approverEmployeeId,
    });

    await expect(handler.execute(approve())).rejects.toBeInstanceOf(ForbiddenException);

    expect(attendanceRepo.save).not.toHaveBeenCalled();
    expect(queryRunner.rollbackTransaction).toHaveBeenCalled();
  });

  it('looks the approver up by their auth user id, then compares EMPLOYEE ids', async () => {
    const { handler, findOne } = build(pendingRecord('someone-else'), { id: approverEmployeeId });

    await handler.execute(approve());

    expect(findOne).toHaveBeenCalledWith(Employee, {
      where: { userId: approverUserId, tenantId, isDeleted: false },
      select: ['id', 'departmentHrId'],
    });
  });

  it("approves someone else's record", async () => {
    const { handler, attendanceRepo } = build(pendingRecord('someone-else'), {
      id: approverEmployeeId,
    });

    const saved = await handler.execute(approve());

    expect(saved.approvalStatus).toBe(ApprovalStatus.MANAGER_APPROVED);
    expect(saved.approvedBy).toBe(approverUserId);
    expect(attendanceRepo.save).toHaveBeenCalledTimes(1);
  });

  it('lets a tenant owner with no employee record approve: they have no record of their own', async () => {
    const { handler } = build(pendingRecord('someone-else'), null);

    const saved = await handler.execute(approve());

    expect(saved.approvalStatus).toBe(ApprovalStatus.MANAGER_APPROVED);
  });
});
