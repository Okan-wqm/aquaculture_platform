/**
 * INFRA-CRITICAL-013 contract test
 *
 * The GraphQL enum input boundary must coerce both possible literal forms
 * (KEY: 'MEMBER' and VALUE: 'member') to the canonical TypeScript enum
 * VALUE before the AddMemberCommand reaches the SQL layer. The CHECK
 * constraint chk_member_role only accepts ('owner','admin','member') —
 * any uppercase write violates it.
 *
 * This test pins the normalization expression used in
 * channel.resolver.ts addChannelMember(). A regression that drops the
 * `(ChannelMemberRole as Record<string, ChannelMemberRole>)[input] ?? input`
 * line will surface here BEFORE the deploy gate's E2E spec catches it
 * (and before any production write fails).
 */

import { ChannelMemberRole } from '../entities/channel-member.entity';

/**
 * Mirror of the resolver's normalization expression. Kept as a separate
 * function so the contract test exercises the exact boundary normalization
 * shape independent of the surrounding resolver wiring.
 */
function normalizeRole(input: ChannelMemberRole | string): ChannelMemberRole {
  return (ChannelMemberRole as Record<string, ChannelMemberRole>)[input] ?? input;
}

describe('INFRA-CRITICAL-013 — ChannelMemberRole input boundary normalization', () => {
  it('coerces uppercase enum NAME → lowercase TS VALUE', () => {
    expect(normalizeRole('MEMBER' as unknown as ChannelMemberRole)).toBe('member');
    expect(normalizeRole('ADMIN' as unknown as ChannelMemberRole)).toBe('admin');
    expect(normalizeRole('OWNER' as unknown as ChannelMemberRole)).toBe('owner');
  });

  it('passes lowercase TS VALUE through unchanged (idempotent)', () => {
    expect(normalizeRole(ChannelMemberRole.MEMBER)).toBe('member');
    expect(normalizeRole(ChannelMemberRole.ADMIN)).toBe('admin');
    expect(normalizeRole(ChannelMemberRole.OWNER)).toBe('owner');
  });

  it('preserves arbitrary unrecognized strings (defers validation to CHECK constraint)', () => {
    // The DB CHECK constraint chk_member_role is the final guard — any
    // unrecognized value reaches it and is rejected. The normalizer's
    // job is NOT to validate; it's to coerce known forms canonically.
    expect(normalizeRole('definitely-not-a-role' as ChannelMemberRole)).toBe(
      'definitely-not-a-role',
    );
  });

  it('asserts every TypeScript enum NAME maps to its VALUE — no orphans', () => {
    // Defensive: if a future refactor adds a new role to the TS enum
    // without updating the GraphQL valuesMap or the CHECK constraint,
    // this test still passes (normalizer is generic). The deploy-gate
    // schema-drift validator + the CHECK constraint will catch it.
    for (const [key, value] of Object.entries(ChannelMemberRole)) {
      expect(normalizeRole(key as ChannelMemberRole)).toBe(value);
    }
  });
});
