import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

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
// Faz C (D6): trusted NATS read surface for effective config (incl. decrypted secrets).
import { ConfigRuntimeNatsHandler } from './handlers/config-runtime-nats.handler';
import { MarineProviderCredentialsNatsHandler } from './handlers/marine-provider-credentials-nats.handler';

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
  imports: [TypeOrmModule.forFeature([Configuration, ConfigurationHistory])],
  // ConfigRuntimeNatsHandler is a @Controller so the NATS microservice
  // transport registers its @MessagePattern subscribers (config.runtime.*).
  controllers: [ConfigRuntimeNatsHandler, MarineProviderCredentialsNatsHandler],
  providers: [
    ConfigurationResolver,
    ConfigurationService,
    EncryptionService,
    ConfigurationValidationService,
    // SecurityEventService emits real-time alerts on config-runtime denials.
    // Degrades gracefully when EVENT_BUS is unavailable (its own @Optional inject).
    SecurityEventService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
})
export class ConfigurationModule {}
