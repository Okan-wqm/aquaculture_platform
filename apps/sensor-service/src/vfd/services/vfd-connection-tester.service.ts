import { Injectable, Logger } from '@nestjs/common';

import {
  createVfdAdapter,
  ConnectionTestResult,
  ValidationResult,
  getProtocolInfoList,
} from '../adapters';
import { VfdProtocol, VfdBrand, VfdDeviceStatus } from '../entities/vfd.enums';

import { VfdDeviceService } from './vfd-device.service';
import { VfdRegisterMappingService } from './vfd-register-mapping.service';

/**
 * Test connection input
 */
export interface TestConnectionInput {
  protocol: VfdProtocol;
  configuration: Record<string, unknown>;
  brand?: VfdBrand;
}

/**
 * Extended test result with device info
 */
export interface ExtendedTestResult extends ConnectionTestResult {
  protocol: VfdProtocol;
  configuration: Record<string, unknown>;
  testedAt: Date;
  parameters?: Record<string, number>;
}

/**
 * VFD Connection Tester Service
 * Handles testing connections to VFD devices
 */
@Injectable()
export class VfdConnectionTesterService {
  private readonly logger = new Logger(VfdConnectionTesterService.name);

  constructor(
    private readonly vfdDeviceService: VfdDeviceService,
    private readonly registerMappingService: VfdRegisterMappingService
  ) {}

  /**
   * Test a connection configuration
   */
  async testConnection(input: TestConnectionInput): Promise<ExtendedTestResult> {
    this.logger.log(`Testing ${input.protocol} connection`);

    const adapter = createVfdAdapter(input.protocol);

    // First validate configuration
    const validation = adapter.validateConfiguration(input.configuration);
    if (!validation.valid) {
      return {
        success: false,
        error: `Configuration validation failed: ${validation.errors.join(', ')}`,
        protocol: input.protocol,
        configuration: input.configuration,
        testedAt: new Date(),
      };
    }

    try {
      // Test the connection
      const result = await adapter.testConnection(input.configuration);

      // If brand is specified and test was successful, try to read some parameters
      let parameters: Record<string, number> | undefined;
      if (result.success && input.brand) {
        try {
          parameters = await this.readSampleParameters(
            input.protocol,
            input.configuration,
            input.brand
          );
        } catch (error) {
          this.logger.warn('Failed to read sample parameters', error);
        }
      }

      return {
        ...result,
        protocol: input.protocol,
        configuration: input.configuration,
        testedAt: new Date(),
        parameters,
      };
    } catch (error) {
      this.logger.error('Connection test failed', error);
      return {
        success: false,
        error: (error as Error).message,
        protocol: input.protocol,
        configuration: input.configuration,
        testedAt: new Date(),
      };
    }
  }

  /**
   * Test connection for an existing device
   */
  async testDeviceConnection(
    deviceId: string,
    tenantId: string
  ): Promise<ExtendedTestResult> {
    const device = await this.vfdDeviceService.findById(deviceId, tenantId);

    const result = await this.testConnection({
      protocol: device.protocol,
      configuration: device.protocolConfiguration as unknown as Record<string, unknown>,
      brand: device.brand,
    });

    // Update device connection status
    await this.vfdDeviceService.updateConnectionStatus(deviceId, tenantId, {
      isConnected: result.success,
      lastTestedAt: result.testedAt,
      lastError: result.error,
      latencyMs: result.latencyMs,
    });

    // Update device status if needed
    if (result.success && device.status === VfdDeviceStatus.DRAFT) {
      await this.vfdDeviceService.updateStatus(deviceId, tenantId, VfdDeviceStatus.TESTING);
    } else if (!result.success && device.status === VfdDeviceStatus.TESTING) {
      await this.vfdDeviceService.updateStatus(deviceId, tenantId, VfdDeviceStatus.TEST_FAILED);
    }

    return result;
  }

  /**
   * Validate protocol configuration without testing connection
   */
  validateConfiguration(
    protocol: VfdProtocol,
    configuration: Record<string, unknown>
  ): ValidationResult {
    const adapter = createVfdAdapter(protocol);
    return adapter.validateConfiguration(configuration);
  }

  /**
   * Get configuration schema for a protocol
   */
  getProtocolSchema(protocol: VfdProtocol): Record<string, unknown> {
    const adapter = createVfdAdapter(protocol);
    return adapter.getConfigurationSchema();
  }

  /**
   * Get default configuration for a protocol
   */
  getDefaultConfiguration(protocol: VfdProtocol): Record<string, unknown> {
    const adapter = createVfdAdapter(protocol);
    return adapter.getDefaultConfiguration();
  }

  /**
   * Get all supported protocols with their info
   */
  getSupportedProtocols(): ReturnType<typeof getProtocolInfoList> {
    return getProtocolInfoList();
  }

  /**
   * Discover devices on a network (for protocols that support discovery)
   */
  async discoverDevices(
    protocol: VfdProtocol,
    discoveryParams: Record<string, unknown>
  ): Promise<Array<{
    address: string;
    deviceInfo?: Record<string, unknown>;
  }>> {
    this.logger.log(`Discovering devices on ${protocol}`);

    // Device discovery is protocol-specific
    // For now, return empty array - discovery would be implemented per protocol
    switch (protocol) {
      case VfdProtocol.MODBUS_TCP:
        // Could scan IP range for Modbus TCP devices
        return [];

      case VfdProtocol.PROFINET:
        // Could use DCP protocol for PROFINET device discovery
        return [];

      case VfdProtocol.ETHERNET_IP:
        // Could use List Identity request for EtherNet/IP
        return [];

      case VfdProtocol.BACNET_IP:
        // Could use Who-Is/I-Am for BACnet discovery
        return [];

      default:
        return [];
    }
  }

  /**
   * Read sample parameters from a device (for verification)
   */
  private async readSampleParameters(
    protocol: VfdProtocol,
    configuration: Record<string, unknown>,
    brand: VfdBrand
  ): Promise<Record<string, number>> {
    const adapter = createVfdAdapter(protocol);
    const handle = await adapter.connect(configuration);

    try {
      // Get critical parameters for the brand
      const mappings = await this.registerMappingService.getCriticalMappings(brand);

      // Limit to first 5 parameters for sample read
      const sampleMappings = mappings.slice(0, 5);

      const result = await adapter.readParameters(handle, sampleMappings);

      // Convert to simple key-value record
      const parameters: Record<string, number> = {};
      for (const [key, value] of Object.entries(result.parameters)) {
        if (typeof value === 'number') {
          parameters[key] = value;
        }
      }

      return parameters;
    } finally {
      await adapter.disconnect(handle);
    }
  }
}
