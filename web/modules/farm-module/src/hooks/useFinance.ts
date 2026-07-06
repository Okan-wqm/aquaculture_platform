/**
 * Farm Finance hooks
 *
 * TanStack Query wrappers over the finance GraphQL surface. Every query
 * key is tenant-scoped via createTenantQueryKey (FE-CRITICAL-014 —
 * cross-tenant cache-leak guard).
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  useAuth,
  graphqlClient,
  createTenantQueryKey,
  createTenantInvalidationKey,
} from '@aquaculture/shared-ui';

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
  amount: number;
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
  amount: number;
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
  total: number;
}

export interface FinanceTimeBucket {
  bucketStart: string;
  totalExpense: number;
  totalRevenue: number;
}

export interface FinanceSummary {
  currency: string;
  totalExpense: number;
  totalRevenue: number;
  netResult: number;
  byCategory: FinanceCategoryTotal[];
  series: FinanceTimeBucket[];
}

export interface FinanceBatchTotal {
  batchId: string;
  totalExpense: number;
  totalRevenue: number;
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
  currency?: string;
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
  isActive?: boolean;
}

export interface UpdateFinanceSettingsInput {
  defaultCurrency?: string;
  fiscalYearStartMonth?: number;
}

// ============================================================================
// Query hooks
// ============================================================================

const useTenantId = (): string | null => {
  const { tenantId } = useAuth();
  return tenantId;
};

export function useFinanceCategories(scope?: FinanceCategoryScope, includeArchived = false) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'finance', 'categories', scope ?? 'all', includeArchived),
    queryFn: async () => {
      const data = await graphqlClient.request<{ financeCategories: FinanceCategory[] }>(
        GET_FINANCE_CATEGORIES,
        { scope, includeArchived },
      );
      return data.financeCategories;
    },
    enabled: Boolean(tenantId),
  });
}

export function useFinanceLedger(filter: FinanceLedgerFilter) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'finance', 'ledger', filter),
    queryFn: async () => {
      const data = await graphqlClient.request<{ financeLedger: FinanceLineItem[] }>(
        GET_FINANCE_LEDGER,
        { includeDerived: true, limit: 50, offset: 0, ...filter },
      );
      return data.financeLedger;
    },
    enabled: Boolean(tenantId),
  });
}

export function useFinanceSummary(from: string, to: string, granularity: FinanceGranularity) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'finance', 'summary', from, to, granularity),
    queryFn: async () => {
      const data = await graphqlClient.request<{ financeSummary: FinanceSummary }>(
        GET_FINANCE_SUMMARY,
        { from, to, granularity },
      );
      return data.financeSummary;
    },
    enabled: Boolean(tenantId && from && to),
  });
}

export function useFinanceBatchTotals(from: string, to: string) {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'finance', 'batchTotals', from, to),
    queryFn: async () => {
      const data = await graphqlClient.request<{ financeBatchTotals: FinanceBatchTotal[] }>(
        GET_FINANCE_BATCH_TOTALS,
        { from, to },
      );
      return data.financeBatchTotals;
    },
    enabled: Boolean(tenantId && from && to),
  });
}

export function useFinanceSettings() {
  const tenantId = useTenantId();
  return useQuery({
    queryKey: createTenantQueryKey(tenantId, 'finance', 'settings'),
    queryFn: async () => {
      const data = await graphqlClient.request<{ financeSettings: FinanceSettings }>(
        GET_FINANCE_SETTINGS,
      );
      return data.financeSettings;
    },
    enabled: Boolean(tenantId),
  });
}

// ============================================================================
// Mutation hooks — each invalidates the tenant-scoped finance key prefix
// ============================================================================

function useInvalidateFinance() {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: createTenantInvalidationKey(tenantId, 'finance'),
    });
}

export function useCreateFinanceEntry() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async (input: CreateFinanceEntryInput) => {
      const data = await graphqlClient.request<{ createFinanceEntry: FinanceEntry }>(
        CREATE_FINANCE_ENTRY,
        { input },
      );
      return data.createFinanceEntry;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateFinanceEntry() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateFinanceEntryInput }) => {
      const data = await graphqlClient.request<{ updateFinanceEntry: FinanceEntry }>(
        UPDATE_FINANCE_ENTRY,
        { id, input },
      );
      return data.updateFinanceEntry;
    },
    onSuccess: () => invalidate(),
  });
}

export function useDeleteFinanceEntry() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlClient.request<{ deleteFinanceEntry: boolean }>(
        DELETE_FINANCE_ENTRY,
        { id },
      );
      return data.deleteFinanceEntry;
    },
    onSuccess: () => invalidate(),
  });
}

export function useCreateFinanceCategory() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async (input: CreateFinanceCategoryInput) => {
      const data = await graphqlClient.request<{ createFinanceCategory: FinanceCategory }>(
        CREATE_FINANCE_CATEGORY,
        { input },
      );
      return data.createFinanceCategory;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateFinanceCategory() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateFinanceCategoryInput }) => {
      const data = await graphqlClient.request<{ updateFinanceCategory: FinanceCategory }>(
        UPDATE_FINANCE_CATEGORY,
        { id, input },
      );
      return data.updateFinanceCategory;
    },
    onSuccess: () => invalidate(),
  });
}

export function useArchiveFinanceCategory() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async (id: string) => {
      const data = await graphqlClient.request<{ archiveFinanceCategory: FinanceCategory }>(
        ARCHIVE_FINANCE_CATEGORY,
        { id },
      );
      return data.archiveFinanceCategory;
    },
    onSuccess: () => invalidate(),
  });
}

export function useUpdateFinanceSettings() {
  const invalidate = useInvalidateFinance();
  return useMutation({
    mutationFn: async (input: UpdateFinanceSettingsInput) => {
      const data = await graphqlClient.request<{ updateFinanceSettings: FinanceSettings }>(
        UPDATE_FINANCE_SETTINGS,
        { input },
      );
      return data.updateFinanceSettings;
    },
    onSuccess: () => invalidate(),
  });
}
