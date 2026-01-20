/**
 * VFD DTOs - Data Transfer Objects
 *
 * This module exports all DTOs for VFD (Variable Frequency Drive) operations
 * including registration, updates, commands, readings, and filtering.
 */

// Registration DTOs
export {
  RegisterVfdDto,
  VfdRegistrationResponseDto,
} from './register-vfd.dto';

// Update DTOs
export {
  UpdateVfdDto,
  UpdateVfdConnectionStatusDto,
  BulkUpdateVfdStatusDto,
} from './update-vfd.dto';

// Protocol Configuration DTOs
export {
  ModbusRtuConfigDto,
  ModbusTcpConfigDto,
  ProfinetConfigDto,
  EthernetIpConfigDto,
  CanopenConfigDto,
  BacnetIpConfigDto,
  BacnetMstpConfigDto,
  ProfibusDpConfigDto,
  ProtocolConfigurationDto,
  TestVfdConnectionConfigDto,
} from './protocol-config.dto';

// Command DTOs
export {
  VfdCommandDto,
  SetVfdFrequencyDto,
  SetVfdSpeedDto,
  VfdCommandResultDto,
  VfdCommandStatusDto,
  BatchVfdCommandDto,
  BatchVfdCommandResultDto,
  EmergencyStopDto,
  WriteControlWordDto,
} from './vfd-command.dto';

// Reading DTOs
export {
  VfdParametersDto,
  VfdStatusBitsDto,
  VfdReadingDto,
  VfdReadingsQueryDto,
  VfdReadingStatsDto,
  VfdReadingStatsQueryDto,
  VfdLatestReadingsDto,
  PaginatedVfdReadingsDto,
} from './vfd-reading.dto';

// Filter and Pagination DTOs
export {
  VfdDeviceFilterDto,
  VfdPaginationDto,
  VfdDeviceDto,
  VfdConnectionStatusDto,
  PaginatedVfdDevicesDto,
  VfdDeviceCountByStatusDto,
  ConnectionTestResultDto,
  VfdBrandInfoDto,
  VfdProtocolSchemaDto,
  VfdProtocolFieldDto,
} from './vfd-filter.dto';
