import {
  IngestBackendSnapshotRequest,
  IngestBackendSnapshot,
} from '@platform/event-contracts';
import { NatsRequestReply, RequestReplyContext } from '@platform/event-bus';

import { IngestBackendPolicyService } from '../services/ingest-backend-policy.service';
import { PolicySnapshotResponder } from '../services/policy-snapshot.responder';

describe('PolicySnapshotResponder', () => {
  it('registers the responder on init + drains on destroy', async () => {
    const drain = jest.fn().mockResolvedValue(undefined);
    const requestReply = {
      respond: jest.fn().mockResolvedValue({
        subject: 'policy.ingest_backend.snapshot',
        drain,
      }),
    } as unknown as NatsRequestReply;
    const snapshot: IngestBackendSnapshot = {
      defaultBackend: 'node',
      overrides: {},
    };
    const policyService = {
      getSnapshot: jest.fn().mockResolvedValue(snapshot),
    } as unknown as IngestBackendPolicyService;

    const responder = new PolicySnapshotResponder(requestReply, policyService);
    await responder.onModuleInit();

    expect(requestReply.respond).toHaveBeenCalledWith(
      'policy.ingest_backend.snapshot',
      expect.any(Function),
    );

    // Exercise the handler the respond() call registered — it
    // MUST delegate to policyService.getSnapshot exactly once.
    const [, handler] = (requestReply.respond as jest.Mock).mock.calls[0];
    const ctx: RequestReplyContext = {
      subject: 'policy.ingest_backend.snapshot',
    };
    const reply = await handler({} as IngestBackendSnapshotRequest, ctx);
    expect(reply).toEqual(snapshot);
    expect(policyService.getSnapshot).toHaveBeenCalledTimes(1);

    // Shutdown drains the subscription so in-flight replies
    // finish before the broker connection closes.
    await responder.onModuleDestroy();
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it('handleSnapshotRequest returns the service-provided snapshot verbatim', async () => {
    // Public handler is exposed so tests + an HTTP diagnostic
    // path can exercise it without the NATS respond() plumbing.
    const snapshot: IngestBackendSnapshot = {
      defaultBackend: 'rust',
      overrides: { 'tenant-a': 'node' },
    };
    const policyService = {
      getSnapshot: jest.fn().mockResolvedValue(snapshot),
    } as unknown as IngestBackendPolicyService;
    const requestReply = {
      respond: jest.fn(),
    } as unknown as NatsRequestReply;

    const responder = new PolicySnapshotResponder(requestReply, policyService);
    const reply = await responder.handleSnapshotRequest({}, {
      subject: 'policy.ingest_backend.snapshot',
    });
    expect(reply).toEqual(snapshot);
  });

  it('onModuleDestroy is a no-op when onModuleInit never ran', async () => {
    const requestReply = { respond: jest.fn() } as unknown as NatsRequestReply;
    const policyService = {
      getSnapshot: jest.fn(),
    } as unknown as IngestBackendPolicyService;
    const responder = new PolicySnapshotResponder(requestReply, policyService);
    // Must not throw — boot-time errors can leave the responder
    // half-initialised; tearDown needs to survive that.
    await expect(responder.onModuleDestroy()).resolves.toBeUndefined();
  });
});
