import 'reflect-metadata';
import { of } from 'rxjs';
import { FARM_AI_QUERY_SUBJECTS } from '@platform/event-contracts';
import {
  humanToolContext,
  tenantBoundClient,
} from '../../../../tenant-boundary/__tests__/fixtures/tenant-bound.fixture';
import { ListFeedingProtocolsTool } from '../list-feeding-protocols.tool';

const CTX = humanToolContext({
  userId: 'u-1',
  userRoles: ['MODULE_USER'],
  correlationId: 'corr-1',
  persona: 'manager-farm-production-v1',
  personaTier: 'manager',
  offeredToolNames: [],
  actuationPolicy: 'confirm_required',
});

describe('ListFeedingProtocolsTool', () => {
  let send: jest.Mock;
  let tool: ListFeedingProtocolsTool;

  beforeEach(() => {
    send = jest
      .fn()
      .mockReturnValue(
        of({ ok: true, tenantId: CTX.tenant.tenantId, data: { items: [], truncated: false } }),
      );
    tool = new ListFeedingProtocolsTool(tenantBoundClient({ send }));
  });

  it('is a module-scoped farm read tool', () => {
    const metadata = tool.getMetadata();
    expect(metadata.name).toBe('list_feeding_protocols');
    expect(metadata.category).toBe('farm_query');
    expect(metadata.requiresModule).toBe('farm');
    expect(metadata.requiresConfirmation).toBe(false);
  });

  it('applies defaults and sends the contract subject with the context tenant', async () => {
    const result = await tool.execute({}, CTX);

    expect(result.success).toBe(true);
    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS, {
      ...{ limit: 20 },
      tenantId: CTX.tenant.tenantId,
    });
  });

  it('forwards explicit fields (limits clamped to the contract cap)', async () => {
    await tool.execute({ species: 'SEABASS', limit: 5 }, CTX);

    expect(send).toHaveBeenCalledWith(FARM_AI_QUERY_SUBJECTS.FEED_PROTOCOLS, {
      ...{ species: 'SEABASS', limit: 5 },
      tenantId: CTX.tenant.tenantId,
    });
  });
});
