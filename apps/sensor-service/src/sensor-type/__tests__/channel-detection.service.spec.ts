/**
 * ChannelDetectionService Unit Tests
 */

 
 
 

import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';

import { ChannelDetectionLog } from '../../database/entities/channel-detection-log.entity';
import {
  SensorDataChannel,
  ChannelDataType,
  DiscoverySource,
} from '../../database/entities/sensor-data-channel.entity';
import { ChannelDetectionService } from '../channel-detection.service';

// Mock global fetch
const mockFetch = jest.fn() as jest.Mock;
global.fetch = mockFetch;

describe('ChannelDetectionService', () => {
  let service: ChannelDetectionService;
  let logRepo: jest.Mocked<Repository<ChannelDetectionLog>>;
  let channelRepo: jest.Mocked<Repository<SensorDataChannel>>;
  let mockDataSource: jest.Mocked<DataSource>;

  const tenantId = 'tenant-123';
  const sensorId = 'sensor-456';

  const sampleData = [
    { temperature: 25.3, ph: 7.2, dissolved_oxygen: 6.8 },
    { temperature: 25.5, ph: 7.1, dissolved_oxygen: 6.9 },
  ];

  const mockAiResponse = {
    message: 'Analysis complete',
    toolResults: [
      {
        tool: 'analyze_sensor_data',
        result: {
          fields: [
            { key: 'temperature', type: 'number', sampleValues: [25.3, 25.5] },
            { key: 'ph', type: 'number', sampleValues: [7.2, 7.1] },
            { key: 'dissolved_oxygen', type: 'number', sampleValues: [6.8, 6.9] },
          ],
        },
      },
      {
        tool: 'suggest_sensor_channels',
        result: {
          channels: [
            {
              channelKey: 'temperature',
              displayLabel: 'Temperature',
              dataType: 'number',
              unit: 'Celsius',
              unitSymbol: '\u00b0C',
            },
            {
              channelKey: 'ph',
              displayLabel: 'pH',
              dataType: 'number',
              unit: 'pH',
              unitSymbol: 'pH',
            },
            {
              channelKey: 'dissolved_oxygen',
              displayLabel: 'Dissolved Oxygen',
              dataType: 'number',
              unit: 'mg/L',
              unitSymbol: 'mg/L',
            },
          ],
        },
      },
    ],
  };

  const mockProposal: Partial<ChannelDetectionLog> = {
    id: 'proposal-1',
    tenantId,
    sensorId,
    rawSample: sampleData as any,
    aiAnalysis: mockAiResponse.toolResults![0]!.result as any,
    proposedChannels: (mockAiResponse.toolResults![1]!.result as any).channels as any,
    userAction: undefined,
    finalChannels: undefined,
    createdAt: new Date(),
  };

  beforeEach(async () => {
    mockFetch.mockReset();

    const logRepoMock = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((dto) => ({ ...dto })),
      save: jest.fn().mockImplementation((entity) =>
        Promise.resolve({ id: 'proposal-1', ...entity }),
      ),
    };

    const channelRepoMock = {
      find: jest.fn(),
      // TenantScopedRepository.saveMany() calls repository.create(array), so the
      // mock must mirror TypeORM's create(array)->array (spreading an array into
      // an object literal would corrupt the batch into {0,1,2}).
      create: jest.fn().mockImplementation((dto) =>
        Array.isArray(dto) ? dto.map((d) => ({ ...d })) : { ...dto },
      ),
      save: jest.fn().mockImplementation((entity) =>
        Array.isArray(entity)
          ? Promise.resolve(entity.map((e, i) => ({ id: `channel-${i}`, ...e })))
          : Promise.resolve({ id: 'channel-id', ...entity }),
      ),
    };

    const repoMap = new Map<any, any>([
      [ChannelDetectionLog, logRepoMock],
      [SensorDataChannel, channelRepoMock],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelDetectionService,
        {
          provide: getRepositoryToken(ChannelDetectionLog),
          useValue: logRepoMock,
        },
        {
          provide: getRepositoryToken(SensorDataChannel),
          useValue: channelRepoMock,
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key: string, defaultValue?: string) => defaultValue ?? undefined),
          },
        },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn().mockImplementation(async (cb: any) => {
              const manager = {
                getRepository: jest.fn().mockImplementation((entity: any) => repoMap.get(entity) ?? {}),
              };
              return cb(manager);
            }),
          },
        },
        // CIRCUIT-LOW-002 cure: ChannelDetectionService now
        // constructor-injects CircuitBreakerService for the AI
        // service fetch wrap. Mock the execute() to delegate
        // straight to fn() so the existing tests don't have to
        // know about the breaker layer — a passthrough means
        // the breaker is invisible to test logic AND any
        // regression that drops the breaker still surfaces
        // (the AI fetch now ALWAYS runs even when the breaker
        // would have tripped — but the unit specs aren't
        // asserting trip behaviour anyway).
        {
          provide: CircuitBreakerService,
          useValue: {
            execute: jest
              .fn()
              .mockImplementation(async (args: { fn: () => Promise<unknown> }) => args.fn()),
          },
        },
      ],
    }).compile();

    service = module.get<ChannelDetectionService>(ChannelDetectionService);
    logRepo = module.get(getRepositoryToken(ChannelDetectionLog));
    channelRepo = module.get(getRepositoryToken(SensorDataChannel));
    mockDataSource = module.get(getDataSourceToken());
  });

  describe('detectChannels', () => {
    it('should call AI service and store proposal in DB', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockAiResponse),
      });

      const result = await service.detectChannels(sensorId, tenantId, sampleData);

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v2/ai/chat'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      );
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sensorId,
          tenantId,
          rawSample: sampleData,
        }),
      );
      expect(logRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
      expect(result.id).toBe('proposal-1');
    });

    it('should fall back to local analysis when AI service is unavailable', async () => {
      mockFetch.mockRejectedValue(new Error('Connection refused'));

      const result = await service.detectChannels(sensorId, tenantId, sampleData);

      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sensorId,
          tenantId,
          rawSample: sampleData,
          aiAnalysis: expect.objectContaining({ source: 'local_fallback' }),
        }),
      );
      expect(logRepo.save).toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it('should fall back to local analysis when AI service returns error', async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const result = await service.detectChannels(sensorId, tenantId, sampleData);

      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          aiAnalysis: expect.objectContaining({ source: 'local_fallback' }),
        }),
      );
      expect(result).toBeDefined();
    });
  });

  describe('approveProposal', () => {
    it('should create channels and update log when approved', async () => {
      // Return a fresh copy: approveProposal mutates proposal.userAction, and a
      // shared mockProposal would leak "already approved" into sibling tests.
      logRepo.findOne.mockResolvedValue({ ...mockProposal } as ChannelDetectionLog);
      channelRepo.find.mockResolvedValue([]);

      const result = await service.approveProposal('proposal-1', tenantId);

      expect(logRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'proposal-1', tenantId },
      });
      // 3 per-channel create() calls in the map + 1 batch create(array) inside
      // TenantScopedRepository.saveMany() = 4.
      expect(channelRepo.create).toHaveBeenCalledTimes(4);
      // Batch save: all channels saved in one call via transaction
      expect(channelRepo.save).toHaveBeenCalled();
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userAction: 'approved',
        }),
      );
      expect(result).toHaveLength(3);
    });

    it('should use modifications when provided', async () => {
      logRepo.findOne.mockResolvedValue({ ...mockProposal } as ChannelDetectionLog);
      channelRepo.find.mockResolvedValue([]);

      const modifications = [
        {
          channelKey: 'temp',
          displayLabel: 'Water Temp',
          dataType: 'number',
          unit: 'Fahrenheit',
          unitSymbol: '\u00b0F',
        },
      ];

      const result = await service.approveProposal('proposal-1', tenantId, modifications);

      // 1 per-channel create() + 1 batch create(array) inside saveMany() = 2.
      expect(channelRepo.create).toHaveBeenCalledTimes(2);
      expect(channelRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          channelKey: 'temp',
          displayLabel: 'Water Temp',
          unit: 'Fahrenheit',
        }),
      );
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userAction: 'approved',
          finalChannels: modifications,
        }),
      );
      expect(result).toHaveLength(1);
    });

    it('should throw NotFoundException for non-existent proposal', async () => {
      logRepo.findOne.mockResolvedValue(null);

      await expect(
        service.approveProposal('missing-id', tenantId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('rejectProposal', () => {
    it('should set userAction to rejected', async () => {
      logRepo.findOne.mockResolvedValue(mockProposal as ChannelDetectionLog);

      const result = await service.rejectProposal('proposal-1', tenantId);

      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userAction: 'rejected',
        }),
      );
      expect(result).toBe(true);
    });

    it('should throw NotFoundException for non-existent proposal', async () => {
      logRepo.findOne.mockResolvedValue(null);

      await expect(
        service.rejectProposal('missing-id', tenantId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getPendingProposals', () => {
    it('should return proposals where userAction IS NULL ordered by createdAt DESC', async () => {
      const proposals = [mockProposal] as ChannelDetectionLog[];
      logRepo.find.mockResolvedValue(proposals);

      const result = await service.getPendingProposals(sensorId, tenantId);

      expect(result).toEqual(proposals);
      expect(logRepo.find).toHaveBeenCalledWith({
        where: {
          sensorId,
          tenantId,
          userAction: expect.anything(),
        },
        order: { createdAt: 'DESC' },
      });
    });

    it('should return empty array when no pending proposals', async () => {
      logRepo.find.mockResolvedValue([]);

      const result = await service.getPendingProposals(sensorId, tenantId);

      expect(result).toHaveLength(0);
    });
  });
});
