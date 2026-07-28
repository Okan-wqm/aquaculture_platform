/**
 * The tenant READ contract — one named, fully-serializable shape, one mapper.
 *
 * # What was wrong
 *
 * Only the list endpoint mapped a DTO. `GET /admin/tenants/:id`,
 * `GET /admin/tenants/slug/:slug`, `GET /admin/tenants/search`,
 * `GET /admin/tenants/expiring-trials` and the four lifecycle mutations all
 * returned the `Tenant` ENTITY straight out of the repository.
 *
 * `Tenant` declares `tier` and `limits` as GETTERS. A getter lives on the
 * prototype, so it is not an own enumerable property, so `JSON.stringify` does
 * not see it — every one of those responses silently shipped without a tier and
 * without limits. `getTenantBySlug` made it worse by destructuring the entity to
 * drop `status`, which also drops the getters, and then spreading every
 * remaining internal column onto the wire.
 *
 * It was not theoretical. The impersonation target picker renders
 * `{tenant.name} ({tenant.tier})` over `tenantsApi.search(…)`, so every row read
 * `Acme ()`. `useTenantSearch` fed `t.tier` into `.toLowerCase()`.
 *
 * # The rule
 *
 * A persistence object is not a response. Every tenant read returns
 * `TenantSummaryDto`, built by `toTenantSummary` — the ONLY place a `Tenant`
 * becomes wire data, so a field can no longer be lost by being computed in a
 * place JSON cannot reach. `tests/invariants/entity-getter-response.spec.ts`
 * makes the regression detectable.
 *
 * # Why the counts are a separate shape
 *
 * `farmCount`/`sensorCount` are not columns — they are counted at read time
 * across the per-tenant schemas, batched once per page. The summary therefore
 * does NOT carry them: an endpoint that did not measure a count must not report
 * one, and `0` is a measurement. `TenantListItemDto` extends the summary with
 * exactly the numbers the list actually measured.
 */
import { TenantPlan, TenantStatus } from '../entities/tenant.entity';
import type { Tenant } from '../entities/tenant.entity';

/**
 * A tenant as every read surface sees it: identity, lifecycle, plan, contact.
 *
 * Every member is an own property of a plain object — nothing here is computed
 * by an accessor, so nothing here can vanish between the handler and the client.
 */
export interface TenantSummaryDto {
  id: string;
  name: string;
  slug: string;
  /** The tenant's custom domain. `customDomain` is the column; `domain` is the wire name. */
  domain?: string;
  status: TenantStatus;
  /** Materialized from `plan`: `Tenant.tier` is a getter and does not serialize. */
  tier: TenantPlan;
  contactEmail?: string;
  description?: string;
  trialEndsAt: Date | null;
  /**
   * Derived from `trialEndsAt`, the trial SSoT (MT-MEDIUM-001 dropped the
   * `is_trial_active` column precisely because it drifted from it).
   *
   * Derived HERE rather than at each reader: the detail service already
   * computed it, the list did not, so the same tenant showed a Trial badge on
   * one screen and not the other.
   */
  isTrialActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A tenant in the paginated list, with the resource counts the list measured.
 *
 * Extends rather than repeats: the list is a summary plus counts, so a field
 * added to the read contract reaches both without a second edit.
 */
export interface TenantListItemDto extends TenantSummaryDto {
  userCount: number;
  farmCount: number;
  sensorCount: number;
}

/** Resource counts measured across a tenant's own schema. */
export interface TenantResourceCounts {
  farmCount: number;
  sensorCount: number;
}

/**
 * The one place a `Tenant` entity becomes wire data.
 *
 * `tier` is read from `plan` rather than from the `tier` getter — not because
 * the getter is wrong, but so the projection stays explicit about which fields
 * exist on the wire.
 */
export function toTenantSummary(tenant: Tenant): TenantSummaryDto {
  return {
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    domain: tenant.customDomain,
    status: tenant.status,
    tier: tenant.plan,
    contactEmail: tenant.contactEmail,
    description: tenant.description,
    trialEndsAt: tenant.trialEndsAt ?? null,
    isTrialActive: tenant.trialEndsAt != null && tenant.trialEndsAt > new Date(),
    createdAt: tenant.createdAt,
    updatedAt: tenant.updatedAt,
  };
}

/** The list projection: a summary plus the counts this page actually measured. */
export function toTenantListItem(
  tenant: Tenant,
  resources: TenantResourceCounts,
): TenantListItemDto {
  return {
    ...toTenantSummary(tenant),
    userCount: tenant.userCount,
    farmCount: resources.farmCount,
    sensorCount: resources.sensorCount,
  };
}
