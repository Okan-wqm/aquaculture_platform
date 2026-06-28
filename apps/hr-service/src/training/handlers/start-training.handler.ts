import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { StartTrainingCommand } from '../commands/start-training.command';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';

/**
 * Self-service start of a training enrollment: ENROLLED -> IN_PROGRESS.
 *
 * Ownership: the enrollment MUST belong to the calling employee (callerEmployeeId,
 * resolved from the JWT subject in the resolver). A manager/admin enrolling others
 * is a separate (enrollInTraining) flow; this start action is the employee's own.
 */
@CommandHandler(StartTrainingCommand)
export class StartTrainingHandler
  implements ICommandHandler<StartTrainingCommand>
{
  constructor(
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
  ) {}

  async execute(command: StartTrainingCommand): Promise<TrainingEnrollment> {
    const { tenantId, userId, enrollmentId, callerEmployeeId } = command;

    const enrollment = await this.enrollmentRepository.findOne({
      where: { id: enrollmentId, tenantId, isDeleted: false },
    });

    if (!enrollment) {
      throw new NotFoundException(`Training enrollment with ID ${enrollmentId} not found`);
    }

    // OWNERSHIP: self-service start is restricted to the enrollment's own employee.
    if (enrollment.employeeId !== callerEmployeeId) {
      throw new ForbiddenException('You can only start your own training enrollments');
    }

    if (enrollment.status === EnrollmentStatus.IN_PROGRESS) {
      throw new BadRequestException('Training is already in progress');
    }

    if (enrollment.status !== EnrollmentStatus.ENROLLED) {
      throw new BadRequestException(
        `Cannot start training from status "${enrollment.status}". Only ENROLLED training can be started.`,
      );
    }

    enrollment.status = EnrollmentStatus.IN_PROGRESS;
    enrollment.startedAt = new Date();
    enrollment.updatedBy = userId;

    return this.enrollmentRepository.save(enrollment);
  }
}
