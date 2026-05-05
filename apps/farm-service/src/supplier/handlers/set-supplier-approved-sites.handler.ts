/**
 * SetSupplierApprovedSitesHandler — Scope A Phase 4.4.2.
 *
 * Replaces a supplier's full set of approved sites in one
 * transactional swap (DELETE + INSERT). The handler:
 *
 *   1. Pre-validates the supplier exists in the caller's tenant.
 *   2. Pre-validates every requested siteId exists AND belongs to
 *      the same tenant — partial writes are forbidden, so any
 *      unknown id triggers BadRequest before any mutation.
 *   3. Pre-validates `preferredSiteId ∈ siteIds` (or null) so the
 *      `isPreferred` flag can never end up on a row outside the
 *      approved set.
 *   4. Snapshots the previous approved-site rows (for the outbox
 *      event's `previousSiteIds` + `previousPreferredSiteId`).
 *   5. Deletes existing rows for `(tenantId, supplierId)`.
 *   6. Inserts new rows for each site.
 *   7. Enqueues `SupplierApprovedSitesChanged` outbox event in the
 *      same QueryRunner transaction so the event never fires without
 *      the domain writes, and the domain never commits without its
 *      event enqueued.
 *   8. Commits.
 *
 * The caller receives the post-write set of `SupplierSite` rows.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { OutboxPublisher } from '@platform/outbox';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import {
  createBaseEvent,
  type SupplierApprovedSitesChangedEvent,
} from '@platform/event-contracts';

import { SetSupplierApprovedSitesCommand } from '../commands/set-supplier-approved-sites.command';
import { Supplier } from '../entities/supplier.entity';
import { SupplierSite } from '../entities/supplier-site.entity';
import { Site } from '../../site/entities/site.entity';

@CommandHandler(SetSupplierApprovedSitesCommand)
export class SetSupplierApprovedSitesHandler
  implements ICommandHandler<SetSupplierApprovedSitesCommand, SupplierSite[]>
{
  private readonly logger = new Logger(SetSupplierApprovedSitesHandler.name);

  constructor(
    @InjectRepository(Supplier)
    private readonly supplierRepository: Repository<Supplier>,
    @InjectRepository(SupplierSite)
    private readonly supplierSiteRepository: Repository<SupplierSite>,
    @InjectRepository(Site)
    private readonly siteRepository: Repository<Site>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
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

    // 1. Supplier exists in tenant
    const supplier = await this.supplierRepository.findOne({
      where: { id: supplierId, tenantId },
    });
    if (!supplier) {
      throw new NotFoundException(`Supplier ${supplierId} not found in tenant.`);
    }

    // 2. Every site exists in same tenant — single bulk lookup so
    //    we don't fan out N queries for N sites.
    if (uniqueSiteIds.length > 0) {
      const sites = await this.siteRepository.find({
        where: { id: In(uniqueSiteIds), tenantId },
        select: { id: true },
      });
      if (sites.length !== uniqueSiteIds.length) {
        const foundIds = new Set(sites.map((s) => s.id));
        const missing = uniqueSiteIds.filter((id) => !foundIds.has(id));
        throw new BadRequestException(
          `Site ids not found in tenant: ${missing.join(', ')}`,
        );
      }
    }

    // 3. preferredSiteId must be null OR a member of siteIds.
    if (preferredSiteId !== null && !uniqueSiteIds.includes(preferredSiteId)) {
      throw new BadRequestException(
        `preferredSiteId (${preferredSiteId}) must be one of the approved siteIds.`,
      );
    }

    // 4. Snapshot previous state for the audit event.
    const previousRows = await this.supplierSiteRepository.find({
      where: { tenantId, supplierId },
      select: { siteId: true, isPreferred: true },
    });
    const previousSiteIds = previousRows.map((r) => r.siteId);
    const previousPreferredSiteId =
      previousRows.find((r) => r.isPreferred)?.siteId ?? null;

    // 5..7 transactional swap + outbox.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      // Wipe the current set for this supplier. (DELETE scoped to
      // tenant + supplier — junction rows for OTHER suppliers are
      // untouched.)
      await queryRunner.manager.delete(SupplierSite, { tenantId, supplierId });

      // Insert the new rows. Empty siteIds is a valid "clear all
      // approvals" call.
      const newRows: SupplierSite[] = uniqueSiteIds.map((siteId) => {
        const row = new SupplierSite();
        row.tenantId = tenantId;
        row.supplierId = supplierId;
        row.siteId = siteId;
        row.isPreferred = preferredSiteId === siteId;
        row.createdBy = userId;
        return row;
      });
      const saved =
        newRows.length > 0
          ? await queryRunner.manager.save(SupplierSite, newRows)
          : [];

      // Outbox event — pre-commit, in the same transaction.
      const event: SupplierApprovedSitesChangedEvent = {
        ...createBaseEvent<SupplierApprovedSitesChangedEvent>(
          'SupplierApprovedSitesChanged',
          tenantId,
          {
            aggregateId: supplierId,
            aggregateType: 'Supplier',
          },
        ),
        supplierId,
        previousSiteIds,
        newSiteIds: uniqueSiteIds,
        previousPreferredSiteId,
        newPreferredSiteId: preferredSiteId,
        changedBy: userId,
      };
      await this.outboxPublisher.enqueue(event, queryRunner.manager);

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
