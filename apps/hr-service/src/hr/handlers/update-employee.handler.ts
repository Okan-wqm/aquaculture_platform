import { Injectable, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { UpdateEmployeeCommand } from '../commands/update-employee.command';
import { Employee } from '../entities/employee.entity';

@Injectable()
@CommandHandler(UpdateEmployeeCommand)
export class UpdateEmployeeHandler implements ICommandHandler<UpdateEmployeeCommand, Employee> {
  private readonly logger = new Logger(UpdateEmployeeHandler.name);

  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(command: UpdateEmployeeCommand): Promise<Employee> {
    const { tenantId, input, userId } = command;

    const employee = await this.employeeRepository.findOne({
      where: { id: input.id, tenantId },
    });

    if (!employee) {
      throw new NotFoundException(`Employee with id ${input.id} not found`);
    }

    // Check for email conflict if email is being updated
    if (input.email && input.email !== employee.email) {
      const existingByEmail = await this.employeeRepository.findOne({
        where: { tenantId, email: input.email, id: Not(input.id) },
      });

      if (existingByEmail) {
        throw new ConflictException(`Employee with email ${input.email} already exists`);
      }
    }

    // Update fields - extract and convert properly
    const { id: _id, dateOfBirth, hireDate, terminationDate, ...restInput } = input;

    const updateData: Partial<Employee> = {
      ...restInput,
      updatedBy: userId,
    };

    // Handle date conversions
    if (dateOfBirth) {
      updateData.dateOfBirth = new Date(dateOfBirth);
    }
    if (hireDate) {
      updateData.hireDate = new Date(hireDate);
    }
    if (terminationDate) {
      updateData.terminationDate = new Date(terminationDate);
    }

    Object.assign(employee, updateData);

    const savedEmployee = await this.employeeRepository.save(employee);

    this.logger.log(
      `Employee updated: ${savedEmployee.id} (${savedEmployee.employeeNumber}) for tenant ${tenantId}`,
    );

    return savedEmployee;
  }
}
