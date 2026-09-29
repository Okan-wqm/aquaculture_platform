import { Injectable } from '@nestjs/common';
import { TenantScope } from '@aquaculture/backend-common/database';
import { DataSource } from 'typeorm';

/** farm-service's source schema: tenant schemas are cloned from it. */
export const FARM_SOURCE_SCHEMA = 'farm';

/**
 * Opens farm's tenant data boundary for callers that start from a tenant id
 * (GraphQL resolvers, REST controllers, assemblers) — K10 layer 4, PR-T1.
 *
 * WHY a provider instead of each caller holding a DataSource: query handlers
 * that the AI path reaches read only through the `TenantScope` their query
 * carries. A non-AI caller opens that scope here, so the handler runs the
 * same code on both paths and never holds a connection of its own.
 *
 * INVARIANT: AI-reachable code never injects this provider — only the
 * responder skeleton opens scopes on the AI path
 * (tests/invariants/ai-tenant-boundary-data-layer.spec.ts); if violated → a
 * handler could open a second boundary for a tenant id it chose.
 */
@Injectable()
export class FarmTenantScopes {
  constructor(private readonly dataSource: DataSource) {}

  /** Run `fn` inside a READ ONLY boundary pinned and asserted to `tenantId`. */
  read<T>(tenantId: string, fn: (scope: TenantScope) => Promise<T>): Promise<T> {
    return TenantScope.read(this.dataSource, FARM_SOURCE_SCHEMA, tenantId, fn);
  }

  /** Run `fn` inside a read-write boundary pinned and asserted to `tenantId`. */
  write<T>(tenantId: string, fn: (scope: TenantScope) => Promise<T>): Promise<T> {
    return TenantScope.write(this.dataSource, FARM_SOURCE_SCHEMA, tenantId, fn);
  }
}
