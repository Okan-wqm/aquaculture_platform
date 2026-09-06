// The service retains a version of the authority that admitted a case job.
// Publication calls this synchronous check immediately before swapping current.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBearer } from './auth.ts';
import type { ServerConfig } from './config.ts';
import { HttpError } from './errors.ts';
import { requireGate } from './gates.ts';
import { loadInstancePolicy } from './instance-policy.ts';
import { LEGAL_ADAPTER_MANIFEST, LEGAL_INVENTORY_TOOL_ID } from './legal-readiness.ts';
import { canSeeCase, loadPrincipals, tokenDigest } from './principals.ts';
import type { PrincipalRecord } from './principals.ts';

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function adapterVersion(config: ServerConfig): string {
  if (config.workspaceRoot === null) throw new HttpError(409, 'workspace_root_not_configured');
  const value: unknown = JSON.parse(readFileSync(join(config.toolsDir, 'registry.json'), 'utf8'));
  if (typeof value !== 'object' || value === null || !('tools' in value) || !Array.isArray(value.tools)) {
    throw new HttpError(409, 'legal_adapter_unregistered');
  }
  const matching = value.tools.filter((row: unknown) => typeof row === 'object' && row !== null && 'tool_id' in row && row.tool_id === LEGAL_INVENTORY_TOOL_ID);
  const record: unknown = matching[0];
  if (matching.length !== 1 || typeof record !== 'object' || record === null || !('status' in record) || !['SANDBOX', 'SHADOW', 'ACTIVE', 'CALIBRATE'].includes(String(record.status))) {
    throw new HttpError(409, 'legal_adapter_unavailable');
  }
  return digest(JSON.stringify(record) + '\n' + readFileSync(join(config.workspaceRoot, LEGAL_ADAPTER_MANIFEST), 'utf8'));
}

function policyVersion(config: ServerConfig): string {
  if (config.instancePolicy === null) return digest(JSON.stringify({ allowActions: config.allowActions }));
  const current = loadInstancePolicy({ ARIA_INSTANCE_MANIFEST: config.instancePolicy.manifestPath });
  // A running service cannot silently adopt a new policy while retaining its
  // old exclusion set or runtime configuration. A change requires a restart.
  if (JSON.stringify(current) !== JSON.stringify(config.instancePolicy)) throw new HttpError(409, 'legal_job_authority_changed');
  return digest(JSON.stringify(current));
}

function runtimeProfileVersion(config: ServerConfig): string {
  try {
    return digest(readFileSync(join(config.toolsDir, 'runtime-profile.json'), 'utf8'));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/** Capture the submitting record without retaining a bearer token in the job. */
export function captureCaseAuthority(config: ServerConfig, authorizationHeader: string | undefined, caseId: string): () => void {
  const token = extractBearer(authorizationHeader);
  if (token === null || config.principalsFile === null) throw new HttpError(401, 'unauthorized');
  const path = config.principalsFile;
  const presented = Buffer.from(tokenDigest(token), 'hex');
  const findPrincipal = (): PrincipalRecord => {
    let principal: PrincipalRecord | undefined;
    for (const row of loadPrincipals(path).list()) {
      const matches = timingSafeEqual(presented, Buffer.from(row.tokenSha256, 'hex'));
      if (matches && row.revokedAt === null) principal = row;
    }
    if (principal === undefined) throw new HttpError(401, 'unauthorized');
    if (!canSeeCase(principal, caseId)) throw new HttpError(404, 'case_not_found');
    requireGate(config, principal, 'corpus_inventory');
    return principal;
  };
  const principalVersion = digest(JSON.stringify(findPrincipal()));
  const adapter = adapterVersion(config);
  const policy = policyVersion(config);
  const runtimeProfile = runtimeProfileVersion(config);
  return (): void => {
    try {
      if (digest(JSON.stringify(findPrincipal())) !== principalVersion || adapterVersion(config) !== adapter || policyVersion(config) !== policy || runtimeProfileVersion(config) !== runtimeProfile) {
        throw new HttpError(409, 'legal_job_authority_changed');
      }
    } catch {
      throw new HttpError(409, 'legal_job_authority_changed');
    }
  };
}
