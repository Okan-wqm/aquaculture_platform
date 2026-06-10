import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UpdateTenantCommand } from '../commands/tenant.commands';
import { Tenant } from '../entities/tenant.entity';

@Injectable()
@CommandHandler(UpdateTenantCommand)
export class UpdateTenantHandler
  implements ICommandHandler<UpdateTenantCommand, Tenant>
{
  private readonly logger = new Logger(UpdateTenantHandler.name);

  constructor(
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  async execute(command: UpdateTenantCommand): Promise<Tenant> {
    const { tenantId, data, updatedBy } = command;

    const tenant = await this.tenantRepository.findOne({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant with ID '${tenantId}' not found`);
    }

    if (Object.keys(data).length === 0) {
      return tenant;
    }

    this.logger.warn(
      `Rejected admin-api tenant update for ${tenantId} by ${updatedBy}; auth-owned tenant mutations must use owner command receipts`,
    );
    throw new BadRequestException(
      'Tenant updates are owner-service-owned. Use an auth tenant command/read facade or admin projection for editable fields.',
    );
  }
}
