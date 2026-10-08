import { NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';

/**
 * The channel row, locked FOR UPDATE inside the caller's transaction.
 *
 * Every read-check-write of a channel (configuration edit, quantity
 * declaration, calibration) goes through this, so a writer validates against
 * the row as it is and no concurrent writer can save a stale copy over its
 * change — a declaration cleared by an edit that loaded the row a moment
 * earlier, a unit change that slips past a declaration's unit check.
 *
 * SECURITY: tenantId in the WHERE clause prevents cross-tenant IDOR; another
 * tenant's channel reads as not found.
 */
export async function lockChannel(
  manager: EntityManager,
  tenantId: string,
  channelId: string,
): Promise<SensorDataChannel> {
  const channel = await manager.findOne(SensorDataChannel, {
    where: { id: channelId, tenantId },
    lock: { mode: 'pessimistic_write' },
  });
  if (!channel) {
    throw new NotFoundException(`Channel with ID '${channelId}' not found`);
  }
  return channel;
}
