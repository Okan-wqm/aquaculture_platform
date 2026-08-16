import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';

import { ApplyConfigurationBatchCommand } from '../commands/apply-configuration-batch.command';
import { ConfigurationBatchReceiptV1 } from '../dto/configuration-snapshot.dto';
import { ConfigurationBatchAuthorityService } from '../services/configuration-batch-authority.service';

@CommandHandler(ApplyConfigurationBatchCommand)
export class ApplyConfigurationBatchHandler
  implements ICommandHandler<ApplyConfigurationBatchCommand, ConfigurationBatchReceiptV1>
{
  constructor(private readonly authority: ConfigurationBatchAuthorityService) {}

  async execute(command: ApplyConfigurationBatchCommand): Promise<ConfigurationBatchReceiptV1> {
    return this.authority.apply(
      command.input,
      command.tenantId,
      command.actorId,
      command.operatorSurfaceOnly,
    );
  }
}
