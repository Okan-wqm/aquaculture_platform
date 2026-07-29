/**
 * ChannelDetectionService Unit Tests
 *
 * SENSOR-MEDIUM-070: the AI call now rides NATS request-reply
 * (request.ai.sensor.detectChannels) under this service's mTLS cert identity —
 * no forged x-user-payload user, no dead HTTP endpoint.
 */
import { NotFoundException } from '@nestjs/common';
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { of, throwError } from 'rxjs';

import { ChannelDetectionLog } from '../../database/entities/channel-detection-log.entity';
import { SensorDataChannel } from '../../database/entities/sensor-data-channel.entity';
import { AI_NATS_CLIENT, ChannelDetectionService } from '../channel-detection.service';

describe('ChannelDetectionService', () => {
  let service: ChannelDetectionService;
  let logRepo: jest.Mocked<Repository<ChannelDetectionLog>>;
  let channelRepo: jest.Mocked<Repository<SensorDataChannel>>;
  const mockSend = jest.fn();

  const tenantId = 'tenant-123';
  const sensorId = 'sensor-456';

  const sampleData = [
    { timestamp: '2026-01-01T00:00:00Z', values: { temperature: 25.3, ph: 7.2, dissolved_oxygen: 6.8 } },
    { timestamp: '2026-01-01T00:00:01Z', values: { temperature: 25.5, ph: 7.1, dissolved_oxygen: 6.9 } },
  ];

  // Wire response from ai-service's request.ai.sensor.detectChannels responder.
  const natsResponse = {
    proposals: [
      { channelKey: 'temperature', displayLabel: 'Temperature', dataType: 'number', unit: '°C' },
      { channelKey: 'ph', displayLabel: 'pH', dataType: 'number', unit: 'pH' },
      { channelKey: 'dissolved_oxygen', displayLabel: 'Dissolved Oxygen', dataType: 'number', unit: 'mg/L' },
    ],
    detectedFields: [],
    confidence: 'high' as const,
  };

  const storedChannels = natsResponse.proposals;

  // FRESH proposal per test: approveProposal MUTATES the object findOne returns
  // (proposal.userAction = APPROVED before save), so a shared fixture trips the
  // "already approved" idempotency guard after the first approval.
  const makeProposal = (): Partial<ChannelDetectionLog> => ({
    id: 'proposal-1',
    tenantId,
    sensorId,
    rawSample: sampleData as never,
    aiAnalysis: { confidence: 'high' } as never,
    proposedChannels: storedChannels as never,
    userAction: undefined,
    finalChannels: undefined,
    createdAt: new Date(),
  });

  beforeEach(async () => {
    mockSend.mockReset();

    const logRepoMock = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((dto) => ({ ...dto })),
      save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: 'proposal-1', ...entity })),
    };

    const channelRepoMock = {
      find: jest.fn(),
      create: jest.fn().mockImplementation((dto) =>
        Array.isArray(dto) ? dto.map((d) => ({ ...d })) : { ...dto },
      ),
      save: jest.fn().mockImplementation((entity) =>
        Array.isArray(entity)
          ? Promise.resolve(entity.map((e, i) => ({ id: `channel-${i}`, ...e })))
          : Promise.resolve({ id: 'channel-id', ...entity }),
      ),
    };

    const repoMap = new Map<unknown, unknown>([
      [ChannelDetectionLog, logRepoMock],
      [SensorDataChannel, channelRepoMock],
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChannelDetectionService,
        { provide: getRepositoryToken(ChannelDetectionLog), useValue: logRepoMock },
        { provide: getRepositoryToken(SensorDataChannel), useValue: channelRepoMock },
        // SENSOR-MEDIUM-070: the outbound NATS client to ai-service.
        { provide: AI_NATS_CLIENT, useValue: { send: mockSend } },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: jest.fn().mockImplementation(async (cb: (m: unknown) => unknown) => {
              const manager = {
                getRepository: jest.fn().mockImplementation((entity: unknown) => repoMap.get(entity) ?? {}),
              };
              return cb(manager);
            }),
          },
        },
        // CIRCUIT-LOW-002 cure: passthrough breaker — execute() delegates
        // straight to fn() so the specs don't have to model the breaker layer.
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
  });

  describe('detectChannels', () => {
    it('requests channel detection over NATS and stores the mapped proposal', async () => {
      mockSend.mockReturnValue(of(natsResponse));

      const result = await service.detectChannels(sensorId, tenantId, sampleData);

      expect(mockSend).toHaveBeenCalledWith(
        'request.ai.sensor.detectChannels',
        expect.objectContaining({ tenantId, sensorId, samples: sampleData }),
      );
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          sensorId,
          tenantId,
          rawSample: sampleData,
          proposedChannels: expect.arrayContaining([
            expect.objectContaining({ channelKey: 'temperature', unit: '°C' }),
          ]),
        }),
      );
      expect(logRepo.save).toHaveBeenCalled();
      expect(result.id).toBe('proposal-1');
    });

    it('falls back to local analysis when the NATS request errors', async () => {
      mockSend.mockReturnValue(throwError(() => new Error('NATS unavailable')));

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

    it('falls back to local analysis when ai-service returns an error response', async () => {
      mockSend.mockReturnValue(
        of({
          proposals: [],
          detectedFields: [],
          confidence: 'low',
          error: { code: 'INTERNAL', message: 'boom' },
        }),
      );

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
      logRepo.findOne.mockResolvedValue(makeProposal() as ChannelDetectionLog);
      channelRepo.find.mockResolvedValue([]);

      const result = await service.approveProposal('proposal-1', tenantId);

      expect(logRepo.findOne).toHaveBeenCalledWith({ where: { id: 'proposal-1', tenantId } });
      expect(channelRepo.save).toHaveBeenCalledWith([
        expect.objectContaining({ channelKey: 'temperature', tenantId }),
        expect.objectContaining({ channelKey: 'ph', tenantId }),
        expect.objectContaining({ channelKey: 'dissolved_oxygen', tenantId }),
      ]);
      expect(logRepo.save).toHaveBeenCalledWith(expect.objectContaining({ userAction: 'approved' }));
      expect(result).toHaveLength(3);
    });

    it('should use modifications when provided', async () => {
      logRepo.findOne.mockResolvedValue(makeProposal() as ChannelDetectionLog);
      channelRepo.find.mockResolvedValue([]);

      const modifications = [
        {
          channelKey: 'temp',
          displayLabel: 'Water Temp',
          dataType: 'number',
          unit: 'Fahrenheit',
          unitSymbol: '°F',
        },
      ];

      const result = await service.approveProposal('proposal-1', tenantId, modifications);

      expect(channelRepo.save).toHaveBeenCalledWith([
        expect.objectContaining({
          channelKey: 'temp',
          displayLabel: 'Water Temp',
          unit: 'Fahrenheit',
          tenantId,
        }),
      ]);
      expect(logRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ userAction: 'approved', finalChannels: modifications }),
      );
      expect(result).toHaveLength(1);
    });

    it('should throw NotFoundException for non-existent proposal', async () => {
      logRepo.findOne.mockResolvedValue(null);

      await expect(service.approveProposal('missing-id', tenantId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('rejectProposal', () => {
    it('should set userAction to rejected', async () => {
      logRepo.findOne.mockResolvedValue(makeProposal() as ChannelDetectionLog);

      const result = await service.rejectProposal('proposal-1', tenantId);

      expect(logRepo.save).toHaveBeenCalledWith(expect.objectContaining({ userAction: 'rejected' }));
      expect(result).toBe(true);
    });

    it('should throw NotFoundException for non-existent proposal', async () => {
      logRepo.findOne.mockResolvedValue(null);

      await expect(service.rejectProposal('missing-id', tenantId)).rejects.toThrow(NotFoundException);
    });
  });

  describe('getPendingProposals', () => {
    it('should return proposals where userAction IS NULL ordered by createdAt DESC', async () => {
      const proposals = [makeProposal()] as ChannelDetectionLog[];
      logRepo.find.mockResolvedValue(proposals);

      const result = await service.getPendingProposals(sensorId, tenantId);

      expect(result).toEqual(proposals);
      expect(logRepo.find).toHaveBeenCalledWith({
        where: { sensorId, tenantId, userAction: expect.anything() },
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
