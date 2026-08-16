import { DynamicModule, Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';
import { CONFIG_RUNTIME_ACCESS_BY_CONSUMER } from '@platform/event-contracts';

import { NatsV3Client } from '../nats/nats-v3-client.proxy';

import {
  CONFIG_NATS_CLIENT,
  CONFIG_RUNTIME_CONSUMER_SERVICE,
  ConfigRuntimeClient,
} from './config-runtime.client';

/**
 * ConfigClientModule — wires the ConfigRuntimeClient over a platform-owned
 * NatsV3Client ClientProxy (the same v3 proxy admin-api uses for BILLING_NATS_CLIENT).
 *
 * Reusable primitive: any service that must read config-service's *effective*
 * configuration (including decrypted secrets on the trusted path) imports
 * `ConfigClientModule.forRoot({ consumerService: '<its-service-id>' })`. The
 * consumerService is bound BOTH as the NatsV3Client's mTLS cert identity and as
 * the ServiceIdentity `X-Service-Identity` the ConfigRuntimeClient signs with,
 * so the NATS cert-CN allowlist and the HMAC caller allowlist agree.
 */
@Module({})
export class ConfigClientModule {
  static forRoot(options: { consumerService: string }): DynamicModule {
    const access = CONFIG_RUNTIME_ACCESS_BY_CONSUMER[options.consumerService];
    if (access === undefined) {
      throw new Error(
        `Configuration consumer ${options.consumerService} is absent from the signed catalog projection`,
      );
    }
    return {
      module: ConfigClientModule,
      imports: [
        ClientsModule.register([
          {
            name: CONFIG_NATS_CLIENT,
            customClass: NatsV3Client,
            // SEC-CRITICAL-001: scoped reply inbox so the decrypted secret never
            // returns on the platform-wide `_INBOX.>` that every service cert
            // subscribes. Only billing subscribes / config publishes this token.
            options: {
              serviceName: options.consumerService,
              inboxPrefix: access.replyInboxPrefix,
            },
          },
        ]),
      ],
      providers: [
        {
          provide: CONFIG_RUNTIME_CONSUMER_SERVICE,
          useValue: options.consumerService,
        },
        ConfigRuntimeClient,
      ],
      exports: [ConfigRuntimeClient],
    };
  }
}
