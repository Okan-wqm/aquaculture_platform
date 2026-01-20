import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CompleteTrainingCommand } from '../commands/complete-training.command';
import { TrainingEnrollment, EnrollmentStatus, AssessmentAttempt } from '../entities/training-enrollment.entity';
import { TrainingCourse } from '../entities/training-course.entity';

@CommandHandler(CompleteTrainingCommand)
export class CompleteTrainingHandler
  implements ICommandHandler<CompleteTrainingCommand>
{
  constructor(
    @InjectRepository(TrainingEnrollment)
    private readonly enrollmentRepository: Repository<TrainingEnrollment>,
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CompleteTrainingCommand): Promise<TrainingEnrollment> {
    const { tenantId, userId, enrollmentId, score, feedback, feedbackRating } = command;

    const enrollment = await this.enrollmentRepository.findOne({
      where: { id: enrollmentId, tenantId, isDeleted: false },
      relations: ['trainingCourse'],
    });

    if (!enrollment) {
      throw new NotFoundException(`Training enrollment with ID ${enrollmentId} not found`);
    }

    if (
      enrollment.status === EnrollmentStatus.COMPLETED ||
      enrollment.status === EnrollmentStatus.PASSED
    ) {
      throw new BadRequestException('Training is already completed');
    }

    const course = enrollment.trainingCourse;
    const now = new Date();

    // Handle assessment-based courses
    if (course?.requiresAssessment && score !== undefined) {
      const attemptNumber = (enrollment.attemptCount || 0) + 1;
      const passed = score >= (course.passingScore || 0);

      const attempt: AssessmentAttempt = {
        attemptNumber,
        score,
        passed,
        attemptedAt: now,
      };

      enrollment.assessmentAttempts = [
        ...(enrollment.assessmentAttempts || []),
        attempt,
      ];
      enrollment.attemptCount = attemptNumber;
      enrollment.finalScore = score;

      if (passed) {
        enrollment.status = EnrollmentStatus.PASSED;
        enrollment.completedAt = now;
        enrollment.progressPercent = 100;
      } else if (course.maxAttempts && attemptNumber >= course.maxAttempts) {
        enrollment.status = EnrollmentStatus.FAILED;
        enrollment.completedAt = now;
      } else {
        // Still has attempts remaining
        enrollment.status = EnrollmentStatus.IN_PROGRESS;
      }
    } else {
      // Non-assessment courses
      enrollment.status = EnrollmentStatus.COMPLETED;
      enrollment.completedAt = now;
      enrollment.progressPercent = 100;
      if (score !== undefined) {
        enrollment.finalScore = score;
      }
    }

    if (feedback) {
      enrollment.feedback = feedback;
    }
    if (feedbackRating) {
      enrollment.feedbackRating = feedbackRating;
    }

    enrollment.updatedBy = userId;

    const savedEnrollment = await this.enrollmentRepository.save(enrollment);

    // TODO: Publish TrainingCompletedEvent
    // if (enrollment.status === EnrollmentStatus.PASSED || enrollment.status === EnrollmentStatus.COMPLETED) {
    //   this.eventBus.publish(new TrainingCompletedEvent(savedEnrollment));
    // }

    return savedEnrollment;
  }
}
