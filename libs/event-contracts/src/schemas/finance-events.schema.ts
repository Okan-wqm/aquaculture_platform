import type { JSONSchemaType } from 'ajv';
import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  UUID_SCHEMA,
  OPTIONAL_UUID_SCHEMA,
  MAX_SHORT_CODE_LENGTH,
} from './common.schema';

/**
 * @module FinanceEventSchemas
 *
 * JSON Schema definitions for the finance domain events crossing the
 * NATS trust boundary. Today's consumer is hr-service
 * (`FinanceSettingsUpdated` → payroll-cost-settings currency projection);
 * the planned standalone finance-service consumes the full set when it
 * lands. Consumers MUST validate before acting — same fail-closed
 * posture as the farm NATS bridge (H-3).
 *
 * # Monetary encoding
 *
 * `amount` fields are string-encoded decimals per HR-MEDIUM-001
 * (`^\d{1,13}(\.\d{1,2})?$` — non-negative, 2 decimal places, matching
 * the `decimal(15,2)` columns they mirror). A `number` on the wire is
 * rejected, which makes IEEE 754 money arithmetic structurally
 * impossible through this contract.
 *
 * # Strict mode
 *
 * Every schema has `additionalProperties: false` — an undeclared field
 * on the wire causes the event to be dropped by the consumer.
 */

const EVENT_OBJECT_OPTS = {
  type: 'object' as const,
  additionalProperties: false as const,
};

/**
 * Non-negative string-encoded decimal with up to 2 fraction digits.
 * Mirrors the `decimal(15,2) CHECK (amount >= 0)` ledger columns.
 */
const MONEY_DECIMAL_STRING = {
  type: 'string',
  pattern: '^\\d{1,13}(\\.\\d{1,2})?$',
} as const;

/** ISO 4217 alpha-3 currency code (uppercase). */
const CURRENCY_CODE = {
  type: 'string',
  pattern: '^[A-Z]{3}$',
} as const;

/** ISO 8601 date or date-time string for booking dates. */
const ISO_DATE_OR_DATETIME = {
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}(T.*)?$',
} as const;

const FINANCE_SCOPE = {
  type: 'string',
  enum: ['FARM_OPEX', 'FARM_REVENUE', 'HR_EXPENSE'],
} as const;

const FINANCE_SOURCE_SERVICE = {
  type: 'string',
  enum: ['farm-service', 'hr-service'],
} as const;

const CATEGORY_NAME = {
  type: 'string',
  minLength: 1,
  maxLength: 120,
} as const;

const CATEGORY_CODE = {
  type: 'string',
  minLength: 1,
  maxLength: MAX_SHORT_CODE_LENGTH,
  nullable: true,
} as const;

// ============================================================================
// Wire-format interfaces (ISO strings on the wire, mirroring finance-events.ts)
// ============================================================================

interface WireFinanceDimensions {
  siteId?: string;
  batchId?: string;
  departmentHrId?: string;
}

interface WireBaseEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  tenantId: string;
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
}

interface WireFinanceEntryRecorded extends WireBaseEvent {
  eventType: 'FinanceEntryRecorded';
  entryId: string;
  categoryId: string;
  categoryCode?: string;
  scope: 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';
  amount: string;
  currency: string;
  entryDate: string;
  dimensions?: WireFinanceDimensions;
  sourceService: 'farm-service' | 'hr-service';
}

interface WireFinanceEntryUpdated extends WireBaseEvent {
  eventType: 'FinanceEntryUpdated';
  entryId: string;
  categoryId: string;
  categoryCode?: string;
  scope: 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';
  amount: string;
  currency: string;
  entryDate: string;
  dimensions?: WireFinanceDimensions;
  sourceService: 'farm-service' | 'hr-service';
}

interface WireFinanceEntryDeleted extends WireBaseEvent {
  eventType: 'FinanceEntryDeleted';
  entryId: string;
  categoryId: string;
  scope: 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';
  sourceService: 'farm-service' | 'hr-service';
}

interface WireFinanceCategoryCreated extends WireBaseEvent {
  eventType: 'FinanceCategoryCreated';
  categoryId: string;
  code?: string;
  name: string;
  scope: 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';
  kind: 'EXPENSE' | 'REVENUE';
  isSystem: boolean;
  sourceService: 'farm-service' | 'hr-service';
}

interface WireFinanceCategoryUpdated extends WireBaseEvent {
  eventType: 'FinanceCategoryUpdated';
  categoryId: string;
  code?: string;
  name: string;
  scope: 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';
  sourceService: 'farm-service' | 'hr-service';
}

interface WireFinanceCategoryArchived extends WireBaseEvent {
  eventType: 'FinanceCategoryArchived';
  categoryId: string;
  code?: string;
  scope: 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';
  sourceService: 'farm-service' | 'hr-service';
}

interface WireFinanceSettingsUpdated extends WireBaseEvent {
  eventType: 'FinanceSettingsUpdated';
  defaultCurrency: string;
  fiscalYearStartMonth: number;
  sourceService: 'farm-service' | 'hr-service';
}

// ============================================================================
// Schemas
// ============================================================================

