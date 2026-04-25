/**
 * SensorReadingResolver — federation reference resolver tests.
 *
 * Scope B Phase S1.2. Pins the tenant-isolation contract for the
 * `__resolveReference` entry point: empty tenantId returns null
 * (NOT a 500), and a populated tenant routes to the repository
 * lookup.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { SensorReading } from '../../../database/entities/sensor-reading.entity';
import { SensorReadingResolver } from '../sensor-reading.resolver';

describe('SensorReadingResolver', () => {
  let resolver: SensorReadingResolver;
  let readingRepository: jest.Mocked<Repository<SensorReading>>;

  const tenantId = '11111111-1111-1111-1111-111111111111';
  const otherTenantId = '22222222-2222-2222-2222-222222222222';
  const readingId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  const mockReading = {
    id: readingId,
    sensorId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    tenantId,
    timestamp: new Date('2026-04-25T12:00:00Z'),
    readings: { temperature: 22.5 },
  } as unknown as SensorReading;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorReadingResolver,
        {
          provide: getRepositoryToken(SensorReading),
          useValue: {
            findOne: jest.fn(),
          },
        },
      ],
    }).compile();

    resolver = module.get(SensorReadingResolver);
    readingRepository = module.get(getRepositoryToken(SensorReading));
  });

  describe('resolveReference', () => {
    it('returns the reading when the gateway forwards an authenticated tenant context', async () => {
      readingRepository.findOne.mockResolvedValue(mockReading);

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: { tenantId } } },
      );

      expect(result).toEqual(mockReading);
      expect(readingRepository.findOne).toHaveBeenCalledWith({
        where: { id: readingId, tenantId },
      });
    });

    it('returns null and does NOT throw when neither context nor reference carries tenantId', async () => {
      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        {},
      );

      expect(result).toBeNull();
      // Critical: no DB call when tenant is missing — the resolver
      // MUST NOT issue a tenant-less query that could leak rows.
      expect(readingRepository.findOne).not.toHaveBeenCalled();
    });

    it('returns null when context user object is present but tenantId is missing', async () => {
      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: {} } },
      );

      expect(result).toBeNull();
      expect(readingRepository.findOne).not.toHaveBeenCalled();
    });

    it('falls back to reference.tenantId when the producing subgraph included it', async () => {
      readingRepository.findOne.mockResolvedValue(mockReading);

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId, tenantId },
        // No context user — emulates a federation hop where the
        // gateway didn't forward auth (rare but supported).
        {},
      );

      expect(result).toEqual(mockReading);
      expect(readingRepository.findOne).toHaveBeenCalledWith({
        where: { id: readingId, tenantId },
      });
    });

    it('prefers context.req.user.tenantId over reference.tenantId on conflict', async () => {
      // The gateway-forwarded user context is the source of truth;
      // the reference's `tenantId` is a hint at best (the producing
      // subgraph could have been wrong about the tenant).
      readingRepository.findOne.mockResolvedValue(mockReading);

      await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId, tenantId: otherTenantId },
        { req: { user: { tenantId } } },
      );

      expect(readingRepository.findOne).toHaveBeenCalledWith({
        where: { id: readingId, tenantId },
      });
    });

    it('returns null on repository error (does not propagate to the gateway)', async () => {
      readingRepository.findOne.mockRejectedValue(new Error('connection lost'));

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: { tenantId } } },
      );

      // Federation expects null on miss; throwing surfaces 500s in
      // the gateway and breaks composition for ALL subgraphs in the
      // request. The resolver swallows + logs.
      expect(result).toBeNull();
    });

    it('returns null when the repository finds no matching row', async () => {
      readingRepository.findOne.mockResolvedValue(null);

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: { tenantId } } },
      );

      expect(result).toBeNull();
    });
  });
});
