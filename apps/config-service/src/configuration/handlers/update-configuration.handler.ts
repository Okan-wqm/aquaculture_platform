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

@Injectable()
@CommandHandler(UpdateConfigurationCommand)
export class UpdateConfigurationHandler
  implements ICommandHandler<UpdateConfigurationCommand, Configuration>
{
  private readonly logger = new Logger(UpdateConfigurationHandler.name);

  constructor(private readonly dataSource: DataSource) {}

  async execute(command: UpdateConfigurationCommand): Promise<Configuration> {
    const { tenantId, input, userId } = command;

    const queryRunner: QueryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');

    try {
      const configRepo = queryRunner.manager.getRepository(Configuration);
      const historyRepo = queryRunner.manager.getRepository(ConfigurationHistory);

      // Find existing configuration with lock
      const configuration = await configRepo.findOne({
        where: { id: input.id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });

      if (!configuration) {
        throw new NotFoundException(`Configuration not found: ${input.id}`);
      }

      // Store previous value for history
      const previousValue = configuration.value;
      const valueChanged = input.value !== undefined && input.value !== previousValue;

      // Validate new value if provided
      if (input.value !== undefined) {
        const valueType = input.valueType || configuration.valueType;
        this.validateValue(input.value, valueType);
      }

      // Update fields
      if (input.value !== undefined) configuration.value = input.value;
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

      // Save updated configuration
      const savedConfig = await configRepo.save(configuration);

      // Create history record if value changed
      if (valueChanged) {
        const history = historyRepo.create({
          configurationId: configuration.id,
          tenantId,
          service: configuration.service,
          key: configuration.key,
          previousValue,
          newValue: input.value!,
          changedBy: userId,
          changedAt: new Date(),
          changeReason: input.changeReason,
        });

        await historyRepo.save(history);
      }

      await queryRunner.commitTransaction();

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
