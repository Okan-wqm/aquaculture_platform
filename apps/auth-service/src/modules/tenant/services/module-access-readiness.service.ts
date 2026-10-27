/**
 * Module-access readiness for one tenant (PKG-06 "Readiness"; plan §6 R4 entry gate). The report
 * is counts only; module-access-readiness.ts says what each count means.
 *
 * WHAT: reads the census (module-access-census.ts) in one transaction bound to the tenant (RLS:
 * user_module_assignments and tenant_modules carry the forced tenant-isolation policy), closes
 * it, then asks each enabled owner module about the members without its grant
 * (module-recent-writers.ts) — no database transaction stays open across a NATS round trip.
 */
import { bindTenantRlsContext } from '@aquaculture/backend-common/database';
import type { OwnerModuleCode } from '@aquaculture/shared-contracts';
import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { NatsRequestReply } from '@platform/event-bus';
import { DataSource } from 'typeorm';

import { readModuleAccessCensus } from './module-access-census';
import {
  READINESS_WINDOW_DAYS,
  buildModuleAccessReadiness,
  membersWithoutGrantIn,
  type ModuleAccessReadinessReport,
  type RecentWriterReadiness,
} from './module-access-readiness';
import { askRecentWriters } from './module-recent-writers';

@Injectable()
export class ModuleAccessReadinessService {
  private readonly logger = new Logger(ModuleAccessReadinessService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly requestReply: NatsRequestReply,
  ) {}

  async readiness(tenantId: string): Promise<ModuleAccessReadinessReport> {
    const census = await this.dataSource.transaction(async (manager) => {
      await bindTenantRlsContext(manager, tenantId, 'auth');
      return readModuleAccessCensus(
        (sql, parameters) => manager.query(sql, [...parameters]),
        tenantId,
      );
    });
    const recentWriters = new Map<OwnerModuleCode, RecentWriterReadiness>();
    for (const code of census.enabledModules) {
      recentWriters.set(
        code,
        await askRecentWriters(
          this.requestReply,
          {
            tenantId,
            module: code,
            withoutGrant: membersWithoutGrantIn(census, code),
            windowDays: READINESS_WINDOW_DAYS,
          },
          this.logger,
        ),
      );
    }
    return buildModuleAccessReadiness(census, recentWriters);
  }
}
