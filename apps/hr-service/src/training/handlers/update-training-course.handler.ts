import { Logger, NotFoundException } from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UpdateTrainingCourseCommand } from '../commands/update-training-course.command';
import { TrainingCourse } from '../entities/training-course.entity';

@CommandHandler(UpdateTrainingCourseCommand)
export class UpdateTrainingCourseHandler
  implements ICommandHandler<UpdateTrainingCourseCommand>
{
  private readonly logger = new Logger(UpdateTrainingCourseHandler.name);

  constructor(
    @InjectRepository(TrainingCourse)
    private readonly courseRepository: Repository<TrainingCourse>,
  ) {}

  async execute(command: UpdateTrainingCourseCommand): Promise<TrainingCourse> {
    const { tenantId, userId, input } = command;
    const { id, ...patch } = input;

    const course = await this.courseRepository.findOne({
      where: { id, tenantId, isDeleted: false },
    });
    if (!course) {
      throw new NotFoundException(`Training course with ID ${id} not found`);
    }

    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        Reflect.set(course, key, value);
      }
    }
    course.updatedBy = userId;

    const saved = await this.courseRepository.save(course);
    this.logger.log(`Training course ${saved.id} updated for tenant ${tenantId}`);
    return saved;
  }
}
