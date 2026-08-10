import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { VfdCommandAuditLog } from './entities/vfd-command-audit-log.entity';
import { VfdDevice } from './entities/vfd-device.entity';
import { VfdDriveBinding } from './entities/vfd-drive-binding.entity';
import { VfdDriveBindingUnit } from './entities/vfd-drive-binding-unit.entity';
import { VfdReading } from './entities/vfd-reading.entity';
import { VfdRegisterMapping } from './entities/vfd-register-mapping.entity';
import { VfdDeviceResolver, VfdReadingResolver, VfdCommandResolver } from './resolvers';
import { VfdCommandService } from './services/vfd-command.service';
import { VfdConnectionTesterService } from './services/vfd-connection-tester.service';
import { VfdDataReaderService } from './services/vfd-data-reader.service';
import { VfdDeviceService } from './services/vfd-device.service';
import { VfdDriveBindingListener } from './services/vfd-drive-binding.listener';
import { VfdDriveBindingService } from './services/vfd-drive-binding.service';
import { VfdEdgeProvisioningService } from './services/vfd-edge-provisioning.service';
import { VfdEdgeReadService } from './services/vfd-edge-read.service';
import { VfdEdgeWriteService } from './services/vfd-edge-write.service';
import { VfdRegisterMappingService } from './services/vfd-register-mapping.service';

/**
 * VFD (Variable Frequency Drive) Module
 *
 * Provides comprehensive VFD device management including:
 * - Device registration and management
 * - Edge-delegated Modbus communication (all drive I/O runs on the edge gateway via
 *   `read_modbus` / `write_modbus`; the cloud opens no sockets)
 * - Multi-brand support (Danfoss, ABB, Siemens, Schneider, Yaskawa, Delta, Mitsubishi, Rockwell)
 * - Real-time parameter reading
 * - Control commands (Start, Stop, Speed Control, Fault Reset)
 * - Connection testing and validation (edge-delegated; `protocol-config` SSoT)
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      VfdDevice,
      VfdRegisterMapping,
      VfdReading,
      VfdCommandAuditLog,
      VfdDriveBinding,
      VfdDriveBindingUnit,
    ]),
  ],
  providers: [
    // Resolvers
    VfdDeviceResolver,
    VfdReadingResolver,
    VfdCommandResolver,

    // Services
    VfdDeviceService,
    VfdDriveBindingService,
    VfdDriveBindingListener,
    VfdRegisterMappingService,
    VfdDataReaderService,
    VfdCommandService,
    VfdConnectionTesterService,
    VfdEdgeWriteService,
    VfdEdgeReadService,
    VfdEdgeProvisioningService,
  ],
  exports: [
    // Export services for use in other modules
    VfdDeviceService,
    VfdDriveBindingService,
    VfdRegisterMappingService,
    VfdDataReaderService,
    VfdCommandService,
    VfdConnectionTesterService,
    VfdEdgeWriteService,
    VfdEdgeReadService,
    VfdEdgeProvisioningService,
  ],
})
export class VfdModule {}
