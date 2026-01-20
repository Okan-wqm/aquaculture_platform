import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
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

    // Validate employee
    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with ID ${employeeId} not found`);
    }

    // Validate course
    const course = await this.courseRepository.findOne({
      where: { id: trainingCourseId, tenantId, isDeleted: false },
    });

    if (!course) {
      throw new NotFoundException(`Training course with ID ${trainingCourseId} not found`);
    }

    if (!course.isActive) {
      throw new BadRequestException(`Training course ${course.name} is not active`);
    }

    // Check for existing enrollment
    const existingEnrollment = await this.enrollmentRepository.findOne({
      where: {
        tenantId,
        employeeId,
        trainingCourseId,
        status: EnrollmentStatus.ENROLLED,
        isDeleted: false,
      },
    });

    if (existingEnrollment) {
      throw new BadRequestException(
        `Employee is already enrolled in ${course.name}`,
      );
    }

    // Check in-progress enrollment
    const inProgressEnrollment = await this.enrollmentRepository.findOne({
      where: {
        tenantId,
        employeeId,
        trainingCourseId,
        status: EnrollmentStatus.IN_PROGRESS,
        isDeleted: false,
      },
    });

    if (inProgressEnrollment) {
      throw new BadRequestException(
        `Employee already has ${course.name} in progress`,
      );
    }

    const enrollment = this.enrollmentRepository.create({
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

    return this.enrollmentRepository.save(enrollment);
  }
}
