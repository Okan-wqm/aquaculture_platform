/**
 * JsonbPatchService Unit Tests
 *
 * Covers every safety invariant the service commits to:
 *   - path[0] mismatch with target.firstPathSegment → reject
 *   - missing tenantId or id in `where` → reject
 *   - unknown (schema, table, column, firstPathSegment) tuple →
 *     reject with a pointer to JSONB_PATCH_WHITELIST
 *   - caller-provided target containing a quote / space → reject
 *   - happy path builds the expected SQL + parameter tuple
 *   - row-count extraction handles both `[[],n]` and `{affected:n}`
 *     shapes returned by different TypeORM drivers
 *
 * Hand-rolled DataSource double — no real DB, no NestJS harness.
 */
import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import {
  JSONB_PATCH_WHITELIST,
  JsonbPatchService,
} from '../jsonb-patch.service';

interface DataSourceDouble {
  query: jest.Mock;
}

function makeService(
  queryResult: unknown = [[], 1],
): { service: JsonbPatchService; ds: DataSourceDouble } {
  const ds: DataSourceDouble = {
    query: jest.fn().mockResolvedValue(queryResult),
  };
  const service = new JsonbPatchService(ds as unknown as DataSource);
  return { service, ds };
}

const FEEDING_TARGET = {
  table: 'batches_v2',
  column: 'feedingSummary',
  firstPathSegment: 'lastFedAt',
};

const TENANT = '11111111-1111-4111-8111-111111111111';
const BATCH = '22222222-2222-4222-8222-222222222222';

