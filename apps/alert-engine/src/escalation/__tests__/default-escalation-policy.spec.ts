import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  EscalationPolicy,
  EscalationRecipientRole,
  EscalationRecipientScope,
  NotificationChannel,
} from '../../database/entities/escalation-policy.entity';
import {
  DEFAULT_ESCALATION_POLICY_CREATOR,
  defaultEscalationPolicyRow,
} from '../default-escalation-policy';
import { EscalationPolicyService } from '../escalation-policy.service';

const TENANT_ID = '7f6b08ab-90e2-46d3-8a11-2b3c4d5e6f70';

/**
 * ALERT-CRITICAL-004 — the default escalation policy. The INSERT … ON CONFLICT
 * semantics (idempotency, the unique default index, reconcile over tenants) are
 * proven against real Postgres in
 * `src/__tests__/integration/farm-signal-delivery.postgres.spec.ts`; this spec
 * pins the policy's content and the service invariants around it.
 */
describe('defaultEscalationPolicyRow', () => {
  it('is the plan content: CRITICAL/HIGH → site managers + tenant admins, push + e-mail', () => {
    // SCENARIO: the row every tenant is seeded with.
    // EXPECTS: exactly the plan's recipients/channels, marked default + active, no
    //          repeats (until incidents can be acknowledged a repeat re-pages people).
    const row = defaultEscalationPolicyRow(TENANT_ID);

    expect(row).toMatchObject({
      tenantId: TENANT_ID,
      isDefault: true,
      isActive: true,
      maxRepeats: 0,
      createdBy: DEFAULT_ESCALATION_POLICY_CREATOR,
      severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
    });
    expect(row.levels).toEqual([
      expect.objectContaining({
        level: 1,
        notifyUserIds: [],
        notifyRoles: [
          {
            role: EscalationRecipientRole.MODULE_MANAGER,
            scope: EscalationRecipientScope.INCIDENT_SITE,
          },
          { role: EscalationRecipientRole.TENANT_ADMIN, scope: EscalationRecipientScope.TENANT },
        ],
        channels: [NotificationChannel.PUSH, NotificationChannel.EMAIL],
      }),
    ]);
  });
});

/** An insert chain double: `rows` are what the INSERT … RETURNING yields. */
interface InsertChain {
  insert(): InsertChain;
  into(): InsertChain;
  values(row: unknown): InsertChain;
  orIgnore(): InsertChain;
  returning(): InsertChain;
  execute(): Promise<{ raw: unknown[] }>;
}

function insertChain(rows: unknown[]): { chain: InsertChain; values: jest.Mock } {
  const values = jest.fn();
  const chain: InsertChain = {
    insert: () => chain,
    into: () => chain,
    values: (row: unknown) => {
      values(row);
      return chain;
    },
    orIgnore: () => chain,
    returning: () => chain,
    execute: async () => ({ raw: rows }),
  };
  return { chain, values };
}

describe('EscalationPolicyService — default policy invariants', () => {
  async function build(): Promise<{
    service: EscalationPolicyService;
    repository: { find: jest.Mock; findOne: jest.Mock; save: jest.Mock; update: jest.Mock };
    values: jest.Mock;
  }> {
    const { chain, values } = insertChain([{ id: 'seeded' }]);
    const repository = {
      find: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(async (row: EscalationPolicy) => row),
      update: jest.fn(),
      manager: { createQueryBuilder: () => chain },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        EscalationPolicyService,
        { provide: getRepositoryToken(EscalationPolicy), useValue: repository },
      ],
    }).compile();
    return { service: moduleRef.get(EscalationPolicyService), repository, values };
  }

  it('seeds the default at point of use when a tenant has no policy at all', async () => {
    // SCENARIO: an alarm arrives before the provisioning event / reconcile ran.
    // EXPECTS: the default is inserted through the tenant-bound repository manager
    //          and reloaded, so the very first incident already matches a policy.
    const { service, repository, values } = await build();
    const seeded = Object.assign(new EscalationPolicy(), {
      id: 'seeded',
      tenantId: TENANT_ID,
      isActive: true,
      isDefault: true,
      severity: [AlertSeverity.CRITICAL, AlertSeverity.HIGH],
      levels: [],
    });
    repository.find.mockResolvedValueOnce([]).mockResolvedValueOnce([seeded]);

    const policies = await service.getPolicies(TENANT_ID);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, isDefault: true }),
    );
    expect(policies).toEqual([seeded]);
  });

  it('does not seed when the tenant already has policies', async () => {
    // SCENARIO: a tenant that configured its own policies (none default-marked).
    // EXPECTS: no insert at point of use — only a tenant with zero policies is seeded here.
    const { service, repository, values } = await build();
    repository.find.mockResolvedValue([
      Object.assign(new EscalationPolicy(), { id: 'own', tenantId: TENANT_ID, isActive: true }),
    ]);

    await service.getPolicies(TENANT_ID);

    expect(values).not.toHaveBeenCalled();
  });
});
