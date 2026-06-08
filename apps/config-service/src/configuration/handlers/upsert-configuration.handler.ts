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
    const canonicalIsSecret = isSecret === true;
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const repo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);

      // Fetch existing config before upsert (for history tracking)
      const existingConfig = await repo.findOne({
        where: { tenantId, service, key, environment },
      });

      // Encrypt secret values before storing
      // PLAT-HIGH-003: Pass tenantId + key as AAD to bind ciphertext to context
      let valueToStore = value;
      if (canonicalIsSecret && this.encryptionService.isAvailable()) {
        valueToStore = this.encryptionService.encrypt(value, tenantId, key);
      }

      // Atomic upsert using INSERT ... ON CONFLICT DO UPDATE
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
          valueType: canonicalIsSecret ? ConfigValueType.SECRET : ConfigValueType.STRING,
          isSecret: canonicalIsSecret,
          isActive: true,
          deletedAt: null,
          deletedBy: null,
          deleteReason: null,
          retentionUntil: null,
          suppressFallback: false,
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
            'deleted_at',
            'deleted_by',
            'delete_reason',
            'retention_until',
            'suppress_fallback',
          ],
          ['tenant_id', 'service', 'key', 'environment'],
        )
        .returning('*')
        .execute();

      // Fetch the full entity to return with proper type
      const saved = await repo.findOneOrFail({
        where: { tenantId, service, key, environment },
      });

      // Record history if value changed (update case, not insert)
      if (existingConfig && existingConfig.value !== valueToStore) {
        const historyRepo = tenantManagerRepo(queryRunner.manager, ConfigurationHistory, tenantId);

        // SECURITY: Redact secret values in history records
        const previousWasSecret =
          existingConfig.isSecret || existingConfig.valueType === ConfigValueType.SECRET;
        const newIsSecret = canonicalIsSecret;
        const previousDisplayValue = previousWasSecret
          ? '[REDACTED]'
          : existingConfig.value;
        const newDisplayValue = newIsSecret ? '[REDACTED]' : value;

        const history = historyRepo.create({
          configurationId: saved.id,
          tenantId,
          service,
          key,
          previousValue: previousDisplayValue,
          newValue: newDisplayValue,
          changedBy: userId || 'system',
          changedAt: new Date(),
          changeReason: command.reason || 'Upsert operation',
        });

        await historyRepo.save(history);

        this.logger.debug(
          `Configuration history recorded for upsert: ${service}/${key}`,
        );
      }

      await queryRunner.commitTransaction();
      this.configurationService.invalidateCache(tenantId, service, key);

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
