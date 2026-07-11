/**
 * ComputedRuleEvaluator — table-driven spec for the read-time 5%-rule
 * contract: value = percent% of the sum of NON-computed category totals
 * in the same scope (never of itself or of sibling computed categories).
 */
import Decimal from 'decimal.js';

import {
  ComputedCategoryValue,
  ComputedRuleEvaluator,
} from '../services/computed-rule-evaluator';
import {
  FinanceCategory,
  FinanceCategoryKind,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';

/** Base totals arrive as exact Decimals from the aggregation service. */
const dmap = (pairs: Array<[string, number]>): Map<string, Decimal> =>
  new Map(pairs.map(([id, v]) => [id, new Decimal(v)]));

/** Compare Decimal-valued results by their numeric value. */
const asNumbers = (
  result: ComputedCategoryValue[],
): Array<{ categoryId: string; code: string | null; value: number }> =>
  result.map((r) => ({ categoryId: r.categoryId, code: r.code, value: r.value.toNumber() }));

const makeCategory = (
  id: string,
  overrides: Partial<FinanceCategory> = {},
): FinanceCategory =>
  ({
    id,
    tenantId: 't-1',
    name: id,
    code: null,
    scope: FinanceCategoryScope.FARM_OPEX,
    kind: FinanceCategoryKind.EXPENSE,
    computedRule: null,
    isSystem: false,
    isActive: true,
    displayOrder: 0,
    ...overrides,
  }) as FinanceCategory;

describe('ComputedRuleEvaluator', () => {
  const evaluator = new ComputedRuleEvaluator();

  const cases: Array<{
    name: string;
    totals: Array<[string, number]>;
    percent: number;
    expected: number;
  }> = [
    { name: '5% of a single base category', totals: [['feed', 1000]], percent: 5, expected: 50 },
    {
      name: '5% across multiple base categories',
      totals: [
        ['feed', 1000],
        ['electricity', 500],
        ['oxygen', 250.5],
      ],
      percent: 5,
      // 5% of 1750.5 = 87.525 → HALF_EVEN (banker's rounding, the platform
      // Money VO SSoT) rounds the exact .525 to the even cent → 87.52.
      expected: 87.52,
    },
    { name: 'zero base → zero computed', totals: [], percent: 5, expected: 0 },
    { name: 'non-5 percent honoured', totals: [['feed', 200]], percent: 12.5, expected: 25 },
  ];

  it.each(cases)('$name', ({ totals, percent, expected }) => {
    const base = totals.map(([id]) => makeCategory(id));
    const computed = makeCategory('other-variable', {
      code: 'OTHER_VARIABLE',
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent, base: 'NON_COMPUTED' },
    });

    const result = evaluator.evaluate(
      [...base, computed],
      dmap(totals),
      FinanceCategoryScope.FARM_OPEX,
    );

    expect(asNumbers(result)).toEqual([
      { categoryId: 'other-variable', code: 'OTHER_VARIABLE', value: expected },
    ]);
  });

  it('excludes computed categories from each other’s base (non-self-referential)', () => {
    const feed = makeCategory('feed');
    const computedA = makeCategory('computed-a', {
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 5, base: 'NON_COMPUTED' },
    });
    const computedB = makeCategory('computed-b', {
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 10, base: 'NON_COMPUTED' },
    });

    // Even if a (buggy) caller passed a base total for a computed category,
    // it must not contribute: the base is non-computed categories only.
    const result = evaluator.evaluate(
      [feed, computedA, computedB],
      dmap([
        ['feed', 1000],
        ['computed-a', 999999],
      ]),
      FinanceCategoryScope.FARM_OPEX,
    );

    expect(asNumbers(result)).toEqual([
      { categoryId: 'computed-a', code: null, value: 50 },
      { categoryId: 'computed-b', code: null, value: 100 },
    ]);
  });

  it('never folds another scope’s totals into the percentage base (regression: FINANCE-HIGH-001)', () => {
    const feed = makeCategory('feed', { scope: FinanceCategoryScope.FARM_OPEX });
    const otherVariable = makeCategory('other-variable', {
      code: 'OTHER_VARIABLE',
      scope: FinanceCategoryScope.FARM_OPEX,
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 5, base: 'NON_COMPUTED' },
    });
    const harvestRevenue = makeCategory('harvest-revenue', {
      code: 'HARVEST_REVENUE',
      scope: FinanceCategoryScope.FARM_REVENUE,
      kind: FinanceCategoryKind.REVENUE,
    });

    // OPEX = 100_000, REVENUE = 1_000_000. The 5% OPEX line MUST be
    // 5% × 100_000 = 5_000 — revenue is a different scope and excluded.
    const result = evaluator.evaluate(
      [feed, otherVariable, harvestRevenue],
      dmap([
        ['feed', 100_000],
        ['harvest-revenue', 1_000_000],
      ]),
      FinanceCategoryScope.FARM_OPEX,
    );

    expect(asNumbers(result)).toEqual([
      { categoryId: 'other-variable', code: 'OTHER_VARIABLE', value: 5_000 },
    ]);
  });

  it('drops a computed category whose percent is outside (0,100] (FARM-MEDIUM-164)', () => {
    const feed = makeCategory('feed');
    const bogus = makeCategory('bogus', {
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 150, base: 'NON_COMPUTED' },
    });
    const zero = makeCategory('zero', {
      computedRule: { type: 'PERCENT_OF_SCOPE_TOTAL', percent: 0, base: 'NON_COMPUTED' },
    });

    const result = evaluator.evaluate(
      [feed, bogus, zero],
      dmap([['feed', 1000]]),
      FinanceCategoryScope.FARM_OPEX,
    );

    expect(result).toEqual([]);
  });

  it('returns an empty list when no computed categories exist', () => {
    expect(
      evaluator.evaluate(
        [makeCategory('feed')],
        dmap([['feed', 100]]),
        FinanceCategoryScope.FARM_OPEX,
      ),
    ).toEqual([]);
  });
});
