import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  FARM_SIGNAL_DELIVERY_SEMANTICS,
  requiresDurableDelivery,
} from '../../libs/event-contracts/src/event-delivery-semantics';

const REPO_ROOT = resolve(__dirname, '..', '..');
const ALERT_HANDLER_DIR = resolve(REPO_ROOT, 'apps/alert-engine/src/alert/event-handlers');

function productionHandlerFiles(): string[] {
  return readdirSync(ALERT_HANDLER_DIR)
    .filter((name) => name.endsWith('.handler.ts'))
    .map((name) => resolve(ALERT_HANDLER_DIR, name));
}

function subscribedTypes(source: string): string[] {
  const direct = [...source.matchAll(/subscribeWildcard(?:<[^>]*>)?\(\s*'([A-Za-z]+)'/g)].map(
    (match) => match[1]!,
  );
  const list = /SUBSCRIBED_TYPES[^=]*=\s*\[([^\]]*)\]/s.exec(source)?.[1] ?? '';
  return [...new Set([...direct, ...[...list.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!)])];
}

describe('feeding event delivery authority', () => {
  it('classifies every alert-engine subscription in the typed event-owned registry', () => {
    const subscriptions = productionHandlerFiles().flatMap((file) =>
      subscribedTypes(readFileSync(file, 'utf8')),
    );
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(
      subscriptions.filter((eventType) => !(eventType in FARM_SIGNAL_DELIVERY_SEMANTICS)),
    ).toEqual([]);
  });

  it('pins irreversible feeding transitions to durable delivery', () => {
    expect(requiresDurableDelivery('MealMissed')).toBe(true);
    expect(requiresDurableDelivery('MealUnderfed')).toBe(true);
    expect(requiresDurableDelivery('FeedingDailySummary')).toBe(true);
    expect(requiresDurableDelivery('LowStockDetected')).toBe(true);
    expect(requiresDurableDelivery('MealWindowUpcoming')).toBe(false);
    expect(requiresDurableDelivery('FeedingWindowReadiness')).toBe(false);
  });

  it('forces every catching alert handler to defer to the event-owned policy', () => {
    const violations = productionHandlerFiles()
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        return /}\s*catch\s*\(/.test(source) && !/requiresDurableDelivery\s*\(/.test(source);
      })
      .map((file) => file.split('/').pop());
    expect(violations).toEqual([]);
  });

  it('wires a durable shelf into every service that consumes governed one-shot events', () => {
    const serviceConsumers = [
      {
        module: 'apps/alert-engine/src/app.module.ts',
        sources: productionHandlerFiles(),
      },
      {
        module: 'apps/notification-service/src/app.module.ts',
        sources: [
          resolve(
            REPO_ROOT,
            'apps/notification-service/src/notification/event-handlers/feeding-daily-summary.handler.ts',
          ),
        ],
      },
    ];

    for (const service of serviceConsumers) {
      const oneShotSubscriptions = service.sources
        .flatMap((file) => subscribedTypes(readFileSync(file, 'utf8')))
        .filter(requiresDurableDelivery);
      expect(oneShotSubscriptions.length).toBeGreaterThan(0);
      expect(readFileSync(resolve(REPO_ROOT, service.module), 'utf8')).toContain(
        'DeadLetterModule.forRoot',
      );
    }
  });

  it('keeps transport retirement and durable persistence behind shared authorities', () => {
    const bus = readFileSync(
      resolve(REPO_ROOT, 'platform/libs/event-bus/src/nats/nats-event-bus.ts'),
      'utf8',
    );
    const disposition = readFileSync(
      resolve(REPO_ROOT, 'platform/libs/event-bus/src/nats/message-disposition.ts'),
      'utf8',
    );
    const sink = readFileSync(
      resolve(REPO_ROOT, 'libs/backend-common/src/events/typeorm-dead-letter.sink.ts'),
      'utf8',
    );
    expect(bus).toContain('settleFailedMessage({');
    expect(disposition.indexOf('await sink.record')).toBeLessThan(
      disposition.indexOf('msg.term()'),
    );
    expect(sink).toContain('pg_advisory_xact_lock');
    expect(sink).toContain('WHERE NOT EXISTS');
  });
});
