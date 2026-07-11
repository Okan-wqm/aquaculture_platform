/**
 * Farm Finance GraphQL Operations
 *
 * Maps 1:1 to apps/farm-service/src/finance/resolvers/finance.resolver.ts
 * (root field names are CI-checked by farm-graphql-fe-be-parity.spec.ts).
 */

// ============================================================================
// FRAGMENT FIELDS
// ============================================================================

const FINANCE_CATEGORY_FIELDS = `
  id
  name
  code
  scope
  kind
  computedRule
  isSystem
  isActive
  displayOrder
  createdAt
  updatedAt
`;

const FINANCE_ENTRY_FIELDS = `
  id
  categoryId
  entryDate
  periodStart
  periodEnd
  amount
  currency
  description
  siteId
  batchId
  createdAt
  updatedAt
`;

const FINANCE_LINE_ITEM_FIELDS = `
  id
  origin
  categoryId
  categoryCode
  categoryName
  kind
  amount
  currency
  entryDate
  batchId
  siteId
  description
  estimated
  editable
  sourceDomain
  sourceRecordId
`;

const FINANCE_SETTINGS_FIELDS = `
  id
  defaultCurrency
  fiscalYearStartMonth
  updatedAt
`;

// ============================================================================
// QUERIES
// ============================================================================

export const GET_FINANCE_CATEGORIES = `
  query GetFinanceCategories($scope: FinanceCategoryScope, $includeArchived: Boolean) {
    financeCategories(scope: $scope, includeArchived: $includeArchived) {
      ${FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const GET_FINANCE_LEDGER = `
  query GetFinanceLedger(
    $from: DateTime
    $to: DateTime
    $scope: FinanceCategoryScope
    $categoryId: ID
    $batchId: ID
    $siteId: ID
    $includeDerived: Boolean
    $limit: Int
    $offset: Int
  ) {
    financeLedger(
      from: $from
      to: $to
      scope: $scope
      categoryId: $categoryId
      batchId: $batchId
      siteId: $siteId
      includeDerived: $includeDerived
      limit: $limit
      offset: $offset
    ) {
      ${FINANCE_LINE_ITEM_FIELDS}
    }
  }
`;

export const GET_FINANCE_SUMMARY = `
  query GetFinanceSummary($from: DateTime!, $to: DateTime!, $granularity: FinanceGranularity) {
    financeSummary(from: $from, to: $to, granularity: $granularity) {
      currency
      totalExpense
      totalRevenue
      netResult
      byCategory {
        categoryId
        categoryCode
        categoryName
        scope
        kind
        isComputed
        isDerived
        total
      }
      series {
        bucketStart
        totalExpense
        totalRevenue
      }
    }
  }
`;

export const GET_FINANCE_BATCH_TOTALS = `
  query GetFinanceBatchTotals($from: DateTime!, $to: DateTime!) {
    financeBatchTotals(from: $from, to: $to) {
      batchId
      totalExpense
      totalRevenue
    }
  }
`;

export const GET_FINANCE_SETTINGS = `
  query GetFinanceSettings {
    financeSettings {
      ${FINANCE_SETTINGS_FIELDS}
    }
  }
`;

// ============================================================================
// MUTATIONS
// ============================================================================

export const CREATE_FINANCE_ENTRY = `
  mutation CreateFinanceEntry($input: CreateFinanceEntryInput!) {
    createFinanceEntry(input: $input) {
      ${FINANCE_ENTRY_FIELDS}
    }
  }
`;

export const UPDATE_FINANCE_ENTRY = `
  mutation UpdateFinanceEntry($id: ID!, $input: UpdateFinanceEntryInput!) {
    updateFinanceEntry(id: $id, input: $input) {
      ${FINANCE_ENTRY_FIELDS}
    }
  }
`;

export const DELETE_FINANCE_ENTRY = `
  mutation DeleteFinanceEntry($id: ID!) {
    deleteFinanceEntry(id: $id)
  }
`;

export const CREATE_FINANCE_CATEGORY = `
  mutation CreateFinanceCategory($input: CreateFinanceCategoryInput!) {
    createFinanceCategory(input: $input) {
      ${FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const UPDATE_FINANCE_CATEGORY = `
  mutation UpdateFinanceCategory($id: ID!, $input: UpdateFinanceCategoryInput!) {
    updateFinanceCategory(id: $id, input: $input) {
      ${FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const ARCHIVE_FINANCE_CATEGORY = `
  mutation ArchiveFinanceCategory($id: ID!) {
    archiveFinanceCategory(id: $id) {
      ${FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const RESTORE_FINANCE_CATEGORY = `
  mutation RestoreFinanceCategory($id: ID!) {
    restoreFinanceCategory(id: $id) {
      ${FINANCE_CATEGORY_FIELDS}
    }
  }
`;

export const UPDATE_FINANCE_SETTINGS = `
  mutation UpdateFinanceSettings($input: UpdateFinanceSettingsInput!) {
    updateFinanceSettings(input: $input) {
      ${FINANCE_SETTINGS_FIELDS}
    }
  }
`;
