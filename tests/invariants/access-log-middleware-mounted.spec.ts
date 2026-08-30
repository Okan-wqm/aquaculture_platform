import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * INVARIANT: the low-level HTTP access-log stream (shared.access_logs,
 * AUDITTRAIL-HIGH-004) is actually MOUNTED and RETAINED — not merely built.
 *
 * WHY (IDENT-HIGH-002 / ORPHAN-HIGH-356): the access-logging subsystem
 * (AccessLogEntity + AccessLogService + AccessLogMiddleware + AccessLogModule)
 * and the canonical `shared.access_logs` table shipped, and AccessLogModule's
 * own docstring cited THIS spec as the enforcer — but the spec never existed and
 * the middleware was never mounted. The table sat permanently empty: a FALSE
 * sense of request-level audit coverage (a forensics/compliance gap). This spec
 * makes the wiring load-bearing so it cannot silently regress:
 *
 *   1. The barrel re-exports AccessLogMiddleware (so a consumer can mount it).
 *   2. The gateway-api — the single external ingress and the canonical mount
 *      point — imports AccessLogModule.forRoot(), lists AccessLogEntity in its
 *      TypeORM entities (so getRepository resolves), and applies
 *      AccessLogMiddleware in configure().
 *   3. Retention is registered: admin-api's RetentionEnforcementService bootstrap
 *      carries a `shared.access_logs` policy, so activating the writer cannot
 *      grow the table without bound.
 *
 * If the design later mounts the middleware on additional services, extend
 * CANONICAL_MOUNTS below — the gateway is the authoritative external boundary.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

describe('INVARIANT: access-log middleware is mounted + retained (AUDITTRAIL-HIGH-004)', () => {
  it('the middleware barrel re-exports AccessLogMiddleware', () => {
    expect(read('libs/backend-common/src/middleware/index.ts')).toMatch(
      /export\s*\{\s*AccessLogMiddleware\s*\}\s*from\s*'\.\/access-log\.middleware'/,
    );
  });

  it('gateway-api (canonical mount) imports the module, lists the entity, and applies the middleware', () => {
    const gateway = read('apps/gateway-api/src/app.module.ts');
    // Module registered → AccessLogService + repo provider available.
    expect(gateway).toMatch(/AccessLogModule\.forRoot\(\)/);
    // Entity in the connection metadata → the AccessLogEntity repository resolves.
    expect(gateway).toMatch(/entities:\s*\[[^\]]*AccessLogEntity[^\]]*\]/);
    // Middleware actually applied to every route (this is the bit that was missing).
    expect(gateway).toMatch(/\.apply\(\s*AccessLogMiddleware\s*\)/);
  });

  it('access_logs has a registered retention policy (activating the writer cannot grow it unbounded)', () => {
    const retention = read('apps/admin-api-service/src/retention/retention-bootstrap.module.ts');
    expect(retention).toMatch(/tableName:\s*'access_logs'/);
    expect(retention).toMatch(/schema:\s*'shared'/);
    // 90-day observability horizon, distinct from the 7y audit_logs policies.
    expect(retention).toMatch(/id:\s*'shared\.access_logs\.90d'/);
  });
});
