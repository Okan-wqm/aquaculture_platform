import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * INVARIANT: authentication-module code that opens a transaction or mints
 * tokens does so inside an RLS context boundary.
 *
 * WHY (first-hand, prod 2026-10-12 — SEC-HIGH-196/197, PROC-HIGH-048): the
 * invitation for a real tenant user rendered "invalid" while its rows sat
 * PENDING/ACTIVE in the database. `auth` tables carrying `tenantId` are
 * covered by FORCED `tenant_isolation_policy`; the anonymous
 * validateInvitation/acceptInvitation transactions and the password-reset
 * ActionToken INSERT ran with no `app.current_tenant` and no bypass, so the
 * reads returned ZERO rows and the INSERT was refused. WebAuthn and MFA
 * login failed the same way at their bare `generateTokens` (the
 * refresh_tokens INSERT). That was the FOURTH production incident of the
 * class (auth.users login, refresh_tokens rotation, tenant provisioning
 * receipts, invitations+reset) — each prior fix was one more hand-rolled
 * frame at one more call site, and nothing in the build could see the
 * difference between a framed and an unframed call.
 *
 * The structural fix is `PreAuthRlsFrameService` — one audited boundary
 * (`runPreAuthTokenFlow` / `runTenantCredentialWrite` /
 * `mintTokensForPrincipal`). This spec is the ratchet that keeps it true:
 * every `generateTokens(`, `dataSource.transaction(` and `manager.transaction(`
 * call site under `modules/authentication` must be lexically nested inside
 * an approved frame primitive, or carry an entry in `UNFRAMED_ALLOWLIST`
 * with a reason and a tracked finding. A NEW unframed call site fails CI;
 * the honesty test fails an allowlist entry whose method no longer needs it.
 *
 * Approved frames (the primitive must WRAP the call site, so the pool
 * checkout that emits the RLS GUCs happens inside it):
 *  - `PreAuthRlsFrameService.runPreAuthTokenFlow(`  — audited bypass, cross-tenant token flows
 *  - `PreAuthRlsFrameService.runTenantCredentialWrite(` — fail-closed tenant-bound transaction
 *  - `PreAuthRlsFrameService.mintTokensForPrincipal(` — dual-path session mint
 *  - `withBypass(` — the platform-level audited primitive (refresh rotation, super-admin login)
 *  - `requestContextStorage.run(` — login's tenant-scoped mint frame
 *  - `withTenantContext(` / `bindTenantRlsContext(` / `inCredentialWriterContext(`
 *
 * NOT COVERED (stated so the guarantee is not read wider than it is): this
 * is a call-site check on transactions and mints inside
 * `modules/authentication`. Raw repository writes outside a transaction, and
 * other modules' paths into auth tables, are the province of
 * `auth-tenant-context-ssot.spec.ts` (modules/tenant) — closing the residual
 * gap means routing those writes through `runTenantCredentialWrite`, at
 * which point this allowlist empties (tracked: SEC-MEDIUM-198).
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const AUTHENTICATION_DIR = resolve(REPO_ROOT, 'apps/auth-service/src/modules/authentication');

/** The frame primitives a transaction or mint call site may sit inside. */
const APPROVED_FRAMES: readonly string[] = [
  'runPreAuthTokenFlow(',
  'runTenantCredentialWrite(',
  'mintTokensForPrincipal(',
  'withBypass(',
  'requestContextStorage.run(',
  'withTenantContext(',
  'bindTenantRlsContext(',
  'inCredentialWriterContext(',
];

