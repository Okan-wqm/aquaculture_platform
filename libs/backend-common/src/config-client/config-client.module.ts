import { DynamicModule, Module } from '@nestjs/common';
import { ClientsModule } from '@nestjs/microservices';

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
    return {
      module: ConfigClientModule,
      imports: [
        ClientsModule.register([
          {
            name: CONFIG_NATS_CLIENT,
            customClass: NatsV3Client,
            options: { serviceName: options.consumerService },
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
