import { runInTenantTransaction } from '@aquaculture/backend-common/database';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { ConflictException, Logger } from '@nestjs/common';
import { CreateWorkerCommand } from '../commands/create-worker.command';
import { Worker, workerEmailBlindIndex } from '../entities/worker.entity';

@CommandHandler(CreateWorkerCommand)
export class CreateWorkerHandler implements ICommandHandler<CreateWorkerCommand, Worker> {
  private readonly logger = new Logger(CreateWorkerHandler.name);

  constructor(
    @InjectRepository(Worker)
    private readonly workerRepository: Repository<Worker>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateWorkerCommand): Promise<Worker> {
    const { input, tenantId, userId } = command;

    this.logger.log(`Creating worker for tenant ${tenantId}`);

    // Check for duplicate email within tenant. The email column is encrypted
    // (non-deterministic GCM), so equality must go through the deterministic
    // blind index, which also backs the (tenantId, emailHash) UNIQUE constraint.
    const existingByEmail = await this.workerRepository.findOne({
      where: { tenantId, emailHash: workerEmailBlindIndex(input.email) },
    });
    if (existingByEmail) {
      throw new ConflictException(`Employee with email "${input.email}" already exists`);
    }

    // Generate employee number with transaction + lock
    const saved = await runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      // Get current year
      const year = new Date().getFullYear();
      const prefix = `EMP-${year}-`;

      // Find max employee number for this pattern
      const result = await queryRunner.query(
        `SELECT "employeeNumber" FROM farm_workers WHERE "tenantId" = $1 AND "employeeNumber" LIKE $2 ORDER BY "employeeNumber" DESC LIMIT 1 FOR UPDATE`,
        [tenantId, `${prefix}%`],
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

      const worker = queryRunner.manager.create(Worker, {
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
        dateOfBirth: '1990-01-01',
        nationalId: '-',
        status: 'active',
        employmentType: 'full_time',
        department: 'operations',
        position: input.position,
        isVeterinarian: input.isVeterinarian ?? false,
        veterinaryLicenseNumber: input.veterinaryLicenseNumber,
        hireDate: now,
        baseSalary: 0,
        currency: 'TRY',
        isFarmWorker: true,
        createdBy: userId,
      });

      return queryRunner.manager.save(worker);
    });

    this.logger.log(`Worker created: id=${saved.id} number=${saved.employeeNumber} (tenant ${tenantId})`);
    return saved;
  }
}
