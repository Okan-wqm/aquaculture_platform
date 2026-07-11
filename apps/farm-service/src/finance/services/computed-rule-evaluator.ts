/**
 * ComputedRuleEvaluator — pure, read-time evaluation of category
 * computation rules.
 *
 * Contract for PERCENT_OF_SCOPE_TOTAL:
 *   value(category) = percent% × Σ totals of NON-computed categories in
 *   the same scope and period.
 *
 * The base is restricted to non-computed categories, which makes the
 * definition non-self-referential ("Other variable cost = 5% of total
 * operational cost" means 5% of the real, booked operational cost — not
 * of a total that already contains the 5% line). One deterministic pass,
 * no fixpoint iteration, and two computed categories in one scope cannot
 * feed each other.
 *
 * Pure function of its inputs — no I/O — so the table-driven unit spec
 * covers it exhaustively.
 */
import { Injectable } from '@nestjs/common';

import {
  FinanceCategory,
  FinanceCategoryScope,
} from '../entities/finance-category.entity';

export interface ComputedCategoryValue {
  categoryId: string;
  code: string | null;
  value: number;
}

/** A computed-rule percentage is only meaningful in the half-open range (0, 100]. */
function isValidPercent(percent: number): boolean {
  return Number.isFinite(percent) && percent > 0 && percent <= 100;
}

@Injectable()
export class ComputedRuleEvaluator {
  /**
   * Evaluate the computed categories of a SINGLE scope.
   *
   * `scope` is a required argument and the evaluator filters both the base
   * and the output to it, so a caller cannot accidentally fold another
   * scope's totals into the percentage base (e.g. harvest REVENUE inflating
   * the FARM_OPEX "5% of operational cost" line). The base is the sum of
   * NON-computed categories in that scope, which keeps the definition
   * non-self-referential and lets two computed categories in one scope
   * never feed each other.
   *
   * @param categories all categories (any scope, mixed computed + regular)
   * @param baseTotals categoryId → booked total for the queried period
   *                   (manual + derived; computed categories absent)
   * @param scope      the scope to evaluate; only its categories participate
   * @returns value per computed category IN `scope`, rounded to 2 decimals
   */
  evaluate(
    categories: readonly FinanceCategory[],
    baseTotals: ReadonlyMap<string, number>,
    scope: FinanceCategoryScope,
  ): ComputedCategoryValue[] {
    const scoped = categories.filter((c) => c.scope === scope);

    const nonComputedTotal = scoped
      .filter((c) => !c.computedRule)
      .reduce((sum, c) => sum + (baseTotals.get(c.id) ?? 0), 0);

    return scoped
      .filter((c): c is FinanceCategory & { computedRule: NonNullable<FinanceCategory['computedRule']> } =>
        Boolean(c.computedRule),
      )
      // Defense-in-depth: a percent outside (0,100] is a corrupted rule and
      // would emit a nonsensical cost line — drop it rather than surface it.
      .filter((c) => isValidPercent(c.computedRule.percent))
      .map((category) => {
        const { percent } = category.computedRule;
        const raw = (nonComputedTotal * percent) / 100;
        return {
          categoryId: category.id,
          code: category.code ?? null,
          value: Math.round(raw * 100) / 100,
        };
      });
  }
}
