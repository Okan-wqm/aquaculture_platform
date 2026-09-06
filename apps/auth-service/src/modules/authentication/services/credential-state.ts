import { BypassRlsService } from '@aquaculture/backend-common/database';
import { getRequestContext, requestContextStorage } from '@aquaculture/backend-common/logging';
import { Role } from '@aquaculture/backend-common/decorators';
import { ForbiddenException } from '@nestjs/common';
import { isLoginAllowed } from '@platform/event-contracts';
import { DataSource, EntityManager } from 'typeorm';

import { Tenant } from '../../tenant/entities/tenant.entity';
import { User } from '../entities/user.entity';
import type { OriginatingAccessSession } from './token.service';

const credentialProofBrand = Symbol('CredentialProof');

export interface CredentialProof {
  readonly [credentialProofBrand]: true;
  readonly id: string;
  readonly role: Role;
  readonly tenantId: string | null;
  readonly isActive: boolean;
  readonly credentialVersion: number;
}

export function snapshotCredentialProof(user: User): CredentialProof {
  if (!Number.isSafeInteger(user.credentialVersion) || user.credentialVersion < 1) {
    throw new ForbiddenException('User credential state is unavailable');
  }
  return Object.freeze({
    [credentialProofBrand]: true as const,
    id: user.id,
    role: user.role,
    tenantId: user.tenantId ?? null,
    isActive: user.isActive,
    credentialVersion: user.credentialVersion,
  });
}

/** Restore only validated signed claims; never accept an arbitrary principal as a proof. */
export function credentialProofFromClaims(claims: unknown): CredentialProof {
  if (
    !claims ||
    typeof claims !== 'object' ||
    !('id' in claims) ||
    typeof claims.id !== 'string' ||
    !claims.id ||
    !('role' in claims) ||
    !Object.values(Role).some((role) => role === claims.role) ||
    !('tenantId' in claims) ||
    !(claims.tenantId === null || typeof claims.tenantId === 'string') ||
    !('isActive' in claims) ||
    typeof claims.isActive !== 'boolean' ||
    !('credentialVersion' in claims) ||
    typeof claims.credentialVersion !== 'number' ||
    !Number.isSafeInteger(claims.credentialVersion) ||
    claims.credentialVersion < 1
  ) {
    throw new ForbiddenException('User credential state is unavailable');
  }
  const role = Object.values(Role).find((candidate) => candidate === claims.role);
  if (!role) throw new ForbiddenException('User credential state is unavailable');
  return Object.freeze({
    [credentialProofBrand]: true as const,
    id: claims.id,
    role,
    tenantId: claims.tenantId,
    isActive: claims.isActive,
    credentialVersion: claims.credentialVersion,
  });
}

export function assertCredentialProof(proof: CredentialProof, user: User): void {
  if (
    proof.id !== user.id ||
    proof.role !== user.role ||
    proof.tenantId !== (user.tenantId ?? null) ||
    proof.isActive !== user.isActive ||
    proof.credentialVersion !== user.credentialVersion
  ) {
    throw new ForbiddenException('User credentials changed during authentication');
  }
}

/** Created only after Tenant → User locks. Identity tables deliberately have no tenant RLS. */
export class LockedAuthContext {
  private proof: CredentialProof;

  private constructor(
    readonly manager: EntityManager,
    public user: User,
    readonly tenant: Tenant | null,
  ) {
    this.proof = snapshotCredentialProof(user);
  }

