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

function rejectDirectHandlerDefault(dependency: string): never {
  throw new Error(
    `${dependency} direct-handler default is test-only; production handlers must receive an explicit DI dependency`,
  );
}

class DirectHandlerFarmStockProjectionService extends FarmStockProjectionService {
  override refreshContainers(
    _manager: EntityManager,
    _tenantId: string,
    _containerIds: readonly string[],
  ): Promise<void> {
    rejectDirectHandlerDefault('FarmStockProjectionService');
  }
}

class DirectHandlerMobileCommandReceiptService extends MobileCommandReceiptService {
  override begin(
    _manager: EntityManager,
    _options: BeginMobileCommandReceiptOptions,
  ): Promise<MobileCommandReceiptState> {
    rejectDirectHandlerDefault('MobileCommandReceiptService.begin');
  }

  override complete(
    _manager: EntityManager,
    _options: CompleteMobileCommandReceiptOptions,
  ): Promise<void> {
    rejectDirectHandlerDefault('MobileCommandReceiptService.complete');
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
    rejectDirectHandlerDefault('OutboxPublisher.enqueue');
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
