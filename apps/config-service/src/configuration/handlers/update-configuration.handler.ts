import {
  Injectable,
  NotFoundException,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { UpdateConfigurationCommand } from '../commands/update-configuration.command';
import {
  Configuration,
  ConfigurationHistory,
  ConfigValueType,
} from '../entities/configuration.entity';
import { ConfigurationService } from '../services/configuration.service';
import { ConfigurationValidationService } from '../services/configuration-validation.service';
import { EncryptionService } from '../services/encryption.service';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

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
  ) {}

  async execute(command: UpdateConfigurationCommand): Promise<Configuration> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const configRepo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);
      const historyRepo = tenantManagerRepo(queryRunner.manager, ConfigurationHistory, tenantId);

      const configuration = await configRepo.findOne({
        where: { id: input.id, tenantId, isActive: true },
      });

      if (!configuration) {
        throw new NotFoundException(`Configuration not found: ${input.id}`);
      }

      const previousValue = configuration.value;
      const previousService = configuration.service;
      const previousKey = configuration.key;
      const previousEnvironment = configuration.environment;
      const explicitlySecret = input.valueType === ConfigValueType.SECRET;
      const explicitlyNonSecret =
        input.valueType !== undefined && input.valueType !== ConfigValueType.SECRET;
      const nextIsSecret = explicitlySecret
        ? true
        : explicitlyNonSecret
          ? false
          : configuration.isSecret;
      const nextValueType = nextIsSecret
        ? ConfigValueType.SECRET
        : input.valueType ??
          (configuration.valueType === ConfigValueType.SECRET
            ? ConfigValueType.STRING
            : configuration.valueType);
      const valueChanged = input.value !== undefined && input.value !== previousValue;

      if (input.value !== undefined) {
        this.validationService.validateValue(input.value, nextValueType);
      }

      if (input.value !== undefined) {
        if (nextIsSecret && this.encryptionService.isAvailable()) {
          configuration.value = this.encryptionService.encrypt(input.value, {
            tenantId: configuration.tenantId,
            service: configuration.service,
            key: configuration.key,
            environment: input.environment ?? configuration.environment,
            classification: nextValueType,
          });
        } else {
          configuration.value = input.value;
        }
      } else if (nextIsSecret && this.encryptionService.isAvailable()) {
        const plaintext = this.encryptionService.isEncrypted(configuration.value)
          ? this.encryptionService.decrypt(configuration.value, {
              tenantId: configuration.tenantId,
              service: configuration.service,
              key: configuration.key,
              environment: configuration.environment,
              classification: configuration.valueType,
            })
          : configuration.value;
        configuration.value = this.encryptionService.encrypt(plaintext, {
          tenantId: configuration.tenantId,
          service: configuration.service,
          key: configuration.key,
          environment: input.environment ?? configuration.environment,
          classification: nextValueType,
        });
      }
      configuration.valueType = nextValueType;
      configuration.isSecret = nextIsSecret;
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
          previousValue: nextIsSecret ? '[REDACTED]' : previousValue,
          newValue: nextIsSecret ? '[REDACTED]' : input.value!,
          changedBy: userId,
          changedAt: new Date(),
          changeReason: input.changeReason,
        });

        await historyRepo.save(history);
      }

      await queryRunner.commitTransaction();

      this.configurationService.invalidateCache(
        tenantId,
        savedConfig.service,
        savedConfig.key,
        savedConfig.environment,
      );
      if (
        previousService !== savedConfig.service ||
        previousKey !== savedConfig.key ||
        previousEnvironment !== savedConfig.environment
      ) {
        this.configurationService.invalidateCache(
          tenantId,
          previousService,
          previousKey,
          previousEnvironment,
        );
      }

      this.logger.log(
        `Configuration updated: ${savedConfig.id} (${configuration.service}/${configuration.key})`,
      );

      return savedConfig;
    } catch (error) {
      await queryRunner.rollbackTransaction();

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
