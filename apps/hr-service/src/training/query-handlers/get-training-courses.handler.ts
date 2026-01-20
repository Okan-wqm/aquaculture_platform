import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
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

  async execute(query: GetTrainingCoursesQuery): Promise<TrainingCourse[]> {
    const { tenantId, trainingType, isMandatory, isActive } = query;

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

    return queryBuilder.getMany();
  }
}
