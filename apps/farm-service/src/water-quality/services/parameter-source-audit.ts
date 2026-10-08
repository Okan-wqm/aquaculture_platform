import type { EntityManager } from 'typeorm';

import { AuditAction } from '../../database/entities/audit-log.entity';
import type { AuditLogService } from '../../database/services/audit-log.service';
import type { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import type { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

import { pointOf } from './parameter-sources';

/**
 * Audit rows of the binding commands, written in their transaction
 * (AuditLogService.logWithManager), so a source change and its record commit
 * or roll back together. The source rows keep their own history (boundAt /
 * unboundAt) beyond the audit log's retention; this records who asked for
 * what, with the before/after the operator saw.
 */
export type SourceOperation =
  | 'bindParameterChannel'
  | 'unbindParameterChannel'
  | 'promoteParameterChannel'
  | 'replaceParameterChannel';

export type QuantityOperation = 'declareParameterQuantity' | 'clearParameterQuantity';

export function sourceSnapshot(source: WaterQualityParamEquipment): Record<string, unknown> {
  return {
    id: source.id,
    parameterConfigId: source.parameterConfigId,
    point: pointOf(source),
    position: source.position,
    depthM: source.depthM,
    sensorId: source.sensorId,
    channelKey: source.channelKey,
    priority: source.priority,
    boundAt: source.boundAt,
    unboundAt: source.unboundAt,
  };
}

export async function auditSourceChange(
  auditLog: AuditLogService,
  manager: EntityManager,
  change: {
    tenantId: string;
    userId: string;
    operation: SourceOperation;
    action: AuditAction;
    before: WaterQualityParamEquipment | null;
    after: WaterQualityParamEquipment;
  },
): Promise<void> {
  await auditLog.logWithManager(manager, {
    tenantId: change.tenantId,
    entityType: 'WaterQualityParamEquipment',
    entityId: change.after.id,
    action: change.action,
    userId: change.userId,
    changes: {
      ...(change.before === null ? {} : { before: sourceSnapshot(change.before) }),
      after: sourceSnapshot(change.after),
    },
    metadata: { source: `parameter-sources:${change.operation}` },
    summary: `${change.operation}: ${change.after.channelKey} of sensor ${change.after.sensorId}`,
  });
}

export async function auditQuantityChange(
  auditLog: AuditLogService,
  manager: EntityManager,
  change: {
    tenantId: string;
    userId: string;
    operation: QuantityOperation;
    /** Read before the change: the config object itself is mutated by it. */
    before: Pick<WaterQualityParameterConfig, 'declaredQuantity' | 'effectiveQuantity'>;
    after: WaterQualityParameterConfig;
  },
): Promise<void> {
  await auditLog.logWithManager(manager, {
    tenantId: change.tenantId,
    entityType: 'WaterQualityParameterConfig',
    entityId: change.after.id,
    action: AuditAction.UPDATE,
    userId: change.userId,
    changes: {
      before: {
        declaredQuantity: change.before.declaredQuantity,
        quantity: change.before.effectiveQuantity,
      },
      after: {
        declaredQuantity: change.after.declaredQuantity,
        quantity: change.after.effectiveQuantity,
      },
      changedFields: ['declaredQuantity'],
    },
    metadata: { source: `parameter-quantities:${change.operation}` },
    summary: `${change.operation} ${change.after.code}: ${change.after.declaredQuantity ?? 'none'}`,
  });
}
