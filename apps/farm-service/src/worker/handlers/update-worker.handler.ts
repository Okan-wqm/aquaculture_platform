import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { UpdateWorkerCommand } from '../commands/update-worker.command';
import { Worker } from '../entities/worker.entity';

@CommandHandler(UpdateWorkerCommand)
export class UpdateWorkerHandler implements ICommandHandler<UpdateWorkerCommand, Worker> {
  private readonly logger = new Logger(UpdateWorkerHandler.name);

  constructor(
    @InjectRepository(Worker)
    private readonly workerRepository: Repository<Worker>,
  ) {}

  async execute(command: UpdateWorkerCommand): Promise<Worker> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Updating worker ${input.id} for tenant ${tenantId}`);

    const worker = await this.workerRepository.findOne({
      where: { id: input.id, tenantId },
    });

    if (!worker) {
      throw new NotFoundException(`Worker with ID "${input.id}" not found`);
    }

    // Check email uniqueness if changing
    if (input.email && input.email.toLowerCase().trim() !== worker.email) {
      const existingByEmail = await this.workerRepository.findOne({
        where: { tenantId, email: input.email.toLowerCase().trim() },
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

    const updated = await this.workerRepository.save(worker);

    this.logger.log(`Worker ${input.id} updated successfully`);
    return updated;
  }
}
