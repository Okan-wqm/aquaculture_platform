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
import { ApiProperty } from '@nestjs/swagger';
import type {
  BillingCustomPlanSnapshot,
  BillingCustomPlanStatus,
  BillingCycle,
  BillingPlanTier,
  BillingPricingMetricType,
} from '@platform/event-contracts';
import type { PaginationResultV1 } from '@platform/pagination-contracts';

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

/**
 * The page contract as the swagger plugin can see it (ADMIN-HIGH-004).
 *
 * `@platform/pagination-contracts` owns the shape and is the only place that
 * CONSTRUCTS one — this class never assembles a page, it only restates the
 * field set so `@nestjs/swagger` can type the response. The plugin reads
 * declared property types from a class in a `.dto.ts` file; it can generate
 * nothing from `PaginationResultV1<T>`, a generic alias in a library, which is
 * why every paginated admin route before these was typed `{type: object}` in
 * the artifact. `implements PaginationResultV1<…>` is the compile-time binding:
 * a field added to the authority is an error here, not a silent omission on the
 * wire. Same rationale, and the same declaration exemption, as the GraphQL
 * bridge at `libs/backend-common/src/pagination/pagination.dto.ts`.
 */
export class CustomPlanPageDto implements PaginationResultV1<CustomPlanResponseDto> {
  // The plugin infers a property's schema from its declared type and cannot
  // read `readonly T[]`: it falls back to the declaring class and reports a
  // circular dependency. An explicit lazy resolver is the documented way out,
  // and it keeps the `readonly` the authority's type requires.
  @ApiProperty({ type: () => [CustomPlanResponseDto] })
  readonly items!: readonly CustomPlanResponseDto[];
  readonly total!: number;
  readonly page!: number;
  readonly limit!: number;
  readonly totalPages!: number;
  readonly hasNextPage!: boolean;
  readonly hasPreviousPage!: boolean;
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
