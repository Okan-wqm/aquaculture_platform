/** Shared money + labour-category formatting for the HR finance tab. */
import type { LaborCategory } from '../../../hooks/useHrFinance';

export function formatMoney(amount: number, currency: string): string {
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
