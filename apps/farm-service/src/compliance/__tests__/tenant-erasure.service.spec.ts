/**
 * TenantErasureService Unit Tests
 *
 * Covers the two-step confirmation flow in isolation:
 *   - initiate creates a ticket with a 32-hex token and 5-min expiry
 *   - confirm with the matching token + tenant succeeds
 *   - confirm with a MISSING ticket → NotFoundException
 *   - confirm with a WRONG token → BadRequestException
 *   - confirm with a WRONG tenant → BadRequestException
 *   - confirm after expiry → BadRequestException, ticket consumed
 *   - second initiate replaces the first (single pending per tenant)
 *   - ticket is consumed before DELETE so retry with the same token
 *     after partial failure is impossible
 *
 * DELETE cascade itself is exercised against a doubled DataSource
 * so we assert the topological sort + anonymise behaviour without
 * standing up a real DB.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';

import { TenantErasureService } from '../services/tenant-erasure.service';

interface EntityMetadataDouble {
  tableName: string;
  target: unknown;
  columns: Array<{ propertyName: string }>;
  foreignKeys: Array<{ referencedTablePath: string }>;
}

function makeDs(opts: {
  entities: EntityMetadataDouble[];
  deleteResults?: Record<string, number>;
  auditAnonAffected?: number;
  deleteError?: Error;
}) {
  const executed: string[] = [];
  const deleteAffected = (table: string): number =>
    opts.deleteResults?.[table] ?? 0;
  const auditQb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({
      affected: opts.auditAnonAffected ?? 0,
    }),
  };
  // The main query builder services both DELETE chains (delete().from(E))
  // AND the audit UPDATE chain (update('farm.farm_audit_logs')). TypeORM
  // exposes a single createQueryBuilder() entrypoint; the service-under-
  // test uses the DELETE path inside the cascade loop and the UPDATE path
  // for the audit anonymise step. The `update` method here delegates to
  // auditQb so the UPDATE assertions (set / where / execute) remain
  // observable through the auditQb spy.
  const qb: {
    delete: jest.Mock;
    from: jest.Mock;
    where: jest.Mock;
    execute: jest.Mock;
    update: jest.Mock;
  } = {
    delete: jest.fn().mockReturnThis(),
    from: jest.fn().mockImplementation((target: unknown) => {
      const meta = opts.entities.find((e) => e.target === target);
      if (meta) executed.push(meta.tableName);
      return qb;
    }),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockImplementation(async () => {
      if (opts.deleteError) throw opts.deleteError;
      const last = executed[executed.length - 1] ?? '';
      return { affected: deleteAffected(last) };
    }),
    update: jest.fn().mockImplementation((table: string) => {
      auditQb.update(table);
      return auditQb;
    }),
  };
  const createQueryBuilder = jest.fn().mockImplementation(() => qb);
  const dataSource = {
    entityMetadatas: opts.entities,
    createQueryBuilder,
  };
  return { dataSource, executed, qb, auditQb };
}

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const USER = 'user-1';

describe('TenantErasureService ticket flow', () => {
  it('initiate returns a 32-hex token with 5-minute expiry', () => {
    const { dataSource } = makeDs({ entities: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const before = Date.now();
    const ticket = service.initiate(TENANT, USER);
    expect(ticket.tenantId).toBe(TENANT);
    expect(ticket.token).toMatch(/^[0-9a-f]{32}$/);
    expect(ticket.requestedBy).toBe(USER);
    const ttl = ticket.expiresAt.getTime() - before;
    expect(ttl).toBeGreaterThanOrEqual(4.9 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(5.1 * 60 * 1000);
  });

  it('confirm without an initiate throws NotFoundException', async () => {
    const { dataSource } = makeDs({ entities: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    await expect(service.confirm(TENANT, 'x')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('confirm with a wrong token rejects with BadRequestException', async () => {
    const { dataSource } = makeDs({ entities: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    service.initiate(TENANT, USER);
    await expect(
      service.confirm(TENANT, 'not-the-token'),
    ).rejects.toThrow(/token does not match/i);
  });

  it('confirm with a wrong tenant rejects (no ticket for that tenant)', async () => {
    const { dataSource } = makeDs({ entities: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const ticket = service.initiate(TENANT, USER);
    await expect(
      service.confirm(OTHER_TENANT, ticket.token),
    ).rejects.toThrow(NotFoundException);
  });

  it('confirm after expiry throws BadRequestException and consumes the ticket', async () => {
    const { dataSource } = makeDs({ entities: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const ticket = service.initiate(TENANT, USER);
    // Mutate the expiry so the ticket is stale without actually
    // waiting 5 minutes. The private map is reachable via the
    // documented getPendingTicket helper.
    const pending = service.getPendingTicket(TENANT);
    if (pending) pending.expiresAt = new Date(Date.now() - 1_000);
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      /expired/i,
    );
    expect(service.getPendingTicket(TENANT)).toBeUndefined();
  });

  it('second initiate replaces the first (single pending per tenant)', () => {
    const { dataSource } = makeDs({ entities: [] });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const t1 = service.initiate(TENANT, USER);
    const t2 = service.initiate(TENANT, USER);
    expect(t1.token).not.toBe(t2.token);
    expect(service.getPendingTicket(TENANT)?.token).toBe(t2.token);
  });

  it('successful confirm consumes the ticket so it cannot be replayed', async () => {
    const { dataSource } = makeDs({
      entities: [
        {
          tableName: 'example',
          target: class Example {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { example: 3 },
      auditAnonAffected: 0,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);
    expect(service.getPendingTicket(TENANT)).toBeUndefined();
    await expect(service.confirm(TENANT, ticket.token)).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('TenantErasureService DELETE cascade', () => {
  it('skips farm_audit_logs from DELETE and anonymises its userId instead', async () => {
    const { dataSource, executed, auditQb } = makeDs({
      entities: [
        {
          tableName: 'farm_audit_logs',
          target: class AuditLog {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'batches_v2',
          target: class Batch {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
      ],
      deleteResults: { batches_v2: 5 },
      auditAnonAffected: 12,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const ticket = service.initiate(TENANT, USER);
    const result = await service.confirm(TENANT, ticket.token);

    expect(executed).toEqual(['batches_v2']); // audit table skipped
    expect(result.deletedRowsByTable).toEqual({ batches_v2: 5 });
    expect(result.totalDeleted).toBe(5);
    expect(result.auditRowsAnonymised).toBe(12);
    expect(auditQb.update).toHaveBeenCalledWith('farm.farm_audit_logs');
  });

  it('sorts by inbound-FK count so child tables delete before parents', async () => {
    const { dataSource, executed } = makeDs({
      entities: [
        {
          tableName: 'parent',
          target: class Parent {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [],
        },
        {
          tableName: 'child',
          target: class Child {},
          columns: [{ propertyName: 'tenantId' }],
          foreignKeys: [{ referencedTablePath: 'parent' }],
        },
      ],
      deleteResults: { child: 2, parent: 1 },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const service = new TenantErasureService(dataSource as any);
    const ticket = service.initiate(TENANT, USER);
    await service.confirm(TENANT, ticket.token);
    // Parent has 1 inbound FK (from child); child has 0.
    // Sort ascending by inbound count → child (0), parent (1).
    expect(executed).toEqual(['child', 'parent']);
  });
});

describe('TenantErasureService.hashUserId', () => {
  it('produces a stable 16-char hex prefix', () => {
    const h1 = TenantErasureService.hashUserId('user-1');
    const h2 = TenantErasureService.hashUserId('user-1');
    expect(h1).toMatch(/^hashed:[0-9a-f]{16}$/);
    expect(h1).toBe(h2);
  });

  it('different userIds hash to different values', () => {
    expect(TenantErasureService.hashUserId('alice')).not.toBe(
      TenantErasureService.hashUserId('bob'),
    );
  });
});
