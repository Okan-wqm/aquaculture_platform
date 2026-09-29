/**
 * UpsertStorageItemSitePolicyHandler — create or change one site's minimum
 * for one stock item (plan K8 tier 1, FARM-HIGH-336).
 *
 * WHY upsert: the policy is identified by (site, item), which the unique index
 * already makes the natural key; a separate create/update pair would only add
 * a "policy already exists" failure mode for the same operator intent.
 * WHAT: validates the site (live, same tenant) and the catalog item, then
 * inserts or updates inside one tenant transaction, stamping the author.
 * INVARIANT: the read-then-write runs under the item's stock mutation lock
 * (an advisory lock exists before the row does). If violated → two managers
 * creating the first policy of one (site, item) both read "none" and the
 * second insert fails on the unique index with a raw 23505.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { UpsertStorageItemSitePolicyCommand } from '../commands/upsert-storage-item-site-policy.command';
import { StorageItemSitePolicy } from '../entities/storage-item-site-policy.entity';
import { Site } from '../../site/entities/site.entity';
import { describeStorageItem } from '../services/storage-item-catalog';
import { canonicalStockItemType } from '../services/low-stock/stock-identity';
import { StockMutationLockAuthority } from '../services/stock-mutation-lock.authority';

@CommandHandler(UpsertStorageItemSitePolicyCommand)
export class UpsertStorageItemSitePolicyHandler
  implements ICommandHandler<UpsertStorageItemSitePolicyCommand, StorageItemSitePolicy>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    // Serialises policy writes with each other and with the item's movements,
    // so an edge-trigger evaluation never sees a half-applied policy change.
    private readonly mutationLocks: StockMutationLockAuthority,
  ) {}

  async execute(command: UpsertStorageItemSitePolicyCommand): Promise<StorageItemSitePolicy> {
    const { input, tenantId, userId } = command;
    // One physical item has one policy: HEALTHCARE and CONSUMABLE share the
    // consumable catalog row, so the policy is stored under the canonical type.
    const itemType = canonicalStockItemType(input.itemType);
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;

      const site = await tenantManagerRepo(manager, Site, tenantId).findOne({
        where: { id: input.siteId, tenantId },
      });
      if (!site) throw new NotFoundException(`Site "${input.siteId}" not found`);
      if (site.isDeleted) throw new BadRequestException(`Site "${input.siteId}" is deleted`);

      const item = await describeStorageItem(manager, tenantId, itemType, input.itemId);
      if (!item) {
        throw new NotFoundException(`${input.itemType} "${input.itemId}" not found`);
      }

      await this.mutationLocks.acquire(manager, tenantId, [{ itemType, itemId: input.itemId }]);
      const repo = tenantManagerRepo(manager, StorageItemSitePolicy, tenantId);
      const existing = await repo.findOne({
        where: { tenantId, siteId: input.siteId, itemType, itemId: input.itemId },
      });
      if (existing) {
        existing.minStock = input.minStock;
        existing.updatedBy = userId;
        return repo.save(existing);
      }
      return repo.save(
        repo.create({
          tenantId,
          siteId: input.siteId,
          itemType,
          itemId: input.itemId,
          minStock: input.minStock,
          createdBy: userId,
          updatedBy: userId,
        }),
      );
    });
  }
}
