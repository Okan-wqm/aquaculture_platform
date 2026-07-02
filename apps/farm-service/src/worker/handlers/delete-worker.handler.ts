import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NotFoundException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { DeleteWorkerCommand } from '../commands/delete-worker.command';
import { Worker } from '../entities/worker.entity';

@CommandHandler(DeleteWorkerCommand)
export class DeleteWorkerHandler implements ICommandHandler<DeleteWorkerCommand, boolean> {
  private readonly logger = new Logger(DeleteWorkerHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeleteWorkerCommand): Promise<boolean> {
    const { workerId, tenantId, userId } = command;

    this.logger.log(`Deleting worker ${workerId} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const workerRepo = tenantManagerRepo(queryRunner.manager, Worker, tenantId);

      const worker = await workerRepo.findOne({
        where: { id: workerId, tenantId },
      });

      if (!worker) {
        throw new NotFoundException(`Worker with ID "${workerId}" not found`);
      }

      worker.isDeleted = true;
      await workerRepo.save(worker);

      this.logger.log(`Worker ${workerId} marked as deleted`);
      return true;
    });
  }
}
