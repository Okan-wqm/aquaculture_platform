import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Configuration, ConfigurationHistory } from './entities/configuration.entity';

// Resolver
import { ConfigurationResolver } from './configuration.resolver';

// Services
import { ConfigurationService } from './services/configuration.service';
import { EncryptionService } from './services/encryption.service';
import { ConfigurationValidationService } from './services/configuration-validation.service';

// Command Handlers
import { CreateConfigurationHandler } from './handlers/create-configuration.handler';
import { UpdateConfigurationHandler } from './handlers/update-configuration.handler';
import { DeleteConfigurationHandler } from './handlers/delete-configuration.handler';
import { UpsertConfigurationHandler } from './handlers/upsert-configuration.handler';

// Query Handlers
import {
  GetConfigurationHandler,
  GetConfigurationByIdHandler,
} from './query-handlers/get-configuration.handler';
import {
  GetConfigurationsHandler,
  GetConfigurationsByServiceHandler,
  GetConfigurationHistoryHandler,
} from './query-handlers/get-configurations.handler';

const CommandHandlers = [
  CreateConfigurationHandler,
  UpdateConfigurationHandler,
  DeleteConfigurationHandler,
  UpsertConfigurationHandler,
];

const QueryHandlers = [
  GetConfigurationHandler,
  GetConfigurationByIdHandler,
  GetConfigurationsHandler,
  GetConfigurationsByServiceHandler,
  GetConfigurationHistoryHandler,
];

@Module({
  imports: [
    TypeOrmModule.forFeature([Configuration, ConfigurationHistory]),
    CqrsModule,
  ],
  providers: [
    ConfigurationResolver,
    ConfigurationService,
    EncryptionService,
    ConfigurationValidationService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
})
export class ConfigurationModule {}
