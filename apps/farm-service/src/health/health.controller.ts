import { Controller } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { StandardHealthController } from '@aquaculture/backend-common/health';
import { DataSource } from 'typeorm';

import { TenantSchemaReadinessService } from './tenant-schema-readiness.service';

/**
 * Farm Service Health Controller
 * Extends the standard health controller with consistent K8s probe format.
 *
 * Adds a tenant-schema-routing readiness slice on top of the standard
 * `SELECT 1` database check. farm-service is schema-per-tenant, so a healthy
 * raw connection is NOT sufficient evidence that tenant routing works — a
 * missing source-schema template table or an un-populated tenant schema is
 * invisible to `SELECT 1`. See TenantSchemaReadinessService for the (bounded,
 * O(1)-in-tenants) topology check this exposes via `/health/ready`.
 */
@Controller('health')
export class HealthController extends StandardHealthController {
  constructor(
    @InjectDataSource()
    dataSource: DataSource,
    private readonly tenantSchemaReadiness: TenantSchemaReadinessService,
  ) {
    super(dataSource);
    this.serviceName = 'farm-service';
  }

  /**
   * Extend the standard readiness contract with the tenant-schema-routing
   * check. Reported under the `tenant_schema` key alongside `database`. A
   * failure here marks readiness `degraded` (or `not_ready` if the DB check
   * also fails) per the StandardHealthController aggregation rules — it never
   * throws a 500.
   */
  protected override async getAdditionalChecks(): Promise<
    Record<string, 'ok' | 'error'>
  > {
    return {
      tenant_schema: await this.tenantSchemaReadiness.checkTenantSchemaRouting(),
    };
  }
}
