import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@platform/cqrs';

import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../../feeding-protocol/feeding-operation-command.port';
import type { FeedingRecordOperationResult } from '../../feeding-protocol/feeding-operation-command';
import { UpdateFeedingRecordCommand } from '../commands/update-feeding-record.command';

/** CQRS ingress only; the operation authority owns replay, transaction and mutation. */
@Injectable()
@CommandHandler(UpdateFeedingRecordCommand)
export class UpdateFeedingRecordHandler
  implements ICommandHandler<UpdateFeedingRecordCommand, FeedingRecordOperationResult>
{
  constructor(
    @Inject(FEEDING_OPERATION_COMMAND_PORT)
    private readonly operationPort: FeedingOperationCommandPort,
  ) {}

  execute(command: UpdateFeedingRecordCommand): Promise<FeedingRecordOperationResult> {
    return this.operationPort.updateFeeding({
      tenantId: command.tenantId,
      actorId: command.userId,
      requestId: command.operationRequestId,
      feedingRecordId: command.feedingRecordId,
      payload: command.payload,
    });
  }
}
