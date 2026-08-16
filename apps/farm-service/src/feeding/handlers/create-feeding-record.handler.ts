import { Inject, Injectable } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@platform/cqrs';

import {
  FEEDING_OPERATION_COMMAND_PORT,
  type FeedingOperationCommandPort,
} from '../../feeding-protocol/feeding-operation-command.port';
import type { FeedingRecordOperationResult } from '../../feeding-protocol/feeding-operation-command';
import { CreateFeedingRecordCommand } from '../commands/create-feeding-record.command';

/** CQRS ingress. Validation is pure; every state mutation is coordinator-owned. */
@Injectable()
@CommandHandler(CreateFeedingRecordCommand)
export class CreateFeedingRecordHandler
  implements ICommandHandler<CreateFeedingRecordCommand, FeedingRecordOperationResult>
{
  constructor(
    @Inject(FEEDING_OPERATION_COMMAND_PORT)
    private readonly operationPort: FeedingOperationCommandPort,
  ) {}

  async execute(command: CreateFeedingRecordCommand): Promise<FeedingRecordOperationResult> {
    return this.operationPort.recordFeeding({
      tenantId: command.tenantId,
      actorId: command.userId,
      requestId: command.operationRequestId,
      payload: command.payload,
    });
  }
}
