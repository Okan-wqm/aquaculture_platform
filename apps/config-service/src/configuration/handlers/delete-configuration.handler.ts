import {
  Injectable,
  NotFoundException,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { DeleteConfigurationCommand } from '../commands/delete-configuration.command';
import { Configuration } from '../entities/configuration.entity';

@Injectable()
@CommandHandler(DeleteConfigurationCommand)
export class DeleteConfigurationHandler
  implements ICommandHandler<DeleteConfigurationCommand, boolean>
{
  private readonly logger = new Logger(DeleteConfigurationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: DeleteConfigurationCommand): Promise<boolean> {
    const { tenantId, configurationId, userId, hardDelete } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const configRepo = queryRunner.manager.getRepository(Configuration);

      const configuration = await configRepo.findOne({
        where: { id: configurationId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!configuration) {
        throw new NotFoundException(`Configuration not found: ${configurationId}`);
      }

      if (hardDelete) {
        // Permanently delete
        await configRepo.remove(configuration);
        this.logger.log(
          `Configuration hard deleted: ${configurationId} by user ${userId}`,
        );
      } else {
        // Soft delete - just deactivate
        configuration.isActive = false;
        configuration.updatedBy = userId;
        await configRepo.save(configuration);
        this.logger.log(
          `Configuration soft deleted: ${configurationId} by user ${userId}`,
        );
      }

      await queryRunner.commitTransaction();

      return true;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof NotFoundException) {
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
