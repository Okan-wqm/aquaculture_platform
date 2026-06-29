/**
 * Health-event read query handlers — fail-closed tenant boundary (FARM-HIGH-060).
 * Tenant scoping + nullable by-id + empty aggregates.
 */
import { createMockDataSource } from '@aquaculture/testing';

import { GetHealthEventHandler } from '../handlers/get-health-event.handler';
import { GetHealthEventQuery } from '../queries/get-health-event.query';
import { ListHealthEventsByBatchHandler } from '../handlers/list-health-events-by-batch.handler';
import { ListHealthEventsByBatchQuery } from '../queries/list-health-events-by-batch.query';
import { ListCriticalHealthEventsHandler } from '../handlers/list-critical-health-events.handler';
import { ListCriticalHealthEventsQuery } from '../queries/list-critical-health-events.query';
import { GetHealthEventStatsHandler } from '../handlers/get-health-event-stats.handler';
import { GetHealthEventStatsQuery } from '../queries/get-health-event-stats.query';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('Health-event read handlers (fail-closed tenant boundary)', () => {
  it('GetHealthEventHandler reads by id scoped to the tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce({ id: 'he-1' });

    const result = await new GetHealthEventHandler(mockDataSource).execute(
      new GetHealthEventQuery(tenantId, 'he-1'),
    );

    expect(result).toEqual({ id: 'he-1' });
    expect(mockManager.findOne).toHaveBeenCalledWith(expect.anything(), {
      where: { id: 'he-1', tenantId },
    });
  });

  it('GetHealthEventHandler returns null when absent (nullable GraphQL field)', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.findOne as jest.Mock).mockResolvedValueOnce(null);

    const result = await new GetHealthEventHandler(mockDataSource).execute(
      new GetHealthEventQuery(tenantId, 'missing'),
    );

    expect(result).toBeNull();
  });

  it('ListHealthEventsByBatchHandler scopes to tenant + batch', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([{ id: 'he-2' }]);

    const result = await new ListHealthEventsByBatchHandler(mockDataSource).execute(
      new ListHealthEventsByBatchQuery(tenantId, 'batch-1', false),
    );

    expect(result).toHaveLength(1);
    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId, batchId: 'batch-1' });
  });

  it('ListCriticalHealthEventsHandler scopes to tenant', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]);

    await new ListCriticalHealthEventsHandler(mockDataSource).execute(
      new ListCriticalHealthEventsQuery(tenantId),
    );

    const [, opts] = (mockManager.find as jest.Mock).mock.calls[0];
    expect(opts.where).toMatchObject({ tenantId });
  });

  it('GetHealthEventStatsHandler aggregates tenant-scoped events', async () => {
    const { mockDataSource, mockManager } = createMockDataSource();
    (mockManager.find as jest.Mock).mockResolvedValueOnce([]); // none → zeroed stats

    const result = await new GetHealthEventStatsHandler(mockDataSource).execute(
      new GetHealthEventStatsQuery(tenantId),
    );

    expect(result.total).toBe(0);
    expect(result.active).toBe(0);
    expect(mockManager.find).toHaveBeenCalledWith(expect.anything(), { where: { tenantId } });
  });
});
