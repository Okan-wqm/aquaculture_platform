import { Test, type TestingModule } from '@nestjs/testing';

import { CreateFeedingRecordOperationExecutor } from '../../feeding/executors/create-feeding-record-operation.executor';
import { UpdateFeedingRecordOperationExecutor } from '../../feeding/executors/update-feeding-record-operation.executor';
import { DayPlanOperationExecutor } from '../executors/day-plan-operation.executor';
import { MealOperationExecutor } from '../executors/meal-operation.executor';
import { ProtocolFeedForecastExecutor } from '../executors/protocol-feed-forecast.executor';
import { ScheduledFeedingOperationExecutor } from '../executors/scheduled-feeding-operation.executor';
import {
  FEEDING_OPERATION_HANDLER_ADAPTER,
  FEEDING_OPERATION_HANDLER_ADAPTER_PROVIDER,
  type FeedingOperationHandlerAdapterPort,
} from '../feeding-operation-handler.adapter';

describe('feeding operation result-codec authority', () => {
  let moduleRef: TestingModule;
  let adapter: FeedingOperationHandlerAdapterPort;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      providers: [
        FEEDING_OPERATION_HANDLER_ADAPTER_PROVIDER,
        {
          provide: ScheduledFeedingOperationExecutor,
          useValue: { executeScheduledOperation: jest.fn() },
        },
        {
          provide: ProtocolFeedForecastExecutor,
          useValue: { executeForecastOperation: jest.fn() },
        },
        {
          provide: DayPlanOperationExecutor,
          useValue: {
            executeRegenerateOperation: jest.fn(),
            executeTransitionOperation: jest.fn(),
          },
        },
        {
          provide: CreateFeedingRecordOperationExecutor,
          useValue: { executeFeedingRecordOperation: jest.fn() },
        },
        {
          provide: UpdateFeedingRecordOperationExecutor,
          useValue: { executeUpdateFeedingRecordOperation: jest.fn() },
        },
        {
          provide: MealOperationExecutor,
          useValue: {
            executeCorrectMealOperation: jest.fn(),
            executeFinalizeMealOperation: jest.fn(),
            executeSkipMealOperation: jest.fn(),
            executeRecordMealOperation: jest.fn(),
          },
        },
      ],
    }).compile();
    await moduleRef.init();
    adapter = moduleRef.get<FeedingOperationHandlerAdapterPort>(FEEDING_OPERATION_HANDLER_ADAPTER);
  });

  afterAll(async () => {
    await moduleRef.close();
  });

  it('boots only when the handler/result-codec registry exactly equals the catalog', () => {
    expect(adapter).toBeDefined();
  });

  it('round-trips typed scalar and meal results under job-specific schemas', () => {
    const forecast = adapter.encode('v2.forecast.refresh', 7);
    expect(forecast).toEqual({
      schema: 'feeding-operation-result/v2.forecast.refresh/v1',
      payload: { refreshedCount: 7 },
    });
    expect(adapter.decode('v2.forecast.refresh', forecast.schema, forecast.payload)).toBe(7);

    const meal = {
      id: '22222222-2222-4222-8222-222222222222',
      status: 'fed' as const,
      actualKg: 1e-7,
      varianceKg: -0,
      variancePercent: 1e21,
    };
    const encodedMeal = adapter.encode('mobile.meal.record', meal);
    expect(adapter.decode('mobile.meal.record', encodedMeal.schema, encodedMeal.payload)).toEqual({
      ...meal,
      varianceKg: 0,
    });
  });

  it('round-trips the recursive feeding-record codec without trusting object casts', () => {
    const result = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      batchId: '33333333-3333-4333-8333-333333333333',
      feedingDate: new Date('2026-08-08T00:00:00.000Z'),
      feedingTime: '08:15',
      feedingSequence: 1,
      totalMealsToday: 4,
      feedId: '44444444-4444-4444-8444-444444444444',
      plannedAmount: 12.5,
      actualAmount: 12.25,
      variance: -0.25,
      variancePercent: -2,
      environment: {
        waterTemp: 21.4,
        weather: 'cloudy' as const,
        visibility: 'clear' as const,
      },
      fishBehavior: {
        appetite: 'good' as const,
        feedingIntensity: 8,
        schoolingBehavior: 'normal' as const,
      },
      feedingMethod: 'manual' as const,
      feedCostDecimal: 42.75,
      currency: 'TRY',
      fedBy: '55555555-5555-4555-8555-555555555555',
      createdAt: new Date('2026-08-08T08:15:00.000Z'),
      updatedAt: new Date('2026-08-08T08:15:01.000Z'),
    };

    const encoded = adapter.encode('manual.feeding.record', result);
    expect(adapter.decode('manual.feeding.record', encoded.schema, encoded.payload)).toEqual(
      result,
    );
  });

  it.each([
    {
      label: 'unknown top-level field',
      patch: { injected: true },
      message: /unknown field/,
    },
    {
      label: 'unknown nested field',
      patch: { environment: { waterTemp: 20, injected: true } },
      message: /unknown field/,
    },
    {
      label: 'non-finite nested number',
      patch: { environment: { dissolvedOxygen: Number.NaN } },
      message: /finite number/,
    },
    {
      label: 'invalid nested enum',
      patch: { fishBehavior: { appetite: 'hungry', feedingIntensity: 8 } },
      message: /invalid/,
    },
    {
      label: 'invalid canonical timestamp',
      patch: { feedingDate: '2026-08-08' },
      message: /canonical ISO timestamp/,
    },
  ])('rejects $label in a persisted feeding record', ({ patch, message }) => {
    const payload = {
      id: '11111111-1111-4111-8111-111111111111',
      tenantId: '22222222-2222-4222-8222-222222222222',
      batchId: '33333333-3333-4333-8333-333333333333',
      feedingDate: '2026-08-08T00:00:00.000Z',
      feedingTime: '08:15',
      feedingSequence: 1,
      totalMealsToday: 4,
      feedId: '44444444-4444-4444-8444-444444444444',
      plannedAmount: 12.5,
      actualAmount: 12.25,
      variance: -0.25,
      variancePercent: -2,
      feedingMethod: 'manual',
      feedCostDecimal: null,
      fedBy: '55555555-5555-4555-8555-555555555555',
      createdAt: '2026-08-08T08:15:00.000Z',
      updatedAt: '2026-08-08T08:15:01.000Z',
      ...patch,
    };

    expect(() =>
      adapter.decode(
        'manual.feeding.record',
        'feeding-operation-result/manual.feeding.record/v1',
        payload,
      ),
    ).toThrow(message);
  });

  it('rejects schema substitution and malformed scalar replay payloads', () => {
    expect(() =>
      adapter.decode('manual.meal.skip', 'feeding-operation-result/mobile.meal.record/v1', {}),
    ).toThrow(/is not/);
    expect(() =>
      adapter.decode('v2.forecast.refresh', 'feeding-operation-result/v2.forecast.refresh/v1', {
        refreshedCount: 1,
        injected: true,
      }),
    ).toThrow(/unknown field/);
  });
});
