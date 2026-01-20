import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { ApproveAttendanceCommand } from '../commands/approve-attendance.command';
import { AttendanceRecord, ApprovalStatus } from '../entities/attendance-record.entity';

@CommandHandler(ApproveAttendanceCommand)
export class ApproveAttendanceHandler implements ICommandHandler<ApproveAttendanceCommand> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
  ) {}

  async execute(command: ApproveAttendanceCommand): Promise<AttendanceRecord> {
    const { tenantId, userId, attendanceRecordId, notes } = command;

    const attendanceRecord = await this.attendanceRepository.findOne({
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

    return this.attendanceRepository.save(attendanceRecord);
  }
}
