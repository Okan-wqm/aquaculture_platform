import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { EnrollInTrainingCommand } from '../commands/enroll-in-training.command';
import { TrainingEnrollment, EnrollmentStatus } from '../entities/training-enrollment.entity';
import { TrainingCourse } from '../entities/training-course.entity';
import { Employee } from '../../hr/entities/employee.entity';

@CommandHandler(EnrollInTrainingCommand)
export class EnrollInTrainingHandler
  implements ICommandHandler<EnrollInTrainingCommand>
{
  constructor(
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: EnrollInTrainingCommand): Promise<TrainingEnrollment> {
    const {
      tenantId,
      userId,
      employeeId,
      trainingCourseId,
      dueDate,
      sessionId,
      instructor,
      location,
    } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    // READ COMMITTED with the unique index on (tenantId, employeeId, trainingCourseId, status)
    // is sufficient to prevent duplicate enrollments; SERIALIZABLE is unnecessary overhead here.
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      // Validate employee
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: employeeId, tenantId, isDeleted: false },
      });

      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Validate course
      const course = await queryRunner.manager.findOne(TrainingCourse, {
        where: { id: trainingCourseId, tenantId, isDeleted: false },
      });

      if (!course) {
        throw new NotFoundException(`Training course with ID ${trainingCourseId} not found`);
      }

      if (!course.isActive) {
        throw new BadRequestException(`Training course ${course.name} is not active`);
      }

      // Check for existing enrollment with either ENROLLED or IN_PROGRESS status
      const existingEnrollment = await queryRunner.manager.findOne(TrainingEnrollment, {
        where: [
          { tenantId, employeeId, trainingCourseId, status: EnrollmentStatus.ENROLLED, isDeleted: false },
          { tenantId, employeeId, trainingCourseId, status: EnrollmentStatus.IN_PROGRESS, isDeleted: false },
        ],
      });

      if (existingEnrollment) {
        const statusMessage = existingEnrollment.status === EnrollmentStatus.ENROLLED
          ? `Employee is already enrolled in ${course.name}`
          : `Employee already has ${course.name} in progress`;
        throw new ConflictException(statusMessage);
      }

      const enrollment = queryRunner.manager.create(TrainingEnrollment, {
        tenantId,
        employeeId,
        trainingCourseId,
        status: EnrollmentStatus.ENROLLED,
        enrollmentDate: new Date(),
        dueDate: dueDate ? new Date(dueDate) : undefined,
        progressPercent: 0,
        attemptCount: 0,
        sessionId,
        instructor,
        location,
        createdBy: userId,
        updatedBy: userId,
      });

      const result = await queryRunner.manager.save(enrollment);
      await queryRunner.commitTransaction();
      return result;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
