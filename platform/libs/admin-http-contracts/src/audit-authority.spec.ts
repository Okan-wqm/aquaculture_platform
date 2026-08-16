import {
  ADMIN_AUDIT_ACTION_CATALOG,
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_SEVERITY,
  ADMIN_AUDIT_WRITE_POLICY,
  adminAuditActionsForPolicy,
  adminAuditDefinition,
  isAdminAuditAction,
  isAdminAuditSeverity,
} from './audit-authority';

describe('admin audit authority', () => {
  it('partitions every active action into exactly one typed write policy', () => {
    const partitions = Object.values(ADMIN_AUDIT_WRITE_POLICY).map((policy) =>
      adminAuditActionsForPolicy(policy),
    );
    const flattened = partitions.flat();
    const active = ADMIN_AUDIT_ACTIONS.filter(
      (action) => adminAuditDefinition(action).lifecycle === 'ACTIVE',
    );

    expect([...flattened].sort()).toEqual([...active].sort());
    expect(new Set(flattened).size).toBe(flattened.length);
    expect(partitions.every((partition) => partition.length > 0)).toBe(true);
  });

  it('keeps retired values queryable but removes their write policy', () => {
    expect(adminAuditDefinition('TENANT_SUSPENDED')).toEqual({
      lifecycle: 'RETIRED_QUERY_ONLY',
      writePolicy: null,
      severity: ADMIN_AUDIT_SEVERITY.WARNING,
      successorAuthority: 'auth.tenant_command_receipts',
    });
    expect(isAdminAuditAction('TENANT_SUSPENDED')).toBe(true);
    expect(isAdminAuditAction('UNDECLARED_ACTION')).toBe(false);
  });

  it('publishes one immutable severity and action vocabulary to browser and server', () => {
    expect(Object.isFrozen(ADMIN_AUDIT_ACTION_CATALOG)).toBe(true);
    expect(Object.isFrozen(ADMIN_AUDIT_ACTIONS)).toBe(true);
    expect(
      ADMIN_AUDIT_ACTIONS.every((action) => Object.isFrozen(adminAuditDefinition(action))),
    ).toBe(true);
    expect(isAdminAuditSeverity('info')).toBe(true);
    expect(isAdminAuditSeverity('error')).toBe(false);
  });
});
