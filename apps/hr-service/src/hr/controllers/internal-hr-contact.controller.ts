import { Public } from '@aquaculture/backend-common/decorators';
import type { TenantRequest } from '@aquaculture/backend-common/types';
import { Controller, ForbiddenException, Get, NotFoundException, Param, Req } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Employee } from '../entities/employee.entity';

type HrNotificationContactKind = 'employee.email' | 'manager.email';

@Public()
@Controller('internal/notification-contacts')
export class InternalHrContactController {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  @Get(':ref')
  async resolveNotificationContact(
    @Param('ref') ref: string,
    @Req() request: TenantRequest,
  ): Promise<{ email: string; contactRef: string }> {
    const tenantId = this.requireNotificationService(request);
    const decodedRef = decodeURIComponent(ref);
    const { kind, employeeId } = this.parseContactRef(decodedRef);

    const employee = await this.employeeRepository.findOne({
      where: { id: employeeId, tenantId, isDeleted: false },
    });
    if (!employee) {
      throw new NotFoundException('HR notification contact not found');
    }

    if (kind === 'employee.email') {
      return this.emailContact(decodedRef, employee);
    }

    const managerId = employee.supervisorId;
    if (!managerId) {
      throw new NotFoundException('HR manager contact not found');
    }
    const manager = await this.employeeRepository.findOne({
      where: { id: managerId, tenantId, isDeleted: false },
    });
    if (!manager) {
      throw new NotFoundException('HR manager contact not found');
    }
    return this.emailContact(decodedRef, manager);
  }

  private parseContactRef(ref: string): { kind: HrNotificationContactKind; employeeId: string } {
    const match = /^hr\.(employee|manager)\.email:([A-Za-z0-9_-]+)$/.exec(ref);
    if (!match) {
      throw new NotFoundException('Unsupported HR notification contact ref');
    }
    const [, kind, employeeId] = match;
    if ((kind !== 'employee' && kind !== 'manager') || !employeeId) {
      throw new NotFoundException('Unsupported HR notification contact ref');
    }
    return {
      kind: `${kind}.email` as HrNotificationContactKind,
      employeeId,
    };
  }

  private emailContact(
    contactRef: string,
    employee: Employee,
  ): { email: string; contactRef: string } {
    if (!employee.email) {
      throw new NotFoundException('HR notification contact has no email');
    }
    return { email: employee.email, contactRef };
  }

  private requireNotificationService(request: TenantRequest): string {
    const identity = request.verifiedIdentity;
    if (!identity || identity.serviceName !== 'notification-service') {
      throw new ForbiddenException('Internal notification-service identity is required');
    }
    if (!identity.tenantId) {
      throw new ForbiddenException('Tenant-bound notification contact resolution is required');
    }
    return identity.tenantId;
  }
}
