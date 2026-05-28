import { Injectable } from '@nestjs/common';
import { EntityManager } from 'typeorm';

import {
  ANONYMOUS_USER_ID,
  SYSTEM_AI_USER_ID,
  TenantPrincipal,
  TenantPrincipalKind,
  TenantPrincipalSource,
} from './tenant-principal.entity';

@Injectable()
export class TenantPrincipalService {
  async ensureSystemPrincipals(
    manager: EntityManager,
    tenantId: string,
  ): Promise<void> {
    await this.upsertPrincipal(manager, tenantId, ANONYMOUS_USER_ID, {
      kind: TenantPrincipalKind.ANONYMOUS,
      source: TenantPrincipalSource.SYSTEM,
      isActive: true,
    });
    await this.upsertPrincipal(manager, tenantId, SYSTEM_AI_USER_ID, {
      kind: TenantPrincipalKind.SYSTEM_AI,
      source: TenantPrincipalSource.SYSTEM,
      isActive: true,
    });
  }

  async upsertActiveUsers(
    manager: EntityManager,
    tenantId: string,
    userIds: string[],
  ): Promise<void> {
    await this.ensureSystemPrincipals(manager, tenantId);
    const uniqueUserIds = Array.from(new Set(userIds));
    const now = new Date();

    for (const userId of uniqueUserIds) {
      await this.upsertPrincipal(manager, tenantId, userId, {
        kind: TenantPrincipalKind.USER,
        source: TenantPrincipalSource.AUTH,
        isActive: true,
        lastValidatedAt: now,
      });
    }
  }

  private async upsertPrincipal(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    values: {
      kind: TenantPrincipalKind;
      source: TenantPrincipalSource;
      isActive: boolean;
      lastValidatedAt?: Date;
    },
  ): Promise<void> {
    const existing = await manager.findOne(TenantPrincipal, {
      where: { tenantId, userId },
    });

    if (existing) {
      existing.kind = values.kind;
      existing.source = values.source;
      existing.isActive = values.isActive;
      existing.lastValidatedAt = values.lastValidatedAt ?? existing.lastValidatedAt;
      existing.deactivatedAt = values.isActive ? null : (existing.deactivatedAt ?? new Date());
      await manager.save(TenantPrincipal, existing);
      return;
    }

    await manager.save(
      TenantPrincipal,
      manager.create(TenantPrincipal, {
        tenantId,
        userId,
        kind: values.kind,
        source: values.source,
        isActive: values.isActive,
        lastValidatedAt: values.lastValidatedAt ?? null,
        deactivatedAt: values.isActive ? null : new Date(),
      }),
    );
  }
}
