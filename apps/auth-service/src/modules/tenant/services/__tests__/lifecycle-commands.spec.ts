import { TENANT_STATUS_TRANSITIONS, TenantStatus } from '@platform/event-contracts';

import { LIFECYCLE_COMMANDS } from '../tenant-provisioning-command.service';

/**
 * W3.3-c make-it-detectable guard. LIFECYCLE_COMMANDS is the command→{target,
 * sources} authorization map the provisioning command service consults; edge
 * legality itself is owned by the canonical TenantStatusMachine
 * (TENANT_STATUS_TRANSITIONS). These tests pin the invariant that the
 * authorization map is always a SUBSET of the machine — it may narrow which
 * command drives a transition, but it can never authorize an edge the machine
 * forbids. Drift looser than the machine fails here at CI time rather than only
 * at runtime when the offending transition is exercised.
 */
describe('LIFECYCLE_COMMANDS vs canonical TenantStatusMachine', () => {
  const entries = Object.entries(LIFECYCLE_COMMANDS);

  // LIFECYCLE_COMMANDS is a Record<string, …> (the service indexes it by an
  // arbitrary command string and guards undefined). Narrow by command name for
  // the targeted assertions without a non-null cast.
  const cmd = (name: string): (typeof LIFECYCLE_COMMANDS)[string] => {
    const entry = LIFECYCLE_COMMANDS[name];
    if (!entry) {
      throw new Error(`LIFECYCLE_COMMANDS is missing the ${name} command`);
    }
    return entry;
  };

  it('declares at least one lifecycle command', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries)(
    '%s: every authorized source is a legal canonical machine edge into its target',
    (_command, { target, sources }) => {
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) {
        // source -> target MUST be a legal edge in the SSoT machine.
        expect(TENANT_STATUS_TRANSITIONS[source]).toContain(target);
      }
    },
  );

  it.each(entries)(
    '%s: never authorizes a self-transition (source === target)',
    (_command, { target, sources }) => {
      expect(sources).not.toContain(target);
    },
  );

  it('makes PROVISIONING a real persisted phase: BeginProvisioning targets PROVISIONING and ActivateTenant only completes it from PROVISIONING', () => {
    expect(cmd('BeginProvisioning').target).toBe(TenantStatus.PROVISIONING);
    expect(cmd('BeginProvisioning').sources).toEqual([
      TenantStatus.PENDING,
      TenantStatus.PROVISIONING_FAILED,
    ]);
    expect(cmd('ActivateTenant').target).toBe(TenantStatus.ACTIVE);
    expect(cmd('ActivateTenant').sources).toEqual([TenantStatus.PROVISIONING]);
  });

  it('does not let ActivateTenant reactivate a SUSPENDED/DEACTIVATED/CANCELLED tenant even though the machine permits those edges', () => {
    // The machine allows SUSPENDED/DEACTIVATED/CANCELLED -> ACTIVE; the command
    // authorization map deliberately narrows ActivateTenant to PROVISIONING only.
    expect(TENANT_STATUS_TRANSITIONS[TenantStatus.SUSPENDED]).toContain(TenantStatus.ACTIVE);
    expect(cmd('ActivateTenant').sources).not.toContain(TenantStatus.SUSPENDED);
    expect(cmd('ActivateTenant').sources).not.toContain(TenantStatus.DEACTIVATED);
    expect(cmd('ActivateTenant').sources).not.toContain(TenantStatus.CANCELLED);
  });

  it('gives suspension recovery its own typed ResumeTenant authority', () => {
    expect(cmd('ResumeTenant').target).toBe(TenantStatus.ACTIVE);
    expect(cmd('ResumeTenant').sources).toEqual([TenantStatus.SUSPENDED]);
  });

  it('marks FailProvisioning tolerant (saga compensation no-op outside PROVISIONING)', () => {
    expect(cmd('FailProvisioning').tolerant).toBe(true);
    expect(cmd('FailProvisioning').sources).toEqual([TenantStatus.PROVISIONING]);
  });
});
