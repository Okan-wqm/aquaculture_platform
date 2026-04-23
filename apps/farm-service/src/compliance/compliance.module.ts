/**
 * ComplianceModule
 *
 * Wires the GDPR primitives: TenantExportService +
 * TenantErasureService + ComplianceResolver. DatabaseModule
 * (which carries AuditRedactionService) is @Global so no
 * explicit import needed for the redaction dependency.
 *
 * Phase 6.3 of the "Farm modülü kalan kör noktalar" plan.
 */
import { Module } from '@nestjs/common';

import { TenantExportService } from './services/tenant-export.service';
import { TenantErasureService } from './services/tenant-erasure.service';
import { ComplianceResolver } from './compliance.resolver';

@Module({
  providers: [
    TenantExportService,
    TenantErasureService,
    ComplianceResolver,
  ],
  exports: [TenantExportService, TenantErasureService],
})
export class ComplianceModule {}
