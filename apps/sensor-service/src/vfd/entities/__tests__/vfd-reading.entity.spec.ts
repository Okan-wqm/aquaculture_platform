/**
 * VFD Reading Entity Unit Tests
 */

import { VfdReading, VfdParameters, VfdStatusBits } from '../vfd-reading.entity';

describe('VfdReading Entity', () => {
  let reading: VfdReading;

  beforeEach(() => {
    reading = new VfdReading();
  });

  describe('basic properties', () => {
    it('should create an instance', () => {
      expect(reading).toBeDefined();
      expect(reading).toBeInstanceOf(VfdReading);
    });

    it('should set identification properties', () => {
      reading.id = '123e4567-e89b-12d3-a456-426614174000';
      reading.vfdDeviceId = 'device-123';
      reading.tenantId = 'tenant-456';
      reading.timestamp = new Date();

      expect(reading.id).toBeDefined();
      expect(reading.vfdDeviceId).toBe('device-123');
      expect(reading.tenantId).toBe('tenant-456');
      expect(reading.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('motor parameters', () => {
    it('should set motor performance parameters', () => {
      const params: VfdParameters = {
        outputFrequency: 50.0,
        motorSpeed: 1475,
        motorCurrent: 12.5,
        motorVoltage: 400,
        dcBusVoltage: 565,
        outputPower: 5.5,
        motorTorque: 35.6,
        powerFactor: 0.87,
      };

      reading.parameters = params;

      expect(reading.parameters.outputFrequency).toBe(50.0);
      expect(reading.parameters.motorSpeed).toBe(1475);
      expect(reading.parameters.motorCurrent).toBe(12.5);
      expect(reading.parameters.motorVoltage).toBe(400);
      expect(reading.parameters.dcBusVoltage).toBe(565);
      expect(reading.parameters.outputPower).toBe(5.5);
      expect(reading.parameters.motorTorque).toBe(35.6);
      expect(reading.parameters.powerFactor).toBe(0.87);
    });

    it('should handle partial parameters', () => {
      const params: VfdParameters = {
        outputFrequency: 50.0,
        motorCurrent: 12.5,
      };

      reading.parameters = params;

      expect(reading.parameters.outputFrequency).toBe(50.0);
      expect(reading.parameters.motorCurrent).toBe(12.5);
      expect(reading.parameters.motorVoltage).toBeUndefined();
    });
  });

  describe('energy parameters', () => {
    it('should set energy consumption parameters', () => {
      const params: VfdParameters = {
        energyConsumption: 1234.56,
        runningHours: 5678,
        powerOnHours: 10000,
        startCount: 250,
      };

      reading.parameters = params;

      expect(reading.parameters.energyConsumption).toBe(1234.56);
      expect(reading.parameters.runningHours).toBe(5678);
      expect(reading.parameters.powerOnHours).toBe(10000);
      expect(reading.parameters.startCount).toBe(250);
    });
  });

  describe('thermal parameters', () => {
    it('should set temperature parameters', () => {
      const params: VfdParameters = {
        driveTemperature: 45.5,
        motorThermal: 60.0,
        controlCardTemperature: 38.2,
        ambientTemperature: 25.0,
      };

      reading.parameters = params;

      expect(reading.parameters.driveTemperature).toBe(45.5);
      expect(reading.parameters.motorThermal).toBe(60.0);
      expect(reading.parameters.controlCardTemperature).toBe(38.2);
      expect(reading.parameters.ambientTemperature).toBe(25.0);
    });
  });

  describe('status and fault parameters', () => {
    it('should set status word parameters', () => {
      const params: VfdParameters = {
        statusWord: 0x0277,
        faultCode: 0,
        warningWord: 0x0000,
        alarmWord: 0x0000,
      };

      reading.parameters = params;

      expect(reading.parameters.statusWord).toBe(0x0277);
      expect(reading.parameters.faultCode).toBe(0);
      expect(reading.parameters.warningWord).toBe(0);
    });

    it('should set fault code when present', () => {
      reading.parameters = {
        statusWord: 0x0008, // Fault bit set
        faultCode: 15, // Overcurrent fault
      };

      expect(reading.parameters.faultCode).toBe(15);
    });
  });

  describe('reference parameters', () => {
    it('should set speed and frequency references', () => {
      const params: VfdParameters = {
        speedReference: 75.0,
        frequencyReference: 37.5,
      };

      reading.parameters = params;

      expect(reading.parameters.speedReference).toBe(75.0);
      expect(reading.parameters.frequencyReference).toBe(37.5);
    });
  });

  describe('status bits', () => {
    it('should set status bits for running state', () => {
      const statusBits: VfdStatusBits = {
        ready: true,
        running: true,
        fault: false,
        warning: false,
        atSetpoint: true,
        direction: 'forward',
        voltageEnabled: true,
        quickStopActive: false,
        switchOnDisabled: false,
        remote: true,
        targetReached: true,
        internalLimit: false,
      };

      reading.statusBits = statusBits;

      expect(reading.statusBits.ready).toBe(true);
      expect(reading.statusBits.running).toBe(true);
      expect(reading.statusBits.fault).toBe(false);
      expect(reading.statusBits.direction).toBe('forward');
      expect(reading.statusBits.atSetpoint).toBe(true);
    });

    it('should set status bits for fault state', () => {
      const statusBits: VfdStatusBits = {
        ready: false,
        running: false,
        fault: true,
        warning: false,
        atSetpoint: false,
        direction: 'forward',
      };

      reading.statusBits = statusBits;

      expect(reading.statusBits.ready).toBe(false);
      expect(reading.statusBits.running).toBe(false);
      expect(reading.statusBits.fault).toBe(true);
    });

    it('should set reverse direction', () => {
      reading.statusBits = {
        running: true,
        direction: 'reverse',
      };

      expect(reading.statusBits.direction).toBe('reverse');
    });
  });

  describe('raw values', () => {
    it('should store raw register values', () => {
      reading.rawValues = {
        reg_16029: 0x0277,
        reg_16129: 500,
        reg_16139: 1250,
      };

      expect(reading.rawValues.reg_16029).toBe(0x0277);
      expect(reading.rawValues.reg_16129).toBe(500);
      expect(reading.rawValues.reg_16139).toBe(1250);
    });
  });

  describe('read quality', () => {
    it('should mark valid readings', () => {
      reading.isValid = true;
      reading.latencyMs = 25;
      reading.errorMessage = undefined;

      expect(reading.isValid).toBe(true);
      expect(reading.latencyMs).toBe(25);
      expect(reading.errorMessage).toBeUndefined();
    });

    it('should mark invalid readings with error', () => {
      reading.isValid = false;
      reading.errorMessage = 'Communication timeout';
      reading.latencyMs = undefined;

      expect(reading.isValid).toBe(false);
      expect(reading.errorMessage).toBe('Communication timeout');
    });

    it('should track communication latency', () => {
      reading.latencyMs = 15;
      expect(reading.latencyMs).toBe(15);

      reading.latencyMs = 250;
      expect(reading.latencyMs).toBe(250);
    });
  });

  describe('timestamps', () => {
    it('should set reading timestamp', () => {
      const timestamp = new Date('2024-01-15T10:30:00Z');
      reading.timestamp = timestamp;

      expect(reading.timestamp).toEqual(timestamp);
    });

    it('should have separate createdAt timestamp', () => {
      const readingTime = new Date('2024-01-15T10:30:00Z');
      const createdTime = new Date('2024-01-15T10:30:01Z');

      reading.timestamp = readingTime;
      reading.createdAt = createdTime;

      expect(reading.timestamp).not.toEqual(reading.createdAt);
    });
  });

  describe('custom parameters', () => {
    it('should allow custom parameter keys', () => {
      reading.parameters = {
        outputFrequency: 50.0,
        custom_pressure: 2.5,
        custom_flow_rate: 100.0,
      };

      expect(reading.parameters.custom_pressure).toBe(2.5);
      expect(reading.parameters.custom_flow_rate).toBe(100.0);
    });
  });

  describe('complete reading scenario', () => {
    it('should handle a complete reading with all fields', () => {
      const now = new Date();

      reading.id = 'reading-123';
      reading.vfdDeviceId = 'device-456';
      reading.tenantId = 'tenant-789';
      reading.timestamp = now;
      reading.createdAt = now;
      reading.isValid = true;
      reading.latencyMs = 18;

      reading.parameters = {
        outputFrequency: 50.0,
        motorSpeed: 1478,
        motorCurrent: 15.2,
        motorVoltage: 398,
        dcBusVoltage: 563,
        outputPower: 7.2,
        motorTorque: 42.5,
        driveTemperature: 48.3,
        runningHours: 12500,
        statusWord: 0x0277,
        faultCode: 0,
      };

      reading.statusBits = {
        ready: true,
        running: true,
        fault: false,
        warning: false,
        atSetpoint: true,
        direction: 'forward',
        voltageEnabled: true,
        remote: true,
      };

      reading.rawValues = {
        status_word: 0x0277,
        output_frequency: 500,
        motor_current: 1520,
      };

      expect(reading.isValid).toBe(true);
      expect(reading.parameters.outputFrequency).toBe(50.0);
      expect(reading.statusBits.running).toBe(true);
      expect(reading.rawValues.status_word).toBe(0x0277);
    });
  });
});
