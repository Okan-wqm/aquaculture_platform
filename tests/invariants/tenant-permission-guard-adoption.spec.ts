/**
 * Tenant-Permission-Guard Adoption Invariant
 * ============================================================================
 *
 * Closes SENSOR-HIGH-022 (docs/reviews/2026-07-05-sensor-vfd-device-audit.md).
 *
 *   The `@RequireTenantPermission('<perm>')` decorator only enforces anything
 *   when `TenantPermissionGuard` is active. The guard is opt-in (a handler
 *   with no decorator passes through), so the safe wiring is a global
 *   `APP_GUARD` registration in the owning service's `app.module.ts`.
 *
 *   Before this gate, sensor-service decorated its edge I/O-config mutations
 *   with `@RequireTenantPermission('edge:manage-io-config')` but never
 *   registered the guard — the fine-grained permission was dead metadata and
 *   the weakest layer (the role gate) silently won.
 *
 * # What this spec enforces (Tier-3 "make it detectable")
 *
 *   For every `apps/<svc>` whose `src/**` uses `@RequireTenantPermission`,
 *   that service's `app.module.ts` MUST register `TenantPermissionGuard` as an
 *   `APP_GUARD`. Otherwise the decorator is inert.
 *
 * # When this spec fails
 *
 *   - A service added `@RequireTenantPermission` but did not wire the guard →
 *     register `TenantPermissionGuard` as a fourth `APP_GUARD` (after
 *     `RolesGuard`) in that service's `app.module.ts`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const APPS_DIR = path.join(REPO_ROOT, 'apps');

/** Recursively collect *.ts files under a directory (skips node_modules/dist). */
function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

function servicesUsingDecorator(): string[] {
  const services: string[] = [];
  if (!existsSync(APPS_DIR)) return services;
  for (const svc of readdirSync(APPS_DIR)) {
    const srcDir = path.join(APPS_DIR, svc, 'src');
    if (!existsSync(srcDir)) continue;
    const uses = collectTsFiles(srcDir).some((f) =>
      /@RequireTenantPermission\s*\(/.test(readFileSync(f, 'utf8')),
    );
    if (uses) services.push(svc);
  }
  return services;
}

describe('TenantPermissionGuard adoption (SENSOR-HIGH-022)', () => {
  const services = servicesUsingDecorator();

  it('at least one service uses @RequireTenantPermission (sanity)', () => {
    // Guards against a false-green if the decorator is ever renamed/removed.
    expect(services.length).toBeGreaterThan(0);
  });

  it.each(services)(
    '%s registers TenantPermissionGuard as an APP_GUARD',
    (svc) => {
      const modulePath = path.join(APPS_DIR, svc, 'src', 'app.module.ts');
      expect(existsSync(modulePath)).toBe(true);
      const src = readFileSync(modulePath, 'utf8');
      // The guard must be both referenced and wired to the APP_GUARD token.
      expect(src).toContain('TenantPermissionGuard');
      expect(/APP_GUARD[\s\S]{0,400}TenantPermissionGuard/.test(src)).toBe(true);
    },
  );
});