/** Call sites this spec polices. */
const POLICED_CALL_SITES: readonly RegExp[] = [
  /generateTokens\(/g,
  /dataSource\.transaction\(/g,
  /manager\.transaction\(/g,
];

/**
 * Methods that open a policed call site WITHOUT an enclosing frame, each
 * with its reason and the tracked finding that owns the debt. Keys are
 * `path-relative-to-modules/authentication#methodName`.
 */
const UNFRAMED_ALLOWLIST: Readonly<Record<string, string>> = {
  // The boundary itself: binds the tenant context as the transaction's
  // FIRST statement (fail-closed read-back), so its own transaction is the
  // one place an unframed `dataSource.transaction(` is correct.
  'services/pre-auth-rls-frame.service.ts#runTenantCredentialWrite':
    'THE boundary — binds tenant context before the work runs',
  // The mint's own issuance-fence transaction. RLS context is established
  // by the CALLER through PreAuthRlsFrameService / login's frames; the
  // fence itself only locks the auth.users identity primitive.
  'services/token.service.ts#generateTokens':
    'mint fence tx; context owned by the caller-side frame',
  // Refresh rotation internals: invoked exclusively inside the audited
  // 'auth-service:refresh-token-rotation' withBypass callback opened at the
  // refreshToken() call sites (re-entrant bypass short-circuits re-wrapping).
  'services/authentication.service.ts#refreshTokenWithHash':
    'runs inside the rotation bypass opened by refreshToken()',
  'services/authentication.service.ts#rotateMatchedRefreshToken':
    'mints via the rotation transaction manager, inside the rotation bypass',
  // Authenticated ambient-context sites: correct for tenant users (the
  // request-scoped GUC from TenantContextMiddleware), but a platform
  // principal (tenantId NULL) matches no tenant predicate, so its refresh
  // rows survive logout. Tracked: SEC-MEDIUM-198 (owner + deadline).
  'services/authentication.service.ts#logout':
    'authenticated ambient context; platform-principal gap tracked as SEC-MEDIUM-198',
  'services/authentication.service.ts#logoutAllDevices':
    'authenticated ambient context; platform-principal gap tracked as SEC-MEDIUM-198',
  'services/account.service.ts#changeMyPassword':
    'authenticated ambient context; platform-principal gap tracked as SEC-MEDIUM-198',
};

function listServiceFiles(dir: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'test' || entry.name === 'tests') continue;
      files.push(...listServiceFiles(resolve(dir, entry.name), `${prefix}${entry.name}/`));
      continue;
    }
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(prefix + entry.name);
    }
  }
  return files;
}

/** Balanced-paren span of the call that opens at `openIndex` (the `(`). */
function balancedSpan(src: string, openIndex: number): readonly [number, number] {
  let depth = 0;
  for (let i = openIndex; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    else if (src[i] === ')') {
      depth -= 1;
      if (depth === 0) return [openIndex, i + 1];
    }
  }
  return [openIndex, src.length];
}

