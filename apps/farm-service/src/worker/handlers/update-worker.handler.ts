import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { UpdateWorkerCommand } from '../commands/update-worker.command';
import { Worker, workerEmailBlindIndex } from '../entities/worker.entity';

@CommandHandler(UpdateWorkerCommand)
export class UpdateWorkerHandler implements ICommandHandler<UpdateWorkerCommand, Worker> {
  private readonly logger = new Logger(UpdateWorkerHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateWorkerCommand): Promise<Worker> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Updating worker ${input.id} for tenant ${tenantId}`);

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const workerRepo = tenantManagerRepo(queryRunner.manager, Worker, tenantId);

      const worker = await workerRepo.findOne({
        where: { id: input.id, tenantId },
      });

      if (!worker) {
        throw new NotFoundException(`Worker with ID "${input.id}" not found`);
      }

      // Check email uniqueness if changing. The email column is encrypted
      // (non-deterministic GCM), so equality must go through the deterministic
      // blind index, which also backs the (tenantId, emailHash) UNIQUE constraint.
      if (input.email && input.email.toLowerCase().trim() !== worker.email) {
        const existingByEmail = await workerRepo.findOne({
          where: { tenantId, emailHash: workerEmailBlindIndex(input.email) },
        });
        if (existingByEmail && existingByEmail.id !== worker.id) {
          throw new ConflictException(`Employee with email "${input.email}" already exists`);
        }
      }

      if (input.firstName !== undefined) worker.firstName = input.firstName.trim();
      if (input.lastName !== undefined) worker.lastName = input.lastName.trim();
      if (input.email !== undefined) {
        worker.email = input.email.toLowerCase().trim();
        worker.contactInfo = { ...worker.contactInfo, email: worker.email };
      }
      if (input.phone !== undefined) {
        worker.contactInfo = { ...worker.contactInfo, phone: input.phone };
      }
      if (input.position !== undefined) worker.position = input.position;
      if (input.isVeterinarian !== undefined) worker.isVeterinarian = input.isVeterinarian;
      if (input.veterinaryLicenseNumber !== undefined)
        worker.veterinaryLicenseNumber = input.veterinaryLicenseNumber;

      const updated = await workerRepo.save(worker);

      this.logger.log(`Worker ${input.id} updated successfully`);
      return updated;
    });
  }
}
