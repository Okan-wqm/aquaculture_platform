import { Injectable, NotFoundException, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner, Not } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { UpdateEmployeeCommand } from '../commands/update-employee.command';
import { Employee } from '../entities/employee.entity';
import { createEmployeeUpdatedEvent, createEmployeeTerminatedEvent } from '../events/hr.events';
import { EmployeeStatus } from '../entities/employee.entity';

@Injectable()
@CommandHandler(UpdateEmployeeCommand)
export class UpdateEmployeeHandler implements ICommandHandler<UpdateEmployeeCommand, Employee> {
  private readonly logger = new Logger(UpdateEmployeeHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateEmployeeCommand): Promise<Employee> {
    const { tenantId, input, userId } = command;

    // Create a query runner for transaction management
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const employeeRepo = queryRunner.manager.getRepository(Employee);

      const employee = await employeeRepo.findOne({
        where: { id: input.id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!employee) {
        throw new NotFoundException(`Employee with id ${input.id} not found`);
      }

      // Check for email conflict if email is being updated
      if (input.email && input.email !== employee.email) {
        const existingByEmail = await employeeRepo.findOne({
          where: { tenantId, email: input.email, id: Not(input.id) },
        });

        if (existingByEmail) {
          throw new ConflictException('An employee with this email already exists');
        }
      }

      // Update fields - extract and convert properly
      const { id: _id, dateOfBirth, hireDate, terminationDate, ...restInput } = input;

      const updateData: Partial<Employee> = {
        ...restInput,
        updatedBy: userId,
      };

      // Handle date conversions with validation
      if (dateOfBirth) {
        const parsedDateOfBirth = new Date(dateOfBirth);
        if (isNaN(parsedDateOfBirth.getTime())) {
          throw new ConflictException('Invalid date of birth');
        }
        if (parsedDateOfBirth > new Date()) {
          throw new ConflictException('Date of birth cannot be in the future');
        }
        updateData.dateOfBirth = parsedDateOfBirth;
      }
      if (hireDate) {
        const parsedHireDate = new Date(hireDate);
        if (isNaN(parsedHireDate.getTime())) {
          throw new ConflictException('Invalid hire date');
        }
        if (parsedHireDate > new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)) {
          throw new ConflictException('Hire date cannot be more than 1 year in the future');
        }
        updateData.hireDate = parsedHireDate;
      }
      if (terminationDate) {
        const parsedTerminationDate = new Date(terminationDate);
        if (isNaN(parsedTerminationDate.getTime())) {
          throw new ConflictException('Invalid termination date');
        }
        updateData.terminationDate = parsedTerminationDate;
      }

      // Capture original status before Object.assign mutates the entity.
      // Used below to detect status TRANSITIONS (e.g., ACTIVE → TERMINATED).
      const statusBeforeUpdate = employee.status;

      Object.assign(employee, updateData);

      const savedEmployee = await employeeRepo.save(employee);

      // CRITICAL-002 fix: Enqueue events into transactional outbox BEFORE commit.
      // Previously eventBus.publish() was called AFTER commit — fire-and-forget.
      // Now the outbox INSERT joins the same transaction as the domain write.
      const employeeUpdatedEvent = createEmployeeUpdatedEvent(savedEmployee, userId);
      await this.outboxPublisher.enqueue(employeeUpdatedEvent, queryRunner.manager);

      // Publish EmployeeTerminatedEvent only when status CHANGES to TERMINATED.
      // statusBeforeUpdate was captured before Object.assign — it holds the original value.
      if (savedEmployee.status === EmployeeStatus.TERMINATED &&
          statusBeforeUpdate !== EmployeeStatus.TERMINATED) {
        const terminatedEvent = createEmployeeTerminatedEvent(
          savedEmployee,
          savedEmployee.terminationDate ?? new Date(),
          undefined,
          userId,
        );
        await this.outboxPublisher.enqueue(terminatedEvent, queryRunner.manager);
      }

      // Commit transaction (domain write + outbox rows are atomic)
      await queryRunner.commitTransaction();

      this.logger.log(
        `Employee updated: ${savedEmployee.id} (${savedEmployee.employeeNumber}) for tenant ${tenantId}`,
      );

      return savedEmployee;
    } catch (error) {
      // Rollback transaction on error
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof ConflictException) {
        throw error;
      }

      this.logger.error(
        `Failed to update employee ${input.id} for tenant ${tenantId}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update employee');
    } finally {
      // Release the query runner
      await queryRunner.release();
    }
  }
}
