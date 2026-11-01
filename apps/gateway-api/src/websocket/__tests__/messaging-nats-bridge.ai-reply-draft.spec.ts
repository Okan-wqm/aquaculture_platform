import type { ConfigService } from '@nestjs/config';
import type { Server } from 'socket.io';
import type { ClientProxy } from '@nestjs/microservices';
import type { JwtService } from '@nestjs/jwt';
import { AI_REPLY_DRAFT_SUBSCRIPTION } from '@platform/event-contracts';
import { TenantConnectionLimiter, WsTokenRevalidator } from '@aquaculture/backend-common/websocket';

const mockConnect = jest.fn();
jest.mock('@nats-io/transport-node', () => ({
  connect: (...args: unknown[]) => mockConnect(...args),
}));

import { MessagingGateway } from '../messaging.gateway';
import { MessagingNatsBridgeService } from '../messaging-nats-bridge.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const CHANNEL = '22222222-2222-4222-8222-222222222222';
const REPLY_KEY = '33333333-3333-5333-8333-333333333333';

interface FakeMsg {
  subject: string;
  string(): string;
}

/** An async iterable of `messages` that ends after the last one. */
function subscription(messages: FakeMsg[]): AsyncIterable<FakeMsg> & { unsubscribe(): void } {
  return {
    unsubscribe: () => undefined,
    async *[Symbol.asyncIterator]() {
      yield* messages;
    },
  };
}

/** A NATS message as messaging-service's Nest client publishes it. */
const published = (subject: string, data: unknown): FakeMsg => ({
  subject,
  string: () => JSON.stringify({ pattern: subject, data }),
});

const subject = (tenantId: string): string => `live.${tenantId}.AiReplyDraft`;
const writing = { tenantId: TENANT, channelId: CHANNEL, replyKey: REPLY_KEY, phase: 'writing' };

describe('MessagingNatsBridgeService AI reply drafts (MSG-MEDIUM-089)', () => {
  let emit: jest.Mock;
  let to: jest.Mock;
  let revalidator: WsTokenRevalidator;
  let bridge: MessagingNatsBridgeService;

  afterEach(async () => {
    await bridge.onModuleDestroy();
    revalidator.onModuleDestroy();
  });

  async function relay(messages: FakeMsg[]): Promise<void> {
    emit = jest.fn();
    to = jest.fn(() => ({ emit }));
    let closed = false;
    let markClosed: () => void = () => undefined;
    const whenClosed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    mockConnect.mockResolvedValue({
      subscribe: (name: string) =>
        subscription(name === AI_REPLY_DRAFT_SUBSCRIPTION ? messages : []),
      status: () => subscription([]),
      isClosed: () => closed,
      closed: () => whenClosed,
      drain: async () => {
        closed = true;
        markClosed();
      },
    });
    revalidator = new WsTokenRevalidator({ intervalMs: 3_600_000, isStillValid: async () => true });
    const gateway = new MessagingGateway(
      {} as Partial<JwtService> as JwtService,
      { get: () => 'test' } as Partial<ConfigService> as ConfigService,
      new TenantConnectionLimiter(),
      revalidator,
      undefined,
      {} as Partial<ClientProxy> as ClientProxy,
    );
    gateway.server = { to } as Partial<Server> as Server;
    bridge = new MessagingNatsBridgeService(
      {
        get: (_key: string, fallback: string) => fallback,
      } as Partial<ConfigService> as ConfigService,
      gateway,
    );
    await bridge.onModuleInit();
    // Let the subscription loops drain their messages.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('relays each draft to its channel room, in order, with only the envelope fields', async () => {
    await relay([
      published(subject(TENANT), { ...writing, turn: 1, text: 'Water ' }),
      published(subject(TENANT), { ...writing, turn: 1, text: 'is fine.' }),
      published(subject(TENANT), {
        tenantId: TENANT,
        channelId: CHANNEL,
        replyKey: REPLY_KEY,
        phase: 'stored',
      }),
    ]);

    expect(to).toHaveBeenCalledWith(`channel:${TENANT}:${CHANNEL}`);
    expect(emit.mock.calls).toEqual([
      [
        'aiReplyDraft',
        { channelId: CHANNEL, replyKey: REPLY_KEY, phase: 'writing', turn: 1, text: 'Water ' },
      ],
      [
        'aiReplyDraft',
        { channelId: CHANNEL, replyKey: REPLY_KEY, phase: 'writing', turn: 1, text: 'is fine.' },
      ],
      ['aiReplyDraft', { channelId: CHANNEL, replyKey: REPLY_KEY, phase: 'stored' }],
    ]);
  });

  it.each([
    [
      'a draft naming another tenant than its subject',
      published(subject(OTHER_TENANT), { ...writing, turn: 1, text: 'x' }),
    ],
    ['a draft that is not one', published(subject(TENANT), { ...writing, turn: 1 })],
    [
      'a message that is not a Nest event packet',
      {
        subject: subject(TENANT),
        string: () => JSON.stringify({ ...writing, turn: 1, text: 'x' }),
      },
    ],
    ['a message that is not JSON', { subject: subject(TENANT), string: () => 'not json' }],
  ])('drops %s', async (_name, message) => {
    await relay([message]);

    expect(emit).not.toHaveBeenCalled();
  });
});
