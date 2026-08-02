import { DynamicModule, Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX } from '@platform/event-contracts';

import { NatsV3Client } from '../nats/nats-v3-client.proxy';

import {
  MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
  MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE_TOKEN,
  MARINE_PROVIDER_CREDENTIAL_NATS_CLIENT,
  MarineProviderCredentialClient,
} from './marine-provider-credential.client';

/**
 * Farm-only client module. A fixed service identity makes it impossible for a
 * different runtime to import this module and self-declare access to the
 * secret-returning inbox.
 */
@Module({})
export class MarineProviderCredentialClientModule {
  static forFarmService(): DynamicModule {
    return {
      module: MarineProviderCredentialClientModule,
      imports: [
        ClientsModule.register([
          {
            name: MARINE_PROVIDER_CREDENTIAL_NATS_CLIENT,
            customClass: NatsV3Client,
            options: {
              serviceName: MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
              inboxPrefix: MARINE_PROVIDER_CREDENTIAL_INBOX_PREFIX,
            },
          },
        ]),
      ],
      providers: [
        {
          provide: MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE_TOKEN,
          useValue: MARINE_PROVIDER_CREDENTIAL_CONSUMER_SERVICE,
        },
        MarineProviderCredentialClient,
      ],
      exports: [MarineProviderCredentialClient],
    };
  }
}
