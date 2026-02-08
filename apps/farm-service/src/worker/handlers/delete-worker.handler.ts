import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, Logger } from '@nestjs/common';
import { DeleteWorkerCommand } from '../commands/delete-worker.command';
import { Worker } from '../entities/worker.entity';

@CommandHandler(DeleteWorkerCommand)
export class DeleteWorkerHandler implements ICommandHandler<DeleteWorkerCommand> {
  private readonly logger = new Logger(DeleteWorkerHandler.name);

  constructor(
    @InjectRepository(Worker)
    private readonly workerRepository: Repository<Worker>,
  ) {}

  async execute(command: DeleteWorkerCommand): Promise<boolean> {
    const { workerId, tenantId, userId } = command;

    this.logger.log(`Deleting worker ${workerId} for tenant ${tenantId}`);

    const worker = await this.workerRepository.findOne({
      where: { id: workerId, tenantId },
    });

    if (!worker) {
      throw new NotFoundException(`Worker with ID "${workerId}" not found`);
    }

    worker.isDeleted = true;
    await this.workerRepository.save(worker);

    this.logger.log(`Worker ${workerId} marked as deleted`);
    return true;
  }
}
