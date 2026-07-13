import { createHash } from 'crypto';

import { AuditLogService, AuditSeverity } from '@aquaculture/backend-common/audit';
import { SecurityEventService } from '@aquaculture/backend-common/security';
import {
  getServiceIdentityHeader,
  parseServiceIdentityKeyring,
  verifyServiceIdentityRequest,
  type ServiceIdentityKeyringEntry,
} from '@aquaculture/backend-common/utils';
import { Controller, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  CONFIG_RUNTIME_NONSECRET_ALLOWLIST,
  CONFIG_RUNTIME_SECRET_ALLOWLIST,
  CONFIG_RUNTIME_SUBJECTS,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  canonicalConfigRuntimeBody,
  type ConfigRuntimeGetRequest,
  type ConfigRuntimeResult,
} from '@platform/event-contracts';

// Relative deep import (matches libs/backend-common service-identity.util) — the
// nx jest resolver maps the @platform/service-catalog alias inconsistently, and
// the sibling verifier code already reaches the catalog this way.
import { serviceIdentityAudiencesForService } from '../../../../../platform/libs/service-catalog/src/index';
import { SYSTEM_TENANT_ID } from '../configuration.constants';
import { ConfigurationService } from '../services/configuration.service';

/**
 * Per-caller (service/key) allowlists — the SSoT lives in the contract
 * (@platform/event-contracts) so the nats-invariant can cross-check every
 * allowlisted caller against its NATS publish grants AND assert the secret and
 * non-secret maps are disjoint (a secret key can never appear on the GET path).
 */
const NONSECRET_FETCH_ALLOWLIST = toSetMap(CONFIG_RUNTIME_NONSECRET_ALLOWLIST);
const SECRET_FETCH_ALLOWLIST = toSetMap(CONFIG_RUNTIME_SECRET_ALLOWLIST);

function toSetMap(
  source: Readonly<Record<string, readonly string[]>>,
): Readonly<Record<string, ReadonlySet<string>>> {
  const out: Record<string, ReadonlySet<string>> = {};
  for (const [caller, keys] of Object.entries(source)) {
    out[caller] = new Set(keys);
  }
  return out;
}

/** Nonce-replay window — matches the ServiceIdentity signature validity (5 min). */
const NONCE_TTL_MS = 5 * 60 * 1000;

/**
 * ConfigRuntimeNatsHandler — the ONLY trusted read surface for effective
 * config-service configuration, including decrypted platform secrets (Faz C, D6).
 *
 * Defense in depth (5 layers):
 *   1. NATS cert-CN publish allowlist (services.yaml) — only the billing_service
 *      CN can PUBLISH `config.runtime.get_secret`. Enforced by the broker.
 *   2. ServiceIdentity HMAC-v2 verification — the request must carry a valid
 *      signature over the exact (subject, body) bound to the SYSTEM tenant +
 *      config-service audience. Forged/expired/tampered → deny.
 *   3. Nonce-replay rejection — a captured-and-replayed signature within the
 *      5-minute window is rejected.
 *   4. Per-caller (service, key) allowlist — billing may fetch ONLY its exact
 *      keys; the secret key is unreachable via the non-secret GET path.
 *   5. Mandatory audit on EVERY fetch (allow AND deny). The value NEVER appears
 *      on an audit row, in metadata, or in a log line.
 */
@Controller()
export class ConfigRuntimeNatsHandler {
  private readonly logger = new Logger(ConfigRuntimeNatsHandler.name);
  private readonly keyring: ServiceIdentityKeyringEntry[];
  private readonly devSecret: string | undefined;
  private readonly expectedAudiences: readonly string[];
  private readonly seenNonces = new Map<string, number>();

  constructor(
    private readonly configurationService: ConfigurationService,
    private readonly auditLogService: AuditLogService,
    private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    // The cross-service contract constant MUST equal config-service's own
    // SYSTEM_TENANT_ID — a drift would silently reject every signed request
    // (the signer binds one tenant, the verifier expects another).
    if (CONFIG_RUNTIME_SYSTEM_TENANT_ID !== SYSTEM_TENANT_ID) {
      throw new Error(
        'CONFIG_RUNTIME_SYSTEM_TENANT_ID drifted from config-service SYSTEM_TENANT_ID',
      );
    }
    this.keyring = parseServiceIdentityKeyring(
      this.configService.get<string>('SERVICE_IDENTITY_KEYRING') ??
        process.env['SERVICE_IDENTITY_KEYRING'],
    );
    this.devSecret =
      process.env['NODE_ENV'] === 'production'
        ? undefined
        : (this.configService.get<string>('SERVICE_IDENTITY_SIGNING_SECRET') ??
          this.configService.get<string>('INTERNAL_SERVICE_SECRET'));
    this.expectedAudiences = serviceIdentityAudiencesForService('config-service');
  }

  @MessagePattern(CONFIG_RUNTIME_SUBJECTS.GET)
  async getValue(@Payload() request: ConfigRuntimeGetRequest): Promise<ConfigRuntimeResult> {
    return this.handle(request, CONFIG_RUNTIME_SUBJECTS.GET, false);
  }

  @MessagePattern(CONFIG_RUNTIME_SUBJECTS.GET_SECRET)
  async getSecret(@Payload() request: ConfigRuntimeGetRequest): Promise<ConfigRuntimeResult> {
    return this.handle(request, CONFIG_RUNTIME_SUBJECTS.GET_SECRET, true);
  }

