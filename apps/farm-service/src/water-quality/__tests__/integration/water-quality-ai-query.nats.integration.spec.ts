import 'reflect-metadata';
import { INestMicroservice } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { QueryBus } from '@platform/cqrs';
import { NatsV3Client, NatsV3Server } from '@aquaculture/backend-common/nats';
import {
  FARM_AI_QUERY_SUBJECTS,
  isAiQueryReply,
  isWaterQualityStatsReply,
} from '@platform/event-contracts';
import { firstValueFrom, timeout } from 'rxjs';
import { WaterQualityAiQueryResponder } from '../../responders/water-quality-ai-query.responder';

/**
 * The one real NATS round trip for the farm AI read contract
 * (FARM-MEDIUM-328): an ai-service-shaped NatsV3Client sends a contract
 * subject through the broker to a farm-service-shaped NatsV3Server hosting
 * the responder, and the envelope comes back through the Nest packet codec.
 * The query bus is a double (tenant pinning is the handler's unit-tested
 * concern); what this proves is the wire: subject, codec, envelope, guard.
 *
 * Runs only against a live broker (`npm run infra:up`, NATS_URL set) —
 * `nx run farm-service:test:integration`.
 */
const NATS_URL = process.env['NATS_URL'];
const describeWithNats = NATS_URL ? describe : describe.skip;

describeWithNats('farm AI read contract — NATS round trip (water quality)', () => {
  const TENANT = '11111111-1111-4111-8111-111111111111';
  const TANK = '22222222-2222-4222-8222-222222222222';
  const STATS = {
    avgTemperature: 14.2,
    avgDO: 8.1,
    avgPH: 7.6,
    avgAmmonia: null,
    avgNitrite: null,
    measurementCount: 3,
    criticalCount: 0,
    warningCount: 1,
    lastMeasurement: null,
  };

  let microservice: INestMicroservice;
  let client: NatsV3Client;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [WaterQualityAiQueryResponder],
      providers: [{ provide: QueryBus, useValue: { execute: jest.fn().mockResolvedValue(STATS) } }],
    }).compile();
    microservice = moduleRef.createNestMicroservice({
      strategy: new NatsV3Server({ serviceName: 'farm-service', queue: 'farm-service-it' }),
    });
    await microservice.listen();
    client = new NatsV3Client({ serviceName: 'ai-service' });
    await client.connect();
  });

  afterAll(async () => {
    await client?.close();
    await microservice?.close();
  });

  it('answers a well-formed request with an ok envelope that passes the contract guard', async () => {
    const reply: unknown = await firstValueFrom(
      client
        .send(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS, { tenantId: TENANT, tankId: TANK, days: 7 })
        .pipe(timeout(5000)),
    );

    expect(isAiQueryReply(reply)).toBe(true);
    if (!isAiQueryReply(reply) || !reply.ok) throw new Error('expected an ok envelope');
    expect(isWaterQualityStatsReply(reply.data)).toBe(true);
    expect(reply.data).toMatchObject({ scopeId: TANK, days: 7, measurementCount: 3 });
  });

  it('answers a malformed request with INVALID_REQUEST through the same codec', async () => {
    const reply: unknown = await firstValueFrom(
      client
        .send(FARM_AI_QUERY_SUBJECTS.WQ_TANK_STATS, { tenantId: TENANT, tankId: 'tank-1', days: 7 })
        .pipe(timeout(5000)),
    );

    expect(reply).toEqual({ ok: false, error: 'INVALID_REQUEST' });
  });
});
