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
import { Configuration, ConfigurationHistory } from '../entities/configuration.entity';
import { ConfigurationService } from '../services/configuration.service';
import { ConfigurationValidationService } from '../services/configuration-validation.service';
import { EncryptionService } from '../services/encryption.service';

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
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (config-service): Phase B tenantManagerRepo migration backlog — Configuration writes inside transaction
      const configRepo = queryRunner.manager.getRepository(Configuration);
      // eslint-disable-next-line no-restricted-syntax -- AUDIT-MEDIUM-014 (config-service): Phase B tenantManagerRepo migration backlog — ConfigurationHistory audit row
      const historyRepo = queryRunner.manager.getRepository(ConfigurationHistory);

      const configuration = await configRepo.findOne({
        where: { id: input.id, tenantId, isActive: true },
      });

      if (!configuration) {
        throw new NotFoundException(`Configuration not found: ${input.id}`);
      }

      const previousValue = configuration.value;
      const valueChanged = input.value !== undefined && input.value !== previousValue;

      if (input.value !== undefined) {
        const valueType = input.valueType || configuration.valueType;
        this.validationService.validateValue(input.value, valueType);
      }

      // Encrypt new value if this is a secret config
      // PLAT-HIGH-003: Pass tenantId + key as AAD to bind ciphertext to context
      if (input.value !== undefined) {
        if (configuration.isSecret && this.encryptionService.isAvailable()) {
          configuration.value = this.encryptionService.encrypt(input.value, configuration.tenantId, configuration.key);
        } else {
          configuration.value = input.value;
        }
      }
      if (input.valueType !== undefined) configuration.valueType = input.valueType;
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
          previousValue: configuration.isSecret ? '[REDACTED]' : previousValue,
          newValue: configuration.isSecret ? '[REDACTED]' : input.value!,
          changedBy: userId,
          changedAt: new Date(),
          changeReason: input.changeReason,
        });

        await historyRepo.save(history);
      }

      await queryRunner.commitTransaction();

      this.configurationService.invalidateCache(tenantId, savedConfig.service, savedConfig.key);

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
