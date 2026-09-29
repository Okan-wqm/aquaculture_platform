/**
 * RestoreSiteHandler — bring a soft-deleted site back (Phase 4.2, Girdi 6).
 *
 * WHY a command (it used to be resolver → RestoreService): a restored site
 * wakes its dormant stock policies (plan K8: a deleted site distributes
 * nothing, so its `storage_item_site_policies` are ignored, not deleted). A
 * woken policy whose site holds less than its minimum is a site tier that
 * became low WITHOUT any stock movement, so the restore runs inside
 * StockTierWatch in one transaction and signals it (V-B1-5 of the B1a-1
 * verifier round) — exactly once, under the items' stock locks.
 *
 * WHAT: collects the items with a policy at the site, then restores the site
 * through RestoreService on the transaction's tenant-scoped repository. The
 * uniqueness check guards BOTH unique indexes — (tenantId, code) and
 * (tenantId, name) — so a code or name re-used on an active site since the
 * soft delete surfaces a RestoreUniquenessConflictError instead of a database
 * unique-constraint failure.
 */
import { CommandHandler, ICommandHandler } from '@platform/cqrs';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { runInTenantTransaction, tenantManagerRepo } from '@aquaculture/backend-common/database';

import { RestoreService } from '../../common/services/restore.service';
import { StockTierWatch } from '../../storage/services/low-stock/stock-tier-watch.service';
import { RestoreSiteCommand } from '../commands/restore-site.command';
import { Site } from '../entities/site.entity';

@CommandHandler(RestoreSiteCommand)
export class RestoreSiteHandler implements ICommandHandler<RestoreSiteCommand, Site> {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly restoreService: RestoreService,
    private readonly tierWatch: StockTierWatch,
  ) {}

  async execute(command: RestoreSiteCommand): Promise<Site> {
    const { siteId, tenantId, userId, userName } = command;
    return runInTenantTransaction(this.dataSource, 'farm', tenantId, async (queryRunner) => {
      const manager = queryRunner.manager;
      const items = await this.tierWatch.sitePolicyItems(manager, tenantId, siteId);
      return this.tierWatch.around(manager, tenantId, { items, causationId: () => siteId }, () =>
        this.restoreService.restore(
          tenantManagerRepo(manager, Site, tenantId),
          Site,
          siteId,
          { tenantId, userId, userName },
          // Both unique indexes from site.entity.ts must be checked.
          { uniqueKeys: [['code'], ['name']] },
        ),
      );
    });
  }
}
