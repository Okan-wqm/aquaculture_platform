 
 
 
 
 
/**
 * VFD Modbus TCP Adapter Unit Tests
 *
 * Mocking layers:
 *  - `net` — the adapter speaks RAW MBAP-framed TCP (the old modbus-serial
 *    mock was vestigial and every I/O test attempted a real socket).
 *    FakeModbusSocket answers FC3/FC4 reads with 0x01f4 per register and
 *    echoes FC6 writes, exercising the adapter's real frame builder/parser.
 *  - SsrfValidatorService.validateHost — the deliberate pre-connect SSRF
 *    guard (SVD-HIGH-001) denies the RFC-1918 test address; tests stub the
 *    prototype method (the adapter's instance is a field initializer, not
 *    injectable) to an allow verdict, and re-enable it where the guard
 *    itself is under test. The PRODUCTION guard is untouched.
 */

import { SsrfValidatorService } from '@aquaculture/backend-common/ai-safety';

import { VfdProtocol } from '../../entities/vfd.enums';
import { VfdModbusTcpAdapter } from '../vfd-modbus-tcp.adapter';

jest.mock('net', () => {
  // Only Socket is faked — the SSRF validator's isIPv4/isIPv6 and every
  // other `net` export stay real.
  const actualNet = jest.requireActual<typeof import('net')>('net');
  const { EventEmitter } = jest.requireActual<typeof import('events')>('events');

  class FakeModbusSocket extends EventEmitter {
    setNoDelay(): void {}
    setKeepAlive(): void {}
    connect(_port: number, _host: string, cb: () => void): void {
      setImmediate(cb);
    }
    write(request: Buffer): boolean {
      const txId = request.readUInt16BE(0);
      const unitId = request[6] ?? 0;
      const fc = request[7] ?? 0;
      if (fc === 3 || fc === 4) {
        const quantity = request.readUInt16BE(10);
        const byteCount = quantity * 2;
        const response = Buffer.alloc(9 + byteCount);
        response.writeUInt16BE(txId, 0); // transaction id
        response.writeUInt16BE(0, 2); // protocol id
        response.writeUInt16BE(3 + byteCount, 4); // length = unit + fc + bc + data
        response.writeUInt8(unitId, 6);
        response.writeUInt8(fc, 7);
        response.writeUInt8(byteCount, 8);
        for (let i = 0; i < quantity; i += 1) {
          response.writeUInt16BE(0x01f4, 9 + i * 2); // 500 per register
        }
        setImmediate(() => this.emit('data', response));
      } else if (fc === 6) {
        // FC06 acknowledges by echoing the 12-byte request frame.
        setImmediate(() => this.emit('data', Buffer.from(request)));
      }
      return true;
    }
    end(cb?: () => void): void {
      if (cb) setImmediate(cb);
    }
    destroy(): void {}
  }

  return { ...actualNet, Socket: FakeModbusSocket };
});

