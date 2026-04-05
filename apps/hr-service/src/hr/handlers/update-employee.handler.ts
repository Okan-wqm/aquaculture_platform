import { Injectable, NotFoundException, ConflictException, Logger, InternalServerErrorException } from '@nestjs/common';
import { DataSource, QueryRunner, Not } from 'typeorm';
import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
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
    private readonly eventBus: EventBus,
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

      // Commit transaction
      await queryRunner.commitTransaction();

      this.logger.log(
        `Employee updated: ${savedEmployee.id} (${savedEmployee.employeeNumber}) for tenant ${tenantId}`,
      );

      // Publish EmployeeUpdatedEvent AFTER commit.
      // BEFORE this fix: no event was published — cross-service caches (sensor assignments,
      // messaging profiles) were never invalidated when employee data changed.
      this.eventBus.publish(createEmployeeUpdatedEvent(savedEmployee, userId)).catch((err: unknown) => {
        this.logger.error(
          `Failed to publish EmployeeUpdatedEvent for ${savedEmployee.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });

      // Publish EmployeeTerminatedEvent only when status CHANGES to TERMINATED.
      // Bug fix: checking savedEmployee.status === TERMINATED without checking prior state
      // would fire the event on ANY update to an already-terminated employee
      // (e.g., correcting their termination date after the fact).
      // The pre-update employee object (before Object.assign) holds the original status.
      // We capture it as statusBeforeUpdate from the employee loaded at the start.
      // Only fire TerminatedEvent when status TRANSITIONS to TERMINATED.
      // statusBeforeUpdate was captured before Object.assign — it holds the original value.
      if (savedEmployee.status === EmployeeStatus.TERMINATED &&
          statusBeforeUpdate !== EmployeeStatus.TERMINATED) {
        this.eventBus.publish(
          createEmployeeTerminatedEvent(
            savedEmployee,
            savedEmployee.terminationDate ?? new Date(),
            undefined,
            userId,
          ),
        ).catch((err: unknown) => {
          this.logger.error(
            `Failed to publish EmployeeTerminatedEvent for ${savedEmployee.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }

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
