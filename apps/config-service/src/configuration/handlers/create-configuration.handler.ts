import {
  Injectable,
  ConflictException,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import { CreateConfigurationCommand } from '../commands/create-configuration.command';
import { Configuration, ConfigValueType } from '../entities/configuration.entity';
import { emitConfigurationChanged } from '../events/emit-configuration-changed';
import { ConfigurationService } from '../services/configuration.service';
import { ConfigurationValidationService } from '../services/configuration-validation.service';
import { EncryptionService } from '../services/encryption.service';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

@Injectable()
@CommandHandler(CreateConfigurationCommand)
export class CreateConfigurationHandler
  implements ICommandHandler<CreateConfigurationCommand, Configuration>
{
  private readonly logger = new Logger(CreateConfigurationHandler.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly configurationService: ConfigurationService,
    private readonly validationService: ConfigurationValidationService,
    private readonly encryptionService: EncryptionService,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  async execute(command: CreateConfigurationCommand): Promise<Configuration> {
    const { tenantId, input, userId } = command;

    this.validationService.validateValue(input.value, input.valueType, input.validationRules);

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('READ COMMITTED');

    try {
      const configRepo = tenantManagerRepo(queryRunner.manager, Configuration, tenantId);

      const existing = await configRepo.findOne({
        where: {
          tenantId,
          service: input.service,
          key: input.key,
          environment: input.environment,
        },
      });

      if (existing) {
        throw new ConflictException(
          `Configuration already exists: ${input.service}/${input.key} for environment ${input.environment}`,
        );
      }

      const isSecret = input.valueType === ConfigValueType.SECRET || input.isSecret === true;

      // Encrypt secret values before saving
      // PLAT-HIGH-003: Pass tenantId + key as AAD to bind ciphertext to context
      let valueToStore = input.value;
      if (isSecret && this.encryptionService.isAvailable()) {
        valueToStore = this.encryptionService.encrypt(input.value, tenantId, input.key);
      }

      const configuration = configRepo.create({
        tenantId,
        service: input.service,
        key: input.key,
        value: valueToStore,
        valueType: isSecret ? ConfigValueType.SECRET : input.valueType,
        environment: input.environment,
        description: input.description,
        isSecret,
        defaultValue: input.defaultValue,
        validationRules: input.validationRules as Record<string, unknown>,
        category: input.category,
        tags: input.tags,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedConfig = await configRepo.save(configuration);

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
        `Configuration created: ${savedConfig.id} (${input.service}/${input.key}) for tenant ${tenantId}`,
      );

      return savedConfig;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      if (error instanceof ConflictException || error instanceof BadRequestException) {
        throw error;
      }

      this.logger.error(
        `Failed to create configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to create configuration');
    } finally {
      await queryRunner.release();
    }
  }
}
