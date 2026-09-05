import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * INVARIANT: every e-mailed action link resolves through ActionTokenResolver.
 *
 * SEC-HIGH-056 root cause: three consumers (validateInvitation, acceptInvitation,
 * resetPassword) and one URL builder (InternalAuthController.getActionTokenUrl)
 * each hand-rolled how a link segment becomes a database lookup. One of them
 * sha256-hashed the ActionToken ROW ID the link carried and searched for it as a
 * token hash; two publishers put a token HASH under `actionTokenId`, a value the
 * URL builder could never resolve to a row. The form fronting every invitation
 * rendered "invalid" while the redemption behind it would have accepted the link.
 *
 * The fix makes the resolver the only place a segment is classified and hashed
 * (apps/auth-service/src/modules/authentication/services/action-token-resolver.service.ts),
 * makes every invitation delivery mint an ActionToken row (mintInvitation), and
 * this spec keeps both true:
 *
 *  1. The URL builder derives the link from the ActionToken row only — no
 *     hashing, no token rotation, no crypto import.
 *  2. The three consumers reach the ActionToken table only through the resolver
 *     and never hash or bind the raw segment themselves.
 *  3. Nothing in auth-service publishes a hash as `actionTokenId`, and every
 *     UserInvited publisher lives next to the code that mints the row it names.
 *
 * Raw-token (64-hex) segments are still admitted by the resolver for links
 * e-mailed before this change; that branch retires under SEC-LOW-060.
 */

const REPO_ROOT = resolve(__dirname, '..', '..');
const AUTH_SRC = 'apps/auth-service/src';
const RESOLVER = `${AUTH_SRC}/modules/authentication/services/action-token-resolver.service.ts`;
const SERVICE = `${AUTH_SRC}/modules/authentication/services/authentication.service.ts`;
const CONTROLLER = `${AUTH_SRC}/modules/authentication/controllers/internal-auth.controller.ts`;
const USER_LIFECYCLE = `${AUTH_SRC}/modules/tenant/services/user-lifecycle.service.ts`;
const TENANT_USER_MANAGEMENT = `${AUTH_SRC}/modules/tenant/services/tenant-user-management.service.ts`;

/**
 * Files allowed to publish UserInvited. Each one mints the ActionToken row the
 * event names in the same transaction as the user row:
 * - user-lifecycle: mintInvitation (createUser + adminInviteUser)
 * - tenant-provisioning-command: first-admin invite (ensureInvitationActionToken)
 */
const USER_INVITED_PUBLISHERS: ReadonlySet<string> = new Set([
  USER_LIFECYCLE,
  `${AUTH_SRC}/modules/tenant/services/tenant-provisioning-command.service.ts`,
]);

