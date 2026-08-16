import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';

import { ConfigurationSnapshotV1 } from '../dto/configuration-snapshot.dto';
import { GetConfigurationSnapshotQuery } from '../queries/get-configuration-snapshot.query';
import { ConfigurationSnapshotService } from '../services/configuration-snapshot.service';

@QueryHandler(GetConfigurationSnapshotQuery)
export class GetConfigurationSnapshotHandler
  implements IQueryHandler<GetConfigurationSnapshotQuery, ConfigurationSnapshotV1>
{
  constructor(private readonly snapshots: ConfigurationSnapshotService) {}

  async execute(query: GetConfigurationSnapshotQuery): Promise<ConfigurationSnapshotV1> {
    return this.snapshots.getSnapshot(query.tenantId, query.environment);
  }
}
