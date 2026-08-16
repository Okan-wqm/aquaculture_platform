import { ApplyConfigurationBatchInputV1 } from '../dto/configuration-snapshot.dto';

export class ApplyConfigurationBatchCommand {
  constructor(
    readonly input: ApplyConfigurationBatchInputV1,
    readonly tenantId: string,
    readonly actorId: string,
    readonly operatorSurfaceOnly: boolean,
  ) {}
}