/** True when the call site's own line DECLARES the method (definition, not call). */
function isDefinitionLine(src: string, idx: number): boolean {
  const lineStart = src.lastIndexOf('\n', idx) + 1;
  const lineEnd = src.indexOf('\n', idx);
  const line = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
  return /^\s*(?:export\s+)?(?:private |public |protected )?(?:async )?[A-Za-z_]\w*(?:<[^>]*>)?\s*\(/.test(
    line,
  );
}

/** Name of the class method a call site sits in (two-space member indent). */
function enclosingMethod(src: string, callIndex: number): string | null {
  const before = src.slice(0, callIndex);
  const matches = [
    ...before.matchAll(
      /\n {2}(?:private |public |protected )?(?:async )?([A-Za-z_]\w*)(?:<[^>]*>)?\(/g,
    ),
  ];
  const last = matches[matches.length - 1];
  return last?.[1] ?? null;
}

interface Violation {
  readonly key: string;
  readonly file: string;
  readonly method: string | null;
  readonly line: number;
  readonly snippet: string;
}

describe('INVARIANT: authentication transactions and mints run inside an RLS frame', () => {
  const files = listServiceFiles(AUTHENTICATION_DIR);

  function collectViolations(): Violation[] {
    const violations: Violation[] = [];
    for (const relative of files) {
      const src = readFileSync(resolve(AUTHENTICATION_DIR, relative), 'utf-8');
      // Frame spans: every approved primitive's call covers its argument list.
      const frameSpans: ReadonlyArray<readonly [number, number]> = [];
      for (const frame of APPROVED_FRAMES) {
        for (const m of src.matchAll(new RegExp(frame.replace('(', '\\('), 'g'))) {
          const open = src.indexOf('(', m.index);
          if (open >= 0) frameSpans.push(balancedSpan(src, open));
        }
      }
      for (const pattern of POLICED_CALL_SITES) {
        for (const m of src.matchAll(pattern)) {
          const idx = m.index;
          if (idx === undefined) continue;
          if (isDefinitionLine(src, idx)) continue;
          const framed = frameSpans.some(([start, end]) => idx > start && idx < end);
          if (framed) continue;
          const method = enclosingMethod(src, idx);
          const key = `${relative}#${method ?? '<module>'}`;
          if (key in UNFRAMED_ALLOWLIST) continue;
          const line = src.slice(0, idx).split('\n').length;
          violations.push({
            key,
            file: relative,
            method,
            line,
            snippet: src.slice(idx, src.indexOf('\n', idx)).trim().slice(0, 80),
          });
        }
      }
    }
    return violations;
  }

  it('every transaction and mint call site is framed or explicitly allowlisted', () => {
    const violations = collectViolations();
    const detail = violations
      .map((v) => `  ${v.file}:${v.line} (${v.method}) — ${v.snippet}`)
      .join('\n');
    expect(
      `Unframed transaction/mint call sites (wrap in PreAuthRlsFrameService or add a reasoned UNFRAMED_ALLOWLIST entry):\n${detail}`,
    ).toBe(
      `Unframed transaction/mint call sites (wrap in PreAuthRlsFrameService or add a reasoned UNFRAMED_ALLOWLIST entry):\n`,
    );
    expect(violations).toEqual([]);
  });

  it('UNFRAMED_ALLOWLIST stays honest — every entry still names an unframed call site', () => {
    // Re-collect WITHOUT the allowlist filter: each allowlist key must appear.
    const seen = new Set<string>();
    for (const relative of files) {
      const src = readFileSync(resolve(AUTHENTICATION_DIR, relative), 'utf-8');
      const frameSpans: ReadonlyArray<readonly [number, number]> = [];
      for (const frame of APPROVED_FRAMES) {
        for (const m of src.matchAll(new RegExp(frame.replace('(', '\\('), 'g'))) {
          const open = src.indexOf('(', m.index);
          if (open >= 0) frameSpans.push(balancedSpan(src, open));
        }
      }
      for (const pattern of POLICED_CALL_SITES) {
        for (const m of src.matchAll(pattern)) {
          const idx = m.index;
          if (idx === undefined) continue;
          if (isDefinitionLine(src, idx)) continue;
          if (frameSpans.some(([start, end]) => idx > start && idx < end)) continue;
          const method = enclosingMethod(src, idx);
          seen.add(`${relative}#${method ?? '<module>'}`);
        }
      }
    }
    const stale = Object.keys(UNFRAMED_ALLOWLIST).filter((key) => !seen.has(key));
    expect(
      `Stale UNFRAMED_ALLOWLIST entries (the method no longer opens an unframed call site — shrink the list):\n${stale.join('\n')}`,
    ).toBe(
      'Stale UNFRAMED_ALLOWLIST entries (the method no longer opens an unframed call site — shrink the list):\n',
    );
  });

  it('the four pre-auth flows route through the frame service (regression pin)', () => {
    const service = readFileSync(
      resolve(AUTHENTICATION_DIR, 'services/authentication.service.ts'),
      'utf-8',
    );
    expect(service).toContain("'invitation-validation',");
    expect(service).toContain("'invitation-redemption',");
    expect(service).toContain("'password-reset-redemption',");
    expect(service).toContain("'password-reset-request',");
    expect(service.match(/runPreAuthTokenFlow\(/g)?.length ?? 0).toBe(4);
    expect(service).toContain('mintTokensForPrincipal(principal, ipAddress, userAgent)');
    // The issuance fence needs the post-commit row, never the stale entity.
    expect(service).toContain('reloadIssuancePrincipal(result.id)');
    expect(service).toContain('reloadIssuancePrincipal(user.id)');
    // WebAuthn and MFA logins mint through the same boundary.
    expect(
      readFileSync(resolve(AUTHENTICATION_DIR, 'services/webauthn.service.ts'), 'utf-8'),
    ).toContain('mintTokensForPrincipal(user, ipAddress, userAgent)');
    const mfa = readFileSync(resolve(AUTHENTICATION_DIR, 'services/mfa.service.ts'), 'utf-8');
    expect(mfa.match(/mintTokensForPrincipal\(/g)?.length).toBe(2);
  });
});
