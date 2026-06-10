import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { UpsertConfigurationCommand } from '../commands/upsert-configuration.command';
import { Configuration, ConfigurationHistory, ConfigValueType } from '../entities/configuration.entity';
import { ConfigurationService } from '../services/configuration.service';
import { EncryptionService } from '../services/encryption.service';

@Injectable()
@CommandHandler(UpsertConfigurationCommand)
export class UpsertConfigurationHandler
  implements ICommandHandler<UpsertConfigurationCommand, Configuration>
{
  private readonly logger = new Logger(UpsertConfigurationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configurationService: ConfigurationService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async execute(command: UpsertConfigurationCommand): Promise<Configuration> {
    const { tenantId, service, key, value, environment, userId, isSecret } = command;
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();

    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');
    try {
      const repo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);
      const historyRepo = tenantManagerRepo(
        queryRunner.manager,
        ConfigurationHistory,
        tenantId,
      );

      const existingConfig = await repo.findOne({
        where: { tenantId, service, key, environment },
      });

      const valueType = isSecret ? ConfigValueType.SECRET : ConfigValueType.STRING;
      let valueToStore = value;
      if (isSecret && this.encryptionService.isAvailable()) {
        valueToStore = this.encryptionService.encrypt(value, {
          tenantId,
          service,
          key,
          environment,
          classification: valueType,
        });
      }

      await repo
        .createQueryBuilder()
        .insert()
        .into(Configuration)
        .values({
          tenantId,
          service,
          key,
          value: valueToStore,
          environment,
          valueType,
          isSecret,
          isActive: true,
          createdBy: userId,
          updatedBy: userId,
        })
        .orUpdate(
          [
            'value',
            'value_type',
            'is_secret',
            'updated_by',
            'updated_at',
            'is_active',
          ],
          ['tenant_id', 'service', 'key', 'environment'],
        )
        .returning('*')
        .execute();

      const saved = await repo.findOneOrFail({
        where: { tenantId, service, key, environment },
      });

      if (existingConfig && existingConfig.value !== valueToStore) {
        const history = historyRepo.create({
          configurationId: saved.id,
          tenantId,
          service,
          key,
          previousValue:
            existingConfig.valueType === ConfigValueType.SECRET || existingConfig.isSecret
              ? '[REDACTED]'
              : existingConfig.value,
          newValue: isSecret ? '[REDACTED]' : value,
          changedBy: userId || 'system',
          changedAt: new Date(),
          changeReason: command.reason || 'Upsert operation',
        });

        await historyRepo.save(history);
      }

      await queryRunner.commitTransaction();

      this.configurationService.invalidateCache(tenantId, service, key, environment);

      this.logger.log(`Configuration upserted: ${service}/${key} for tenant ${tenantId}`);

      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Failed to upsert configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to upsert configuration');
    } finally {
      await queryRunner.release();
    }
  }
}
