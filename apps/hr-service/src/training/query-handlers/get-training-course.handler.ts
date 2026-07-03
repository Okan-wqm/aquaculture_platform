import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetTrainingCourseQuery } from '../queries/get-training-course.query';
import { TrainingCourse } from '../entities/training-course.entity';
import { CertificationType } from '../entities/certification-type.entity';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';

@QueryHandler(GetTrainingCourseQuery)
export class GetTrainingCourseHandler
  implements IQueryHandler<GetTrainingCourseQuery>
{
  constructor(
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
    @InjectRepository(CertificationType)
    private readonly certTypeRepository: Repository<CertificationType>,
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
  ) {}

  async execute(query: GetTrainingCourseQuery): Promise<TrainingCourse> {
    const { tenantId, id } = query;

    const course = await this.courseRepository.findOne({
      where: { id, tenantId, isDeleted: false },
    });

    if (!course) {
      throw new NotFoundException(`Training course with ID ${id} not found`);
    }

    // Linked certification type (FE selects certificationType { id code name }).
    if (course.certificationTypeId) {
      course.certificationType =
        (await this.certTypeRepository.findOne({
          where: { id: course.certificationTypeId, tenantId, isDeleted: false },
        })) ?? undefined;
    }

    // Prerequisite courses resolved from the prerequisites (course-id) array.
    const prereqIds = course.prerequisites ?? [];
    course.prerequisiteCourses =
      prereqIds.length > 0
        ? await this.courseRepository.find({
            where: { tenantId, id: In(prereqIds), isDeleted: false },
          })
        : [];

    // Enrolment roll-up: total enrolments + completion rate (0-100).
    const total = await this.enrollmentRepository.count({
      where: { tenantId, trainingCourseId: id, isDeleted: false },
    });
    course.enrollmentCount = total;

    if (total === 0) {
      course.completionRate = 0;
    } else {
      const completed = await this.enrollmentRepository.count({
        where: [
          {
            tenantId,
            trainingCourseId: id,
            status: EnrollmentStatus.COMPLETED,
            isDeleted: false,
          },
          {
            tenantId,
            trainingCourseId: id,
            status: EnrollmentStatus.PASSED,
            isDeleted: false,
          },
        ],
      });
      course.completionRate = Math.round((completed / total) * 10000) / 100;
    }

    return course;
  }
}
