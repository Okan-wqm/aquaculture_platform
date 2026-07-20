/**
 * SensorReadingResolver — Apollo Federation entity owner.
 *
 * Phase S1.2 of the Scope B sensor↔farm federation plan. This is the
 * resolver class that "owns" the federated `SensorReading` type in
 * the supergraph. The `@key(fields: "id")` directive on the type
 * declaration (database/entities/sensor-reading.entity.ts) announces
 * the type to the gateway; this class implements the
 * `__resolveReference` callback the gateway invokes when ANOTHER
 * subgraph (today: farm-service via the upcoming `Tank.sensorReadings`
 * extension in S1.3) hands back a stub like
 *   `{ __typename: 'SensorReading', id: '...' }`.
 *
 * SENSOR-HIGH-085 — a SensorReading is an as-of read PROJECTION over
 * sensor.sensor_metrics, not a stored row. Its `id` is therefore an
 * opaque codec of its anchor (sensorId, as-of instant), not a database
 * key. Reference resolution decodes the id and RECONSTRUCTS the
 * snapshot via SensorQueryService.reconstructAsOf — the same as-of
 * machinery `latestReading` / `readings` / `latestReadingsBatch` use —
 * so a reference minted by any of those reads resolves to the exact
 * same reading. Device-ingested sensors (which never wrote the retired
 * sensor_readings store) now resolve real data.
 *
 * Tenant-isolation discipline (D7/D8, fail-closed):
 *   - Federation calls bypass the request's normal tenant middleware
 *     because the gateway routes by `__typename` + `id`.
 *   - The tenant is taken ONLY from the authenticated user the gateway
 *     forwards (`context.req.user.tenantId`). The `id`/reference is
 *     attacker/peer-subgraph-influenced, so it is NEVER a tenant source
 *     — a reference cannot name the tenant its own data is read under.
 *   - No authenticated tenant, or an id that fails to decode, LOGS +
 *     RETURNS NULL (federation reads null as entity-not-found).
 *   - reconstructAsOf runs inside a tenant-pinned read (runInTenantRead),
 *     so the per-tenant channel join and the cross-tenant metrics read
 *     are both scoped to that one tenant even off the middleware path.
 */
import { Logger } from '@nestjs/common';
import { Resolver, ResolveReference } from '@nestjs/graphql';
import { decodeSensorReadingId } from '@aquaculture/backend-common/sensor';

import { SensorReading } from '../../database/entities/sensor-reading.entity';
import { SensorQueryService } from '../services/sensor-query.service';

/**
 * Reference shape passed by the gateway. Only `id` is trusted for
 * reconstruction (decoded to its anchor); the tenant is resolved from
 * the authenticated context, never the reference.
 */
interface SensorReadingReference {
  __typename: string;
  id: string;
}

interface FederationContext {
  req?: {
    user?: {
      tenantId?: string;
    };
  };
}

@Resolver(() => SensorReading)
export class SensorReadingResolver {
  private readonly logger = new Logger(SensorReadingResolver.name);

  constructor(private readonly queryService: SensorQueryService) {}

  /**
   * Federation `__resolveReference` for SensorReading.
   *
   * Returns null when the call cannot be safely tenant-scoped or the id
   * cannot be decoded — the gateway interprets null as "entity not found
   * in this subgraph". That is the architecturally correct fail-closed
   * posture for cross-tenant safety.
   */
  @ResolveReference()
  async resolveReference(
    reference: SensorReadingReference,
    context: FederationContext,
  ): Promise<SensorReading | null> {
    try {
      const tenantId = context?.req?.user?.tenantId;
      if (!tenantId) {
        this.logger.warn(
          `Federation reference resolver called without an authenticated tenant for sensor reading ${reference.id} — rejecting for tenant isolation`,
        );
        return null;
      }

      const decoded = decodeSensorReadingId(reference.id);
      if (!decoded) {
        this.logger.warn(
          'Federation reference resolver received an undecodable SensorReading id — rejecting',
        );
        return null;
      }

      return await this.queryService.reconstructAsOf(
        decoded.sensorId,
        decoded.timeText,
        tenantId,
      );
    } catch (error: unknown) {
      this.logger.debug(
        `Error in resolveReference: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
