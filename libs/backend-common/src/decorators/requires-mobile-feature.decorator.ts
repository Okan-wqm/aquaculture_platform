import { SetMetadata, CustomDecorator } from '@nestjs/common';

/**
 * Metadata key carrying the required mobile feature for a route/resolver.
 */
export const MOBILE_FEATURE_KEY = 'requiresMobileFeature';

/**
 * @RequiresMobileFeature (SEC-HIGH-052)
 *
 * WHY: the per-user mobile entitlement SSoT —
 * `auth.mobile_user_settings.allowedFeatures` (TENANT_ADMIN-managed) — gates the
 * AquaMobil UI via `useMobilePermissions`, but the farm/hr GraphQL resolvers
 * never consulted it, so a crafted GraphQL request bypassed every feature flag.
 * This decorator names the feature a mutation belongs to; {@link MobileFeatureGuard}
 * enforces it server-side against the JWT `mobileFeatures` claim.
 *
 * WHAT: stamps the feature key (e.g. 'mortality', 'harvest', 'leave') so the
 * guard can read it via the Nest Reflector. The role gate (`@Roles`) and this
 * feature gate are ORTHOGONAL controls — both apply; the feature flag never
 * relaxes the role floor.
 *
 * @param feature the MobileAllowedFeatures key this mutation requires.
 */
export const RequiresMobileFeature = (feature: string): CustomDecorator<string> =>
  SetMetadata(MOBILE_FEATURE_KEY, feature);
