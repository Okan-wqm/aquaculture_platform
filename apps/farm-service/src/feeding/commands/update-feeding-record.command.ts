/**
 * UpdateFeedingRecordCommand
 *
 * Mevcut yemleme kaydını güncellemek için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import type { UpdateFeedingRecordPayload } from '../../feeding-protocol/feeding-operation-command';

/**
 * Yemleme kaydı güncelleme payload
 */
export type { UpdateFeedingRecordPayload } from '../../feeding-protocol/feeding-operation-command';

export class UpdateFeedingRecordCommand implements ITenantCommand {
  readonly commandName = 'UpdateFeedingRecordCommand';

  constructor(
    public readonly tenantId: string,
    public readonly feedingRecordId: string,
    public readonly payload: UpdateFeedingRecordPayload,
    public readonly userId: string,
    public readonly operationRequestId: string,
  ) {}
}
