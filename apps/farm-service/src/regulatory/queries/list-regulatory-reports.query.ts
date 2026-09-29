import { RegulatoryReportType } from '../entities/regulatory-report.entity';
import type { TenantScope } from '@aquaculture/backend-common/database';

/** List persisted regulatory report submissions for one report type. */
export class ListRegulatoryReportsQuery {
  constructor(
    public readonly scope: TenantScope,
    public readonly reportType: RegulatoryReportType,
    public readonly siteId?: string,
    public readonly limit: number = 50,
    public readonly offset: number = 0,
  ) {}
}
