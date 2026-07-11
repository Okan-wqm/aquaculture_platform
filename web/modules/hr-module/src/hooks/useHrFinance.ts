/**
 * HR Finance hooks — TanStack Query via the shared useTenantQuery /
 * useTenantMutation SSoT (tenant prefix + auth gating handled for us).
 */
import { graphqlClient, useTenantMutation, useTenantQuery } from '@aquaculture/shared-ui';

import {
  ARCHIVE_HR_FINANCE_CATEGORY,
  CREATE_HR_FINANCE_CATEGORY,
  CREATE_HR_FINANCE_ENTRY,
  DELETE_HR_FINANCE_ENTRY,
  GET_HR_FINANCE_CATEGORIES,
  GET_HR_FINANCE_ENTRIES,
  GET_HR_FINANCE_SUMMARY,
  GET_HR_LABOUR_COST,
  GET_PAYROLL_COST_SETTINGS,
  UPDATE_HR_FINANCE_CATEGORY,
  UPDATE_HR_FINANCE_ENTRY,
  UPDATE_PAYROLL_COST_SETTINGS,
} from '../graphql/finance.operations';

// ============================================================================
// Types
// ============================================================================

export type LaborCategory = 'manager' | 'technical' | 'unskilled';
export type HrFinanceGranularity = 'DAY' | 'WEEK' | 'MONTH' | 'YEAR';

export interface HrLabourCostRow {
  category: LaborCategory | null;
  headcount: number;
  /** null when withheld for small-cell privacy (salarySuppressed = true). */
  annualSalaryTotal: number | null;
  /** null when withheld for small-cell privacy (salarySuppressed = true). */
  avgAnnualSalary: number | null;
  salarySuppressed: boolean;
}

export interface HrLabourCost {
  currency: string;
  rows: HrLabourCostRow[];
  totalHeadcount: number;
  unclassifiedCount: number;
  annualSalaryTotal: number;
  pensionFund: number;
  socialInsuranceFund: number;
  medicalInsuranceFund: number;
  otherCost: number;
  totalPayroll: number;
  actualGrossPayYtd: number;
  hrExpensesYtd: number;
}

export interface HrFinanceTimeBucket {
  bucketStart: string;
  payrollGross: number;
  hrExpenses: number;
}

export interface HrDepartmentCost {
  departmentHrId?: string | null;
  departmentName: string;
  headcount: number;
  /** null when withheld for small-cell privacy (salarySuppressed = true). */
  annualSalaryTotal: number | null;
  salarySuppressed: boolean;
  hrExpenses: number;
}

export interface HrFinanceSummary {
  currency: string;
  series: HrFinanceTimeBucket[];
  byDepartment: HrDepartmentCost[];
}