function readRepoFile(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf-8');
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function listSourceFiles(path: string): string[] {
  const absolute = resolve(REPO_ROOT, path);
  const files: string[] = [];
  for (const entry of readdirSync(absolute)) {
    const childPath = `${path}/${entry}`;
    const stats = statSync(resolve(REPO_ROOT, childPath));
    if (stats.isDirectory()) {
      if (entry === '__tests__' || entry === 'test' || entry === 'tests') continue;
      files.push(...listSourceFiles(childPath));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      files.push(childPath);
    }
  }
  return files;
}

/**
 * Body of a class method: from its signature to the next member declared at
 * the class's two-space indent (or the class's closing brace). The service is
 * a single class, so member-boundary slicing is exact and does not need to
 * brace-match through `Promise<{ … }>` return types.
 */
function methodBody(source: string, name: string): string {
  const signature = new RegExp(`\\n  (?:private |public |protected )?(?:async )?${name}\\(`);
  const start = source.search(signature);
  if (start < 0) {
    throw new Error(`method ${name} not found`);
  }
  const rest = source.slice(start + 1);
  const next = rest
    .slice(1)
    .search(/\n {2}(?:\/\*\*|private |public |protected |async |[A-Za-z_]\w*\(|@)|\n}\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** Lookups that bind the raw link segment (`token`) instead of a resolved row. */
const RAW_SEGMENT_LOOKUPS: ReadonlyArray<RegExp> = [
  /(?:invitationToken|passwordResetToken|tokenHash|token)\s*:\s*token\b/,
  /\{\s*token\s*\}/,
  /where:\s*\{[^}]*(?<![.\w])token\b\s*[,}]/,
  /:token\b/,
  /createHash\(/,
  /randomBytes\(/,
];

describe('INVARIANT: emailed action links resolve through ActionTokenResolver', () => {
  const service = stripComments(readRepoFile(SERVICE));
  const controller = stripComments(readRepoFile(CONTROLLER));
  const resolver = stripComments(readRepoFile(RESOLVER));

  it('the resolver owns segment classification and hashing', () => {
    expect(resolver).toContain('export class ActionTokenResolver');
    expect(resolver).toMatch(/resolve\(/);
    expect(resolver).toMatch(/hashRawToken\(/);
    expect(resolver).toMatch(/buildActionUrl\(/);
    expect(resolver).toContain("createHash('sha256')");
    expect(resolver).toContain('${actionToken.id}');
  });

  it('the URL builder derives the link from the ActionToken row only', () => {
    expect(controller).toContain('actionTokenResolver.buildActionUrl(');
    expect(controller).toContain('where: { id: actionTokenId');
    for (const banned of [
      'createHash',
      'randomBytes',
      'rotateInvitationToken',
      'rotatePasswordResetToken',
      'hashToken(',
      'actionPath(',
      "from 'crypto'",
      "from 'node:crypto'",
    ]) {
      expect(controller).not.toContain(banned);
    }
  });

  it.each([
    ['validateInvitation', 'this.loadInvitationForSegment('],
    ['acceptInvitation', 'this.loadInvitationForSegment('],
    ['loadInvitationForSegment', 'this.actionTokenResolver.resolve('],
    ['resetPassword', 'this.actionTokenResolver.resolve('],
  ])('%s reaches the token table only through the resolver', (name, via) => {
    const body = methodBody(service, name);
    expect(body).toContain(via);
    for (const pattern of RAW_SEGMENT_LOOKUPS) {
      expect(body).not.toMatch(pattern);
    }
  });

  it('validateInvitation and acceptInvitation share one acceptance gate', () => {
    expect(methodBody(service, 'validateInvitation')).toContain('canBeAccepted()');
    expect(methodBody(service, 'acceptInvitation')).toContain('canBeAccepted()');
    expect(methodBody(service, 'validateInvitation')).not.toContain('isPending()');
  });

  it('no auth-service publisher puts a token hash under actionTokenId', () => {
    const offenders = listSourceFiles(AUTH_SRC).filter((file) =>
      /actionTokenId\s*:\s*\w*[Hh]ash\b/.test(stripComments(readRepoFile(file))),
    );
    expect(offenders).toEqual([]);
  });

  it('every UserInvited publisher mints the ActionToken row it names', () => {
    const publishers = listSourceFiles(AUTH_SRC).filter((file) =>
      stripComments(readRepoFile(file)).includes('createBaseEvent<UserInvitedEvent>('),
    );
    expect(new Set(publishers)).toEqual(USER_INVITED_PUBLISHERS);

    const lifecycle = stripComments(readRepoFile(USER_LIFECYCLE));
    expect(lifecycle.match(/createBaseEvent<UserInvitedEvent>\(/g)).toHaveLength(1);
    expect(lifecycle).toContain('private async publishUserInvited(');
    expect(lifecycle).toContain('private async mintInvitation(');
    expect(lifecycle).not.toContain('sendInvitationEmail');
    expect(methodBody(lifecycle, 'createUser')).toContain('this.mintInvitation(');
    expect(methodBody(lifecycle, 'adminInviteUser')).toContain('this.mintInvitation(');

    const tenantUserManagement = stripComments(readRepoFile(TENANT_USER_MANAGEMENT));
    expect(tenantUserManagement).not.toContain('UserInvitedEvent');
    expect(tenantUserManagement).not.toContain('createHash');
  });
});
