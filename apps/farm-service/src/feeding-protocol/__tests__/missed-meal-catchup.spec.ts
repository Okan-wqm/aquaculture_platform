/**
 * W5 kaçırılan öğün telafisi — kullanıcı kararı 3'ün pinlenmesi.
 *
 * KURAL: kaçırılan/atlanan öğünün kg'ı kalan öğünlere **OTOMATİK
 * DAĞITILMAZ**. Balığın günlük sindirim kapasitesi sabittir; kaçan öğünü
 * sonrakilere yüklemek aşırı besleme, yem israfı ve amonyak yüküdür. Telafi
 * ancak tenant açıkça bir yüzde tanımladığında ve yalnız o yüzde kadar
 * uygulanır.
 *
 * Bu davranış varsayılan olduğu için ayrıca REGRESYON pinidir: ileride biri
 * "kaçan kg'ı kalan öğünlere dağıtalım" diye kolaylık eklerse bu spec kırılır.
 */
import { EntityManager } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';

import { DayPlanRecalcService } from '../services/day-plan-recalc.service';
import { ProtocolResolutionService } from '../services/protocol-resolution.service';
import { ProtocolRateService } from '../services/protocol-rate.service';
import { distributeCatchUp } from '../services/meal-schedule.util';
import { FeedingDayPlan } from '../entities/feeding-day-plan.entity';
import { FeedingMeal, FeedingMealStatus } from '../entities/feeding-meal.entity';
import { FeedingProtocolV2 } from '../entities/feeding-protocol-v2.entity';
import { ProtocolAssignment } from '../entities/protocol-assignment.entity';

const TENANT = '11111111-1111-4111-8111-111111111111';

function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

describe('distributeCatchUp — SAF (kullanıcı kararı 3)', () => {
  const remaining = [{ percentOfDaily: 40 }, { percentOfDaily: 20 }];

  it('VARSAYILAN (yüzde 0): hiçbir öğüne kg EKLENMEZ', () => {
    expect(distributeCatchUp(10, 0, remaining)).toEqual([0, 0]);
  });

  it('yüzde verilirse kaçan kg’ın O KADARI, öğünlerin KENDİ yüzdeleri oranında dağıtılır', () => {
    // 12 kg kaçtı, telafi %50 → 6 kg; kalan öğünler 40/60 ve 20/60 payla.
    expect(distributeCatchUp(12, 50, remaining)).toEqual([4, 2]);
  });

  it('yüzde 100 tam telafi eder', () => {
    expect(distributeCatchUp(12, 100, remaining)).toEqual([8, 4]);
  });

  it('kalan öğün yoksa dağıtım yapılmaz (gün bitmiş)', () => {
    expect(distributeCatchUp(12, 100, [])).toEqual([]);
  });

  it('aralık dışındaki yüzde clamp’lenir (negatif = dağıtım yok)', () => {
    expect(distributeCatchUp(12, -30, remaining)).toEqual([0, 0]);
    expect(distributeCatchUp(12, 500, remaining)).toEqual([8, 4]);
  });
});

describe('DayPlanRecalcService.applyMissedCatchUp', () => {
  function makeHarness(opts: {
    protocolPercent?: number;
    assignmentPercent?: number;
    meals: Array<Partial<FeedingMeal>>;
  }) {
    const saved: Array<{ id?: string; plannedKg?: number }> = [];
    const findOne = jest.fn(async (entity: unknown) => {
      if (entity === ProtocolAssignment) {
        return {
          overrides:
            opts.assignmentPercent === undefined
              ? {}
              : { missedMealCatchUpPercent: opts.assignmentPercent },
        };
      }
      if (entity === FeedingProtocolV2) {
        return {
          settings:
            opts.protocolPercent === undefined
              ? {}
              : { missedMealCatchUpPercent: opts.protocolPercent },
        };
      }
      return null;
    });
    const builder = {
      setLock: () => builder,
      where: () => builder,
      andWhere: () => builder,
      orderBy: () => builder,
      getMany: async () => opts.meals,
    };
    const manager = mock<EntityManager>({
      findOne: findOne as never,
      createQueryBuilder: (() => builder) as never,
      save: (async (entity: { id?: string; plannedKg?: number }) => {
        saved.push(entity);
        return entity;
      }) as never,
    });
    const service = new DayPlanRecalcService(
      mock<OutboxPublisher>({ enqueue: jest.fn() }),
      new ProtocolResolutionService(new ProtocolRateService()),
    );
    const dayPlan = mock<FeedingDayPlan>({
      id: 'dp-1',
      assignmentId: 'a-1',
      protocolId: 'p-1',
      plannedTotalKg: 30,
      snapshot: mock<FeedingDayPlan['snapshot']>({ biomassKg: 1000 }),
      recalcLog: [],
    });
    return { service, manager, dayPlan, saved };
  }

  const remainingMeals: Array<Partial<FeedingMeal>> = [
    {
      id: 'm-2',
      mealIndex: 1,
      percentOfDaily: 40,
      plannedKg: 12,
      status: FeedingMealStatus.SCHEDULED,
    },
    {
      id: 'm-3',
      mealIndex: 2,
      percentOfDaily: 20,
      plannedKg: 6,
      status: FeedingMealStatus.SCHEDULED,
    },
  ];

  it('telafi yüzdesi TANIMSIZ iken kalan öğünlerin plannedKg’ı DEĞİŞMEZ', async () => {
    const harness = makeHarness({ meals: remainingMeals });

    const added = await harness.service.applyMissedCatchUp(
      harness.manager,
      TENANT,
      harness.dayPlan,
      12,
    );

    expect(added).toBe(0);
    expect(harness.saved).toHaveLength(0);
    expect(remainingMeals[0]!.plannedKg).toBe(12);
    expect(remainingMeals[1]!.plannedKg).toBe(6);
    expect(harness.dayPlan.plannedTotalKg).toBe(30);
  });

  it('protokol yüzdesi tanımlıysa kalan öğünler oransal olarak artar ve recalcLog’a düşer', async () => {
    const meals = remainingMeals.map((meal) => ({ ...meal }));
    const harness = makeHarness({ protocolPercent: 50, meals });

    const added = await harness.service.applyMissedCatchUp(
      harness.manager,
      TENANT,
      harness.dayPlan,
      12,
    );

    expect(added).toBeCloseTo(6);
    expect(meals[0]!.plannedKg).toBeCloseTo(16); // 12 + 4
    expect(meals[1]!.plannedKg).toBeCloseTo(8); // 6 + 2
    expect(harness.dayPlan.plannedTotalKg).toBeCloseTo(36);
    expect(harness.dayPlan.recalcLog.at(-1)?.reason).toBe('missed_catchup');
  });

  it('atama override’ı protokol ayarını EZER (ünite bazlı karar)', async () => {
    const meals = remainingMeals.map((meal) => ({ ...meal }));
    const harness = makeHarness({ protocolPercent: 100, assignmentPercent: 0, meals });

    const added = await harness.service.applyMissedCatchUp(
      harness.manager,
      TENANT,
      harness.dayPlan,
      12,
    );

    expect(added).toBe(0);
    expect(meals[0]!.plannedKg).toBe(12);
  });
});