describe('VfdModbusTcpAdapter', () => {
  let adapter: VfdModbusTcpAdapter;
  let validateHostSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Allow the RFC-1918 test address through the SSRF guard by default.
    validateHostSpy = jest
      .spyOn(SsrfValidatorService.prototype, 'validateHost')
      .mockResolvedValue({ safe: true, resolvedIp: '192.168.1.100' });
    adapter = new VfdModbusTcpAdapter();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('protocolCode', () => {
    it('should have MODBUS_TCP protocol code', () => {
      expect(adapter.protocolCode).toBe(VfdProtocol.MODBUS_TCP);
    });
  });

  describe('protocolName', () => {
    it('should have correct protocol name', () => {
      expect(adapter.protocolName).toBe('Modbus TCP');
    });
  });

  describe('validateConfiguration', () => {
    it('should validate valid configuration', () => {
      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject missing host', () => {
      const config = {
        port: 502,
        unitId: 1,
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('host is required and must be a string');
    });

    it('should reject invalid port', () => {
      const config = {
        host: '192.168.1.100',
        port: 70000,
        unitId: 1,
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('port'))).toBe(true);
    });

    it('should reject invalid unit ID', () => {
      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 256,
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('unitId'))).toBe(true);
    });

    it('should accept valid IP address', () => {
      const config = {
        host: '10.0.0.1',
        port: 502,
        unitId: 1,
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(true);
    });

    it('should accept hostname', () => {
      const config = {
        host: 'vfd-device.local',
        port: 502,
        unitId: 1,
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(true);
    });

    it('should validate timeout range', () => {
      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
        connectionTimeout: 100000, // Too high
      };

      const result = adapter.validateConfiguration(config);

      expect(result.valid).toBe(false);
    });
  });

  describe('getConfigurationSchema', () => {
    it('should return JSON schema', () => {
      const schema = adapter.getConfigurationSchema();

      expect(schema).toBeDefined();
      expect(schema['type']).toBe('object');
      expect(schema['required']).toContain('host');
      expect(schema['properties']).toBeDefined();
    });

    it('should include all configuration properties', () => {
      const schema = adapter.getConfigurationSchema() as {
        properties: Record<string, unknown>;
      };

      expect(schema.properties['host']).toBeDefined();
      expect(schema.properties['port']).toBeDefined();
      expect(schema.properties['unitId']).toBeDefined();
      expect(schema.properties['connectionTimeout']).toBeDefined();
      expect(schema.properties['responseTimeout']).toBeDefined();
    });
  });

  describe('getDefaultConfiguration', () => {
    it('should return default values', () => {
      const defaults = adapter.getDefaultConfiguration();

      expect(defaults['port']).toBe(502);
      expect(defaults['unitId']).toBe(1);
      expect(defaults['connectionTimeout']).toBeDefined();
      expect(defaults['responseTimeout']).toBeDefined();
    });
  });

  describe('connect', () => {
    it('should establish connection', async () => {
      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      const handle = await adapter.connect(config);

      expect(handle).toBeDefined();
      expect(handle.id).toBeDefined();
      expect(handle.protocol).toBe(VfdProtocol.MODBUS_TCP);
      expect(handle.isConnected).toBe(true);
    });

    it('should store connection configuration', async () => {
      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      const handle = await adapter.connect(config);

      expect(handle.metadata).toBeDefined();
      expect(handle.metadata?.['host']).toBe('192.168.1.100');
    });

    it('should handle a denied/unreachable target with the OPAQUE error', async () => {
      // SVD-HIGH-001 oracle suppression: every pre-connect failure is the
      // single opaque 'Connection failed' — never a network-mapping detail
      // like the old 'Connection refused'.
      validateHostSpy.mockResolvedValueOnce({ safe: false, reason: 'denied' });

      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      await expect(adapter.connect(config)).rejects.toThrow('Connection failed');
    });

    it('the REAL SSRF guard denies RFC-1918 targets (no stub)', async () => {
      // IP literal → no DNS; deterministic denylist hit on the real guard.
      validateHostSpy.mockRestore();

      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      await expect(adapter.connect(config)).rejects.toThrow('Connection failed');
    });
  });

  describe('disconnect', () => {
    it('should close connection', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      await expect(adapter.disconnect(handle)).resolves.not.toThrow();
    });

    it('should handle already closed connection', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      // First disconnect
      await adapter.disconnect(handle);

      // Second disconnect should not throw
      await expect(adapter.disconnect(handle)).resolves.not.toThrow();
    });
  });

  describe('testConnection', () => {
    it('should return success for valid connection', async () => {
      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      const result = await adapter.testConnection(config);

      expect(result.success).toBe(true);
      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe('number');
    });

    it('should return failure for connection error', async () => {
      validateHostSpy.mockResolvedValueOnce({ safe: false, reason: 'denied' });

      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      const result = await adapter.testConnection(config);

      expect(result.success).toBe(false);
      // Opaque by design (SVD-HIGH-001 oracle suppression).
      expect(result.error).toBe('Connection failed');
    });
  });

  describe('readRegister', () => {
    it('should read holding registers (function code 3)', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      const result = await adapter.readRegister(handle, 16129, 1, 3);

      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBe(2);
    });

    it('should read input registers (function code 4)', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      const result = await adapter.readRegister(handle, 16129, 1, 4);

      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('writeRegister', () => {
    it('should write single register', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      const result = await adapter.writeRegister(handle, 49999, 0x047f);

      expect(result.success).toBe(true);
    });
  });

  describe('writeControlWord', () => {
    it('should write control word', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      const result = await adapter.writeControlWord(handle, 0x047f, 49999);

      expect(result.success).toBe(true);
    });
  });

  describe('writeSpeedReference', () => {
    it('should write speed reference with scaling', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      const result = await adapter.writeSpeedReference(handle, 50.0, 50000, 0.1);

      expect(result.success).toBe(true);
    });
  });

  describe('readParameters', () => {
    it('should read multiple parameters', async () => {
      const config = { host: '192.168.1.100', port: 502, unitId: 1 };
      const handle = await adapter.connect(config);

      const mappings = [
        {
          parameterName: 'output_frequency',
          registerAddress: 16129,
          registerCount: 1,
          functionCode: 3,
          dataType: 'uint16',
          scalingFactor: 0.1,
          offset: 0,
        },
      ];

      const result = await adapter.readParameters(handle, mappings as any);

      expect(result).toBeDefined();
      expect(result.parameters).toBeDefined();
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.latencyMs).toBeDefined();
    });
  });
});
