import {
  Injectable,
  NotFoundException,
  Logger,
  InternalServerErrorException,
  ForbiddenException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { DeleteConfigurationCommand } from '../commands/delete-configuration.command';
import { Configuration } from '../entities/configuration.entity';
import { emitConfigurationChanged } from '../events/emit-configuration-changed';
import { ConfigurationService } from '../services/configuration.service';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(DeleteConfigurationCommand)
export class DeleteConfigurationHandler
  implements ICommandHandler<DeleteConfigurationCommand, boolean>
{
  private readonly logger = new Logger(DeleteConfigurationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configurationService: ConfigurationService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: DeleteConfigurationCommand): Promise<boolean> {
    const { tenantId, configurationId, userId, hardDelete } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const configRepo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);

      const configuration = await configRepo.findOne({
        where: { id: configurationId, tenantId },
      });

      if (!configuration) {
        throw new NotFoundException(`Configuration not found: ${configurationId}`);
      }

      if (hardDelete) {
        throw new ForbiddenException(
          'Hard delete is disabled for config runtime; use the audited purge lifecycle',
        );
      } else {
        configuration.isActive = false;
        configuration.deletedAt = new Date();
        configuration.deletedBy = userId;
        configuration.deleteReason = 'runtime-delete';
        configuration.suppressFallback = true;
        configuration.updatedBy = userId;
        await configRepo.save(configuration);
        this.logger.log(`Configuration soft deleted: ${configurationId} by user ${userId}`);
      }

      // ARCH-MEDIUM-003: a soft-delete IS a change — emit the signal atomically
      // with the write so a deleted secret key also invalidates a cached snapshot.
      await emitConfigurationChanged(
        this.outboxPublisher,
        queryRunner.manager,
        configuration,
        userId,
      );

      await queryRunner.commitTransaction();

      this.configurationService.invalidateCache(tenantId, configuration.service, configuration.key);

      return true;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException || error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.error(
        `Failed to delete configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to delete configuration');
    } finally {
      await queryRunner.release();
    }
  }
}
