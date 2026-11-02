import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { ApproveAttendanceCommand } from '../commands/approve-attendance.command';
import { AttendanceRecord, ApprovalStatus } from '../entities/attendance-record.entity';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { assertNotOwnRecord, findViewerEmployee } from '../../common/viewer';

@CommandHandler(ApproveAttendanceCommand)
export class ApproveAttendanceHandler implements ICommandHandler<ApproveAttendanceCommand> {
  private readonly logger = new Logger(ApproveAttendanceHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: ApproveAttendanceCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, attendanceRecordId, notes } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const attendanceRepo = tenantManagerRepo(queryRunner.manager, AttendanceRecord, tenantId);

      const attendanceRecord = await attendanceRepo.findOne({
        where: { id: attendanceRecordId, tenantId, isDeleted: false },
      });

      if (!attendanceRecord) {
        throw new NotFoundException(`Attendance record with ID ${attendanceRecordId} not found`);
      }

      if (attendanceRecord.approvalStatus !== ApprovalStatus.PENDING_REVIEW) {
        throw new BadRequestException(
          `Cannot approve attendance record with status ${attendanceRecord.approvalStatus}`,
        );
      }

      // The record carries an HR employee id and `userId` is the auth user id, so the approver's
      // employee is looked up first. A tenant owner with no employee record has no record of their
      // own to approve.
      const approver = await findViewerEmployee(queryRunner.manager, tenantId, { sub: userId });
      assertNotOwnRecord(
        approver,
        attendanceRecord.employeeId,
        'You cannot approve your own attendance record',
      );

      attendanceRecord.approvalStatus = ApprovalStatus.MANAGER_APPROVED;
      attendanceRecord.approvedBy = userId;
      attendanceRecord.approvedAt = new Date();

      if (notes) {
        attendanceRecord.remarks = attendanceRecord.remarks
          ? `${attendanceRecord.remarks}; Approval: ${notes}`
          : `Approval: ${notes}`;
      }

      attendanceRecord.updatedBy = userId;

      const savedRecord = await attendanceRepo.save(attendanceRecord);

      await queryRunner.commitTransaction();

      return savedRecord;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException ||
        error instanceof ForbiddenException
      ) {
        throw error;
      }

      this.logger.error(
        `Failed to approve attendance record ${attendanceRecordId} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to approve attendance record');
    } finally {
      await queryRunner.release();
    }
  }
}
