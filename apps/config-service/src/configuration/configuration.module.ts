import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CqrsModule } from '@nestjs/cqrs';

// Entities
import { Configuration, ConfigurationHistory } from './entities/configuration.entity';

// Resolver
import { ConfigurationResolver } from './configuration.resolver';

// Command Handlers
import { CreateConfigurationHandler } from './handlers/create-configuration.handler';
import { UpdateConfigurationHandler } from './handlers/update-configuration.handler';
import { DeleteConfigurationHandler } from './handlers/delete-configuration.handler';

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

// Services
import { ConfigurationService } from './services/configuration.service';

const CommandHandlers = [
  CreateConfigurationHandler,
  UpdateConfigurationHandler,
  DeleteConfigurationHandler,
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
    ...CommandHandlers,
    ...QueryHandlers,
  ],
  exports: [ConfigurationService],
})
export class ConfigurationModule {}
