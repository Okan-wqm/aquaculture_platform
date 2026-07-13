/**
 * validateEntryDimensions — reject a finance entry whose batchId/siteId
 * dimension does not reference an existing tenant-owned aggregate.
 *
 * batchId/siteId are free UUIDs on the input; without this check a typo'd
 * or foreign id would book a phantom per-batch / per-site cost line and
 * corrupt the dimensional P&L (financeBatchTotals, site-scoped ledger).
 * Existence + tenant ownership is the integrity contract — an archived
 * batch/site is still a legitimate historical dimension, so activation
 * state is intentionally not constrained here.
 */
import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import { Batch } from '../../batch/entities/batch.entity';
import { Site } from '../../site/entities/site.entity';

export async function validateEntryDimensions(
  manager: EntityManager,
  tenantId: string,
  dimensions: { batchId?: string | null; siteId?: string | null },
): Promise<void> {
  if (dimensions.batchId) {
    const exists = await manager.count(Batch, {
      where: { id: dimensions.batchId, tenantId },
    });
    if (exists === 0) {
      throw new BadRequestException(
        `Finance entry batchId ${dimensions.batchId} does not reference a batch in this tenant`,
      );
    }
  }
  if (dimensions.siteId) {
    const exists = await manager.count(Site, {
      where: { id: dimensions.siteId, tenantId },
    });
    if (exists === 0) {
      throw new BadRequestException(
        `Finance entry siteId ${dimensions.siteId} does not reference a site in this tenant`,
      );
    }
  }
}
