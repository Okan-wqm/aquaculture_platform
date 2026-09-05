import { ENDPOINTS } from '../../shared/api-contract.ts';
import { LEGAL_CASE_ID_RE } from '../../shared/legal-contract.ts';
import type { PrincipalResolver } from './auth.ts';
import { requireCurrentInstanceOperator } from './gates.ts';
import { ConfigError } from './config.ts';
import { HttpError } from './errors.ts';
import type { InstallationLock } from './installation-lock.ts';
import { isInstanceOperator, isPrincipalRole } from './principal.ts';
import type { Principal } from './principal.ts';
import { addPrincipal, revokePrincipal } from './principals.ts';
import type { AddPrincipalInput, PrincipalDirectory, PrincipalRecord } from './principals.ts';
import { readJsonBody, sendJson } from './router.ts';
import type { Route } from './router.ts';

type Command = { action: 'list' } | { action: 'revoke'; id: string } | ({ action: 'add' } & AddPrincipalInput);
type PublicRecord = Omit<PrincipalRecord, 'tokenSha256'>;
export type PrincipalAdminResult = { principals: ReadonlyArray<PublicRecord> } | { record: PublicRecord } | { record: PublicRecord; token: string };

function publicRecord(record: PrincipalRecord): PublicRecord {
  const { id, displayName, role, cases, createdAt, revokedAt } = record;
  return { id, displayName, role, cases, createdAt, revokedAt };
}

export function parsePrincipalCommand(value: Record<string, unknown>): Command {
  const invalid = (): never => { throw new HttpError(400, 'invalid_principal_command'); };
  const action = value['action'];
  const fields = action === 'list' ? ['action'] : action === 'revoke' ? ['action', 'id'] : action === 'add' ? ['action', 'id', 'displayName', 'role', 'cases'] : invalid();
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) invalid();
  if (action === 'list') return { action };
  const id = value['id'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) return invalid();
  if (action === 'revoke') return { action, id };
  const displayName = value['displayName'];
  const role = value['role'];
  const cases = value['cases'];
  if (typeof displayName !== 'string' || displayName.trim() === '' || displayName.length > 120 || typeof role !== 'string' || !isPrincipalRole(role)) return invalid();
  if (cases !== '*' && (!Array.isArray(cases) || cases.length > 1000 || !cases.every((item: unknown) => typeof item === 'string' && LEGAL_CASE_ID_RE.test(item)))) return invalid();
  return { action: 'add', id, displayName, role, cases: cases === '*' ? '*' : cases as string[] };
}

/** Synchronous transactions serialize disk mutation and resolver reload in one event-loop turn. */
export class PrincipalAdministration {
  private readonly directory: PrincipalDirectory;
  private readonly lease: InstallationLock;
  constructor(directory: PrincipalDirectory, lease: InstallationLock) { this.directory = directory; this.lease = lease; }

  execute(principal: Principal, body: Record<string, unknown>): PrincipalAdminResult {
    if (!isInstanceOperator(principal)) throw new HttpError(403, 'instance_operator_required');
    this.lease.assertOwns(this.directory.path);
    const command = parsePrincipalCommand(body);
    try {
      if (command.action === 'list') return { principals: this.directory.list().map(publicRecord) };
      const now = new Date().toISOString();
      if (command.action === 'add') {
        const added = addPrincipal(this.directory.path, command, now);
        this.directory.reload();
        return { record: publicRecord(added.record), token: added.token };
      }
      const record = revokePrincipal(this.directory.path, command.id, now);
      this.directory.reload();
      return { record: publicRecord(record) };
    } catch (error) {
      if (error instanceof ConfigError) throw new HttpError(409, 'principal_mutation_refused');
      throw error;
    }
  }
}

export function principalAdminRoute(directory: PrincipalDirectory | null, lease: InstallationLock, resolvePrincipal: PrincipalResolver): Route {
  return { method: ENDPOINTS.principalAdmin.method, pattern: ENDPOINTS.principalAdmin.path, handler: async ({ req, res, principal }): Promise<void> => {
    if (!isInstanceOperator(principal)) throw new HttpError(403, 'instance_operator_required');
    if (directory === null) throw new HttpError(503, 'principal_management_unavailable');
    const body = await readJsonBody(req);
    // Re-resolve the credential, not only the id: rotation invalidates an old token.
    const active = requireCurrentInstanceOperator(req.headers.authorization, resolvePrincipal);
    sendJson(res, 200, new PrincipalAdministration(directory, lease).execute(active, body));
  } };
}
