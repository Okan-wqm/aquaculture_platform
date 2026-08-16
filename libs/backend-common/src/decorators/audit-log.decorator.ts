import { SetMetadata } from '@nestjs/common';
import type { CustomDecorator } from '@nestjs/common';

/**
 * Metadata key for the AuditLog decorator
 */
export const AUDIT_LOG_KEY = 'audit_log';

/**
 * Options for the @AuditLog() decorator
 */
export interface AuditLogOptions {
  /**
   * Action identifier, e.g. 'CREATE_FARM', 'UPDATE_BATCH', 'DELETE_EQUIPMENT'
   */
  action: string;

  /**
   * Resource/entity type, e.g. 'Farm', 'Batch', 'Equipment'
   */
  resource: string;

  /**
   * Optional human-readable description of the operation
   */
  description?: string;
}

/**
 * AuditLog Decorator
 *
 * Marks a resolver/controller method for automatic audit logging.
 * Works together with AuditLogInterceptor to capture mutations and
 * persist audit trail entries.
 *
 * @example
 * ```ts
 * @AuditLog({ action: 'CREATE_FARM', resource: 'Farm', description: 'Create a new farm' })
 * @Mutation(() => Farm)
 * async createFarm(@Args('input') input: CreateFarmInput) { ... }
 * ```
 */
export const AuditLog = (options: AuditLogOptions): CustomDecorator<string> =>
  SetMetadata(AUDIT_LOG_KEY, options);
