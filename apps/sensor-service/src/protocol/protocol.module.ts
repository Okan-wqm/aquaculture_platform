import { Module, Global, DynamicModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { SensorProtocol } from '../database/entities/sensor-protocol.entity';
import { PROTOCOL_ADAPTERS } from './adapters/protocol-adapters.registry';
import { ProtocolResolver } from './resolvers/protocol.resolver';
import { ConnectionTesterService } from './services/connection-tester.service';
import { ProtocolRegistryService } from './services/protocol-registry.service';
import { ProtocolValidatorService } from './services/protocol-validator.service';

// Re-export for backward compatibility
export { PROTOCOL_ADAPTERS } from './adapters/protocol-adapters.registry';

/**
 * Protocol Module
 * Provides protocol adapters for connecting to various sensor devices
 */
@Global()
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([SensorProtocol]),
  ],
  providers: [
    // All protocol adapters (classes)
    ...PROTOCOL_ADAPTERS,

    // Services
    ProtocolRegistryService,
    ProtocolValidatorService,
    ConnectionTesterService,

    // Resolver
    ProtocolResolver,
  ],
  exports: [
    ProtocolRegistryService,
    ProtocolValidatorService,
    ConnectionTesterService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class ProtocolModule {
  /**
   * Static forRoot method for module registration
   * Required for dynamic module pattern used in app.module.ts
   */
  static forRoot(): DynamicModule {
    return {
      module: ProtocolModule,
      global: true,
    };
  }

  /**
   * Get all available adapter types
   */
  static getAdapterTypes(): typeof PROTOCOL_ADAPTERS {
    return PROTOCOL_ADAPTERS;
  }
}
