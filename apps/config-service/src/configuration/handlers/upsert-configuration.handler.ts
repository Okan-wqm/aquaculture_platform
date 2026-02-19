import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { DataSource } from 'typeorm';
import { UpsertConfigurationCommand } from '../commands/upsert-configuration.command';
import { Configuration, ConfigValueType } from '../entities/configuration.entity';
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

    try {
      const repo = this.dataSource.getRepository(Configuration);

      // Encrypt secret values before storing
      let valueToStore = value;
      if (isSecret && this.encryptionService.isAvailable()) {
        valueToStore = this.encryptionService.encrypt(value);
      }

      // Atomic upsert using INSERT ... ON CONFLICT DO UPDATE
      const result = await repo
        .createQueryBuilder()
        .insert()
        .into(Configuration)
        .values({
          tenantId,
          service,
          key,
          value: valueToStore,
          environment,
          valueType: isSecret ? ConfigValueType.SECRET : ConfigValueType.STRING,
          isSecret,
          isActive: true,
          createdBy: userId,
          updatedBy: userId,
        })
        .orUpdate(
          ['value', 'updated_by', 'updated_at', 'is_active'],
          ['tenant_id', 'service', 'key', 'environment'],
        )
        .returning('*')
        .execute();

      const upsertedConfig = result.generatedMaps[0] as Configuration;

      this.configurationService.invalidateCache(tenantId, service, key);

      this.logger.log(`Configuration upserted: ${service}/${key} for tenant ${tenantId}`);

      // Fetch the full entity to return with proper type
      const saved = await repo.findOneOrFail({
        where: { tenantId, service, key, environment },
      });

      return saved;
    } catch (error) {
      this.logger.error(
        `Failed to upsert configuration: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error instanceof Error ? error.stack : undefined,
      );

      throw new InternalServerErrorException('Failed to upsert configuration');
    }
  }
}
