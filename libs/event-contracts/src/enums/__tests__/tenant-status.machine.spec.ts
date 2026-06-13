import { TenantStatus } from '../tenant-status.enum';
import {
  TENANT_STATUS_TRANSITIONS,
  assertTransition,
  canTransition,
  isLoginAllowed,
  isTerminal,
} from '../tenant-status.machine';

/**
 * Table-driven lifecycle contract for the tenant status machine.
 *
 * The EXPECTED matrix below is declared independently of the source matrix
 * so a change to {@link TENANT_STATUS_TRANSITIONS} that is not also reflected
 * here fails CI — the spec is the second witness, not a copy of the impl.
 */
const ALL_STATUSES = Object.values(TenantStatus);

const EXPECTED_TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  [TenantStatus.PENDING]: [TenantStatus.PROVISIONING, TenantStatus.CANCELLED],
  [TenantStatus.PROVISIONING]: [TenantStatus.ACTIVE, TenantStatus.PROVISIONING_FAILED],
  [TenantStatus.PROVISIONING_FAILED]: [TenantStatus.PROVISIONING, TenantStatus.CANCELLED],
  [TenantStatus.ACTIVE]: [
    TenantStatus.SUSPENDED,
    TenantStatus.DEACTIVATED,
    TenantStatus.CANCELLED,
  ],
  [TenantStatus.SUSPENDED]: [
    TenantStatus.ACTIVE,
    TenantStatus.DEACTIVATED,
    TenantStatus.CANCELLED,
    TenantStatus.ARCHIVED,
  ],
  [TenantStatus.DEACTIVATED]: [
    TenantStatus.ACTIVE,
    TenantStatus.CANCELLED,
    TenantStatus.ARCHIVED,
  ],
  [TenantStatus.CANCELLED]: [TenantStatus.ACTIVE, TenantStatus.ARCHIVED],
  [TenantStatus.ARCHIVED]: [TenantStatus.PURGED],
  [TenantStatus.PURGED]: [],
};

describe('TenantStatusMachine', () => {
  describe('matrix completeness', () => {
    it('declares a transition row for EVERY status (no forgotten state)', () => {
      for (const status of ALL_STATUSES) {
        expect(TENANT_STATUS_TRANSITIONS[status]).toBeDefined();
      }
      expect(Object.keys(TENANT_STATUS_TRANSITIONS).sort()).toEqual([...ALL_STATUSES].sort());
    });

    it('only references known statuses as targets (no mistyped target)', () => {
      for (const targets of Object.values(TENANT_STATUS_TRANSITIONS)) {
        for (const to of targets) {
          expect(ALL_STATUSES).toContain(to);
        }
      }
    });

    it('never lists a self-transition', () => {
      for (const status of ALL_STATUSES) {
        expect(TENANT_STATUS_TRANSITIONS[status]).not.toContain(status);
      }
    });
  });

  describe('canTransition — every (from, to) pair pinned', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const expected = EXPECTED_TRANSITIONS[from].includes(to);
        it(`${from} → ${to} is ${expected ? 'LEGAL' : 'illegal'}`, () => {
          expect(canTransition(from, to)).toBe(expected);
        });
      }
    }
  });

  describe('assertTransition', () => {
    it('returns void (no throw) for a legal transition', () => {
      expect(() => assertTransition(TenantStatus.ACTIVE, TenantStatus.SUSPENDED)).not.toThrow();
    });

    it('throws with a deterministic message for an illegal transition', () => {
      expect(() => assertTransition(TenantStatus.PURGED, TenantStatus.ACTIVE)).toThrow(
        'Illegal tenant status transition: PURGED → ACTIVE',
      );
    });

    it('labels a terminal source as (terminal) in the error', () => {
      expect(() => assertTransition(TenantStatus.PURGED, TenantStatus.PENDING)).toThrow(
        '(terminal)',
      );
    });

    it('rejects a self-transition (callers should no-op instead)', () => {
      expect(() => assertTransition(TenantStatus.ACTIVE, TenantStatus.ACTIVE)).toThrow(
        'Illegal tenant status transition: ACTIVE → ACTIVE',
      );
    });
  });

  describe('isLoginAllowed — fail-closed allow-list', () => {
    it('permits login ONLY in ACTIVE', () => {
      expect(isLoginAllowed(TenantStatus.ACTIVE)).toBe(true);
    });

    it.each(ALL_STATUSES.filter((s) => s !== TenantStatus.ACTIVE))(
      'blocks login in %s (closes the DEACTIVATED/ARCHIVED slip-through)',
      (status) => {
        expect(isLoginAllowed(status)).toBe(false);
      },
    );
  });

  describe('isTerminal', () => {
    it('is true for PURGED (GDPR erasure complete)', () => {
      expect(isTerminal(TenantStatus.PURGED)).toBe(true);
    });

    it.each(ALL_STATUSES.filter((s) => s !== TenantStatus.PURGED))(
      'is false for the still-mutable status %s',
      (status) => {
        expect(isTerminal(status)).toBe(false);
      },
    );
  });
});
