import {
  Injectable,
  NotFoundException,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { TenantErasureTombstoneError } from '@aquaculture/backend-common/compliance';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { UpdateConfigurationCommand } from '../commands/update-configuration.command';
import {
  Configuration,
  ConfigurationHistory,
  ConfigValueType,
} from '../entities/configuration.entity';
import { emitConfigurationChanged } from '../events/emit-configuration-changed';
import { ConfigurationService } from '../services/configuration.service';
import { ConfigurationValidationService } from '../services/configuration-validation.service';
import { EncryptionService } from '../services/encryption.service';
import { assertTenantConfigurationNotErased } from '../services/configuration-erasure-fence';
import { pinRlsTenantScope } from '../../database/rls-scoped-session';

@Injectable()
@CommandHandler(UpdateConfigurationCommand)
export class UpdateConfigurationHandler
  implements ICommandHandler<UpdateConfigurationCommand, Configuration>
{
  private readonly logger = new Logger(UpdateConfigurationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configurationService: ConfigurationService,
    private readonly validationService: ConfigurationValidationService,
    private readonly encryptionService: EncryptionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: UpdateConfigurationCommand): Promise<Configuration> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      await pinRlsTenantScope(queryRunner, tenantId);
      await assertTenantConfigurationNotErased(queryRunner, tenantId);
      const configRepo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);
      const historyRepo = tenantManagerRepo(queryRunner.manager, ConfigurationHistory, tenantId);

      const configuration = await configRepo.findOne({
        where: { id: input.id, tenantId, isActive: true },
      });

      if (!configuration) {
        throw new NotFoundException(`Configuration not found: ${input.id}`);
      }

      const previousValue = configuration.value;
      const previousWasSecret =
        configuration.valueType === ConfigValueType.SECRET || configuration.isSecret === true;
      const nextValueType =
        input.valueType ?? (previousWasSecret ? ConfigValueType.SECRET : configuration.valueType);
      const nextWillBeSecret = nextValueType === ConfigValueType.SECRET;
      const valueChanged = input.value !== undefined && input.value !== previousValue;
      const downgradesSecret =
        previousWasSecret &&
        input.valueType !== undefined &&
        input.valueType !== ConfigValueType.SECRET;

      if (downgradesSecret && input.value === undefined) {
        throw new BadRequestException(
          'Secret downgrade requires replacement plaintext value in the same request',
        );
      }
      if (
        !previousWasSecret &&
        input.valueType === ConfigValueType.SECRET &&
        input.value === undefined
      ) {
        throw new BadRequestException(
          'Secret upgrade requires plaintext value in the same request',
        );
      }

      if (input.value !== undefined) {
        this.validationService.validateValue(input.value, nextValueType);
        if (nextWillBeSecret && !this.encryptionService.isAvailable()) {
          throw new InternalServerErrorException(
            'Secret configuration writes require CONFIG_ENCRYPTION_KEY',
          );
        }
      }

      // Encrypt new value if this is a secret config
      // PLAT-HIGH-003: Pass tenantId + key as AAD to bind ciphertext to context
      if (input.value !== undefined) {
        if (nextWillBeSecret) {
          configuration.value = this.encryptionService.encrypt(
            input.value,
            configuration.tenantId,
            configuration.key,
          );
        } else {
          configuration.value = input.value;
        }
      }
      configuration.valueType = nextValueType;
      configuration.isSecret = nextWillBeSecret;
      if (input.environment !== undefined) configuration.environment = input.environment;
      if (input.description !== undefined) configuration.description = input.description;
      if (input.isActive !== undefined) configuration.isActive = input.isActive;
      if (input.defaultValue !== undefined) configuration.defaultValue = input.defaultValue;
      if (input.validationRules !== undefined) {
        configuration.validationRules = input.validationRules as Record<string, unknown>;
      }
      if (input.category !== undefined) configuration.category = input.category;
      if (input.tags !== undefined) configuration.tags = input.tags;

      configuration.updatedBy = userId;

      const savedConfig = await configRepo.save(configuration);

      // SECURITY: Redact secret values in history records
      if (valueChanged) {
        const history = historyRepo.create({
          configurationId: configuration.id,
          tenantId,
          service: configuration.service,
          key: configuration.key,
          previousValue: previousWasSecret ? '[REDACTED]' : previousValue,
          newValue: nextWillBeSecret ? '[REDACTED]' : input.value!,
          changedBy: userId,
          changedAt: new Date(),
          changeReason: input.changeReason,
        });

        await historyRepo.save(history);
      }

      // ARCH-MEDIUM-003: emit the change signal atomically with the write.
      await emitConfigurationChanged(
        this.outboxPublisher,
        queryRunner.manager,
        savedConfig,
        userId,
      );

      await queryRunner.commitTransaction();

      this.configurationService.invalidateCache(tenantId, savedConfig.service, savedConfig.key);

      this.logger.log(
        `Configuration updated: ${savedConfig.id} (${configuration.service}/${configuration.key})`,
      );

      return savedConfig;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof TenantErasureTombstoneError) {
        throw error;
      }

      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to update configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to update configuration');
    } finally {
      await queryRunner.release();
    }
  }
}
