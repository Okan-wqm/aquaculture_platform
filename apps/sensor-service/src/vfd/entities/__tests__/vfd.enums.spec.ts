/**
 * VFD Enums Unit Tests
 */

import {
  VfdBrand,
  VfdProtocol,
  VfdParameterCategory,
  VfdDeviceStatus,
  VfdCommandType,
  VfdDataType,
  ByteOrder,
  VFD_BRAND_NAMES,
  VFD_PROTOCOL_NAMES,
  VFD_BRAND_PROTOCOLS,
  VFD_BRAND_MODELS,
  VFD_BRAND_DEFAULT_SERIAL,
  VFD_CONTROL_COMMANDS,
  VFD_STATUS_BITS,
} from '../vfd.enums';

describe('VFD Enums', () => {
  describe('VfdBrand', () => {
    it('should contain all 8 major VFD brands', () => {
      expect(Object.keys(VfdBrand)).toHaveLength(8);
      expect(VfdBrand.DANFOSS).toBe('danfoss');
      expect(VfdBrand.ABB).toBe('abb');
      expect(VfdBrand.SIEMENS).toBe('siemens');
      expect(VfdBrand.SCHNEIDER).toBe('schneider');
      expect(VfdBrand.YASKAWA).toBe('yaskawa');
      expect(VfdBrand.DELTA).toBe('delta');
      expect(VfdBrand.MITSUBISHI).toBe('mitsubishi');
      expect(VfdBrand.ROCKWELL).toBe('rockwell');
    });

    it('should have display names for all brands', () => {
      Object.values(VfdBrand).forEach(brand => {
        expect(VFD_BRAND_NAMES[brand]).toBeDefined();
        expect(typeof VFD_BRAND_NAMES[brand]).toBe('string');
      });
    });
  });

  describe('VfdProtocol', () => {
    it('should contain all 8 protocol types', () => {
      expect(Object.keys(VfdProtocol)).toHaveLength(8);
      expect(VfdProtocol.MODBUS_RTU).toBe('modbus_rtu');
      expect(VfdProtocol.MODBUS_TCP).toBe('modbus_tcp');
      expect(VfdProtocol.PROFIBUS_DP).toBe('profibus_dp');
      expect(VfdProtocol.PROFINET).toBe('profinet');
      expect(VfdProtocol.ETHERNET_IP).toBe('ethernet_ip');
      expect(VfdProtocol.CANOPEN).toBe('canopen');
      expect(VfdProtocol.BACNET_IP).toBe('bacnet_ip');
      expect(VfdProtocol.BACNET_MSTP).toBe('bacnet_mstp');
    });

    it('should have display names for all protocols', () => {
      Object.values(VfdProtocol).forEach(protocol => {
        expect(VFD_PROTOCOL_NAMES[protocol]).toBeDefined();
        expect(typeof VFD_PROTOCOL_NAMES[protocol]).toBe('string');
      });
    });
  });

  describe('VfdParameterCategory', () => {
    it('should contain all parameter categories', () => {
      expect(VfdParameterCategory.STATUS).toBe('status');
      expect(VfdParameterCategory.MOTOR).toBe('motor');
      expect(VfdParameterCategory.ENERGY).toBe('energy');
      expect(VfdParameterCategory.THERMAL).toBe('thermal');
      expect(VfdParameterCategory.FAULT).toBe('fault');
      expect(VfdParameterCategory.CONTROL).toBe('control');
    });
  });

  describe('VfdDeviceStatus', () => {
    it('should contain all device status values', () => {
      expect(VfdDeviceStatus.DRAFT).toBe('draft');
      expect(VfdDeviceStatus.PENDING_TEST).toBe('pending_test');
      expect(VfdDeviceStatus.TESTING).toBe('testing');
      expect(VfdDeviceStatus.TEST_FAILED).toBe('test_failed');
      expect(VfdDeviceStatus.ACTIVE).toBe('active');
      expect(VfdDeviceStatus.SUSPENDED).toBe('suspended');
      expect(VfdDeviceStatus.OFFLINE).toBe('offline');
    });
  });

  describe('VfdCommandType', () => {
    it('should contain all command types', () => {
      expect(VfdCommandType.START).toBe('start');
      expect(VfdCommandType.STOP).toBe('stop');
      expect(VfdCommandType.REVERSE).toBe('reverse');
      expect(VfdCommandType.SET_FREQUENCY).toBe('set_frequency');
      expect(VfdCommandType.FAULT_RESET).toBe('fault_reset');
      expect(VfdCommandType.QUICK_STOP).toBe('quick_stop');
    });
  });

  describe('VfdDataType', () => {
    it('should contain all data types', () => {
      expect(VfdDataType.UINT16).toBe('uint16');
      expect(VfdDataType.INT16).toBe('int16');
      expect(VfdDataType.UINT32).toBe('uint32');
      expect(VfdDataType.INT32).toBe('int32');
      expect(VfdDataType.FLOAT32).toBe('float32');
      expect(VfdDataType.CONTROL_WORD).toBe('control_word');
      expect(VfdDataType.STATUS_WORD).toBe('status_word');
    });
  });

  describe('ByteOrder', () => {
    it('should contain big and little endian options', () => {
      expect(ByteOrder.BIG).toBe('big');
      expect(ByteOrder.LITTLE).toBe('little');
    });
  });

  describe('VFD_BRAND_PROTOCOLS', () => {
    it('should have protocols defined for all brands', () => {
      Object.values(VfdBrand).forEach(brand => {
        expect(VFD_BRAND_PROTOCOLS[brand]).toBeDefined();
        expect(Array.isArray(VFD_BRAND_PROTOCOLS[brand])).toBe(true);
        expect(VFD_BRAND_PROTOCOLS[brand].length).toBeGreaterThan(0);
      });
    });

    it('should have Modbus RTU support for all brands', () => {
      Object.values(VfdBrand).forEach(brand => {
        expect(VFD_BRAND_PROTOCOLS[brand]).toContain(VfdProtocol.MODBUS_RTU);
      });
    });

    it('should have Modbus TCP support for all brands', () => {
      Object.values(VfdBrand).forEach(brand => {
        expect(VFD_BRAND_PROTOCOLS[brand]).toContain(VfdProtocol.MODBUS_TCP);
      });
    });

    it('should have Danfoss supporting 7 protocols', () => {
      expect(VFD_BRAND_PROTOCOLS[VfdBrand.DANFOSS]).toHaveLength(7);
      expect(VFD_BRAND_PROTOCOLS[VfdBrand.DANFOSS]).toContain(VfdProtocol.PROFIBUS_DP);
      expect(VFD_BRAND_PROTOCOLS[VfdBrand.DANFOSS]).toContain(VfdProtocol.PROFINET);
      expect(VFD_BRAND_PROTOCOLS[VfdBrand.DANFOSS]).toContain(VfdProtocol.CANOPEN);
    });

    it('should have Delta supporting fewer protocols', () => {
      expect(VFD_BRAND_PROTOCOLS[VfdBrand.DELTA].length).toBeLessThan(
        VFD_BRAND_PROTOCOLS[VfdBrand.DANFOSS].length
      );
    });
  });

  describe('VFD_BRAND_MODELS', () => {
    it('should have model series defined for all brands', () => {
      Object.values(VfdBrand).forEach(brand => {
        expect(VFD_BRAND_MODELS[brand]).toBeDefined();
        expect(Array.isArray(VFD_BRAND_MODELS[brand])).toBe(true);
        expect(VFD_BRAND_MODELS[brand].length).toBeGreaterThan(0);
      });
    });

    it('should have correct Danfoss models', () => {
      expect(VFD_BRAND_MODELS[VfdBrand.DANFOSS]).toContain('FC102');
      expect(VFD_BRAND_MODELS[VfdBrand.DANFOSS]).toContain('FC302');
    });

    it('should have correct ABB models', () => {
      expect(VFD_BRAND_MODELS[VfdBrand.ABB]).toContain('ACS580');
      expect(VFD_BRAND_MODELS[VfdBrand.ABB]).toContain('ACS880');
    });

    it('should have correct Siemens models', () => {
      expect(VFD_BRAND_MODELS[VfdBrand.SIEMENS]).toContain('G120');
      expect(VFD_BRAND_MODELS[VfdBrand.SIEMENS]).toContain('S120');
    });

    it('should have correct Rockwell models', () => {
      expect(VFD_BRAND_MODELS[VfdBrand.ROCKWELL]).toContain('PowerFlex 525');
      expect(VFD_BRAND_MODELS[VfdBrand.ROCKWELL]).toContain('PowerFlex 755');
    });
  });

  describe('VFD_BRAND_DEFAULT_SERIAL', () => {
    it('should have default serial config for all brands', () => {
      Object.values(VfdBrand).forEach(brand => {
        expect(VFD_BRAND_DEFAULT_SERIAL[brand]).toBeDefined();
        expect(VFD_BRAND_DEFAULT_SERIAL[brand].baudRate).toBeDefined();
        expect(VFD_BRAND_DEFAULT_SERIAL[brand].dataBits).toBeDefined();
        expect(VFD_BRAND_DEFAULT_SERIAL[brand].parity).toBeDefined();
        expect(VFD_BRAND_DEFAULT_SERIAL[brand].stopBits).toBeDefined();
      });
    });

    it('should have valid baud rates', () => {
      const validBaudRates = [4800, 9600, 19200, 38400, 57600, 115200];
      Object.values(VFD_BRAND_DEFAULT_SERIAL).forEach(config => {
        expect(validBaudRates).toContain(config.baudRate);
      });
    });

    it('should have valid parity options', () => {
      const validParity = ['none', 'even', 'odd'];
      Object.values(VFD_BRAND_DEFAULT_SERIAL).forEach(config => {
        expect(validParity).toContain(config.parity);
      });
    });

    it('should have Siemens using even parity by default', () => {
      expect(VFD_BRAND_DEFAULT_SERIAL[VfdBrand.SIEMENS].parity).toBe('even');
      expect(VFD_BRAND_DEFAULT_SERIAL[VfdBrand.SIEMENS].baudRate).toBe(19200);
    });

    it('should have Danfoss using no parity by default', () => {
      expect(VFD_BRAND_DEFAULT_SERIAL[VfdBrand.DANFOSS].parity).toBe('none');
      expect(VFD_BRAND_DEFAULT_SERIAL[VfdBrand.DANFOSS].baudRate).toBe(9600);
    });
  });

  describe('VFD_CONTROL_COMMANDS', () => {
    it('should have standard CiA402 commands', () => {
      expect(VFD_CONTROL_COMMANDS.SHUTDOWN).toBe(0x0006);
      expect(VFD_CONTROL_COMMANDS.SWITCH_ON).toBe(0x0007);
      expect(VFD_CONTROL_COMMANDS.ENABLE_OPERATION).toBe(0x000f);
      expect(VFD_CONTROL_COMMANDS.DISABLE_VOLTAGE).toBe(0x0000);
      expect(VFD_CONTROL_COMMANDS.QUICK_STOP).toBe(0x0002);
    });

    it('should have run commands', () => {
      expect(VFD_CONTROL_COMMANDS.RUN_FORWARD).toBe(0x000f);
      expect(VFD_CONTROL_COMMANDS.RUN_REVERSE).toBe(0x080f);
    });

    it('should have fault reset command', () => {
      expect(VFD_CONTROL_COMMANDS.FAULT_RESET).toBe(0x0080);
    });

    it('should have Danfoss-specific commands', () => {
      expect(VFD_CONTROL_COMMANDS.DANFOSS_START).toBe(0x047f);
      expect(VFD_CONTROL_COMMANDS.DANFOSS_STOP).toBe(0x043c);
    });
  });

  describe('VFD_STATUS_BITS', () => {
    it('should have all standard status bits defined', () => {
      expect(VFD_STATUS_BITS.READY_TO_SWITCH_ON).toBe(0);
      expect(VFD_STATUS_BITS.SWITCHED_ON).toBe(1);
      expect(VFD_STATUS_BITS.OPERATION_ENABLED).toBe(2);
      expect(VFD_STATUS_BITS.FAULT).toBe(3);
      expect(VFD_STATUS_BITS.VOLTAGE_ENABLED).toBe(4);
      expect(VFD_STATUS_BITS.QUICK_STOP).toBe(5);
      expect(VFD_STATUS_BITS.SWITCH_ON_DISABLED).toBe(6);
      expect(VFD_STATUS_BITS.WARNING).toBe(7);
    });

    it('should have additional status bits', () => {
      expect(VFD_STATUS_BITS.AT_SETPOINT).toBe(8);
      expect(VFD_STATUS_BITS.REMOTE).toBe(9);
      expect(VFD_STATUS_BITS.TARGET_REACHED).toBe(10);
      expect(VFD_STATUS_BITS.INTERNAL_LIMIT).toBe(11);
    });

    it('should allow bit extraction from status word', () => {
      const statusWord = 0x0277; // Running, ready

      const isReady = (statusWord & (1 << VFD_STATUS_BITS.READY_TO_SWITCH_ON)) !== 0;
      const isSwitchedOn = (statusWord & (1 << VFD_STATUS_BITS.SWITCHED_ON)) !== 0;
      const isOperationEnabled = (statusWord & (1 << VFD_STATUS_BITS.OPERATION_ENABLED)) !== 0;
      const isFault = (statusWord & (1 << VFD_STATUS_BITS.FAULT)) !== 0;

      expect(isReady).toBe(true);
      expect(isSwitchedOn).toBe(true);
      expect(isOperationEnabled).toBe(true);
      expect(isFault).toBe(false);
    });
  });
});
