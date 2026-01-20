import { Injectable, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { CreateEmployeeCommand } from '../commands/create-employee.command';
import { Employee } from '../entities/employee.entity';

@Injectable()
@CommandHandler(CreateEmployeeCommand)
export class CreateEmployeeHandler implements ICommandHandler<CreateEmployeeCommand, Employee> {
  private readonly logger = new Logger(CreateEmployeeHandler.name);

  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateEmployeeCommand): Promise<Employee> {
    const { tenantId, input, userId } = command;

    // Create a query runner for transaction management
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const employeeRepo = queryRunner.manager.getRepository(Employee);

      // Check for existing employee with same email (within transaction)
      const existingByEmail = await employeeRepo.findOne({
        where: { tenantId, email: input.email.toLowerCase().trim() },
        lock: { mode: 'pessimistic_read' },
      });

      if (existingByEmail) {
        throw new ConflictException(`Employee with email ${input.email} already exists`);
      }

      // Generate employee number with pessimistic lock to prevent race conditions
      const employeeNumber = await this.generateEmployeeNumber(tenantId, queryRunner);

      // Validate dates
      const dateOfBirth = new Date(input.dateOfBirth);
      const hireDate = new Date(input.hireDate);

      if (isNaN(dateOfBirth.getTime())) {
        throw new ConflictException('Invalid date of birth');
      }
      if (isNaN(hireDate.getTime())) {
        throw new ConflictException('Invalid hire date');
      }
      if (dateOfBirth > new Date()) {
        throw new ConflictException('Date of birth cannot be in the future');
      }
      if (hireDate > new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)) {
        throw new ConflictException('Hire date cannot be more than 1 year in the future');
      }

      // Create employee entity
      const employee = employeeRepo.create({
        ...input,
        tenantId,
        employeeNumber,
        dateOfBirth,
        hireDate,
        currency: input.currency || 'USD',
        createdBy: userId,
        updatedBy: userId,
      });

      const savedEmployee = await employeeRepo.save(employee);

      // Commit transaction
      await queryRunner.commitTransaction();

      this.logger.log(
        `Employee created: ${savedEmployee.id} (${savedEmployee.employeeNumber}) for tenant ${tenantId} by user ${userId}`,
      );

      return savedEmployee;
    } catch (error) {
      // Rollback transaction on error
      await queryRunner.rollbackTransaction();

      if (error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to create employee for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create employee');
    } finally {
      // Release the query runner
      await queryRunner.release();
    }
  }

  private async generateEmployeeNumber(tenantId: string, queryRunner: QueryRunner): Promise<string> {
    // Use a lock to prevent race conditions when generating employee numbers
    const result = await queryRunner.manager
      .createQueryBuilder(Employee, 'e')
      .where('e.tenantId = :tenantId', { tenantId })
      .setLock('pessimistic_write')
      .getCount();

    const year = new Date().getFullYear();
    const sequence = String(result + 1).padStart(5, '0');
    return `EMP-${year}-${sequence}`;
  }
}