const DIMENSIONS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  nullable: true,
  properties: {
    siteId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    batchId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
    departmentHrId: { ...OPTIONAL_UUID_SCHEMA, nullable: true },
  },
  required: [],
} as const;

export const financeEntryRecordedSchema: JSONSchemaType<WireFinanceEntryRecorded> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceEntryRecorded' },
      entryId: UUID_SCHEMA,
      categoryId: UUID_SCHEMA,
      categoryCode: CATEGORY_CODE,
      scope: FINANCE_SCOPE,
      amount: MONEY_DECIMAL_STRING,
      currency: CURRENCY_CODE,
      entryDate: ISO_DATE_OR_DATETIME,
      dimensions: DIMENSIONS_SCHEMA,
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'entryId',
      'categoryId',
      'scope',
      'amount',
      'currency',
      'entryDate',
      'sourceService',
    ],
  };

export const financeEntryUpdatedSchema: JSONSchemaType<WireFinanceEntryUpdated> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceEntryUpdated' },
      entryId: UUID_SCHEMA,
      categoryId: UUID_SCHEMA,
      categoryCode: CATEGORY_CODE,
      scope: FINANCE_SCOPE,
      amount: MONEY_DECIMAL_STRING,
      currency: CURRENCY_CODE,
      entryDate: ISO_DATE_OR_DATETIME,
      dimensions: DIMENSIONS_SCHEMA,
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'entryId',
      'categoryId',
      'scope',
      'amount',
      'currency',
      'entryDate',
      'sourceService',
    ],
  };

export const financeEntryDeletedSchema: JSONSchemaType<WireFinanceEntryDeleted> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceEntryDeleted' },
      entryId: UUID_SCHEMA,
      categoryId: UUID_SCHEMA,
      scope: FINANCE_SCOPE,
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'entryId',
      'categoryId',
      'scope',
      'sourceService',
    ],
  };

export const financeCategoryCreatedSchema: JSONSchemaType<WireFinanceCategoryCreated> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceCategoryCreated' },
      categoryId: UUID_SCHEMA,
      code: CATEGORY_CODE,
      name: CATEGORY_NAME,
      scope: FINANCE_SCOPE,
      kind: { type: 'string', enum: ['EXPENSE', 'REVENUE'] },
      isSystem: { type: 'boolean' },
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'categoryId',
      'name',
      'scope',
      'kind',
      'isSystem',
      'sourceService',
    ],
  };

export const financeCategoryUpdatedSchema: JSONSchemaType<WireFinanceCategoryUpdated> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceCategoryUpdated' },
      categoryId: UUID_SCHEMA,
      code: CATEGORY_CODE,
      name: CATEGORY_NAME,
      scope: FINANCE_SCOPE,
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'categoryId',
      'name',
      'scope',
      'sourceService',
    ],
  };

export const financeCategoryArchivedSchema: JSONSchemaType<WireFinanceCategoryArchived> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceCategoryArchived' },
      categoryId: UUID_SCHEMA,
      code: CATEGORY_CODE,
      scope: FINANCE_SCOPE,
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [...BASE_EVENT_REQUIRED, 'categoryId', 'scope', 'sourceService'],
  };

export const financeSettingsUpdatedSchema: JSONSchemaType<WireFinanceSettingsUpdated> =
  {
    ...EVENT_OBJECT_OPTS,
    properties: {
      ...BASE_EVENT_PROPERTIES,
      eventType: { type: 'string', const: 'FinanceSettingsUpdated' },
      defaultCurrency: CURRENCY_CODE,
      fiscalYearStartMonth: { type: 'integer', minimum: 1, maximum: 12 },
      sourceService: FINANCE_SOURCE_SERVICE,
    },
    required: [
      ...BASE_EVENT_REQUIRED,
      'defaultCurrency',
      'fiscalYearStartMonth',
      'sourceService',
    ],
  };

/**
 * Event types covered by the finance schema catalogue.
 */
export type FinanceEventType =
  | 'FinanceEntryRecorded'
  | 'FinanceEntryUpdated'
  | 'FinanceEntryDeleted'
  | 'FinanceCategoryCreated'
  | 'FinanceCategoryUpdated'
  | 'FinanceCategoryArchived'
  | 'FinanceSettingsUpdated';

/**
 * Schema catalogue keyed by event type. Values are typed as plain
 * `object` to avoid TS7056 deep-inference blowups (same posture as
 * FARM_EVENT_SCHEMAS); each value was built via `JSONSchemaType<T>`
 * at its definition site.
 */
export const FINANCE_EVENT_SCHEMAS: Record<FinanceEventType, object> = {
  FinanceEntryRecorded: financeEntryRecordedSchema,
  FinanceEntryUpdated: financeEntryUpdatedSchema,
  FinanceEntryDeleted: financeEntryDeletedSchema,
  FinanceCategoryCreated: financeCategoryCreatedSchema,
  FinanceCategoryUpdated: financeCategoryUpdatedSchema,
  FinanceCategoryArchived: financeCategoryArchivedSchema,
  FinanceSettingsUpdated: financeSettingsUpdatedSchema,
};
