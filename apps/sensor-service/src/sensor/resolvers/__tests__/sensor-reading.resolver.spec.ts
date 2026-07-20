/**
 * SensorReadingResolver — federation reference resolver tests.
 *
 * Scope B Phase S1.2 + SENSOR-HIGH-085. Pins the tenant-isolation and
 * as-of-reconstruction contract for the `__resolveReference` entry point:
 *   - the tenant comes ONLY from the authenticated context — the
 *     reference is never a tenant source (D7, fail-closed);
 *   - a decodable id routes to SensorQueryService.reconstructAsOf with the
 *     decoded (sensorId, anchor);
 *   - an undecodable id or a missing tenant returns null (NOT a 500) and
 *     issues no reconstruction.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { encodeSensorReadingId } from '@aquaculture/backend-common/sensor';

import { SensorQueryService } from '../../services/sensor-query.service';
import { SensorReadingResolver } from '../sensor-reading.resolver';

describe('SensorReadingResolver', () => {
  let resolver: SensorReadingResolver;
  let queryService: { reconstructAsOf: jest.Mock };

  const tenantId = '11111111-1111-4111-8111-111111111111';
  const otherTenantId = '22222222-2222-4222-8222-222222222222';
  const sensorId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const timeText = '2026-04-25 12:00:00.123456+00';
  const readingId = encodeSensorReadingId(sensorId, timeText);

  const mockReading = {
    id: readingId,
    sensorId,
    tenantId,
    timestamp: new Date('2026-04-25T12:00:00.123Z'),
    readings: { temperature: 22.5 },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SensorReadingResolver,
        {
          provide: SensorQueryService,
          useValue: { reconstructAsOf: jest.fn() },
        },
      ],
    }).compile();

    resolver = module.get(SensorReadingResolver);
    queryService = module.get(SensorQueryService);
  });

  describe('resolveReference', () => {
    it('reconstructs the as-of snapshot when the gateway forwards an authenticated tenant', async () => {
      queryService.reconstructAsOf.mockResolvedValue(mockReading);

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: { tenantId } } },
      );

      expect(result).toEqual(mockReading);
      // The decoded anchor drives the reconstruction; the tenant is the
      // authenticated one, never taken from the reference.
      expect(queryService.reconstructAsOf).toHaveBeenCalledWith(sensorId, timeText, tenantId);
    });

    it('returns null and does NOT reconstruct when no authenticated tenant is present', async () => {
      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        {},
      );

      expect(result).toBeNull();
      expect(queryService.reconstructAsOf).not.toHaveBeenCalled();
    });

    it('returns null when the context user object is present but tenantId is missing', async () => {
      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: {} } },
      );

      expect(result).toBeNull();
      expect(queryService.reconstructAsOf).not.toHaveBeenCalled();
    });

    it('NEVER takes the tenant from the reference — a reference-only tenant is rejected (D7)', async () => {
      // A peer subgraph could put any tenantId on the reference; without an
      // authenticated context tenant the resolver must fail closed, not read
      // another tenant's data under the reference's say-so.
      const result = await resolver.resolveReference(
        {
          __typename: 'SensorReading',
          id: readingId,
          // deliberately smuggled — must be ignored
          ...({ tenantId: otherTenantId } as Record<string, unknown>),
        },
        {},
      );

      expect(result).toBeNull();
      expect(queryService.reconstructAsOf).not.toHaveBeenCalled();
    });

    it('reconstructs under the AUTHENTICATED tenant even if the reference smuggles another', async () => {
      queryService.reconstructAsOf.mockResolvedValue(mockReading);

      await resolver.resolveReference(
        {
          __typename: 'SensorReading',
          id: readingId,
          ...({ tenantId: otherTenantId } as Record<string, unknown>),
        },
        { req: { user: { tenantId } } },
      );

      expect(queryService.reconstructAsOf).toHaveBeenCalledWith(sensorId, timeText, tenantId);
    });

    it('returns null and does NOT reconstruct when the id cannot be decoded (D3 fail-closed)', async () => {
      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: 'not-a-valid-codec-id' },
        { req: { user: { tenantId } } },
      );

      expect(result).toBeNull();
      expect(queryService.reconstructAsOf).not.toHaveBeenCalled();
    });

    it('returns null on reconstruction error (does not propagate to the gateway)', async () => {
      queryService.reconstructAsOf.mockRejectedValue(new Error('connection lost'));

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: { tenantId } } },
      );

      expect(result).toBeNull();
    });

    it('returns null when the reconstruction finds no data for the anchor', async () => {
      queryService.reconstructAsOf.mockResolvedValue(null);

      const result = await resolver.resolveReference(
        { __typename: 'SensorReading', id: readingId },
        { req: { user: { tenantId } } },
      );

      expect(result).toBeNull();
    });
  });
});
