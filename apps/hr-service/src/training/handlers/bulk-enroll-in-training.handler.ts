import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import {
  NotFoundException,
  BadRequestException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { BulkEnrollInTrainingCommand } from '../commands/bulk-enroll-in-training.command';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';
import { TrainingCourse } from '../entities/training-course.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { BulkEnrollResult } from '../dto/certification-reports.types';

/**
 * Bulk-enroll many employees into a single training course.
 *
 * The course is validated once. Each employee is then enrolled, tolerating
 * per-employee outcomes: already-enrolled (active enrollment exists) and failed
 * (employee not found / cross-tenant) are counted without aborting the batch.
 * The whole batch runs in one transaction — a successful enrolment is committed
 * only if no unexpected (non-per-employee) error occurs.
 */
@CommandHandler(BulkEnrollInTrainingCommand)
export class BulkEnrollInTrainingHandler
  implements ICommandHandler<BulkEnrollInTrainingCommand>
{
  private readonly logger = new Logger(BulkEnrollInTrainingHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: BulkEnrollInTrainingCommand): Promise<BulkEnrollResult> {
    const { tenantId, userId, courseId, employeeIds } = command;

    if (employeeIds.length === 0) {
      throw new BadRequestException('employeeIds must contain at least one employee');
    }

    // De-duplicate caller-supplied ids so a repeated id is not double-counted.
    const uniqueEmployeeIds = [...new Set(employeeIds)];

    const result: BulkEnrollResult = {
      enrolled: 0,
      alreadyEnrolled: 0,
      failed: 0,
      errors: [],
    };

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const course = await queryRunner.manager.findOne(TrainingCourse, {
        where: { id: courseId, tenantId, isDeleted: false },
      });

      if (!course) {
        throw new NotFoundException(`Training course with ID ${courseId} not found`);
      }

      if (!course.isActive) {
        throw new BadRequestException(`Training course ${course.name} is not active`);
      }

      for (const employeeId of uniqueEmployeeIds) {
        const employee = await queryRunner.manager.findOne(Employee, {
          where: { id: employeeId, tenantId, isDeleted: false },
        });

        if (!employee) {
          result.failed += 1;
          result.errors.push(`Employee ${employeeId} not found`);
          continue;
        }

        const existingEnrollment = await queryRunner.manager.findOne(TrainingEnrollment, {
          where: [
            {
              tenantId,
              employeeId,
              trainingCourseId: courseId,
              status: EnrollmentStatus.ENROLLED,
              isDeleted: false,
            },
            {
              tenantId,
              employeeId,
              trainingCourseId: courseId,
              status: EnrollmentStatus.IN_PROGRESS,
              isDeleted: false,
            },
          ],
        });

        if (existingEnrollment) {
          result.alreadyEnrolled += 1;
          continue;
        }

        const enrollment = queryRunner.manager.create(TrainingEnrollment, {
          tenantId,
          employeeId,
          trainingCourseId: courseId,
          status: EnrollmentStatus.ENROLLED,
          enrollmentDate: new Date(),
          progressPercent: 0,
          attemptCount: 0,
          createdBy: userId,
          updatedBy: userId,
        });

        await queryRunner.manager.save(TrainingEnrollment, enrollment);
        result.enrolled += 1;
      }

      await queryRunner.commitTransaction();

      this.logger.log(
        `Bulk enrolment into course ${courseId} for tenant ${tenantId}: ` +
          `enrolled=${result.enrolled}, alreadyEnrolled=${result.alreadyEnrolled}, failed=${result.failed}`,
      );

      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Bulk enrolment failed for course ${courseId}, tenant ${tenantId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new InternalServerErrorException('Failed to bulk-enroll employees in training');
    } finally {
      await queryRunner.release();
    }
  }
}
