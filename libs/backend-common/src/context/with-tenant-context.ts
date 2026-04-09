import { requestContextStorage, RequestContext } from '../logging/request-context';
import { getTenantSchemaName } from '../database/tenant-schema.utils';
import { isValidUUID } from '../database/tenant-schema.utils';

/**
 * Execute an async function within a tenant context.
 *
 * MQTT handlers, cron jobs, NATS event handlers, and any non-HTTP execution
 * path lack the AsyncLocalStorage context that HTTP middleware establishes.
 * Without this context, TenantConnectionBootstrap's pool patch defaults to
 * the source schema (e.g., `sensor, public`), and queries may read/write
 * data in the wrong schema.
 *
 * This function wraps `AsyncLocalStorage.run()` to establish a tenant context
 * that TenantConnectionBootstrap can read during pool connection checkout.
 * Any `dataSource.getRepository()` or `queryRunner.manager` call inside `fn`
 * will automatically get the correct `SET search_path TO "tenant_xxx", <src>, public`.
 *
 * @example
 * ```typescript
 * // In an MQTT handler:
 * await withTenantContext(tenantId, async () => {
 *   await this.dataSource.getRepository(DeviceEvent).save(events);
 * });
 *
 * // In a cron job iterating tenants:
 * for (const tenantId of tenantIds) {
 *   await withTenantContext(tenantId, async () => {
 *     await processScheduledFeedings(tenantId);
 *   });
 * }
 * ```
 *
 * @param tenantId - UUID v4 of the tenant
 * @param fn - Async function to execute within the tenant context
 * @param options - Optional overrides (bypassRls, correlationId)
 * @returns The return value of `fn`
 * @throws If tenantId is not a valid UUID v4
 */
export async function withTenantContext<T>(
  tenantId: string,
  fn: () => Promise<T>,
  options?: {
    /** Set to true for admin/worker paths that need cross-tenant visibility */
    bypassRls?: boolean;
    /** Correlation ID for distributed tracing */
    correlationId?: string;
  },
): Promise<T> {
  if (!isValidUUID(tenantId)) {
    throw new Error(`withTenantContext: invalid tenantId "${tenantId}" — must be UUID v4`);
  }

  const schemaName = getTenantSchemaName(tenantId);

  const context: RequestContext = {
    tenantId,
    schemaName,
    bypassRls: options?.bypassRls,
    correlationId: options?.correlationId,
  };

  return requestContextStorage.run(context, fn);
}
