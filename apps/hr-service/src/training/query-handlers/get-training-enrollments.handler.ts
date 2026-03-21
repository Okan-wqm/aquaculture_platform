import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTrainingEnrollmentsQuery } from '../queries/get-training-enrollments.query';
import { TrainingEnrollment } from '../entities/training-enrollment.entity';

@QueryHandler(GetTrainingEnrollmentsQuery)
export class GetTrainingEnrollmentsHandler
  implements IQueryHandler<GetTrainingEnrollmentsQuery>
{
  constructor(
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
  ) {}

  async execute(query: GetTrainingEnrollmentsQuery): Promise<PaginatedQueryResult<TrainingEnrollment>> {
    const { tenantId, employeeId, trainingCourseId, status } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const queryBuilder = this.enrollmentRepository
      .createQueryBuilder('te')
      .leftJoinAndSelect('te.trainingCourse', 'trainingCourse')
      .leftJoinAndSelect('te.employee', 'employee')
      .where('te.tenantId = :tenantId', { tenantId })
      .andWhere('te.isDeleted = false')
      .orderBy('te.enrollmentDate', 'DESC');

    if (employeeId) {
      queryBuilder.andWhere('te.employeeId = :employeeId', { employeeId });
    }

    if (trainingCourseId) {
      queryBuilder.andWhere('te.trainingCourseId = :trainingCourseId', { trainingCourseId });
    }

    if (status) {
      queryBuilder.andWhere('te.status = :status', { status });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
