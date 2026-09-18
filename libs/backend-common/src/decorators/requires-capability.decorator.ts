/**
 * `@RequiresCapability(...)` — a platform-admin route names the capability it
 * needs (ADR-0016, SEC-HIGH-059).
 *
 * The SUPER_ADMIN role admits a principal to the platform-admin surface;
 * it no longer authorises every mutation on it. A handler decorated with
 * `@RequiresCapability('billing-ops')` is admitted only when the verified
 * `platformCapabilities` JWT claim holds at least one of the listed
 * capabilities. `PlatformCapabilityGuard` enforces it as a global guard,
 * ANDed after the authentication guard, so a grant can narrow but never
 * widen what the role admits.
 *
 * The capability vocabulary is the closed enum in `@platform/event-contracts`;
 * a typo is a compile error, not an unreachable route.
 */
import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { PlatformCapability } from '@platform/event-contracts';

export const PLATFORM_CAPABILITY_KEY = 'aquaculture:requiresCapability';

export const RequiresCapability = (
  first: PlatformCapability,
  ...rest: PlatformCapability[]
): CustomDecorator<string> => SetMetadata(PLATFORM_CAPABILITY_KEY, [first, ...rest]);
