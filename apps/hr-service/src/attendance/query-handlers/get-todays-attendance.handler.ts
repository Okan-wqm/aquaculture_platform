import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { GetTodaysAttendanceQuery } from '../queries/get-todays-attendance.query';
import { AttendanceRecord } from '../entities/attendance-record.entity';

@Injectable()
@QueryHandler(GetTodaysAttendanceQuery)
export class GetTodaysAttendanceHandler implements IQueryHandler<GetTodaysAttendanceQuery, AttendanceRecord[]> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
  ) {}

  async execute(query: GetTodaysAttendanceQuery): Promise<AttendanceRecord[]> {
    const { tenantId, employeeId } = query;
    const today = new Date().toISOString().split('T')[0];

    const qb = this.attendanceRepository.createQueryBuilder('ar')
      .leftJoinAndSelect('ar.employee', 'employee')
      .where('ar.tenantId = :tenantId', { tenantId })
      .andWhere('ar.date = :today', { today })
      .andWhere('ar.isDeleted = false')
      .orderBy('ar.clockIn', 'DESC');

    if (employeeId) {
      qb.andWhere('ar.employeeId = :employeeId', { employeeId });
    }

    return qb.getMany();
  }
}
