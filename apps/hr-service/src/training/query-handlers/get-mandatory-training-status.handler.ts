import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { GetMandatoryTrainingStatusQuery } from '../queries/get-mandatory-training-status.query';
import { TrainingCourse } from '../entities/training-course.entity';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { MandatoryTrainingStatus } from '../dto/certification-reports.types';

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * For an employee, report the completion status of every mandatory training course.
 *
 * Status semantics (matches FE MandatoryTrainingStatus):
 *  - completed   : a terminal COMPLETED/PASSED enrolment exists
 *  - in_progress : an ENROLLED/IN_PROGRESS enrolment exists, not past due
 *  - overdue     : an active enrolment exists whose dueDate has passed (or no
 *                  enrolment at all but the course is mandatory and considered due)
 *  - not_started : no enrolment exists yet
 */
@QueryHandler(GetMandatoryTrainingStatusQuery)
export class GetMandatoryTrainingStatusHandler
  implements IQueryHandler<GetMandatoryTrainingStatusQuery>
{
  constructor(
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(
    query: GetMandatoryTrainingStatusQuery,
  ): Promise<MandatoryTrainingStatus[]> {
    const { tenantId, employeeId } = query;

    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
      select: ['id'],
    });
    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    const mandatoryCourses = await this.courseRepository.find({
      where: { tenantId, isMandatory: true, isActive: true, isDeleted: false },
      order: { displayOrder: 'ASC', name: 'ASC' },
    });

    if (mandatoryCourses.length === 0) {
      return [];
    }

    const enrollments = await this.enrollmentRepository.find({
      where: { tenantId, employeeId, isDeleted: false },
    });

    // Latest enrolment per course (by enrollmentDate) is the authoritative one.
    const latestByCourse = new Map<string, TrainingEnrollment>();
    for (const e of enrollments) {
      const current = latestByCourse.get(e.trainingCourseId);
      if (!current || e.enrollmentDate > current.enrollmentDate) {
        latestByCourse.set(e.trainingCourseId, e);
      }
    }

    const now = new Date();

    return mandatoryCourses.map((course): MandatoryTrainingStatus => {
      const enrollment = latestByCourse.get(course.id);

      if (!enrollment) {
        return {
          courseId: course.id,
          courseName: course.name,
          isMandatory: true,
          status: 'not_started',
        };
      }

      const isComplete =
        enrollment.status === EnrollmentStatus.COMPLETED ||
        enrollment.status === EnrollmentStatus.PASSED;

      if (isComplete) {
        return {
          courseId: course.id,
          courseName: course.name,
          isMandatory: true,
          status: 'completed',
          completedAt: enrollment.completedAt?.toISOString(),
          dueDate: enrollment.dueDate
            ? new Date(enrollment.dueDate).toISOString()
            : undefined,
        };
      }

      const isActive =
        enrollment.status === EnrollmentStatus.ENROLLED ||
        enrollment.status === EnrollmentStatus.IN_PROGRESS;

      const due = enrollment.dueDate ? new Date(enrollment.dueDate) : undefined;
      const overdue = isActive && due !== undefined && due < now;

      if (overdue) {
        const daysOverdue = Math.floor((now.getTime() - due!.getTime()) / MS_PER_DAY);
        return {
          courseId: course.id,
          courseName: course.name,
          isMandatory: true,
          status: 'overdue',
          dueDate: due!.toISOString(),
          daysOverdue,
        };
      }

      // FAILED / WITHDRAWN / EXPIRED enrolments mean the mandatory course is not
      // satisfied — surface as not_started so the employee re-enrols.
      if (!isActive) {
        return {
          courseId: course.id,
          courseName: course.name,
          isMandatory: true,
          status: 'not_started',
        };
      }

      return {
        courseId: course.id,
        courseName: course.name,
        isMandatory: true,
        status: 'in_progress',
        dueDate: due?.toISOString(),
      };
    });
  }
}
