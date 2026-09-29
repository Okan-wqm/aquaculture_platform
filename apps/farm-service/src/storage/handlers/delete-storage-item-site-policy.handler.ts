/**
 * DeleteStorageItemSitePolicyHandler — drop one site's minimum (plan K8 tier 1).
 *
 * WHY a hard delete: a policy is configuration, not a record of something that
 * happened; "no policy" is exactly the absence of the row, and keeping a
 * soft-deleted twin would defeat the (site, item) unique key.
 */
import { NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { DeleteStorageItemSitePolicyCommand } from '../commands/delete-storage-item-site-policy.command';
import { StorageItemSitePolicy } from '../entities/storage-item-site-policy.entity';

@CommandHandler(DeleteStorageItemSitePolicyCommand)
export class DeleteStorageItemSitePolicyHandler
  implements ICommandHandler<DeleteStorageItemSitePolicyCommand, boolean>
{
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async execute(command: DeleteStorageItemSitePolicyCommand): Promise<boolean> {
    const { policyId, tenantId } = command;
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const repo = tenantManagerRepo(queryRunner.manager, StorageItemSitePolicy, tenantId);
      const policy = await repo.findOne({ where: { id: policyId, tenantId } });
      if (!policy) throw new NotFoundException(`Site stock policy "${policyId}" not found`);
      await repo.remove(policy);
      return true;
    });
  }
}
