import { Injectable } from '@nestjs/common';

import {
  type PlatformPermission,
  type RbacManifestStatement,
  type SignedStatement,
  STATEMENT,
} from './edge-contract';
import { ManifestSigner } from './manifest-signer';
import { SuderraEdgeConfig } from './suderra-edge.config';

/**
 * The minimal RBAC manifest producer of P0 (ADR-048 DEC-9.4).
 *
 * Contract 1.x knows one actor: the platform actor, whose key is the cloud's
 * `command` key and whose single role `platform-authenticated` means "the
 * platform authenticated this request" — not a per-operator grant (that
 * single-actor model is EDGE-MEDIUM-121 until P2). The manifest is signed
 * with the `rbac-manifest` key; the device verifies it against the bundle's
 * rbac-manifest anchor and refuses an actor key the bundle does not anchor
 * as `command` (actor-key-not-anchored).
 *
 * The statement is a pure function of the tenant and the configured policy
 * (version, window, actor, key), so every provisioning of a tenant's devices
 * re-presents the identical manifest and the device's identical-only version
 * gate accepts it again (DEC-9.9). Changing any input requires a new
 * SUDERRA_EDGE_RBAC_POLICY_VERSION; reusing a version for a changed manifest
 * is refused by the device (same-policy-version-changed).
 */

/**
 * The platform role's permissions in P0: observation and failover only.
 * PlatformPermission excludes every two-person-integrity permission, so a
 * firmware, deploy, force, safe-state, reboot, OPC UA or S7 grant cannot be
 * written here (DEC-9.4); and until SG-1 opens at P2 exit the cloud grants
 * no actuation at all, so the device refuses remote output writes.
 */
export const PLATFORM_ROLE_PERMISSIONS: readonly PlatformPermission[] = [
  'FailoverControl',
  'ReadAuditLog',
  'ReadTag',
  'WatchSubscribe',
];

export interface RbacManifestInput {
  readonly tenantId: string;
  readonly policyVersion: number;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly actorId: string;
  readonly actorKeyid: string;
  readonly actorPublicKey: Buffer;
  readonly permissions: readonly PlatformPermission[];
}

export function buildRbacManifest(input: RbacManifestInput): RbacManifestStatement {
  return {
    _type: STATEMENT.rbacManifest,
    tenant_id: input.tenantId,
    policy_version: input.policyVersion,
    not_before: input.notBefore,
    expires_at: input.expiresAt,
    actors: [
      {
        actor_id: input.actorId,
        kind: 'platform',
        keyid: input.actorKeyid,
        public_key: input.actorPublicKey.toString('base64'),
        roles: ['platform-authenticated'],
      },
    ],
    roles: [
      {
        name: 'platform-authenticated',
        permissions: [...new Set(input.permissions)].sort(),
        not_before: input.notBefore,
        expires_at: input.expiresAt,
      },
    ],
  };
}

@Injectable()
export class RbacManifestService {
  constructor(private readonly config: SuderraEdgeConfig) {}

  /** The policy_version every command envelope claims (agent: claimed >= installed). */
  get policyVersion(): number {
    return this.config.settings.rbac.policyVersion;
  }

  /** The platform actor commands are signed as. */
  get platformActorId(): string {
    return this.config.settings.platformActorId;
  }

  forTenant(tenantId: string): SignedStatement<typeof STATEMENT.rbacManifest> {
    const settings = this.config.settings;
    const signer = new ManifestSigner(settings.keys.rbacManifest);
    return signer.sign(
      STATEMENT.rbacManifest,
      buildRbacManifest({
        tenantId,
        policyVersion: settings.rbac.policyVersion,
        notBefore: settings.rbac.notBefore,
        expiresAt: settings.rbac.expiresAt,
        actorId: settings.platformActorId,
        actorKeyid: settings.keys.command.keyid,
        actorPublicKey: settings.keys.command.publicKey,
        permissions: PLATFORM_ROLE_PERMISSIONS,
      }),
    );
  }
}
