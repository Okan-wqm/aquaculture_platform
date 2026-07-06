import { BaseEvent } from './base-event';

/**
 * Finance domain events — tenant-internal operational finance
 * (farm OPEX / revenue ledger + HR labour-cost ledger).
 *
 * NOT platform SaaS billing: subscription/invoice/Stripe events live in
 * `billing-events.ts`. These events describe a tenant's OWN expense and
 * revenue bookkeeping recorded through the farm and hr finance modules.
 *
 * # Producers & the future finance-service
 *
 * farm-service publishes finance events for `FARM_OPEX` / `FARM_REVENUE`
 * scoped records; hr-service publishes for `HR_EXPENSE` scoped records.
 * Both publish through their transactional outboxes. The planned
 * standalone finance-service builds its cross-domain read models by
 * projecting THIS event stream (plus the money-bearing domain events:
 * `FeedingRecorded.feedCost`, `BatchHarvested`, `PayrollProcessed`) —
 * the write paths never need to change when that service lands.
 *
 * # Monetary encoding (HR-MEDIUM-001)
 *
 * All monetary values are string-encoded decimals (e.g. "1234.56"),
 * NEVER JavaScript `number`. IEEE 754 float arithmetic is structurally
 * impossible through this contract. Consumers parse with Decimal.js or
 * the `Money` value object from `@aquaculture/backend-common/monetary`.
 */

/**
 * Ledger scope a finance category / entry belongs to.
 *
 *  - `FARM_OPEX`    — farm operational expenses (electricity, feed,
 *                     oxygen, fingerlings, insurance, …). Producer: farm-service.
 *  - `FARM_REVENUE` — farm revenue (harvest sales). Producer: farm-service.
 *  - `HR_EXPENSE`   — HR / workforce expenses beyond payroll (training,
 *                     recruitment, PPE, …). Producer: hr-service.
 */
export type FinanceScope = 'FARM_OPEX' | 'FARM_REVENUE' | 'HR_EXPENSE';

/** Service that owns the ledger record the event describes. */
export type FinanceSourceService = 'farm-service' | 'hr-service';

/**
 * Optional analytic dimensions carried by finance entries so downstream
 * projections can aggregate per batch / site / department without a
 * lookup into the producing service.
 */
export interface FinanceDimensions {
  siteId?: string;
  batchId?: string;
  departmentHrId?: string;
}

/**
 * A manual finance entry was recorded through a finance tab.
 *
 * Derived costs (feed cost from feeding records, fingerling cost from
 * batches, maintenance from work orders, …) intentionally do NOT emit
 * finance events — they are query-time projections of their source
 * records, and their source domains already emit the authoritative
 * domain events (e.g. `FeedingRecorded`). Emitting a second event for
 * the same fact would create a dual-ledger consistency problem.
 */
export interface FinanceEntryRecordedEvent extends BaseEvent {
  eventType: 'FinanceEntryRecorded';
  entryId: string;
  categoryId: string;
  /** Stable system code of the category, if it is a system category. */
  categoryCode?: string;
  scope: FinanceScope;
  /** String-encoded decimal. NEVER use JavaScript number for monetary values. */
  amount: string;
  /** ISO 4217 currency code */
  currency: string;
  /** ISO 8601 date (day precision) the expense/revenue is booked on. */
  entryDate: string;
  dimensions?: FinanceDimensions;
  sourceService: FinanceSourceService;
}

/**
 * A manual finance entry was updated (amount, date, category or
 * dimensions changed).
 */
export interface FinanceEntryUpdatedEvent extends BaseEvent {
  eventType: 'FinanceEntryUpdated';
  entryId: string;
  categoryId: string;
  categoryCode?: string;
  scope: FinanceScope;
  /** String-encoded decimal. NEVER use JavaScript number for monetary values. */
  amount: string;
  /** ISO 4217 currency code */
  currency: string;
  entryDate: string;
  dimensions?: FinanceDimensions;
  sourceService: FinanceSourceService;
}

/**
 * A manual finance entry was deleted (soft delete in the producing
 * service; projections must remove it from aggregates).
 */
export interface FinanceEntryDeletedEvent extends BaseEvent {
  eventType: 'FinanceEntryDeleted';
  entryId: string;
  categoryId: string;
  scope: FinanceScope;
  sourceService: FinanceSourceService;
}

/**
 * A finance category was created — either a seeded system category
 * (isSystem=true, carries a stable `code`) or a user-defined category.
 */
export interface FinanceCategoryCreatedEvent extends BaseEvent {
  eventType: 'FinanceCategoryCreated';
  categoryId: string;
  /** Stable machine code — present only on system categories. */
  code?: string;
  name: string;
  scope: FinanceScope;
  kind: 'EXPENSE' | 'REVENUE';
  isSystem: boolean;
  sourceService: FinanceSourceService;
}

/**
 * A finance category was updated (rename / display order).
 * The `code` of a system category is immutable; only display fields change.
 */
export interface FinanceCategoryUpdatedEvent extends BaseEvent {
  eventType: 'FinanceCategoryUpdated';
  categoryId: string;
  code?: string;
  name: string;
  scope: FinanceScope;
  sourceService: FinanceSourceService;
}

/**
 * A finance category was archived (soft-deactivated). Entries referencing
 * it remain valid history; new entries can no longer use it.
 */
export interface FinanceCategoryArchivedEvent extends BaseEvent {
  eventType: 'FinanceCategoryArchived';
  categoryId: string;
  code?: string;
  scope: FinanceScope;
  sourceService: FinanceSourceService;
}

/**
 * Tenant finance settings changed (default currency / fiscal year start).
 *
 * CROSS-SERVICE CONTRACT: farm-service owns the tenant's finance settings
 * (the per-tenant currency SSoT that cures the historical TRY/NOK/USD
 * hardcode drift). hr-service consumes this event to keep
 * `hr_payroll_cost_settings.defaultCurrency` aligned so the HR finance
 * tab reports in the same currency without a second tenant-editable
 * source of truth.
 */
export interface FinanceSettingsUpdatedEvent extends BaseEvent {
  eventType: 'FinanceSettingsUpdated';
  /** ISO 4217 currency code — the tenant-wide default currency. */
  defaultCurrency: string;
  /** 1-12; month the tenant's fiscal year starts in. */
  fiscalYearStartMonth: number;
  sourceService: FinanceSourceService;
}

/**
 * Union type for all finance events.
 */
export type FinanceEvent =
  | FinanceEntryRecordedEvent
  | FinanceEntryUpdatedEvent
  | FinanceEntryDeletedEvent
  | FinanceCategoryCreatedEvent
  | FinanceCategoryUpdatedEvent
  | FinanceCategoryArchivedEvent
  | FinanceSettingsUpdatedEvent;
