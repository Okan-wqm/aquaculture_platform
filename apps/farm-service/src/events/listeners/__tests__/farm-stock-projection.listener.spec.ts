/**
 * FarmStockProjectionListener unit tests.
 *
 * Covers the event-driven read-model refresh: container-id extraction across the
 * differently-shaped stock events, the fan-out subscription, and the fail-closed
 * tenant guard. The shared refreshContainers SSoT is mocked (its projection SQL
 * is covered by the farm-stock-projection integration tests).
 */
import { createMockDataSource } from '@aquaculture/testing';
import type { BaseEvent } from '@platform/event-contracts';

import { FarmStockProjectionService } from '../../../farm-stock/farm-stock-projection.service';
import { FarmStockProjectionListener } from '../farm-stock-projection.listener';
import { makeMockEventBus } from './make-mock-event-bus';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function baseEvent(overrides: Record<string, unknown>): BaseEvent {
  return {
    eventId: 'evt-1',
    eventType: 'MortalityRecorded',
    tenantId: TENANT,
    ...overrides,
  } as BaseEvent;
}

function makeHarness() {
  const { mockDataSource } = createMockDataSource();
  const refreshContainers = jest.fn().mockResolvedValue(undefined);
  const projectionService = {
    refreshContainers,
  } as Partial<FarmStockProjectionService> as FarmStockProjectionService;
  const eventBus = makeMockEventBus();
  const listener = new FarmStockProjectionListener(
    mockDataSource,
    projectionService,
    eventBus,
  );
  return { listener, refreshContainers, eventBus };
}

describe('FarmStockProjectionListener', () => {
  describe('extractContainerIds', () => {
    it('reads a single tankId (mortality/cull/allocate/feeding/cleaner shapes)', () => {
      expect(
        FarmStockProjectionListener.extractContainerIds(
          baseEvent({ tankId: 'tank-1' }),
        ),
      ).toEqual(['tank-1']);
    });

    it('reads source + destination for a transfer', () => {
      expect(
        FarmStockProjectionListener.extractContainerIds(
          baseEvent({ sourceTankId: 'tank-1', destinationTankId: 'tank-2' }),
        ),
      ).toEqual(['tank-1', 'tank-2']);
    });

    it('reads the tankIds[] of an initial-stocking BatchCreated (the "180 fish" gap)', () => {
      expect(
        FarmStockProjectionListener.extractContainerIds(
          baseEvent({ eventType: 'BatchCreated', tankIds: ['tank-1', 'tank-2'] }),
        ),
      ).toEqual(['tank-1', 'tank-2']);
    });

    it('dedups + drops empty/non-string ids', () => {
      expect(
        FarmStockProjectionListener.extractContainerIds(
          baseEvent({ tankId: 'tank-1', tankIds: ['tank-1', '', 'tank-3'] }),
        ),
      ).toEqual(['tank-1', 'tank-3']);
    });

    it('returns [] when no tank reference is present', () => {
      expect(
        FarmStockProjectionListener.extractContainerIds(baseEvent({})),
      ).toEqual([]);
    });
  });

  describe('onModuleInit', () => {
    it('subscribes the listener to every stock-mutation event', async () => {
      const { listener, eventBus } = makeHarness();
      await listener.onModuleInit();
      // 7 stock-mutation events (BatchCreated, BatchAllocatedToTank,
      // BatchTransferred, MortalityRecorded, CullRecorded,
      // CleanerFishMortalityRecorded, FeedingRecorded).
      expect(eventBus.subscribeWildcard).toHaveBeenCalledTimes(7);
      expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('BatchCreated', listener);
      expect(eventBus.subscribeWildcard).toHaveBeenCalledWith('BatchTransferred', listener);
    });
  });

  describe('handle', () => {
    it('refreshes the affected container snapshots for a valid event', async () => {
      const { listener, refreshContainers } = makeHarness();
      await listener.handle(baseEvent({ tankId: 'tank-1' }));
      expect(refreshContainers).toHaveBeenCalledTimes(1);
      expect(refreshContainers).toHaveBeenCalledWith(
        expect.anything(),
        TENANT,
        ['tank-1'],
      );
    });

    it('refreshes BOTH legs of a transfer', async () => {
      const { listener, refreshContainers } = makeHarness();
      await listener.handle(
        baseEvent({
          eventType: 'BatchTransferred',
          sourceTankId: 'tank-1',
          destinationTankId: 'tank-2',
        }),
      );
      expect(refreshContainers).toHaveBeenCalledWith(
        expect.anything(),
        TENANT,
        ['tank-1', 'tank-2'],
      );
    });

    it('fails closed on a missing/invalid tenantId — never refreshes', async () => {
      const { listener, refreshContainers } = makeHarness();
      await listener.handle(baseEvent({ tenantId: 'not-a-uuid', tankId: 'tank-1' }));
      expect(refreshContainers).not.toHaveBeenCalled();
    });

    it('is a no-op when the event carries no tank reference', async () => {
      const { listener, refreshContainers } = makeHarness();
      await listener.handle(baseEvent({}));
      expect(refreshContainers).not.toHaveBeenCalled();
    });
  });
});
