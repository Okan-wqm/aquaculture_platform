import { ConflictException, Logger } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { CreateTrainingCourseCommand } from '../commands/create-training-course.command';
import { TrainingCourse } from '../entities/training-course.entity';

@CommandHandler(CreateTrainingCourseCommand)
export class CreateTrainingCourseHandler
  implements ICommandHandler<CreateTrainingCourseCommand>
{
  private readonly logger = new Logger(CreateTrainingCourseHandler.name);

  constructor(
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
  ) {}

  async execute(command: CreateTrainingCourseCommand): Promise<TrainingCourse> {
    const { tenantId, userId, input } = command;

    // Per-tenant code uniqueness is the business key (@Index(['tenantId','code'], unique)).
    const existing = await this.courseRepository.findOne({
      where: { tenantId, code: input.code, isDeleted: false },
    });
    if (existing) {
      throw new ConflictException(
        `Training course with code ${input.code} already exists for this tenant`,
      );
    }

    const course = this.courseRepository.create({
      ...input,
      tenantId,
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.courseRepository.save(course);
    this.logger.log(`Training course ${saved.id} (${saved.code}) created for tenant ${tenantId}`);
    return saved;
  }
}
