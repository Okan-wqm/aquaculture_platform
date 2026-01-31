import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTrainingCoursesQuery } from '../queries/get-training-courses.query';
import { TrainingCourse } from '../entities/training-course.entity';

export interface PaginatedTrainingCourses {
  items: TrainingCourse[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

@QueryHandler(GetTrainingCoursesQuery)
export class GetTrainingCoursesHandler implements IQueryHandler<GetTrainingCoursesQuery> {
  constructor(
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
  ) {}

  async execute(query: GetTrainingCoursesQuery): Promise<PaginatedTrainingCourses> {
    const { tenantId, trainingType, isMandatory, isActive, limit = 20, offset = 0 } = query;

    // Enforce pagination limits
    const effectiveLimit = Math.min(Math.max(limit, 1), 100);
    const effectiveOffset = Math.max(offset, 0);

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
