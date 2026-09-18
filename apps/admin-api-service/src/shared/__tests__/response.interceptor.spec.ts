import { CallHandler, ExecutionContext, StreamableFile } from '@nestjs/common';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  createCursorPaginationResultV1,
  createStandardPaginatedResult,
} from '@platform/pagination-contracts';
import { firstValueFrom, of, throwError } from 'rxjs';

import {
  ApiResponse,
  ResponseInterceptor,
  UnissuedPaginationShapeError,
} from '../response.interceptor';

/**
 * ADMIN-HIGH-004. The interceptor used to duck-type `'data' in x && 'total' in
 * x`, so it recognised nothing the real producers emitted and wrapped whatever
 * they happened to build. These cases pin the three outcomes that replace it:
 * a factory-issued page is projected, a cursor page is projected under its own
 * coordinates, and a hand-built page is refused.
 */
describe('ResponseInterceptor', () => {
  const interceptor = new ResponseInterceptor();

  /**
   * Nest's own context object rather than a stubbed lookalike: the interceptor
   * reads the request through `switchToHttp()`, and ExecutionContextHost is the
   * implementation that does at runtime.
   */
  const contextFor = (url: string): ExecutionContext => new ExecutionContextHost([{ url }]);

  const handlerFor = (value: unknown): CallHandler => ({ handle: () => of(value) });

  const run = async (url: string, value: unknown): Promise<unknown> =>
    firstValueFrom(interceptor.intercept(contextFor(url), handlerFor(value)));

  const anyTimestamp = expect.any(String);

  describe('factory-issued pages', () => {
    it('projects the authority page onto data + meta', async () => {
      const page = createStandardPaginatedResult(['a', 'b'], 42, 2, 2);

      const response = (await run('/v1/users?page=2', page)) as ApiResponse<unknown>;

      expect(response.success).toBe(true);
      expect(response.data).toEqual(['a', 'b']);
      expect(response.meta).toEqual({
        total: 42,
        page: 2,
        limit: 2,
        totalPages: 21,
        hasNextPage: true,
        hasPreviousPage: true,
        timestamp: anyTimestamp,
      });
    });

    it('carries the empty page as page 1 of 1, never 1 of 0', async () => {
      const response = (await run(
        '/v1/audit-logs',
        createStandardPaginatedResult([], 0, 1, 20),
      )) as ApiResponse<unknown>;

      expect(response.data).toEqual([]);
      expect(response.meta).toMatchObject({
        total: 0,
        totalPages: 1,
        hasNextPage: false,
        hasPreviousPage: false,
      });
    });

    it('projects a cursor page under cursor coordinates, not page coordinates', async () => {
      const page = createCursorPaginationResultV1(['row'], 10, true, 'opaque-cursor');

      const response = (await run('/v1/events', page)) as ApiResponse<unknown>;

      expect(response.data).toEqual(['row']);
      expect(response.meta).toEqual({
        totalCount: 10,
        hasMore: true,
        cursor: 'opaque-cursor',
        timestamp: anyTimestamp,
      });
    });
  });

  describe('fail-closed on unissued pages', () => {
    it.each([
      ['items', { items: [], total: 0, page: 1, limit: 20, totalPages: 0 }],
      ['data', { data: [{ id: 1 }], total: 1, page: 1, limit: 20 }],
    ])('refuses a hand-built page keyed by %s', async (_key, payload) => {
      await expect(run('/v1/anything', payload)).rejects.toBeInstanceOf(
        UnissuedPaginationShapeError,
      );
    });

    it('names the route and the remedy so the handler is findable', async () => {
      await expect(
        run('/v1/support/tickets', { data: [], total: 0, page: 1, limit: 20 }),
      ).rejects.toThrow(/\/support\/tickets.*createStandardPaginatedResult/s);
    });

    it('reports the failure as a 500, not a silently different envelope', async () => {
      const error = await run('/v1/x', { data: [], total: 0, page: 1, limit: 5 }).catch(
        (thrown: unknown) => thrown,
      );

      expect(error).toBeInstanceOf(UnissuedPaginationShapeError);
      expect((error as UnissuedPaginationShapeError).getStatus()).toBe(500);
    });

    it('leaves a structurally similar non-page alone', async () => {
      // `total` + `limit` without `page` is a slow-query summary, not a page.
      const payload = { data: [], total: 3, limit: 10 };

      const response = (await run('/v1/database/slow-queries', payload)) as ApiResponse<unknown>;

      expect(response.data).toBe(payload);
      expect(response.meta).toEqual({ timestamp: anyTimestamp });
    });
  });

  describe('non-paginated payloads', () => {
    it('wraps a plain object', async () => {
      const payload = { id: 'tenant-1' };

      const response = (await run('/v1/admin/tenants/tenant-1', payload)) as ApiResponse<unknown>;

      expect(response).toEqual({
        success: true,
        data: payload,
        meta: { timestamp: anyTimestamp },
      });
    });

    it('passes health and docs routes through untouched', async () => {
      for (const url of ['/health', '/v1/health/ready', '/docs-json']) {
        await expect(run(url, { status: 'ok' })).resolves.toEqual({ status: 'ok' });
      }
    });

    it('does not swallow handler errors', async () => {
      const failing: CallHandler = {
        handle: () => throwError(() => new Error('boom')),
      };

      await expect(
        firstValueFrom(interceptor.intercept(contextFor('/v1/users'), failing)),
      ).rejects.toThrow('boom');
    });
  });

  /**
   * Bytes are the response, not a payload to describe.
   *
   * Nest streams a `StreamableFile` only when the handler returns it directly.
   * Nested inside `{success,data,meta}` it is serialized as an ordinary object,
   * so a download arrives as the envelope under the attachment filename — the
   * DB-explorer CSV and JSON exports both shipped that way. A `Buffer` takes
   * the same route through `JSON.stringify` and lands as
   * `{"type":"Buffer","data":[…]}`.
   */
  describe('binary payloads', () => {
    it('streams a StreamableFile through without an envelope', async () => {
      const file = new StreamableFile(Buffer.from('id,name\n1,alpha', 'utf-8'), {
        type: 'text/csv; charset=utf-8',
        disposition: 'attachment; filename="probe_export.csv"',
      });

      await expect(run('/v1/database/explorer/export', file)).resolves.toBe(file);
    });

    it('passes a raw Buffer through without an envelope', async () => {
      const buffer = Buffer.from('[]', 'utf-8');

      await expect(run('/v1/database/explorer/export', buffer)).resolves.toBe(buffer);
    });
  });
});
