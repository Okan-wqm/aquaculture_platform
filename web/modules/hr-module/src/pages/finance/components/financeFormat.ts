/** Shared money + labour-category formatting for the HR finance tab. */
import type { LaborCategory } from '../../../hooks/useHrFinance';

export function formatMoney(
  amount: number | string | null | undefined,
  currency: string,
): string {
  // Suppressed small-cell salary (HR-HIGH-001) arrives as null — render a dash,
  // never a fabricated 0 that would read as "this category costs nothing".
  // Money now crosses the wire as an exact decimal STRING (Decimal scalar,
  // ADR-0004); coerce to a number only here, at the display boundary.
  if (amount === null || amount === undefined) {
    return '—';
  }
  const value = typeof amount === 'number' ? amount : Number(amount);
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

const CATEGORY_LABELS: Record<LaborCategory, string> = {
  manager: 'Managers',
  technical: 'Technicians / biologists / WQ experts',
  unskilled: 'Unskilled labour',
};

export function laborCategoryLabel(category: LaborCategory | null): string {
  return category ? CATEGORY_LABELS[category] : 'Unclassified';
}
