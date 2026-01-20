import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { VfdDevice } from './entities/vfd-device.entity';
import { VfdRegisterMapping } from './entities/vfd-register-mapping.entity';
import { VfdReading } from './entities/vfd-reading.entity';

// Services
import { VfdDeviceService } from './services/vfd-device.service';
import { VfdRegisterMappingService } from './services/vfd-register-mapping.service';
import { VfdDataReaderService } from './services/vfd-data-reader.service';
import { VfdCommandService } from './services/vfd-command.service';
import { VfdConnectionTesterService } from './services/vfd-connection-tester.service';

// Resolvers
import { VfdDeviceResolver } from './resolvers/vfd-device.resolver';
import { VfdReadingResolver } from './resolvers/vfd-reading.resolver';
import { VfdCommandResolver } from './resolvers/vfd-command.resolver';

// Adapters
import { VfdModbusRtuAdapter } from './adapters/vfd-modbus-rtu.adapter';
import { VfdModbusTcpAdapter } from './adapters/vfd-modbus-tcp.adapter';
import { VfdProfibusAdapter } from './adapters/vfd-profibus-dp.adapter';
import { VfdProfinetAdapter } from './adapters/vfd-profinet.adapter';
import { VfdEthernetIpAdapter } from './adapters/vfd-ethernet-ip.adapter';
import { VfdCanopenAdapter } from './adapters/vfd-canopen.adapter';
import { VfdBacnetAdapter } from './adapters/vfd-bacnet.adapter';

/**
 * VFD (Variable Frequency Drive) Module
 *
 * Provides comprehensive VFD device management including:
 * - Device registration and management
 * - Multi-protocol communication (Modbus RTU/TCP, PROFIBUS, PROFINET, EtherNet/IP, CANopen, BACnet)
 * - Multi-brand support (Danfoss, ABB, Siemens, Schneider, Yaskawa, Delta, Mitsubishi, Rockwell)
 * - Real-time parameter reading
 * - Control commands (Start, Stop, Speed Control, Fault Reset)
 * - Connection testing and validation
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      VfdDevice,
      VfdRegisterMapping,
      VfdReading,
    ]),
  ],
  providers: [
    // Services
    VfdDeviceService,
    VfdRegisterMappingService,
    VfdDataReaderService,
    VfdCommandService,
    VfdConnectionTesterService,

    // Resolvers - Temporarily disabled due to schema-first vs code-first GraphQL issues
    // TODO: Convert these resolvers to code-first approach
    // VfdDeviceResolver,
    // VfdReadingResolver,
    // VfdCommandResolver,

    // Protocol Adapters
    VfdModbusRtuAdapter,
    VfdModbusTcpAdapter,
    VfdProfibusAdapter,
    VfdProfinetAdapter,
    VfdEthernetIpAdapter,
    VfdCanopenAdapter,
    VfdBacnetAdapter,
  ],
  exports: [
    // Export services for use in other modules
    VfdDeviceService,
    VfdRegisterMappingService,
    VfdDataReaderService,
    VfdCommandService,
    VfdConnectionTesterService,
  ],
})
export class VfdModule {}
