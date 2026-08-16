import { SecurityEventService } from '@aquaculture/backend-common/security';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Configuration, ConfigurationHistory } from './entities/configuration.entity';
import {
  ConfigurationChangeJournal,
  ConfigurationOperationReceipt,
  ConfigurationScope,
} from './entities/configuration-operation.entity';

// Resolver
import { ConfigurationResolver } from './configuration.resolver';

// Services
import { ConfigurationService } from './services/configuration.service';
import { EncryptionService } from './services/encryption.service';
import { ConfigurationBatchAuthorityService } from './services/configuration-batch-authority.service';
import { ConfigurationSnapshotService } from './services/configuration-snapshot.service';

// Command Handlers
import { ApplyConfigurationBatchHandler } from './handlers/apply-configuration-batch.handler';
// Faz C (D6): trusted NATS read surface for effective config (incl. decrypted secrets).
import { ConfigRuntimeNatsHandler } from './handlers/config-runtime-nats.handler';
import { MarineProviderCredentialsNatsHandler } from './handlers/marine-provider-credentials-nats.handler';

// Query Handlers
import { GetConfigurationSnapshotHandler } from './query-handlers/get-configuration-snapshot.handler';

const CommandHandlers = [ApplyConfigurationBatchHandler];

const QueryHandlers = [GetConfigurationSnapshotHandler];

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Configuration,
      ConfigurationHistory,
      ConfigurationScope,
      ConfigurationOperationReceipt,
      ConfigurationChangeJournal,
    ]),
  ],
  // ConfigRuntimeNatsHandler is a @Controller so the NATS microservice
  // transport registers its @MessagePattern subscribers (config.runtime.*).
  controllers: [ConfigRuntimeNatsHandler, MarineProviderCredentialsNatsHandler],
  providers: [
    ConfigurationResolver,
    ConfigurationService,
    EncryptionService,
    ConfigurationSnapshotService,
    ConfigurationBatchAuthorityService,
    // SecurityEventService emits real-time alerts on config-runtime denials.
    // Degrades gracefully when EVENT_BUS is unavailable (its own @Optional inject).
    SecurityEventService,
    ...CommandHandlers,
    ...QueryHandlers,
  ],
})
export class ConfigurationModule {}
