/**
 * EscalationPolicyWriter — every policy write keeps CRITICAL and HIGH paging
 * somebody, the default changes only by a TENANT_ADMIN, and every write is
 * audited on the write's own transaction (V-S1a-2, V-S1b-2, V-S1b-6).
 *
 * London-school: the policy repository's transaction hands a scripted manager
 * (the tenant's current policies); the REAL `validatePolicy` and coverage rule
 * run.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AlertAuditService } from '../../audit/alert-audit.service';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  EscalationActionType,
  EscalationPolicy,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';
import { defaultEscalationLevels } from '../default-escalation-policy';
import { EscalationPolicyService } from '../escalation-policy.service';
import { EscalationPolicyWriter, type PolicyActor } from '../escalation-policy-writer.service';

const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';
const ADMIN: PolicyActor = { userId: '11111111-1111-4111-8111-111111111111', isTenantAdmin: true };
const MANAGER: PolicyActor = {
  userId: '22222222-2222-4222-8222-222222222222',
  isTenantAdmin: false,
};
const ON_CALL_USER = '33333333-3333-4333-8333-333333333333';

function defaultPolicy(overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return Object.assign(new EscalationPolicy(), {
    id: 'default',
    tenantId: TENANT_ID,
    name: 'Varsayılan alarm politikası',
    severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
    levels: defaultEscalationLevels(),
    repeatIntervalMinutes: 30,
    maxRepeats: 0,
    isActive: true,
    isDefault: true,
    priority: 0,
    ...overrides,
  });
}

function sitePolicy(overrides: Partial<EscalationPolicy> = {}): EscalationPolicy {
  return Object.assign(new EscalationPolicy(), {
    id: 'site',
    tenantId: TENANT_ID,
    name: 'Night shift',
    severity: [AlertSeverity.HIGH, AlertSeverity.WARNING],
    levels: [
      {
        level: 1,
        name: 'on call',
        timeoutMinutes: 15,
        notifyUserIds: [],
        channels: [NotificationChannel.PUSH],
        action: EscalationActionType.NOTIFY,
      },
    ],
    onCallSchedule: [{ dayOfWeek: 1, startTime: '00:00', endTime: '23:59', userId: ON_CALL_USER }],
    repeatIntervalMinutes: 5,
    maxRepeats: 0,
    isActive: true,
    isDefault: false,
    priority: 5,
    ...overrides,
  });
}

interface Harness {
  writer: EscalationPolicyWriter;
  manager: {
    find: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    remove: jest.Mock;
  };
  audit: { recordInTransaction: jest.Mock };
}

async function build(current: EscalationPolicy[]): Promise<Harness> {
  const manager = {
    find: jest.fn(async () => current),
    create: jest.fn((_entity: unknown, row: object) => Object.assign(new EscalationPolicy(), row)),
    save: jest.fn(async (_entity: unknown, row: EscalationPolicy) => row),
    update: jest.fn(async () => ({ affected: 1 })),
    remove: jest.fn(async () => undefined),
  };
  const audit = { recordInTransaction: jest.fn(async () => undefined) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      EscalationPolicyWriter,
      EscalationPolicyService,
      {
        provide: getRepositoryToken(EscalationPolicy),
        useValue: {
          manager: { transaction: (cb: (m: typeof manager) => Promise<unknown>) => cb(manager) },
        },
      },
      { provide: AlertAuditService, useValue: audit },
    ],
  }).compile();
  return { writer: moduleRef.get(EscalationPolicyWriter), manager, audit };
}

describe('EscalationPolicyWriter — life-safety coverage invariant (V-S1a-2)', () => {
  it('refuses an update WITHOUT levels that drops CRITICAL from the only covering policy', async () => {
    // SCENARIO: an admin narrows the default to [INFO] — no `levels` in the update
    //           (the path that used to skip validation entirely).
    // EXPECTS: 409, nothing saved, nothing audited.
    const { writer, manager, audit } = await build([defaultPolicy()]);

    await expect(
      writer.updatePolicy('default', TENANT_ID, { severity: [AlertSeverity.INFO] }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(manager.save).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('refuses an empty severity list on update', async () => {
    const { writer } = await build([defaultPolicy()]);

    await expect(
      writer.updatePolicy('default', TENANT_ID, { severity: [] }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('allows narrowing the default when another active policy keeps HIGH covered', async () => {
    // SCENARIO: the default keeps CRITICAL only; the night-shift policy covers HIGH
    //           through its on-call user.
    // EXPECTS: accepted and audited on the same transaction manager.
    const { writer, manager, audit } = await build([defaultPolicy(), sitePolicy()]);

    await writer.updatePolicy('default', TENANT_ID, { severity: [AlertSeverity.CRITICAL] }, ADMIN);

    expect(manager.save).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ entityId: 'default', userId: ADMIN.userId }),
    );
  });

  it('refuses deactivating or deleting the policy that alone keeps HIGH covered', async () => {
    const current = [defaultPolicy({ severity: [AlertSeverity.CRITICAL] }), sitePolicy()];
    const { writer } = await build(current);

    await expect(
      writer.updatePolicy('site', TENANT_ID, { isActive: false }, MANAGER),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(writer.deletePolicy('site', TENANT_ID, ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses an on-call change that leaves the HIGH policy with nobody to page', async () => {
    // SCENARIO: the night-shift level pages only its on-call user; the schedule is emptied.
    // EXPECTS: 409 — its level would no longer name a resolvable recipient.
    const { writer } = await build([
      defaultPolicy({ severity: [AlertSeverity.CRITICAL] }),
      sitePolicy(),
    ]);

    await expect(
      writer.updateOnCallSchedule('site', TENANT_ID, [], MANAGER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not count a rule-filtered policy as coverage', async () => {
    // SCENARIO: the only HIGH policy is filtered to one rule.
    const { writer } = await build([defaultPolicy()]);

    await expect(
      writer.updatePolicy(
        'default',
        TENANT_ID,
        { ruleIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('refuses a policy whose explicit recipient is not a user id (V-S1b-6)', async () => {
    const { writer } = await build([defaultPolicy()]);

    await expect(
      writer.createPolicy(
        {
          tenantId: TENANT_ID,
          name: 'Typo',
          severity: [AlertSeverity.WARNING],
          levels: [
            {
              level: 1,
              name: 'ops',
              timeoutMinutes: 10,
              notifyUserIds: ['night.shift@farm.example'],
              channels: [NotificationChannel.EMAIL],
              action: EscalationActionType.NOTIFY,
            },
          ],
        },
        MANAGER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('EscalationPolicyWriter — the default policy is the admin’s (V-S1b-2)', () => {
  it('refuses a module manager editing the default policy', async () => {
    const { writer, manager } = await build([defaultPolicy()]);

    await expect(
      writer.updatePolicy('default', TENANT_ID, { name: 'Muted' }, MANAGER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('refuses a module manager making a policy the default (create or update)', async () => {
    const { writer } = await build([defaultPolicy(), sitePolicy()]);

    await expect(
      writer.updatePolicy('site', TENANT_ID, { isDefault: true }, MANAGER),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      writer.createPolicy(
        {
          tenantId: TENANT_ID,
          name: 'New default',
          severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
          levels: defaultEscalationLevels(),
          isDefault: true,
        },
        MANAGER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets an admin switch the default, demoting the old one in the same transaction, audited', async () => {
    const { writer, manager, audit } = await build([defaultPolicy(), sitePolicy()]);

    await writer.updatePolicy('site', TENANT_ID, { isDefault: true }, ADMIN);

    expect(manager.update).toHaveBeenCalledWith(
      EscalationPolicy,
      { tenantId: TENANT_ID, isDefault: true },
      { isDefault: false },
    );
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({ entityId: 'site', severity: 'WARNING' }),
    );
  });

  it('refuses un-defaulting or deactivating the default policy', async () => {
    const { writer } = await build([defaultPolicy()]);

    await expect(
      writer.updatePolicy('default', TENANT_ID, { isDefault: false }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      writer.updatePolicy('default', TENANT_ID, { isActive: false }, ADMIN),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 404 for another tenant’s policy id', async () => {
    const { writer } = await build([]);

    await expect(
      writer.updatePolicy('default', TENANT_ID, { name: 'x' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('EscalationPolicyWriter — suppression windows (ALERT-3, V-S1b-2)', () => {
  const window = {
    name: 'maintenance',
    startTime: new Date('2026-09-30T01:00:00.000Z'),
    endTime: new Date('2026-09-30T03:00:00.000Z'),
    isRecurring: false,
  };

  it('refuses a module manager adding a window to the default policy', async () => {
    const { writer } = await build([defaultPolicy()]);

    await expect(
      writer.addSuppressionWindow('default', TENANT_ID, window, MANAGER),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('stamps the creator role: a manager window can never silence HIGH', async () => {
    const { writer, manager } = await build([defaultPolicy(), sitePolicy()]);

    const saved = await writer.addSuppressionWindow('site', TENANT_ID, window, MANAGER);

    expect(saved.suppressionWindows?.[0]).toMatchObject({
      createdBy: MANAGER.userId,
      createdByTenantAdmin: false,
    });
    expect(saved.suppresses(AlertSeverity.HIGH, new Date('2026-09-30T02:00:00.000Z'))).toBe(false);
    expect(saved.suppresses(AlertSeverity.WARNING, new Date('2026-09-30T02:00:00.000Z'))).toBe(
      true,
    );
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('stamps an admin window, which may silence HIGH but never CRITICAL', async () => {
    const { writer } = await build([defaultPolicy()]);

    const saved = await writer.addSuppressionWindow('default', TENANT_ID, window, ADMIN);
    const inside = new Date('2026-09-30T02:00:00.000Z');

    expect(saved.suppresses(AlertSeverity.HIGH, inside)).toBe(true);
    expect(saved.suppresses(AlertSeverity.CRITICAL, inside)).toBe(false);
  });

  it('refuses a window that ends before it starts', async () => {
    const { writer } = await build([defaultPolicy()]);

    await expect(
      writer.addSuppressionWindow(
        'default',
        TENANT_ID,
        { ...window, endTime: new Date('2026-09-30T00:00:00.000Z') },
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('EscalationPolicyWriter — role targets count as coverage', () => {
  it('accepts a policy whose only level-1 recipients are role targets', async () => {
    const { writer, manager } = await build([defaultPolicy()]);

    await writer.createPolicy(
      {
        tenantId: TENANT_ID,
        name: 'Managers',
        severity: [AlertSeverity.WARNING],
        levels: [
          {
            level: 1,
            name: 'managers',
            timeoutMinutes: 10,
            notifyUserIds: [],
            notifyRoles: [
              {
                role: EscalationRecipientRole.MODULE_MANAGER,
                scope: EscalationRecipientScope.INCIDENT_SITE,
              },
            ],
            channels: [NotificationChannel.PUSH],
            action: EscalationActionType.NOTIFY,
          },
        ],
      },
      MANAGER,
    );

    expect(manager.save).toHaveBeenCalledTimes(1);
  });
});
