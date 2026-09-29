/**
 * SearchSimilarMessagesHandler — K10 layer 5 (PR-T1, MT-HIGH-062): the AI
 * retrieval (RAG) read is tenant-bound by construction.
 *
 * The DataSource double has NO members: any ambient read (`dataSource.query`)
 * throws, so every passing test proves the handler reads only through the
 * query runner `runInTenantRead` hands it.
 */
import type { ClientProxy } from '@nestjs/microservices';
import { collaborator } from '@aquaculture/testing';
import { runInTenantRead } from '@aquaculture/backend-common/database';
import type { DataSource } from 'typeorm';
import { of } from 'rxjs';

import { SearchSimilarMessagesHandler } from '../search-similar-messages.handler';
import { SearchSimilarMessagesQuery } from '../search-similar-messages.query';
import type { AiEgressGateService } from '../../services/ai-egress-gate.service';

const queryRunner = { query: jest.fn() };

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantRead: jest.fn(
      (_ds: unknown, _schema: unknown, _tenant: unknown, fn: (qr: unknown) => unknown) =>
        Promise.resolve(fn(queryRunner)),
    ),
  };
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';

describe('SearchSimilarMessagesHandler — tenant-bound RAG read (K10 layer 5)', () => {
  const dataSource = collaborator<DataSource>({}, 'DataSource');
  const send = jest.fn();
  const isAllowed = jest.fn();
  const handler = new SearchSimilarMessagesHandler(
    dataSource,
    collaborator<ClientProxy>({ send }, 'ClientProxy'),
    collaborator<AiEgressGateService>({ isAllowed }, 'AiEgressGateService'),
  );
  const tenantRead = jest.mocked(runInTenantRead);

  beforeEach(() => {
    jest.clearAllMocks();
    isAllowed.mockResolvedValue(true);
    send.mockReturnValue(of({ embeddings: [[0.25, 0.5]] }));
  });

  it("reads the channel scope and the vector search inside the request tenant's boundary, each filtered by tenant", async () => {
    // SCENARIO: a tenant user searches across every channel they belong to.
    // EXPECTS: one runInTenantRead for the request tenant; both statements carry the
    //          tenant as a predicate; no ambient DataSource read (the double would throw).
    queryRunner.query.mockResolvedValueOnce([{ channelId: CHANNEL }]).mockResolvedValueOnce([
      {
        id: 'm-1',
        channelId: CHANNEL,
        senderId: USER,
        content: 'tank A1 oxygen low',
        contentType: 'text',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        isDeleted: false,
        similarity: '0.91',
      },
    ]);

    const results = await handler.execute(
      new SearchSimilarMessagesQuery(TENANT, USER, 'oxygen', null, 10),
    );

    expect(tenantRead).toHaveBeenCalledTimes(1);
    expect(tenantRead).toHaveBeenCalledWith(dataSource, 'messaging', TENANT, expect.any(Function));
    const [membershipCall, searchCall] = queryRunner.query.mock.calls;
    expect(membershipCall?.[0]).toContain('"tenantId" = $1');
    expect(membershipCall?.[1]).toEqual([TENANT, USER]);
    expect(searchCall?.[0]).toContain('m."tenantId" = $2::uuid');
    expect(searchCall?.[1]).toEqual(['[0.25,0.5]', TENANT, [CHANNEL], 10]);
    expect(results).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ id: 'm-1', channelId: CHANNEL }),
        similarity: 0.91,
      }),
    ]);
  });

  it('asks ai-service for the embedding BEFORE opening the tenant read (no transaction held across NATS)', async () => {
    queryRunner.query.mockResolvedValueOnce([]);

    await handler.execute(new SearchSimilarMessagesQuery(TENANT, USER, 'oxygen', null, 10));

    const sentAt = send.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    const readAt = tenantRead.mock.invocationCallOrder[0] ?? Number.NEGATIVE_INFINITY;
    expect(sentAt).toBeLessThan(readAt);
  });

  it('scopes a single-channel search to the membership of that channel in the request tenant', async () => {
    // SCENARIO: the user names one channel; they are not a member of it in this tenant.
    // EXPECTS: the membership check carries tenant, user and channel; no vector search runs.
    queryRunner.query.mockResolvedValueOnce([]);

    const results = await handler.execute(
      new SearchSimilarMessagesQuery(TENANT, USER, 'oxygen', CHANNEL, 10),
    );

    expect(results).toEqual([]);
    expect(queryRunner.query).toHaveBeenCalledTimes(1);
    expect(queryRunner.query.mock.calls[0]?.[1]).toEqual([TENANT, USER, CHANNEL]);
  });

  it('reads nothing when the egress gate refuses (tenant AI off or no consent)', async () => {
    isAllowed.mockResolvedValue(false);

    const results = await handler.execute(
      new SearchSimilarMessagesQuery(TENANT, USER, 'oxygen', null, 10),
    );

    expect(results).toEqual([]);
    expect(send).not.toHaveBeenCalled();
    expect(tenantRead).not.toHaveBeenCalled();
  });
});
