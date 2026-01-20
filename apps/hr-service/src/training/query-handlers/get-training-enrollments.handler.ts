import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
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

  async execute(query: GetTrainingEnrollmentsQuery): Promise<TrainingEnrollment[]> {
    const { tenantId, employeeId, trainingCourseId, status } = query;

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

    return queryBuilder.getMany();
  }
}