  private async handle(
    request: ConfigRuntimeGetRequest,
    subject: string,
    isSecretPath: boolean,
  ): Promise<ConfigRuntimeResult> {
    const service = request?.service ?? '';
    const key = request?.key ?? '';
    const resource = `${service}/${key}`;
    const actions = isSecretPath
      ? { ok: 'config.secret.fetched', deny: 'config.secret.denied' }
      : { ok: 'config.value.fetched', deny: 'config.value.denied' };

    // ── Layer 2: ServiceIdentity HMAC-v2 verification ──
    const headers = this.headersFrom(request);
    const outcome = verifyServiceIdentityRequest({
      headers,
      observedMethod: 'POST',
      observedPath: subject,
      observedBody: canonicalConfigRuntimeBody(service, key),
      keyring: this.keyring,
      secret: this.devSecret,
      allowUnscopedDevKey: process.env['NODE_ENV'] !== 'production',
      expectedTenantId: SYSTEM_TENANT_ID,
      expectedAudiences: this.expectedAudiences,
    });

    if (!outcome.valid) {
      await this.deny(actions.deny, resource, {
        caller: getServiceIdentityHeader(headers, 'x-service-identity') ?? 'unknown',
        reason: outcome.reason,
      });
      return { found: false, value: null };
    }

    const caller = outcome.serviceName;
    const nonce = outcome.nonce;

    // ── Layer 3: nonce-replay rejection ──
    if (this.isReplay(nonce)) {
      await this.deny(actions.deny, resource, { caller, nonce, reason: 'nonce-replay' });
      return { found: false, value: null };
    }

    // ── Layer 4: per-caller (service, key) allowlist ──
    const allowlist = isSecretPath ? SECRET_FETCH_ALLOWLIST : NONSECRET_FETCH_ALLOWLIST;
    if (!allowlist[caller]?.has(resource)) {
      await this.deny(actions.deny, resource, { caller, nonce, reason: 'key-not-allowed' });
      return { found: false, value: null };
    }

    // ── Fetch effective value + secret classification (single lookup) ──
    // The VALUE is never logged or placed in audit metadata.
    let entry: { value: string; isSecret: boolean } | null;
    try {
      entry = await this.configurationService.getEffectiveWithMeta(SYSTEM_TENANT_ID, service, key);
    } catch (err) {
      await this.deny(actions.deny, resource, {
        caller,
        nonce,
        reason: `fetch-error: ${err instanceof Error ? err.message : String(err)}`,
      });
      return { found: false, value: null };
    }

    // ── SEC-MEDIUM-001: the non-secret GET path can NEVER return a secret ──
    // Structural guard independent of the allowlist: even if a secret key were
    // ever added to the non-secret allowlist by mistake, GET refuses it here.
    if (!isSecretPath && entry?.isSecret) {
      await this.deny(actions.deny, resource, {
        caller,
        nonce,
        reason: 'is-secret-on-nonsecret-path',
      });
      return { found: false, value: null };
    }

    const found = entry !== null;
    const value = entry?.value ?? null;

    if (isSecretPath) {
      // ── SEC-MEDIUM-002: fail-closed — do NOT return the secret if the audit
      // row cannot be written. The regulated-mutation audit invariant must hold
      // for every secret disclosure; a lost audit row means no disclosure.
      try {
        await this.auditLogService.recordAwait({
          action: actions.ok,
          resource: 'config-runtime',
          resourceId: resource,
          tenantId: SYSTEM_TENANT_ID,
          severity: AuditSeverity.INFO,
          metadata: { caller, nonce, outcome: 'allow', found },
        });
      } catch (err) {
        this.logger.error(
          `config-runtime secret audit write failed for ${resource} — refusing to ` +
            `return the secret (fail-closed): ${err instanceof Error ? err.message : String(err)}`,
        );
        return { found: false, value: null };
      }
      return { found, value };
    }

    // ── Layer 5 (non-secret): best-effort audit on allow (VALUE NEVER in metadata) ──
    await this.audit(actions.ok, resource, { caller, nonce, outcome: 'allow', found });
    return { found, value };
  }

  private headersFrom(request: ConfigRuntimeGetRequest): Record<string, string | undefined> {
    const identity = request?.identity;
    return identity && typeof identity === 'object' ? { ...identity } : {};
  }

  /** Returns true if the nonce was already seen inside the replay window. */
  private isReplay(nonce: string): boolean {
    const now = Date.now();
    // Opportunistic prune so the map cannot grow unbounded.
    for (const [seen, expiry] of this.seenNonces) {
      if (expiry <= now) this.seenNonces.delete(seen);
    }
    if (this.seenNonces.has(nonce)) return true;
    this.seenNonces.set(nonce, now + NONCE_TTL_MS);
    return false;
  }

  private async deny(
    action: string,
    resource: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.logger.warn(`config-runtime DENY ${action} ${resource}: ${JSON.stringify(metadata)}`);
    void this.securityEventService?.publishSuspiciousActivity({
      description: 'config-runtime-denied',
      action,
      resource,
      ...metadata,
    });
    await this.audit(action, resource, { ...metadata, outcome: 'deny' });
  }

  private async audit(
    action: string,
    resource: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.auditLogService.recordAwait({
        action,
        resource: 'config-runtime',
        resourceId: resource,
        tenantId: SYSTEM_TENANT_ID,
        severity: action.endsWith('denied') ? AuditSeverity.WARNING : AuditSeverity.INFO,
        // metadata carries caller/nonce/outcome ONLY — never the value.
        metadata,
      });
    } catch (err) {
      // A single audit-write failure must not leak a secret or crash the RPC.
      // The fetch itself already fails closed on deny; on the allow path a lost
      // audit row is logged loudly for the AUDIT_FAILURE monitor.
      this.logger.error(
        `config-runtime audit write failed for ${action} ${resource}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
