import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { WithdrawFromTrainingCommand } from '../commands/withdraw-from-training.command';
import {
  TrainingEnrollment,
  EnrollmentStatus,
} from '../entities/training-enrollment.entity';

/**
 * Self-service withdrawal from a training enrollment:
 * ENROLLED | IN_PROGRESS -> WITHDRAWN.
 *
 * Ownership: the enrollment MUST belong to the calling employee. Terminal states
 * (COMPLETED, PASSED, FAILED, WITHDRAWN, EXPIRED) cannot be withdrawn.
 */
@CommandHandler(WithdrawFromTrainingCommand)
export class WithdrawFromTrainingHandler
  implements ICommandHandler<WithdrawFromTrainingCommand>
{
  private static readonly WITHDRAWABLE: ReadonlySet<EnrollmentStatus> = new Set([
    EnrollmentStatus.ENROLLED,
    EnrollmentStatus.IN_PROGRESS,
  ]);

  constructor(
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
  ) {}

  async execute(command: WithdrawFromTrainingCommand): Promise<TrainingEnrollment> {
    const { tenantId, userId, enrollmentId, callerEmployeeId, reason } = command;

    const enrollment = await this.enrollmentRepository.findOne({
      where: { id: enrollmentId, tenantId, isDeleted: false },
    });

    if (!enrollment) {
      throw new NotFoundException(`Training enrollment with ID ${enrollmentId} not found`);
    }

    // OWNERSHIP: self-service withdrawal is restricted to the enrollment's own employee.
    if (enrollment.employeeId !== callerEmployeeId) {
      throw new ForbiddenException('You can only withdraw from your own training enrollments');
    }

    if (!WithdrawFromTrainingHandler.WITHDRAWABLE.has(enrollment.status)) {
      throw new BadRequestException(
        `Cannot withdraw from training with status "${enrollment.status}". ` +
          `Only ENROLLED or IN_PROGRESS training can be withdrawn.`,
      );
    }

    enrollment.status = EnrollmentStatus.WITHDRAWN;
    if (reason) {
      enrollment.notes = enrollment.notes
        ? `${enrollment.notes}; Withdrawal: ${reason}`
        : `Withdrawal: ${reason}`;
    }
    enrollment.updatedBy = userId;

    return this.enrollmentRepository.save(enrollment);
  }
}
