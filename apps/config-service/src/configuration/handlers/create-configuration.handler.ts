import {
  Injectable,
  ConflictException,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource, QueryRunner } from 'typeorm';
import { CreateConfigurationCommand } from '../commands/create-configuration.command';
import { Configuration, ConfigValueType } from '../entities/configuration.entity';

@Injectable()
@CommandHandler(CreateConfigurationCommand)
export class CreateConfigurationHandler
  implements ICommandHandler<CreateConfigurationCommand, Configuration>
{
  private readonly logger = new Logger(CreateConfigurationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: CreateConfigurationCommand): Promise<Configuration> {
    const { tenantId, input, userId } = command;

    // Validate value based on type
    this.validateValue(input.value, input.valueType);

    // Create query runner for transaction
    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const configRepo = queryRunner.manager.getRepository(Configuration);

      // Check for existing configuration with same service/key/environment
      const existing = await configRepo.findOne({
        where: {
          tenantId,
          service: input.service,
          key: input.key,
          environment: input.environment,
        },
        lock: { mode: 'pessimistic_write' },
      });

      if (existing) {
        throw new ConflictException(
          `Configuration already exists: ${input.service}/${input.key} for environment ${input.environment}`,
        );
      }

      // Create configuration
      const configuration = configRepo.create({
        tenantId,
        service: input.service,
        key: input.key,
        value: input.value,
        valueType: input.valueType,
        environment: input.environment,
        description: input.description,
        isSecret: input.isSecret,
        defaultValue: input.defaultValue,
        validationRules: input.validationRules as Record<string, unknown>,
        category: input.category,
        tags: input.tags,
        isActive: true,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedConfig = await configRepo.save(configuration);

      await queryRunner.commitTransaction();

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

  private validateValue(value: string, valueType: ConfigValueType): void {
    switch (valueType) {
      case ConfigValueType.NUMBER:
        if (isNaN(Number(value))) {
          throw new BadRequestException('Value must be a valid number');
        }
        break;
      case ConfigValueType.BOOLEAN:
        if (!['true', 'false', '1', '0'].includes(value.toLowerCase())) {
          throw new BadRequestException('Value must be true/false or 1/0');
        }
        break;
      case ConfigValueType.JSON:
        try {
          JSON.parse(value);
        } catch {
          throw new BadRequestException('Value must be valid JSON');
        }
        break;
    }
  }
}
