import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GetTrainingCalendarQuery } from '../queries/get-training-calendar.query';
import {
  TrainingSession,
  TrainingSessionStatus,
} from '../entities/training-session.entity';
import { TrainingCourse } from '../entities/training-course.entity';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';
import { WorkArea } from '../../aquaculture/entities/work-area.entity';

/**
 * Returns scheduled training sessions over a date range for the calendar view.
 *
 * - Date range is inclusive [startDate, endDate]; CANCELLED sessions are excluded.
 * - Optional courseId narrows to one course.
 * - Optional workAreaId narrows to courses whose linked certificationType is
 *   required by that work area (WorkArea.requiredCertifications).
 * - enrolledCount counts non-deleted, non-withdrawn TrainingEnrollment rows whose
 *   sessionId references the session; availableSlots = maxParticipants - enrolledCount
 *   (null when the session has no capacity cap).
 */
@QueryHandler(GetTrainingCalendarQuery)
export class GetTrainingCalendarHandler
  implements IQueryHandler<GetTrainingCalendarQuery>
{
  constructor(
    @InjectRepository(TrainingSession)
    private readonly sessionRepository: Repository<TrainingSession>,
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
    @InjectRepository(WorkArea)
    private readonly workAreaRepository: Repository<WorkArea>,
  ) {}

  async execute(query: GetTrainingCalendarQuery): Promise<TrainingSession[]> {
    const { tenantId, startDate, endDate, courseId, workAreaId } = query;

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new BadRequestException('startDate and endDate must be valid dates');
    }
    if (start > end) {
      throw new BadRequestException('startDate must not be after endDate');
    }

    // Resolve the workArea filter to a set of allowed course ids (via the
    // course's linked certificationType being required by the work area).
    let allowedCourseIds: string[] | undefined;
    if (workAreaId) {
      const workArea = await this.workAreaRepository.findOne({
        where: { id: workAreaId, tenantId, isDeleted: false },
      });
      if (!workArea) {
        throw new NotFoundException(`Work area with ID ${workAreaId} not found`);
      }
      const requiredCertIds = workArea.requiredCertifications ?? [];
      if (requiredCertIds.length === 0) {
        return [];
      }
      const courses = await this.courseRepository.find({
        where: {
          tenantId,
          certificationTypeId: In(requiredCertIds),
          isDeleted: false,
        },
      });
      allowedCourseIds = courses.map((c) => c.id);
      if (allowedCourseIds.length === 0) {
        return [];
      }
    }

    const qb = this.sessionRepository
      .createQueryBuilder('ts')
      .where('ts.tenantId = :tenantId', { tenantId })
      .andWhere('ts.isDeleted = false')
      .andWhere('ts.status != :cancelled', {
        cancelled: TrainingSessionStatus.CANCELLED,
      })
      .andWhere('ts.sessionDate >= :start', { start })
      .andWhere('ts.sessionDate <= :end', { end })
      .orderBy('ts.sessionDate', 'ASC')
      .addOrderBy('ts.startTime', 'ASC');

    if (courseId) {
      qb.andWhere('ts.trainingCourseId = :courseId', { courseId });
    }
    if (allowedCourseIds) {
      qb.andWhere('ts.trainingCourseId IN (:...allowedCourseIds)', { allowedCourseIds });
    }

    const sessions = await qb.getMany();
    if (sessions.length === 0) {
      return [];
    }

    // Resolve course names for the involved courses (FE selects courseName).
    const courseIds = [...new Set(sessions.map((s) => s.trainingCourseId))];
    const courses = await this.courseRepository.find({
      where: { tenantId, id: In(courseIds), isDeleted: false },
    });
    const courseById = new Map(courses.map((c) => [c.id, c]));

    // Per-session enrolment counts: active enrolments (not WITHDRAWN/EXPIRED)
    // whose sessionId references the session.
    const sessionIds = sessions.map((s) => s.id);
    const enrollments = await this.enrollmentRepository.find({
      where: {
        tenantId,
        sessionId: In(sessionIds),
        isDeleted: false,
      },
    });
    const countBySession = new Map<string, number>();
    for (const e of enrollments) {
      if (
        e.status === EnrollmentStatus.WITHDRAWN ||
        e.status === EnrollmentStatus.EXPIRED ||
        !e.sessionId
      ) {
        continue;
      }
      countBySession.set(e.sessionId, (countBySession.get(e.sessionId) ?? 0) + 1);
    }

    for (const session of sessions) {
      const course = courseById.get(session.trainingCourseId);
      session.trainingCourse = course;
      session.courseName = course?.name;
      const enrolled = countBySession.get(session.id) ?? 0;
      session.enrolledCount = enrolled;
      session.availableSlots =
        session.maxParticipants != null
          ? Math.max(session.maxParticipants - enrolled, 0)
          : undefined;
    }

    return sessions;
  }
}
