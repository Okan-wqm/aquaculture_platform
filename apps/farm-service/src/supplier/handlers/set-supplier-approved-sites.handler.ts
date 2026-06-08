/**
 * SetSupplierApprovedSitesHandler — Scope A Phase 4.4.2.
 *
 * Replaces a supplier's full set of approved sites in one
 * transactional swap (DELETE + INSERT). The handler:
 *
 *   1. Pre-validates `preferredSiteId ∈ siteIds` (or null) so the
 *      `isPreferred` flag can never end up on a row outside the
 *      approved set.
 *   2. Executes inside `runInTenantTransaction` with tenant-scoped repos.
 *   3. Validates the supplier exists in the caller's tenant.
 *   4. Validates every requested siteId exists in the same tenant.
 *   5. Snapshots the previous approved-site rows.
 *   6. Deletes existing rows for `(tenantId, supplierId)`.
 *   7. Inserts new rows for each site.
 *   8. Writes fail-closed audit and enqueues `SupplierApprovedSitesChanged`
 *      in the same transaction, so domain, audit, and outbox commit together.
 *
 * The caller receives the post-write set of `SupplierSite` rows.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';
import { DataSource, In } from 'typeorm';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { createBaseEvent, type SupplierApprovedSitesChangedEvent } from '@platform/event-contracts';

import { SetSupplierApprovedSitesCommand } from '../commands/set-supplier-approved-sites.command';
import { Supplier } from '../entities/supplier.entity';
import { SupplierSite } from '../entities/supplier-site.entity';
import { Site } from '../../site/entities/site.entity';
import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { supplierSiteAuditSnapshot } from './supplier-audit.util';

@CommandHandler(SetSupplierApprovedSitesCommand)
export class SetSupplierApprovedSitesHandler
  implements ICommandHandler<SetSupplierApprovedSitesCommand, SupplierSite[]>
{
  private readonly logger = new Logger(SetSupplierApprovedSitesHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: SetSupplierApprovedSitesCommand): Promise<SupplierSite[]> {
    const { supplierId, siteIds, preferredSiteId, tenantId, userId } = command;

    this.logger.log(
      `Setting approved sites for supplier ${supplierId}: ${siteIds.length} site(s), preferred=${preferredSiteId ?? 'none'}`,
    );

    const uniqueSiteIds = Array.from(new Set(siteIds));
    if (uniqueSiteIds.length !== siteIds.length) {
      throw new BadRequestException(
        `siteIds contains duplicates — every id must be unique (got ${siteIds.length}, ${uniqueSiteIds.length} unique).`,
      );
    }

    if (preferredSiteId !== null && !uniqueSiteIds.includes(preferredSiteId)) {
      throw new BadRequestException(
        `preferredSiteId (${preferredSiteId}) must be one of the approved siteIds.`,
      );
    }

    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const supplierRepository = tenantManagerRepo(queryRunner.manager, Supplier, tenantId);
      const supplierSiteRepository = tenantManagerRepo(queryRunner.manager, SupplierSite, tenantId);
      const siteRepository = tenantManagerRepo(queryRunner.manager, Site, tenantId);

      const supplier = await supplierRepository.findOne({
        where: { id: supplierId, tenantId },
      });
      if (!supplier) {
        throw new NotFoundException(`Supplier ${supplierId} not found in tenant.`);
      }

      // Single bulk lookup keeps the write all-or-nothing without N site queries.
      if (uniqueSiteIds.length > 0) {
        const sites = await siteRepository.find({
          where: { id: In(uniqueSiteIds), tenantId },
          select: { id: true },
        });
        if (sites.length !== uniqueSiteIds.length) {
          const foundIds = new Set(sites.map((s) => s.id));
          const missing = uniqueSiteIds.filter((id) => !foundIds.has(id));
          throw new BadRequestException(`Site ids not found in tenant: ${missing.join(', ')}`);
        }
      }

      const previousRows = await supplierSiteRepository.find({
        where: { supplierId, tenantId },
        order: { isPreferred: 'DESC', createdAt: 'ASC' },
      });
      const previousSiteIds = previousRows.map((r) => r.siteId);
      const previousPreferredSiteId = previousRows.find((r) => r.isPreferred)?.siteId ?? null;

      await supplierSiteRepository.delete({ supplierId });

      const newRows: SupplierSite[] = uniqueSiteIds.map((siteId) => {
        return supplierSiteRepository.create({
          supplierId,
          siteId,
          isPreferred: preferredSiteId === siteId,
          createdBy: userId,
        });
      });
      const saved = newRows.length > 0 ? await supplierSiteRepository.saveMany(newRows) : [];

      await this.auditLogService.logWithManager(queryRunner.manager, {
        tenantId,
        entityType: 'Supplier',
        entityId: supplierId,
        action: AuditAction.UPDATE,
        userId,
        changes: {
          before: {
            approvedSites: previousRows.map(supplierSiteAuditSnapshot),
            preferredSiteId: previousPreferredSiteId,
          },
          after: {
            approvedSites: saved.map(supplierSiteAuditSnapshot),
            preferredSiteId,
          },
        },
        metadata: { source: 'SITES_SETUP_SUPPLIER_SITES' },
        entityVersion: supplier.version,
        summary: `Updated approved sites for supplier ${supplier.code ?? supplier.name}`,
      });

      const event: SupplierApprovedSitesChangedEvent = {
        ...createBaseEvent<SupplierApprovedSitesChangedEvent>(
          'SupplierApprovedSitesChanged',
          tenantId,
          {
            aggregateId: supplierId,
            aggregateType: 'Supplier',
            userId,
          },
        ),
        supplierId,
        previousSiteIds,
        newSiteIds: uniqueSiteIds,
        previousPreferredSiteId,
        newPreferredSiteId: preferredSiteId,
        changedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager, {
        aggregateId: supplierId,
      });

      return saved;
    });
  }
}
