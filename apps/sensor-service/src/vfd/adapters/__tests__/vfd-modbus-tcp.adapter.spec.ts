 
 
 
 
 
/**
 * VFD Modbus TCP Adapter Unit Tests
 */

import { VfdProtocol } from '../../entities/vfd.enums';
import { VfdModbusTcpAdapter } from '../vfd-modbus-tcp.adapter';

// The adapter talks raw Modbus-TCP over a `net.Socket` (no modbus-serial
// dependency), so the mock lives at the socket layer: it accepts a connection,
// then answers each 12-byte MBAP request with a correctly-framed response
// echoing the transaction id, unit id and function code.
jest.mock('net', () => {
  const { EventEmitter } = require('events');
  class MockSocket extends EventEmitter {
    private failConnect: boolean;
    constructor() {
      super();
      // Consume the one-shot failure flag so only the next socket fails.
      this.failConnect = MockSocket.failNext;
      MockSocket.failNext = false;
    }
    static failNext = false;
    setNoDelay(): this { return this; }
    setKeepAlive(): this { return this; }
    setTimeout(): this { return this; }
    connect(_port: number, _host: string, cb?: () => void): this {
      process.nextTick(() => {
        if (this.failConnect) {
          this.emit('error', new Error('Connection refused'));
        } else if (typeof cb === 'function') {
          cb();
        }
      });
      return this;
    }
    write(buffer: Buffer): boolean {
      process.nextTick(() => {
        const txId = buffer.readUInt16BE(0);
        const unitId = buffer[6] ?? 1;
        const fc = buffer[7] ?? 3;
        let resp: Buffer;
        if (fc === 0x05 || fc === 0x06) {
          // Write echo: MBAP(7) + fc + 4 echo bytes (address + value).
          resp = Buffer.alloc(12);
          resp.writeUInt16BE(txId, 0);
          resp.writeUInt16BE(0x0000, 2);
          resp.writeUInt16BE(6, 4); // length = unitId + fc + 4 echo
          resp[6] = unitId;
          resp[7] = fc;
          buffer.copy(resp, 8, 8, 12);
        } else {
          // Read: MBAP(7) + fc + byteCount(1) + 2 data bytes (0x01f4 = 500).
          resp = Buffer.alloc(11);
          resp.writeUInt16BE(txId, 0);
          resp.writeUInt16BE(0x0000, 2);
          resp.writeUInt16BE(5, 4); // length = unitId + fc + byteCount + 2 data
          resp[6] = unitId;
          resp[7] = fc;
          resp[8] = 2;
          resp[9] = 0x01;
          resp[10] = 0xf4;
        }
        this.emit('data', resp);
      });
      return true;
    }
    end(cb?: () => void): this {
      if (typeof cb === 'function') process.nextTick(cb);
      this.emit('close');
      return this;
    }
    destroy(): this {
      this.emit('close');
      return this;
    }
  }
  return { Socket: MockSocket };
});

describe('VfdModbusTcpAdapter', () => {
  let adapter: VfdModbusTcpAdapter;

  beforeEach(() => {
    adapter = new VfdModbusTcpAdapter();
    jest.clearAllMocks();
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
      expect(result.errors.some((e) => e.includes('host'))).toBe(true);
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

    it('should handle connection error', async () => {
      const net = require('net');
      net.Socket.failNext = true;

      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      await expect(adapter.connect(config)).rejects.toThrow('Connection refused');
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
      const net = require('net');
      net.Socket.failNext = true;

      const config = {
        host: '192.168.1.100',
        port: 502,
        unitId: 1,
      };

      const result = await adapter.testConnection(config);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
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
