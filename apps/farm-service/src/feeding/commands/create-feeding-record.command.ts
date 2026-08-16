/**
 * CreateFeedingRecordCommand
 *
 * Yeni yemleme kaydı oluşturmak için command.
 *
 * @module Feeding/Commands
 */
import { ITenantCommand } from '@platform/cqrs';
import type { ManualFeedingRecordPayload } from '../../feeding-protocol/feeding-operation-command';

/**
 * Yemleme kaydı oluşturma payload
 */
export type CreateFeedingRecordPayload = ManualFeedingRecordPayload;

export class CreateFeedingRecordCommand implements ITenantCommand {
  readonly commandName = 'CreateFeedingRecordCommand';

  constructor(
    public readonly tenantId: string,
    public readonly payload: CreateFeedingRecordPayload,
    public readonly userId: string,
    public readonly operationRequestId: string,
  ) {}
}
