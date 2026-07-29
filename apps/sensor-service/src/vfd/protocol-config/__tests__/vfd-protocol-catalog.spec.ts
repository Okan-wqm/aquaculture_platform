import { ProtocolImplementationStatus } from '../../../protocol/adapters/protocol-implementation-status';
import { VfdProtocol } from '../../entities/vfd.enums';
import {
  getVfdProtocolImplementationStatus,
  isSelectableVfdProtocol,
  getVfdProtocolSchema,
  getVfdProtocolDefaults,
  validateVfdProtocolConfig,
  getSelectableVfdProtocolInfo,
} from '../vfd-protocol-catalog';

const EDGE_SERVICEABLE = [VfdProtocol.MODBUS_TCP, VfdProtocol.MODBUS_RTU];
const UNSUPPORTED = Object.values(VfdProtocol).filter((p) => !EDGE_SERVICEABLE.includes(p));

describe('VFD protocol catalog (SSoT)', () => {
  describe('classification', () => {
    it.each(EDGE_SERVICEABLE)('%s is EDGE_DELEGATED and selectable', (protocol) => {
      expect(getVfdProtocolImplementationStatus(protocol)).toBe(
        ProtocolImplementationStatus.EDGE_DELEGATED,
      );
      expect(isSelectableVfdProtocol(protocol)).toBe(true);
    });

    it.each(UNSUPPORTED)('%s is UNSUPPORTED and not selectable', (protocol) => {
      expect(getVfdProtocolImplementationStatus(protocol)).toBe(
        ProtocolImplementationStatus.UNSUPPORTED,
      );
      expect(isSelectableVfdProtocol(protocol)).toBe(false);
    });
  });

  describe('schema + defaults', () => {
    it('exposes a Modbus TCP schema keyed on host, and TCP defaults', () => {
      const schema = getVfdProtocolSchema(VfdProtocol.MODBUS_TCP) as Record<string, unknown>;
      expect(schema).toMatchObject({ type: 'object', required: ['host'] });
      expect(getVfdProtocolDefaults(VfdProtocol.MODBUS_TCP)).toMatchObject({
        port: 502,
        unitId: 1,
      });
    });

    it('exposes a Modbus RTU schema keyed on serialPort + slaveId, and RTU defaults', () => {
      const schema = getVfdProtocolSchema(VfdProtocol.MODBUS_RTU) as Record<string, unknown>;
      expect(schema).toMatchObject({ type: 'object', required: ['serialPort', 'slaveId'] });
      expect(getVfdProtocolDefaults(VfdProtocol.MODBUS_RTU)).toMatchObject({ baudRate: 9600 });
    });

    it.each(UNSUPPORTED)('%s has no schema and no defaults', (protocol) => {
      expect(getVfdProtocolSchema(protocol)).toBeNull();
      expect(getVfdProtocolDefaults(protocol)).toBeNull();
    });
  });

  describe('validateVfdProtocolConfig — Modbus TCP', () => {
    it('accepts a valid config', () => {
      expect(
        validateVfdProtocolConfig(VfdProtocol.MODBUS_TCP, {
          host: '10.0.0.5',
          port: 502,
          unitId: 1,
        }).valid,
      ).toBe(true);
    });

    it('requires host', () => {
      const r = validateVfdProtocolConfig(VfdProtocol.MODBUS_TCP, { port: 502 });
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/host is required/);
    });

    it('rejects an out-of-range port and unitId', () => {
      const r = validateVfdProtocolConfig(VfdProtocol.MODBUS_TCP, {
        host: 'localhost',
        port: 70000,
        unitId: 999,
      });
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/port must be between/);
      expect(r.errors.join(' ')).toMatch(/unitId must be between/);
    });

    it('rejects a malformed host', () => {
      const r = validateVfdProtocolConfig(VfdProtocol.MODBUS_TCP, { host: 'not a host!!' });
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/valid IP address or hostname/);
    });
  });

  describe('validateVfdProtocolConfig — Modbus RTU', () => {
    it('accepts a valid config', () => {
      expect(
        validateVfdProtocolConfig(VfdProtocol.MODBUS_RTU, {
          serialPort: '/dev/ttyUSB0',
          slaveId: 1,
          baudRate: 9600,
        }).valid,
      ).toBe(true);
    });

    it('requires serialPort and slaveId, and range-checks slaveId + baudRate', () => {
      const missing = validateVfdProtocolConfig(VfdProtocol.MODBUS_RTU, {});
      expect(missing.valid).toBe(false);
      expect(missing.errors.join(' ')).toMatch(/serialPort is required/);
      expect(missing.errors.join(' ')).toMatch(/slaveId is required/);

      const bad = validateVfdProtocolConfig(VfdProtocol.MODBUS_RTU, {
        serialPort: '/dev/ttyS0',
        slaveId: 300,
        baudRate: 1234,
      });
      expect(bad.valid).toBe(false);
      expect(bad.errors.join(' ')).toMatch(/slaveId must be between 1 and 247/);
      expect(bad.errors.join(' ')).toMatch(/baudRate must be one of/);
    });
  });

  describe('validateVfdProtocolConfig — unsupported', () => {
    it.each(UNSUPPORTED)('%s always fails validation with an honest reason', (protocol) => {
      const r = validateVfdProtocolConfig(protocol, { anything: true });
      expect(r.valid).toBe(false);
      expect(r.errors.join(' ')).toMatch(/not supported/i);
    });
  });

  describe('getSelectableVfdProtocolInfo', () => {
    it('returns exactly the edge-serviceable protocols with populated schema + status', () => {
      const info = getSelectableVfdProtocolInfo();
      const codes = info.map((i) => i.code).sort();
      expect(codes).toEqual([VfdProtocol.MODBUS_RTU, VfdProtocol.MODBUS_TCP].sort());
      for (const entry of info) {
        expect(entry.implementationStatus).toBe(ProtocolImplementationStatus.EDGE_DELEGATED);
        expect(entry.configurationSchema).toMatchObject({ type: 'object' });
        expect(Object.keys(entry.defaultConfiguration).length).toBeGreaterThan(0);
      }
    });
  });
});
