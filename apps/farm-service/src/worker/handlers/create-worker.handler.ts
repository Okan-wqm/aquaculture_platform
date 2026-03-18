import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import { CreateWorkerCommand } from '../commands/create-worker.command';
import { Worker } from '../entities/worker.entity';

@CommandHandler(CreateWorkerCommand)
export class CreateWorkerHandler implements ICommandHandler<CreateWorkerCommand> {
  private readonly logger = new Logger(CreateWorkerHandler.name);

  constructor(
    @InjectRepository(Worker)
    private readonly workerRepository: Repository<Worker>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateWorkerCommand): Promise<Worker> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating worker "${input.firstName} ${input.lastName}" for tenant ${tenantId}`);

    // Check for duplicate email within tenant
    const existingByEmail = await this.workerRepository.findOne({
      where: { tenantId, email: input.email.toLowerCase().trim() },
    });
    if (existingByEmail) {
      throw new ConflictException(`Employee with email "${input.email}" already exists`);
    }

    // Generate employee number with transaction + lock
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get current year
      const year = new Date().getFullYear();
      const prefix = `EMP-${year}-`;

      // Find max employee number for this pattern
      const result = await queryRunner.query(
        `SELECT "employeeNumber" FROM farm_workers WHERE "employeeNumber" LIKE $1 ORDER BY "employeeNumber" DESC LIMIT 1 FOR UPDATE`,
        [`${prefix}%`],
      );

      let nextNumber = 1;
      if (result.length > 0) {
        const lastNumber = result[0].employeeNumber;
        const numPart = parseInt(lastNumber.replace(prefix, ''), 10);
        if (!isNaN(numPart)) {
          nextNumber = numPart + 1;
        }
      }

      const employeeNumber = `${prefix}${String(nextNumber).padStart(5, '0')}`;
      const now = new Date();

      const worker = this.workerRepository.create({
        tenantId,
        employeeNumber,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        email: input.email.toLowerCase().trim(),
        contactInfo: {
          email: input.email.toLowerCase().trim(),
          phone: input.phone || '',
        },
        address: {
          street: '-',
          city: '-',
          state: '-',
          postalCode: '-',
          country: 'TR',
        },
        dateOfBirth: new Date('1990-01-01'),
        nationalId: '-',
        status: 'active',
        employmentType: 'full_time',
        department: 'operations',
        position: input.position,
        hireDate: now,
        baseSalary: 0,
        currency: 'TRY',
        isFarmWorker: true,
        createdBy: userId,
      });

      const saved = await queryRunner.manager.save(worker);
      await queryRunner.commitTransaction();

      this.logger.log(`Worker "${saved.firstName} ${saved.lastName}" created with ID ${saved.id}, number ${saved.employeeNumber}`);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