export interface HrFinanceCategory {
  id: string;
  name: string;
  code?: string | null;
  computedRule?: { type: string; percent: number } | null;
  isSystem: boolean;
  isActive: boolean;
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface HrFinanceEntry {
  id: string;
  categoryId: string;
  entryDate: string;
  amount: number;
  currency: string;
  description?: string | null;
  departmentHrId?: string | null;
  employeeId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PayrollCostSettings {
  id: string;
  pensionFundPct: number;
  socialInsurancePct: number;
  medicalInsurancePct: number;
  otherCostPct: number;
  defaultCurrency: string;
  updatedAt: string;
}

export interface CreateHrFinanceEntryInput {
  categoryId: string;
  entryDate: string;
  amount: number;
  description?: string;
  departmentHrId?: string;
  employeeId?: string;
}

export type UpdateHrFinanceEntryInput = Partial<CreateHrFinanceEntryInput>;

export interface CreateHrFinanceCategoryInput {
  name: string;
  displayOrder?: number;
}

export interface UpdateHrFinanceCategoryInput {
  name?: string;
  displayOrder?: number;
}

export interface UpdatePayrollCostSettingsInput {
  pensionFundPct?: number;
  socialInsurancePct?: number;
  medicalInsurancePct?: number;
  otherCostPct?: number;
}

// ============================================================================
// Query hooks
// ============================================================================

export function useHrLabourCost(year: number) {
  return useTenantQuery(['hrFinance', 'labourCost', year], async () => {
    const data = await graphqlClient.request<{ hrLabourCost: HrLabourCost }>(GET_HR_LABOUR_COST, {
      year,
    });
    return data.hrLabourCost;
  });
}

export function useHrFinanceSummary(from: string, to: string, granularity: HrFinanceGranularity) {
  return useTenantQuery(
    ['hrFinance', 'summary', from, to, granularity],
    async () => {
      const data = await graphqlClient.request<{ hrFinanceSummary: HrFinanceSummary }>(
        GET_HR_FINANCE_SUMMARY,
        { from, to, granularity },
      );
      return data.hrFinanceSummary;
    },
    { enabled: Boolean(from && to) },
  );
}

export function useHrFinanceCategories(includeArchived = false) {
  return useTenantQuery(['hrFinance', 'categories', includeArchived], async () => {
    const data = await graphqlClient.request<{ hrFinanceCategories: HrFinanceCategory[] }>(
      GET_HR_FINANCE_CATEGORIES,
      { includeArchived },
    );
    return data.hrFinanceCategories;
  });
}

export function useHrFinanceEntries(filter: {
  from?: string;
  to?: string;
  categoryId?: string;
  departmentHrId?: string;
  limit?: number;
  offset?: number;
}) {
  return useTenantQuery(['hrFinance', 'entries', filter], async () => {
    const data = await graphqlClient.request<{ hrFinanceEntries: HrFinanceEntry[] }>(
      GET_HR_FINANCE_ENTRIES,
      { limit: 50, offset: 0, ...filter },
    );
    return data.hrFinanceEntries;
  });
}

export function usePayrollCostSettings() {
  return useTenantQuery(['hrFinance', 'settings'], async () => {
    const data = await graphqlClient.request<{ payrollCostSettings: PayrollCostSettings }>(
      GET_PAYROLL_COST_SETTINGS,
    );
    return data.payrollCostSettings;
  });
}

// ============================================================================
// Mutation hooks — invalidate the tenant-scoped hrFinance prefix on success.
// ============================================================================

const INVALIDATE_HR_FINANCE: ReadonlyArray<readonly unknown[]> = [['hrFinance']];

export function useCreateHrFinanceEntry() {
  return useTenantMutation(
    async (input: CreateHrFinanceEntryInput) => {
      const data = await graphqlClient.request<{ createHrFinanceEntry: HrFinanceEntry }>(
        CREATE_HR_FINANCE_ENTRY,
        { input },
      );
      return data.createHrFinanceEntry;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}

export function useUpdateHrFinanceEntry() {
  return useTenantMutation(
    async ({ id, input }: { id: string; input: UpdateHrFinanceEntryInput }) => {
      const data = await graphqlClient.request<{ updateHrFinanceEntry: HrFinanceEntry }>(
        UPDATE_HR_FINANCE_ENTRY,
        { id, input },
      );
      return data.updateHrFinanceEntry;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}

export function useDeleteHrFinanceEntry() {
  return useTenantMutation(
    async (id: string) => {
      const data = await graphqlClient.request<{ deleteHrFinanceEntry: boolean }>(
        DELETE_HR_FINANCE_ENTRY,
        { id },
      );
      return data.deleteHrFinanceEntry;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}

export function useCreateHrFinanceCategory() {
  return useTenantMutation(
    async (input: CreateHrFinanceCategoryInput) => {
      const data = await graphqlClient.request<{ createHrFinanceCategory: HrFinanceCategory }>(
        CREATE_HR_FINANCE_CATEGORY,
        { input },
      );
      return data.createHrFinanceCategory;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}

export function useUpdateHrFinanceCategory() {
  return useTenantMutation(
    async ({ id, input }: { id: string; input: UpdateHrFinanceCategoryInput }) => {
      const data = await graphqlClient.request<{ updateHrFinanceCategory: HrFinanceCategory }>(
        UPDATE_HR_FINANCE_CATEGORY,
        { id, input },
      );
      return data.updateHrFinanceCategory;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}

export function useArchiveHrFinanceCategory() {
  return useTenantMutation(
    async (id: string) => {
      const data = await graphqlClient.request<{ archiveHrFinanceCategory: HrFinanceCategory }>(
        ARCHIVE_HR_FINANCE_CATEGORY,
        { id },
      );
      return data.archiveHrFinanceCategory;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}

export function useUpdatePayrollCostSettings() {
  return useTenantMutation(
    async (input: UpdatePayrollCostSettingsInput) => {
      const data = await graphqlClient.request<{ updatePayrollCostSettings: PayrollCostSettings }>(
        UPDATE_PAYROLL_COST_SETTINGS,
        { input },
      );
      return data.updatePayrollCostSettings;
    },
    { invalidate: INVALIDATE_HR_FINANCE },
  );
}
