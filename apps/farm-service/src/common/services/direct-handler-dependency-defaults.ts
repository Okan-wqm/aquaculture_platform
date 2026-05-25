import {
  MobileCommandReceiptService,
  type BeginMobileCommandReceiptOptions,
  type CompleteMobileCommandReceiptOptions,
  type MobileCommandReceiptState,
} from '@aquaculture/backend-common/mobile-command';
import type { BaseEvent } from '@platform/event-contracts';
import { OutboxEntityBase, OutboxPublisher } from '@platform/outbox';
import type { EntityManager } from 'typeorm';

import { FarmStockProjectionService } from '../../farm-stock/farm-stock-projection.service';

class DirectHandlerFarmStockProjectionService extends FarmStockProjectionService {
  override refreshContainers(
    _manager: EntityManager,
    _tenantId: string,
    _containerIds: readonly string[],
  ): Promise<void> {
    return Promise.resolve();
  }
}

class DirectHandlerMobileCommandReceiptService extends MobileCommandReceiptService {
  override begin(
    _manager: EntityManager,
    _options: BeginMobileCommandReceiptOptions,
  ): Promise<MobileCommandReceiptState> {
    return Promise.resolve({ mode: 'legacy' });
  }

  override complete(
    _manager: EntityManager,
    _options: CompleteMobileCommandReceiptOptions,
  ): Promise<void> {
    return Promise.resolve();
  }
}

class DirectHandlerOutboxEntity extends OutboxEntityBase {}

class DirectHandlerOutboxPublisher extends OutboxPublisher {
  constructor() {
    super(DirectHandlerOutboxEntity);
  }

  override enqueue<TEvent extends BaseEvent>(
    _event: TEvent,
    _manager: EntityManager,
    _options?: { idempotencyKey?: string; aggregateId?: string },
  ): Promise<void> {
    return Promise.resolve();
  }
}

const directHandlerFarmStockProjection = new DirectHandlerFarmStockProjectionService();
const directHandlerMobileCommandReceipts = new DirectHandlerMobileCommandReceiptService();
const directHandlerOutboxPublisher = new DirectHandlerOutboxPublisher();

export function defaultFarmStockProjectionForDirectHandlerConstruction(): FarmStockProjectionService {
  return directHandlerFarmStockProjection;
}

export function defaultMobileCommandReceiptsForDirectHandlerConstruction(): MobileCommandReceiptService {
  return directHandlerMobileCommandReceipts;
}

export function defaultOutboxPublisherForDirectHandlerConstruction(): OutboxPublisher {
  return directHandlerOutboxPublisher;
}
