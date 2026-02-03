import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { ApproveAttendanceCommand } from '../commands/approve-attendance.command';
import { AttendanceRecord, ApprovalStatus } from '../entities/attendance-record.entity';

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
      const attendanceRepo = queryRunner.manager.getRepository(AttendanceRecord);

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

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
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
