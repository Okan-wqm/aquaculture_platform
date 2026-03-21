import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { PaginatedQueryResult, createPaginatedQueryResult } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTrainingCoursesQuery } from '../queries/get-training-courses.query';
import { TrainingCourse } from '../entities/training-course.entity';

@QueryHandler(GetTrainingCoursesQuery)
export class GetTrainingCoursesHandler implements IQueryHandler<GetTrainingCoursesQuery> {
  constructor(
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
  ) {}

  async execute(query: GetTrainingCoursesQuery): Promise<PaginatedQueryResult<TrainingCourse>> {
    const { tenantId, trainingType, isMandatory, isActive } = query;

    const page = query.page ?? 1;
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const offset = (page - 1) * limit;

    const queryBuilder = this.courseRepository
      .createQueryBuilder('tc')
      .where('tc.tenantId = :tenantId', { tenantId })
      .andWhere('tc.isDeleted = false')
      .orderBy('tc.displayOrder', 'ASC')
      .addOrderBy('tc.name', 'ASC');

    if (trainingType) {
      queryBuilder.andWhere('tc.trainingType = :trainingType', { trainingType });
    }

    if (isMandatory !== undefined) {
      queryBuilder.andWhere('tc.isMandatory = :isMandatory', { isMandatory });
    }

    if (isActive !== undefined) {
      queryBuilder.andWhere('tc.isActive = :isActive', { isActive });
    }

    const [items, total] = await queryBuilder
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    return createPaginatedQueryResult(items, page, limit, total);
  }
}
