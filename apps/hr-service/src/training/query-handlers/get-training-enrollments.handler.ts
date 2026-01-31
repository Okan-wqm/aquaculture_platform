import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTrainingEnrollmentsQuery } from '../queries/get-training-enrollments.query';
import { TrainingEnrollment } from '../entities/training-enrollment.entity';

export interface PaginatedTrainingEnrollments {
  items: TrainingEnrollment[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetTrainingEnrollmentsQuery)
export class GetTrainingEnrollmentsHandler
  implements IQueryHandler<GetTrainingEnrollmentsQuery>
{
  constructor(
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
  ) {}

  async execute(query: GetTrainingEnrollmentsQuery): Promise<PaginatedTrainingEnrollments> {
    const { tenantId, employeeId, trainingCourseId, status, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

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
      .skip(effectiveOffset)
      .take(effectiveLimit)
      .getManyAndCount();

    return {
      items,
      total,
      limit: effectiveLimit,
      offset: effectiveOffset,
      hasMore: effectiveOffset + items.length < total,
    };
  }
}
