/**
 * ChannelDetectionService Unit Tests
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelDetectionService,
        {
          provide: getRepositoryToken(ChannelDetectionLog),
          useValue: {
            find: jest.fn(),
            findOne: jest.fn(),
            create: jest.fn().mockImplementation((dto) => ({ ...dto })),
            save: jest.fn().mockImplementation((entity) =>
              Promise.resolve({ id: 'proposal-1', ...entity }),
            ),
          },
        },
        {
          provide: getRepositoryToken(SensorDataChannel),
          useValue: {
            find: jest.fn(),
            create: jest.fn().mockImplementation((dto) => ({ ...dto })),
            save: jest.fn().mockImplementation((entity) =>
              Promise.resolve({ id: 'channel-id', ...entity }),
            ),
          },
        },
      ],
    }).compile();

    service = module.get<ChannelDetectionService>(ChannelDetectionService);
    logRepo = module.get(getRepositoryToken(ChannelDetectionLog));
    channelRepo = module.get(getRepositoryToken(SensorDataChannel));
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
      logRepo.findOne.mockResolvedValue(mockProposal as ChannelDetectionLog);
      channelRepo.find.mockResolvedValue([]);

      const result = await service.approveProposal('proposal-1', tenantId);

      expect(logRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'proposal-1', tenantId },
      });
      expect(channelRepo.create).toHaveBeenCalledTimes(3);
      expect(channelRepo.save).toHaveBeenCalledTimes(3);
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          userAction: 'approved',
        }),
      );
      expect(result).toHaveLength(3);
    });

    it('should use modifications when provided', async () => {
      logRepo.findOne.mockResolvedValue(mockProposal as ChannelDetectionLog);
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

      expect(channelRepo.create).toHaveBeenCalledTimes(1);
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
