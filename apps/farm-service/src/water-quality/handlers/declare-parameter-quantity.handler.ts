/**
 * DeclareParameterQuantityHandler / ClearParameterQuantityHandler
 *
 * Say which measured quantity a parameter records, or clear the declaration
 * so the code's own meaning stands (FARM-MEDIUM-374). Both go through the one
 * writer, writeDeclaredQuantity.
 *
 * @module WaterQuality/Handlers
 */
import { parseQuantityId } from '@aquaculture/shared-contracts';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';

import { AuditLogService } from '../../database/services/audit-log.service';
import {
  ClearParameterQuantityCommand,
  DeclareParameterQuantityCommand,
} from '../commands/declare-parameter-quantity.command';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';
import { ParameterConfigCacheService } from '../services/parameter-config-cache.service';
import { writeDeclaredQuantity } from '../services/parameter-quantity-writer';
import { runSourceTransaction } from '../services/source-transaction';

@Injectable()
@CommandHandler(DeclareParameterQuantityCommand)
export class DeclareParameterQuantityHandler
  implements ICommandHandler<DeclareParameterQuantityCommand, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(DeclareParameterQuantityHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: DeclareParameterQuantityCommand): Promise<WaterQualityParameterConfig> {
    const { tenantId, parameterConfigId, userId } = command;
    const quantity = parseQuantityId(command.quantity);
    if (quantity === null) {
      throw new BadRequestException(`'${command.quantity}' is not a measured quantity`);
    }
    const config = await runSourceTransaction(this.dataSource, tenantId, (queryRunner) =>
      writeDeclaredQuantity(queryRunner.manager, this.auditLog, {
        tenantId,
        userId,
        parameterConfigId,
        quantity,
      }),
    );
    this.configCache.invalidate(tenantId);
    this.logger.log(
      JSON.stringify({
        event: 'parameter_quantity_declared',
        tenantId,
        parameterConfigId,
        quantity,
      }),
    );
    return config;
  }
}

@Injectable()
@CommandHandler(ClearParameterQuantityCommand)
export class ClearParameterQuantityHandler
  implements ICommandHandler<ClearParameterQuantityCommand, WaterQualityParameterConfig>
{
  private readonly logger = new Logger(ClearParameterQuantityHandler.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly auditLog: AuditLogService,
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  async execute(command: ClearParameterQuantityCommand): Promise<WaterQualityParameterConfig> {
    const { tenantId, parameterConfigId, userId } = command;
    const config = await runSourceTransaction(this.dataSource, tenantId, (queryRunner) =>
      writeDeclaredQuantity(queryRunner.manager, this.auditLog, {
        tenantId,
        userId,
        parameterConfigId,
        quantity: null,
      }),
    );
    this.configCache.invalidate(tenantId);
    this.logger.log(
      JSON.stringify({ event: 'parameter_quantity_cleared', tenantId, parameterConfigId }),
    );
    return config;
  }
}
