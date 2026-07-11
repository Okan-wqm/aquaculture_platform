/**
 * Farm Finance hooks
 *
 * TanStack Query wrappers over the finance GraphQL surface. Every query
 * key is tenant-scoped via createTenantQueryKey (FE-CRITICAL-014 —
 * cross-tenant cache-leak guard).
 */
import { graphqlClient, useTenantMutation, useTenantQuery } from '@aquaculture/shared-ui';

import {
  ARCHIVE_FINANCE_CATEGORY,
  CREATE_FINANCE_CATEGORY,
  CREATE_FINANCE_ENTRY,
  DELETE_FINANCE_ENTRY,
  GET_FINANCE_BATCH_TOTALS,
  GET_FINANCE_CATEGORIES,
  GET_FINANCE_LEDGER,
  GET_FINANCE_SETTINGS,
  GET_FINANCE_SUMMARY,
  RESTORE_FINANCE_CATEGORY,
  UPDATE_FINANCE_CATEGORY,
  UPDATE_FINANCE_ENTRY,
  UPDATE_FINANCE_SETTINGS,
} from '../graphql/finance.operations';

// ============================================================================
// Types (mirror the farm subgraph finance types)
// ============================================================================

export type FinanceCategoryScope = 'FARM_OPEX' | 'FARM_REVENUE';
export type FinanceCategoryKind = 'EXPENSE' | 'REVENUE';
export type FinanceLineOrigin = 'MANUAL' | 'DERIVED';
export type FinanceGranularity = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export interface FinanceCategory {
  id: string;
  name: string;
  code?: string | null;
  scope: FinanceCategoryScope;
  kind: FinanceCategoryKind;
  computedRule?: { type: string; percent: number; base: string } | null;
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceEntry {
  id: string;
  categoryId: string;
  entryDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** @deprecated Float — use `amountDecimal` (exact decimal string, ADR-0004). */
  amount: number;
  /** Exact-decimal amount as a string (Decimal scalar). Parse with `parseMoney`. */
  amountDecimal: string;
  currency: string;
  description?: string | null;
  siteId?: string | null;
  batchId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FinanceLineItem {
  id: string;
  origin: FinanceLineOrigin;
  categoryId?: string | null;
  categoryCode?: string | null;
  categoryName: string;
  kind: FinanceCategoryKind;
  /** @deprecated Float — use `amountDecimal` (exact decimal string, ADR-0004). */
  amount: number;
  /** Exact-decimal amount as a string (Decimal scalar). Parse with `parseMoney`. */
  amountDecimal: string;
  currency: string;
  entryDate: string;
  batchId?: string | null;
  siteId?: string | null;
  description?: string | null;
  estimated: boolean;
  editable: boolean;
  sourceDomain?: string | null;
  sourceRecordId?: string | null;
}

export interface FinanceCategoryTotal {
  categoryId: string;
  categoryCode?: string | null;
  categoryName: string;
  scope: FinanceCategoryScope;
  kind: FinanceCategoryKind;
  isComputed: boolean;
  isDerived: boolean;
  // Money crosses as exact decimal STRINGS via the Decimal scalar (ADR-0004);
  // parse with `parseMoney` at the display/arithmetic boundary.
  totalDecimal: string;
}

export interface FinanceTimeBucket {
  bucketStart: string;
  totalExpenseDecimal: string;
  totalRevenueDecimal: string;
}

export interface FinanceSummary {
  currency: string;
  totalExpenseDecimal: string;
  totalRevenueDecimal: string;
  netResultDecimal: string;
  byCategory: FinanceCategoryTotal[];
  series: FinanceTimeBucket[];
}

export interface FinanceBatchTotal {
  batchId: string;
  totalExpenseDecimal: string;
  totalRevenueDecimal: string;
}

export interface FinanceSettings {
  id: string;
  defaultCurrency: string;
  fiscalYearStartMonth: number;
  updatedAt: string;
}

export interface FinanceLedgerFilter {
  from?: string;
  to?: string;
  scope?: FinanceCategoryScope;
  categoryId?: string;
  batchId?: string;
  siteId?: string;
  includeDerived?: boolean;
  limit?: number;
  offset?: number;
}

export interface CreateFinanceEntryInput {
  categoryId: string;
  entryDate: string;
  amount: number;
  description?: string;
  siteId?: string;
  batchId?: string;
  periodStart?: string;
  periodEnd?: string;
}

export type UpdateFinanceEntryInput = Partial<CreateFinanceEntryInput>;

export interface CreateFinanceCategoryInput {
  name: string;
  scope: FinanceCategoryScope;
  kind?: FinanceCategoryKind;
  displayOrder?: number;
}

export interface UpdateFinanceCategoryInput {
  name?: string;
  displayOrder?: number;
}

export interface UpdateFinanceSettingsInput {
  defaultCurrency?: string;
  fiscalYearStartMonth?: number;
}

// ============================================================================
// Query hooks — useTenantQuery adds the tenant prefix + auth gating for us.
// ============================================================================

export function useFinanceCategories(scope?: FinanceCategoryScope, includeArchived = false) {
  return useTenantQuery(
    ['finance', 'categories', scope ?? 'all', includeArchived],
    async () => {
      const data = await graphqlClient.request<{ financeCategories: FinanceCategory[] }>(
        GET_FINANCE_CATEGORIES,
        { scope, includeArchived },
      );
      return data.financeCategories;
    },
  );
}

export function useFinanceLedger(filter: FinanceLedgerFilter) {
  return useTenantQuery(
    ['finance', 'ledger', filter],
    async () => {
      const data = await graphqlClient.request<{ financeLedger: FinanceLineItem[] }>(
        GET_FINANCE_LEDGER,
        { includeDerived: true, limit: 50, offset: 0, ...filter },
      );
      return data.financeLedger;
    },
  );
}

export function useFinanceSummary(from: string, to: string, granularity: FinanceGranularity) {
  return useTenantQuery(
    ['finance', 'summary', from, to, granularity],
    async () => {
      const data = await graphqlClient.request<{ financeSummary: FinanceSummary }>(
        GET_FINANCE_SUMMARY,
        { from, to, granularity },
      );
      return data.financeSummary;
    },
    { enabled: Boolean(from && to) },
  );
}

export function useFinanceBatchTotals(from: string, to: string) {
  return useTenantQuery(
    ['finance', 'batchTotals', from, to],
    async () => {
      const data = await graphqlClient.request<{ financeBatchTotals: FinanceBatchTotal[] }>(
        GET_FINANCE_BATCH_TOTALS,
        { from, to },
      );
      return data.financeBatchTotals;
    },
    { enabled: Boolean(from && to) },
  );
}

export function useFinanceSettings() {
  return useTenantQuery(
    ['finance', 'settings'],
    async () => {
      const data = await graphqlClient.request<{ financeSettings: FinanceSettings }>(
        GET_FINANCE_SETTINGS,
      );
      return data.financeSettings;
    },
  );
}

// ============================================================================
// Mutation hooks — useTenantMutation invalidates the tenant-scoped finance
// prefix on success (declare domain segments; the tenant prefix is added).
// ============================================================================

// Scoped invalidation — a mutation refetches only the queries it actually
// affects, not the entire finance surface (PERF-005). Entry mutations move the
// ledger + aggregates; category mutations also move the catalogue; a settings
// change (currency/fiscal year) moves everything that renders in that currency.
const AGG_KEYS = [
  ['finance', 'ledger'],
  ['finance', 'summary'],
  ['finance', 'batchTotals'],
] as const;
const INVALIDATE_ENTRIES: ReadonlyArray<readonly unknown[]> = AGG_KEYS;
const INVALIDATE_CATEGORIES: ReadonlyArray<readonly unknown[]> = [
  ['finance', 'categories'],
  ...AGG_KEYS,
];
const INVALIDATE_SETTINGS: ReadonlyArray<readonly unknown[]> = [
  ['finance', 'settings'],
  ...AGG_KEYS,
];

export function useCreateFinanceEntry() {
  return useTenantMutation(
    async (input: CreateFinanceEntryInput) => {
      const data = await graphqlClient.request<{ createFinanceEntry: FinanceEntry }>(
        CREATE_FINANCE_ENTRY,
        { input },
      );
      return data.createFinanceEntry;
    },
    { invalidate: INVALIDATE_ENTRIES },
  );
}

export function useUpdateFinanceEntry() {
  return useTenantMutation(
    async ({ id, input }: { id: string; input: UpdateFinanceEntryInput }) => {
      const data = await graphqlClient.request<{ updateFinanceEntry: FinanceEntry }>(
        UPDATE_FINANCE_ENTRY,
        { id, input },
      );
      return data.updateFinanceEntry;
    },
    { invalidate: INVALIDATE_ENTRIES },
  );
}

export function useDeleteFinanceEntry() {
  return useTenantMutation(
    async (id: string) => {
      const data = await graphqlClient.request<{ deleteFinanceEntry: boolean }>(
        DELETE_FINANCE_ENTRY,
        { id },
      );
      return data.deleteFinanceEntry;
    },
    { invalidate: INVALIDATE_ENTRIES },
  );
}

export function useCreateFinanceCategory() {
  return useTenantMutation(
    async (input: CreateFinanceCategoryInput) => {
      const data = await graphqlClient.request<{ createFinanceCategory: FinanceCategory }>(
        CREATE_FINANCE_CATEGORY,
        { input },
      );
      return data.createFinanceCategory;
    },
    { invalidate: INVALIDATE_CATEGORIES },
  );
}

export function useUpdateFinanceCategory() {
  return useTenantMutation(
    async ({ id, input }: { id: string; input: UpdateFinanceCategoryInput }) => {
      const data = await graphqlClient.request<{ updateFinanceCategory: FinanceCategory }>(
        UPDATE_FINANCE_CATEGORY,
        { id, input },
      );
      return data.updateFinanceCategory;
    },
    { invalidate: INVALIDATE_CATEGORIES },
  );
}

export function useArchiveFinanceCategory() {
  return useTenantMutation(
    async (id: string) => {
      const data = await graphqlClient.request<{ archiveFinanceCategory: FinanceCategory }>(
        ARCHIVE_FINANCE_CATEGORY,
        { id },
      );
      return data.archiveFinanceCategory;
    },
    { invalidate: INVALIDATE_CATEGORIES },
  );
}

export function useRestoreFinanceCategory() {
  return useTenantMutation(
    async (id: string) => {
      const data = await graphqlClient.request<{ restoreFinanceCategory: FinanceCategory }>(
        RESTORE_FINANCE_CATEGORY,
        { id },
      );
      return data.restoreFinanceCategory;
    },
    { invalidate: INVALIDATE_CATEGORIES },
  );
}

export function useUpdateFinanceSettings() {
  return useTenantMutation(
    async (input: UpdateFinanceSettingsInput) => {
      const data = await graphqlClient.request<{ updateFinanceSettings: FinanceSettings }>(
        UPDATE_FINANCE_SETTINGS,
        { input },
      );
      return data.updateFinanceSettings;
    },
    { invalidate: INVALIDATE_SETTINGS },
  );
}
