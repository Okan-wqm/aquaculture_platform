/**
 * SensorReadingResolver — Apollo Federation entity owner.
 *
 * Phase S1.2 of the Scope B sensor↔farm federation plan. This is the
 * resolver class that "owns" the federated `SensorReading` type in
 * the supergraph. The dedicated `@key(fields: "id")` directive on
 * the entity declaration (database/entities/sensor-reading.entity.ts)
 * announces the type to the gateway; this class implements the
 * `__resolveReference` callback the gateway invokes when ANOTHER
 * subgraph (today: farm-service via the upcoming `Tank.sensorReadings`
 * extension in S1.3) hands back a stub like
 *   `{ __typename: 'SensorReading', id: '...' }`.
 *
 * Why a dedicated resolver class (and not piggybacking on
 * SensorResolver):
 *   - One `@Resolver(() => SensorReading)` per type is the canonical
 *     NestJS pattern; multiple `@Resolver(...)` blocks per file
 *     compose, but the framework (and humans) reason most clearly
 *     about ONE class = ONE federated entity. Future field
 *     resolvers on SensorReading land here without touching
 *     SensorResolver.
 *   - SensorResolver currently hosts operation-level queries that
 *     return `[SensorReading]` (`latestReading`, `readings`,
 *     `latestReadingsBatch`). Those stay there — they're sensor-
 *     centric reads, not type ownership. Splitting per the
 *     ownership axis means future SensorReading-specific queries
 *     (e.g. cross-tank time-series joins) have a clear home.
 *
 * Tenant-isolation discipline (mirror of FarmResolver.resolveReference
 * at apps/farm-service/src/farm/resolvers/farm.resolver.ts:55):
 *   - Federation calls bypass the request's normal tenant guard
 *     because the gateway routes by `__typename` + `id`.
 *   - The reference object MAY carry a `tenantId` field if the
 *     caller subgraph included it; we prefer that when present.
 *   - Otherwise we fall back to the user context the gateway
 *     forwards through.
 *   - If neither resolves to a tenant, we LOG + RETURN NULL rather
 *     than throw. Federation expects null on miss; throwing surfaces
 *     500s in the gateway and breaks composition for all subgraphs.
 *
 * INFRA-MEDIUM-015 closes here: until this resolver landed, any
 * future federated extension of SensorReading would silently break
 * because the type had no owner with `__resolveReference`.
 */
import { Logger } from '@nestjs/common';
import { Resolver, ResolveReference } from '@nestjs/graphql';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorReading } from '../../database/entities/sensor-reading.entity';

/**
 * Reference shape passed by the gateway. The `tenantId` is OPTIONAL
 * and only present when the producing subgraph explicitly includes
 * it on the reference. We accept either source (reference OR
 * context) and reject when neither yields a tenant.
 */
interface SensorReadingReference {
  __typename: string;
  id: string;
  tenantId?: string;
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

  constructor(
    @InjectRepository(SensorReading)
    private readonly readingRepository: Repository<SensorReading>,
  ) {}

  /**
   * Federation `__resolveReference` for SensorReading.
   *
   * Returns null when the call cannot be safely tenant-scoped — the
   * gateway interprets null as "entity not found in this subgraph"
   * and the supergraph response carries a null where the federated
   * field was expected. That is the architecturally correct fail-
   * closed posture for cross-tenant safety.
   */
  @ResolveReference()
  async resolveReference(
    reference: SensorReadingReference,
    context: FederationContext,
  ): Promise<SensorReading | null> {
    try {
      const tenantId = context?.req?.user?.tenantId ?? reference.tenantId;
      if (!tenantId) {
        this.logger.warn(
          `Federation reference resolver called without tenantId for sensor reading ${reference.id} — rejecting for tenant isolation`,
        );
        return null;
      }
      return await this.readingRepository.findOne({
        where: { id: reference.id, tenantId },
      });
    } catch (error: unknown) {
      this.logger.debug(
        `Error in resolveReference: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}
