/**
 * The wire shape of a custom plan — one shape, whether the row was read or
 * just written (ADR-0013 / BILLING-CRITICAL-002, ADR-0015).
 *
 * Returning the TypeORM entity would publish a lie: every amount is a
 * `Decimal` that serialises to a string via `toJSON`, so the generated
 * contract would describe objects where the client receives text. These
 * classes state the JSON, and — being classes in a `.dto.ts` file — the
 * `@nestjs/swagger` plugin can type the responses from them.
 */
import type {
  BillingCustomPlanSnapshot,
  BillingCustomPlanStatus,
  BillingCycle,
  BillingPlanTier,
  BillingPricingMetricType,
} from '@platform/event-contracts';

export class CustomPlanQuantitiesDto {
  users?: number;
  farms?: number;
  ponds?: number;
  sensors?: number;
  employees?: number;
  devices?: number;
  storageGb?: number;
  apiCalls?: number;
  alerts?: number;
  reports?: number;
  integrations?: number;
}

export class CustomPlanLineItemResponseDto {
  metric!: BillingPricingMetricType;
  metricLabel!: string;
  quantity!: number;
  /** Exact decimal strings. */
  unitPrice!: string;
  total!: string;
}

export class CustomPlanModuleResponseDto {
  moduleId!: string;
  moduleCode!: string;
  moduleName!: string;
  quantities!: CustomPlanQuantitiesDto;
  lineItems!: CustomPlanLineItemResponseDto[];
  /** Exact decimal string. */
  subtotal!: string;
}

export class CustomPlanResponseDto {
  id!: string;
  tenantId!: string;
  name!: string;
  description?: string;
  basePlanId?: string;
  tier!: BillingPlanTier;
  billingCycle!: BillingCycle;
  modules!: CustomPlanModuleResponseDto[];
  /** Exact decimal strings. */
  monthlySubtotal!: string;
  discountPercent!: string;
  discountAmount!: string;
  discountReason?: string;
  monthlyTotal!: string;
  currency!: string;
  status!: BillingCustomPlanStatus;
  /** ISO-8601 dates. */
  validFrom!: string;
  validTo?: string;
  approvedBy?: string;
  approvedAt?: string;
  rejectionReason?: string;
  notes?: string;
  subscriptionId?: string;
  /** Module codes the plan selected that carry no active price sheet. */
  unpricedModuleCodes!: string[];
  createdAt!: string;
  updatedAt!: string;
  createdBy?: string;
  updatedBy?: string;
}

export class CustomPlanPageDto {
  data!: CustomPlanResponseDto[];
  total!: number;
  page!: number;
  limit!: number;
  totalPages!: number;
}

export class CustomPlanLookupDto {
  found!: boolean;
  customPlan?: CustomPlanResponseDto;
}

/** A delete has no body to return; `success` is the whole answer. */
export class DeletedCustomPlanDto {
  success!: boolean;
}

/**
 * Compile-time proof that every field this response publishes exists on
 * billing's snapshot; a rename or a drop in billing fails the build here
 * rather than surfacing as an `undefined` on the CustomPlans page.
 */
type MissingName<TResponse, TSnapshot> = Exclude<keyof TResponse, keyof TSnapshot>;
export const CUSTOM_PLAN_RESPONSE_COVERED: MissingName<
  CustomPlanResponseDto,
  BillingCustomPlanSnapshot
> extends never
  ? true
  : MissingName<CustomPlanResponseDto, BillingCustomPlanSnapshot> = true;
