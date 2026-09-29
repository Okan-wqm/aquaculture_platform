/**
 * ORPHAN-HIGH-413 (second arm) — the SEND_* NATS commands must execute inside
 * a tenant AsyncLocalStorage frame, not only inside the receipt boundary.
 *
 * `bindTenantRlsContext` protects the SQL the dispatcher issues by hand. It
 * cannot protect the rest of the command path, which goes through TypeORM
 * repositories: `NotificationCommandHandler.resolveUserRecipient` reads
 * `notification.device_tokens` and `sendNotification` writes
 * `notification.notification_logs` — both RLS-protected tenant-column tables
 * (in `MODULE_SCHEMAS['notification'].tables`, absent from that module's
 * `infrastructureTables`). Those queries take their GUCs from
 * `RlsConnectionBootstrap`, which reads `getRequestContext()` at pool
 * checkout. On a NATS command there is no HTTP frame to seed it, so the
 * device-token lookup silently returned zero rows ("No active push device
 * token found for recipient user") and the log write was refused.
 *
 * The cure is the SSoT registration, not a per-handler wrapper: importing
 * `TenantExecutionContextModule` installs the global interceptor whose RPC arm
 * reads `tenantId` off the message payload and re-enters
 * `withTenantContext(...)` around handler execution — so a NEW
 * `@MessagePattern` handler cannot forget to bind it (the reasoning recorded
 * on that interceptor for ORPHAN-CRITICAL-573).
 *
 * This spec pins the REGISTRATION, which is notification-service's half of the
 * contract. The interceptor's own behaviour (RPC payload → tenant frame,
 * fail-closed on a malformed tenant) is proven once, where it lives:
 * `libs/backend-common/src/context/tenant-execution-context.interceptor.spec.ts`.
 * The dispatcher's half — that `notification_logs` is written inside the frame
 * even when no interceptor is in the path — is proven behaviourally in
 * `notification-command-receipt-rls.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const appModuleSource = readFileSync(resolve(__dirname, '../../app.module.ts'), 'utf8');

describe('ORPHAN-HIGH-413: notification NATS commands execute inside a tenant context', () => {
  it('registers the tenant execution context through the SSoT module', () => {
    // A hand-copied APP_INTERCEPTOR provider block is exactly the duplication
    // the SSoT module exists to prevent — the import is the contract.
    expect(appModuleSource).toContain('TenantExecutionContextModule');
    expect(appModuleSource).toContain('@aquaculture/backend-common/context');
  });

  it('does not hand-copy the interceptor as a local APP_INTERCEPTOR provider', () => {
    expect(appModuleSource).not.toContain('TenantExecutionContextInterceptor');
  });
});