  static async lock(
    manager: EntityManager,
    subject: CredentialProof | string,
  ): Promise<LockedAuthContext> {
    const queryRunner = manager.queryRunner;
    if (!queryRunner || !queryRunner.isTransactionActive) {
      throw new Error('Credential locks require an active transaction');
    }
    const id = typeof subject === 'string' ? subject : subject.id;
    const discovered = await manager.findOne(User, {
      where: { id },
      select: { id: true, tenantId: true },
    });
    if (!discovered) throw new ForbiddenException('Authentication failed');
    const tenant = discovered.tenantId
      ? await manager.findOne(Tenant, {
          where: { id: discovered.tenantId },
          lock: { mode: 'pessimistic_read' },
        })
      : null;
    const user = await manager.findOne(User, {
      where: { id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!user || (user.tenantId ?? null) !== (discovered.tenantId ?? null)) {
      throw new ForbiddenException('User credentials changed during authentication');
    }
    snapshotCredentialProof(user);
    if (typeof subject !== 'string') assertCredentialProof(subject, user);
    return new LockedAuthContext(manager, user, tenant);
  }

  assertSessionAdmission(): void {
    if (!this.manager.queryRunner || !this.manager.queryRunner.isTransactionActive) {
      throw new Error('Credential context requires an active transaction');
    }
    assertCredentialProof(this.proof, this.user);
    if (
      !this.user.isActive ||
      this.user.isLocked() ||
      (this.user.tenantId && (!this.tenant || !isLoginAllowed(this.tenant.status))) ||
      (!this.user.tenantId && this.user.role !== Role.SUPER_ADMIN)
    ) {
      throw new ForbiddenException('Authentication failed');
    }
  }

  /** Explicitly adopt a credential change performed by this locked transaction. */
  async reloadUser(): Promise<User> {
    const user = await this.manager.findOne(User, { where: { id: this.user.id } });
    if (!user || (user.tenantId ?? null) !== (this.user.tenantId ?? null)) {
      throw new ForbiddenException('User identity changed during authentication');
    }
    this.proof = snapshotCredentialProof(user);
    this.user = user;
    return user;
  }
}

export async function withLockedCredentialPrincipal<T>(
  dataSource: DataSource,
  subject: CredentialProof | string,
  operation: (context: LockedAuthContext) => Promise<T>,
): Promise<T> {
  const transact = (): Promise<T> =>
    dataSource.transaction(async (manager) =>
      operation(await LockedAuthContext.lock(manager, subject)),
    );
  if (typeof subject === 'string') return transact();
  if (!subject.tenantId && subject.role !== Role.SUPER_ADMIN) {
    throw new ForbiddenException('Authentication failed');
  }
  // Public MFA/WebAuthn calls carry a verified proof before any tenant middleware
  // can authenticate the request. Bind its scope before the pool checkout.
  return requestContextStorage.run(
    {
      ...getRequestContext(),
      userId: subject.id,
      tenantId: subject.tenantId ?? undefined,
      bypassRls: false,
    },
    () =>
      subject.tenantId
        ? transact()
        : new BypassRlsService().withBypass('auth-service:platform-credential-proof', transact),
  );
}

/** Session cleanup trusts the verified JWT boundary, then revalidates its identity under locks.
 * It deliberately permits inactive/locked accounts and inactive tenants to terminate sessions.
 */
export async function withLockedAuthenticatedSession<T>(
  dataSource: DataSource,
  session: OriginatingAccessSession,
  operation: (context: LockedAuthContext) => Promise<T>,
): Promise<T> {
  if (
    typeof session.sub !== 'string' ||
    !session.sub ||
    !Object.values(Role).includes(session.role) ||
    !(
      session.tenantId === null ||
      (typeof session.tenantId === 'string' && session.tenantId.length > 0)
    ) ||
    (session.tenantId === null && session.role !== Role.SUPER_ADMIN) ||
    typeof session.jti !== 'string' ||
    !session.jti ||
    !Number.isSafeInteger(session.iat) ||
    session.iat < 1 ||
    !Number.isSafeInteger(session.exp) ||
    session.exp <= session.iat
  ) {
    throw new ForbiddenException('Authenticated session identity is unavailable');
  }
  const transact = (): Promise<T> =>
    dataSource.transaction(async (manager) => {
      const context = await LockedAuthContext.lock(manager, session.sub);
      if (
        context.user.role !== session.role ||
        (context.user.tenantId ?? null) !== session.tenantId
      ) {
        throw new ForbiddenException('Authenticated session identity changed');
      }
      return operation(context);
    });
  return requestContextStorage.run(
    {
      ...getRequestContext(),
      userId: session.sub,
      tenantId: session.tenantId ?? undefined,
      bypassRls: false,
    },
    () =>
      session.tenantId
        ? transact()
        : new BypassRlsService().withBypass('auth-service:platform-session-cleanup', transact),
  );
}
