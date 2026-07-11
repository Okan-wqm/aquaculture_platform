/** Shared money + labour-category formatting for the HR finance tab. */
import type { LaborCategory } from '../../../hooks/useHrFinance';

export function formatMoney(amount: number | null | undefined, currency: string): string {
  // Suppressed small-cell salary (HR-HIGH-001) arrives as null — render a dash,
  // never a fabricated 0 that would read as "this category costs nothing".
  if (amount === null || amount === undefined) {
    return '—';
  }
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  }).format(amount);
}

const CATEGORY_LABELS: Record<LaborCategory, string> = {
  manager: 'Managers',
  technical: 'Technicians / biologists / WQ experts',
  unskilled: 'Unskilled labour',
};

export function laborCategoryLabel(category: LaborCategory | null): string {
  return category ? CATEGORY_LABELS[category] : 'Unclassified';
}
