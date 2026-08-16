import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  VERSION_NEUTRAL,
  VersioningType,
  type VersioningOptions,
} from '@nestjs/common';
import {
  ADMIN_HTTP_ROUTE_POLICY,
  assertCanonicalAdminRequestTarget,
  type AdminHttpRoutePolicy,
} from '@platform/admin-http-contracts';
import {
  ADMIN_SERVER_REQUEST_CONTRACTS,
  ADMIN_SERVER_ROUTE_LIFECYCLE,
} from './generated/admin-request-contracts.generated';
import { createAdminRequestContractGuard } from './admin-request-contract.guard';

const canonicalAdminRequestTargetGuard: CanActivate = Object.freeze({
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<{ readonly originalUrl?: unknown }>();
    try {
      assertCanonicalAdminRequestTarget(request.originalUrl);
      return true;
    } catch {
      throw new BadRequestException('Non-canonical request target');
    }
  },
});

export function adminHttpBootstrapRouteOptions(policy: AdminHttpRoutePolicy): {
  readonly globalPrefix: string;
  readonly prefixExclusions: string[];
  readonly versioning: VersioningOptions;
  readonly globalGuards: CanActivate[];
} {
  if (policy !== ADMIN_HTTP_ROUTE_POLICY) {
    throw new TypeError('admin bootstrap requires the canonical route policy object');
  }
  return {
    globalPrefix: policy.globalPrefix,
    prefixExclusions: [...policy.prefixExclusions],
    versioning: {
      type: VersioningType.URI,
      prefix: policy.versioning.prefix,
      defaultVersion: policy.versioning.defaultVersions.map((version) =>
        version === 'neutral' ? VERSION_NEUTRAL : version,
      ),
    },
    globalGuards: [
      canonicalAdminRequestTargetGuard,
      createAdminRequestContractGuard(
        ADMIN_SERVER_REQUEST_CONTRACTS,
        ADMIN_SERVER_ROUTE_LIFECYCLE,
      ),
    ],
  };
}