describe('JsonbPatchService', () => {
  describe('validate', () => {
    it('rejects when path[0] does not equal target.firstPathSegment', async () => {
      const { service } = makeService();
      await expect(
        service.patch({
          target: FEEDING_TARGET,
          path: ['totalFed'],
          value: 42,
          where: { tenantId: TENANT, id: BATCH },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects when path is empty', async () => {
      const { service } = makeService();
      await expect(
        service.patch({
          target: FEEDING_TARGET,
          path: [],
          value: 42,
          where: { tenantId: TENANT, id: BATCH },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing tenantId', async () => {
      const { service } = makeService();
      await expect(
        service.patch({
          target: FEEDING_TARGET,
          path: ['lastFedAt'],
          value: new Date().toISOString(),
          // @ts-expect-error — deliberately malformed
          where: { id: BATCH },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects missing id', async () => {
      const { service } = makeService();
      await expect(
        service.patch({
          target: FEEDING_TARGET,
          path: ['lastFedAt'],
          value: new Date().toISOString(),
          // @ts-expect-error — deliberately malformed
          where: { tenantId: TENANT },
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unknown whitelist key', async () => {
      const { service } = makeService();
      await expect(
        service.patch({
          target: {
            table: 'batches_v2',
            column: 'feedingSummary',
            firstPathSegment: 'notOnTheList',
          },
          path: ['notOnTheList'],
          value: 1,
          where: { tenantId: TENANT, id: BATCH },
        }),
      ).rejects.toThrow(/not on the whitelist/i);
    });

    it('rejects identifier with a quote (injection attempt)', async () => {
      const { service } = makeService();
      // The whitelist check runs first, so an injection-payload
      // column name is caught there with "not on the whitelist".
      // The identifier-hygiene check is a second gate for callers
      // that manage to spoof a whitelist key with metacharacters.
      await expect(
        service.patch({
          target: {
            ...FEEDING_TARGET,
            column: 'feedingSummary"; DROP TABLE users; --',
          },
          path: ['lastFedAt'],
          value: 1,
          where: { tenantId: TENANT, id: BATCH },
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('whitelistKey', () => {
    it('produces the documented format', () => {
      const key = JsonbPatchService.whitelistKey(FEEDING_TARGET);
      expect(key).toBe('batches_v2:feedingSummary:lastFedAt');
      expect(JSONB_PATCH_WHITELIST.has(key)).toBe(true);
    });

    it('covers all three intended JSONB columns on batches_v2', () => {
      // Smoke — catches someone accidentally removing a whitelist
      // entry without adding a replacement.
      for (const segment of [
        'batches_v2:feedingSummary:dailyAverages',
        'batches_v2:feedingSummary:lastFedAt',
        'batches_v2:feedingSummary:totalFed',
        'batches_v2:growthMetrics:lastSampledAt',
        'batches_v2:growthMetrics:latestSGR',
        'batches_v2:growthMetrics:cumulativeWeightGain',
        'batches_v2:mortalitySummary:lastEventAt',
        'batches_v2:mortalitySummary:cumulativeCount',
        'batches_v2:mortalitySummary:cumulativeBiomassKg',
      ]) {
        expect(JSONB_PATCH_WHITELIST.has(segment)).toBe(true);
      }
    });
  });

  describe('patch', () => {
    it('builds the expected SQL with path + value parameters', async () => {
      const { service, ds } = makeService([[], 1]);
      const result = await service.patch({
        target: FEEDING_TARGET,
        path: ['lastFedAt'],
        value: '2026-04-23T08:30:00Z',
        where: { tenantId: TENANT, id: BATCH },
      });
      expect(result.affectedRows).toBe(1);
      expect(ds.query).toHaveBeenCalledTimes(1);
      const [sql, params] = ds.query.mock.calls[0];
      // UNQUALIFIED table reference — the per-tenant search_path routes this
      // into tenant_<uuid>.batches_v2. A `"farm".`-qualified reference would
      // hit the empty source table and silently no-op; assert it never appears.
      expect(sql).toContain('UPDATE "batches_v2"');
      expect(sql).not.toMatch(/"farm"\./);
      expect(sql).toContain('"feedingSummary" = jsonb_set');
      expect(sql).toContain('"tenantId" = $3');
      expect(sql).toContain('"id" = $4');
      expect(params[0]).toEqual(['lastFedAt']);
      expect(params[1]).toBe('"2026-04-23T08:30:00Z"');
      expect(params[2]).toBe(TENANT);
      expect(params[3]).toBe(BATCH);
    });

    it('serialises nested object values into JSONB', async () => {
      const { service, ds } = makeService([[], 1]);
      // Use the dailyAverages whitelist entry — the target and path
      // must agree so the whitelist lookup passes before the SQL
      // builder is reached.
      await service.patch({
        target: {
          table: 'batches_v2',
          column: 'feedingSummary',
          firstPathSegment: 'dailyAverages',
        },
        path: ['dailyAverages'],
        value: { '2026-04-22': 12.5, '2026-04-23': 13.1 },
        where: { tenantId: TENANT, id: BATCH },
      });
      const [, params] = ds.query.mock.calls[0];
      expect(JSON.parse(params[1])).toEqual({
        '2026-04-22': 12.5,
        '2026-04-23': 13.1,
      });
    });

    it('accepts TypeORM affected-rows shape { affected: N }', async () => {
      const { service } = makeService({ affected: 2 });
      const out = await service.patch({
        target: FEEDING_TARGET,
        path: ['lastFedAt'],
        value: 'x',
        where: { tenantId: TENANT, id: BATCH },
      });
      expect(out.affectedRows).toBe(2);
    });

    it('accepts TypeORM tuple shape [[], N]', async () => {
      const { service } = makeService([[], 3]);
      const out = await service.patch({
        target: FEEDING_TARGET,
        path: ['lastFedAt'],
        value: 'x',
        where: { tenantId: TENANT, id: BATCH },
      });
      expect(out.affectedRows).toBe(3);
    });

    it('returns 0 affected rows when the driver returns an unknown shape', async () => {
      const { service } = makeService({});
      const out = await service.patch({
        target: FEEDING_TARGET,
        path: ['lastFedAt'],
        value: 'x',
        where: { tenantId: TENANT, id: BATCH },
      });
      expect(out.affectedRows).toBe(0);
    });
  });
});
