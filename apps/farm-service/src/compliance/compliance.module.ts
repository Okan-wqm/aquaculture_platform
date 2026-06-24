/**
 * ComplianceModule
 *
 * Wires the GDPR primitives: TenantExportService +
 * TenantErasureService + ComplianceResolver. DatabaseModule
 * (which carries AuditRedactionService) is @Global so no
 * explicit import needed for the redaction dependency.
 *
 * Phase 6.3 of the "Farm modülü kalan kör noktalar" plan.
 *
 * # COMPLIANCE-MEDIUM-004 — TenantErasureAuditEntity registration
 *
 * The erasure-audit entity participates in the cascade transaction
 * (see TenantErasureService.executeErasure) and is read by the
 * idempotency-check helper. TypeOrmModule.forFeature loads it into
 * the repository registry so getRepository<TenantErasureAuditEntity>
 * resolves at the DI container.
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TenantExportService } from './services/tenant-export.service';
import { TenantErasureService } from './services/tenant-erasure.service';
import { ComplianceResolver } from './compliance.resolver';
import { TenantErasureAuditEntity } from './entities/tenant-erasure-audit.entity';
import { TenantErasureRequestedHandler } from './tenant-erasure-requested.handler';

@Module({
  imports: [TypeOrmModule.forFeature([TenantErasureAuditEntity])],
  providers: [
    TenantExportService,
    TenantErasureService,
    ComplianceResolver,
    TenantErasureRequestedHandler,
  ],
  exports: [TenantExportService, TenantErasureService],
})
export class ComplianceModule {}
