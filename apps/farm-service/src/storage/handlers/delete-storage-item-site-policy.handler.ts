/**
 * DeleteStorageItemSitePolicyHandler — drop one site's minimum (plan K8 tier 1).
 *
 * WHY a hard delete: a policy is configuration, not a record of something that
 * happened; "no policy" is exactly the absence of the row, and keeping a
 * soft-deleted twin would defeat the (site, item) unique key.
 *
 * WHY an audit row (V-B1-13 of the B1a-1 verifier round): the hard delete takes
 * the row's author stamps with it, so without `farm_audit_logs` nobody could
 * say who removed a site's minimum or what it was. The DELETE row is written in
 * the same transaction (AuditLogService.logWithManager), so a delete never
 * commits without its actor.
 *
 * WHAT: the removal runs inside StockTierWatch like every other policy write:
 * it serialises on the item's stock mutation lock (a removed tier emits
 * nothing) and re-reads the policy under that lock.
 */
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { AuditAction } from '../../database/entities/audit-log.entity';
import { AuditLogService } from '../../database/services/audit-log.service';
import { DeleteStorageItemSitePolicyCommand } from '../commands/delete-storage-item-site-policy.command';
import { StorageItemSitePolicy } from '../entities/storage-item-site-policy.entity';
import { StockTierWatch } from '../services/low-stock/stock-tier-watch.service';

/** The audited facts of a policy (what was removed, and its last author). */
function policyAuditSnapshot(policy: StorageItemSitePolicy): Record<string, unknown> {
  return {
    siteId: policy.siteId,
    itemType: policy.itemType,
    itemId: policy.itemId,
    minStock: Number(policy.minStock),
    createdBy: policy.createdBy,
    updatedBy: policy.updatedBy,
  };
}

@CommandHandler(DeleteStorageItemSitePolicyCommand)
export class DeleteStorageItemSitePolicyHandler
  implements ICommandHandler<DeleteStorageItemSitePolicyCommand, boolean>
{
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly tierWatch: StockTierWatch,
    private readonly auditLogService: AuditLogService,
  ) {}

  async execute(command: DeleteStorageItemSitePolicyCommand): Promise<boolean> {
    const { policyId, tenantId, userId } = command;
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const repo = tenantManagerRepo(manager, StorageItemSitePolicy, tenantId);
      const found = await repo.findOne({ where: { id: policyId, tenantId } });
      if (!found) throw new NotFoundException(`Site stock policy "${policyId}" not found`);

      return this.tierWatch.around(
        manager,
        tenantId,
        {
          items: [{ itemType: found.itemType, itemId: found.itemId }],
          causationId: () => policyId,
        },
        async () => {
          // Re-read under the item lock: a concurrent delete may have won.
          const policy = await repo.findOne({ where: { id: policyId, tenantId } });
          if (!policy) throw new NotFoundException(`Site stock policy "${policyId}" not found`);
          const before = policyAuditSnapshot(policy);
          await repo.remove(policy);
          await this.auditLogService.logWithManager(manager, {
            tenantId,
            entityType: 'StorageItemSitePolicy',
            entityId: policyId,
            action: AuditAction.DELETE,
            userId,
            changes: { before },
            metadata: { source: 'STORAGE_SITE_POLICY' },
            summary: `Deleted the site stock minimum of ${policy.itemType} ${policy.itemId} at site ${policy.siteId}`,
          });
          return true;
        },
      );
    });
  }
}
