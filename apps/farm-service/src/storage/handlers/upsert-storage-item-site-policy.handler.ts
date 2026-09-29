/**
 * UpsertStorageItemSitePolicyHandler — create or change one site's minimum
 * for one stock item (plan K8 tier 1, FARM-HIGH-336).
 *
 * WHY upsert: the policy is identified by (site, item), which the unique index
 * already makes the natural key; a separate create/update pair would only add
 * a "policy already exists" failure mode for the same operator intent.
 * WHAT: validates the site (live, same tenant) and the catalog item, then
 * inserts or updates inside one tenant transaction, stamping the author.
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

@CommandHandler(UpsertStorageItemSitePolicyCommand)
export class UpsertStorageItemSitePolicyHandler
  implements ICommandHandler<UpsertStorageItemSitePolicyCommand, StorageItemSitePolicy>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

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

      const repo = tenantManagerRepo(manager, StorageItemSitePolicy, tenantId);
      const existing = await repo.findOne({
        where: { tenantId, siteId: input.siteId, itemType, itemId: input.itemId },
        lock: { mode: 'pessimistic_write' },
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
