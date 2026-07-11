/**
 * HR Finance GraphQL Operations
 *
 * Maps 1:1 to apps/hr-service/src/finance/resolvers/hr-finance.resolver.ts.
 */

const HR_FINANCE_CATEGORY_FIELDS = `
  id
  name
  code
  computedRule
  isSystem
  isActive
  displayOrder
  createdAt
  updatedAt
`;

const HR_FINANCE_ENTRY_FIELDS = `
  id
  categoryId
  entryDate
  amount
  currency
  description
  departmentHrId
  employeeId
  createdAt
  updatedAt
`;

const PAYROLL_COST_SETTINGS_FIELDS = `
  id
  pensionFundPct
  socialInsurancePct
  medicalInsurancePct
  otherCostPct
  defaultCurrency
  updatedAt
`;

// ============================================================================
// QUERIES
// ============================================================================

export const GET_HR_LABOUR_COST = `
  query GetHrLabourCost($year: Int) {
    hrLabourCost(year: $year) {
      currency
      rows {
        category
        headcount
        annualSalaryTotal
        avgAnnualSalary
      }
      totalHeadcount
      unclassifiedCount
      annualSalaryTotal
      pensionFund
      socialInsuranceFund
      medicalInsuranceFund
      otherCost
      totalPayroll
      actualGrossPayYtd
      hrExpensesYtd
    }
  }
`;

export const GET_HR_FINANCE_SUMMARY = `
  query GetHrFinanceSummary($from: DateTime!, $to: DateTime!, $granularity: HrFinanceGranularity) {
    hrFinanceSummary(from: $from, to: $to, granularity: $granularity) {
      currency
      series {
        bucketStart
        payrollGross
        hrExpenses
      }
      byDepartment {
        departmentHrId
        departmentName
        headcount
        annualSalaryTotal
        hrExpenses
      }
    }
  }
`;

export const GET_HR_FINANCE_CATEGORIES = `
  query GetHrFinanceCategories($includeArchived: Boolean) {
    hrFinanceCategories(includeArchived: $includeArchived) {
      ${HR_FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const GET_HR_FINANCE_ENTRIES = `
  query GetHrFinanceEntries(
    $from: DateTime
    $to: DateTime
    $categoryId: ID
    $departmentHrId: ID
    $limit: Int
    $offset: Int
  ) {
    hrFinanceEntries(
      from: $from
      to: $to
      categoryId: $categoryId
      departmentHrId: $departmentHrId
      limit: $limit
      offset: $offset
    ) {
      ${HR_FINANCE_ENTRY_FIELDS}
    }
  }
`;

export const GET_PAYROLL_COST_SETTINGS = `
  query GetPayrollCostSettings {
    payrollCostSettings {
      ${PAYROLL_COST_SETTINGS_FIELDS}
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

export const CREATE_HR_FINANCE_ENTRY = `
  mutation CreateHrFinanceEntry($input: CreateHrFinanceEntryInput!) {
    createHrFinanceEntry(input: $input) {
      ${HR_FINANCE_ENTRY_FIELDS}
    }
  }
`;

export const UPDATE_HR_FINANCE_ENTRY = `
  mutation UpdateHrFinanceEntry($id: ID!, $input: UpdateHrFinanceEntryInput!) {
    updateHrFinanceEntry(id: $id, input: $input) {
      ${HR_FINANCE_ENTRY_FIELDS}
    }
  }
`;

export const DELETE_HR_FINANCE_ENTRY = `
  mutation DeleteHrFinanceEntry($id: ID!) {
    deleteHrFinanceEntry(id: $id)
  }
`;

export const CREATE_HR_FINANCE_CATEGORY = `
  mutation CreateHrFinanceCategory($input: CreateHrFinanceCategoryInput!) {
    createHrFinanceCategory(input: $input) {
      ${HR_FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const UPDATE_HR_FINANCE_CATEGORY = `
  mutation UpdateHrFinanceCategory($id: ID!, $input: UpdateHrFinanceCategoryInput!) {
    updateHrFinanceCategory(id: $id, input: $input) {
      ${HR_FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const ARCHIVE_HR_FINANCE_CATEGORY = `
  mutation ArchiveHrFinanceCategory($id: ID!) {
    archiveHrFinanceCategory(id: $id) {
      ${HR_FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const UPDATE_PAYROLL_COST_SETTINGS = `
  mutation UpdatePayrollCostSettings($input: UpdatePayrollCostSettingsInput!) {
    updatePayrollCostSettings(input: $input) {
      ${PAYROLL_COST_SETTINGS_FIELDS}
    }
  }
`;
