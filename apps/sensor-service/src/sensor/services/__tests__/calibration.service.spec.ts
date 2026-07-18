import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { SensorDataChannel } from '../../../database/entities/sensor-data-channel.entity';
import { SensorReadings } from '../../../database/entities/sensor-reading.entity';
import {
  CalibrationService,
  LinearCalibrationStrategy,
  PolynomialCalibrationStrategy,
  LookupTableCalibrationStrategy,
} from '../calibration.service';
import { CalibrationConfig } from '../../interfaces/calibration-strategy.interface';

/** Minimal SensorDataChannel seed for applyCalibration tests (no ORM row). */
const seedChannel = (
  channelKey: string,
  calibrationEnabled: boolean,
  calibrationMultiplier?: number,
  calibrationOffset?: number,
): SensorDataChannel =>
  ({ channelKey, calibrationEnabled, calibrationMultiplier, calibrationOffset } as Pick<
    SensorDataChannel,
    'channelKey' | 'calibrationEnabled' | 'calibrationMultiplier' | 'calibrationOffset'
  > as SensorDataChannel);

describe('CalibrationService', () => {
  let service: CalibrationService;

  const mockChannelRepository = {
    find: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CalibrationService,
        {
          provide: getRepositoryToken(SensorDataChannel),
          useValue: mockChannelRepository,
        },
      ],
    }).compile();

    service = module.get<CalibrationService>(CalibrationService);
    jest.clearAllMocks();
  });

  describe('LinearCalibrationStrategy', () => {
    const strategy = new LinearCalibrationStrategy();

    it('should return "linear" as name', () => {
      expect(strategy.getName()).toBe('linear');
    });

    it('should handle enabled linear config', () => {
      const config: CalibrationConfig = {
        enabled: true,
        multiplier: 1.5,
        offset: 2,
      };
      expect(strategy.canHandle(config)).toBe(true);
    });

    it('should not handle polynomial config', () => {
      const config: CalibrationConfig = {
        enabled: true,
        polynomial: [1, 2, 3],
      };
      expect(strategy.canHandle(config)).toBe(false);
    });

    it('should apply linear calibration correctly', () => {
      const config: CalibrationConfig = {
        enabled: true,
        multiplier: 2,
        offset: 5,
      };
      const result = strategy.calibrate(10, config);
      expect(result.calibratedValue).toBe(25); // 10 * 2 + 5
      expect(result.method).toBe('linear');
    });

    it('should return original value when disabled', () => {
      const config: CalibrationConfig = {
        enabled: false,
        multiplier: 2,
        offset: 5,
      };
      const result = strategy.calibrate(10, config);
      expect(result.calibratedValue).toBe(10);
      expect(result.method).toBe('none');
    });

    it('should use default multiplier and offset', () => {
      const config: CalibrationConfig = { enabled: true };
      const result = strategy.calibrate(10, config);
      expect(result.calibratedValue).toBe(10); // 10 * 1 + 0
    });
  });

  describe('PolynomialCalibrationStrategy', () => {
    const strategy = new PolynomialCalibrationStrategy();

    it('should return "polynomial" as name', () => {
      expect(strategy.getName()).toBe('polynomial');
    });

    it('should handle polynomial config', () => {
      const config: CalibrationConfig = {
        enabled: true,
        polynomial: [1, 2, 3],
      };
      expect(strategy.canHandle(config)).toBe(true);
    });

    it('should apply polynomial calibration correctly', () => {
      // y = 1 + 2*x + 0.5*x^2
      const config: CalibrationConfig = {
        enabled: true,
        polynomial: [1, 2, 0.5],
      };
      const result = strategy.calibrate(2, config);
      // 1 + 2*2 + 0.5*4 = 1 + 4 + 2 = 7
      expect(result.calibratedValue).toBe(7);
      expect(result.method).toBe('polynomial');
    });
  });

  describe('LookupTableCalibrationStrategy', () => {
    const strategy = new LookupTableCalibrationStrategy();

    it('should return "lookup" as name', () => {
      expect(strategy.getName()).toBe('lookup');
    });

    it('should handle lookup table config', () => {
      const config: CalibrationConfig = {
        enabled: true,
        lookupTable: [
          { raw: 0, calibrated: 10 },
          { raw: 100, calibrated: 110 },
        ],
      };
      expect(strategy.canHandle(config)).toBe(true);
    });

    it('should interpolate correctly', () => {
      const config: CalibrationConfig = {
        enabled: true,
        lookupTable: [
          { raw: 0, calibrated: 0 },
          { raw: 100, calibrated: 200 },
        ],
      };
      const result = strategy.calibrate(50, config);
      expect(result.calibratedValue).toBe(100); // Linear interpolation
      expect(result.method).toBe('lookup');
    });

    it('should clamp to minimum', () => {
      const config: CalibrationConfig = {
        enabled: true,
        lookupTable: [
          { raw: 10, calibrated: 20 },
          { raw: 100, calibrated: 200 },
        ],
      };
      const result = strategy.calibrate(5, config);
      expect(result.calibratedValue).toBe(20);
      expect(result.confidence).toBe(0.8); // Reduced confidence for out of range
    });

    it('should clamp to maximum', () => {
      const config: CalibrationConfig = {
        enabled: true,
        lookupTable: [
          { raw: 0, calibrated: 10 },
          { raw: 100, calibrated: 110 },
        ],
      };
      const result = strategy.calibrate(150, config);
      expect(result.calibratedValue).toBe(110);
    });
  });

  describe('CalibrationService.applyCalibration', () => {
    it('should return original readings when no channels exist', async () => {
      mockChannelRepository.find.mockResolvedValue([]);

      const readings = { temperature: 25, ph: 7.0 };
      const result = await service.applyCalibration('sensor-123', readings);

      expect(result).toEqual(readings);
    });

    it('should apply calibration from channel config', async () => {
      const channels: Partial<SensorDataChannel>[] = [
        {
          channelKey: 'temperature',
          calibrationEnabled: true,
          calibrationMultiplier: 1.1,
          calibrationOffset: 0.5,
        },
      ];
      mockChannelRepository.find.mockResolvedValue(channels);

      const readings = { temperature: 20, ph: 7.0 };
      const result = await service.applyCalibration('sensor-123', readings);

      expect(result.temperature).toBeCloseTo(22.5); // 20 * 1.1 + 0.5
      expect(result.ph).toBe(7.0); // Unchanged
    });

    it('should cache channel configs', async () => {
      mockChannelRepository.find.mockResolvedValue([]);

      await service.applyCalibration('sensor-123', { temperature: 20 });
      await service.applyCalibration('sensor-123', { temperature: 25 });

      expect(mockChannelRepository.find).toHaveBeenCalledTimes(1);
    });

    it('should clear cache correctly', async () => {
      mockChannelRepository.find.mockResolvedValue([]);

      await service.applyCalibration('sensor-123', { temperature: 20 });
      service.clearCache('sensor-123');
      await service.applyCalibration('sensor-123', { temperature: 25 });

      expect(mockChannelRepository.find).toHaveBeenCalledTimes(2);
    });
  });

  describe('CalibrationService.calibrateValue', () => {
    it('should use appropriate strategy', () => {
      const linearConfig: CalibrationConfig = {
        enabled: true,
        multiplier: 2,
        offset: 1,
      };
      const result = service.calibrateValue(10, linearConfig);
      expect(result.calibratedValue).toBe(21);
      expect(result.method).toBe('linear');
    });

    it('should prefer polynomial over linear', () => {
      const config: CalibrationConfig = {
        enabled: true,
        multiplier: 2,
        polynomial: [0, 1], // y = x
      };
      const result = service.calibrateValue(10, config);
      expect(result.method).toBe('polynomial');
    });
  });

  // SENSOR-MEDIUM-067: the channelKey (snake_case) must reconcile with the
  // camelCase SensorReadings field, or multi-word metrics never calibrate.
  describe('applyCalibration channel-key reconciliation', () => {
    it('calibrates a multi-word channel whose channelKey is snake_case', async () => {
      service.warmChannelCache('sensor-1', [seedChannel('dissolved_oxygen', true, 2, 1)]);

      const readings: SensorReadings = { dissolvedOxygen: 5 };
      const result = await service.applyCalibration('sensor-1', readings);

      // 5 * 2 + 1 = 11. Before the codec, 'dissolved_oxygen' never matched the
      // 'dissolvedOxygen' reading key and the value passed through UNCALIBRATED.
      expect(result.dissolvedOxygen).toBe(11);
    });

    it('still calibrates single-word channels (regression guard)', async () => {
      service.warmChannelCache('sensor-2', [seedChannel('ph', true, 1, 0.5)]);

      const result = await service.applyCalibration('sensor-2', { ph: 7 });

      expect(result.ph).toBe(7.5);
    });

    it('leaves readings untouched when calibration is disabled', async () => {
      service.warmChannelCache('sensor-3', [seedChannel('dissolved_oxygen', false)]);

      const result = await service.applyCalibration('sensor-3', { dissolvedOxygen: 5 });

      expect(result.dissolvedOxygen).toBe(5);
    });
  });
});
