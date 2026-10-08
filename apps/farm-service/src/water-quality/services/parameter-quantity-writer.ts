import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { measuredQuantity, type QuantityId, unitConversion } from '@aquaculture/shared-contracts';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { AuditLogService } from '../../database/services/audit-log.service';
import { declarableQuantitiesOfParameter } from '../data/parameter-quantities';
import {
  ParameterQuantityDeclaration,
  ParameterQuantityDeclarationReason,
} from '../entities/parameter-quantity-declaration.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

import { auditQuantityChange } from './parameter-source-audit';
import { liveChannelSourceCount, lockParameterConfig } from './parameter-sources';

/**
 * The one writer of a parameter's declared quantity (FARM-MEDIUM-374), shared
 * by declare and clear. In the caller's tenant transaction:
 *
 * - the parameter row FOR UPDATE (as every binding write takes it);
 * - a declaration must be one the code allows and must fit the parameter's
 *   unit (a convertible unit of the quantity), else 400;
 * - no change while a channel source is bound (plan Q8): a bound channel was
 *   accepted for the old meaning — unbind it first, then rebind;
 * - the config saves (its effective quantity derives on save; the database
 *   refuses a second active config of one quantity — 409 via the source
 *   transaction; the trigger stamps quantityConfiguredAt);
 * - the declaration ledger and the audit log record it.
 *
 * Declaring what is already declared, or clearing nothing, changes nothing.
 */
export async function writeDeclaredQuantity(
  manager: EntityManager,
  auditLog: AuditLogService,
  change: {
    tenantId: string;
    userId: string;
    parameterConfigId: string;
    quantity: QuantityId | null;
  },
): Promise<WaterQualityParameterConfig> {
  const { tenantId, userId, parameterConfigId, quantity } = change;
  const config = await lockParameterConfig(manager, tenantId, parameterConfigId);
  if (config.declaredQuantity === quantity) {
    return config;
  }
  if (!config.isActive) {
    throw new ConflictException('The parameter is deactivated; activate it before declaring');
  }
  if (quantity !== null) {
    if (!declarableQuantitiesOfParameter(config.code).includes(quantity)) {
      throw new BadRequestException(
        `A '${config.code}' parameter cannot record ${quantity}; it may record ` +
          declarableQuantitiesOfParameter(config.code).join(', '),
      );
    }
    if (unitConversion(quantity, config.unit) === null) {
      throw new BadRequestException(
        `The parameter's unit '${config.unit}' is not a unit of ${quantity} ` +
          `(${measuredQuantity(quantity).unit}); change the unit first`,
      );
    }
  }
  if ((await liveChannelSourceCount(manager, tenantId, config.id)) > 0) {
    throw new ConflictException(
      'A sensor channel is bound to this parameter; unbind it before changing what it records',
    );
  }

  const before = {
    declaredQuantity: config.declaredQuantity,
    effectiveQuantity: config.effectiveQuantity,
  };
  config.declaredQuantity = quantity;
  const configs = tenantManagerRepo(manager, WaterQualityParameterConfig, tenantId);
  await configs.save(config);
  await tenantManagerRepo(manager, ParameterQuantityDeclaration, tenantId).save({
    tenantId,
    parameterConfigId: config.id,
    code: config.code,
    quantity,
    unit: config.unit,
    reason:
      quantity === null
        ? ParameterQuantityDeclarationReason.CLEARED
        : ParameterQuantityDeclarationReason.DECLARED,
    declaredBy: userId,
  });
  // Re-read: the trigger stamped quantityConfiguredAt in the database.
  const after = await configs.findOneOrFail({ where: { id: config.id } });
  await auditQuantityChange(auditLog, manager, {
    tenantId,
    userId,
    operation: quantity === null ? 'clearParameterQuantity' : 'declareParameterQuantity',
    before,
    after,
  });
  return after;
}
