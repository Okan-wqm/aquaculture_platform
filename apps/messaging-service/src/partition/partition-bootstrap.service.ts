import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { getMigrationRunnerCompletion } from '@aquaculture/backend-common/database';

import { PartitionManagerService } from './partition-manager.service';

/**
 * App-level partition bootstrap.
 *
 * PartitionManagerService is exported from an imported module, while the
 * messaging migration gate is an AppModule provider. Nest runs imported module
 * bootstrap hooks before the AppModule hooks, so partition verification must
 * live at the same app level as the migration gate and wait for that gate's
 * completion before inspecting partition parents.
 */
@Injectable()
export class PartitionBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartitionBootstrapService.name);

  constructor(private readonly partitionManager: PartitionManagerService) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.waitForMessagingMigrations();
    await this.partitionManager.ensureStartupPartitions();
  }

  private async waitForMessagingMigrations(): Promise<void> {
    const completion = await this.resolveMigrationRunnerCompletion();
    if (!completion) {
      this.logger.warn(
        'Messaging migration completion was not registered before partition bootstrap; continuing with fail-closed partition verification',
      );
      return;
    }
    await completion;
  }

  private async resolveMigrationRunnerCompletion(): Promise<Promise<unknown> | undefined> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const completion = getMigrationRunnerCompletion('messaging');
      if (completion) {
        return completion;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return undefined;
  }
}
