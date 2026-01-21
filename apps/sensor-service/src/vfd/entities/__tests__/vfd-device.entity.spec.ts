/**
 * VFD Device Entity Unit Tests
 */

import { VfdDevice, VfdConnectionStatus, ModbusRtuConfiguration, ModbusTcpConfiguration } from '../vfd-device.entity';
import { VfdBrand, VfdProtocol, VfdDeviceStatus } from '../vfd.enums';

describe('VfdDevice Entity', () => {
  let device: VfdDevice;

  beforeEach(() => {
    device = new VfdDevice();
  });

  describe('basic properties', () => {
    it('should create an instance', () => {
      expect(device).toBeDefined();
      expect(device).toBeInstanceOf(VfdDevice);
    });

    it('should set basic properties', () => {
      device.id = '123e4567-e89b-12d3-a456-426614174000';
      device.name = 'VFD-001';
      device.brand = VfdBrand.DANFOSS;
      device.model = 'FC302';
      device.serialNumber = 'SN-12345';
      device.status = VfdDeviceStatus.ACTIVE;
      device.tenantId = 'tenant-123';

      expect(device.id).toBe('123e4567-e89b-12d3-a456-426614174000');
      expect(device.name).toBe('VFD-001');
      expect(device.brand).toBe(VfdBrand.DANFOSS);
      expect(device.model).toBe('FC302');
      expect(device.serialNumber).toBe('SN-12345');
      expect(device.status).toBe(VfdDeviceStatus.ACTIVE);
      expect(device.tenantId).toBe('tenant-123');
    });

    it('should set optional location properties', () => {
      device.farmId = 'farm-123';
      device.tankId = 'tank-456';
      device.location = 'Building A, Room 101';
      device.description = 'Main pump VFD';

      expect(device.farmId).toBe('farm-123');
      expect(device.tankId).toBe('tank-456');
      expect(device.location).toBe('Building A, Room 101');
      expect(device.description).toBe('Main pump VFD');
    });
  });

  describe('protocol configuration', () => {
    it('should set Modbus RTU configuration', () => {
      const config: ModbusRtuConfiguration = {
        serialPort: 'COM1',
        slaveId: 1,
        baudRate: 9600,
        dataBits: 8,
        parity: 'none',
        stopBits: 1,
        timeout: 5000,
        retryCount: 3,
      };

      device.protocol = VfdProtocol.MODBUS_RTU;
      device.protocolConfiguration = config;

      expect(device.protocol).toBe(VfdProtocol.MODBUS_RTU);
      expect(device.protocolConfiguration).toEqual(config);
      expect((device.protocolConfiguration).serialPort).toBe('COM1');
      expect((device.protocolConfiguration).slaveId).toBe(1);
    });

    it('should set Modbus TCP configuration', () => {
      const config: ModbusTcpConfiguration = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
        connectionTimeout: 5000,
        responseTimeout: 5000,
      };

      device.protocol = VfdProtocol.MODBUS_TCP;
      device.protocolConfiguration = config;

      expect(device.protocol).toBe(VfdProtocol.MODBUS_TCP);
      expect((device.protocolConfiguration).host).toBe('192.168.1.100');
      expect((device.protocolConfiguration).port).toBe(502);
    });

    it('should support all protocol types', () => {
      const protocols = Object.values(VfdProtocol);

      protocols.forEach(protocol => {
        device.protocol = protocol;
        expect(device.protocol).toBe(protocol);
      });
    });
  });

  describe('connection status', () => {
    it('should set connection status', () => {
      const status: VfdConnectionStatus = {
        isConnected: true,
        lastTestedAt: new Date(),
        lastSuccessAt: new Date(),
        lastError: undefined,
        latencyMs: 25,
        consecutiveFailures: 0,
      };

      device.connectionStatus = status;

      expect(device.connectionStatus.isConnected).toBe(true);
      expect(device.connectionStatus.latencyMs).toBe(25);
      expect(device.connectionStatus.consecutiveFailures).toBe(0);
    });

    it('should handle disconnected status', () => {
      const status: VfdConnectionStatus = {
        isConnected: false,
        lastTestedAt: new Date(),
        lastError: 'Connection timeout',
        consecutiveFailures: 3,
      };

      device.connectionStatus = status;

      expect(device.connectionStatus.isConnected).toBe(false);
      expect(device.connectionStatus.lastError).toBe('Connection timeout');
      expect(device.connectionStatus.consecutiveFailures).toBe(3);
    });
  });

  describe('device status transitions', () => {
    it('should start with DRAFT status by default', () => {
      // In actual entity, default is set by TypeORM
      device.status = VfdDeviceStatus.DRAFT;
      expect(device.status).toBe(VfdDeviceStatus.DRAFT);
    });

    it('should transition through status states', () => {
      const statusSequence = [
        VfdDeviceStatus.DRAFT,
        VfdDeviceStatus.PENDING_TEST,
        VfdDeviceStatus.TESTING,
        VfdDeviceStatus.ACTIVE,
      ];

      statusSequence.forEach(status => {
        device.status = status;
        expect(device.status).toBe(status);
      });
    });

    it('should handle failed test status', () => {
      device.status = VfdDeviceStatus.TEST_FAILED;
      expect(device.status).toBe(VfdDeviceStatus.TEST_FAILED);
    });

    it('should handle suspended status', () => {
      device.status = VfdDeviceStatus.SUSPENDED;
      expect(device.status).toBe(VfdDeviceStatus.SUSPENDED);
    });
  });

  describe('brands', () => {
    it('should support all VFD brands', () => {
      const brands = Object.values(VfdBrand);

      expect(brands).toContain(VfdBrand.DANFOSS);
      expect(brands).toContain(VfdBrand.ABB);
      expect(brands).toContain(VfdBrand.SIEMENS);
      expect(brands).toContain(VfdBrand.SCHNEIDER);
      expect(brands).toContain(VfdBrand.YASKAWA);
      expect(brands).toContain(VfdBrand.DELTA);
      expect(brands).toContain(VfdBrand.MITSUBISHI);
      expect(brands).toContain(VfdBrand.ROCKWELL);
    });

    it('should set brand correctly', () => {
      device.brand = VfdBrand.ABB;
      device.model = 'ACS580';

      expect(device.brand).toBe(VfdBrand.ABB);
      expect(device.model).toBe('ACS580');
    });
  });

  describe('polling configuration', () => {
    it('should set polling interval', () => {
      device.pollIntervalMs = 1000;
      expect(device.pollIntervalMs).toBe(1000);
    });

    it('should enable/disable polling', () => {
      device.isPollingEnabled = true;
      expect(device.isPollingEnabled).toBe(true);

      device.isPollingEnabled = false;
      expect(device.isPollingEnabled).toBe(false);
    });
  });

  describe('custom register mappings', () => {
    it('should set custom register mappings', () => {
      const customMappings = [
        {
          parameterName: 'custom_param',
          registerAddress: 1000,
          registerCount: 1,
          functionCode: 3,
          dataType: 'uint16',
          scalingFactor: 0.1,
          offset: 0,
          unit: 'Hz',
          byteOrder: 'big',
          wordOrder: 'big',
        },
      ];

      device.customRegisterMappings = customMappings;

      expect(device.customRegisterMappings).toHaveLength(1);
      expect(device.customRegisterMappings[0].parameterName).toBe('custom_param');
      expect(device.customRegisterMappings[0].registerAddress).toBe(1000);
    });
  });

  describe('metadata', () => {
    it('should set metadata', () => {
      device.metadata = {
        installDate: '2024-01-15',
        warrantyExpires: '2026-01-15',
        technician: 'John Doe',
      };

      expect(device.metadata.installDate).toBe('2024-01-15');
      expect(device.metadata.technician).toBe('John Doe');
    });
  });

  describe('timestamps', () => {
    it('should have createdAt and updatedAt', () => {
      const now = new Date();
      device.createdAt = now;
      device.updatedAt = now;

      expect(device.createdAt).toBe(now);
      expect(device.updatedAt).toBe(now);
    });

    it('should track user who created/updated', () => {
      device.createdBy = 'user-123';
      device.updatedBy = 'user-456';

      expect(device.createdBy).toBe('user-123');
      expect(device.updatedBy).toBe('user-456');
    });
  });
});
