/**
 * Tenant lifecycle status — re-export of the canonical SSoT.
 *
 * The canonical declaration moved to `@platform/event-contracts`
 * (alongside {@link TenantPlan} and the TenantStatusChanged event that
 * carries it) because shared-contracts is not wired into the tsconfig
 * paths / nx graph, so backend services could never actually import this
 * "SSoT". event-contracts is consumed by every service, so the canonical
 * enum lives there and this module simply forwards it — keeping the old
 * import path valid while guaranteeing a single definition (auth-audit
 * HIGH-007).
 */
export { TenantStatus } from '@platform/event-contracts';
