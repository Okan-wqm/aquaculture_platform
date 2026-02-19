import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetAttendanceRecordsQuery } from '../queries/get-attendance-records.query';
import { AttendanceRecord } from '../entities/attendance-record.entity';

export interface PaginatedAttendanceRecords {
  items: AttendanceRecord[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetAttendanceRecordsQuery)
export class GetAttendanceRecordsHandler implements IQueryHandler<GetAttendanceRecordsQuery> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
  ) {}

  async execute(query: GetAttendanceRecordsQuery): Promise<PaginatedAttendanceRecords> {
    const {
      tenantId,
      employeeId,
      departmentId,
      status,
      approvalStatus,
      startDate,
      endDate,
    } = query;

    // Enforce pagination limits
    const limit = Math.min(Math.max(query.limit || 20, 1), 100);
    const offset = Math.max(query.offset || 0, 0);

    const queryBuilder = this.attendanceRepository
      .createQueryBuilder('ar')
      .leftJoinAndSelect('ar.employee', 'employee')
      .leftJoinAndSelect('ar.shift', 'shift')
      .where('ar.tenantId = :tenantId', { tenantId })
      .andWhere('ar.isDeleted = false')
      .orderBy('ar.date', 'DESC')
      .addOrderBy('ar.createdAt', 'DESC');

    if (employeeId) {
      queryBuilder.andWhere('ar.employeeId = :employeeId', { employeeId });
    }

    if (departmentId) {
      queryBuilder.andWhere('ar.departmentId = :departmentId', { departmentId });
    }

    if (status) {
      queryBuilder.andWhere('ar.status = :status', { status });
    }

    if (approvalStatus) {
      queryBuilder.andWhere('ar.approvalStatus = :approvalStatus', { approvalStatus });
    }

    if (startDate) {
      queryBuilder.andWhere('ar.date >= :startDate', { startDate });
    }

    if (endDate) {
      queryBuilder.andWhere('ar.date <= :endDate', { endDate });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }
}
